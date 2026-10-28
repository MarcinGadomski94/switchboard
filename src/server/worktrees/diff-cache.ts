import { type DiffCount, type DiffScope, type DiffTargets, type FileDiff, type Session, offeredDiffScope } from '../../core/api.ts';
import { isRemoteId } from '../../core/peers.ts';
import type { Store } from '../db/store.ts';
import type { HubBus } from '../hub/bus.ts';
import type { DiffProvider } from '../providers.ts';

/**
 * D144 (`docs/worktrees.md` → *Diff* → *Cached counts (D144)*): the session's Diff
 * reads behind a per-session cache, so the light, often-asked answers (the tab count,
 * `SessionDetail.files`) never wait for git on a large working tree, and concurrent
 * asks run git once.
 *
 * - **Count and detail files** are answered from memory. An answer is **fresh** while
 *   the session's fingerprint (its event revision, its solutions, cwd and worktrees:
 *   {@link DiffCacheOptions.fingerprint}) is the one it was computed at and it is
 *   younger than {@link IDLE_FRESH_MS}. Otherwise one computation starts (or the one
 *   running is joined: never two per session and view), and the ask waits for it up to
 *   a short budget; past it the last answer goes back marked `stale` (with `at`, when
 *   it was computed) and the computation goes on in the background. With no answer yet
 *   the first ask waits longer ({@link FIRST_WAIT_MS}), then gets `stale` too.
 * - A slow computation is not started again right after it ended: while its answer is
 *   younger than twice its duration, a changed fingerprint only marks it `stale`.
 * - When a turn ends (`sessionUpdated` from `run` to `idle` / `done`), the views asked
 *   before are computed again in the background, so the next ask finds them ready.
 * - **The full diff and the targets** are not kept (the Diff tab reads them on its
 *   triggers and must show the files as they are): concurrent identical asks share one
 *   computation.
 */

/** An answer stays fresh this long while the session's fingerprint does not change (edits outside Switchboard show after it). */
export const IDLE_FRESH_MS = 30_000;
/** How long an ask with an earlier answer waits for its refresh before the earlier answer goes back as `stale`. */
export const REFRESH_WAIT_MS = 150;
/** How long the first ask of a view (no answer yet) waits before `{ files: 0, stale: true }`. */
export const FIRST_WAIT_MS = 1_500;
/** How long `SessionDetail.files` waits: the detail never waits for git beyond this. */
export const DETAIL_WAIT_MS = 50;
/** Sessions whose answers are kept (oldest dropped first). */
const MAX_SESSIONS = 300;


/** `SessionDetail.files` from the cache. */
export interface CachedFiles {
  readonly files: FileDiff[];
  /** The list is older than the session's latest change (a refresh runs), or none was computed yet (`files` empty). */
  readonly stale: boolean;
}

/** Options of {@link DiffCache}. */
export interface DiffCacheOptions {
  /** The provider that reads git (the WorktreeManager). */
  readonly inner: DiffProvider;
  /** A cheap value that changes whenever the session's changed files may have (its event revision, solutions, worktrees…). */
  readonly fingerprint: (sessionId: string) => Promise<string>;
  readonly now?: () => number;
  /** Budgets (tests). */
  readonly waits?: { readonly refresh?: number; readonly first?: number; readonly detail?: number; readonly idleFresh?: number };
  readonly onError?: (error: unknown) => void;
}

interface Answer<T> {
  readonly value: T;
  readonly fingerprint: string;
  /** Epoch ms the computation ended. */
  readonly at: number;
  readonly durationMs: number;
}

interface Slot<T> {
  answer: Answer<T> | null;
  running: Promise<Answer<T> | null> | null;
  /** How the view is computed (the last ask's; a turn's end computes it again). */
  compute: (() => Promise<T>) | null;
}

/** Which cached view: a count of a scope, or the detail's whole-branch files. */
type ViewKey = `count:${DiffScope}` | 'files';

/** The Diff reads of the sessions, cached and coalesced (see the module comment). */
export class DiffCache implements DiffProvider {
  readonly #inner: DiffProvider;
  readonly #fingerprint: (sessionId: string) => Promise<string>;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #refreshWait: number;
  readonly #firstWait: number;
  readonly #detailWait: number;
  readonly #idleFresh: number;
  /** session id → view → slot (most recently used session last). */
  readonly #sessions = new Map<string, Map<ViewKey, Slot<unknown>>>();
  /** Coalesced uncached reads (full diff, targets) by their arguments. */
  readonly #shared = new Map<string, Promise<unknown>>();
  readonly #status = new Map<string, Session['status']>();
  #unsubscribe: (() => void) | null = null;

