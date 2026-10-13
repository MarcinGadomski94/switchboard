import { randomUUID } from 'node:crypto';
import type { InboxItem, OwnedLoop, Session, SessionTodo } from '../../core/api.ts';
import { HybridClock } from '../../core/hlc.ts';
import { remoteId, parseRemoteId } from '../../core/peers.ts';
import { isPlaced, looseList, placeOf, placeSession } from '../../core/sidebar-layout.ts';
import {
  DEFAULT_TEAM_ID,
  DEFAULT_TEAM_NAME,
  EMPTY_CHARTER,
  HANDOFF_TEXT_MAX,
  MEMBERS_MAX,
  NO_BUDGET,
  PROTECTED_BRANCH,
  REPORT_MAX,
  TEAM_SETTING,
  type HandoffState,
  type SessionStatusLike,
  type TeamActivityKind,
  type TeamActivityRecord,
  type TeamBudget,
  type TeamCharter,
  type TeamGateKind,
  type TeamHandoff,
  type TeamHandoffRecord,
  type TeamMember,
  type TeamMemberRecord,
  type TeamNeedsYouItem,
  type TeamOriginalPlace,
  type TeamRecord,
  type TeamRequest,
  type TeamRequestAction,
  type TeamRequestRecord,
  type TeamRhythmLoop,
  type TeamState,
  type TeamView,
  type TeamWorkplace,
  charterInstruction,
  checkTeamName,
  memberStatus,
  needsYouLabel,
  normalizeGates,
  readBudget,
  readCharter,
  readLinks,
  readRhythmInput,
  readWorkplace,
  returnNote,
} from '../../core/team.ts';
import { TEAM_TEMPLATES, templateById } from '../../core/team-templates.ts';
import { dayStart, overBudget, pointsUsedSince, shareOfDaily } from '../../core/team-budget.ts';
import { type TeamSnapshot, type TeamSyncMessage, TEAM_SYNC_PATH, TEAM_SYNC_VERSION, newActivity, newerRecords, readTeamSyncMessage } from '../../core/team-sync.ts';
import type { Store } from '../db/store.ts';
import type { HubBus } from '../hub/bus.ts';
import { listInbox } from '../inbox/wire.ts';
import type { LoopService } from '../loops/owned.ts';
import type { PeerService } from '../peers/service.ts';
import type { ReviewService } from '../reviews/service.ts';
import type { SessionSupervisor } from '../supervisor/supervisor.ts';
import type { TakeoverRunner } from '../takeover/runner.ts';
import type { TodoService } from '../todos/service.ts';
import { TeamDb } from './db.ts';
import { registerTeamHooks } from './hooks.ts';
import { peerCall } from './peer-call.ts';
import { computeSuggestions, type TeamSuggestion } from './suggestions.ts';

/** A refusal of a Team operation (`{ error: code, message }` with `status`). */
export class TeamError extends Error {
  override name = 'TeamError';
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown> | null;
  constructor(status: number, code: string, message: string, body: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** The parts of the peer service Team uses. */
export type TeamPeers = Pick<PeerService, 'self' | 'machines' | 'remoteSessions' | 'remoteInbox' | 'forward' | 'ask' | 'hasMachine' | 'sidebarChanged'>;

/** Options of {@link TeamService}. */
export interface TeamServiceOptions {
  readonly dataDir: string;
  readonly store: Store;
  readonly bus: HubBus;
  readonly supervisor: SessionSupervisor;
  readonly loops: LoopService;
  readonly todos: TodoService;
  readonly peers: TeamPeers;
  readonly reviews: ReviewService | null;
  readonly takeover: TakeoverRunner | null;
  /** `true` for a hooked terminal session (D48 P4; refused for adoption). */
  readonly isHooked: (sessionId: string) => Promise<boolean>;
  /** Starts a new session (`POST /api/sessions`'s logic) and runs `beforeSpawn` once it is stored, before its process starts. */
  readonly startSession?: (body: unknown, beforeSpawn: (sessionId: string) => Promise<void>) => Promise<{ readonly ok: true; readonly sessionId: string } | { readonly ok: false; readonly status: number; readonly body: unknown }>;
  readonly now?: () => number;
  /** The Team tick (budgets, paused members' loops, hand-off delivery); default 60 s. */
  readonly tickMs?: number;
  /** The sync with paired machines; default 30 s. */
  readonly syncMs?: number;
  /** A local change is synced after this (default 300 ms). */
  readonly pushDelayMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** The member fields a body sets (adopt, create, update). */
interface MemberFields {
  name?: string;
  charter?: TeamCharter;
  templateId?: string | null;
  budget?: TeamBudget;
  gates?: TeamGateKind[];
  workplace?: TeamWorkplace;
  rhythm?: { readonly loopIds: readonly string[]; readonly onHandoff: boolean };
  model?: string | null;
  effort?: string | null;
  charterDraft?: TeamCharter | null;
}

/** Statuses of a session that count as the session existing for Team. */
const STATUSES: ReadonlySet<string> = new Set(['need', 'run', 'done', 'fail', 'idle', 'paused']);

/** A running move (`POST /api/team/members/{id}/move`). */
export interface TeamMoveRun {
  readonly id: string;
  readonly memberId: string;
  readonly state: 'running' | 'done' | 'failed';
  /** The take-over run (D65) behind it. */
  readonly takeoverRunId: string | null;
  readonly error: string | null;
  readonly targetMachineId: string;
}

/**
 * D100 · Team (`docs/team.md`). Owns `team.db` (opened only while Team is on), the
 * members, hand-offs, requests and activity, the sync with paired machines and the
 * Team timers. **Off by default**: while off it opens nothing, runs no timer and
 * answers every hook with "nothing", so the rest of Switchboard behaves as before.
 */
export class TeamService {
  readonly #o: TeamServiceOptions;
  #enabled = false;
  #db: TeamDb | null = null;
  #problem: string | null = null;
  #clock: HybridClock | null = null;
  #self: { readonly id: string; readonly name: string } | null = null;
  #tick: NodeJS.Timeout | undefined;
  #sync: NodeJS.Timeout | undefined;
  #soon: NodeJS.Timeout | undefined;
  #syncing: Promise<void> | null = null;
  #again = false;
  #closed = false;
  #offBus: (() => void) | null = null;
  #offHooks: (() => void) | null = null;
  /** The members (not deleted) by local or remote session ref, for the synchronous hooks. */
  #roles = new Map<string, string>();
  #queue: Promise<unknown> = Promise.resolve();
  readonly #moves = new Map<string, TeamMoveRun>();
  /** Paired machines whose Team answered the exchange (older ones / Team off there are left out). */
  readonly #syncedWith = new Set<string>();

  constructor(options: TeamServiceOptions) {
    this.#o = options;
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }

  #error(error: unknown): void {
    (this.#o.onError ?? ((e) => console.error('switchboard team:', e)))(error);
  }

  /** Runs `work` after the previous Team write (one writer at a time). */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  // ── lifecycle and the switch ──────────────────────────────────────────

  /** Reads the switch and, when on, opens `team.db` and starts the timers (the app calls it when ready). */
  async init(): Promise<void> {
    this.#offHooks = registerTeamHooks(this.#o.store, {
      charterFor: (sessionId) => this.#charterFor(sessionId),
      roleOf: (sessionId) => this.#roles.get(sessionId) ?? null,
      reviewGate: (input) => this.#reviewGate(input),
      switchChanged: () => this.switchChanged(),
    });
    await this.switchChanged();
  }

  /** Stops everything and closes `team.db` (the app closes). */
  async close(): Promise<void> {
    this.#closed = true;
    this.#stop();
    await this.#syncing?.catch(() => undefined);
    await this.#queue.catch(() => undefined);
    this.#offHooks?.();
    this.#offHooks = null;
    this.#db?.close();
    this.#db = null;
  }

  /** The stored switch (default off). */
  async #switchOn(): Promise<boolean> {
    return (await this.#o.store.settings.get(TEAM_SETTING)) === true;
  }

  /**
   * The switch was read again (start, or Settings changed it): on → `team.db` is
   * opened (created on first use) and the timers start; off → the timers stop and
   * the file is closed (it stays on disk; switching on again re-hides the members).
   */
  async switchChanged(): Promise<void> {
    if (this.#closed) return;
    const on = await this.#switchOn();
    if (on === this.#enabled && (on ? this.#db !== null || this.#problem !== null : true)) return;
    this.#enabled = on;
    if (!on) {
      this.#stop();
      this.#db?.close();
      this.#db = null;
      this.#problem = null;
      this.#roles = new Map();
      await this.#republishMembers();
      this.#publish(['state']);
      return;
    }
    this.#self = await this.#o.peers.self();
    this.#clock = new HybridClock(this.#self.id, () => this.#now());
    try {
      this.#db = await TeamDb.open(this.#o.dataDir);
      this.#problem = null;
      this.#ensureTeam();
    } catch (error) {
      // A broken team.db hides nothing: Team reports the problem and stays unavailable.
      this.#db = null;
      this.#problem = `team.db could not be opened: ${error instanceof Error ? error.message : String(error)}`;
      this.#error(error);
    }
    this.#refreshRoles();
    this.#start();
    await this.#republishMembers();
    this.#publish(['state']);
  }

  /** The number of Team timers running (tests: none while off). */
  activeTimers(): number {
    return [this.#tick, this.#sync, this.#soon].filter((timer) => timer !== undefined).length + (this.#offBus ? 1 : 0);
  }

  #start(): void {
    if (this.#closed || !this.#db) return;
    if (!this.#tick) {
      this.#tick = setInterval(() => void this.tick().catch((error: unknown) => this.#error(error)), this.#o.tickMs ?? 60_000);
      this.#tick.unref();
    }
    if (!this.#sync) {
      this.#sync = setInterval(() => void this.syncNow(), this.#o.syncMs ?? 30_000);
      this.#sync.unref();
    }
    this.#offBus ??= this.#o.bus.subscribe((message) => {
      if (message.name === 'todosChanged') void this.#todosChanged(message.payload.sessionId).catch((error: unknown) => this.#error(error));
      else if (message.name === 'machineState' && message.payload.state === 'online' && !message.payload.removed) this.#syncSoon();
    });
    this.#syncSoon();
  }

  #stop(): void {
    clearInterval(this.#tick);
    clearInterval(this.#sync);
    clearTimeout(this.#soon);
    this.#tick = undefined;
    this.#sync = undefined;
    this.#soon = undefined;
    this.#offBus?.();
    this.#offBus = null;
  }

  /** `GET /api/team/state`: the switch and what the sidebar hides. */
  state(): TeamState {
    const available = this.#enabled && this.#db !== null;
    const roles = available ? Object.fromEntries(this.#roles) : {};
    return { enabled: this.#enabled, available, problem: this.#enabled ? this.#problem : null, hiddenSessionIds: Object.keys(roles), roles };
  }

  /** @throws {TeamError} 404 while Team is off, 503 while `team.db` is broken. */
  #need(): TeamDb {
    if (!this.#enabled) throw new TeamError(404, 'team-off', 'Team is off: switch it on in Settings → Experimental');
    if (!this.#db) throw new TeamError(503, 'team-unavailable', this.#problem ?? 'team.db is not open');
    return this.#db;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  #selfId(): string {
    return this.#self?.id ?? '';
  }

  #stamp(): string {
    return (this.#clock as HybridClock).next();
  }

  #publish(what: readonly string[]): void {
    this.#o.bus.publish('teamChanged', { teamId: DEFAULT_TEAM_ID, what });
  }

  #ensureTeam(): void {
    const db = this.#db as TeamDb;
    if (db.teams().some((team) => team.id === DEFAULT_TEAM_ID)) return;
    const now = this.#iso();
    db.putTeam({ id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME, clock: '', deleted: false, createdAt: now, updatedAt: now });
  }

  #team(): TeamRecord {
    return this.#need().teams().find((team) => team.id === DEFAULT_TEAM_ID) ?? { id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME, clock: '', deleted: false, createdAt: '', updatedAt: '' };
  }

  #liveMembers(): TeamMemberRecord[] {
    return this.#need().members().filter((member) => !member.deleted && member.teamId === DEFAULT_TEAM_ID);
  }

  #sessionRef(member: Pick<TeamMemberRecord, 'machineId' | 'sessionId'>): string {
    return member.machineId === this.#selfId() ? member.sessionId : remoteId(member.machineId, member.sessionId);
  }

  #refreshRoles(): void {
    const roles = new Map<string, string>();
    if (this.#enabled && this.#db) for (const member of this.#liveMembers()) roles.set(this.#sessionRef(member), member.name);
    this.#roles = roles;
  }

  /** The sidebar and lists hide member sessions; their `sessionUpdated` lets open pages re-read the Team state. */
  async #republishMembers(): Promise<void> {
    await this.#o.supervisor.instructionSettingChanged().catch(() => undefined);
  }

  #changed(what: readonly string[]): void {
    this.#refreshRoles();
    this.#publish(what);
    this.#syncSoon();
  }

