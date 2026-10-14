import { stat } from 'node:fs/promises';
import {
  type CiStopReason,
  type PrReading,
  type SessionCi,
  type SessionPr,
  ciFailureMessage,
  failureSignature,
  prReadyToMerge,
  trimLogTail,
} from '../../core/ci.ts';
import type { PrWatchRecord } from '../db/repos/ci.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';
import type { Store } from '../db/store.ts';
import type { HubBus } from '../hub/bus.ts';
import { ciSettingsOf } from '../settings/settings.ts';
import type { CiGhPort, GhMergeMethod, PrViewResult } from './gh.ts';
import { ciMergeOwnedElsewhere } from './hooks.ts';

/** The Inbox items the watcher raises (implemented by the `SystemItemService`, `docs/system-items.md`). */
export interface CiNotices {
  /** Raises an item once per `dedupe` (open or closed). */
  ciNotice(input: CiNoticeInput): Promise<unknown>;
  /** Closes the open CI items of a worktree (of `kinds`, all when absent) with `outcome`; answers how many. */
  closeCiNotices(worktreeId: string, outcome: string, kinds?: readonly CiNoticeKind[]): Promise<number>;
}

/** The two CI Inbox items: "CI keeps failing …" (after the cap or the breaker) and "PR #12 ready to merge". */
export type CiNoticeKind = 'ci-failing' | 'ci-ready';

/** What {@link CiNotices.ciNotice} raises. */
export interface CiNoticeInput {
  readonly kind: CiNoticeKind;
  readonly worktreeId: string;
  readonly sessionId: string | null;
  readonly title: string;
  readonly detail: string;
  readonly url: string | null;
  readonly repo: string;
  readonly branch: string;
  readonly dedupe: string;
}

