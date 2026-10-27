import { randomBytes } from 'node:crypto';
import {
  MEMORY_CAP_DEFAULT,
  MEMORY_DRAFT_REPEAT_HOURS,
  MEMORY_PROPOSE_PER_HOUR,
  MEMORY_REASON_MAX,
  MEMORY_SCOPE_KINDS,
  type MemoryDraftAllAnswer,
  type MemoryDraftAnswer,
  type MemoryEntry,
  type MemoryInput,
  type MemoryReach,
  type MemoryScope,
  type MemoryScopeKind,
  type MemoryScopeOption,
  type MemorySessionCount,
  type MemorySettings,
  type MemoryState,
  type MemoryStatus,
  NO_REACH,
  changeKindOf,
  defaultProposalScope,
  folderName,
  memoryBlockParts,
  memoryDraftAskText,
  memoryOrder,
  memoryProposalLabel,
  memoryProposalsTitle,
  memoryVisible,
  nearDuplicateTitle,
  readMemoryCap,
  isMemoryChange,
  readMemoryInput,
  readScopeKind,
  scopeKindOf,
} from '../../core/memory.ts';
import {
  MEMORY_CHECK_AUTHOR,
  MEMORY_REMOVED_KEEP_DAYS,
  type MemoryCheckSettings,
  type MemoryCheckStatus,
  type MemoryRemovedBy,
  type MemoryRemovedEntry,
  readCheckSettings,
} from '../../core/memory-check.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { StoreError } from '../db/table.ts';
import type { HubBus } from '../hub/bus.ts';
import { inboxCount } from '../inbox/wire.ts';
import { type MemoryCheckOptions, MemoryChecks } from './check.ts';
import { MemoryDb, type MemoryPendingCopy } from './db.ts';
import { MEMORY_COPY_ITEM, MEMORY_COPY_KEEP, MEMORY_COPY_RETRY, type MemoryMemberMove, type MemorySessionRef, registerMemoryHooks } from './hooks.ts';
import { type MemoryRepoSource, MemoryRepoIdentity, reachOf } from './reach.ts';
import { members as teamMembers } from './team-link.ts';

/** Why the service refused a call: maps to the route's HTTP answer (`{ error, message, errors? }`). */
export class MemoryError extends Error {
  override name = 'MemoryError';
  readonly status: number;
  readonly code: string;
  readonly field: string | null;
  constructor(status: number, code: string, message: string, field: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }

  body(): Record<string, unknown> {
    return this.field !== null ? { error: this.code, message: this.message, errors: [{ field: this.field, message: this.message }] } : { error: this.code, message: this.message };
  }
}

/** The kind of the Inbox item that announces a folder's open proposals. */
export const MEMORY_PROPOSALS_ITEM = 'memory-proposals';
/** Its Review action (a link to the Memory page: the web goes to `payload.route`, the item stays open). */
export const OPEN_MEMORY = 'open-memory';

/** What the service needs of the supervisor: D91's "older instruction" flag (republishes the live sessions) and the draft ask's message. */
export interface MemorySupervisor {
  instructionSettingChanged(): Promise<void>;
  /** D107 follow-up 2026-10-15: "Draft memory from this session" sends a normal message (queued while a turn runs, held while new turns pause, D103). */
  sendMessage?(sessionId: string, text: string, origin: 'service'): Promise<unknown>;
  /** 2026-10-16: the same, making sure the session's CLI has listed `tool` first (live list_changed, else one restart; `docs/mcp.md`). */
  sendNeedingTool?(sessionId: string, text: string, origin: 'service', tool: string): Promise<unknown>;
}

/** What the service needs of the paired machines (D48): a member's memory moves with it; draft asks for members elsewhere. */
export interface MemoryPeers {
  forward(machineId: string, method: string, path: string, body: unknown): Promise<{ readonly status: number; readonly body: unknown }>;
  /** The paired machines' names (the "missing its memory on <PC>" item). */
  machines?(): Promise<readonly { readonly id: string; readonly name: string }[]>;
}

export interface MemoryServiceOptions {
  readonly dataDir: string;
  readonly store: Store;
  readonly bus: HubBus;
  /** D91: open sessions of a folder are flagged as on an older instruction when its approved memory changes (never restarted). */
  readonly supervisor: MemorySupervisor;
  /** D107 follow-up 2026-10-15: the shared repo set (`SessionRepos`): which repositories a session works in (repo scope). */
  readonly repos?: MemoryRepoSource;
  /** D107 follow-up 2026-10-15: the paired machines (a moved member's entries; draft asks for members elsewhere). */
  readonly peers?: MemoryPeers;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  /**
   * D136: the memory checks (`docs/memory.md` → *Checking notes*): the proposal check and the
   * periodic check. Absent (demo mode, tests that do not need them): no check ever runs.
   */
  readonly check?: MemoryCheckOptions;
}

const CAP_KEY = 'cap';
const HOUR_MS = 60 * 60 * 1000;
/** D107 ruling 2026-10-14: a rejected entry blocks near-identical proposals for this long. */
export const MEMORY_REJECTED_BLOCK_DAYS = 30;
const REJECTED_BLOCK_MS = MEMORY_REJECTED_BLOCK_DAYS * 24 * HOUR_MS;
const DRAFT_REPEAT_MS = MEMORY_DRAFT_REPEAT_HOURS * HOUR_MS;
/** D107 follow-up 2026-10-16: the waits after a failed member-memory copy (1, 5, 30 minutes, then hourly). */
export const MEMORY_COPY_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, HOUR_MS];
/** The Inbox item is raised after this many failed copies … */
export const MEMORY_COPY_ITEM_AFTER_FAILURES = 3;
/** … or this long after the first failure, whichever comes first. */
export const MEMORY_COPY_ITEM_AFTER_MS = HOUR_MS;

/** The wait after the `attempts`-th failure. */
function backoffAfter(attempts: number): number {
  return MEMORY_COPY_BACKOFF_MS[Math.min(attempts - 1, MEMORY_COPY_BACKOFF_MS.length - 1)] as number;
}

/**
 * D107 · Project memory (`docs/memory.md`). Agents propose entries for their session's folder
 * (`memory_propose`); the developer approves (as proposed or edited), rejects, edits, pins and
 * deletes them, and adds entries by hand. **The review gate:** the block a session gets
 * ({@link blockFor}) and `memory_list` read `status = 'approved'` rows only, and an approval stores
 * the approved title and text in the same row it reads from, so what is injected is exactly what
 * the developer approved (their edit included); proposed and rejected rows are never read for it.
 *
 * When a folder's approved memory changes, its open sessions are only **flagged** (D91's
 * `instructionOutdated`: the developer applies or reloads when they choose; ruling 2026-10-14);
 * new and resumed sessions get the current approved memory at their spawn. A folder with
 * open proposals has one Inbox item ("3 memory proposals for Acme app · Review"), closed when its
 * queue is empty.
 *
 * D132: always on since 2.0 (it graduated from Settings → Experimental): `memory.db` opens at
 * start; a folder without approved entries gets no block. With a broken `memory.db` every call
 * answers 503 `memory-unavailable` and nothing is injected.
 */
export class MemoryService {
  readonly #o: MemoryServiceOptions;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  #enabled = false;
  #db: MemoryDb | null = null;
  #problem: string | null = null;
  #closed = false;
  #offHooks: (() => void) | null = null;
  #switching: Promise<void> = Promise.resolve();
  readonly #identity = new MemoryRepoIdentity();
  #offBus: (() => void) | null = null;
  /** D107 follow-up 2026-10-16: the timer of the next pending member-memory copy. */
  #copyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Copies run one at a time (a retry never overlaps another). */
  #copying: Promise<unknown> = Promise.resolve();
  /** D136: the memory checks (`null` without {@link MemoryServiceOptions.check}). */
  readonly #checks: MemoryChecks | null;