  constructor(options: DiffCacheOptions) {
    this.#inner = options.inner;
    this.#fingerprint = options.fingerprint;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((error) => console.error('switchboard diff cache:', error));
    this.#refreshWait = options.waits?.refresh ?? REFRESH_WAIT_MS;
    this.#firstWait = options.waits?.first ?? FIRST_WAIT_MS;
    this.#detailWait = options.waits?.detail ?? DETAIL_WAIT_MS;
    this.#idleFresh = options.waits?.idleFresh ?? IDLE_FRESH_MS;
  }

  /** The provider behind the cache. */
  get inner(): DiffProvider {
    return this.#inner;
  }

  /** Full diff: concurrent identical asks share one computation; nothing is kept. */
  diff(sessionId: string, file?: string, scope?: DiffScope): Promise<FileDiff[]> {
    return this.#share(`diff\u0000${sessionId}\u0000${scope ?? ''}\u0000${file ?? ''}`, () => this.#inner.diff(sessionId, file, scope));
  }

  /** The working trees (the Diff tab's views): concurrent asks share one computation. */
  async targets(sessionId: string): Promise<DiffTargets> {
    const inner = this.#inner;
    if (!inner.targets) return { worktrees: [], inPlace: [] };
    return this.#share(`targets\u0000${sessionId}`, () => (inner.targets as (id: string) => Promise<DiffTargets>).call(inner, sessionId));
  }

  /** The tab count, from the cache (see the module comment). */
  async count(sessionId: string, scope: DiffScope): Promise<DiffCount> {
    const inner = this.#inner;
    const compute = async (): Promise<DiffCount> => {
      if (inner.count) return inner.count(sessionId, scope);
      const targets = inner.targets ? await inner.targets(sessionId) : { worktrees: [], inPlace: [] };
      const shown = offeredDiffScope(scope, targets);
      return { scope: shown, files: (await inner.diff(sessionId, undefined, shown)).length };
    };
    const { answer, stale } = await this.#read<DiffCount>(sessionId, `count:${scope}`, compute, this.#firstWait);
    if (answer === null) return { scope: 'head', files: 0, stale: true, at: null };
    return stale ? { ...answer.value, stale: true, at: new Date(answer.at).toISOString() } : answer.value;
  }

  /** `SessionDetail.files` (the whole branch), from the cache: never waits for git beyond a short budget. */
  async detailFiles(sessionId: string): Promise<CachedFiles> {
    const { answer, stale } = await this.#read<FileDiff[]>(sessionId, 'files', () => this.#inner.diff(sessionId), this.#detailWait, this.#detailWait);
    return { files: answer?.value ?? [], stale: answer === null || stale };
  }

  /** Marks every answer of the session as needing a refresh (the next ask starts one). */
  invalidate(sessionId: string): void {
    for (const slot of this.#sessions.get(sessionId)?.values() ?? []) if (slot.answer) slot.answer = { ...slot.answer, fingerprint: '' };
  }

  /** Forgets a session (gone). */
  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
    this.#status.delete(sessionId);
  }

