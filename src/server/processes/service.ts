import os from 'node:os';
import type { LifecyclePayload } from '../../core/event-payload.ts';
import type { ProcessTracking, SessionActivity, SessionProcess, SessionProcesses, TrackedProcessTotals } from '../../core/api.ts';
import {
  IDLE_STOP_DEFAULT_MINUTES,
  IDLE_STOP_MAX_MINUTES,
  IDLE_STOP_MIN_MINUTES,
  type KnownProcess,
  type ListedProcess,
  PROCESS_SAMPLE_MS,
  PROCESS_STOP_GRACE_MS,
  type StopCause,
  advanceTree,
  autoStopAt,
  autoStopReason,
  autoStoppable,
  descendsFrom,
  classifyProcess,
  processName,
  sameProcess,
  sessionLeftovers,
  sessionWorking,
  shortCommand,
  stoppedLabel,
  subtreeOf,
} from '../../core/processes.ts';
import { PROCESS_KEEP_REASON_MAX } from '../../core/process-keep.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { type StopHow, stopProcess } from '../hooks/terminal-stop.ts';
import type { ProcessScanner } from './scan.ts';

/** The stored setting: the idle delay in minutes (0 = off). */
export const IDLE_STOP_SETTING = 'processes.idleStopMinutes';

/** Internal key of the settings table: the processes marked Keep (survives a restart; not an editable setting). */
export const KEEP_SETTING = 'processes.keep';

/** A fresh read samples again when the last sample is older than this. */
const FRESH_MS = 2_000;

/** Why a process action was refused. */
export class ProcessError extends Error {
  override name = 'ProcessError';
  readonly code: 'not-found' | 'invalid' | 'unavailable';
  readonly status: number;
  constructor(code: ProcessError['code'], message: string) {
    super(message);
    this.code = code;
    this.status = code === 'not-found' ? 404 : code === 'invalid' ? 422 : 503;
  }
}

/** A process marked Keep: by pid and start (a pid alone may be reused). */
interface KeepEntry {
  readonly sessionId: string;
  readonly pid: number;
  readonly startedAtMs: number;
  readonly by: 'developer' | 'agent';
  readonly reason: string | null;
}

/** A session's processes as last sampled. */
interface SessionState {
  readonly tracking: ProcessTracking;
  /** Every row of the session (the CLI and its helpers included): the stop's subtree is read from them. */
  readonly rows: readonly ListedProcess[];
  readonly leftovers: readonly ListedProcess[];
  /** The session's CLI (live, hooked terminal, else its last pid) when it is among the rows (running), else `null`. */
  readonly rootPid: number | null;
}

/** What the service reads about the sessions (the supervisor and the hooks in the app; stand-ins in tests). */
export interface ProcessSessions {
  /** The session's live supervised process's pid (its CLI), `null` without one. */
  livePid(sessionId: string): number | null;
  /** The live activity (`null` while no turn runs and nothing is pending). */
  activity(sessionId: string): SessionActivity | null;
  /** The sessions with a live supervised process. */
  liveSessionIds(): readonly string[];
  /** Hooked terminal sessions with the pid of their terminal's CLI (not verified: the root must look like the CLI). */
  hookedRoots?(): Promise<ReadonlyArray<{ readonly sessionId: string; readonly pid: number }>>;
  /** A note on the session's timeline (a lifecycle event). */
  record(sessionId: string, label: string, payload: LifecyclePayload): Promise<void>;
  /** Subscribes to the sessions' changes (a close); returns the unsubscribe function. */
  onSessionChanged?(listener: (sessionId: string) => void): () => void;
}

