import { randomUUID } from 'node:crypto';
import type { InboxItem, OwnedLoop, Session, SessionModelInput, SessionTodo } from '../../core/api.ts';
import { HybridClock } from '../../core/hlc.ts';
import { DEFAULT_MODEL_VALUE, normalizeModel } from '../../core/model-choice.ts';
import { remoteId, parseRemoteId } from '../../core/peers.ts';
import { isPlaced, looseList, placeOf, placeSession } from '../../core/sidebar-layout.ts';
import {
  type TeamMoveRun,
  ALL_TEAMS,
  CHARTER_ASK_STALE_MS,
  CHARTER_NOTES_MAX,
  type TeamCharterRequestView,
  charterAskText,
  DEFAULT_TEAM_ID,
  DEFAULT_TEAM_NAME,
  EMPTY_CHARTER,
  HANDOFF_TEXT_MAX,
  MEMBERS_MAX,
  NO_BUDGET,
  REPORT_MAX,
  TEAMS_MAX,
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
  type TeamSummary,
  type TeamView,
  type TeamWorkplace,
  byOrder,
  charterInstruction,
  checkTeamName,
  nextOrder,
  reorderIds,
  memberStatus,
  needsYouLabel,
  normalizeGates,
  parseHandoffTarget,
  readBudget,
  readCharter,
  sameCharter,
  readLinks,
  readRhythmInput,
  readWorkplace,
  returnNote,
} from '../../core/team.ts';
import { TEAM_TEMPLATES, isTemplateCharter, templateById } from '../../core/team-templates.ts';
import { dayStart, overBudget, pointsUsedSince, shareOfDaily } from '../../core/team-budget.ts';
import { type TeamSnapshot, type TeamSyncMessage, TEAM_SYNC_PATH, TEAM_SYNC_VERSION, keepOrder, newActivity, newerRecords, readTeamSyncMessage } from '../../core/team-sync.ts';
import type { Store } from '../db/store.ts';
import type { HubBus } from '../hub/bus.ts';
import { listInbox } from '../inbox/wire.ts';
import type { LoopService } from '../loops/owned.ts';
import type { PeerService } from '../peers/service.ts';
import { ModelChoiceError, type SessionSupervisor, SupervisorError } from '../supervisor/supervisor.ts';
import { type TargetPlacement, placementOf } from '../../core/takeover.ts';
import type { TakeoverRunner } from '../takeover/runner.ts';
import type { TodoService } from '../todos/service.ts';
import { TeamAccess, accessIdOfRef } from './access/service.ts';
import { type SecretStore, defaultSecretStore } from './access/secret-store.ts';
import { TeamDb } from './db.ts';
import { type TeamMemberRef, registerTeamHooks } from './hooks.ts';
// Project memory (D107) hook: a moved member's member-scoped memory goes with it (docs/memory-removal.md).
import { memoryMemberMoved } from '../memory/hooks.ts';
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
  readonly takeover: TakeoverRunner | null;
  /** `true` for a hooked terminal session (D48 P4; refused for adoption). */
  readonly isHooked: (sessionId: string) => Promise<boolean>;
  /** Starts a new session (`POST /api/sessions`'s logic) and runs `beforeSpawn` once it is stored, before its process starts. */
  readonly startSession?: (body: unknown, beforeSpawn: (sessionId: string) => Promise<void>) => Promise<{ readonly ok: true; readonly sessionId: string } | { readonly ok: false; readonly status: number; readonly body: unknown }>;
  readonly now?: () => number;
  /** D100-T2: the keychain access values go to (default: this OS's, or the in-memory one under tests). */
  readonly secretStore?: SecretStore;
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

/** D105 · the one-time "Draft better charters" offer's mark in the main `settings` table (`done` = acted on or Not now; `docs/team-removal.md`). */
export const CHARTER_OFFER_SETTING = 'team.charterOffer';

/** Statuses of a session that count as the session existing for Team. */
const STATUSES: ReadonlySet<string> = new Set(['need', 'run', 'done', 'fail', 'idle', 'paused']);

