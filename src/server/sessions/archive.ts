import path from 'node:path';
import { loopShown } from '../../core/derive/loops.ts';
import {
  ARCHIVE_DAYS_SETTING,
  ARCHIVE_KEPT_REASONS,
  ARCHIVE_NEVER,
  ARCHIVE_SINCE_SETTING,
  ARCHIVE_SWEEP_INTERVAL_MS,
  ARCHIVE_SWEEP_SETTING,
  type ArchiveInfo,
  type ArchiveKeptReason,
  type ArchiveKeptWorktree,
  type ArchiveSweepRecord,
  archiveDaysOf,
  archiveGraceRestarts,
  archiveDue,
  archiveInfo,
  readArchiveSweep,
} from '../../core/session-archive.ts';
import type { CleanupArchive, CleanupArchiveSnapshot, CleanupService } from '../cleanup/service.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { toLoop } from '../loops/wire.ts';
// Plans (D99) hook (docs/plans-removal.md): the archive keeps the source session of an unfinished plan and a running / paused plan's item sessions.
import { plansArchiveHolds } from '../plans/hooks.ts';
// Team (D100) hook (docs/team-removal.md): a member's archived session is kept (`crew`); 2026-10-27, the developer chose B: it stays a member, only hidden.
import { teamMemberOf } from '../team/hooks.ts';
import { registerArchiveSource } from './wire.ts';

/** Options of {@link ArchiveService}. */
export interface ArchiveServiceOptions {
  readonly store: Store;
  /** Clean-up's removal code (D84): the session delete and the worktree checks. */
  readonly cleanup: CleanupService;
  /** `true` while a session has a running process. */
  readonly isLive: (sessionId: string) => boolean;
  readonly now?: () => Date;
  /** How often {@link ArchiveService.start} sweeps (default hourly). */
  readonly intervalMs?: number;
  /** One line per deletion and kept worktree (default `console.log`; the server log). */
  readonly log?: (line: string) => void;
  readonly onError?: (error: unknown) => void;
}

/** The kept sessions and whether Plans could say which sessions it needs. */
interface Holds {
  readonly kept: Map<string, ArchiveKeptReason>;
  readonly plansKnown: boolean;
}

/** How long one computation of the kept sessions is reused (a session list asks for every row). */
const HOLDS_TTL_MS = 2_000;

/**
 * D137 · the archive (`docs/cleanup.md` → *The archive (D137)*). Closing a session
 * archives it; once archived for `sessions.archiveDays` days (default 14; 0 =
 * Never) the sweep deletes it by itself, quietly (a server log line and the
 * Settings record, no Needs-you item, toast or push), with the same removal as a
 * Clean-up run, and removes the worktrees Switchboard made for it when nothing
 * would be lost ({@link CleanupService.removeWorktreeIfSafe}).
 *
 * - **Upgrade grace:** `sessions.archiveSince` is written the first time this
 *   runs; a session archived earlier counts its period from then. A change of the
 *   period from Never or to a shorter one moves it to the change ({@link periodChange}).
 * - **Kept** (never deleted while it holds, re-checked every sweep): running, a
 *   Team member, the source of an unfinished plan or a step of a running /
 *   paused plan, an active (not ended) Switchboard loop, a CLI schedule still
 *   listed, pinned in the sidebar.
 * - **This computer only:** it sweeps its own store; a paired computer sweeps its own.
 * - The sweep runs at start (after the grace) and every hour; never in demo mode
 *   (the app does not start it).
 */
export class ArchiveService implements CleanupArchive {
  readonly #store: Store;
  readonly #cleanup: CleanupService;
  readonly #isLive: (sessionId: string) => boolean;
  readonly #now: () => Date;
  readonly #intervalMs: number;
  readonly #log: (line: string) => void;
  readonly #onError: (error: unknown) => void;
  readonly #unregister: () => void;
  #timer: ReturnType<typeof setInterval> | null = null;
  #sweeping: Promise<ArchiveSweepRecord> | null = null;
  #holds: { readonly at: number; readonly value: Promise<Holds> } | null = null;
  #stopped = false;

  constructor(options: ArchiveServiceOptions) {
    this.#store = options.store;
    this.#cleanup = options.cleanup;
    this.#isLive = options.isLive;
    this.#now = options.now ?? (() => new Date());
    this.#intervalMs = options.intervalMs ?? ARCHIVE_SWEEP_INTERVAL_MS;
    this.#log = options.log ?? ((line) => console.log(line));
    this.#onError = options.onError ?? ((error) => console.error(error));
    this.#unregister = registerArchiveSource(this.#store, { info: (record) => this.info(record) });
    options.cleanup.useArchive(this);
  }