/** Options of {@link ProcessService}. */
export interface ProcessServiceOptions {
  readonly store: Store;
  readonly sessions: ProcessSessions;
  /** The OS listing (`platformScanner()`); `null` = tracking unavailable here. */
  readonly scanner: ProcessScanner | null;
  /** Sampling interval (default {@link PROCESS_SAMPLE_MS}). */
  readonly sampleMs?: number;
  /** The first sample after {@link ProcessService.start} (default 5 s). */
  readonly firstSampleMs?: number;
  /** SIGTERM → SIGKILL grace (default {@link PROCESS_STOP_GRACE_MS}). */
  readonly graceMs?: number;
  /** Tests: the idle delay in ms instead of the setting's minutes. */
  readonly idleDelayMs?: number;
  /** Stops one process (default: `terminal-stop.ts`'s `stopProcess`: SIGTERM / `taskkill /T`, the force after the grace). */
  readonly stop?: (pid: number, graceMs: number) => Promise<StopHow>;
  readonly now?: () => number;
  /** The home folder, shown as `~` (default `os.homedir()`). */
  readonly home?: string;
  /** The service's own pid (never touched; default `process.pid`). */
  readonly selfPid?: number;
  readonly onError?: (error: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readKeeps(value: unknown): KeepEntry[] {
  if (!Array.isArray(value)) return [];
  const out: KeepEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const { sessionId, pid, startedAtMs, by, reason } = item;
    if (typeof sessionId !== 'string' || typeof pid !== 'number' || typeof startedAtMs !== 'number' || (by !== 'developer' && by !== 'agent')) continue;
    out.push({ sessionId, pid, startedAtMs, by, reason: typeof reason === 'string' ? reason : null });
  }
  return out;
}

/** A setting's idle delay (whole minutes in bounds, else the default). */
export function idleStopMinutes(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= IDLE_STOP_MIN_MINUTES && value <= IDLE_STOP_MAX_MINUTES ? value : IDLE_STOP_DEFAULT_MINUTES;
}

/**
 * D127 · the processes sessions leave running (`docs/processes.md`). Every
 * {@link PROCESS_SAMPLE_MS} it lists this user's processes ({@link ProcessScanner}), gives
 * each session the ones that carry its marker (`SWITCHBOARD_SESSION`, macOS / Linux) or sit in
 * its CLI's process tree (Windows; hooked terminal sessions anywhere), minus the CLI itself and
 * its own helpers, and stops a session's leftovers (all but those marked Keep) once it is
 * closed, or idle for the setting's delay. It never stops a process of a session that works or
 * waits on a background task, never one it cannot tie to a session, and checks each pid again
 * (same session, same start) right before signalling it.
 */
export class ProcessService {
  readonly #options: ProcessServiceOptions;
  readonly #now: () => number;
  readonly #home: string;
  #states = new Map<string, SessionState>();
  readonly #trees = new Map<string, KnownProcess[]>();
  readonly #lastWorking = new Map<string, number>();
  #keeps: KeepEntry[] | null = null;
  #sampledAt: number | null = null;
  #sampling: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #soon: NodeJS.Timeout | null = null;
  #unsubscribe: (() => void) | null = null;
  readonly #stopping = new Set<number>();
  #closed = false;

  constructor(options: ProcessServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#home = options.home ?? os.homedir();
  }

  /** `true` where this OS can be listed. */
  get available(): boolean {
    return this.#options.scanner !== null;
  }

  /** Starts sampling (the first sample after `firstSampleMs`), and reacts to closes. */
  start(): void {
    if (this.#closed || this.#timer || !this.#options.scanner) return;
    this.#schedule(this.#options.firstSampleMs ?? 5_000);
    this.#unsubscribe =
      this.#options.sessions.onSessionChanged?.((sessionId) => {
        // A close stops that session's leftovers at once (the next sample would, within 30 s).
        if (this.#states.has(sessionId)) this.#sampleSoon();
      }) ?? null;
  }