/** A running move (`POST /api/team/members/{id}/move`). */
export type { TeamMoveRun } from '../../core/team.ts';

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
  /** D100-T2: access requests (`access/service.ts`). */
  readonly access: TeamAccess;

  constructor(options: TeamServiceOptions) {
    this.#o = options;
    this.access = new TeamAccess({
      store: options.store,
      supervisor: options.supervisor,
      secrets: options.secretStore ?? defaultSecretStore(),
      db: () => this.#need(),
      available: () => this.#enabled && this.#db !== null,
      selfId: () => this.#selfId(),
      stamp: () => this.#stamp(),
      now: () => this.#now(),
      serial: (work) => this.#serial(work),
      changed: (what) => this.#changed(what),
      activity: (kind, memberId, text) => this.#activity(kind, memberId, text),
      members: () => this.#liveMembers(),
      memberOfSession: (sessionId) => this.memberOfSession(sessionId),
      requestGate: (input) => this.requestGate(input),
      machineNames: () => this.#machineNames(),
      reload: async (sessionId) => {
        await this.#o.supervisor.instructionSettingChanged().catch(() => undefined);
        try {
          return await this.#o.supervisor.reloadInstruction(sessionId);
        } catch (error) {
          this.#error(error);
          return 'failed';
        }
      },
      error: (error) => this.#error(error),
    });
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
      sessionModelChanged: (sessionId, model, effort) => this.sessionModelChanged(sessionId, model, effort),
      roleOf: (sessionId) => this.#roles.get(sessionId) ?? null,
      switchChanged: () => this.switchChanged(),
      // D100-T2: a member's access at its spawn (servers, environment, masking).
      accessServers: (sessionId) => this.access.serversFor(sessionId),
      accessEnv: (sessionId) => this.access.envFor(sessionId),
      mask: (sessionId) => this.access.maskerFor(sessionId),
      // Project memory (D107) hook: the member scope (docs/memory-removal.md).
      memberOf: (sessionId) => {
        const member = this.memberOfSession(sessionId);
        return member ? this.#memberRef(member) : null;
      },
      memberList: () => (this.#enabled && this.#db ? this.#liveMembers().map((member) => this.#memberRef(member)) : []),
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

  /** Project memory (D107) hook: a member as Project memory sees it. */
  #memberRef(member: TeamMemberRecord): TeamMemberRef {
    return { id: member.id, name: member.name, teamId: member.teamId, sessionId: member.sessionId, machineId: member.machineId, here: member.machineId === this.#selfId(), paused: member.paused };
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

  #publish(what: readonly string[], teamId: string = DEFAULT_TEAM_ID): void {
    this.#o.bus.publish('teamChanged', { teamId, what });
  }

  #ensureTeam(): void {
    const db = this.#db as TeamDb;
    // The first team on a fresh team.db only (D100 follow-up 2026-10-14: once deleted, it is not made again).
    if (db.teams().length > 0) return;
    const now = this.#iso();
    db.putTeam({ id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME, clock: '', deleted: false, order: 0, createdAt: now, updatedAt: now });
  }

  /** The teams (not deleted) in their order (D100 follow-up 2026-10-14: multiple teams; the first one always exists). */
  #teams(): TeamRecord[] {
    const live = this.#need().teams().filter((team) => !team.deleted);
    // Never none (a team.db whose teams are all tombstones, e.g. synced so): the first team as it was.
    if (live.length === 0) live.push({ id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME, clock: '', deleted: false, order: 0, createdAt: '', updatedAt: '' });
    return byOrder(live);
  }

  /**
   * A team by id; `undefined` / `''` = the first team: `team` while it exists, else
   * (D100 follow-up 2026-10-14: it was deleted) the first remaining team in order.
   * @throws {TeamError} 404 for an unknown or deleted team.
   */
  #team(teamId?: string | null): TeamRecord {
    const id = teamId === undefined || teamId === null || teamId === '' ? this.#defaultTeamId() : teamId;
    const team = this.#teams().find((t) => t.id === id);
    if (!team) throw new TeamError(404, 'not-found', `no team ${id}`);
    return team;
  }

  /** The team the routes without a team id act on: `team` while it exists, else the first team in order. */
  #defaultTeamId(): string {
    const teams = this.#teams();
    return (teams.find((team) => team.id === DEFAULT_TEAM_ID) ?? teams[0])?.id ?? DEFAULT_TEAM_ID;
  }

  /** A team's name for texts (a deleted or unknown team: the first team's). */
  #teamName(teamId: string): string {
    return (this.#teams().find((team) => team.id === teamId) ?? this.#team()).name;
  }

  /** Every team's members (not deleted), by the teams' order, then each team's order (D100 follow-ups 2026-10-14). */
  #liveMembers(): TeamMemberRecord[] {
    const teams = this.#teams();
    const rank = new Map(teams.map((team, index) => [team.id, index]));
    const live = this.#need().members().filter((member) => !member.deleted && rank.has(member.teamId));
    return teams.flatMap((team) => byOrder(live.filter((member) => member.teamId === team.id)));
  }

  /** One team's members (not deleted) in its order. */
  #teamMembers(teamId: string): TeamMemberRecord[] {
    return byOrder(this.#need().members().filter((member) => !member.deleted && member.teamId === teamId));
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

  #changed(what: readonly string[], teamId?: string): void {
    this.#refreshRoles();
    this.#publish(what, teamId);
    this.#syncSoon();
  }

  /** An activity line in `teamId` (default: the member's team, else the first team). */
  #activity(kind: TeamActivityKind, memberId: string | null, text: string, teamId?: string): void {
    const team = teamId ?? (memberId ? this.#need().members().find((member) => member.id === memberId)?.teamId : undefined) ?? this.#defaultTeamId();
    this.#need().addActivity([{ id: randomUUID(), teamId: team, at: this.#iso(), kind, memberId, text }]);
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
      charterRequest: this.#charterRequestView(member.id),
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

  /** `GET /api/team[?teamId=]` (without one: the first team). */
  async view(teamId?: string | null): Promise<TeamView> {
    const db = this.#need();
    const team = this.#team(teamId);
    const machines = await this.#machineNames();
    const records = this.#teamMembers(team.id);
    const members = await Promise.all(records.map((member) => this.#toMember(member, machines)));
    const self = this.#self ?? (await this.#o.peers.self());
    // The hand-offs to the team's members (a cross-team hand-off shows in the receiver's team).
    const ids = new Set(records.map((member) => member.id));
    return {
      team: { id: team.id, name: team.name },
      self,
      members,
      handoffs: db.handoffs().filter((h) => !h.deleted && (h.teamId === team.id || ids.has(h.toMemberId))).map(stripHandoff).reverse(),
      activity: db.activity(team.id, 100),
      charterOffer: await this.#charterOffer(),
    };
  }

  /** `GET /api/team/teams` (D100 follow-up 2026-10-14): every team in order, with its members and how many need the developer. */
  async teamList(): Promise<TeamSummary[]> {
    this.#need();
    const machines = await this.#machineNames();
    const items = await this.needsYou(ALL_TEAMS);
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.memberId, (counts.get(item.memberId) ?? 0) + 1);
    const out: TeamSummary[] = [];
    for (const team of this.#teams()) {
      const members = this.#teamMembers(team.id);
      let needsYou = 0;
      for (const member of members) {
        if ((counts.get(member.id) ?? 0) > 0) needsYou += 1;
        else if ((await this.#sessionFacts(member, machines)).status === 'need') needsYou += 1;
      }
      out.push({ id: team.id, name: team.name, order: team.order, members: members.length, needsYou });
    }
    return out;
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

  /** `GET /api/team/activity?before=&limit=&teamId=`. */
  activity(before?: string, limit = 100, teamId?: string | null): TeamActivityRecord[] {
    return this.#need().activity(this.#team(teamId).id, Math.max(1, Math.min(limit, 500)), before);
  }

  /** `GET /api/team/templates`. */
  templates(): typeof TEAM_TEMPLATES {
    this.#need();
    return TEAM_TEMPLATES;
  }

  /** `PUT /api/team` `{ name }` (the first team), `PUT /api/team/teams/{id}` `{ name }` (D100 follow-up 2026-10-14). */
  async rename(body: unknown, teamId?: string | null): Promise<TeamView> {
    const name = checkTeamName((body as { name?: unknown } | null)?.name);
    if (!name) throw new TeamError(422, 'invalid', 'name must be 1–40 characters on one line');
    const id = this.#team(teamId).id;
    await this.#serial(async () => {
      const team = this.#team(id);
      if (this.#teams().some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) throw new TeamError(409, 'name-taken', `a team is called ${name} already`);
      this.#need().putTeam({ ...team, name, clock: this.#stamp(), updatedAt: this.#iso() });
      this.#activity('team', null, `renamed to ${name}`, id);
    });
    this.#changed(['team'], id);
    await this.#republishMembers();
    return this.view(id);
  }

  /** `POST /api/team/teams` `{ name }` (D100 follow-up 2026-10-14): a new, empty team at the end. */
  async createTeam(body: Record<string, unknown>): Promise<TeamSummary> {
    this.#need();
    const name = checkTeamName(body['name']);
    if (!name) throw new TeamError(422, 'invalid', 'name must be 1–40 characters on one line', { errors: [{ field: 'name', message: 'name must be 1–40 characters on one line' }] });
    const team = await this.#serial(async () => {
      const teams = this.#teams();
      if (teams.length >= TEAMS_MAX) throw new TeamError(409, 'too-many', `at most ${TEAMS_MAX} teams`);
      if (teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new TeamError(409, 'name-taken', `a team is called ${name} already`);
      const now = this.#iso();
      const record: TeamRecord = { id: randomUUID(), name, clock: this.#stamp(), deleted: false, order: nextOrder(teams), createdAt: now, updatedAt: now };
      this.#need().putTeam(record);
      this.#activity('team', null, `team ${name} created`, record.id);
      return record;
    });
    this.#changed(['teams'], team.id);
    return { id: team.id, name: team.name, order: team.order, members: 0, needsYou: 0 };
  }

  /**
   * `DELETE /api/team/teams/{id}` (D100 follow-up 2026-10-14): every member returns to
   * the sessions list as with ↩ Return to sessions (folder and position restored; a
   * paired machine's member on its machine), then the team is removed (a tombstone,
   * synced). Never deletes a session. Any team can be deleted while another remains (409
   * `last-team`; the first team too, ruling 2026-10-14); a member whose
   * machine is offline keeps the team until it is back (502, nothing changed).
   */
  async deleteTeam(id: string): Promise<{ readonly ok: true; readonly returned: number }> {
    const team = this.#team(id);
    // Any team, the first one too, while another one remains (D100 follow-up 2026-10-14, the developer's ruling).
    if (this.#teams().length <= 1) throw new TeamError(409, 'last-team', 'the last team cannot be deleted: create another team first, or return its members');
    const members = this.#teamMembers(team.id);
    const machines = await this.#machineNames();
    const away = members.filter((member) => member.machineId !== this.#selfId() && machines.get(member.machineId)?.online !== true);
    if (away.length > 0) {
      const names = [...new Set(away.map((member) => machines.get(member.machineId)?.name ?? member.machineId))].join(', ');
      throw new TeamError(502, 'peer-unreachable', `${names} is offline: ${away.map((m) => m.name).join(', ')} cannot return to its session list now. Delete the team when it is back.`);
    }
    for (const member of members) await this.returnMember(member.id);
    await this.#serial(async () => {
      const current = this.#team(team.id);
      this.#need().putTeam({ ...current, deleted: true, clock: this.#stamp(), updatedAt: this.#iso() });
    });
    this.#changed(['teams', 'members'], team.id);
    await this.#republishMembers();
    return { ok: true, returned: members.length };
  }

  /** `PUT /api/team/teams/order` `{ teamIds }` (D100 follow-up 2026-10-14): the teams' order (synced like the members'). */
  async reorderTeams(body: Record<string, unknown>): Promise<TeamSummary[]> {
    this.#need();
    const changed = await this.#serial(async () => {
      const teams = this.#teams();
      const ids = reorderIds(
        teams.map((team) => team.id),
        body['teamIds'],
      );
      if (!ids) throw new TeamError(422, 'invalid', 'teamIds must list teams, each once', { errors: [{ field: 'teamIds', message: 'unknown or repeated team id' }] });
      const byId = new Map(teams.map((team) => [team.id, team]));
      let any = false;
      this.#need().transaction(() => {
        ids.forEach((id, index) => {
          const team = byId.get(id) as TeamRecord;
          if (team.order === index && team.clock !== '') return;
          this.#need().putTeam({ ...team, order: index, clock: this.#stamp(), updatedAt: this.#iso() });
          any = true;
        });
      });
      return any;
    });
    if (changed) this.#changed(['teams']);
    return this.teamList();
  }

  /**
   * `POST /api/team/members/{id}/team` `{ teamId }` (D100 follow-up 2026-10-14): the
   * member moves to another team, at its end. Charter, rhythm, budget, gates and access
   * are kept; hand-offs stay as they are. Its agent gets the new team's name with its
   * next message (the charter names the team).
   */
  async moveToTeam(id: string, body: Record<string, unknown>): Promise<TeamMember> {
    this.#need();
    if (typeof body['teamId'] !== 'string' || body['teamId'] === '') throw new TeamError(422, 'invalid', 'teamId is required', { errors: [{ field: 'teamId', message: 'teamId is required' }] });
    const target = this.#team(body['teamId']);
    const before = this.#memberRecord(id);
    if (before.teamId === target.id) return this.member(id);
    const moved = await this.#serial(async () => {
      if (this.#teamMembers(target.id).length >= MEMBERS_MAX) throw new TeamError(409, 'too-many', `a team has at most ${MEMBERS_MAX} members`);
      const current = this.#memberRecord(id);
      const next: TeamMemberRecord = { ...current, teamId: target.id, order: nextOrder(this.#teamMembers(target.id)), clock: this.#stamp(), updatedAt: this.#iso() };
      this.#need().putMember(next);
      const from = this.#teamName(current.teamId);
      this.#activity('update', id, `moved to team ${target.name}`, current.teamId);
      this.#activity('update', id, `joined from team ${from}`, target.id);
      return next;
    });
    this.#changed(['members', 'activity'], before.teamId);
    this.#publish(['members', 'activity'], target.id);
    if (moved.machineId === this.#selfId()) await this.#applyCharter(moved.sessionId);
    return this.member(id);
  }

  // ── adopt, create, update, return ─────────────────────────────────────

  #assertCapacity(teamId: string): void {
    if (this.#teamMembers(teamId).length >= MEMBERS_MAX) throw new TeamError(409, 'too-many', `a team has at most ${MEMBERS_MAX} members`);
  }

  /** The team a body names (`teamId`; none = the first team). @throws {TeamError} 422 for an unknown one. */
  #bodyTeam(body: Record<string, unknown>): TeamRecord {
    const raw = body['teamId'];
    if (raw === undefined || raw === null || raw === '') return this.#team();
    const team = typeof raw === 'string' ? this.#teams().find((t) => t.id === raw) : undefined;
    if (!team) throw new TeamError(422, 'invalid', 'no such team', { errors: [{ field: 'teamId', message: 'no such team' }] });
    return team;
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
    const team = this.#bodyTeam(body);
    const session = await this.#o.store.sessions.get(sessionId);
    if (!session) throw new TeamError(404, 'not-found', `no session ${sessionId}`);
    if (session.closedAt !== null) throw new TeamError(409, 'closed', 'the session is closed: reopen it first');
    // D106: a chat only plans: continue it as a session to make it a member.
    if (session.kind === 'chat') throw new TeamError(409, 'chat', 'a chat cannot be a team member: continue it as a session first');
    if (session.hooked || (await this.#o.isHooked(sessionId))) {
      throw new TeamError(409, 'hooked', 'This is a hooked terminal session: Switchboard does not run its CLI, so it cannot get a charter. Continue it in Switchboard first (its ⋯ menu → Continue in Switchboard), then adopt it.');
    }
    if (!session.attached) throw new TeamError(409, 'detached', 'the session continues in a terminal: attach it here first');
    // D100 follow-up 2026-10-14: a model / effort chosen in the Adopt form becomes the session's (as the header's picker).
    await this.#applyModel(sessionId, modelInput(fields));
    const fresh = (await this.#o.store.sessions.get(sessionId)) ?? session;
    const record = await this.#serial(async () => {
      this.#assertCapacity(team.id);
      // One team per session (D100 follow-up 2026-10-14): any team counts.
      const already = this.#liveMembers().find((member) => member.machineId === this.#selfId() && member.sessionId === sessionId);
      if (already) {
        throw new TeamError(409, 'already-member', already.teamId === team.id ? 'this session is already a member of the team' : `this session is already a member of team ${this.#teamName(already.teamId)} (a session can be in one team only)`);
      }
      const now = this.#iso();
      const member: TeamMemberRecord = {
        id: randomUUID(),
        teamId: team.id,
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
        model: fields.model !== undefined ? fields.model : fresh.model,
        effort: fields.effort !== undefined ? fields.effort : fresh.effort,
        rhythm: { loops: await this.#rhythmFromIds(sessionId, fields.rhythm?.loopIds ?? []), onHandoff: fields.rhythm?.onHandoff ?? true },
        budget: fields.budget ?? NO_BUDGET,
        gates: fields.gates ?? normalizeGates([]),
        paused: false,
        pausedLoops: [],
        pausedBy: null,
        cliLoops: await this.#cliLoops(sessionId),
        originalPlace: await this.#placeNow(sessionId),
        access: [],
        // New members go to the end of the team's order.
        order: nextOrder(this.#teamMembers(team.id)),
        createdAt: now,
        updatedAt: now,
      };
      this.#need().putMember(member);
      this.#activity('adopt', member.id, `adopted from session ${session.title ?? session.name}`);
      return member;
    });
    this.#changed(['members', 'activity']);
    await this.#applyCharter(sessionId);
    // D105: the Adopt form asks the new member's agent for a specific charter (the developer still approves it).
    if (body['askCharter'] === true) await this.askCharter(record.id).catch((error: unknown) => this.#error(error));
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
    const team = this.#bodyTeam(body);
    this.#assertCapacity(team.id);
    const template = templateById(fields.templateId ?? null);
    const sessionBody = { ...((body['session'] ?? {}) as Record<string, unknown>) };
    // A session name of its own (kebab-case, unique): the role's slug and a short suffix.
    if (sessionBody['name'] === undefined) sessionBody['name'] = `${(fields.name ?? 'member').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'member'}-${randomUUID().slice(0, 4)}`;
    if (sessionBody['task'] === undefined) sessionBody['task'] = '';
    // The template's model is recorded on the member, not forced on the session (it may not be on offer for this CLI).
    if (sessionBody['model'] === undefined && fields.model) sessionBody['model'] = fields.model;
    if (sessionBody['effort'] === undefined && fields.effort) sessionBody['effort'] = fields.effort;
    let memberId: string | null = null;
    const outcome = await this.#o.startSession(sessionBody, async (sessionId) => {
      const session = await this.#o.store.sessions.get(sessionId);
      const now = this.#iso();
      const member: TeamMemberRecord = {
        id: randomUUID(),
        teamId: team.id,
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
        model: session?.model ?? fields.model ?? template?.model.model ?? null,
        effort: session?.effort ?? fields.effort ?? template?.model.effort ?? null,
        rhythm: { loops: [], onHandoff: fields.rhythm?.onHandoff ?? template?.rhythm.onHandoff ?? true },
        budget: fields.budget ?? NO_BUDGET,
        gates: fields.gates ?? normalizeGates([]),
        paused: false,
        pausedLoops: [],
        pausedBy: null,
        cliLoops: [],
        originalPlace: { place: 'none', folderId: null, index: null },
        access: [],
        order: 0,
        createdAt: now,
        updatedAt: now,
      };
      await this.#serial(async () => {
        // New members go to the end of the team's order.
        this.#need().putMember({ ...member, order: nextOrder(this.#teamMembers(team.id)) });
        this.#activity('create', member.id, 'started as a new member');
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
    // D100 follow-up 2026-10-14 (model dropdown): a model / effort change goes to the session first, the way the
    // session header's picker does (a running turn finishes on the old one); a refusal changes nothing. On a paired
    // machine's member it is stored here and applied there when the record arrives (`receive`).
    if (local) await this.#applyModel(before.sessionId, modelInput(fields));
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
      this.#activity('update', id, 'settings changed');
      return next;
    });
    this.#changed(['members', 'activity']);
    const charterChanged = fields.charter !== undefined || fields.name !== undefined || fields.gates !== undefined;
    if (charterChanged && local) await this.#applyCharter(after.sessionId);
    return this.member(id);
  }

  /**
   * `PUT /api/team/order` `{ memberIds }` (D100 follow-up 2026-10-14): the members'
   * order in the team (cards strip, phone list, `team_members`). Ids the body leaves
   * out keep their relative order after the given ones; an unknown id is refused.
   * Part of the synced definition: only the members whose place changed get a new
   * clock (last writer wins per member), so it shows on the paired machines too.
   */
  async reorder(body: Record<string, unknown>): Promise<TeamView> {
    this.#need();
    // The team: the body's `teamId`, else the first listed member's, else the first team.
    const firstId = Array.isArray(body['memberIds']) ? body['memberIds'][0] : undefined;
    const teamId = typeof body['teamId'] === 'string' && body['teamId'] !== '' ? this.#team(body['teamId']).id : (this.#liveMembers().find((m) => m.id === firstId)?.teamId ?? this.#defaultTeamId());
    const changed = await this.#serial(async () => {
      const members = this.#teamMembers(teamId);
      const ids = reorderIds(
        members.map((member) => member.id),
        body['memberIds'],
      );
      if (!ids) throw new TeamError(422, 'invalid', 'memberIds must list members of the team, each once', { errors: [{ field: 'memberIds', message: 'unknown or repeated member id' }] });
      const byId = new Map(members.map((member) => [member.id, member]));
      let any = false;
      this.#need().transaction(() => {
        ids.forEach((id, index) => {
          const member = byId.get(id) as TeamMemberRecord;
          if (member.order === index) return;
          this.#need().putMember({ ...member, order: index, clock: this.#stamp(), updatedAt: this.#iso() });
          any = true;
        });
      });
      return any;
    });
    if (changed) this.#changed(['members', 'order'], teamId);
    return this.view(teamId);
  }

  /**
   * D100 follow-up 2026-10-14: sets the session's model / effort through the session
   * header's mechanism (`SessionSupervisor.setModel`: checked against the models the
   * CLI reported; a live process gets `set_model` / `apply_flag_settings` and uses
   * it from its next turn; stored for every later spawn). Nothing given: nothing.
   * @throws {TeamError} 422 for a model or effort not on offer; 409 when the CLI refused it.
   */
  async #applyModel(sessionId: string, input: SessionModelInput): Promise<void> {
    if (input.model === undefined && input.effort === undefined) return;
    try {
      await this.#o.supervisor.setModel(sessionId, input);
    } catch (error) {
      if (error instanceof ModelChoiceError) throw new TeamError(422, 'invalid', error.message, { errors: [{ field: error.field, message: error.message }] });
      if (error instanceof SupervisorError) throw new TeamError(409, error.code, error.message);
      throw error;
    }
  }

  /**
   * The developer chose a model / effort in a member's session header (`PUT
   * /api/sessions/{id}/model`, the `teamSessionModelChanged` hook; D100 follow-up
   * 2026-10-14): the member's saved choice follows and syncs. D82's routing and D63's
   * account switching do not come through here, so they never change it.
   */
  async sessionModelChanged(sessionId: string, model: string | null, effort: string | null): Promise<void> {
    if (!this.memberOfSession(sessionId)) return;
    const changed = await this.#serial(async () => {
      const current = this.memberOfSession(sessionId);
      if (!current || (normalizeModel(current.model) === model && current.effort === effort)) return null;
      this.#need().putMember({ ...current, model: model ?? DEFAULT_MODEL_VALUE, effort, clock: this.#stamp(), updatedAt: this.#iso() });
      return current;
    });
    if (changed) this.#changed(['members'], changed.teamId);
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
    const teamName = this.#teamName(before.teamId);
    const member = await this.#serial(async () => {
      const current = this.#memberRecord(id);
      // Its Team pause ends with it: the loops Team paused run again as the session's own.
      await this.#resumeLoops(current);
      this.#need().putMember({ ...current, deleted: true, paused: false, pausedLoops: [], pausedBy: null, clock: this.#stamp(), updatedAt: this.#iso() });
      this.#activity('return', id, 'returned to the sessions list');
      return current;
    });
    // D100-T2: its accesses end with it (this machine's values leave the keychain).
    await this.access.memberRemoved(id).catch((error: unknown) => this.#error(error));
    this.#changed(['members', 'activity']);
    await this.#restorePlace(member);
    const session = await this.#o.store.sessions.get(member.sessionId);
    if (session && session.closedAt === null) {
      await this.#applyCharter(member.sessionId);
      if (options.note !== false && this.#o.supervisor.isLive(member.sessionId)) {
        await this.#o.supervisor.sendMessage(member.sessionId, returnNote(member.name, teamName), 'service').catch((error: unknown) => this.#error(error));
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
      if (!current.paused) this.#activity('pause', id, by === 'budget' ? 'over its daily budget — loops paused' : 'paused');
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
      if (current.paused) this.#activity('resume', id, 'resumed');
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

  /**
   * A hand-off's receiver (D100 follow-up 2026-10-14: multiple teams): a member id (any
   * team), else a role name in `team` (an explicit team argument, by name or id), in the
   * team written as "Name (Team)", or in `scope` (the caller's own team by default).
   * @throws {TeamError} 404 naming where it looked (and the team to name, when only another team has that role).
   */
  #receiver(to: string, team: unknown, scope: string): TeamMemberRecord {
    const byId = this.#liveMembers().find((member) => member.id === to);
    if (byId) return byId;
    const teams = this.#teams();
    let target: TeamRecord | undefined;
    let name = to.trim();
    if (typeof team === 'string' && team.trim() !== '') {
      const wanted = team.trim().toLowerCase();
      target = teams.find((t) => t.id === team || t.name.toLowerCase() === wanted);
      if (!target) throw new TeamError(404, 'not-found', `no team called "${team}"`);
    } else {
      const parsed = parseHandoffTarget(to, teams.map((t) => t.name));
      if (parsed.team) {
        target = teams.find((t) => t.name.toLowerCase() === (parsed.team as string).toLowerCase());
        name = parsed.name;
      }
    }
    const inTeam = target ?? teams.find((t) => t.id === scope) ?? this.#team();
    const wanted = name.toLowerCase();
    const found = this.#teamMembers(inTeam.id).find((member) => member.name.toLowerCase() === wanted);
    if (found) return found;
    const elsewhere = this.#liveMembers().filter((member) => member.name.toLowerCase() === wanted && member.teamId !== inTeam.id);
    const hint = elsewhere.length > 0 ? `; ${elsewhere.map((m) => `"${m.name} (${this.#teamName(m.teamId)})"`).join(' or ')} is in another team: name it with its team` : '';
    throw new TeamError(404, 'not-found', `no member called "${name}" in team ${inTeam.name}: team_members lists them${hint}`);
  }

  /**
   * Creates a hand-off (`POST /api/team/handoffs` from the developer, `team_handoff`
   * from a member). The receiver's machine turns it into a todo in the receiver's
   * session (D68) and, with rhythm "on hand-off", tells its agent.
   */
  async createHandoff(input: { readonly from: string | null; readonly to: string; readonly brief: unknown; readonly expected: unknown; readonly links: unknown; readonly planRef?: unknown; readonly team?: unknown; readonly teamId?: unknown }): Promise<TeamHandoff> {
    this.#need();
    // Within the sender's team by default (the developer's: the body's `teamId`, else the first team).
    const sender = input.from ? (this.#liveMembers().find((member) => member.id === input.from) ?? null) : null;
    const scope = sender?.teamId ?? (typeof input.teamId === 'string' && input.teamId !== '' ? input.teamId : this.#defaultTeamId());
    const to = this.#receiver(input.to, input.team, scope);
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
        // The receiver's team (a cross-team hand-off shows there).
        teamId: to.teamId,
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
      const across = from && from.teamId !== to.teamId;
      // 2026-10-14 (D100 follow-up): actor-less texts; the sender is the actor where it is in this team.
      if (!from) this.#activity('handoff', to.id, `got a hand-off from you: ${firstLine(brief, 120)}`, to.teamId);
      else if (across) {
        this.#activity('handoff', to.id, `got a hand-off from ${from.name} (${this.#teamName(from.teamId)}): ${firstLine(brief, 120)}`, to.teamId);
        this.#activity('handoff', from.id, `handed off to ${to.name} (${this.#teamName(to.teamId)}): ${firstLine(brief, 120)}`, from.teamId);
      } else this.#activity('handoff', from.id, `handed off to ${to.name}: ${firstLine(brief, 120)}`, to.teamId);
      return record;
    });
    this.#changed(['handoffs', 'activity'], to.teamId);
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
              plan: [`Hand-off ${current.id} from ${fromName} in team ${this.#teamName(to.teamId)}.`, `Brief: ${current.brief}`, current.expected ? `Expected result: ${current.expected}` : '', 'Mark this todo in progress when you start it and done when the expected result is delivered: the hand-off follows it.'].filter(Boolean).join('\n').slice(0, 8_000),
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
          await this.#o.supervisor.sendMessage(to.sessionId, `New hand-off from ${fromName} (team ${this.#teamName(to.teamId)}): ${current.brief}${current.expected ? `\nExpected result: ${current.expected}` : ''}\nIt is todo [${current.todoId}] in your list: start it with todo_start and mark it done with todo_done when finished.`, 'service');
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
      const next: HandoffState | null = todo?.state === 'done' ? 'done' : todo?.state === 'in_progress' ? 'accepted' : null;
      if (!next || next === handoff.state) continue;
      await this.#serial(async () => {
        this.#need().putHandoff({ ...handoff, state: next, clock: this.#stamp(), updatedAt: this.#iso() });
        if (next === 'done') this.#activity('handoff', member.id, `finished: ${firstLine(handoff.brief, 120)}`);
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
  async membersText(asSessionId: string, team?: unknown): Promise<string> {
    const me = this.memberOfSession(asSessionId);
    if (!me) throw new TeamError(404, 'not-a-member', 'this session is not a team member (or Team is off)');
    // Its own team by default; `team` (a name or id) lists another (D100 follow-up 2026-10-14).
    let teamId = me.teamId;
    if (typeof team === 'string' && team.trim() !== '') {
      const wanted = team.trim().toLowerCase();
      const found = this.#teams().find((t) => t.id === team || t.name.toLowerCase() === wanted);
      if (!found) throw new TeamError(404, 'not-found', `no team called "${team}"`);
      teamId = found.id;
    }
    const view = await this.view(teamId);
    const others = this.#teams().filter((t) => t.id !== teamId);
    const lines = view.members.map((member) => {
      const you = member.id === me.id ? ' (you)' : '';
      const how = member.charter.howItWorks ? `\n  how it works: ${member.charter.howItWorks}` : '';
      return `- ${member.name}${you} · ${member.status}${member.local ? '' : ` · on ${member.machineName}`}\n  owns: ${member.charter.owns || '—'}\n  produces: ${member.charter.produces || '—'}${how}\n  never does: ${member.charter.neverDoes || '—'}`;
    });
    const open = view.handoffs.filter((h) => h.toMemberId === me.id && (h.state === 'open' || h.state === 'accepted'));
    const otherLine =
      others.length > 0
        ? `\nOther teams: ${others.map((t) => `${t.name} (${this.#teamMembers(t.id).length})`).join(', ')}. To hand off across teams, name the receiver as "Role (Team)" or pass team; team_members with team lists one.`
        : '';
    return [`Team ${view.team.name}: ${view.members.length} member${view.members.length === 1 ? '' : 's'}.`, ...lines, open.length > 0 ? `\nYour open hand-offs: ${open.map((h) => `[todo ${h.todoId ?? 'pending'}] ${firstLine(h.brief, 80)}`).join('; ')}` : '', otherLine].filter(Boolean).join('\n');
  }

  /** `team_report`: a short status line in the activity feed. */
  async report(asSessionId: string, text: unknown): Promise<void> {
    const me = this.memberOfSession(asSessionId);
    if (!me) throw new TeamError(404, 'not-a-member', 'this session is not a team member (or Team is off)');
    const line = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
    if (line === '' || line.length > REPORT_MAX) throw new TeamError(422, 'invalid', `text is required (one line, at most ${REPORT_MAX} characters)`);
    await this.#serial(async () => {
      this.#activity('report', me.id, line);
    });
    this.#changed(['activity']);
  }

  // ── Needs you, requests, gates ────────────────────────────────────────

  /**
   * `GET /api/team/needs-you`: the members' open questions, permission requests and
   * system items (D102: a plan's "Ready to merge" item of a member's session too; derived from the Inbox, this machine's and the paired machines'; not
   * stored again) plus Team's own open requests (gates, budgets; T2 adds access).
   */
  async needsYou(teamId?: string | null): Promise<TeamNeedsYouItem[]> {
    this.#need();
    // One team's (without one: the first team's), or every team's with `all` (D100 follow-up 2026-10-14).
    const all = teamId === ALL_TEAMS;
    const members = all ? this.#liveMembers() : this.#teamMembers(this.#team(teamId).id);
    const names = new Map(this.#teams().map((team) => [team.id, team.name]));
    const teamOf = (member: TeamMemberRecord) => ({ teamId: member.teamId, teamName: names.get(member.teamId) ?? '' });
    const bySession = new Map(members.map((member) => [this.#sessionRef(member), member]));
    const inbox: InboxItem[] = [...(await listInbox(this.#o.store)), ...this.#o.peers.remoteInbox()];
    const out: TeamNeedsYouItem[] = [];
    for (const item of inbox) {
      const member = item.sessionId ? bySession.get(item.sessionId) : undefined;
      if (!member) continue;
      out.push({ id: item.id, source: 'inbox', kind: item.kind, memberId: member.id, memberName: member.name, label: needsYouLabel(member.name, item.kind), title: item.title, detail: item.detail, createdAt: item.createdAt, sessionRef: this.#sessionRef(member), ...teamOf(member), inbox: item });
    }
    const byId = new Map(members.map((member) => [member.id, member]));
    for (const request of this.#need().requests()) {
      const member = byId.get(request.memberId);
      if (request.deleted || request.state !== 'open' || !member) continue;
      // D105: a charter ask waits for the member's agent, not for the developer: only its proposal shows.
      if (request.kind === 'charter' && !request.proposal) continue;
      const access = request.kind === 'access' ? await this.access.entryForRequest(request) : null;
      const charter = request.kind === 'charter' && request.proposal ? { charter: { before: member.charter, after: request.proposal, notes: request.detail } } : {};
      out.push({ id: request.id, source: 'team', kind: request.kind === 'gate' ? 'gate' : request.kind, memberId: member.id, memberName: member.name, label: needsYouLabel(member.name, request.kind === 'gate' ? 'gate' : request.kind), title: request.title, detail: request.detail, createdAt: request.createdAt, sessionRef: this.#sessionRef(member), ...teamOf(member), request: stripRequest(request), ...(access ? { access } : {}), ...charter });
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
      const created: TeamRequestRecord = { id: randomUUID(), teamId: this.#need().members().find((m) => m.id === input.memberId)?.teamId ?? this.#defaultTeamId(), clock: this.#stamp(), deleted: false, memberId: input.memberId, kind: input.kind, gate: input.gate, title: input.title, detail: input.detail, state: 'open', action: input.action, note: null, createdAt: now, updatedAt: now };
      this.#need().putRequest(created);
      return created;
    });
    this.#changed(['requests']);
    return stripRequest(record);
  }

  /** `POST /api/team/requests/{id}/approve | decline | dismiss`; an approval runs the request's action on the member's machine. */
  async decide(id: string, decision: 'approve' | 'decline' | 'dismiss', body: Record<string, unknown> = {}): Promise<TeamRequest> {
    const request = this.#need().requests().find((r) => r.id === id && !r.deleted);
    if (!request) throw new TeamError(404, 'not-found', `no request ${id}`);
    if (request.state !== 'open') throw new TeamError(409, 'decided', `the request is ${request.state} already`);
    const member = this.#liveMembers().find((m) => m.id === request.memberId);
    if (member && member.machineId !== this.#selfId()) {
      // D105: the body (an edited charter) goes along.
      await this.#forward(member.machineId, 'POST', `/api/team/requests/${encodeURIComponent(id)}/${decision}`, body);
      await this.syncNow();
      return stripRequest(this.#need().requests().find((r) => r.id === id) ?? request);
    }
    if (request.kind === 'charter') return this.#decideCharter(request, member ?? null, decision, body);
    const state = decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'dismissed';
    await this.#serial(async () => {
      this.#need().putRequest({ ...request, state, clock: this.#stamp(), updatedAt: this.#iso() });
      this.#activity('approval', request.memberId, `request ${state}: ${request.title}`);
    });
    this.#changed(['requests', 'activity']);
    let note: string | null = null;
    if (request.kind === 'access') {
      // D100-T2: Deny / Not now / Approve of an access request (never a setup: the values are entered in the Access tab).
      note = await this.access.decided(request, decision);
    } else if (decision === 'approve' && request.action) {
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

  // ── D105: better charters (asks, proposals, the offer) ────────────────

  /** The member's open charter request (an ask or a proposal; a lapsed ask without a proposal is not open any more). */
  #openCharterRequest(memberId: string): TeamRequestRecord | null {
    const lapsed = this.#now() - CHARTER_ASK_STALE_MS;
    return (
      this.#need()
        .requests()
        .filter((r) => !r.deleted && r.state === 'open' && r.kind === 'charter' && r.memberId === memberId)
        .filter((r) => r.proposal || Date.parse(r.updatedAt) >= lapsed)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
    );
  }

  #charterRequestView(memberId: string): TeamCharterRequestView | null {
    const request = this.#openCharterRequest(memberId);
    if (!request) return null;
    return { requestId: request.id, state: request.proposal ? 'proposed' : 'asked', proposal: request.proposal ?? null, notes: request.proposal ? request.detail : '', at: request.updatedAt };
  }

  /** The stored "Not now" / acted-on mark of the one-time offer (a row of the main `settings` table, `docs/team-removal.md`). */
  async #charterOfferDone(): Promise<boolean> {
    return (await this.#o.store.settings.get(CHARTER_OFFER_SETTING)) === 'done';
  }

  /** D105 · how many members (every team) the one-time offer is for: template-only charters, no open charter request; 0 once done. */
  async #charterOffer(): Promise<number> {
    if (await this.#charterOfferDone()) return 0;
    return this.#liveMembers().filter((member) => isTemplateCharter(member.charter) && !this.#openCharterRequest(member.id)).length;
  }

  /** `POST /api/team/charters/offer/dismiss` (D105): Not now on the one-time banner (remembered on this install). */
  async dismissCharterOffer(): Promise<{ readonly ok: true }> {
    this.#need();
    await this.#o.store.settings.set(CHARTER_OFFER_SETTING, 'done');
    this.#publish(['charters']);
    return { ok: true };
  }

  /**
   * `POST /api/team/members/{id}/charter/ask` (D105): sends the member's own session a
   * normal message ({@link charterAskText}) asking its agent to summarise its work and
   * call `team_propose_charter`; the ask is a `charter` request without a proposal, so
   * there is at most one per member. On the member's machine.
   * @throws {TeamError} 409 `charter-open` while an ask or a proposal is open, `paused`, `offline` / `closed`, `not-sent`.
   */
  async askCharter(id: string): Promise<{ readonly asked: true; readonly requestId: string }> {
    const before = this.#memberRecord(id);
    if (before.machineId !== this.#selfId()) {
      const answer = await this.#forward<{ asked: true; requestId: string }>(before.machineId, 'POST', `/api/team/members/${encodeURIComponent(id)}/charter/ask`, {});
      await this.syncNow();
      return answer;
    }
    if (before.paused) throw new TeamError(409, 'paused', `${before.name} is paused: resume it first`);
    const session = await this.#o.store.sessions.get(before.sessionId);
    if (!session || session.closedAt !== null) throw new TeamError(409, 'closed', `${before.name}'s session is closed: reopen it first`);
    const request = await this.#serial(async () => {
      const member = this.#memberRecord(id);
      const open = this.#openCharterRequest(id);
      if (open) {
        throw new TeamError(409, 'charter-open', open.proposal ? `${member.name} has proposed a charter already: accept, edit or dismiss it first` : `${member.name} was asked already and has not proposed yet`, { requestId: open.id });
      }
      // A lapsed ask gives way to the new one.
      for (const old of this.#need().requests()) {
        if (!old.deleted && old.state === 'open' && old.kind === 'charter' && old.memberId === id) this.#need().putRequest({ ...old, state: 'dismissed', note: 'lapsed: asked again', clock: this.#stamp(), updatedAt: this.#iso() });
      }
      const now = this.#iso();
      const created: TeamRequestRecord = { id: randomUUID(), teamId: member.teamId, clock: this.#stamp(), deleted: false, memberId: id, kind: 'charter', gate: null, title: `${member.name} was asked to draft its charter`, detail: '', state: 'open', action: null, note: null, proposal: null, createdAt: now, updatedAt: now };
      this.#need().putRequest(created);
      this.#activity('update', id, 'asked to draft a specific charter from its own session');
      return created;
    });
    this.#changed(['requests', 'activity', 'members']);
    try {
      // The normal message path: queued while a turn runs, held while new turns pause (D103).
      await this.#o.supervisor.sendMessage(before.sessionId, charterAskText(before.name, this.#teamName(before.teamId), before.charter), 'service');
    } catch (error) {
      await this.#serial(async () => {
        const current = this.#need().requests().find((r) => r.id === request.id) ?? request;
        this.#need().putRequest({ ...current, state: 'dismissed', note: 'not sent', clock: this.#stamp(), updatedAt: this.#iso() });
      });
      this.#changed(['requests', 'members']);
      throw new TeamError(409, 'not-sent', `the ask could not be sent to ${before.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { asked: true, requestId: request.id };
  }

  /**
   * `POST /api/team/charters/ask` `{ teamId?, templateOnly? }` (D105 "Draft better
   * charters"): asks every member of the team (`all`: every team), skipping members
   * with an open ask or proposal, paused or offline ones (with the reason);
   * `templateOnly` asks only members whose charter is template-only (the one-time
   * offer). Marks the offer done.
   */
  async askCharters(body: Record<string, unknown>): Promise<{ readonly asked: readonly { readonly memberId: string; readonly name: string }[]; readonly skipped: readonly { readonly memberId: string; readonly name: string; readonly reason: string }[] }> {
    this.#need();
    const teamId = typeof body['teamId'] === 'string' && body['teamId'] !== '' ? body['teamId'] : undefined;
    const members = teamId === ALL_TEAMS ? this.#liveMembers() : this.#teamMembers(this.#team(teamId).id);
    const templateOnly = body['templateOnly'] === true;
    const machines = await this.#machineNames();
    const asked: { memberId: string; name: string }[] = [];
    const skipped: { memberId: string; name: string; reason: string }[] = [];
    for (const member of members) {
      if (templateOnly && !isTemplateCharter(member.charter)) continue;
      const open = this.#openCharterRequest(member.id);
      if (open) skipped.push({ memberId: member.id, name: member.name, reason: open.proposal ? 'a proposal waits for you' : 'asked already' });
      else if (member.paused) skipped.push({ memberId: member.id, name: member.name, reason: 'paused' });
      else if (member.machineId !== this.#selfId() && machines.get(member.machineId)?.online !== true) skipped.push({ memberId: member.id, name: member.name, reason: `${machines.get(member.machineId)?.name ?? 'its machine'} is offline` });
      else {
        try {
          await this.askCharter(member.id);
          asked.push({ memberId: member.id, name: member.name });
        } catch (error) {
          skipped.push({ memberId: member.id, name: member.name, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    await this.#o.store.settings.set(CHARTER_OFFER_SETTING, 'done');
    this.#publish(['charters']);
    return { asked, skipped };
  }

  /**
   * `team_propose_charter` (D105): the member's agent proposes a charter. It fills the
   * open ask (or a new request when there is none; a newer proposal replaces an open
   * one). It becomes a Needs-you item; nothing changes until the developer accepts it.
   */
  async proposeCharter(asSessionId: string, body: Record<string, unknown>): Promise<{ readonly requestId: string }> {
    const me = this.memberOfSession(asSessionId);
    if (!me) throw new TeamError(404, 'not-a-member', 'this session is not a team member (or Team is off)');
    const proposal = readCharter({ owns: body['owns'], produces: body['produces'], neverDoes: body['neverDoes'], howItWorks: body['howItWorks'] });
    if (!proposal) throw new TeamError(422, 'invalid', 'owns, produces, neverDoes and howItWorks must be text of at most 2,000 characters each');
    for (const field of ['owns', 'produces', 'neverDoes'] as const) {
      if (proposal[field] === '') throw new TeamError(422, 'invalid', `${field} is required`, { errors: [{ field, message: `${field} is required` }] });
    }
    const notes = typeof body['notes'] === 'string' ? body['notes'].trim() : '';
    if (notes.length > CHARTER_NOTES_MAX) throw new TeamError(422, 'invalid', `notes are at most ${CHARTER_NOTES_MAX} characters`);
    const record = await this.#serial(async () => {
      const now = this.#iso();
      const open = this.#need()
        .requests()
        .filter((r) => !r.deleted && r.state === 'open' && r.kind === 'charter' && r.memberId === me.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const title = `${me.name} proposes a new charter`;
      const next: TeamRequestRecord = open
        ? { ...open, title, detail: notes, proposal, clock: this.#stamp(), createdAt: now, updatedAt: now }
        : { id: randomUUID(), teamId: me.teamId, clock: this.#stamp(), deleted: false, memberId: me.id, kind: 'charter', gate: null, title, detail: notes, state: 'open', action: null, note: null, proposal, createdAt: now, updatedAt: now };
      this.#need().putRequest(next);
      this.#activity('update', me.id, 'proposed a new charter — waiting in Needs you');
      return next;
    });
    this.#changed(['requests', 'activity', 'members']);
    return { requestId: record.id };
  }

  /**
   * Accept (`approve`, optionally `{ charter }`: the developer's edit of the proposal)
   * or Dismiss (`dismiss` / `decline`) of a charter request. Accept replaces the
   * member's charter (synced; the standing instruction is re-sent, D64 / D91) and logs it.
   */
  async #decideCharter(request: TeamRequestRecord, member: TeamMemberRecord | null, decision: 'approve' | 'decline' | 'dismiss', body: Record<string, unknown>): Promise<TeamRequest> {
    let charter: TeamCharter | null = null;
    let edited = false;
    if (decision === 'approve') {
      if (!member) throw new TeamError(404, 'not-found', 'the member is gone');
      if (body['charter'] !== undefined) {
        charter = readCharter(body['charter']);
        if (!charter) throw new TeamError(422, 'invalid', 'charter must be { owns, produces, howItWorks?, neverDoes }, each at most 2,000 characters', { errors: [{ field: 'charter', message: 'not a charter' }] });
        edited = request.proposal ? !sameCharter(charter, request.proposal) : true;
      } else if (request.proposal) charter = request.proposal;
      else throw new TeamError(409, 'no-proposal', `${member.name} has not proposed a charter yet`);
    }
    await this.#serial(async () => {
      const current = this.#need().requests().find((r) => r.id === request.id) ?? request;
      if (current.state !== 'open') throw new TeamError(409, 'decided', `the request is ${current.state} already`);
      if (charter && member) {
        const now = this.#memberRecord(member.id);
        this.#need().putMember({ ...now, charter, clock: this.#stamp(), updatedAt: this.#iso() });
        this.#need().putRequest({ ...current, state: 'approved', note: edited ? 'accepted with your edits' : 'accepted', clock: this.#stamp(), updatedAt: this.#iso() });
        this.#activity('update', member.id, `new charter accepted${edited ? ' (with your edits)' : ''}`);
      } else {
        this.#need().putRequest({ ...current, state: 'dismissed', note: current.proposal ? 'dismissed' : 'ask cancelled', clock: this.#stamp(), updatedAt: this.#iso() });
        this.#activity('update', request.memberId, current.proposal ? 'charter proposal dismissed' : 'charter ask cancelled');
      }
    });
    this.#changed(['requests', 'activity', 'members']);
    if (charter && member) await this.#applyCharter(member.sessionId);
    return stripRequest(this.#need().requests().find((r) => r.id === request.id) ?? request);
  }

  async #run(request: TeamRequestRecord, action: TeamRequestAction): Promise<string> {
    if (action.type === 'resume-member') {
      await this.resume(request.memberId);
      return 'Resumed.';
    }
    if (accessIdOfRef(action.ref)) return 'Approved: set it up in the member\'s Access tab.';
    return 'Approved: the member may go ahead.';
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
    await this.access.tick();
  }

  // ── sync with paired machines ─────────────────────────────────────────

  /** This machine's records (`POST /api/team/sync` body / answer). */
  async message(): Promise<TeamSyncMessage> {
    const db = this.#need();
    const self = this.#self ?? (await this.#o.peers.self());
    const snapshot: TeamSnapshot = { teams: db.teams(), members: db.members(), handoffs: db.handoffs(), requests: db.requests(), activity: db.activityAll(), access: db.access() };
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
      for (const record of [...s.teams, ...s.members, ...s.handoffs, ...s.requests, ...s.access]) clock.observe(record.clock);
      const teams = keepOrder(db.teams(), newerRecords(db.teams(), s.teams));
      // An older peer's records carry no order: the local one is kept (D100 follow-up 2026-10-14).
      const members = keepOrder(db.members(), newerRecords(db.members(), s.members));
      // The model / effort chosen on the other machine for a member that runs here (applied below).
      const previous = new Map(db.members().map((member) => [member.id, member]));
      const models = members.filter((member) => {
        const was = previous.get(member.id);
        return member.machineId === this.#selfId() && !member.deleted && was !== undefined && (was.model !== member.model || was.effort !== member.effort);
      });
      const handoffs = newerRecords(db.handoffs(), s.handoffs);
      const requests = newerRecords(db.requests(), s.requests);
      const activity = newActivity(db.activityAll(), s.activity);
      const access = newerRecords(db.access(), s.access);
      db.transaction(() => {
        for (const team of teams) db.putTeam(team);
        for (const member of members) db.putMember(member);
        for (const handoff of handoffs) db.putHandoff(handoff);
        for (const request of requests) db.putRequest(request);
        for (const record of access) db.putAccess(record);
      });
      db.addActivity(activity);
      return { any: teams.length + members.length + handoffs.length + requests.length + activity.length + access.length > 0, members, access, models };
    });
    this.#syncedWith.add(message.machine.id);
    if (changed.any) {
      this.#refreshRoles();
      this.#publish(['teams', 'members', 'handoffs', 'requests', 'activity']);
      // D100 follow-up 2026-10-14: a model chosen on the other machine for a member that runs here: this machine applies it.
      for (const member of changed.models) {
        await this.#applyModel(member.sessionId, { model: member.model, effort: member.effort }).catch((error: unknown) => this.#error(error));
      }
      // A member that now runs here (a move) or whose charter changed elsewhere: its process picks it up.
      for (const member of changed.members) {
        if (member.machineId === this.#selfId()) await this.#applyCharter(member.sessionId);
      }
      // D100-T2: a revoked access's values leave this machine's keychain too; a member that runs here picks its access up.
      for (const sessionId of await this.access.received(changed.access)) await this.#applyCharter(sessionId);
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
   * `POST /api/team/members/{id}/move/check` `{ targetMachineId, placement?, clonePaths? }`: the take-over's
   * checks (both machines) plus Team's own (a running turn), before anything changes.
   */
  async moveCheck(id: string, body: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly blockers: readonly string[]; readonly preview: unknown }> {
    const member = this.#memberRecord(id);
    const target = typeof body['targetMachineId'] === 'string' ? body['targetMachineId'] : '';
    if (target === '') throw new TeamError(422, 'invalid', 'targetMachineId is required');
    if (member.machineId !== this.#selfId()) return this.#forward(member.machineId, 'POST', `/api/team/members/${encodeURIComponent(id)}/move/check`, body);
    if (target === member.machineId) throw new TeamError(422, 'invalid', `${member.name} runs on that machine already`);
    if (!this.#o.takeover) throw new TeamError(501, 'not-available', 'take-over is not available here');
    const choice = moveTargetOf(body);
    const blockers: string[] = [];
    const session = await this.#o.store.sessions.get(member.sessionId);
    if (session?.status === 'run' || this.#o.supervisor.turnRunning(member.sessionId)) blockers.push(`${member.name} is working (a turn is running): move it when the turn has ended`);
    let preview: unknown = null;
    try {
      const answer = await this.#o.takeover.preview({ sessionId: member.sessionId, targetMachine: target, ...choice });
      preview = answer;
      blockers.push(...answer.blockers);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    return { ok: blockers.length === 0, blockers, preview };
  }

  /** `POST /api/team/members/{id}/move` `{ targetMachineId, placement?, clonePaths? }` (D110: the chosen target folders) → 202 {@link TeamMoveRun} (poll `GET /api/team/moves/{runId}`). */
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
    const run = await takeover.start({ sessionId: member.sessionId, targetMachine: target, ...moveTargetOf(body) });
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
        this.#activity('move', run.memberId, `moved from ${machines.get(this.#selfId())?.name ?? 'this machine'} to ${machines.get(result.machineId)?.name ?? result.machineName}`);
      });
      this.#changed(['members', 'activity']);
      await this.syncNow();
      // Project memory (D107) hook: its member-scoped entries move to the machine it now runs on (docs/memory.md → Scopes).
      await memoryMemberMoved(this.#o.store, { memberId: run.memberId, machineId: result.machineId, sessionId: newSessionId });
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
    const access = this.access.charterLines(member);
    return [charterInstruction(member.name, this.#teamName(member.teamId), member.charter, member.gates), access].filter(Boolean).join(' ');
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

/** The model / effort fields a member body set (left out: not changed). */
function modelInput(fields: { readonly model?: string | null; readonly effort?: string | null }): SessionModelInput {
  return { ...(fields.model !== undefined ? { model: fields.model } : {}), ...(fields.effort !== undefined ? { effort: fields.effort } : {}) };
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

/**
 * D110: the target folders (and clone paths) of a member's move, from the request
 * body, in the take-over's shape; a malformed value is refused (422).
 */
function moveTargetOf(body: Record<string, unknown>): { placement?: TargetPlacement; savedFolders?: boolean; clonePaths?: Record<string, string> } {
  const placement = placementOf(body['placement']);
  if (placement === null) throw new TeamError(422, 'invalid', 'placement must be { roots: string[], repoPaths?: { <repo key>: path } }');
  // `placement: null` = the target's saved folders (not the remembered ones).
  const out: { placement?: TargetPlacement; savedFolders?: boolean; clonePaths?: Record<string, string> } = placement ? { placement } : body['placement'] === null ? { savedFolders: true } : {};
  const paths = body['clonePaths'];
  if (paths !== undefined && paths !== null) {
    if (typeof paths !== 'object' || Array.isArray(paths) || Object.values(paths).some((entry) => typeof entry !== 'string')) throw new TeamError(422, 'invalid', 'clonePaths must map repo keys to paths');
    out.clonePaths = paths as Record<string, string>;
  }
  return out;
}