/** Options of {@link PrWatcher}. */
export interface PrWatcherOptions {
  readonly store: Store;
  readonly bus?: HubBus;
  readonly gh: CiGhPort;
  /** Sends a normal message to a session (queued while it works, held while new turns pause for credits, a hooked session's mailbox). */
  readonly send: (sessionId: string, text: string) => Promise<void>;
  readonly notices: CiNotices;
  /** D30: reads the worktree's PR again so a merged, clean one raises the "PR merged" item with Remove worktree. */
  readonly cleanup?: (worktreeId: string) => Promise<void>;
  readonly now?: () => number;
  /** Tests: read every PR again after this many ms instead of the settings' minutes (`SWITCHBOARD_CI_POLL_MS`). */
  readonly pollMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** How long a reading stays fresh for {@link PrWatcher.read} (Plans asks often). */
export const PR_READ_TTL_MS = 20_000;
/** The watcher's tick: due PRs are read at most this late. */
export const DEFAULT_CI_TICK_MS = 30_000;
/**
 * The watcher's timing from the environment: `SWITCHBOARD_CI_TICK_MS` (whole ms, ≥ 200) sets
 * both the tick and the first tick's delay (test servers shorten them); otherwise the defaults.
 */
export function ciTiming(env: Readonly<Record<string, string | undefined>> = process.env): { readonly intervalMs?: number; readonly initialDelayMs?: number } {
  const ms = envMs(env, 'SWITCHBOARD_CI_TICK_MS');
  return ms !== null ? { intervalMs: ms, initialDelayMs: ms } : {};
}

/** Test servers: `SWITCHBOARD_CI_POLL_MS` (whole ms, ≥ 200) replaces the settings' poll minutes; `null` = the settings. */
export function ciPollMs(env: Readonly<Record<string, string | undefined>> = process.env): number | null {
  return envMs(env, 'SWITCHBOARD_CI_POLL_MS');
}

function envMs(env: Readonly<Record<string, string | undefined>>, name: string): number | null {
  const raw = env[name]?.trim() ?? '';
  const ms = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isFinite(ms) && ms >= 200 ? ms : null;
}

/** A worktree without a known PR is asked at most this often at a turn's end (the agent may have opened one). */
const DISCOVER_EVERY_MS = 2 * 60_000;

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Why a PR is not ready to merge, for a refused Merge PR. */
function notReadyReason(pr: PrReading): string {
  if (pr.state !== 'OPEN') return `PR #${pr.number} is ${pr.state.toLowerCase()}`;
  if (pr.isDraft) return `PR #${pr.number} is a draft`;
  if (pr.checks.state === 'red') return `the checks of PR #${pr.number} ${pr.checks.summary ?? 'failed'}`;
  if (pr.checks.state === 'pending') return `the checks of PR #${pr.number} are still running`;
  if (pr.mergeable === 'CONFLICTING') return `PR #${pr.number} conflicts with ${pr.baseRefName ?? 'its base branch'}`;
  if (pr.review === 'CHANGES_REQUESTED') return `changes were requested on PR #${pr.number}`;
  if (pr.review === 'REVIEW_REQUIRED') return `PR #${pr.number} still needs an approving review`;
  return `PR #${pr.number} is not ready to merge`;
}

/**
 * D109 · the shared PR watcher (`docs/ci.md`). It follows the pull request of every live
 * worktree whose PR is open (found by D30's worktree PR poll, by a check at the end of a
 * session's turn, or after Plans' Open PR), reading it with `gh pr view` every
 * `ci.pendingPollMinutes` while its checks run and every `ci.idlePollMinutes` otherwise, and
 * stops once it is merged or closed.
 *
 * - **Red checks:** the failing job's log tail goes to the session as a normal message, one
 *   per red head, at most `ci.maxAttempts` per PR; the same failure twice in a row, or the
 *   cap, stops it and raises "CI keeps failing on PR #n …" (Open PR / Open session / Try again).
 * - **Green and approved** (or no approval required): "PR #n ready to merge" with Merge PR
 *   (`gh pr merge`, only on the click) and Open PR; once merged, D30's "PR merged" item offers
 *   the clean-up. A session whose PR another feature merges (Plans) gets no such item.
 * - **Plans** reads its items' PRs through {@link read} (one reading for both).
 *
 * Every change publishes `ciChanged { sessionId }`.
 */
export class PrWatcher {
  readonly #store: Store;
  readonly #bus: HubBus | null;
  readonly #gh: CiGhPort;
  readonly #send: (sessionId: string, text: string) => Promise<void>;
  readonly #notices: CiNotices;
  readonly #cleanup: ((worktreeId: string) => Promise<void>) | null;
  readonly #now: () => number;
  readonly #pollMs: number | null;
  readonly #onError: (error: unknown) => void;
  /** One check per worktree at a time. */
  readonly #running = new Map<string, Promise<void>>();
  /** `${repoPath}\0${branch}` → the last reading and when. */
  readonly #cache = new Map<string, { readonly at: number; readonly result: PrViewResult }>();
  /** Worktree → when a turn's end last asked gh whether it has a PR. */
  readonly #discovered = new Map<string, number>();
  /** Worktree without a watch row → when it was last read (a PR D30 saw that gh cannot read now is not asked every tick). */
  readonly #tried = new Map<string, number>();
  /** Session → whether its last status was a running turn. */
  readonly #turns = new Map<string, boolean>();
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<void> | null = null;
  #unsubscribe: (() => void) | null = null;
  #closed = false;