  /** Records the upgrade grace, sweeps once, then every interval. */
  async start(): Promise<void> {
    if (this.#stopped || this.#timer) return;
    await this.since();
    await this.sweep().catch(this.#onError);
    if (this.#stopped) return;
    this.#timer = setInterval(() => {
      void this.sweep().catch(this.#onError);
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  /** Stops the timer and waits for a sweep that runs; the source stays registered until then. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#sweeping?.catch(() => undefined);
    this.#unregister();
  }

  /** The period in days (0 = Never). */
  async days(): Promise<number> {
    return archiveDaysOf(await this.#store.settings.get(ARCHIVE_DAYS_SETTING));
  }

  /**
   * The grace start: the upgrade grace, written (now) when missing; a period change from
   * Never or to a shorter period moves it ({@link periodChange}). Read from the store every
   * time (never cached), so a sweep never pairs a new period with an old grace.
   */
  async since(): Promise<string> {
    const stored = await this.#storedSince();
    if (stored !== null) return stored;
    const now = this.#now().toISOString();
    await this.#store.settings.set(ARCHIVE_SINCE_SETTING, now);
    return now;
  }

  /** The grace as stored, without writing it (`null` before the first start). */
  async #storedSince(): Promise<string | null> {
    const stored = await this.#store.settings.get(ARCHIVE_SINCE_SETTING);
    return typeof stored === 'string' && Number.isFinite(Date.parse(stored)) ? stored : null;
  }

  /**
   * D137 follow-up 2026-10-26: the settings to store together with a new period `next`
   * (`PUT /api/settings`, in the same transaction): a new grace start (now) when the period
   * goes from Never to days or is shortened ({@link archiveGraceRestarts}), so a change never
   * makes archived sessions due at once; nothing when it is lengthened or unchanged.
   */
  async periodChange(next: number): Promise<Readonly<Record<string, unknown>>> {
    const previous = await this.days();
    return archiveGraceRestarts(previous, next) ? { [ARCHIVE_SINCE_SETTING]: this.#now().toISOString() } : {};
  }

  /** Stores a new period with its {@link periodChange} (what `PUT /api/settings` does). */
  async setPeriod(next: number): Promise<void> {
    await this.#store.settings.setMany({ [ARCHIVE_DAYS_SETTING]: next, ...(await this.periodChange(next)) });
  }

  /** The sweep's record. */
  async record(): Promise<ArchiveSweepRecord> {
    return readArchiveSweep(await this.#store.settings.get(ARCHIVE_SWEEP_SETTING));
  }

  /** Every session kept past its period now, with the first reason that holds. */
  async holds(): Promise<Map<string, ArchiveKeptReason>> {
    return (await this.#currentHolds()).kept;
  }

  #currentHolds(): Promise<Holds> {
    const now = Date.now();
    if (this.#holds && now - this.#holds.at < HOLDS_TTL_MS) return this.#holds.value;
    const value = this.#computeHolds();
    this.#holds = { at: now, value };
    value.catch(() => {
      if (this.#holds?.value === value) this.#holds = null;
    });
    return value;
  }

  async #computeHolds(): Promise<Holds> {
    const closed = await this.#store.sessions.list({ closed: true });
    const ids = new Set(closed.map((session) => session.id));
    const found = new Map<string, Set<ArchiveKeptReason>>();
    const add = (sessionId: string, reason: ArchiveKeptReason): void => {
      if (!ids.has(sessionId)) return;
      const reasons = found.get(sessionId) ?? new Set<ArchiveKeptReason>();
      reasons.add(reason);
      found.set(sessionId, reasons);
    };
    for (const session of closed) {
      if (this.#isLive(session.id)) add(session.id, 'running');
      if (teamMemberOf(this.#store, session.id) !== null) add(session.id, 'crew');
    }
    const plans = await plansArchiveHolds(this.#store);
    for (const [sessionId, reason] of plans ?? []) add(sessionId, reason);
    for (const loop of await this.#store.sessionLoops.listAll()) if (loop.state !== 'ended') add(loop.sessionId, 'routine');
    const now = this.#now();
    for (const loop of await this.#store.loops.list()) if (loop.kind !== 'Workflow' && loopShown(toLoop(loop), now)) add(loop.sessionId, 'cli-schedule');
    for (const sessionId of (await this.#store.sidebar.read()).pinned) add(sessionId, 'pinned');
    const kept = new Map<string, ArchiveKeptReason>();
    for (const [sessionId, reasons] of found) {
      const first = ARCHIVE_KEPT_REASONS.find((reason) => reasons.has(reason));
      if (first) kept.set(sessionId, first);
    }
    return { kept, plansKnown: plans !== null };
  }

  /** What an archived session shows (`Session.deletesAt` / `keptReason`). */
  async info(record: Pick<SessionRecord, 'id' | 'closedAt'>): Promise<ArchiveInfo> {
    if (record.closedAt === null) return { deletesAt: null, keptReason: null };
    const [days, since, holds] = await Promise.all([this.days(), this.#storedSince(), this.holds()]);
    // Before the first start (no grace yet) the grace would be "now": count from now so nothing reads as due.
    return archiveInfo({ closedAt: record.closedAt, since: since ?? this.#now().toISOString(), days, kept: holds.get(record.id) ?? null });
  }

  /** D84 Clean-up's view of the archive (its Closed sessions group follows the period). */
  async snapshot(): Promise<CleanupArchiveSnapshot> {
    const [days, since, kept] = await Promise.all([this.days(), this.#storedSince(), this.holds()]);
    return { days, since: since ?? this.#now().toISOString(), kept };
  }

  /**
   * One sweep: deletes every archived session past its period that nothing keeps, after
   * removing its worktrees that are safe to remove. A sweep already running is joined
   * (never two at once); a second sweep finds nothing new (idempotent).
   */
  sweep(): Promise<ArchiveSweepRecord> {
    if (this.#sweeping) return this.#sweeping;
    const run = this.#sweep().finally(() => {
      if (this.#sweeping === run) this.#sweeping = null;
    });
    this.#sweeping = run;
    return run;
  }

  async #sweep(): Promise<ArchiveSweepRecord> {
    const startedAt = this.#now();
    const days = await this.days();
    const since = await this.since();
    let deletedSessions = 0;
    let removedWorktrees = 0;
    const keptWorktrees: ArchiveKeptWorktree[] = [];
    if (days !== ARCHIVE_NEVER) {
      this.#holds = null;
      const { kept: holds, plansKnown } = await this.#currentHolds();
      // Plans has not opened plans.db (or cannot): which sessions a plan needs is unknown, so nothing is deleted now.
      if (!plansKnown) this.#log('[archive] skipped: Plans is not ready (plans.db), so the sessions plans need are unknown');
      const all = plansKnown ? await this.#store.sessions.list() : [];
      for (const session of all) {
        if (this.#stopped) break;
        if (session.closedAt === null || holds.has(session.id) || this.#isLive(session.id)) continue;
        const info = archiveInfo({ closedAt: session.closedAt, since, days, kept: null });
        if (!archiveDue(info.deletesAt, this.#now().getTime())) continue;
        const name = session.title ?? session.name;
        try {
          const outcome = await this.#deleteDue(session, all);
          removedWorktrees += outcome.removed;
          keptWorktrees.push(...outcome.kept);
          deletedSessions++;
          this.#log(`[archive] deleted archived session ${session.name} (“${name}”, archived ${session.closedAt.slice(0, 10)})${outcome.removed > 0 ? `, ${outcome.removed} worktree${outcome.removed === 1 ? '' : 's'} removed` : ''}`);
        } catch (error) {
          this.#log(`[archive] could not delete archived session ${session.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.#holds = null;
    }
    const previous = await this.record();
    const record: ArchiveSweepRecord = {
      lastRunAt: startedAt.toISOString(),
      lastDeleted: deletedSessions > 0 ? { at: startedAt.toISOString(), sessions: deletedSessions, worktrees: removedWorktrees, keptWorktrees: keptWorktrees.slice(0, 50) } : previous.lastDeleted,
    };
    await this.#store.settings.set(ARCHIVE_SWEEP_SETTING, record);
    return record;
  }

  /** Removes the session's safe worktrees, then the session (re-checked just before). */
  async #deleteDue(session: SessionRecord, all: readonly SessionRecord[]): Promise<{ removed: number; kept: ArchiveKeptWorktree[] }> {
    const fresh = await this.#store.sessions.get(session.id);
    // Restored (and maybe archived again) since the sweep read it: a new period.
    if (!fresh || fresh.closedAt === null || fresh.closedAt !== session.closedAt) throw new Error('it was restored');
    if (this.#isLive(session.id)) throw new Error('it is running');
    let removed = 0;
    const kept: ArchiveKeptWorktree[] = [];
    const rows = (await this.#store.worktrees.list()).filter((row) => row.sessionId === session.id && !row.removedAt);
    for (const row of rows) {
      // Another session (open or archived) that works in this worktree keeps it.
      const users = all.filter((other) => other.id !== session.id && other.cwd !== null && isInside(other.cwd, row.path)).map((other) => other.title ?? other.name);
      const outcome = await this.#cleanup.removeWorktreeIfSafe(row, users);
      if (outcome.removed) {
        removed++;
        this.#log(`[archive] removed worktree ${row.path} of ${session.name}`);
      } else {
        kept.push({ path: row.path, reason: outcome.reason });
        this.#log(`[archive] kept worktree ${row.path} of ${session.name}: ${outcome.reason}`);
      }
    }
    await this.#cleanup.deleteArchivedSession(session.id);
    return { removed, kept };
  }
}

/** `true` when `dir` is `root` or inside it. */
function isInside(dir: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