  /** Stops sampling and waits for a sample in flight. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#soon) clearTimeout(this.#soon);
    this.#timer = null;
    this.#soon = null;
    this.#unsubscribe?.();
    await this.#sampling?.catch(() => undefined);
  }

  #schedule(ms: number): void {
    if (this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.sample()
        .catch((error: unknown) => this.#onError(error))
        .finally(() => this.#schedule(this.#options.sampleMs ?? PROCESS_SAMPLE_MS));
    }, ms);
    this.#timer.unref();
  }

  #sampleSoon(): void {
    if (this.#soon || this.#closed) return;
    this.#soon = setTimeout(() => {
      this.#soon = null;
      void this.sample().catch((error: unknown) => this.#onError(error));
    }, 300);
    this.#soon.unref();
  }

  #onError(error: unknown): void {
    (this.#options.onError ?? ((e: unknown) => console.error('switchboard processes:', e)))(error);
  }

  // ── sampling ───────────────────────────────────────────────────────────

  /** Samples now (a sample in flight is joined), then runs the auto-stop. */
  sample(): Promise<void> {
    if (this.#sampling) return this.#sampling;
    const run = (async () => {
      const found = await this.#read();
      if (!found) return;
      this.#states = found;
      this.#sampledAt = this.#now();
      await this.#pruneKeeps();
      if (!this.#closed) await this.#autoStop();
    })().finally(() => {
      this.#sampling = null;
    });
    this.#sampling = run;
    return run;
  }

  /** Samples when the last sample is older than a moment (the UI's fresh reads). */
  async fresh(): Promise<void> {
    if (this.#sampledAt === null || this.#now() - this.#sampledAt > FRESH_MS) await this.sample();
  }

  /** Lists and assigns: the sessions' states, `null` when the listing failed (or there is none here). */
  async #read(): Promise<Map<string, SessionState> | null> {
    const scanner = this.#options.scanner;
    if (!scanner) return null;
    const listed = await scanner.list();
    if (!listed) return null;
    const self = this.#options.selfPid ?? process.pid;
    const rows = listed.filter((row) => row.pid !== self && row.pid > 1);
    // Roots of the trees: every live CLI where the environment cannot be read; hooked terminals everywhere.
    const roots = new Map<string, { readonly pid: number; readonly hooked: boolean }>();
    if (!scanner.envReadable) for (const id of this.#options.sessions.liveSessionIds()) {
      const pid = this.#options.sessions.livePid(id);
      if (pid !== null) roots.set(id, { pid, hooked: false });
    }
    for (const root of (await this.#options.sessions.hookedRoots?.()) ?? []) roots.set(root.sessionId, { pid: root.pid, hooked: true });
    const byPid = new Map(rows.map((row) => [row.pid, row] as const));
    const members = new Map<string, Set<number>>();
    const tracking = new Map<string, ProcessTracking>();
    const add = (sessionId: string, pid: number, how: ProcessTracking): void => {
      let set = members.get(sessionId);
      if (!set) {
        set = new Set();
        members.set(sessionId, set);
      }
      set.add(pid);
      if (!tracking.has(sessionId) || how === 'marker') tracking.set(sessionId, how);
    };
    if (scanner.envReadable) for (const row of rows) if (row.marker) add(row.marker, row.pid, 'marker');
    const treeIds = new Set([...roots.keys(), ...this.#trees.keys()]);
    for (const id of treeIds) {
      const root = roots.get(id);
      const rootRow = root ? byPid.get(root.pid) : undefined;
      // A hooked root must look like the CLI the hooks named (a pid reported earlier may be reused since).
      const rootOk = rootRow !== undefined && (!root?.hooked || /claude/i.test(rootRow.command));
      const known = advanceTree(this.#trees.get(id) ?? [], rows, rootOk && rootRow ? [{ pid: rootRow.pid, startedAtMs: rootRow.startedAtMs }] : []);
      if (known.length === 0) this.#trees.delete(id);
      else this.#trees.set(id, known);
      for (const entry of known) add(id, entry.pid, 'tree');
    }
    // Only this machine's sessions (another Switchboard's markers are not ours to touch).
    const sessions = new Map<string, SessionRecord>();
    for (const id of members.keys()) {
      const record = await this.#options.store.sessions.get(id);
      if (record) sessions.set(id, record);
      else this.#trees.delete(id);
    }
    const wanted = [...sessions.keys()].flatMap((id) => [...(members.get(id) ?? [])]);
    const commands = await scanner.commands(wanted, rows);
    const states = new Map<string, SessionState>();
    for (const [id, record] of sessions) {
      const sessionRows = [...(members.get(id) ?? [])]
        .map((pid) => byPid.get(pid))
        .filter((row): row is ListedProcess => row !== undefined)
        .map((row) => ({ ...row, command: commands.get(row.pid) ?? row.command }));
      const rootPid = this.#options.sessions.livePid(id) ?? roots.get(id)?.pid ?? record.pid;
      const leftovers = sessionLeftovers(sessionRows, rootPid);
      const running = rootPid !== null && sessionRows.some((row) => row.pid === rootPid);
      states.set(id, { tracking: tracking.get(id) ?? 'none', rows: sessionRows, leftovers, rootPid: running ? rootPid : null });
    }
    return states;
  }

  // ── keeps ──────────────────────────────────────────────────────────────

  async #loadKeeps(): Promise<KeepEntry[]> {
    if (this.#keeps === null) this.#keeps = readKeeps(await this.#options.store.settings.get(KEEP_SETTING));
    return this.#keeps;
  }

  async #saveKeeps(keeps: KeepEntry[]): Promise<void> {
    this.#keeps = keeps;
    await this.#options.store.settings.set(KEEP_SETTING, keeps);
  }

  /** Forgets the Keep marks of processes that are gone (or whose pid now belongs to another process). */
  async #pruneKeeps(): Promise<void> {
    const keeps = await this.#loadKeeps();
    if (keeps.length === 0) return;
    const live = keeps.filter((entry) => this.#states.get(entry.sessionId)?.rows.some((row) => sameProcess(row, entry)) === true);
    if (live.length !== keeps.length) await this.#saveKeeps(live);
  }

  #keepOf(sessionId: string, row: ListedProcess): KeepEntry | null {
    return (this.#keeps ?? []).find((entry) => entry.sessionId === sessionId && sameProcess(row, entry)) ?? null;
  }

  /**
   * The rows of a session the automatic stop leaves alone: those marked Keep, plus their
   * ancestors and descendants among its rows (stopping `npm run dev` would end the kept `vite`).
   */
  #protected(sessionId: string, state: SessionState): Set<number> {
    const kept = state.leftovers.filter((row) => this.#keepOf(sessionId, row) !== null).map((row) => row.pid);
    const out = new Set<number>();
    for (const pid of kept) {
      for (const below of subtreeOf(state.rows, pid)) out.add(below);
      let current = state.rows.find((row) => row.pid === pid);
      while (current && !out.has(current.ppid)) {
        const parent = state.rows.find((row) => row.pid === current?.ppid);
        if (!parent) break;
        out.add(parent.pid);
        current = parent;
      }
      out.add(pid);
    }
    return out;
  }

  /**
   * What an automatic stop of the session would take: its leftovers but the kept ones (and their
   * family), and, under a CLI that still runs, an `other` process (it may be one of the CLI's
   * own, an MCP server behind a shell): only the developer stops those.
   */
  #autoTargets(sessionId: string, state: SessionState): ListedProcess[] {
    const keep = this.#protected(sessionId, state);
    return state.leftovers.filter((row) => !keep.has(row.pid) && autoStoppable(classifyProcess(row.command), descendsFrom(state.rows, row.pid, state.rootPid)));
  }

  // ── views ──────────────────────────────────────────────────────────────

  #view(sessionId: string, row: ListedProcess): SessionProcess {
    const keep = this.#keepOf(sessionId, row);
    return {
      pid: row.pid,
      ppid: row.ppid,
      name: processName(row.command),
      kind: classifyProcess(row.command),
      rssBytes: row.rssBytes,
      startedAt: new Date(row.startedAtMs).toISOString(),
      cpuPct: row.cpuPct,
      command: shortCommand(row.command, this.#home),
      keep: keep !== null,
      keptBy: keep?.by ?? null,
      keepReason: keep?.reason ?? null,
    };
  }

  async #idleDelayMs(): Promise<number> {
    if (this.#options.idleDelayMs !== undefined) return this.#options.idleDelayMs;
    return (await this.idleStopMinutes()) * 60_000;
  }

  /** The idle delay setting (minutes; 0 = off). */
  async idleStopMinutes(): Promise<number> {
    if (this.#options.idleDelayMs !== undefined) return Math.round(this.#options.idleDelayMs / 60_000);
    return idleStopMinutes(await this.#options.store.settings.get(IDLE_STOP_SETTING));
  }

  #working(record: SessionRecord): boolean {
    return sessionWorking(record.status, this.#options.sessions.activity(record.id));
  }

  /** Since when the session has not worked (epoch ms): its last sign of work, else its last activity. */
  #idleSince(record: SessionRecord): number | null {
    const seen = this.#lastWorking.get(record.id) ?? null;
    const at = Date.parse(record.lastActivityAt ?? record.updatedAt);
    const activity = Number.isNaN(at) ? null : at;
    if (seen === null) return activity;
    return activity === null ? seen : Math.max(seen, activity);
  }

  /** A session's processes (`GET /api/sessions/{id}/processes`); `fresh` samples first when the last sample is old. */
  async forSession(sessionId: string, options: { readonly fresh?: boolean } = {}): Promise<SessionProcesses> {
    const record = await this.#options.store.sessions.get(sessionId);
    if (!record) throw new ProcessError('not-found', `no session ${sessionId}`);
    if (options.fresh) await this.fresh();
    await this.#loadKeeps();
    return this.#sessionView(record, await this.#idleDelayMs());
  }

  #sessionView(record: SessionRecord, delayMs: number): SessionProcesses {
    const state = this.#states.get(record.id);
    const processes = (state?.leftovers ?? []).map((row) => this.#view(record.id, row)).sort((a, b) => b.rssBytes - a.rssBytes);
    const working = this.#working(record);
    const closed = record.closedAt !== null;
    const anyToStop = state !== undefined && this.#autoTargets(record.id, state).length > 0;
    const at = anyToStop && !closed ? autoStopAt({ working, idleSinceMs: this.#idleSince(record), delayMs }) : null;
    return {
      sessionId: record.id,
      title: record.title ?? record.name,
      processes,
      rssBytes: processes.reduce((sum, process) => sum + process.rssBytes, 0),
      tracking: state?.tracking ?? (this.#options.scanner?.envReadable ? 'marker' : record.hooked || this.#options.sessions.livePid(record.id) !== null ? 'tree' : 'none'),
      working,
      closed,
      stopsAt: at === null ? null : new Date(Math.max(at, this.#now())).toISOString(),
      sampledAt: this.#sampledAt === null ? null : new Date(this.#sampledAt).toISOString(),
    };
  }

  /** Every session with processes (`GET /api/processes`, this machine's part), the most memory first. */
  async overview(options: { readonly fresh?: boolean } = {}): Promise<SessionProcesses[]> {
    if (options.fresh) await this.fresh();
    await this.#loadKeeps();
    const delayMs = await this.#idleDelayMs();
    const out: SessionProcesses[] = [];
    for (const [id, state] of this.#states) {
      if (state.leftovers.length === 0) continue;
      const record = await this.#options.store.sessions.get(id);
      if (record) out.push(this.#sessionView(record, delayMs));
    }
    return out.sort((a, b) => b.rssBytes - a.rssBytes);
  }

  /** The sidebar footer's totals; `null` before the first sample (or where nothing is tracked). */
  totals(): TrackedProcessTotals | null {
    if (this.#sampledAt === null) return null;
    let count = 0;
    let rssBytes = 0;
    for (const state of this.#states.values()) {
      count += state.leftovers.length;
      for (const row of state.leftovers) rssBytes += row.rssBytes;
    }
    return { count, rssBytes };
  }

  /** When the last sample was taken (ISO), `null` before the first. */
  get sampledAt(): string | null {
    return this.#sampledAt === null ? null : new Date(this.#sampledAt).toISOString();
  }

  // ── Keep ───────────────────────────────────────────────────────────────

  /** Keep (or hand back) one of the session's processes (the developer's toggle). */
  async setKeep(sessionId: string, pid: number, keep: boolean, reason: string | null = null): Promise<SessionProcesses> {
    await this.fresh();
    const row = this.#states.get(sessionId)?.leftovers.find((candidate) => candidate.pid === pid);
    if (!row) throw new ProcessError('not-found', `process ${pid} is not one of this session's processes (it may have ended)`);
    await this.#mark(sessionId, [row], keep, 'developer', reason);
    return this.forSession(sessionId);
  }

  /**
   * The agent's `process_keep`: its session's processes by pid or by a part of the command
   * line (case-insensitive, also the short name). Answers the processes it changed.
   * @throws {ProcessError} `invalid` (neither pid nor match, a bad reason), `not-found` (nothing matched).
   */
  async agentKeep(sessionId: string, body: unknown): Promise<{ readonly processes: SessionProcess[]; readonly keep: boolean }> {
    const input = isRecord(body) ? body : {};
    const keep = input['keep'];
    if (typeof keep !== 'boolean') throw new ProcessError('invalid', 'Give keep: true to keep the process running, false to hand it back.');
    const pid = input['pid'];
    const match = typeof input['match'] === 'string' ? input['match'].trim() : '';
    if ((typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) && match === '') throw new ProcessError('invalid', 'Give pid (the process id) or match (part of its command line).');
    const rawReason = typeof input['reason'] === 'string' ? input['reason'].replace(/\s+/g, ' ').trim() : '';
    if (rawReason.length > PROCESS_KEEP_REASON_MAX) throw new ProcessError('invalid', `Keep reason to one line of at most ${PROCESS_KEEP_REASON_MAX} characters.`);
    await this.fresh();
    const leftovers = this.#states.get(sessionId)?.leftovers ?? [];
    const needle = match.toLowerCase();
    const rows = leftovers.filter((row) => (typeof pid === 'number' ? row.pid === pid : row.command.toLowerCase().includes(needle) || processName(row.command).toLowerCase().includes(needle)));
    if (rows.length === 0) {
      const list = leftovers.map((row) => `${processName(row.command)} (pid ${row.pid})`).join(', ');
      throw new ProcessError('not-found', `No process of this session matches${typeof pid === 'number' ? ` pid ${pid}` : ` "${match}"`}. ${list ? `This session's processes: ${list}.` : 'This session has no processes running.'}`);
    }
    await this.#mark(sessionId, rows, keep, 'agent', rawReason || null);
    await this.#loadKeeps();
    return { processes: rows.map((row) => this.#view(sessionId, row)), keep };
  }

  async #mark(sessionId: string, rows: readonly ListedProcess[], keep: boolean, by: 'developer' | 'agent', reason: string | null): Promise<void> {
    const keeps = (await this.#loadKeeps()).filter((entry) => !(entry.sessionId === sessionId && rows.some((row) => sameProcess(row, entry))));
    if (keep) for (const row of rows) keeps.push({ sessionId, pid: row.pid, startedAtMs: row.startedAtMs, by, reason });
    await this.#saveKeeps(keeps);
  }

  // ── stopping ───────────────────────────────────────────────────────────

  /** The developer's Stop: the process and what runs under it, Keep or not; noted on the session's timeline. */
  async stopOne(sessionId: string, pid: number): Promise<SessionProcesses> {
    await this.fresh();
    const state = this.#states.get(sessionId);
    const row = state?.leftovers.find((candidate) => candidate.pid === pid);
    if (!state || !row) throw new ProcessError('not-found', `process ${pid} is not one of this session's processes (it may have ended)`);
    const pids = subtreeOf(state.leftovers, pid);
    await this.#stopRows(
      sessionId,
      state.leftovers.filter((candidate) => pids.includes(candidate.pid)),
      { kind: 'developer' },
    );
    return this.forSession(sessionId);
  }

  /** D127 decision 4: each session's leftovers, closed → now, idle ≥ the delay → now; never while it works; never a kept one. */
  async #autoStop(): Promise<void> {
    const delayMs = await this.#idleDelayMs();
    const now = this.#now();
    for (const [id, state] of this.#states) {
      const record = await this.#options.store.sessions.get(id);
      if (!record) continue;
      const working = this.#working(record);
      if (working) {
        this.#lastWorking.set(id, now);
        continue;
      }
      if (state.leftovers.length === 0) continue;
      const reason = autoStopReason({ closed: record.closedAt !== null, working, idleSinceMs: this.#idleSince(record), nowMs: now, delayMs });
      if (!reason) continue;
      const targets = this.#autoTargets(id, state).filter((row) => !this.#stopping.has(row.pid));
      if (targets.length === 0) continue;
      const cause: StopCause = reason === 'closed' ? { kind: 'closed' } : { kind: 'idle', minutes: Math.round(delayMs / 60_000) };
      await this.#stopRows(id, targets, cause);
    }
  }

  /**
   * Stops `rows` of a session: each pid is checked against a new listing first (still the
   * session's, same start), then SIGTERM (`taskkill /T`) and SIGKILL (`/F`) after the grace, all
   * at once; the stop is noted on the session's timeline. A process that ended by itself meanwhile
   * is left out of the note.
   */
  async #stopRows(sessionId: string, rows: readonly ListedProcess[], cause: StopCause): Promise<void> {
    const scanner = this.#options.scanner;
    if (!scanner || rows.length === 0) return;
    const again = await this.#read();
    if (!again) throw new ProcessError('unavailable', 'could not list the processes to check them before stopping');
    const current = again.get(sessionId)?.leftovers ?? [];
    const verified = rows.filter((row) => current.some((now) => sameProcess(now, row)) && !this.#stopping.has(row.pid));
    if (verified.length === 0) return;
    for (const row of verified) this.#stopping.add(row.pid);
    const grace = this.#options.graceMs ?? PROCESS_STOP_GRACE_MS;
    const stop = this.#options.stop ?? ((pid: number, graceMs: number) => stopProcess(pid, { graceMs }));
    const stopped: ListedProcess[] = [];
    try {
      const results = await Promise.allSettled(verified.map((row) => stop(row.pid, grace)));
      results.forEach((result, index) => {
        const row = verified[index] as ListedProcess;
        if (result.status === 'fulfilled' && result.value !== 'gone') stopped.push(row);
        else if (result.status === 'rejected') this.#onError(result.reason);
      });
    } finally {
      for (const row of verified) this.#stopping.delete(row.pid);
    }
    if (stopped.length > 0) {
      const views = stopped.map((row) => this.#view(sessionId, row));
      const label = stoppedLabel(views, cause);
      await this.#options.sessions
        .record(sessionId, label, {
          type: 'lifecycle',
          action: 'processes-stopped',
          message: label,
          reason: cause.kind,
          stoppedProcesses: views.map((view) => ({ pid: view.pid, name: view.name, kind: view.kind, rssBytes: view.rssBytes })),
        })
        .catch((error: unknown) => this.#onError(error));
    }
    // The views follow at once (the next sample would only come in 30 s).
    const after = await this.#read();
    if (after) {
      this.#states = after;
      this.#sampledAt = this.#now();
    }
  }
}