  constructor(options: MemoryServiceOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? ((error) => console.error('switchboard memory:', error));
    this.#checks = options.check
      ? new MemoryChecks(
          {
            db: () => (this.#enabled ? this.#db : null),
            now: () => this.#now(),
            label: (folder) => this.#label(folder),
            removeNote: (entry, reason) => this.#removeNote(entry, reason, 'check'),
            fileChange: (target, kind, fields) => this.#fileCheckChange(target, kind, fields),
            changed: (folder) => this.#o.bus.publish('memoryChanged', { scope: folder }),
            onError: (error) => this.#onError(error),
          },
          options.check,
        )
      : null;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Registers the seams and reads the switch (the app calls it when ready). */
  async start(): Promise<void> {
    if (this.#closed) return;
    this.#offHooks ??= registerMemoryHooks(this.#o.store, {
      blockFor: (session) => this.blockFor(session),
      memberMoved: (move) => this.memberMoved(move),
      peerMemoryChanged: (machineId) => void this.retryCopies({ machineId }).catch((error: unknown) => this.#onError(error)),
      copyAction: (payload, action) => this.copyAction(payload, action),
    });
    // D107 follow-up 2026-10-16: a paired machine coming online retries its pending member-memory copies.
    this.#offBus ??= this.#o.bus.subscribe((message) => {
      if (message.name !== 'machineState') return;
      const machine = message.payload as { readonly id?: unknown; readonly state?: unknown; readonly removed?: unknown };
      if (machine.state === 'online' && machine.removed !== true && typeof machine.id === 'string') void this.retryCopies({ machineId: machine.id }).catch((error: unknown) => this.#onError(error));
    });
    await this.#open();
    this.#checks?.start();
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#checks?.close();
    this.#offHooks?.();
    this.#offHooks = null;
    this.#offBus?.();
    this.#offBus = null;
    this.#clearCopyTimer();
    await this.#switching.catch(() => undefined);
    await this.#copying.catch(() => undefined);
    this.#db?.close();
    this.#db = null;
  }

  /**
   * D132 (Project memory graduated in 2.0, `docs/memory-removal.md`): opens `memory.db` (created
   * on first use) once, at start. There is no off-switch any more. Sessions get a memory block
   * only from approved entries (none: no block, the instruction is unchanged).
   */
  #open(): Promise<void> {
    const next = this.#switching.then(() => this.#openNow());
    this.#switching = next.catch((error: unknown) => this.#onError(error));
    return next;
  }

  async #openNow(): Promise<void> {
    if (this.#closed || this.#enabled) return;
    this.#enabled = true;
    try {
      this.#db = await MemoryDb.open(this.#o.dataDir);
      this.#problem = null;
    } catch (error) {
      this.#db = null;
      this.#problem = `memory.db could not be opened: ${error instanceof Error ? error.message : String(error)}`;
      this.#onError(error);
    }
    // The blocks may appear: the open sessions' `instructionOutdated` follows (D91; no restart).
    await this.#o.supervisor.instructionSettingChanged().catch(() => undefined);
    await this.#syncAllInbox();
    this.#scheduleCopies();
    this.#o.bus.publish('memoryChanged', { scope: null });
  }