  constructor(options: PrWatcherOptions) {
    this.#store = options.store;
    this.#bus = options.bus ?? null;
    this.#gh = options.gh;
    this.#send = options.send;
    this.#notices = options.notices;
    this.#cleanup = options.cleanup ?? null;
    this.#now = options.now ?? Date.now;
    this.#pollMs = options.pollMs ?? null;
    this.#onError = options.onError ?? ((error) => console.error('switchboard ci:', error));
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Reads the due PRs now and every `intervalMs`, and checks a session's worktrees for a new PR when its turn ends. */
  start(options: { readonly intervalMs?: number; readonly initialDelayMs?: number } = {}): void {
    if (this.#closed || this.#timer !== undefined || this.#unsubscribe) return;
    const interval = options.intervalMs ?? DEFAULT_CI_TICK_MS;
    this.#unsubscribe =
      this.#bus?.subscribe((message) => {
        if (message.name !== 'sessionUpdated') return;
        const running = message.payload.status === 'run';
        const before = this.#turns.get(message.payload.id) ?? false;
        this.#turns.set(message.payload.id, running);
        if (before && !running) void this.discover(message.payload.id).catch(this.#onError);
      }) ?? null;
    const tick = async (): Promise<void> => {
      this.#timer = undefined;
      if (this.#closed) return;
      try {
        await this.tick();
      } catch (error) {
        this.#onError(error);
      }
      if (!this.#closed) {
        this.#timer = setTimeout(() => void tick(), interval);
        this.#timer.unref();
      }
    };
    this.#timer = setTimeout(() => void tick(), options.initialDelayMs ?? 20_000);
    this.#timer.unref();
  }

  /** Stops the timer and the listener and waits for the checks in flight. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.idle();
  }

  /** Resolves once the tick and the checks in flight are done (tests). */
  async idle(): Promise<void> {
    await this.#ticking?.catch(() => undefined);
    await Promise.all([...this.#running.values()].map((running) => running.catch(() => undefined)));
  }

  // ── reading ─────────────────────────────────────────────────────────────

  /**
   * One tick: every live worktree with an open PR whose next read is due (a PR D30's poll
   * found that has no watch row yet is due at once). Concurrent calls share one run.
   */
  tick(): Promise<void> {
    this.#ticking ??= (async () => {
      try {
        const now = this.#now();
        const idleMs = this.#pollMs ?? (await ciSettingsOf(this.#store.settings))['ci.idlePollMinutes'] * 60_000;
        const rows = new Map((await this.#store.prWatch.list()).map((row) => [row.worktreeId, row]));
        for (const worktree of await this.#store.worktrees.list()) {
          if (worktree.sessionId === null) continue;
          const row = rows.get(worktree.id);
          const open = row ? row.prState === 'OPEN' : worktree.prState === 'OPEN';
          if (!open) continue;
          if (row && row.nextAt !== null && Date.parse(row.nextAt) > now) continue;
          if (!row && now - (this.#tried.get(worktree.id) ?? -Infinity) < idleMs) continue;
          await this.check(worktree.id);
        }
      } finally {
        this.#ticking = null;
      }
    })();
    return this.#ticking;
  }

  /**
   * D109: at the end of a session's turn, asks gh about its worktrees that have no open PR
   * known yet (at most every 2 minutes each): the agent may just have opened one.
   */
  async discover(sessionId: string): Promise<void> {
    if (this.#closed) return;
    const now = this.#now();
    for (const worktree of await this.#store.worktrees.list({ sessionId })) {
      const row = await this.#store.prWatch.get(worktree.id);
      if (row?.prState === 'OPEN' || worktree.prState === 'OPEN') continue;
      if (now - (this.#discovered.get(worktree.id) ?? 0) < DISCOVER_EVERY_MS) continue;
      this.#discovered.set(worktree.id, now);
      await this.check(worktree.id);
    }
  }

  /** Reads the worktree's PR now (Plans' Open PR, a test, Try again). */
  async watchSoon(worktreeId: string): Promise<void> {
    await this.check(worktreeId);
  }

  /**
   * The PR of `branch` in the repository at `repoPath`, through the shared reading (fresh for
   * {@link PR_READ_TTL_MS}): Plans' scheduler reads its items' checks here.
   */
  async read(repoPath: string, branch: string, cwd: string = repoPath): Promise<PrViewResult> {
    const key = `${repoPath}\0${branch}`;
    const cached = this.#cache.get(key);
    if (cached && this.#now() - cached.at < PR_READ_TTL_MS) return cached.result;
    const result = await this.#gh.viewPr(cwd, branch);
    if (result.kind !== 'error') this.#cache.set(key, { at: this.#now(), result });
    return result;
  }

  /** `GET /api/sessions/{id}/ci`: the session's watched PRs, newest first. */
  async status(sessionId: string): Promise<SessionCi> {
    const settings = await ciSettingsOf(this.#store.settings);
    const prs: SessionPr[] = [];
    for (const row of await this.#store.prWatch.forSession(sessionId)) {
      const worktree = await this.#store.worktrees.get(row.worktreeId);
      if (!worktree) continue;
      prs.push(toSessionPr(row, worktree, settings['ci.maxAttempts']));
    }
    return { prs };
  }

  /** Reads one worktree's PR and acts on it (one at a time per worktree). */
  check(worktreeId: string): Promise<void> {
    const before = this.#running.get(worktreeId) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(() => this.#check(worktreeId));
    const settled = next.catch((error: unknown) => this.#onError(error));
    this.#running.set(worktreeId, settled);
    void settled.finally(() => {
      if (this.#running.get(worktreeId) === settled) this.#running.delete(worktreeId);
    });
    return next;
  }

  async #check(worktreeId: string): Promise<void> {
    if (this.#closed) return;
    const worktree = await this.#store.worktrees.get(worktreeId);
    if (!worktree || worktree.removedAt !== null) return;
    const cwd = (await isDirectory(worktree.path)) ? worktree.path : worktree.repoPath;
    const settings = await ciSettingsOf(this.#store.settings);
    const result = await this.#gh.viewPr(cwd, worktree.branch);
    const now = this.#now();
    this.#tried.set(worktreeId, now);
    const previous = await this.#store.prWatch.get(worktreeId);
    if (result.kind !== 'pr') {
      // gh failed (offline, signed out) or no PR (yet): try again at the idle interval.
      if (previous && previous.prState === 'OPEN') await this.#store.prWatch.update(worktreeId, { nextAt: new Date(now + settings['ci.idlePollMinutes'] * 60_000).toISOString() });
      if (result.kind === 'error' && previous) this.#onError(new Error(`PR of ${worktree.repo} ⎇ ${worktree.branch}: ${result.message}`));
      return;
    }
    const pr = result.pr;
    this.#cache.set(`${worktree.repoPath}\0${worktree.branch}`, { at: now, result });
    // Another PR for the branch (the old one closed, a new one opened): its attempts start again.
    const fresh = !previous || previous.prNumber !== pr.number;
    if (previous && fresh) await this.#notices.closeCiNotices(worktreeId, 'replaced');
    const ready = prReadyToMerge(pr);
    const minutes = pr.checks.state === 'pending' ? settings['ci.pendingPollMinutes'] : settings['ci.idlePollMinutes'];
    const waitMs = this.#pollMs ?? minutes * 60_000;
    let row = await this.#store.prWatch.upsert(worktreeId, {
      sessionId: worktree.sessionId,
      prNumber: pr.number,
      prUrl: pr.url,
      prState: pr.state,
      checks: pr.checks.state,
      summary: pr.checks.summary,
      headSha: pr.headRefOid,
      review: pr.review,
      ready,
      checkedAt: new Date(now).toISOString(),
      nextAt: pr.state === 'OPEN' ? new Date(now + waitMs).toISOString() : null,
      ...(fresh ? { attempts: 0, failureSha: null, signature: null, stopped: null } : {}),
    });
    if (pr.state !== 'OPEN') {
      // Merged or closed: the watch ends; its items close; a merged one offers the clean-up (D30).
      await this.#notices.closeCiNotices(worktreeId, pr.state === 'MERGED' ? 'merged' : 'closed');
      if (pr.state === 'MERGED' && previous?.prState !== 'MERGED' && this.#cleanup) await this.#cleanup(worktreeId).catch(this.#onError);
    } else if (pr.checks.state === 'red') {
      await this.#notices.closeCiNotices(worktreeId, 'not-ready', ['ci-ready']);
      row = await this.#onRed(worktree, row, pr, cwd, settings);
    } else {
      // Green (or running again after a push): a stop because of failures is over once it is green.
      if (pr.checks.state !== 'pending') await this.#notices.closeCiNotices(worktreeId, 'fixed', ['ci-failing']);
      if (ready) await this.#raiseReady(worktree, pr);
      else await this.#notices.closeCiNotices(worktreeId, 'not-ready', ['ci-ready']);
    }
    if (fresh || changed(previous, row)) this.#publish(worktree.sessionId);
  }

  async #onRed(worktree: WorktreeRecord, row: PrWatchRecord, pr: PrReading, cwd: string, settings: Awaited<ReturnType<typeof ciSettingsOf>>): Promise<PrWatchRecord> {
    if (!settings['ci.sendFailures'] || row.stopped !== null) return row;
    // One message per red head: a second read of the same red head sends nothing.
    if (pr.headRefOid !== null && row.failureSha === pr.headRefOid) return row;
    const session = worktree.sessionId ? await this.#store.sessions.get(worktree.sessionId) : null;
    if (!session || session.closedAt !== null) return row;
    const names = pr.failing.length > 0 ? pr.failing.map((check) => check.name) : (pr.checks.summary ?? 'failed').replace(/^failed: /, '').split(', ');
    const withLog = pr.failing.find((check) => check.runId !== null);
    const log = withLog?.runId ? await this.#gh.failedLog(cwd, withLog.runId, withLog.jobId) : null;
    const excerpt = log ? trimLogTail(log, settings['ci.logTailLines']) || null : null;
    const signature = failureSignature(names, excerpt);
    const max = settings['ci.maxAttempts'];
    let stop: CiStopReason | null = null;
    if (row.attempts >= max) stop = 'cap';
    else if (row.signature !== null && row.signature === signature) stop = 'same-failure';
    if (stop !== null) {
      const updated = (await this.#store.prWatch.update(row.worktreeId, { stopped: stop, failureSha: pr.headRefOid, signature })) ?? row;
      const tried = row.attempts === 1 ? '1 fix tried' : `${row.attempts} fixes tried`;
      const why = stop === 'cap' ? tried : `the same failure twice, ${tried}`;
      const tail = excerpt ? `\n\n${excerpt.split('\n').slice(-12).join('\n')}` : '';
      await this.#notices.ciNotice({
        kind: 'ci-failing',
        worktreeId: worktree.id,
        sessionId: worktree.sessionId,
        title: `CI keeps failing on PR #${pr.number} (${names.join(', ')}) — ${why}`,
        detail: `${worktree.repo} ⎇ ${worktree.branch}: Switchboard stopped sending the failures to the session. Open the PR or the session, or press Try again to send this one.${tail}`,
        url: pr.url,
        repo: worktree.repo,
        branch: worktree.branch,
        dedupe: `ci-failing:${worktree.id}:${pr.number}:${pr.headRefOid ?? ''}`,
      });
      return updated;
    }
    const attempt = row.attempts + 1;
    try {
      await this.#send(session.id, ciFailureMessage({ checks: names, prNumber: pr.number, branch: worktree.branch, excerpt, attempt, maxAttempts: max }));
    } catch (error) {
      // Detached, closing, …: nothing counted; the next read tries again.
      this.#onError(error);
      return row;
    }
    return (await this.#store.prWatch.update(row.worktreeId, { attempts: attempt, failureSha: pr.headRefOid, signature })) ?? row;
  }

  async #raiseReady(worktree: WorktreeRecord, pr: PrReading): Promise<void> {
    // Plans' items keep their own Merge step and Inbox item (D102): no second one.
    if (worktree.sessionId && (await ciMergeOwnedElsewhere(this.#store, worktree.sessionId))) return;
    const approval = pr.review === 'APPROVED' ? 'approved' : 'no approval required';
    await this.#notices.ciNotice({
      kind: 'ci-ready',
      worktreeId: worktree.id,
      sessionId: worktree.sessionId,
      title: `PR #${pr.number} ready to merge`,
      detail: `${worktree.repo} ⎇ ${worktree.branch} → ${pr.baseRefName ?? 'its base'}: every check is green, ${approval}. Merge PR merges it on GitHub (Settings → CI & pull requests → Merge method); nothing merges without your click.`,
      url: pr.url,
      repo: worktree.repo,
      branch: worktree.branch,
      dedupe: `ci-ready:${worktree.id}:${pr.number}:${pr.headRefOid ?? ''}`,
    });
  }

  // ── the Inbox items' actions ────────────────────────────────────────────

  /**
   * **Merge PR** (the "ready to merge" item, only on the developer's click): reads the PR
   * again, refuses unless it is still ready, merges it with the configured method (the repo's
   * default through gh when `repo`, else squash), then reads it again (merged: the items close
   * and D30's clean-up is offered). Answers `null` when merged, else why not.
   */
  async merge(worktreeId: string): Promise<string | null> {
    const worktree = await this.#store.worktrees.get(worktreeId);
    if (!worktree || worktree.removedAt !== null) return 'the worktree is no longer registered';
    const cwd = (await isDirectory(worktree.path)) ? worktree.path : worktree.repoPath;
    const current = await this.#gh.viewPr(cwd, worktree.branch);
    if (current.kind === 'none') return `${worktree.branch} has no pull request any more`;
    if (current.kind === 'error') return current.message;
    if (!prReadyToMerge(current.pr)) {
      await this.check(worktreeId);
      return notReadyReason(current.pr);
    }
    const settings = await ciSettingsOf(this.#store.settings);
    const configured = settings['ci.mergeMethod'];
    const method: GhMergeMethod = configured === 'repo' ? ((await this.#gh.defaultMergeMethod(cwd)) ?? 'squash') : configured;
    const merged = await this.#gh.mergePr(cwd, current.pr.number, method);
    if (!merged.ok) return `gh pr merge failed: ${merged.message}`;
    await this.#notices.closeCiNotices(worktreeId, 'merge-pr', ['ci-ready']);
    this.#cache.delete(`${worktree.repoPath}\0${worktree.branch}`);
    await this.check(worktreeId);
    return null;
  }

  /** **Try again** (the "CI keeps failing" item): the attempts start again and the PR is read now (a red head gets its message). */
  async tryAgain(worktreeId: string): Promise<void> {
    const row = await this.#store.prWatch.get(worktreeId);
    if (!row) return;
    await this.#store.prWatch.update(worktreeId, { attempts: 0, stopped: null, failureSha: null, signature: null, nextAt: null });
    this.#publish(row.sessionId);
    await this.check(worktreeId);
  }

  #publish(sessionId: string | null): void {
    if (sessionId && this.#bus) this.#bus.publish('ciChanged', { sessionId });
  }
}

function changed(before: PrWatchRecord | null, after: PrWatchRecord): boolean {
  if (!before) return true;
  return (
    before.prState !== after.prState ||
    before.checks !== after.checks ||
    before.ready !== after.ready ||
    before.review !== after.review ||
    before.attempts !== after.attempts ||
    before.stopped !== after.stopped ||
    before.summary !== after.summary ||
    before.prUrl !== after.prUrl
  );
}

/** A watch row as the API answers it. */
export function toSessionPr(row: PrWatchRecord, worktree: Pick<WorktreeRecord, 'repo' | 'branch'>, maxAttempts: number): SessionPr {
  return {
    worktreeId: row.worktreeId,
    repo: worktree.repo,
    branch: worktree.branch,
    number: row.prNumber,
    url: row.prUrl,
    state: row.prState,
    checks: row.checks,
    summary: row.summary,
    review: row.review,
    ready: row.ready,
    attempts: row.attempts,
    maxAttempts,
    stopped: row.stopped,
    checkedAt: row.checkedAt,
  };
}