  /** Refreshes the views asked before when a turn ends; returns the stop function. */
  listen(bus: HubBus): () => void {
    this.#unsubscribe?.();
    const unsubscribe = bus.subscribe((message) => {
      if (message.name !== 'sessionUpdated') return;
      const session = message.payload;
      if (isRemoteId(session.id)) return;
      const before = this.#status.get(session.id);
      this.#status.set(session.id, session.status);
      if (this.#status.size > MAX_SESSIONS * 4) this.#status.delete(this.#status.keys().next().value as string);
      if (before === 'run' && session.status !== 'run') this.#warm(session.id);
    });
    this.#unsubscribe = unsubscribe;
    return () => {
      unsubscribe();
      if (this.#unsubscribe === unsubscribe) this.#unsubscribe = null;
    };
  }

  /** Resolves once no computation runs (tests, shutdown). */
  async idle(): Promise<void> {
    for (;;) {
      const running: Array<Promise<unknown>> = [...this.#shared.values()];
      for (const views of this.#sessions.values()) for (const slot of views.values()) if (slot.running) running.push(slot.running);
      if (running.length === 0) return;
      await Promise.allSettled(running);
    }
  }

  /** Stops listening and waits for the computations in flight. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.idle();
  }

  // ── internals ─────────────────────────────────────────────────────────

  #share<T>(key: string, work: () => Promise<T>): Promise<T> {
    const known = this.#shared.get(key);
    if (known) return known as Promise<T>;
    const run = work().finally(() => {
      if (this.#shared.get(key) === run) this.#shared.delete(key);
    });
    this.#shared.set(key, run);
    return run;
  }

  #slot<T>(sessionId: string, view: ViewKey): Slot<T> {
    let views = this.#sessions.get(sessionId);
    if (views) {
      this.#sessions.delete(sessionId);
      this.#sessions.set(sessionId, views);
    } else {
      views = new Map();
      this.#sessions.set(sessionId, views);
      if (this.#sessions.size > MAX_SESSIONS) this.#sessions.delete(this.#sessions.keys().next().value as string);
    }
    let slot = views.get(view);
    if (!slot) {
      slot = { answer: null, running: null, compute: null };
      views.set(view, slot);
    }
    return slot as Slot<T>;
  }

  /** Starts the slot's computation unless one runs; the answer is stored when it ends. */
  #refresh<T>(slot: Slot<T>, fingerprint: string, compute: () => Promise<T>): Promise<Answer<T> | null> {
    if (slot.running) return slot.running;
    const started = this.#now();
    const run = (async (): Promise<Answer<T> | null> => {
      try {
        const value = await compute();
        const answer: Answer<T> = { value, fingerprint, at: this.#now(), durationMs: this.#now() - started };
        slot.answer = answer;
        return answer;
      } catch (error) {
        this.#onError(error);
        return null;
      } finally {
        slot.running = null;
      }
    })();
    slot.running = run;
    return run;
  }

  async #read<T>(sessionId: string, view: ViewKey, compute: () => Promise<T>, firstWait: number, refreshWait: number = this.#refreshWait): Promise<{ readonly answer: Answer<T> | null; readonly stale: boolean }> {
    const slot = this.#slot<T>(sessionId, view);
    slot.compute = compute;
    const fingerprint = await this.#fingerprint(sessionId);
    const known = slot.answer;
    const now = this.#now();
    if (known && known.fingerprint === fingerprint && now - known.at < this.#idleFresh) return { answer: known, stale: false };
    // A slow computation is not started again right after it ended: the answer only says it is stale.
    if (known && !slot.running && known.fingerprint !== '' && now - known.at < 2 * known.durationMs) return { answer: known, stale: true };
    const running = this.#refresh(slot, fingerprint, compute);
    const done = await within(running, known ? refreshWait : firstWait);
    if (done !== undefined && done !== null) return { answer: done, stale: done.fingerprint !== fingerprint };
    return { answer: slot.answer, stale: true };
  }

  /** A turn ended: the views asked before are computed again now (in the background). */
  #warm(sessionId: string): void {
    const views = this.#sessions.get(sessionId);
    if (!views) return;
    void (async () => {
      const fingerprint = await this.#fingerprint(sessionId);
      for (const slot of views.values()) {
        if (slot.answer === null || slot.running || slot.compute === null) continue;
        if (slot.answer.fingerprint === fingerprint) continue;
        void this.#refresh(slot, fingerprint, slot.compute);
      }
    })().catch((error: unknown) => this.#onError(error));
  }
}

/** The promise's value when it settles within `ms`, else `undefined` (it goes on). */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  if (ms <= 0) {
    // Already settled computations still answer (a microtask turn).
    return Promise.race([promise, Promise.resolve(undefined)]);
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * D144: the session's fingerprint for the cache: its event revision (D95: moves with
 * every stored event, so a tool call, a turn's end or a result changes it), its
 * solutions, folder and cwd, and its worktrees. Cheap: memory and two indexed reads.
 */
export async function diffFingerprint(store: Store, sessionId: string): Promise<string> {
  const record = await store.sessions.get(sessionId);
  const worktrees = await store.worktrees.list({ sessionId });
  return JSON.stringify([
    await store.events.revision(sessionId),
    record?.solutions ?? null,
    record?.root ?? null,
    record?.cwd ?? null,
    worktrees.map((worktree) => `${worktree.id}:${worktree.path}:${worktree.baseRef ?? ''}`),
  ]);
}