  /** `GET /api/memory/state` (`enabled` is always true since D132). */
  state(): MemoryState {
    return { enabled: this.#enabled, available: this.#enabled && this.#db !== null, problem: this.#enabled ? this.#problem : null, members: this.#enabled ? teamMembers(this.#o.store).length : 0 };
  }

  /** Timers running (tests): only the next pending member-memory copy's (none without one). */
  activeTimers(): number {
    return this.#copyTimer ? 1 : 0;
  }

  #need(): MemoryDb {
    if (!this.#db) throw new MemoryError(503, 'memory-unavailable', this.#problem ?? 'memory.db is not open');
    return this.#db;
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  // ── scopes ──────────────────────────────────────────────────────────────

  /** A session's folder: its canonical root (the workspace or the repo), `null` for a chat or without one. */
  static scopeOf(session: MemorySessionRef): string | null {
    if (session.kind === 'chat') return null;
    return session.root ?? session.cwd ?? null;
  }

  async #label(scope: string): Promise<string> {
    const saved = (await this.#o.store.folders.list()).find((folder) => folder.canonicalPath === scope || folder.path === scope);
    return saved?.label ?? folderName(scope);
  }

  /** `GET /api/memory/scopes`: the saved folders, then every other folder with entries; each with its counts. */
  async scopes(): Promise<MemoryScope[]> {
    const db = this.#need();
    const counts = new Map(db.counts().map((row) => [row.scope, row]));
    const out: MemoryScope[] = [];
    const seen = new Set<string>();
    for (const folder of await this.#o.store.folders.list()) {
      const scope = folder.canonicalPath;
      if (seen.has(scope)) continue;
      seen.add(scope);
      const count = counts.get(scope);
      out.push({ scope, label: folder.label ?? folderName(scope), saved: true, approved: count?.approved ?? 0, proposed: count?.proposed ?? 0 });
    }
    for (const [scope, count] of counts) {
      if (seen.has(scope) || count.approved + count.proposed === 0) continue;
      out.push({ scope, label: folderName(scope), saved: false, approved: count.approved, proposed: count.proposed });
    }
    return out;
  }

  // ── reads ───────────────────────────────────────────────────────────────

  /** `GET /api/memory/entries`: a folder's entries (all folders without one), approved in block order, then proposed (oldest first), then rejected. */
  entries(filter: { readonly scope?: string; readonly status?: string; readonly kind?: string } = {}): MemoryEntry[] {
    const db = this.#need();
    const statuses: MemoryStatus[] | undefined = filter.status === 'approved' || filter.status === 'proposed' || filter.status === 'rejected' ? [filter.status] : undefined;
    const kind = readScopeKind(filter.kind);
    const rows = db.list({ ...(filter.scope ? { scope: filter.scope } : {}), ...(statuses ? { statuses } : {}), ...(kind ? { scopeKind: kind } : {}) }).map((entry) => this.#withTarget(entry));
    return [...memoryOrder(rows.filter((entry) => entry.status === 'approved')), ...rows.filter((entry) => entry.status === 'proposed'), ...rows.filter((entry) => entry.status === 'rejected').reverse()];
  }

  /**
   * D135: a change proposal with its target as it is now (the review's "old" side; `null` once gone);
   * D136: a proposed add with what the proposal check found (only while its approved note exists).
   */
  #withTarget(entry: MemoryEntry): MemoryEntry {
    if (!isMemoryChange(entry) && entry.status === 'proposed') {
      const check = this.#need().proposalCheck(entry.id);
      const target = check ? this.#need().get(check.targetId) : null;
      return check && target && target.status === 'approved' ? { ...entry, check: { ...check, targetTitle: target.title } } : entry;
    }
    if (!isMemoryChange(entry) || entry.targetId == null) return entry;
    const target = this.#need().get(entry.targetId);
    return { ...entry, target: target && target.status === 'approved' ? target : null };
  }

  /** `GET|PUT /api/memory/settings`. */
  settings(): MemorySettings {
    const raw = Number(this.#need().meta(CAP_KEY));
    return { cap: Number.isInteger(raw) && raw > 0 ? raw : MEMORY_CAP_DEFAULT };
  }

  async setSettings(body: unknown): Promise<MemorySettings> {
    const db = this.#need();
    const cap = readMemoryCap(body);
    if (cap === null) throw new MemoryError(422, 'invalid', 'cap must be a whole number of characters from 500 to 20000', 'cap');
    db.setMeta(CAP_KEY, String(cap));
    for (const scope of new Set(db.list({ statuses: ['approved'] }).map((entry) => entry.scope))) await this.#approvedChanged(scope);
    this.#o.bus.publish('memoryChanged', { scope: null });
    return this.settings();
  }

  /**
   * The block a session gets next to its standing instruction (`null` while off, broken, for a
   * chat, without a folder or without approved entries). **Approved rows only** (the gate).
   */
  async blockFor(session: MemorySessionRef): Promise<string | null> {
    if (!this.#enabled || !this.#db) return null;
    const scope = MemoryService.scopeOf(session);
    if (scope === null) return null;
    const reach = await this.#reach(session.id);
    const approved = this.#visible(scope, reach, ['approved']);
    if (approved.length === 0) return null;
    return memoryBlockParts(approved, this.settings().cap, await this.#label(scope), reach)?.text ?? null;
  }

  /** D107 follow-up 2026-10-15: what a session sees besides its folder: its member and its repositories (nothing found = the folder only). */
  async #reach(sessionId: string): Promise<MemoryReach> {
    const record = await this.#o.store.sessions.get(sessionId).catch(() => null);
    if (!record) return NO_REACH;
    return reachOf(this.#o.store, record, this.#o.repos ?? null, this.#identity);
  }

  /** The entries a session of `folder` with `reach` sees (its folder's workspace entries, its repositories', its member's). */
  #visible(folder: string, reach: MemoryReach, statuses: readonly MemoryStatus[]): MemoryEntry[] {
    return this.#need().list({ statuses, visibleTo: { folder, repoKeys: reach.repos.map((repo) => repo.key), memberId: reach.memberId } });
  }

  /**
   * `GET /api/memory/sessions/{id}` (D107 follow-up 2026-10-15): what this session receives: the
   * entries in its block, per scope, those over the cap, and its folder's proposals.
   */
  async sessionCount(sessionId: string): Promise<MemorySessionCount> {
    this.#need();
    const session = await this.#o.store.sessions.get(sessionId);
    if (!session) throw new MemoryError(404, 'not-found', `no session ${sessionId}`);
    const folder = MemoryService.scopeOf(session);
    if (folder === null) return { count: 0, member: 0, repo: 0, workspace: 0, overflow: 0, proposed: 0, folder: null };
    const reach = await this.#reach(sessionId);
    const parts = memoryBlockParts(this.#visible(folder, reach, ['approved']), this.settings().cap, await this.#label(folder), reach);
    const proposed = this.#need().list({ scope: folder, statuses: ['proposed'] }).length;
    const counts = parts?.counts ?? { member: 0, repo: 0, workspace: 0 };
    return { count: parts?.included.length ?? 0, ...counts, overflow: parts?.overflow.length ?? 0, proposed, folder };
  }

  // ── the agent's calls (`/agent/v1/memory`, the session's agent token) ───

  async #agentScope(sessionId: string): Promise<{ session: SessionRecord; scope: string; reach: MemoryReach }> {
    this.#need();
    const session = await this.#o.store.sessions.get(sessionId);
    if (!session) throw new MemoryError(404, 'not-found', 'this session is not known to Switchboard');
    const scope = MemoryService.scopeOf(session);
    if (scope === null) throw new MemoryError(404, 'no-folder', session.kind === 'chat' ? 'a chat has no project folder: project memory belongs to sessions' : 'this session has no folder');
    return { session, scope, reach: await reachOf(this.#o.store, session, this.#o.repos ?? null, this.#identity) };
  }

  /**
   * `memory_list`: the approved entries the caller sees (its member's, its repositories', its
   * folder's), member first, then repo, then workspace, each in block order; each carries its scope.
   */
  async agentList(sessionId: string): Promise<{ scope: string; label: string; entries: MemoryEntry[] }> {
    const { scope, reach } = await this.#agentScope(sessionId);
    const visible = this.#visible(scope, reach, ['approved']);
    const entries = MEMORY_SCOPE_KINDS.flatMap((kind) => memoryOrder(visible.filter((entry) => scopeKindOf(entry) === kind)));
    return { scope, label: await this.#label(scope), entries };
  }

  /** The scope a proposal asks for (`scope`, `repo`), checked against the caller's reach; the default when none is given. */
  #proposalScope(body: unknown, reach: MemoryReach): { kind: MemoryScopeKind; key: string | null; label: string | null } {
    const raw = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    let kind: MemoryScopeKind = defaultProposalScope(reach);
    if (raw['scope'] !== undefined && raw['scope'] !== null) {
      const asked = readScopeKind(raw['scope']);
      if (asked === null) throw new MemoryError(422, 'invalid', 'scope must be member, repo or workspace', 'scope');
      kind = asked;
    }
    if (kind === 'member') {
      if (reach.memberId === null) throw new MemoryError(422, 'invalid', 'scope "member" is only for team members: use repo or workspace', 'scope');
      return { kind, key: reach.memberId, label: reach.memberLabel };
    }
    if (kind === 'repo') {
      if (reach.repos.length === 0) throw new MemoryError(422, 'invalid', 'this session works in no repository Switchboard can see: use workspace', 'scope');
      const wanted = typeof raw['repo'] === 'string' ? raw['repo'].trim() : '';
      if (wanted === '') {
        if (reach.repos.length > 1) throw new MemoryError(422, 'invalid', `you work in several repositories: name one in repo (${reach.repos.map((repo) => repo.label).join(', ')})`, 'repo');
        const only = reach.repos[0] as { key: string; label: string };
        return { kind, key: only.key, label: only.label };
      }
      const lower = wanted.toLowerCase();
      const found = reach.repos.find((repo) => repo.key === wanted || repo.label.toLowerCase() === lower || repo.key.toLowerCase().endsWith(`/${lower}`));
      if (!found) throw new MemoryError(422, 'invalid', `no repository "${wanted}" among the ones this session works in (${reach.repos.map((repo) => repo.label).join(', ')})`, 'repo');
      return { kind, key: found.key, label: found.label };
    }
    return { kind: 'workspace', key: null, label: null };
  }

  /**
   * `memory_propose`: a **proposed** entry for the caller's folder (never injected until the
   * developer approves it). Refused: more than {@link MEMORY_PROPOSE_PER_HOUR} proposals of this
   * session in the last hour (429 `rate-limited`), a title near-identical to a proposed, approved
   * entry of the folder or one it rejected in the last 30 days (409 `duplicate`).
   */
  async propose(sessionId: string, body: unknown): Promise<MemoryEntry> {
    const { session, scope, reach } = await this.#agentScope(sessionId);
    const input = readMemoryInput(body, ['title', 'text']);
    if (!input.ok) throw new MemoryError(422, 'invalid', input.message, input.field);
    const target = this.#proposalScope(body, reach);
    const db = this.#need();
    const since = new Date(this.#now().getTime() - HOUR_MS).toISOString();
    if (db.proposalsSince(sessionId, since) >= MEMORY_PROPOSE_PER_HOUR) {
      throw new MemoryError(429, 'rate-limited', `at most ${MEMORY_PROPOSE_PER_HOUR} proposals per hour from one session: propose only durable facts, and try again later`);
    }
    const title = input.value.title as string;
    // Ruling 2026-10-14: a rejected entry blocks near-identical proposals for 30 days only.
    const blockedSince = new Date(this.#now().getTime() - REJECTED_BLOCK_MS).toISOString();
    const known = new Map([...db.list({ scope }), ...this.#visible(scope, reach, ['proposed', 'approved', 'rejected'])].map((entry) => [entry.id, entry]));
    const twin = [...known.values()]
      // D135: change proposals (edit / retract) are about an entry, not entries of their own.
      .filter((entry) => !isMemoryChange(entry))
      .filter((entry) => entry.status !== 'rejected' || (entry.decidedAt ?? entry.updatedAt) >= blockedSince)
      .find((entry) => nearDuplicateTitle(entry.title, title) || (entry.proposedTitle !== null && nearDuplicateTitle(entry.proposedTitle, title)));
    if (twin) {
      const state = twin.status === 'approved' ? 'already approved' : twin.status === 'proposed' ? 'already waiting for review' : 'rejected by the developer in the last 30 days';
      throw new MemoryError(409, 'duplicate', `a near-identical entry is ${state}: "${twin.title}". Do not propose it again${twin.status === 'approved' ? '; read it with memory_list' : ''}.`, 'title');
    }
    const now = this.#iso();
    const entry = db.insert({
      id: randomBytes(5).toString('hex'),
      scope,
      title,
      text: input.value.text as string,
      tags: input.value.tags ?? [],
      authorKind: 'agent',
      authorSessionId: sessionId,
      authorLabel: session.title ?? session.name,
      status: 'proposed',
      pinned: false,
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
      decidedBy: null,
      proposedTitle: null,
      proposedText: null,
      scopeKind: target.kind,
      scopeKey: target.key,
      scopeLabel: target.label,
    });
    await this.#syncInbox(scope);
    this.#o.bus.publish('memoryChanged', { scope });
    // D136: in the background, does it duplicate or contradict a note this session sees?
    this.#checks?.proposalAdded(entry, this.#visible(scope, reach, ['approved']));
    return entry;
  }

  /** D135: the approved entry `body.entry` names, checked against the caller's reach (what `memory_list` shows it). */
  async #changeTarget(sessionId: string, body: unknown, kind: 'edit' | 'retract'): Promise<{ session: SessionRecord; target: MemoryEntry; reason: string | null }> {
    const { session, scope, reach } = await this.#agentScope(sessionId);
    const raw = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const id = typeof raw['entry'] === 'string' ? raw['entry'].trim() : '';
    if (id === '') throw new MemoryError(422, 'invalid', 'entry is required: the id of an approved entry, as memory_list shows it', 'entry');
    let reason: string | null = null;
    if (raw['reason'] !== undefined && raw['reason'] !== null) {
      if (typeof raw['reason'] !== 'string') throw new MemoryError(422, 'invalid', 'reason must be text', 'reason');
      reason = raw['reason'].replace(/\s+/g, ' ').trim() || null;
      if (reason !== null && reason.length > MEMORY_REASON_MAX) throw new MemoryError(422, 'invalid', `reason must be at most ${MEMORY_REASON_MAX} characters (it is ${reason.length})`, 'reason');
    }
    if (kind === 'retract' && reason === null) throw new MemoryError(422, 'invalid', 'reason is required: say why the entry should be removed', 'reason');
    const db = this.#need();
    const target = db.get(id);
    if (!target || target.status !== 'approved' || isMemoryChange(target)) throw new MemoryError(404, 'not-found', `no approved memory entry ${id}: read the ids with memory_list`, 'entry');
    if (!memoryVisible(target, scope, reach)) throw new MemoryError(403, 'out-of-scope', `entry ${id} is not one this session sees (memory_list lists those): it belongs to another folder, repository or team member`, 'entry');
    const since = new Date(this.#now().getTime() - HOUR_MS).toISOString();
    if (db.proposalsSince(sessionId, since) >= MEMORY_PROPOSE_PER_HOUR) {
      throw new MemoryError(429, 'rate-limited', `at most ${MEMORY_PROPOSE_PER_HOUR} proposals per hour from one session: propose only what matters, and try again later`);
    }
    const pending = db.changesFor(id).find((change) => change.status === 'proposed' && changeKindOf(change) === kind && change.authorSessionId === sessionId);
    if (pending) throw new MemoryError(409, 'duplicate', `this session already proposed ${kind === 'edit' ? 'an edit of' : 'removing'} "${target.title}"; it is waiting for the developer's review. Do not propose it again.`, 'entry');
    return { session, target, reason };
  }

  /** D135: a change proposal row about `target` (in its folder and scope, so it is reviewed next to it). */
  async #insertChange(sessionId: string, session: SessionRecord, target: MemoryEntry, kind: 'edit' | 'retract', fields: { title: string; text: string; reason: string | null }): Promise<MemoryEntry> {
    const now = this.#iso();
    const entry = this.#need().insert({
      id: randomBytes(5).toString('hex'),
      scope: target.scope,
      title: fields.title,
      text: fields.text,
      tags: target.tags,
      authorKind: 'agent',
      authorSessionId: sessionId,
      authorLabel: session.title ?? session.name,
      status: 'proposed',
      pinned: false,
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
      decidedBy: null,
      proposedTitle: null,
      proposedText: null,
      scopeKind: target.scopeKind,
      scopeKey: target.scopeKey,
      scopeLabel: target.scopeLabel,
      changeKind: kind,
      targetId: target.id,
      reason: fields.reason,
      targetTitle: target.title,
      targetText: target.text,
    });
    await this.#syncInbox(target.scope);
    this.#o.bus.publish('memoryChanged', { scope: target.scope });
    return this.#withTarget(entry);
  }

  /**
   * D135 · `memory_propose_edit { entry, title?, text?, reason? }`: a **proposed** edit of an approved
   * entry the caller sees (the same reach as `memory_list`). Nothing changes until the developer
   * approves it: then the entry's title and / or text are replaced (its id, scope, tags and pin
   * kept). Refused: an unknown entry (404), one outside the caller's reach (403 `out-of-scope`),
   * neither field or no change (422), a pending edit of the same entry from this session (409
   * `duplicate`), the shared rate limit (429).
   */
  async proposeEdit(sessionId: string, body: unknown): Promise<MemoryEntry> {
    const input = readMemoryInput(body);
    if (!input.ok) throw new MemoryError(422, 'invalid', input.message, input.field);
    if (input.value.title === undefined && input.value.text === undefined) throw new MemoryError(422, 'invalid', 'give the new title, the new text or both', 'text');
    const { session, target, reason } = await this.#changeTarget(sessionId, body, 'edit');
    const title = input.value.title ?? target.title;
    const text = input.value.text ?? target.text;
    if (title === target.title && text === target.text) throw new MemoryError(422, 'no-change', `the entry already reads exactly like that: "${target.title}". Propose an edit only when something changes.`, 'text');
    return this.#insertChange(sessionId, session, target, 'edit', { title, text, reason });
  }

  /**
   * D135 · `memory_propose_retract { entry, reason }`: a **proposed** removal of an approved entry
   * the caller sees. Approving it deletes the entry; rejecting keeps it. Refused like
   * {@link proposeEdit} (a reason is required).
   */
  async proposeRetract(sessionId: string, body: unknown): Promise<MemoryEntry> {
    const { session, target, reason } = await this.#changeTarget(sessionId, body, 'retract');
    return this.#insertChange(sessionId, session, target, 'retract', { title: target.title, text: target.text, reason });
  }

  // ── the developer's calls (`/api/memory`) ──────────────────────────────

  /** `POST /api/memory/entries`: an entry the developer writes (approved at once). */
  async add(body: unknown): Promise<MemoryEntry> {
    const db = this.#need();
    const raw = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const scope = typeof raw['scope'] === 'string' ? raw['scope'].trim() : '';
    if (scope === '') throw new MemoryError(422, 'invalid', 'scope is required: the folder the entry belongs to', 'scope');
    const input = readMemoryInput(body, ['title', 'text']);
    if (!input.ok) throw new MemoryError(422, 'invalid', input.message, input.field);
    const target = (await this.#chosenScope(body, scope, null)) ?? { scopeKind: 'workspace' as const, scopeKey: null, scopeLabel: null };
    const now = this.#iso();
    const entry = db.insert({
      id: randomBytes(5).toString('hex'),
      scope,
      ...target,
      title: input.value.title as string,
      text: input.value.text as string,
      tags: input.value.tags ?? [],
      authorKind: 'developer',
      authorSessionId: null,
      authorLabel: null,
      status: 'approved',
      pinned: input.value.pinned ?? false,
      createdAt: now,
      updatedAt: now,
      decidedAt: now,
      decidedBy: 'developer',
      proposedTitle: null,
      proposedText: null,
    });
    await this.#approvedChanged(scope);
    return entry;
  }

  #get(id: string): MemoryEntry {
    const entry = this.#need().get(id);
    if (!entry) throw new MemoryError(404, 'not-found', `no memory entry ${id}`);
    return entry;
  }

  /** The agent's own words kept when the developer changes them (once: the first edit keeps the original). */
  #originals(entry: MemoryEntry, input: MemoryInput): { proposedTitle: string | null; proposedText: string | null } {
    if (entry.authorKind !== 'agent') return { proposedTitle: entry.proposedTitle, proposedText: entry.proposedText };
    const titleChanged = input.title !== undefined && input.title !== entry.title;
    const textChanged = input.text !== undefined && input.text !== entry.text;
    return {
      proposedTitle: entry.proposedTitle ?? (titleChanged || textChanged ? entry.title : null),
      proposedText: entry.proposedText ?? (titleChanged || textChanged ? entry.text : null),
    };
  }

  /** `PUT /api/memory/entries/{id}`: edit (title, text, tags) or pin an entry; a proposal stays a proposal. */
  async update(id: string, body: unknown): Promise<MemoryEntry> {
    const entry = this.#get(id);
    const input = readMemoryInput(body);
    if (!input.ok) throw new MemoryError(422, 'invalid', input.message, input.field);
    if (isMemoryChange(entry)) {
      // D135: an edit proposal's new title / text can be changed before approving it; nothing else.
      if (changeKindOf(entry) === 'retract') throw new MemoryError(409, 'not-editable', 'a proposed removal has nothing to edit: approve or reject it');
      const changed = this.#need().update(id, { ...(input.value.title !== undefined ? { title: input.value.title } : {}), ...(input.value.text !== undefined ? { text: input.value.text } : {}), updatedAt: this.#iso() }) as MemoryEntry;
      this.#o.bus.publish('memoryChanged', { scope: entry.scope });
      return this.#withTarget(changed);
    }
    const target = await this.#chosenScope(body, entry.scope, entry);
    const updated = this.#need().update(id, {
      ...(target ?? {}),
      ...(input.value.title !== undefined ? { title: input.value.title } : {}),
      ...(input.value.text !== undefined ? { text: input.value.text } : {}),
      ...(input.value.tags !== undefined ? { tags: input.value.tags } : {}),
      ...(input.value.pinned !== undefined ? { pinned: input.value.pinned } : {}),
      ...this.#originals(entry, input.value),
      updatedAt: this.#iso(),
    }) as MemoryEntry;
    if (entry.status === 'approved') await this.#approvedChanged(entry.scope);
    else this.#o.bus.publish('memoryChanged', { scope: entry.scope });
    return updated;
  }

  /**
   * `POST /api/memory/entries/{id}/approve` (`{ title?, text?, tags?, pinned? }`): a proposal
   * becomes approved; an edit given here is what is approved (and injected). A rejected entry can
   * be approved too (the developer changed their mind).
   */
  async approve(id: string, body: unknown): Promise<MemoryEntry> {
    const entry = this.#get(id);
    if (entry.status === 'approved') throw new MemoryError(409, 'not-proposed', 'this entry is already approved');
    const input = readMemoryInput(body);
    if (!input.ok) throw new MemoryError(422, 'invalid', input.message, input.field);
    if (isMemoryChange(entry)) return this.#applyChange(entry, input.value);
    // D136: "Approve and remove the old note": the note the proposal check found goes to the removed list (recoverable).
    const removeOld = body !== null && typeof body === 'object' && (body as Record<string, unknown>)['removeConflicting'] === true;
    const check = this.#need().proposalCheck(id);
    const old = removeOld && check ? this.#need().get(check.targetId) : null;
    const target = await this.#chosenScope(body, entry.scope, entry);
    const now = this.#iso();
    const approved = this.#need().update(id, {
      ...(target ?? {}),
      ...(input.value.title !== undefined ? { title: input.value.title } : {}),
      ...(input.value.text !== undefined ? { text: input.value.text } : {}),
      ...(input.value.tags !== undefined ? { tags: input.value.tags } : {}),
      ...(input.value.pinned !== undefined ? { pinned: input.value.pinned } : {}),
      ...this.#originals(entry, input.value),
      status: 'approved',
      decidedAt: now,
      decidedBy: 'developer',
      updatedAt: now,
    }) as MemoryEntry;
    this.#need().deleteProposalCheck(id);
    if (old && check && old.status === 'approved' && !isMemoryChange(old) && old.id !== id) {
      await this.#removeNote(old, `Replaced by “${approved.title}” (${check.verdict === 'duplicate' ? 'a duplicate' : 'a conflict'}: ${check.reason})`, 'approval');
    }
    await this.#syncInbox(entry.scope);
    await this.#approvedChanged(entry.scope);
    return approved;
  }

  /**
   * D135: approving an `edit` / `retract` proposal. An edit writes the proposed title and / or text
   * (the developer's, when they edited it first) into the target, which keeps its id, scope, tags
   * and pin and records the decision (`decidedAt` / `decidedBy`, `updatedAt`); a field the agent
   * left as it was is not written, so a change the developer made since is kept. A retract deletes
   * the target (the store has no soft delete). Either way the proposal itself is not kept (it is
   * never an approved entry), nor are other proposals about a deleted target. Answers the target
   * as it is now (a retract: as it was, the last time).
   */
  async #applyChange(change: MemoryEntry, input: { readonly title?: string; readonly text?: string }): Promise<MemoryEntry> {
    const db = this.#need();
    const target = change.targetId ? db.get(change.targetId) : null;
    if (!target || target.status !== 'approved') throw new MemoryError(409, 'target-gone', 'the entry this proposal is about no longer exists: reject or delete the proposal');
    const now = this.#iso();
    let answer: MemoryEntry;
    if (changeKindOf(change) === 'retract') {
      db.delete(target.id);
      db.deleteChangesFor(target.id);
      answer = target;
    } else {
      const title = input.title ?? (change.title !== (change.targetTitle ?? target.title) ? change.title : undefined);
      const text = input.text ?? (change.text !== (change.targetText ?? target.text) ? change.text : undefined);
      answer = db.update(target.id, { ...(title !== undefined ? { title } : {}), ...(text !== undefined ? { text } : {}), decidedAt: now, decidedBy: 'developer', updatedAt: now }) as MemoryEntry;
      db.delete(change.id);
    }
    await this.#syncInbox(change.scope);
    if (target.scope !== change.scope) await this.#syncInbox(target.scope);
    await this.#approvedChanged(target.scope);
    return answer;
  }

  /** `POST /api/memory/entries/{id}/reject`: a proposal is rejected (kept, never injected; its title blocks a re-proposal). */
  async reject(id: string): Promise<MemoryEntry> {
    const entry = this.#get(id);
    if (entry.status !== 'proposed') throw new MemoryError(409, 'not-proposed', entry.status === 'approved' ? 'this entry is approved: delete it instead' : 'this entry is already rejected');
    const now = this.#iso();
    const rejected = this.#need().update(id, { status: 'rejected', decidedAt: now, decidedBy: 'developer', updatedAt: now }) as MemoryEntry;
    this.#need().deleteProposalCheck(id);
    await this.#syncInbox(entry.scope);
    this.#o.bus.publish('memoryChanged', { scope: entry.scope });
    return rejected;
  }

  /** `DELETE /api/memory/entries/{id}`. */
  async delete(id: string): Promise<void> {
    const entry = this.#get(id);
    this.#need().delete(id);
    this.#need().deleteProposalCheck(id);
    // D135: proposals to change an entry go with it.
    const dropped = isMemoryChange(entry) ? 0 : this.#need().deleteChangesFor(id);
    if (dropped > 0 && entry.status !== 'proposed') await this.#syncInbox(entry.scope);
    if (entry.status === 'proposed') await this.#syncInbox(entry.scope);
    if (entry.status === 'approved') await this.#approvedChanged(entry.scope);
    else this.#o.bus.publish('memoryChanged', { scope: entry.scope });
  }

  // ── scopes the developer can choose (D107 follow-up 2026-10-15) ────────

  /**
   * `GET /api/memory/scope-options?scope=<folder>&entry=<id>`: the scopes an entry of `folder` can be
   * given (the review queue's and the edit form's selector): **Workspace**; the repositories of the
   * proposing session, of the folder's open sessions and of the folder's repo entries; the Team
   * members (every team) and the entry's own current scope.
   */
  async scopeOptions(folder: string, entryId?: string): Promise<MemoryScopeOption[]> {
    const db = this.#need();
    const entry = entryId ? this.#get(entryId) : null;
    const out: MemoryScopeOption[] = [{ kind: 'workspace', key: null, label: await this.#label(entry?.scope ?? folder) }];
    const add = (option: MemoryScopeOption): void => {
      if (!out.some((known) => known.kind === option.kind && known.key === option.key)) out.push(option);
    };
    if (entry && entry.scopeKind !== 'workspace' && entry.scopeKey !== null) add({ kind: entry.scopeKind, key: entry.scopeKey, label: entry.scopeLabel ?? entry.scopeKey });
    const sessionIds: string[] = [];
    if (entry?.authorSessionId) sessionIds.push(entry.authorSessionId);
    const open = (await this.#o.store.sessions.list({ closed: false })).filter((session) => MemoryService.scopeOf(session) === (entry?.scope ?? folder));
    for (const session of open.slice(0, 20)) if (!sessionIds.includes(session.id)) sessionIds.push(session.id);
    const reaches: MemoryReach[] = [];
    for (const sessionId of sessionIds) reaches.push(await this.#reach(sessionId));
    for (const reach of reaches) for (const repo of reach.repos) add({ kind: 'repo', key: repo.key, label: repo.label });
    for (const known of db.list({ scope: entry?.scope ?? folder, scopeKind: 'repo' })) if (known.scopeKey) add({ kind: 'repo', key: known.scopeKey, label: known.scopeLabel ?? known.scopeKey });
    for (const reach of reaches) if (reach.memberId) add({ kind: 'member', key: reach.memberId, label: reach.memberLabel ?? reach.memberId });
    for (const member of teamMembers(this.#o.store)) add({ kind: 'member', key: member.id, label: member.name });
    return out;
  }

  /**
   * The scope a developer's body asks for (`scopeKind`, `scopeKey`), `null` when it names none.
   * A repo or member scope must be one of {@link scopeOptions} (or the entry's own).
   */
  async #chosenScope(body: unknown, folder: string, entry: MemoryEntry | null): Promise<Pick<MemoryEntry, 'scopeKind' | 'scopeKey' | 'scopeLabel'> | null> {
    const raw = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    if (raw['scopeKind'] === undefined || raw['scopeKind'] === null) return null;
    const kind = readScopeKind(raw['scopeKind']);
    if (kind === null) throw new MemoryError(422, 'invalid', 'scopeKind must be member, repo or workspace', 'scopeKind');
    if (kind === 'workspace') return { scopeKind: 'workspace', scopeKey: null, scopeLabel: null };
    const key = typeof raw['scopeKey'] === 'string' ? raw['scopeKey'] : '';
    if (key === '') throw new MemoryError(422, 'invalid', `a ${kind} scope needs scopeKey (the ${kind === 'repo' ? 'repository' : 'member'})`, 'scopeKey');
    if (entry && entry.scopeKind === kind && entry.scopeKey === key) return { scopeKind: kind, scopeKey: key, scopeLabel: entry.scopeLabel };
    const option = (await this.scopeOptions(folder, entry?.id)).find((candidate) => candidate.kind === kind && candidate.key === key);
    if (!option) throw new MemoryError(422, 'invalid', `${kind === 'repo' ? 'that repository' : 'that member'} is not one this entry can be scoped to`, 'scopeKey');
    return { scopeKind: kind, scopeKey: key, scopeLabel: option.label };
  }

  // ── "Draft memory from this session" (D107 follow-up 2026-10-15) ───────

  /**
   * `POST /api/memory/draft` `{ sessionId }` or `{ memberId }`: sends the session a normal message
   * ({@link memoryDraftAskText}: queued while a turn runs, held while new turns pause, D103) asking
   * its agent to review its own history and propose its durable facts with `memory_propose`. Nothing
   * is applied: the proposals go through the review queue. One ask per session: another within
   * {@link MEMORY_DRAFT_REPEAT_HOURS} hours is ignored (`asked: false`, `asked-recently`). A member on
   * a paired machine is asked there (through the peer API).
   */
  async draft(body: unknown): Promise<MemoryDraftAnswer> {
    const db = this.#need();
    const raw = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    let sessionId = typeof raw['sessionId'] === 'string' ? raw['sessionId'] : '';
    if (typeof raw['memberId'] === 'string' && raw['memberId'] !== '') {
      const member = teamMembers(this.#o.store).find((candidate) => candidate.id === raw['memberId']);
      if (!member) throw new MemoryError(404, 'not-found', 'no such team member');
      if (!member.here) return this.#draftThere(member.machineId, member.sessionId);
      sessionId = member.sessionId;
    }
    if (sessionId === '') throw new MemoryError(422, 'invalid', 'sessionId (or memberId) is required', 'sessionId');
    const session = await this.#o.store.sessions.get(sessionId);
    if (!session) throw new MemoryError(404, 'not-found', `no session ${sessionId}`);
    if (MemoryService.scopeOf(session) === null) return { asked: false, reason: 'no-folder', askedAt: null };
    if (session.closedAt !== null) return { asked: false, reason: 'closed', askedAt: null };
    const before = db.draftAskedAt(sessionId);
    if (before !== null && this.#now().getTime() - Date.parse(before) < DRAFT_REPEAT_MS) return { asked: false, reason: 'asked-recently', askedAt: before };
    const now = this.#iso();
    db.setDraftAsked(sessionId, now);
    const reach = await this.#reach(sessionId);
    try {
      const supervisor = this.#o.supervisor;
      // 2026-10-16: the ask needs memory_propose: a CLI that has not listed it gets it first.
      if (supervisor.sendNeedingTool) await supervisor.sendNeedingTool(sessionId, memoryDraftAskText(reach.memberLabel, reach), 'service', 'memory_propose');
      else if (supervisor.sendMessage) await supervisor.sendMessage(sessionId, memoryDraftAskText(reach.memberLabel, reach), 'service');
      else throw new Error('no supervisor');
    } catch (error) {
      db.setDraftAsked(sessionId, before);
      return { asked: false, reason: `not-sent: ${error instanceof Error ? error.message : String(error)}`, askedAt: null };
    }
    return { asked: true, reason: null, askedAt: now };
  }

  async #draftThere(machineId: string, sessionId: string): Promise<MemoryDraftAnswer> {
    if (!this.#o.peers) return { asked: false, reason: 'offline', askedAt: null };
    try {
      const answer = await this.#o.peers.forward(machineId, 'POST', '/api/memory/draft', { sessionId });
      if (answer.status === 200) return answer.body as MemoryDraftAnswer;
      const message = (answer.body as { message?: unknown } | null)?.message;
      return { asked: false, reason: typeof message === 'string' ? message : `the paired machine answered HTTP ${answer.status}`, askedAt: null };
    } catch (error) {
      return { asked: false, reason: `offline: ${error instanceof Error ? error.message : String(error)}`, askedAt: null };
    }
  }

  /**
   * `POST /api/memory/draft-all` `{ teamId? }` ("Draft memory for all members"): {@link draft} for
   * every Team member (of `teamId`, else every team), on whichever machine it runs; paused members,
   * archived ones (2026-10-27) and the ones asked in the last 24 hours are skipped (with the reason).
   */
  async draftAll(body: unknown): Promise<MemoryDraftAllAnswer> {
    this.#need();
    const raw = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const teamId = typeof raw['teamId'] === 'string' && raw['teamId'] !== '' && raw['teamId'] !== 'all' ? raw['teamId'] : null;
    const asked: { memberId: string; name: string }[] = [];
    const skipped: { memberId: string; name: string; reason: string }[] = [];
    for (const member of teamMembers(this.#o.store)) {
      if (teamId !== null && member.teamId !== teamId) continue;
      if (member.paused) {
        skipped.push({ memberId: member.id, name: member.name, reason: 'paused' });
        continue;
      }
      const answer = await this.draft({ memberId: member.id }).catch((error: unknown) => ({ asked: false, reason: error instanceof Error ? error.message : String(error), askedAt: null }));
      if (answer.asked) asked.push({ memberId: member.id, name: member.name });
      // 2026-10-27 (D137 follow-up): a closed session is an archived member (skipped, it stays in its crew).
      else skipped.push({ memberId: member.id, name: member.name, reason: answer.reason === 'asked-recently' ? 'asked in the last 24 hours' : answer.reason === 'closed' ? 'archived' : (answer.reason ?? 'not asked') });
    }
    return { asked, skipped };
  }

  // ── a member's memory moves with it (D107 follow-up 2026-10-15) ────────

  /**
   * Team's move seam: the member now runs on `move.machineId`; its member-scoped entries (every
   * state: approved ones stay approved, proposals stay in review, rejections keep blocking) are
   * copied there (`POST /api/memory/import` through the peer API) and, once the other machine took
   * them, deleted here. When it cannot take them (offline, Project memory off there, an older
   * build), they stay here and a **pending copy** is kept (D107 follow-up 2026-10-16): retried
   * with backoff ({@link MEMORY_COPY_BACKOFF_MS}), when that machine comes online and when its
   * Project memory changes (switched on); after {@link MEMORY_COPY_ITEM_AFTER_FAILURES} failures or
   * an hour, an Inbox item "<member> is missing its memory on <PC>" offers Retry / Keep on this PC.
   */
  async memberMoved(move: MemoryMemberMove): Promise<void> {
    if (!this.#enabled || !this.#db || !this.#o.peers) return;
    if (this.#db.list({ scopeKind: 'member', scopeKey: move.memberId }).length === 0) return;
    await this.#serialCopy(async () => {
      const db = this.#need();
      const label = teamMembers(this.#o.store).find((member) => member.id === move.memberId)?.name ?? this.#memberLabelOf(move.memberId);
      const before = db.pendingCopy(move.memberId);
      const error = await this.#copy(move.memberId, move.machineId, move.sessionId);
      if (error === null) {
        if (before) await this.#resolveCopy(before);
        return;
      }
      const now = this.#now().getTime();
      db.putPendingCopy({
        memberId: move.memberId,
        memberLabel: label,
        machineId: move.machineId,
        sessionId: move.sessionId,
        attempts: 1,
        firstFailedAt: new Date(now).toISOString(),
        nextAttemptAt: new Date(now + backoffAfter(1)).toISOString(),
        lastError: error,
        itemId: before?.itemId ?? null,
      });
      this.#onError(new Error(`a moved member's memory stayed here for now (it is retried): ${error}`));
    });
    this.#scheduleCopies();
  }

  /** The member's role name from its entries (the move's label when Team no longer lists it). */
  #memberLabelOf(memberId: string): string | null {
    return this.#db?.list({ scopeKind: 'member', scopeKey: memberId }).find((entry) => entry.scopeLabel !== null)?.scopeLabel ?? null;
  }

  #serialCopy<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#copying.then(work, work);
    this.#copying = next.catch(() => undefined);
    return next;
  }

  /**
   * One copy of a member's entries to `machineId` (its session there `sessionId`): `null` when the
   * other machine took them (or there were none) and they were deleted here, else why not.
   */
  async #copy(memberId: string, machineId: string, sessionId: string): Promise<string | null> {
    const db = this.#need();
    const entries = db.list({ scopeKind: 'member', scopeKey: memberId });
    if (entries.length === 0) return null;
    if (!this.#o.peers) return 'paired machines are not available';
    let answer: { readonly status: number; readonly body: unknown };
    try {
      answer = await this.#o.peers.forward(machineId, 'POST', '/api/memory/import', { sessionId, memberId, entries });
    } catch (error) {
      return `the other machine could not be reached: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (answer.status < 200 || answer.status >= 300) {
      const body = answer.body as { error?: unknown; message?: unknown } | null;
      if (answer.status === 404 && body?.error === 'memory-off') return 'Project memory is off there';
      return typeof body?.message === 'string' ? body.message : `the other machine answered HTTP ${answer.status}`;
    }
    const folders = new Set(entries.map((entry) => entry.scope));
    for (const entry of entries) db.delete(entry.id);
    for (const folder of folders) {
      await this.#syncInbox(folder);
      await this.#approvedChanged(folder);
    }
    return null;
  }

  /**
   * Retries the pending copies (all, one machine's or one member's; `due` only those whose time
   * came). Before each: a member that runs on this machine again needs no copy (dropped), one that
   * moved on is copied to where it runs now. Success deletes the entries here and resolves the
   * item; a failure counts, waits longer and raises the item once it is due. Answers the copies
   * still pending among those tried.
   */
  async retryCopies(filter: { readonly machineId?: string; readonly memberId?: string; readonly due?: boolean } = {}): Promise<MemoryPendingCopy[]> {
    if (!this.#enabled || !this.#db) return [];
    const left = await this.#serialCopy(async () => {
      if (!this.#enabled || !this.#db) return [];
      const now = this.#now().getTime();
      const pending = this.#db
        .pendingCopies()
        .filter((copy) => (filter.memberId === undefined || copy.memberId === filter.memberId) && (filter.machineId === undefined || copy.machineId === filter.machineId) && (!filter.due || Date.parse(copy.nextAttemptAt) <= now));
      const out: MemoryPendingCopy[] = [];
      for (const before of pending) {
        let copy = before;
        const member = teamMembers(this.#o.store).find((candidate) => candidate.id === copy.memberId);
        if (member?.here) {
          // It runs here again: its entries are where it is.
          await this.#resolveCopy(copy);
          continue;
        }
        if (member && (member.machineId !== copy.machineId || member.sessionId !== copy.sessionId)) copy = { ...copy, machineId: member.machineId, sessionId: member.sessionId };
        const error = await this.#copy(copy.memberId, copy.machineId, copy.sessionId);
        if (error === null) {
          await this.#resolveCopy(copy);
          continue;
        }
        const attempts = copy.attempts + 1;
        const failed: MemoryPendingCopy = { ...copy, attempts, lastError: error, nextAttemptAt: new Date(now + backoffAfter(attempts)).toISOString() };
        this.#need().putPendingCopy(failed);
        const raised = attempts >= MEMORY_COPY_ITEM_AFTER_FAILURES || now - Date.parse(copy.firstFailedAt) >= MEMORY_COPY_ITEM_AFTER_MS ? await this.#raiseCopyItem(failed) : failed;
        out.push(raised);
      }
      return out;
    });
    this.#scheduleCopies();
    return left;
  }

  /** The pending copies (tests, the docs' contract). */
  pendingCopies(): MemoryPendingCopy[] {
    return this.#db?.pendingCopies() ?? [];
  }

  /** The copy is no longer pending: its record goes and its Inbox item is resolved. */
  async #resolveCopy(copy: MemoryPendingCopy): Promise<void> {
    this.#db?.deletePendingCopy(copy.memberId);
    if (copy.itemId) {
      try {
        await this.#o.store.systemItems.close(copy.itemId, 'resolved');
        this.#o.bus.publish('inboxChanged', { count: await inboxCount(this.#o.store) });
      } catch (error) {
        if (!(error instanceof StoreError && error.code === 'conflict')) throw error;
      }
    }
  }

  /** Raises (or refreshes) the "<member> is missing its memory on <PC>" item; answers the copy with its item id. */
  async #raiseCopyItem(copy: MemoryPendingCopy): Promise<MemoryPendingCopy> {
    const machines = (await this.#o.peers?.machines?.().catch(() => [])) ?? [];
    const pc = machines.find((machine) => machine.id === copy.machineId)?.name ?? 'the other machine';
    const member = copy.memberLabel ?? 'A team member';
    const title = `${member} is missing its memory on ${pc}`;
    const detail = `${member} moved to ${pc}, but its member memory could not be copied there (${copy.attempts} tries; last: ${copy.lastError ?? 'unknown'}). Switchboard keeps retrying. Retry tries now; Keep on this PC stops retrying and leaves the entries here (they reach ${member} again if it moves back).`;
    const payload = { memberId: copy.memberId, machineId: copy.machineId };
    const existing = copy.itemId ? await this.#o.store.systemItems.get(copy.itemId) : null;
    if (existing && existing.state === 'open') {
      if (existing.title !== title || existing.detail !== detail) await this.#o.store.systemItems.update(existing.id, { title, detail, payload });
      return copy;
    }
    const item = await this.#o.store.systemItems.create({
      kind: MEMORY_COPY_ITEM,
      source: 'memory',
      status: 'need',
      title,
      detail,
      branches: [],
      actions: [
        { id: MEMORY_COPY_RETRY, label: 'Retry' },
        { id: MEMORY_COPY_KEEP, label: 'Keep on this PC' },
      ],
      sessionId: null,
      payload,
    });
    const raised = { ...copy, itemId: item.id };
    this.#need().putPendingCopy(raised);
    this.#o.bus.publish('inboxChanged', { count: await inboxCount(this.#o.store) });
    return raised;
  }

  /**
   * The item's actions (`POST /api/inbox/{id}/actions/…`): **Retry** copies now (`null` once done:
   * the copy resolved the item; else the failure, and the item stays); **Keep on this PC** drops the
   * pending copy (the entries stay here; the Inbox closes the item).
   */
  async copyAction(payload: unknown, action: string): Promise<string | null> {
    if (!this.#enabled || !this.#db) return 'Project memory is unavailable: memory.db is not open';
    const memberId = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>)['memberId'] : null;
    if (typeof memberId !== 'string') return 'the member is no longer known';
    if (action === MEMORY_COPY_KEEP) {
      await this.#serialCopy(async () => this.#db?.deletePendingCopy(memberId));
      this.#scheduleCopies();
      return null;
    }
    if (!this.#db.pendingCopy(memberId)) return null;
    const left = await this.retryCopies({ memberId });
    const still = left.find((copy) => copy.memberId === memberId);
    return still ? `still not copied: ${still.lastError ?? 'unknown'}` : null;
  }

  #clearCopyTimer(): void {
    if (this.#copyTimer) clearTimeout(this.#copyTimer);
    this.#copyTimer = null;
  }

  /** Arms the timer for the next due pending copy (none while off, closed or without one). */
  #scheduleCopies(): void {
    this.#clearCopyTimer();
    if (this.#closed || !this.#enabled || !this.#db) return;
    const next = this.#db.pendingCopies()[0];
    if (!next) return;
    const delay = Math.min(Math.max(0, Date.parse(next.nextAttemptAt) - this.#now().getTime()), 2 ** 31 - 1);
    this.#copyTimer = setTimeout(() => {
      this.#copyTimer = null;
      void this.retryCopies({ due: true }).catch((error: unknown) => this.#onError(error));
    }, delay);
    this.#copyTimer.unref?.();
  }

  /**
   * `POST /api/memory/import` `{ sessionId, memberId, entries }` (a paired machine, after a member
   * moved here): the member's entries, kept exactly as they were (ids, texts, states, decisions),
   * now belonging to the member's session's folder on this machine. Only member-scoped entries of
   * that member are taken; an id already here is replaced.
   */
  async importMember(body: unknown): Promise<{ readonly imported: number }> {
    const db = this.#need();
    const raw = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const sessionId = typeof raw['sessionId'] === 'string' ? raw['sessionId'] : '';
    const memberId = typeof raw['memberId'] === 'string' ? raw['memberId'] : '';
    const session = sessionId ? await this.#o.store.sessions.get(sessionId) : null;
    const folder = session ? MemoryService.scopeOf(session) : null;
    if (!session || folder === null || memberId === '') throw new MemoryError(422, 'invalid', 'sessionId (a session with a folder on this machine) and memberId are required', 'sessionId');
    const list = Array.isArray(raw['entries']) ? (raw['entries'] as unknown[]) : [];
    let imported = 0;
    for (const item of list) {
      const entry = item as MemoryEntry;
      if (!entry || typeof entry !== 'object' || entry.scopeKind !== 'member' || entry.scopeKey !== memberId || typeof entry.id !== 'string') continue;
      const input = readMemoryInput(entry, ['title', 'text']);
      if (!input.ok || !['proposed', 'approved', 'rejected'].includes(entry.status)) continue;
      // D135: a change proposal is never approved (an older or broken sender's would break the CHECK).
      if (isMemoryChange(entry) && entry.status === 'approved') continue;
      db.delete(entry.id);
      db.insert({ ...entry, scope: folder, title: input.value.title as string, text: input.value.text as string, tags: input.value.tags ?? [], authorKind: entry.authorKind === 'developer' ? 'developer' : 'agent', decidedBy: entry.decidedBy === 'developer' ? 'developer' : null });
      imported += 1;
    }
    await this.#syncInbox(folder);
    await this.#approvedChanged(folder);
    return { imported };
  }

  // ── D136 · checks: removed notes, check-filed proposals, settings ──────

  /**
   * Moves an approved note to the removed list (recoverable for 30 days): deleted from the entries
   * (so it is never injected again), its pending change proposals with it, the open sessions
   * flagged (D91). `by`: the periodic check, or "Approve and remove the old note".
   */
  async #removeNote(entry: MemoryEntry, reason: string, by: MemoryRemovedBy): Promise<void> {
    const db = this.#need();
    const current = db.get(entry.id);
    if (!current || current.status !== 'approved' || isMemoryChange(current)) return;
    db.delete(current.id);
    const dropped = db.deleteChangesFor(current.id);
    db.putRemoved(current, reason, by, this.#iso());
    if (dropped > 0) await this.#syncInbox(current.scope);
    await this.#approvedChanged(current.scope);
  }

  /** A D135 edit / retract proposal filed by the check (author "Memory check"); `false` when one of the kind is pending already or nothing changes. */
  async #fileCheckChange(target: MemoryEntry, kind: 'edit' | 'retract', fields: { readonly title: string | null; readonly text: string | null; readonly reason: string }): Promise<boolean> {
    const db = this.#need();
    const pending = db.changesFor(target.id).some((change) => change.status === 'proposed' && changeKindOf(change) === kind && change.authorSessionId === null && change.authorLabel === MEMORY_CHECK_AUTHOR);
    if (pending) return false;
    const title = kind === 'edit' ? (fields.title ?? target.title) : target.title;
    const text = kind === 'edit' ? (fields.text ?? target.text) : target.text;
    if (kind === 'edit' && title === target.title && text === target.text) return false;
    const now = this.#iso();
    db.insert({
      id: randomBytes(5).toString('hex'),
      scope: target.scope,
      title,
      text,
      tags: target.tags,
      authorKind: 'agent',
      authorSessionId: null,
      authorLabel: MEMORY_CHECK_AUTHOR,
      status: 'proposed',
      pinned: false,
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
      decidedBy: null,
      proposedTitle: null,
      proposedText: null,
      scopeKind: target.scopeKind,
      scopeKey: target.scopeKey,
      scopeLabel: target.scopeLabel,
      changeKind: kind,
      targetId: target.id,
      reason: fields.reason,
      targetTitle: target.title,
      targetText: target.text,
    });
    await this.#syncInbox(target.scope);
    this.#o.bus.publish('memoryChanged', { scope: target.scope });
    return true;
  }

  /** `GET /api/memory/removed?scope=`: the notes removed by a check (or replaced on approval), newest first, kept 30 days. */
  removed(scope?: string): MemoryRemovedEntry[] {
    return this.#need().removed(scope ? scope : null, MEMORY_REMOVED_KEEP_DAYS);
  }

  /**
   * `POST /api/memory/removed/{id}/restore`: puts a removed note back as an approved note, under
   * its own id (a new one only if that id is taken meanwhile), as it was when removed.
   */
  async restore(id: string): Promise<MemoryEntry> {
    const db = this.#need();
    const removed = db.removedOne(id, MEMORY_REMOVED_KEEP_DAYS);
    if (!removed) throw new MemoryError(404, 'not-found', `no removed note ${id} (removed notes are kept ${MEMORY_REMOVED_KEEP_DAYS} days)`);
    const now = this.#iso();
    const old = removed.entry;
    const restored = db.insert({
      ...old,
      id: db.get(old.id) ? randomBytes(5).toString('hex') : old.id,
      scope: removed.scope,
      status: 'approved',
      changeKind: 'add',
      targetId: null,
      reason: null,
      targetTitle: null,
      targetText: null,
      updatedAt: now,
    });
    db.deleteRemoved(id);
    await this.#approvedChanged(removed.scope);
    return restored;
  }

  /** Purges removed notes past their 30 days (the scheduler does it on each tick; tests). */
  purgeRemoved(): number {
    const db = this.#need();
    const before = new Date(this.#now().getTime() - MEMORY_REMOVED_KEEP_DAYS * 24 * HOUR_MS).toISOString();
    const count = db.removed(null, MEMORY_REMOVED_KEEP_DAYS).filter((row) => row.removedAt < before).length;
    for (const scope of new Set(db.purgeRemoved(before))) this.#o.bus.publish('memoryChanged', { scope });
    return count;
  }

  #needChecks(): MemoryChecks {
    this.#need();
    if (!this.#checks) throw new MemoryError(404, 'checks-off', 'memory checks do not run here (demo mode)');
    return this.#checks;
  }

  /** The checks (tests: run a tick, wait for the runs). */
  get checks(): MemoryChecks | null {
    return this.#checks;
  }

  /** `GET /api/memory/check?scope=`: the folder's check state (last run and result, next due time). */
  checkStatus(scope: string): MemoryCheckStatus {
    if (!scope) throw new MemoryError(422, 'invalid', 'scope is required: the folder', 'scope');
    return this.#needChecks().status(scope);
  }

  /** `GET /api/memory/check/settings`. */
  checkSettings(): MemoryCheckSettings {
    return this.#needChecks().settings();
  }

  /** `PUT /api/memory/check/settings` `{ enabled?, frequencyDays? }`. */
  setCheckSettings(body: unknown): MemoryCheckSettings {
    const checks = this.#needChecks();
    const read = readCheckSettings(body);
    if ('error' in read) throw new MemoryError(422, 'invalid', read.error, read.field);
    const settings = checks.setSettings(read);
    this.#o.bus.publish('memoryChanged', { scope: null });
    return settings;
  }

  /** `PUT /api/memory/check` `{ scope, enabled }`: the check on or off for one folder. */
  setCheckFolder(body: unknown): MemoryCheckStatus {
    const checks = this.#needChecks();
    const raw = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const scope = typeof raw['scope'] === 'string' ? raw['scope'].trim() : '';
    if (scope === '') throw new MemoryError(422, 'invalid', 'scope is required: the folder', 'scope');
    if (typeof raw['enabled'] !== 'boolean') throw new MemoryError(422, 'invalid', 'enabled must be true or false', 'enabled');
    const status = checks.setFolderEnabled(scope, raw['enabled']);
    this.#o.bus.publish('memoryChanged', { scope });
    return status;
  }

  /** `POST /api/memory/check/run` `{ scope }` ("Check now"): runs the folder's check in the background now. */
  checkNow(body: unknown): MemoryCheckStatus {
    const checks = this.#needChecks();
    const raw = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const scope = typeof raw['scope'] === 'string' ? raw['scope'].trim() : '';
    if (scope === '') throw new MemoryError(422, 'invalid', 'scope is required: the folder', 'scope');
    if (this.#need().list({ scope, statuses: ['approved'] }).length === 0) throw new MemoryError(409, 'no-notes', 'this folder has no approved notes to check');
    return checks.checkNow(scope);
  }

  // ── after a change ──────────────────────────────────────────────────────

  /**
   * The approved set (or the cap) of `scope` changed: the page reloads and open sessions are
   * flagged as on an older instruction (D91's `instructionOutdated`, republished now). Nothing is
   * restarted (ruling 2026-10-14): the developer applies or reloads when they choose; new and
   * resumed sessions get the current approved memory at their spawn.
   */
  async #approvedChanged(scope: string): Promise<void> {
    this.#o.bus.publish('memoryChanged', { scope });
    await this.#o.supervisor.instructionSettingChanged().catch(() => undefined);
  }

  // ── the Inbox item per folder with proposals ───────────────────────────

  async #syncAllInbox(): Promise<void> {
    const scopes = new Set<string>(this.#db?.list({ statuses: ['proposed'] }).map((entry) => entry.scope) ?? []);
    for (const item of await this.#o.store.systemItems.list(['open'])) {
      const scope = item.kind === MEMORY_PROPOSALS_ITEM ? scopeOfItem(item.payload) : null;
      if (scope !== null) scopes.add(scope);
    }
    for (const scope of scopes) await this.#syncInbox(scope).catch((error: unknown) => this.#onError(error));
  }

  /**
   * One open "N memory proposals for <folder>" item while the folder has proposals (its title
   * follows the count; Review goes to the Memory page); closed (`resolved`) once the queue is
   * empty, and while Project memory is off.
   */
  async #syncInbox(scope: string): Promise<void> {
    const proposed = this.#enabled && this.#db ? this.#db.list({ scope, statuses: ['proposed'] }) : [];
    const open = (await this.#o.store.systemItems.list(['open'])).filter((item) => item.kind === MEMORY_PROPOSALS_ITEM && scopeOfItem(item.payload) === scope);
    let changed = false;
    if (proposed.length === 0) {
      for (const item of open) {
        try {
          await this.#o.store.systemItems.close(item.id, 'resolved');
          changed = true;
        } catch (error) {
          if (!(error instanceof StoreError && error.code === 'conflict')) throw error;
        }
      }
    } else {
      const label = await this.#label(scope);
      const title = memoryProposalsTitle(proposed.length, label);
      const newest = proposed[proposed.length - 1] as MemoryEntry;
      const detail = `Agents proposed project memory for ${scope}. Review approves, edits or rejects each one; nothing is used until you approve it. Newest: "${memoryProposalLabel(this.#withTarget(newest))}".`;
      const payload = { scope, route: `/memory?scope=${encodeURIComponent(scope)}` };
      const [first, ...rest] = open;
      if (first) {
        if (first.title !== title || first.detail !== detail) {
          await this.#o.store.systemItems.update(first.id, { title, detail, payload });
          changed = true;
        }
      } else {
        await this.#o.store.systemItems.create({
          kind: MEMORY_PROPOSALS_ITEM,
          source: 'memory',
          status: 'need',
          title,
          detail,
          branches: [],
          actions: [
            { id: OPEN_MEMORY, label: 'Review' },
            { id: 'dismiss', label: 'Dismiss' },
          ],
          sessionId: null,
          payload,
        });
        changed = true;
      }
      for (const extra of rest) await this.#o.store.systemItems.close(extra.id, 'resolved').catch(() => undefined);
    }
    if (changed) this.#o.bus.publish('inboxChanged', { count: await inboxCount(this.#o.store) });
  }
}

function scopeOfItem(payload: unknown): string | null {
  const scope = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>)['scope'] : null;
  return typeof scope === 'string' ? scope : null;
}