  #activity(kind: TeamActivityKind, memberId: string | null, text: string): void {
    this.#need().addActivity([{ id: randomUUID(), teamId: DEFAULT_TEAM_ID, at: this.#iso(), kind, memberId, text }]);
  }

  // ── reads ─────────────────────────────────────────────────────────────

  async #machineNames(): Promise<Map<string, { readonly name: string; readonly online: boolean }>> {
    const out = new Map<string, { readonly name: string; readonly online: boolean }>();
    const self = this.#self ?? (await this.#o.peers.self());
    out.set(self.id, { name: self.name, online: true });
    for (const machine of await this.#o.peers.machines()) out.set(machine.id, { name: machine.name, online: machine.state === 'online' });
    return out;
  }

  async #sessionFacts(member: TeamMemberRecord, machines: Map<string, { readonly name: string; readonly online: boolean }>): Promise<{ readonly reachable: boolean; readonly status: SessionStatusLike | null; readonly title: string | null }> {
    if (member.machineId === this.#selfId()) {
      const record = await this.#o.store.sessions.get(member.sessionId);
      if (!record || record.closedAt !== null) return { reachable: true, status: null, title: record ? (record.title ?? record.name) : null };
      return { reachable: true, status: STATUSES.has(record.status) ? (record.status as SessionStatusLike) : 'idle', title: record.title ?? record.name };
    }
    const machine = machines.get(member.machineId);
    const ref = remoteId(member.machineId, member.sessionId);
    const session = this.#o.peers.remoteSessions().find((s) => s.id === ref) as (Session & { readonly title?: string | null; readonly unreachable?: boolean }) | undefined;
    const reachable = machine?.online === true;
    return { reachable, status: session && STATUSES.has(session.status) ? (session.status as SessionStatusLike) : null, title: session ? (session.title ?? session.name) : null };
  }

  async #toMember(member: TeamMemberRecord, machines: Map<string, { readonly name: string; readonly online: boolean }>): Promise<TeamMember> {
    const facts = await this.#sessionFacts(member, machines);
    const { clock: _clock, deleted: _deleted, ...rest } = member;
    const local = member.machineId === this.#selfId();
    return {
      ...rest,
      rhythm: local ? { ...member.rhythm, loops: await this.#rhythmLoops(member) } : member.rhythm,
      status: memberStatus({ reachable: facts.reachable, sessionStatus: facts.status, paused: member.paused }),
      sessionRef: this.#sessionRef(member),
      sessionTitle: facts.title,
      machineName: machines.get(member.machineId)?.name ?? member.machineId,
      local,
      cliLoopsUnmanaged: member.cliLoops.length > 0,
      usedTodayPct: local && member.budget.dailyPct !== null ? await this.#usedToday(member) : null,
    };
  }

  /** The member's rhythm loops as they are now in its session (D94 loops by id, else by prompt + schedule after a move). */
  async #rhythmLoops(member: TeamMemberRecord): Promise<TeamRhythmLoop[]> {
    let loops: OwnedLoop[];
    try {
      loops = (await this.#o.loops.list(member.sessionId)).filter((loop) => loop.state !== 'ended');
    } catch {
      return [...member.rhythm.loops];
    }
    return member.rhythm.loops.map((entry) => {
      const found = loops.find((loop) => loop.id === entry.loopId) ?? loops.find((loop) => loop.prompt === entry.prompt && loop.scheduleText === entry.scheduleText);
      return found ? { loopId: found.id, label: found.label, prompt: found.prompt, scheduleText: found.scheduleText } : entry;
    });
  }

  /** `GET /api/team`. */
  async view(): Promise<TeamView> {
    const db = this.#need();
    const team = this.#team();
    const machines = await this.#machineNames();
    const members = await Promise.all(this.#liveMembers().map((member) => this.#toMember(member, machines)));
    const self = this.#self ?? (await this.#o.peers.self());
    return {
      team: { id: team.id, name: team.name },
      self,
      members,
      handoffs: db.handoffs().filter((h) => !h.deleted).map(stripHandoff).reverse(),
      activity: db.activity(DEFAULT_TEAM_ID, 100),
    };
  }

  /** `GET /api/team/members/{id}`. @throws {TeamError} 404. */
  async member(id: string): Promise<TeamMember> {
    const record = this.#memberRecord(id);
    return this.#toMember(record, await this.#machineNames());
  }

  #memberRecord(id: string): TeamMemberRecord {
    const record = this.#liveMembers().find((member) => member.id === id);
    if (!record) throw new TeamError(404, 'not-found', `no member ${id}`);
    return record;
  }

  /** `GET /api/team/activity?before=&limit=`. */
  activity(before?: string, limit = 100): TeamActivityRecord[] {
    return this.#need().activity(DEFAULT_TEAM_ID, Math.max(1, Math.min(limit, 500)), before);
  }

  /** `GET /api/team/templates`. */
  templates(): typeof TEAM_TEMPLATES {
    this.#need();
    return TEAM_TEMPLATES;
  }

  /** `PUT /api/team` `{ name }`. */
  async rename(body: unknown): Promise<TeamView> {
    const name = checkTeamName((body as { name?: unknown } | null)?.name);
    if (!name) throw new TeamError(422, 'invalid', 'name must be 1–40 characters on one line');
    await this.#serial(async () => {
      const team = this.#team();
      this.#need().putTeam({ ...team, name, clock: this.#stamp(), updatedAt: this.#iso() });
      this.#activity('team', null, `The team is now called ${name}`);
    });
    this.#changed(['team']);
    await this.#republishMembers();
    return this.view();
  }

  // ── adopt, create, update, return ─────────────────────────────────────

  #assertCapacity(): void {
    if (this.#liveMembers().length >= MEMBERS_MAX) throw new TeamError(409, 'too-many', `a team has at most ${MEMBERS_MAX} members`);
  }

  /** The fields a member's body sets (adopt, create, update). */
  #fields(body: Record<string, unknown>, partial: boolean): MemberFields {
    const out: MemberFields = {};
    const invalid = (field: string, message: string): never => {
      throw new TeamError(422, 'invalid', message, { errors: [{ field, message }] });
    };
    if (body['name'] !== undefined || !partial) {
      const name = checkTeamName(body['name']);
      if (!name) invalid('name', 'name (the role) must be 1–40 characters on one line');
      out.name = name as string;
    }
    const template = body['templateId'] === undefined || body['templateId'] === null ? null : templateById(String(body['templateId']));
    if (body['templateId'] !== undefined && body['templateId'] !== null && !template) invalid('templateId', 'no such template');
    if (body['templateId'] !== undefined) out.templateId = template?.id ?? null;
    if (body['charter'] !== undefined) {
      const charter = readCharter(body['charter']);
      if (!charter) invalid('charter', 'charter must be { owns, produces, neverDoes }, each at most 2,000 characters');
      out.charter = charter as TeamCharter;
    } else if (!partial) out.charter = template?.charter ?? EMPTY_CHARTER;
    if (body['charterDraft'] !== undefined) {
      const draft = body['charterDraft'] === null ? null : readCharter(body['charterDraft']);
      if (body['charterDraft'] !== null && !draft) invalid('charterDraft', 'charterDraft must be a charter or null');
      out.charterDraft = draft;
    }
    if (body['budget'] !== undefined || !partial) {
      const budget = readBudget(body['budget']);
      if (!budget) invalid('budget', 'budget must be { dailyPct: 1–100 | null, profileId: string | null }');
      out.budget = budget as TeamBudget;
    }
    if (body['gates'] !== undefined || !partial) out.gates = normalizeGates(body['gates'] ?? template?.gates ?? ['merge-default-branch']);
    if (body['workplace'] !== undefined || !partial) {
      const workplace = readWorkplace(body['workplace']);
      if (!workplace) invalid('workplace', 'workplace must be { folders: string[] }');
      out.workplace = workplace as TeamWorkplace;
    }
    if (body['rhythm'] !== undefined || !partial) {
      const rhythm = readRhythmInput(body['rhythm'] ?? (template ? { onHandoff: template.rhythm.onHandoff } : undefined));
      if (!rhythm) invalid('rhythm', 'rhythm must be { loopIds: string[], onHandoff: boolean }');
      out.rhythm = rhythm as { readonly loopIds: readonly string[]; readonly onHandoff: boolean };
    }
    for (const key of ['model', 'effort'] as const) {
      const value = body[key];
      if (value === undefined) continue;
      if (value !== null && (typeof value !== 'string' || value.length > 200)) invalid(key, `${key} must be text or null`);
      out[key] = value as string | null;
    }
    return out;
  }

  /** Resolves loop ids of the member's session to rhythm entries (unknown ids are refused). */
  async #rhythmFromIds(sessionId: string, loopIds: readonly string[]): Promise<TeamRhythmLoop[]> {
    if (loopIds.length === 0) return [];
    const loops = await this.#o.loops.list(sessionId);
    return loopIds.map((id) => {
      const loop = loops.find((l) => l.id === id && l.state !== 'ended');
      if (!loop) throw new TeamError(422, 'invalid', `the session has no live Switchboard loop ${id}`, { errors: [{ field: 'rhythm', message: `no loop ${id}` }] });
      return { loopId: loop.id, label: loop.label, prompt: loop.prompt, scheduleText: loop.scheduleText };
    });
  }

  /** Where the session sits in the sidebar now (D54 / D71), to put it back on return. */
  async #placeNow(sessionId: string): Promise<TeamOriginalPlace> {
    const layout = await this.#o.store.sidebar.read();
    const where = placeOf(layout, sessionId);
    if (where === 'pinned') return { place: 'pinned', folderId: null, index: layout.pinned.indexOf(sessionId) };
    if (where) return { place: 'folder', folderId: where.folderId, index: layout.folders.find((f) => f.id === where.folderId)?.sessionIds.indexOf(sessionId) ?? null };
    const loose = layout.loose ?? [];
    if (loose.includes(sessionId)) {
      const listed = await this.#listedIds();
      return { place: 'loose', folderId: null, index: looseList(layout, listed).indexOf(sessionId) };
    }
    return { place: 'none', folderId: null, index: null };
  }

  async #listedIds(): Promise<string[]> {
    const records = (await this.#o.store.sessions.list({ closed: false })).filter((record) => !this.#o.supervisor.isStarting(record.id));
    return [...records.map((record) => record.id), ...this.#o.peers.remoteSessions().map((session) => session.id)];
  }

  /** CLI-run loops (`/loop`, CronCreate, ScheduleWakeup cards, D52 / D93) of the session: Switchboard cannot manage them. */
  async #cliLoops(sessionId: string): Promise<string[]> {
    const rows = await this.#o.store.loops.list(sessionId);
    return rows.filter((row) => row.kind !== 'Workflow').map((row) => row.label ?? row.kind);
  }

  /**
   * `POST /api/team/members` with `sessionId`: adopts an existing session (a paired
   * machine's `r~…` id: on that machine). Keeps its history, worktrees, todos and loops;
   * the charter reaches its agent with its next message (D64's mechanism; a running turn
   * finishes first). Refuses a hooked terminal session (D72: continue it in Switchboard
   * first) and a session already in a team.
   */
  async adopt(body: Record<string, unknown>): Promise<TeamMember> {
    this.#need();
    const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : '';
    if (sessionId === '') throw new TeamError(422, 'invalid', 'sessionId is required', { errors: [{ field: 'sessionId', message: 'sessionId is required' }] });
    const remote = parseRemoteId(sessionId);
    if (remote) {
      const member = await this.#forward<TeamMember>(remote.machineId, 'POST', '/api/team/members', { ...body, sessionId: remote.id });
      await this.syncNow();
      return this.member(member.id);
    }
    const fields = this.#fields(body, false);
    const session = await this.#o.store.sessions.get(sessionId);
    if (!session) throw new TeamError(404, 'not-found', `no session ${sessionId}`);
    if (session.closedAt !== null) throw new TeamError(409, 'closed', 'the session is closed: reopen it first');
    if (session.hooked || (await this.#o.isHooked(sessionId))) {
      throw new TeamError(409, 'hooked', 'This is a hooked terminal session: Switchboard does not run its CLI, so it cannot get a charter. Continue it in Switchboard first (its ⋯ menu → Continue in Switchboard), then adopt it.');
    }
    if (!session.attached) throw new TeamError(409, 'detached', 'the session continues in a terminal: attach it here first');
    const record = await this.#serial(async () => {
      this.#assertCapacity();
      if (this.#liveMembers().some((member) => member.machineId === this.#selfId() && member.sessionId === sessionId)) {
        throw new TeamError(409, 'already-member', 'this session is already a member of the team');
      }
      const now = this.#iso();
      const member: TeamMemberRecord = {
        id: randomUUID(),
        teamId: DEFAULT_TEAM_ID,
        clock: this.#stamp(),
        deleted: false,
        name: fields.name as string,
        charter: fields.charter ?? EMPTY_CHARTER,
        charterDraft: fields.charterDraft ?? null,
        templateId: fields.templateId ?? null,
        machineId: this.#selfId(),
        sessionId,
        workplace: fields.workplace ?? { folders: session.cwd ? [session.cwd] : [] },
        provider: session.provider,
        model: fields.model !== undefined ? fields.model : session.model,
        effort: fields.effort !== undefined ? fields.effort : session.effort,
        rhythm: { loops: await this.#rhythmFromIds(sessionId, fields.rhythm?.loopIds ?? []), onHandoff: fields.rhythm?.onHandoff ?? true },
        budget: fields.budget ?? NO_BUDGET,
        gates: fields.gates ?? normalizeGates([]),
        paused: false,
        pausedLoops: [],
        pausedBy: null,
        cliLoops: await this.#cliLoops(sessionId),
        originalPlace: await this.#placeNow(sessionId),
        access: [],
        createdAt: now,
        updatedAt: now,
      };
      this.#need().putMember(member);
      this.#activity('adopt', member.id, `Adopted ${session.title ?? session.name} as ${member.name}`);
      return member;
    });
    this.#changed(['members', 'activity']);
    await this.#applyCharter(sessionId);
    return this.member(record.id);
  }

  /**
   * `POST /api/team/members` with `session` (a NewSession body): starts a new session in
   * the chosen folder; the member is stored before its process starts, so its first
   * spawn already carries the charter.
   */
  async create(body: Record<string, unknown>): Promise<TeamMember> {
    this.#need();
    const fields = this.#fields(body, false);
    if (!this.#o.startSession) throw new TeamError(501, 'not-available', 'new sessions cannot be started here');
    this.#assertCapacity();
    const template = templateById(fields.templateId ?? null);
    const sessionBody = { ...((body['session'] ?? {}) as Record<string, unknown>) };
    if (sessionBody['name'] === undefined) sessionBody['name'] = `${fields.name ?? 'member'}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'member';
    if (sessionBody['task'] === undefined) sessionBody['task'] = '';
    if (sessionBody['model'] === undefined && fields.model === undefined && template?.model.model) sessionBody['model'] = template.model.model;
    if (sessionBody['model'] === undefined && fields.model) sessionBody['model'] = fields.model;
    if (sessionBody['effort'] === undefined && fields.effort) sessionBody['effort'] = fields.effort;
    let memberId: string | null = null;
    const outcome = await this.#o.startSession(sessionBody, async (sessionId) => {
      const session = await this.#o.store.sessions.get(sessionId);
      const now = this.#iso();
      const member: TeamMemberRecord = {
        id: randomUUID(),
        teamId: DEFAULT_TEAM_ID,
        clock: this.#stamp(),
        deleted: false,
        name: fields.name as string,
        charter: fields.charter ?? EMPTY_CHARTER,
        charterDraft: fields.charterDraft ?? null,
        templateId: fields.templateId ?? null,
        machineId: this.#selfId(),
        sessionId,
        workplace: fields.workplace && fields.workplace.folders.length > 0 ? fields.workplace : { folders: session?.cwd ? [session.cwd] : [] },
        provider: session?.provider ?? null,
        model: session?.model ?? null,
        effort: session?.effort ?? null,
        rhythm: { loops: [], onHandoff: fields.rhythm?.onHandoff ?? true },
        budget: fields.budget ?? NO_BUDGET,
        gates: fields.gates ?? normalizeGates([]),
        paused: false,
        pausedLoops: [],
        pausedBy: null,
        cliLoops: [],
        originalPlace: { place: 'none', folderId: null, index: null },
        access: [],
        createdAt: now,
        updatedAt: now,
      };
      await this.#serial(async () => {
        this.#need().putMember(member);
        this.#activity('create', member.id, `Started ${member.name}`);
      });
      memberId = member.id;
      this.#changed(['members', 'activity']);
    });
    if (!outcome.ok) throw new TeamError(outcome.status, 'invalid', 'the session could not be started', (outcome.body ?? null) as Record<string, unknown> | null);
    if (!memberId) throw new TeamError(500, 'failed', 'the session started but the member was not recorded');
    return this.member(memberId);
  }

  /** `PUT /api/team/members/{id}`: name, charter, draft, template, rhythm, budget, gates, workplace, model / effort (LWW-synced; a charter change reaches the agent with its next message). */
  async update(id: string, body: Record<string, unknown>): Promise<TeamMember> {
    this.#need();
    const fields = this.#fields(body, true);
    const before = this.#memberRecord(id);
    const local = before.machineId === this.#selfId();
    const rhythmLoops = fields.rhythm && local ? await this.#rhythmFromIds(before.sessionId, fields.rhythm.loopIds) : null;
    if (fields.rhythm && !local && fields.rhythm.loopIds.length > 0) {
      const updated = await this.#forward<TeamMember>(before.machineId, 'PUT', `/api/team/members/${encodeURIComponent(id)}`, body);
      await this.syncNow();
      return updated;
    }
    const after = await this.#serial(async () => {
      const current = this.#memberRecord(id);
      const next: TeamMemberRecord = {
        ...current,
        ...(fields.name !== undefined ? { name: fields.name } : {}),
        ...(fields.charter !== undefined ? { charter: fields.charter } : {}),
        ...(fields.charterDraft !== undefined ? { charterDraft: fields.charterDraft } : {}),
        ...(fields.templateId !== undefined ? { templateId: fields.templateId } : {}),
        ...(fields.budget !== undefined ? { budget: fields.budget } : {}),
        ...(fields.gates !== undefined ? { gates: fields.gates } : {}),
        ...(fields.workplace !== undefined ? { workplace: fields.workplace } : {}),
        ...(fields.model !== undefined ? { model: fields.model } : {}),
        ...(fields.effort !== undefined ? { effort: fields.effort } : {}),
        ...(fields.rhythm !== undefined ? { rhythm: { loops: rhythmLoops ?? current.rhythm.loops, onHandoff: fields.rhythm.onHandoff } } : {}),
        clock: this.#stamp(),
        updatedAt: this.#iso(),
      };
      this.#need().putMember(next);
      this.#activity('update', id, `${next.name}'s settings changed`);
      return next;
    });
    this.#changed(['members', 'activity']);
    const charterChanged = fields.charter !== undefined || fields.name !== undefined || fields.gates !== undefined;
    if (charterChanged && local) await this.#applyCharter(after.sessionId);
    return this.member(id);
  }

  /** D64 / D91: the session's process picks the (new / withdrawn) charter up: idle → restarted now, busy → after its turn, not running → its next start. */
  async #applyCharter(sessionId: string): Promise<void> {
    await this.#o.supervisor.instructionSettingChanged().catch(() => undefined);
    try {
      await this.#o.supervisor.reloadInstruction(sessionId);
    } catch (error) {
      // A session that cannot restart now gets it at its next start; the reason is in its chat (D91).
      this.#error(error);
    }
  }

  /**
   * `POST /api/team/members/{id}/return`: the session goes back to the sessions list as a
   * plain session, in its original folder and position (D54 / D71); the charter is
   * withdrawn with a short note to the agent. On the machine that runs it.
   */
  async returnMember(id: string, options: { readonly note?: boolean } = {}): Promise<{ readonly sessionId: string }> {
    const before = this.#memberRecord(id);
    if (before.machineId !== this.#selfId()) {
      const answer = await this.#forward<{ sessionId: string }>(before.machineId, 'POST', `/api/team/members/${encodeURIComponent(id)}/return`, {});
      await this.syncNow();
      return { sessionId: remoteId(before.machineId, answer.sessionId) };
    }
    const team = this.#team();
    const member = await this.#serial(async () => {
      const current = this.#memberRecord(id);
      // Its Team pause ends with it: the loops Team paused run again as the session's own.
      await this.#resumeLoops(current);
      this.#need().putMember({ ...current, deleted: true, paused: false, pausedLoops: [], pausedBy: null, clock: this.#stamp(), updatedAt: this.#iso() });
      this.#activity('return', id, `${current.name} returned to the sessions list`);
      return current;
    });
    this.#changed(['members', 'activity']);
    await this.#restorePlace(member);
    const session = await this.#o.store.sessions.get(member.sessionId);
    if (session && session.closedAt === null) {
      await this.#applyCharter(member.sessionId);
      if (options.note !== false && this.#o.supervisor.isLive(member.sessionId)) {
        await this.#o.supervisor.sendMessage(member.sessionId, returnNote(member.name, team.name), 'service').catch((error: unknown) => this.#error(error));
      }
    }
    return { sessionId: member.sessionId };
  }

  /** `DELETE /api/team/members/{id}`: removes the member; its session (when it still exists) returns like {@link returnMember}, without the note. */
  async remove(id: string): Promise<void> {
    const before = this.#memberRecord(id);
    if (before.machineId !== this.#selfId()) {
      const online = (await this.#machineNames()).get(before.machineId)?.online === true;
      if (online) {
        await this.#forward(before.machineId, 'DELETE', `/api/team/members/${encodeURIComponent(id)}`, undefined);
        await this.syncNow();
        return;
      }
      throw new TeamError(502, 'peer-unreachable', `${(await this.#machineNames()).get(before.machineId)?.name ?? 'That machine'} is offline: remove the member when it is back`);
    }
    await this.returnMember(id, { note: false });
  }

  async #restorePlace(member: TeamMemberRecord): Promise<void> {
    const layout = await this.#o.store.sidebar.read();
    if (isPlaced(layout, member.sessionId)) return;
    const place = member.originalPlace;
    if (place.place === 'none') return;
    if (place.place === 'folder' && !layout.folders.some((f) => f.id === place.folderId)) return;
    const listed = place.place === 'loose' ? await this.#listedIds() : [];
    const input =
      place.place === 'folder'
        ? { sessionId: member.sessionId, place: 'folder' as const, folderId: place.folderId as string, ...(place.index !== null ? { index: place.index } : {}) }
        : { sessionId: member.sessionId, place: place.place, ...(place.index !== null ? { index: place.index } : {}) };
    const write = await this.#o.store.sidebar.change((current) => placeSession(current, input, listed));
    if (write) {
      this.#o.bus.publish('sidebarLayoutChanged', write.layout);
      this.#o.peers.sidebarChanged(write.changes);
    }
  }

  // ── pause / resume ────────────────────────────────────────────────────

  /** Pauses the session's active Switchboard loops; returns the ids paused. */
  async #pauseLoops(member: TeamMemberRecord): Promise<string[]> {
    const paused: string[] = [];
    for (const loop of await this.#o.loops.list(member.sessionId).catch(() => [] as OwnedLoop[])) {
      if (loop.state !== 'active') continue;
      try {
        await this.#o.loops.pause(member.sessionId, loop.id);
        paused.push(loop.id);
      } catch (error) {
        this.#error(error);
      }
    }
    return paused;
  }

  async #resumeLoops(member: TeamMemberRecord): Promise<void> {
    for (const loopId of member.pausedLoops) {
      try {
        await this.#o.loops.resume(member.sessionId, loopId);
      } catch {
        // Gone or ended meanwhile.
      }
    }
  }

  /** `POST /api/team/members/{id}/pause`: its Team loops stop and nothing new starts; the session itself is untouched. */
  async pause(id: string, by: 'developer' | 'budget' = 'developer'): Promise<TeamMember> {
    const before = this.#memberRecord(id);
    if (before.machineId !== this.#selfId()) {
      await this.#forward(before.machineId, 'POST', `/api/team/members/${encodeURIComponent(id)}/pause`, {});
      await this.syncNow();
      return this.member(id);
    }
    await this.#serial(async () => {
      const current = this.#memberRecord(id);
      const paused = await this.#pauseLoops(current);
      this.#need().putMember({ ...current, paused: true, pausedBy: current.paused ? current.pausedBy : by, pausedLoops: [...new Set([...current.pausedLoops, ...paused])], clock: this.#stamp(), updatedAt: this.#iso() });
      if (!current.paused) this.#activity('pause', id, by === 'budget' ? `${current.name} is over its daily budget: its loops are paused` : `${current.name} paused`);
    });
    this.#changed(['members', 'activity']);
    return this.member(id);
  }

  /** `POST /api/team/members/{id}/resume`: the loops Team paused run again; waiting hand-offs are sent. */
  async resume(id: string): Promise<TeamMember> {
    const before = this.#memberRecord(id);
    if (before.machineId !== this.#selfId()) {
      await this.#forward(before.machineId, 'POST', `/api/team/members/${encodeURIComponent(id)}/resume`, {});
      await this.syncNow();
      return this.member(id);
    }
    await this.#serial(async () => {
      const current = this.#memberRecord(id);
      await this.#resumeLoops(current);
      this.#need().putMember({ ...current, paused: false, pausedBy: null, pausedLoops: [], clock: this.#stamp(), updatedAt: this.#iso() });
      if (current.paused) this.#activity('resume', id, `${current.name} resumed`);
      // An open budget request is settled by the resume.
      for (const request of this.#need().requests()) {
        if (request.memberId === id && request.kind === 'budget' && request.state === 'open') {
          this.#need().putRequest({ ...request, state: 'dismissed', note: 'resumed', clock: this.#stamp(), updatedAt: this.#iso() });
        }
      }
    });
    this.#changed(['members', 'activity', 'requests']);
    await this.#deliverHandoffs();
    return this.member(id);
  }

  // ── hand-offs ─────────────────────────────────────────────────────────

  /** A member by role name (case-insensitive) or id. */
  #memberByName(name: string): TeamMemberRecord | null {
    const wanted = name.trim().toLowerCase();
    return this.#liveMembers().find((member) => member.id === name || member.name.toLowerCase() === wanted) ?? null;
  }

  /**
   * Creates a hand-off (`POST /api/team/handoffs` from the developer, `team_handoff`
   * from a member). The receiver's machine turns it into a todo in the receiver's
   * session (D68) and, with rhythm "on hand-off", tells its agent.
   */
  async createHandoff(input: { readonly from: string | null; readonly to: string; readonly brief: unknown; readonly expected: unknown; readonly links: unknown; readonly planRef?: unknown }): Promise<TeamHandoff> {
    this.#need();
    const to = this.#memberByName(input.to);
    if (!to) throw new TeamError(404, 'not-found', `no member called "${input.to}": team_members lists them`);
    const brief = typeof input.brief === 'string' ? input.brief.trim() : '';
    const expected = typeof input.expected === 'string' ? input.expected.trim() : '';
    if (brief === '' || brief.length > HANDOFF_TEXT_MAX) throw new TeamError(422, 'invalid', `brief is required (at most ${HANDOFF_TEXT_MAX} characters)`);
    if (expected.length > HANDOFF_TEXT_MAX) throw new TeamError(422, 'invalid', `expected is at most ${HANDOFF_TEXT_MAX} characters`);
    const links = readLinks(input.links);
    if (!links) throw new TeamError(422, 'invalid', 'links must be at most 20 texts');
    const from = input.from ? this.#memberRecord(input.from) : null;
    if (from && from.id === to.id) throw new TeamError(422, 'invalid', 'a member cannot hand off to itself');
    const planRef = typeof input.planRef === 'string' && input.planRef !== '' ? input.planRef.slice(0, 200) : null;
    const handoff = await this.#serial(async () => {
      const now = this.#iso();
      const record: TeamHandoffRecord = {
        id: randomUUID(),
        teamId: DEFAULT_TEAM_ID,
        clock: this.#stamp(),
        deleted: false,
        fromMemberId: from?.id ?? null,
        toMemberId: to.id,
        brief,
        expected,
        state: 'open',
        links,
        todoId: null,
        notifiedAt: null,
        planRef,
        createdAt: now,
        updatedAt: now,
      };
      this.#need().putHandoff(record);
      this.#activity('handoff', to.id, `${from?.name ?? 'You'} handed off to ${to.name}: ${firstLine(brief, 120)}`);
      return record;
    });
    this.#changed(['handoffs', 'activity']);
    await this.#deliverHandoffs();
    if (to.machineId !== this.#selfId()) await this.syncNow();
    return stripHandoff(this.#need().handoffs().find((h) => h.id === handoff.id) ?? handoff);
  }

  /** `PUT /api/team/handoffs/{id}` `{ state }`: the developer accepts / declines / closes one. */
  async setHandoffState(id: string, body: Record<string, unknown>): Promise<TeamHandoff> {
    const state = body['state'];
    if (state !== 'open' && state !== 'accepted' && state !== 'done' && state !== 'declined') throw new TeamError(422, 'invalid', 'state must be open, accepted, done or declined');
    const updated = await this.#serial(async () => {
      const current = this.#need().handoffs().find((h) => h.id === id && !h.deleted);
      if (!current) throw new TeamError(404, 'not-found', `no hand-off ${id}`);
      const next = { ...current, state: state as HandoffState, clock: this.#stamp(), updatedAt: this.#iso() };
      this.#need().putHandoff(next);
      return next;
    });
    this.#changed(['handoffs']);
    return stripHandoff(updated);
  }

  /** The hand-offs whose receiver runs here and has no todo yet get one; with "on hand-off" (and not paused) the agent is told. */
  async #deliverHandoffs(): Promise<void> {
    if (!this.#enabled || !this.#db) return;
    const members = new Map(this.#liveMembers().map((member) => [member.id, member]));
    let changed = false;
    for (const handoff of this.#need().handoffs()) {
      if (handoff.deleted || handoff.state !== 'open' && handoff.state !== 'accepted') continue;
      const to = members.get(handoff.toMemberId);
      if (!to || to.machineId !== this.#selfId()) continue;
      const fromName = handoff.fromMemberId ? (members.get(handoff.fromMemberId)?.name ?? 'a former member') : 'the developer';
      let current = handoff;
      if (current.todoId === null) {
        try {
          const { todo } = await this.#o.todos.add(
            to.sessionId,
            {
              title: firstLine(`Hand-off from ${fromName}: ${current.brief}`, 120),
              description: [current.brief, current.expected ? `Expected result: ${current.expected}` : '', current.links.length > 0 ? `Links: ${current.links.join(' ')}` : ''].filter(Boolean).join('\n\n').slice(0, 4_000),
              plan: [`Hand-off ${current.id} from ${fromName} in team ${this.#team().name}.`, `Brief: ${current.brief}`, current.expected ? `Expected result: ${current.expected}` : '', 'Mark this todo in progress when you start it and done when the expected result is delivered: the hand-off follows it.'].filter(Boolean).join('\n').slice(0, 8_000),
              priority: 'medium',
            },
            current.fromMemberId ? 'agent' : 'developer',
          );
          current = await this.#serial(async () => {
            const next = { ...current, todoId: todo.id, clock: this.#stamp(), updatedAt: this.#iso() };
            this.#need().putHandoff(next);
            return next;
          });
          changed = true;
        } catch (error) {
          this.#error(error);
          continue;
        }
      }
      if (current.notifiedAt === null && to.rhythm.onHandoff && !to.paused) {
        try {
          await this.#o.supervisor.sendMessage(to.sessionId, `New hand-off from ${fromName} (team ${this.#team().name}): ${current.brief}${current.expected ? `\nExpected result: ${current.expected}` : ''}\nIt is todo [${current.todoId}] in your list: start it with todo_start and mark it done with todo_done when finished.`, 'service');
          await this.#serial(async () => {
            this.#need().putHandoff({ ...current, notifiedAt: this.#iso(), clock: this.#stamp(), updatedAt: this.#iso() });
          });
          changed = true;
        } catch (error) {
          this.#error(error);
        }
      }
    }
    if (changed) this.#changed(['handoffs']);
  }

  /** A receiver's todo changed: its hand-off follows it (in progress → accepted, done → done). */
  async #todosChanged(sessionId: string): Promise<void> {
    if (!this.#enabled || !this.#db) return;
    const member = this.#liveMembers().find((m) => m.machineId === this.#selfId() && m.sessionId === sessionId);
    if (!member) return;
    const handoffs = this.#need().handoffs().filter((h) => !h.deleted && h.toMemberId === member.id && h.todoId !== null && (h.state === 'open' || h.state === 'accepted'));
    if (handoffs.length === 0) return;
    let todos: readonly SessionTodo[];
    try {
      todos = (await this.#o.todos.list(sessionId)).todos;
    } catch {
      return;
    }
    let changed = false;
    for (const handoff of handoffs) {
      const todo = todos.find((t) => t.id === handoff.todoId);
      const next: HandoffState | null = todo?.state === 'done' ? 'done' : todo?.state === 'in_progress' || todo?.state === 'review' ? 'accepted' : null;
      if (!next || next === handoff.state) continue;
      await this.#serial(async () => {
        this.#need().putHandoff({ ...handoff, state: next, clock: this.#stamp(), updatedAt: this.#iso() });
        if (next === 'done') this.#activity('handoff', member.id, `${member.name} finished: ${firstLine(handoff.brief, 120)}`);
      });
      changed = true;
    }
    if (changed) this.#changed(['handoffs', 'activity']);
  }

  // ── the agent's side (MCP tools) ──────────────────────────────────────

  /** The member a session of this machine is (Team on), else `null`. */
  memberOfSession(sessionId: string): TeamMemberRecord | null {
    if (!this.#enabled || !this.#db) return null;
    return this.#liveMembers().find((member) => member.machineId === this.#selfId() && member.sessionId === sessionId) ?? null;
  }

  /** `team_members`: the members, their charters and status, as text. */
  async membersText(asSessionId: string): Promise<string> {
    const me = this.memberOfSession(asSessionId);
    if (!me) throw new TeamError(404, 'not-a-member', 'this session is not a team member (or Team is off)');
    const view = await this.view();
    const lines = view.members.map((member) => {
      const you = member.id === me.id ? ' (you)' : '';
      return `- ${member.name}${you} · ${member.status}${member.local ? '' : ` · on ${member.machineName}`}\n  owns: ${member.charter.owns || '—'}\n  produces: ${member.charter.produces || '—'}\n  never does: ${member.charter.neverDoes || '—'}`;
    });
    const open = view.handoffs.filter((h) => h.toMemberId === me.id && (h.state === 'open' || h.state === 'accepted'));
    return [`Team ${view.team.name}: ${view.members.length} member${view.members.length === 1 ? '' : 's'}.`, ...lines, open.length > 0 ? `\nYour open hand-offs: ${open.map((h) => `[todo ${h.todoId ?? 'pending'}] ${firstLine(h.brief, 80)}`).join('; ')}` : ''].filter(Boolean).join('\n');
  }

  /** `team_report`: a short status line in the activity feed. */
  async report(asSessionId: string, text: unknown): Promise<void> {
    const me = this.memberOfSession(asSessionId);
    if (!me) throw new TeamError(404, 'not-a-member', 'this session is not a team member (or Team is off)');
    const line = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
    if (line === '' || line.length > REPORT_MAX) throw new TeamError(422, 'invalid', `text is required (one line, at most ${REPORT_MAX} characters)`);
    await this.#serial(async () => {
      this.#activity('report', me.id, `${me.name}: ${line}`);
    });
    this.#changed(['activity']);
  }

  // ── Needs you, requests, gates ────────────────────────────────────────

  /**
   * `GET /api/team/needs-you`: the members' open questions, permission requests and
   * review cards (derived from the Inbox, this machine's and the paired machines'; not
   * stored again) plus Team's own open requests (gates, budgets; T2 adds access).
   */
  async needsYou(): Promise<TeamNeedsYouItem[]> {
    this.#need();
    const members = this.#liveMembers();
    const bySession = new Map(members.map((member) => [this.#sessionRef(member), member]));
    const inbox: InboxItem[] = [...(await listInbox(this.#o.store)), ...this.#o.peers.remoteInbox()];
    const out: TeamNeedsYouItem[] = [];
    for (const item of inbox) {
      const member = item.sessionId ? bySession.get(item.sessionId) : undefined;
      if (!member) continue;
      out.push({ id: item.id, source: 'inbox', kind: item.kind, memberId: member.id, memberName: member.name, label: needsYouLabel(member.name, item.kind), title: item.title, detail: item.detail, createdAt: item.createdAt, sessionRef: this.#sessionRef(member), inbox: item });
    }
    const byId = new Map(members.map((member) => [member.id, member]));
    for (const request of this.#need().requests()) {
      const member = byId.get(request.memberId);
      if (request.deleted || request.state !== 'open' || !member) continue;
      out.push({ id: request.id, source: 'team', kind: request.kind === 'gate' ? 'gate' : request.kind, memberId: member.id, memberName: member.name, label: needsYouLabel(member.name, request.kind === 'gate' ? 'gate' : request.kind), title: request.title, detail: request.detail, createdAt: request.createdAt, sessionRef: this.#sessionRef(member), request: stripRequest(request) });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Raises a Needs-you request for a member (the gate mechanism; T2's access requests
   * use it too). An open request for the same member and action is reused.
   */
  async requestGate(input: { readonly memberId: string; readonly kind: 'gate' | 'budget' | 'access'; readonly gate: TeamGateKind | null; readonly title: string; readonly detail: string; readonly action: TeamRequestAction | null }): Promise<TeamRequest> {
    const record = await this.#serial(async () => {
      const existing = this.#need().requests().find((r) => !r.deleted && r.state === 'open' && r.memberId === input.memberId && r.kind === input.kind && JSON.stringify(r.action) === JSON.stringify(input.action));
      if (existing) return existing;
      const now = this.#iso();
      const created: TeamRequestRecord = { id: randomUUID(), teamId: DEFAULT_TEAM_ID, clock: this.#stamp(), deleted: false, memberId: input.memberId, kind: input.kind, gate: input.gate, title: input.title, detail: input.detail, state: 'open', action: input.action, note: null, createdAt: now, updatedAt: now };
      this.#need().putRequest(created);
      return created;
    });
    this.#changed(['requests']);
    return stripRequest(record);
  }

  /** `POST /api/team/requests/{id}/approve | decline | dismiss`; an approval runs the request's action on the member's machine. */
  async decide(id: string, decision: 'approve' | 'decline' | 'dismiss'): Promise<TeamRequest> {
    const request = this.#need().requests().find((r) => r.id === id && !r.deleted);
    if (!request) throw new TeamError(404, 'not-found', `no request ${id}`);
    if (request.state !== 'open') throw new TeamError(409, 'decided', `the request is ${request.state} already`);
    const member = this.#liveMembers().find((m) => m.id === request.memberId);
    if (member && member.machineId !== this.#selfId()) {
      await this.#forward(member.machineId, 'POST', `/api/team/requests/${encodeURIComponent(id)}/${decision}`, {});
      await this.syncNow();
      return stripRequest(this.#need().requests().find((r) => r.id === id) ?? request);
    }
    const state = decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'dismissed';
    await this.#serial(async () => {
      this.#need().putRequest({ ...request, state, clock: this.#stamp(), updatedAt: this.#iso() });
      this.#activity('approval', request.memberId, `${decision === 'approve' ? 'Approved' : decision === 'decline' ? 'Declined' : 'Dismissed'}: ${request.title}`);
    });
    this.#changed(['requests', 'activity']);
    let note: string | null = null;
    if (decision === 'approve' && request.action) {
      try {
        note = await this.#run(request, request.action);
      } catch (error) {
        note = `Approved, but it failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (decision === 'decline' && member && request.kind === 'gate') {
      await this.#o.supervisor.sendMessage(member.sessionId, `The developer declined: ${request.title}. Do not do it; carry on with the rest of your work.`, 'service').catch((error: unknown) => this.#error(error));
    }
    if (note !== null) {
      await this.#serial(async () => {
        const current = this.#need().requests().find((r) => r.id === id) ?? request;
        this.#need().putRequest({ ...current, note, clock: this.#stamp(), updatedAt: this.#iso() });
      });
      this.#changed(['requests']);
    }
    return stripRequest(this.#need().requests().find((r) => r.id === id) ?? request);
  }

  async #run(request: TeamRequestRecord, action: TeamRequestAction): Promise<string> {
    if (action.type === 'review-merge') {
      if (!this.#o.reviews) throw new Error('review cards are not available here');
      const review = await this.#o.reviews.act(action.reviewId, 'merge', { teamGate: request.id });
      return review.note ?? 'Merged.';
    }
    if (action.type === 'resume-member') {
      await this.resume(request.memberId);
      return 'Resumed.';
    }
    // T2 seam (external writes through the access mechanism): nothing runs here yet.
    return 'Approved: the member may go ahead.';
  }

  /**
   * D79 seam: a member's review-card Merge into a protected / default branch, with the
   * `merge-default-branch` gate on, needs the developer's approval as a Needs-you
   * request first; the approval runs the merge (`{ teamGate: <request id> }`).
   */
  async #reviewGate(input: { readonly reviewId: string; readonly sessionId: string; readonly action: string; readonly body: unknown; readonly bases: readonly (string | null)[] }): Promise<string | null> {
    if (input.action !== 'merge') return null;
    const member = this.memberOfSession(input.sessionId);
    if (!member || !member.gates.includes('merge-default-branch')) return null;
    const into = input.bases.filter((base): base is string => base !== null && PROTECTED_BRANCH.test(base));
    if (into.length === 0) return null;
    const approvedId = (input.body as { teamGate?: unknown } | null)?.teamGate;
    if (typeof approvedId === 'string' && this.#need().requests().some((r) => r.id === approvedId && r.state === 'approved' && r.memberId === member.id)) return null;
    const request = await this.requestGate({
      memberId: member.id,
      kind: 'gate',
      gate: 'merge-default-branch',
      title: `Merge ${member.name}'s changes into ${[...new Set(into)].join(', ')}`,
      detail: `${member.name} has a review card ready to merge into a protected branch. Approve to run the merge.`,
      action: { type: 'review-merge', reviewId: input.reviewId },
    });
    return `${member.name} needs your approval to merge into ${[...new Set(into)].join(', ')}: approve it in Needs you (request ${request.id}).`;
  }

  // ── the tick: budgets, paused members, hand-offs ──────────────────────

  async #usedToday(member: TeamMemberRecord): Promise<number | null> {
    const since = dayStart(new Date(this.#now()));
    const readings = (await this.#o.store.usage.list(new Date(since.getTime() - 24 * 3600_000).toISOString())).filter((r) => member.budget.profileId === null || r.profileId === member.budget.profileId);
    if (readings.length === 0) return 0;
    return shareOfDaily(pointsUsedSince(readings, new Set([member.sessionId]), since));
  }

  /** One pass (every minute while Team is on): budgets, the loops of paused members, hand-off delivery. */
  async tick(): Promise<void> {
    if (!this.#enabled || !this.#db) return;
    for (const member of this.#liveMembers()) {
      if (member.machineId !== this.#selfId()) continue;
      // A paused member: loops added meanwhile are paused too ("nothing new starts").
      if (member.paused) {
        const paused = await this.#pauseLoops(member);
        if (paused.length > 0) {
          await this.#serial(async () => {
            const current = this.#memberRecord(member.id);
            this.#need().putMember({ ...current, pausedLoops: [...new Set([...current.pausedLoops, ...paused])], clock: this.#stamp(), updatedAt: this.#iso() });
          });
        }
      }
      if (member.budget.dailyPct === null) continue;
      const used = await this.#usedToday(member);
      // Approving a budget request resumes the member for the rest of the day.
      const today = dayStart(new Date(this.#now())).toISOString();
      const waived = this.#need().requests().some((r) => r.memberId === member.id && r.kind === 'budget' && r.state === 'approved' && r.updatedAt >= today);
      if (overBudget(member.budget.dailyPct, used) && !member.paused && !waived) {
        await this.pause(member.id, 'budget');
        await this.requestGate({
          memberId: member.id,
          kind: 'budget',
          gate: null,
          title: `${member.name} is over its daily budget (${used}% of ${member.budget.dailyPct}%)`,
          detail: 'Its Team loops are paused; a running turn continues. Approve to resume it for today, or leave it paused until tomorrow.',
          action: { type: 'resume-member' },
        });
      } else if (member.paused && member.pausedBy === 'budget' && !overBudget(member.budget.dailyPct, used)) {
        // A new day: the budget-paused member runs again.
        await this.resume(member.id);
      }
    }
    await this.#deliverHandoffs();
  }

  // ── sync with paired machines ─────────────────────────────────────────

  /** This machine's records (`POST /api/team/sync` body / answer). */
  async message(): Promise<TeamSyncMessage> {
    const db = this.#need();
    const self = this.#self ?? (await this.#o.peers.self());
    const snapshot: TeamSnapshot = { teams: db.teams(), members: db.members(), handoffs: db.handoffs(), requests: db.requests(), activity: db.activity(DEFAULT_TEAM_ID) };
    return { v: TEAM_SYNC_VERSION, machine: self, snapshot };
  }

  /** A paired machine's records: merged, last writer wins per record; activity is a union. `false` when the body is not a message. */
  async receive(body: unknown): Promise<boolean> {
    const message = readTeamSyncMessage(body);
    if (!message) return false;
    const changed = await this.#serial(async () => {
      const db = this.#need();
      const clock = this.#clock as HybridClock;
      const s = message.snapshot;
      for (const record of [...s.teams, ...s.members, ...s.handoffs, ...s.requests]) clock.observe(record.clock);
      const teams = newerRecords(db.teams(), s.teams);
      const members = newerRecords(db.members(), s.members);
      const handoffs = newerRecords(db.handoffs(), s.handoffs);
      const requests = newerRecords(db.requests(), s.requests);
      const activity = newActivity(db.activity(DEFAULT_TEAM_ID), s.activity);
      db.transaction(() => {
        for (const team of teams) db.putTeam(team);
        for (const member of members) db.putMember(member);
        for (const handoff of handoffs) db.putHandoff(handoff);
        for (const request of requests) db.putRequest(request);
      });
      db.addActivity(activity);
      return { any: teams.length + members.length + handoffs.length + requests.length + activity.length > 0, members };
    });
    this.#syncedWith.add(message.machine.id);
    if (changed.any) {
      this.#refreshRoles();
      this.#publish(['members', 'handoffs', 'requests', 'activity']);
      // A member that now runs here (a move) or whose charter changed elsewhere: its process picks it up.
      for (const member of changed.members) {
        if (member.machineId === this.#selfId()) await this.#applyCharter(member.sessionId);
      }
      await this.#republishMembers();
      await this.#deliverHandoffs();
    }
    return true;
  }

  #syncSoon(): void {
    if (this.#closed || !this.#enabled || this.#soon) return;
    this.#soon = setTimeout(() => {
      this.#soon = undefined;
      void this.syncNow();
    }, this.#o.pushDelayMs ?? 300);
    this.#soon.unref();
  }

  /** One exchange with every online paired machine (an overlapping call runs once more after it). */
  syncNow(): Promise<void> {
    if (!this.#enabled || !this.#db || this.#closed) return Promise.resolve();
    if (this.#syncing) {
      this.#again = true;
      return this.#syncing;
    }
    this.#syncing = this.#syncAll()
      .catch((error: unknown) => this.#error(error))
      .finally(() => {
        this.#syncing = null;
        if (this.#again && !this.#closed) {
          this.#again = false;
          void this.syncNow();
        }
      });
    return this.#syncing;
  }

  async #syncAll(): Promise<void> {
    const online = (await this.#o.peers.machines()).filter((machine) => machine.state === 'online');
    if (online.length === 0) return;
    const message = await this.message();
    await Promise.all(
      online.map(async (machine) => {
        const answer = await this.#o.peers.ask(machine.id, 'POST', TEAM_SYNC_PATH, message, { timeoutMs: 10_000 });
        // An older Switchboard (403: not on its allow-list) or Team off there (404): nothing to merge.
        if (answer.status === null || answer.status < 200 || answer.status >= 300) {
          this.#syncedWith.delete(machine.id);
          return;
        }
        await this.receive(answer.body);
      }),
    );
  }

  // ── move (D65 take-over) ──────────────────────────────────────────────

  /**
   * `POST /api/team/members/{id}/move/check` `{ targetMachineId }`: the take-over's
   * checks (both machines) plus Team's own (a running turn), before anything changes.
   */
  async moveCheck(id: string, body: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly blockers: readonly string[]; readonly preview: unknown }> {
    const member = this.#memberRecord(id);
    const target = typeof body['targetMachineId'] === 'string' ? body['targetMachineId'] : '';
    if (target === '') throw new TeamError(422, 'invalid', 'targetMachineId is required');
    if (member.machineId !== this.#selfId()) return this.#forward(member.machineId, 'POST', `/api/team/members/${encodeURIComponent(id)}/move/check`, body);
    if (target === member.machineId) throw new TeamError(422, 'invalid', `${member.name} runs on that machine already`);
    if (!this.#o.takeover) throw new TeamError(501, 'not-available', 'take-over is not available here');
    const blockers: string[] = [];
    const session = await this.#o.store.sessions.get(member.sessionId);
    if (session?.status === 'run' || this.#o.supervisor.turnRunning(member.sessionId)) blockers.push(`${member.name} is working (a turn is running): move it when the turn has ended`);
    let preview: unknown = null;
    try {
      const answer = await this.#o.takeover.preview({ sessionId: member.sessionId, targetMachine: target });
      preview = answer;
      blockers.push(...answer.blockers);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    return { ok: blockers.length === 0, blockers, preview };
  }

  /** `POST /api/team/members/{id}/move` `{ targetMachineId }` → 202 {@link TeamMoveRun} (poll `GET /api/team/moves/{runId}`). */
  async move(id: string, body: Record<string, unknown>): Promise<TeamMoveRun> {
    const member = this.#memberRecord(id);
    const target = typeof body['targetMachineId'] === 'string' ? body['targetMachineId'] : '';
    if (member.machineId !== this.#selfId()) {
      const run = await this.#forward<TeamMoveRun>(member.machineId, 'POST', `/api/team/members/${encodeURIComponent(id)}/move`, body);
      return { ...run, id: `${member.machineId}~${run.id}` };
    }
    const check = await this.moveCheck(id, body);
    if (!check.ok) throw new TeamError(409, 'blocked', check.blockers.join('; '), { blockers: check.blockers });
    const takeover = this.#o.takeover as TakeoverRunner;
    const sourceLoops = await this.#o.loops.list(member.sessionId).catch(() => [] as OwnedLoop[]);
    const run = await takeover.start({ sessionId: member.sessionId, targetMachine: target });
    const moveRun: TeamMoveRun = { id: randomUUID(), memberId: id, state: 'running', takeoverRunId: run.id, error: null, targetMachineId: target };
    this.#moves.set(moveRun.id, moveRun);
    void this.#followMove(moveRun, sourceLoops).catch((error: unknown) => this.#error(error));
    return moveRun;
  }

  /** `GET /api/team/moves/{runId}` (a paired machine's run: `<machine>~<runId>`). */
  async moveRun(runId: string): Promise<TeamMoveRun> {
    const cut = runId.indexOf('~');
    if (cut > 0) {
      const machineId = runId.slice(0, cut);
      const run = await this.#forward<TeamMoveRun>(machineId, 'GET', `/api/team/moves/${encodeURIComponent(runId.slice(cut + 1))}`, undefined);
      return { ...run, id: runId };
    }
    const run = this.#moves.get(runId);
    if (!run) throw new TeamError(404, 'not-found', `no move ${runId}`);
    return run;
  }

  async #followMove(run: TeamMoveRun, sourceLoops: readonly OwnedLoop[]): Promise<void> {
    const takeover = this.#o.takeover as TakeoverRunner;
    const set = (patch: Partial<TeamMoveRun>): void => {
      this.#moves.set(run.id, { ...(this.#moves.get(run.id) ?? run), ...patch });
    };
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const state = takeover.get(run.takeoverRunId as string);
      if (!state) return set({ state: 'failed', error: 'the take-over run is gone' });
      if (state.state === 'running') continue;
      if (state.state === 'failed' || !state.result) return set({ state: 'failed', error: state.error?.message ?? 'the take-over failed' });
      const result = state.result;
      const moved = parseRemoteId(result.sessionId);
      const newSessionId = moved ? moved.id : result.sessionId;
      // The loops moved with the session (D65: re-created there, ended here); their new ids, by prompt and schedule.
      let targetLoops: OwnedLoop[] = [];
      try {
        const answer = await this.#o.peers.forward(result.machineId, 'GET', `/api/sessions/${encodeURIComponent(newSessionId)}/loops`, undefined);
        if (answer.status === 200 && Array.isArray(answer.body)) targetLoops = answer.body as OwnedLoop[];
      } catch {
        // Kept by prompt + schedule until the next read there.
      }
      const remap = (loopId: string): string => {
        const source = sourceLoops.find((loop) => loop.id === loopId);
        const found = source ? targetLoops.find((loop) => loop.prompt === source.prompt && loop.scheduleText === source.scheduleText) : undefined;
        return found?.id ?? loopId;
      };
      const machines = await this.#machineNames();
      const before = this.#memberRecord(run.memberId);
      await this.#serial(async () => {
        const current = this.#memberRecord(run.memberId);
        this.#need().putMember({
          ...current,
          machineId: result.machineId,
          sessionId: newSessionId,
          rhythm: { ...current.rhythm, loops: current.rhythm.loops.map((loop) => ({ ...loop, loopId: remap(loop.loopId) })) },
          pausedLoops: current.pausedLoops.map(remap),
          // T2 seam: access is never moved; every entry now needs setup on the target.
          access: current.access.map((entry) => ({ ...entry, setUpOn: entry.setUpOn.filter((machine) => machine === result.machineId) })),
          clock: this.#stamp(),
          updatedAt: this.#iso(),
        });
        this.#activity('move', run.memberId, `Moved ${before.name} from ${machines.get(this.#selfId())?.name ?? 'this machine'} to ${machines.get(result.machineId)?.name ?? result.machineName}`);
      });
      this.#changed(['members', 'activity']);
      await this.syncNow();
      // The member is told which access needs setting up again (T2 fills the entries; none yet).
      const missing = before.access.filter((entry) => !entry.setUpOn.includes(result.machineId)).map((entry) => entry.name);
      if (missing.length > 0) {
        await this.#o.peers
          .forward(result.machineId, 'POST', `/api/sessions/${encodeURIComponent(newSessionId)}/messages`, { text: `You moved to ${result.machineName}. These accesses need setting up there before you use them: ${missing.join(', ')}.` })
          .catch((error: unknown) => this.#error(error));
      }
      return set({ state: 'done' });
    }
  }

  // ── suggestions ───────────────────────────────────────────────────────

  /** `GET /api/team/suggestions`: candidate members from the existing sessions, with evidence (T3 drafts the charters). */
  async suggestions(): Promise<TeamSuggestion[]> {
    this.#need();
    const members = new Set(this.#liveMembers().filter((m) => m.machineId === this.#selfId()).map((m) => m.sessionId));
    return computeSuggestions({ store: this.#o.store, loops: this.#o.loops, exclude: members, now: this.#now() });
  }

  // ── the charter hook ──────────────────────────────────────────────────

  async #charterFor(sessionId: string): Promise<string | null> {
    const member = this.memberOfSession(sessionId);
    if (!member) return null;
    return charterInstruction(member.name, this.#team().name, member.charter, member.gates);
  }

  // ── forwarding to the member's machine ────────────────────────────────

  async #forward<T>(machineId: string, method: string, path: string, body: unknown): Promise<T> {
    if (peerCall.getStore() === true) throw new TeamError(409, 'not-here', 'that member does not run on this machine (its record is out of date here): try again in a moment');
    const answer = await this.#o.peers.forward(machineId, method, path, body);
    if (answer.status >= 200 && answer.status < 300) return answer.body as T;
    const error = (answer.body ?? {}) as { error?: unknown; message?: unknown };
    throw new TeamError(answer.status, typeof error.error === 'string' ? error.error : 'peer-failed', typeof error.message === 'string' ? error.message : `the paired machine answered HTTP ${answer.status}`, answer.body as Record<string, unknown> | null);
  }
}

function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function stripHandoff(record: TeamHandoffRecord): TeamHandoff {
  const { clock: _clock, deleted: _deleted, ...rest } = record;
  return rest;
}

function stripRequest(record: TeamRequestRecord): TeamRequest {
  const { clock: _clock, deleted: _deleted, ...rest } = record;
  return rest;
}
