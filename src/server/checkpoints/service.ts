import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  CHECKPOINT_FILES_SHOWN,
  CHECKPOINT_NOTE_KIND,
  CHECKPOINT_PRUNE_INTERVAL_MS,
  type CheckpointHeadPlan,
  type CheckpointPlan,
  type CheckpointRepoPlan,
  type CheckpointTurn,
  type SessionCheckpoints,
  checkpointRef,
  firstLineOf,
  prunableGroups,
  redoDivider,
  redoNote,
  revertDivider,
  revertNote,
  safetyRef,
} from '../../core/checkpoints.ts';
import type { LifecyclePayload, UserPayload } from '../../core/event-payload.ts';
import type { CheckpointKind, CheckpointRecord } from '../db/repos/checkpoints.ts';
import type { EventRecord } from '../db/repos/events.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import type { HubBus } from '../hub/bus.ts';
import { CheckpointGit, type TreeSnapshot } from './git.ts';

/** Why a revert / Redo was refused (the API's `{ error, message }`). */
export type CheckpointErrorCode = 'not-found' | 'no-checkpoint' | 'turn-running' | 'hooked-unavailable' | 'files-only-needed' | 'nothing-to-redo' | 'revert-failed';

/** A refusal of the checkpoint service. */
export class CheckpointError extends Error {
  override name = 'CheckpointError';
  readonly code: CheckpointErrorCode;
  readonly status: number;
  /** `files-only-needed`: the preview, so the dialog can offer *Revert files only*. */
  readonly plan: CheckpointPlan | null;

  constructor(code: CheckpointErrorCode, message: string, plan: CheckpointPlan | null = null) {
    super(message);
    this.code = code;
    this.plan = plan;
    this.status = code === 'not-found' || code === 'no-checkpoint' ? 404 : code === 'revert-failed' ? 500 : 409;
  }

  body(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...(this.plan ? { plan: this.plan } : {}) };
  }
}

/** What the service needs of the supervisor. */
export interface CheckpointSessions {
  /** A turn of the session runs now (or its process is taking a message up). */
  turnRunning(sessionId: string): boolean;
  /** Writes a lifecycle event (the chat's divider) and publishes it; answers the event. */
  recordServiceEvent(sessionId: string, kind: 'text' | 'error', label: string, payload: LifecyclePayload): Promise<EventRecord | void>;
}

/** A capture taken before a turn, waiting for its user message's event (then it gets its refs and rows). */
export interface PendingCapture {
  readonly sessionId: string;
  readonly groupId: string;
  readonly items: ReadonlyArray<{ readonly snapshot: TreeSnapshot; readonly sha: string }>;
}

/** Options of {@link CheckpointService}. */
export interface CheckpointServiceOptions {
  readonly store: Store;
  readonly sessions: CheckpointSessions;
  /** Settings → Sessions → *Save a checkpoint before each turn* (read at every turn). */
  readonly enabled: () => Promise<boolean>;
  /**
   * The folders a session writes to besides its cwd (its worktrees, its solutions in place);
   * default: its worktrees. Each is reduced to its working tree's top level (duplicates go).
   */
  readonly foldersOf?: (session: SessionRecord) => Promise<readonly string[]>;
  /** `/hub`: a closed session's checkpoints are pruned at once. */
  readonly bus?: HubBus;
  readonly git?: CheckpointGit;
  readonly env?: NodeJS.ProcessEnv;
  /** Epoch ms (tests pass a fake clock). */
  readonly now?: () => number;
  readonly pruneIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** Why a session gets no checkpoints, as the turn action says it. */
export const UNSUPPORTED = {
  hooked: 'Terminal sessions have no checkpoints: their prompts reach Switchboard only after the terminal started the turn, so a snapshot would not be "before" it.',
  notGit: "This session's folder is not a git repository, so Switchboard takes no checkpoints of it.",
  off: 'Checkpoints are off (Settings → Sessions → Save a checkpoint before each turn).',
} as const;

/**
 * D80 · Undo a turn (`docs/undo.md`). Before each turn of a supervised session
 * ({@link capture} + {@link record}, called by the supervisor around the user
 * message), every git working tree the session uses is snapshotted into a hidden
 * ref; {@link revert} brings a working tree back to before any earlier turn (its
 * files, and its branch when the agent committed and nothing is pushed), after a
 * safety capture of the current state, which {@link redo} restores. The chat gets
 * a divider and the agent a note with its next message; the conversation itself
 * stays. Retention: {@link prune} (hourly, and when a session is closed).
 */
export class CheckpointService {
  readonly #store: Store;
  readonly #sessions: CheckpointSessions;
  readonly #enabled: () => Promise<boolean>;
  readonly #foldersOf: (session: SessionRecord) => Promise<readonly string[]>;
  readonly #git: CheckpointGit;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #bus: HubBus | null;
  readonly #pruneIntervalMs: number;
  /** One capture / revert / Redo at a time per session. */
  readonly #locks = new Map<string, Promise<unknown>>();
  /** The last capture problem per session (shown as the action's reason when a turn has no checkpoint). */
  readonly #problems = new Map<string, string>();
  #timer: NodeJS.Timeout | null = null;
  #unsubscribe: (() => void) | null = null;
  #pruning: Promise<number> | null = null;

  constructor(options: CheckpointServiceOptions) {
    this.#store = options.store;
    this.#sessions = options.sessions;
    this.#enabled = options.enabled;
    this.#git = options.git ?? new CheckpointGit(options.env ? { env: options.env } : {});
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((error) => console.error('switchboard checkpoints:', error));
    this.#bus = options.bus ?? null;
    this.#pruneIntervalMs = options.pruneIntervalMs ?? CHECKPOINT_PRUNE_INTERVAL_MS;
    this.#foldersOf = options.foldersOf ?? (async (session) => (await this.#store.worktrees.list({ sessionId: session.id })).map((worktree) => worktree.path));
  }

  /** Starts the hourly retention and the prune of closed sessions. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.prune().catch((error: unknown) => this.#onError(error)), this.#pruneIntervalMs);
    this.#timer.unref();
    this.#unsubscribe =
      this.#bus?.subscribe((message) => {
        if (message.name === 'sessionUpdated' && message.payload.closedAt != null && !message.payload.id.includes('~')) {
          void this.dropSession(message.payload.id).catch((error: unknown) => this.#onError(error));
        }
      }) ?? null;
    void this.prune().catch((error: unknown) => this.#onError(error));
  }

  /** Stops the timer; waits for a prune in flight. */
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.#pruning?.catch(() => undefined);
    await Promise.all([...this.#locks.values()].map((lock) => lock.catch(() => undefined)));
  }

  /** Runs `work` alone for the session (captures, reverts and Redo never interleave). */
  async #exclusive<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    this.#locks.set(sessionId, run);
    try {
      return await run;
    } finally {
      if (this.#locks.get(sessionId) === run) this.#locks.delete(sessionId);
    }
  }

  // ── before a turn ───────────────────────────────────────────────────

  /** The top-level folders of the git working trees the session uses (its cwd's first), without duplicates. */
  async treesOf(session: SessionRecord): Promise<string[]> {
    const tops: string[] = [];
    for (const dir of [...(session.cwd ? [session.cwd] : []), ...(await this.#foldersOf(session))]) {
      const top = await this.#git.toplevel(dir).catch(() => null);
      if (top !== null && !tops.includes(top)) tops.push(top);
    }
    return tops;
  }

  /**
   * Snapshots the session's working trees before its next user message goes to the
   * process (setting on, not a hooked session, git working trees only). The commits
   * are made now; the refs and rows once the message's event exists ({@link record}).
   * An unchanged tree (same tree and HEAD as the newest checkpoint there) reuses that
   * commit. Never throws: a failure is remembered as the session's problem.
   */
  async capture(sessionId: string): Promise<PendingCapture | null> {
    try {
      if (!(await this.#enabled())) return null;
      const session = await this.#store.sessions.get(sessionId);
      if (!session || session.hooked) return null;
      return await this.#exclusive(sessionId, async () => {
        const items: Array<{ snapshot: TreeSnapshot; sha: string }> = [];
        for (const top of await this.treesOf(session)) {
          try {
            const snapshot = await this.#git.snapshot(top);
            items.push({ snapshot, sha: await this.#commitOf(sessionId, snapshot, `Switchboard checkpoint before a turn of session ${sessionId}`) });
          } catch (error) {
            this.#problems.set(sessionId, `The last checkpoint of ${path.basename(top)} failed: ${error instanceof Error ? error.message : String(error)}`);
            this.#onError(error);
          }
        }
        return items.length > 0 ? { sessionId, groupId: randomUUID(), items } : null;
      });
    } catch (error) {
      this.#onError(error);
      return null;
    }
  }

  /** The commit of a snapshot: the newest checkpoint's when nothing changed there (tree and HEAD), else a new one. */
  async #commitOf(sessionId: string, snapshot: TreeSnapshot, message: string): Promise<string> {
    const newest = await this.#store.checkpoints.latestIn(sessionId, snapshot.top);
    if (newest && newest.tree === snapshot.tree && newest.head === snapshot.head && (await this.#git.hasCommit(snapshot.top, newest.commitSha))) return newest.commitSha;
    return this.#git.commit(snapshot, message);
  }

  /** Gives a capture its refs (`refs/switchboard/checkpoints/<session>/<turn>`) and rows, once its message's event is written. */
  async record(capture: PendingCapture, eventId: number): Promise<void> {
    try {
      await this.#exclusive(capture.sessionId, async () => {
        const turn = await this.#store.events.countUserMessages(capture.sessionId, eventId);
        if (turn < 1) return;
        // A turn number seen before (a message withdrawn and resent): its old rows give way.
        for (const old of await this.#store.checkpoints.turn(capture.sessionId, turn)) await this.#deleteRow(old);
        await this.#write(capture.sessionId, 'turn', turn, eventId, capture.groupId, capture.items, (n) => checkpointRef(capture.sessionId, turn, n));
        this.#problems.delete(capture.sessionId);
      });
    } catch (error) {
      this.#problems.set(capture.sessionId, `The last checkpoint could not be stored: ${error instanceof Error ? error.message : String(error)}`);
      this.#onError(error);
    }
  }

  /** Writes the refs (a suffix for a second working tree of one repo) and the rows of a group. */
  async #write(
    sessionId: string,
    kind: CheckpointKind,
    turn: number,
    eventId: number | null,
    groupId: string,
    items: PendingCapture['items'],
    refName: (suffix: number) => string,
  ): Promise<CheckpointRecord[]> {
    const used = new Map<string, number>();
    const rows: CheckpointRecord[] = [];
    for (const { snapshot, sha } of items) {
      const suffix = (used.get(snapshot.commonDir) ?? 0) + 1;
      used.set(snapshot.commonDir, suffix);
      const ref = refName(suffix);
      await this.#git.setRef(snapshot.top, ref, sha);
      rows.push(
        await this.#store.checkpoints.create({
          sessionId,
          kind,
          turnSeq: turn,
          eventId,
          groupId,
          repoPath: snapshot.top,
          ref,
          commitSha: sha,
          tree: snapshot.tree,
          indexTree: snapshot.indexTree,
          head: snapshot.head,
          branch: snapshot.branch,
          createdAt: new Date(this.#now()).toISOString(),
        }),
      );
    }
    return rows;
  }

  // ── reads ───────────────────────────────────────────────────────────

  /** Why the session gets no checkpoints (`null` = it does). */
  async #unsupported(session: SessionRecord, enabled: boolean): Promise<string | null> {
    if (session.hooked) return UNSUPPORTED.hooked;
    if (!enabled) return UNSUPPORTED.off;
    if ((await this.treesOf(session)).length === 0) return UNSUPPORTED.notGit;
    return null;
  }

  /** `GET /api/sessions/{id}/checkpoints`. */
  async list(sessionId: string): Promise<SessionCheckpoints> {
    const session = await this.#session(sessionId);
    const enabled = await this.#enabled();
    const rows = await this.#store.checkpoints.listOf(sessionId, 'turn');
    const turns = new Map<number, CheckpointTurn & { repos: string[] }>();
    for (const row of rows) {
      const existing = turns.get(row.turnSeq);
      if (existing) existing.repos.push(row.repoPath);
      else turns.set(row.turnSeq, { turn: row.turnSeq, eventId: row.eventId, createdAt: row.createdAt, repos: [row.repoPath], firstLine: await this.#firstLine(row.eventId) });
    }
    return {
      enabled,
      unsupported: (await this.#unsupported(session, enabled)) ?? (this.#problems.get(sessionId) && rows.length === 0 ? (this.#problems.get(sessionId) as string) : null),
      turns: [...turns.values()].sort((a, b) => a.turn - b.turn),
      latestTurn: await this.#store.events.countUserMessages(sessionId),
      running: this.#running(session),
      redo: await this.#redoable(sessionId),
    };
  }

  /** The newest revert, when it can still be undone: no Redo of it yet and no user message since. */
  async #redoable(sessionId: string): Promise<{ turn: number; eventId: number | null } | null> {
    const safety = await this.#store.checkpoints.latestSafety(sessionId);
    const first = safety[0];
    if (!first || first.kind !== 'before-revert' || first.eventId === null) return null;
    const since = await this.#store.events.countUserMessages(sessionId);
    const before = await this.#store.events.countUserMessages(sessionId, first.eventId);
    return since === before ? { turn: first.turnSeq, eventId: first.eventId } : null;
  }

  /** The confirm dialog (`GET /api/sessions/{id}/checkpoints/{turn}`): the files that change, what happens to the branch. */
  async preview(sessionId: string, turn: number): Promise<CheckpointPlan> {
    const session = await this.#session(sessionId);
    if (session.hooked) throw new CheckpointError('hooked-unavailable', UNSUPPORTED.hooked);
    const rows = await this.#store.checkpoints.turn(sessionId, turn);
    if (rows.length === 0) throw new CheckpointError('no-checkpoint', `Turn ${turn} has no checkpoint (it was taken before checkpoints were on, or it was pruned)`);
    return this.#exclusive(sessionId, async () => (await this.#plan(sessionId, turn, rows, 'revert')).plan);
  }

  // ── revert and Redo ─────────────────────────────────────────────────

  /**
   * Reverts the session's working trees to before turn `turn` (developer ruling):
   * refused while a turn runs; the branch goes back only when it can (else 409
   * `files-only-needed`, unless `filesOnly`); a safety capture of the current state
   * comes first (Redo); the chat gets the divider and the agent a note with its next
   * message.
   */
  async revert(sessionId: string, turn: number, options: { readonly filesOnly?: boolean } = {}): Promise<CheckpointPlan> {
    const session = await this.#session(sessionId);
    if (session.hooked) throw new CheckpointError('hooked-unavailable', UNSUPPORTED.hooked);
    const rows = await this.#store.checkpoints.turn(sessionId, turn);
    if (rows.length === 0) throw new CheckpointError('no-checkpoint', `Turn ${turn} has no checkpoint (it was taken before checkpoints were on, or it was pruned)`);
    return this.#exclusive(sessionId, async () => {
      this.#assertIdle(await this.#session(sessionId));
      const { plan, current } = await this.#plan(sessionId, turn, rows, 'revert');
      if (plan.filesOnlyReason !== null && !options.filesOnly) throw new CheckpointError('files-only-needed', plan.filesOnlyReason, plan);
      const filesOnly = plan.filesOnlyReason !== null || options.filesOnly === true;
      const groupId = await this.#safety(sessionId, 'before-revert', turn, current);
      await this.#apply(rows, current, plan, filesOnly, `switchboard: revert to before turn ${turn}`);
      const latest = await this.#store.events.countUserMessages(sessionId);
      const event = await this.#sessions.recordServiceEvent(sessionId, 'text', revertDivider(turn), { type: 'lifecycle', action: 'reverted', turn, latestTurn: latest, filesOnly });
      if (event) await this.#store.checkpoints.setGroupEvent(groupId, event.id);
      await this.#store.pendingMessages.enqueue({ sessionId, kind: CHECKPOINT_NOTE_KIND, text: revertNote(turn, plan.firstLine, latest) });
      return { ...plan, filesOnly };
    });
  }

  /** Undoes the newest revert (its safety capture): the files, and the branch forward again when it can. */
  async redo(sessionId: string): Promise<CheckpointPlan> {
    const session = await this.#session(sessionId);
    if (session.hooked) throw new CheckpointError('hooked-unavailable', UNSUPPORTED.hooked);
    return this.#exclusive(sessionId, async () => {
      this.#assertIdle(await this.#session(sessionId));
      const redoable = await this.#redoable(sessionId);
      const rows = await this.#store.checkpoints.latestSafety(sessionId);
      if (!redoable || rows.length === 0) throw new CheckpointError('nothing-to-redo', 'There is no revert to undo (a message was sent since, or it was already undone)');
      const { plan, current } = await this.#plan(sessionId, redoable.turn, rows, 'redo');
      const filesOnly = plan.filesOnlyReason !== null;
      await this.#safety(sessionId, 'before-redo', redoable.turn, current);
      await this.#apply(rows, current, plan, filesOnly, `switchboard: undo the revert to before turn ${redoable.turn}`);
      const latest = await this.#store.events.countUserMessages(sessionId);
      await this.#sessions.recordServiceEvent(sessionId, 'text', redoDivider(redoable.turn), { type: 'lifecycle', action: 'revert-undone', turn: redoable.turn, latestTurn: latest, filesOnly });
      // The agent's note: the revert's own note goes when it was not delivered yet, else it hears of the Redo.
      if (!(await this.#store.pendingMessages.withdrawKind(sessionId, CHECKPOINT_NOTE_KIND))) {
        await this.#store.pendingMessages.enqueue({ sessionId, kind: CHECKPOINT_NOTE_KIND, text: redoNote(redoable.turn, latest) });
      }
      return { ...plan, filesOnly };
    });
  }

  #running(session: SessionRecord): boolean {
    return this.#sessions.turnRunning(session.id) || session.status === 'run' || session.status === 'need';
  }

  #assertIdle(session: SessionRecord): void {
    if (this.#running(session)) throw new CheckpointError('turn-running', 'A turn is running: stop it first, then revert');
  }

  async #session(sessionId: string): Promise<SessionRecord> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) throw new CheckpointError('not-found', `no session ${sessionId}`);
    return session;
  }

  async #firstLine(eventId: number | null): Promise<string> {
    if (eventId === null) return '';
    const event = await this.#store.events.get(eventId);
    const payload = event?.payload as Partial<UserPayload> | null | undefined;
    return firstLineOf(typeof payload?.text === 'string' ? payload.text : (event?.label ?? ''));
  }

  /** The plan of restoring `rows` (one per working tree): today's state of each, its file changes and the branch move. */
  async #plan(sessionId: string, turn: number, rows: readonly CheckpointRecord[], mode: 'revert' | 'redo'): Promise<{ plan: CheckpointPlan; current: TreeSnapshot[] }> {
    const repos: CheckpointRepoPlan[] = [];
    const current: TreeSnapshot[] = [];
    const reasons: string[] = [];
    for (const row of rows) {
      let snapshot: TreeSnapshot;
      try {
        snapshot = await this.#git.snapshot(row.repoPath);
      } catch (error) {
        throw new CheckpointError('revert-failed', `${row.repoPath} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!(await this.#git.hasCommit(row.repoPath, row.commitSha))) throw new CheckpointError('no-checkpoint', `The checkpoint of ${path.basename(row.repoPath)} is gone from the repo (${row.ref})`);
      current.push(snapshot);
      const files = await this.#git.diff(row.repoPath, snapshot.tree, row.tree);
      const target = { head: row.head, branch: row.branch };
      const now = { head: snapshot.head, branch: snapshot.branch };
      const head: CheckpointHeadPlan = mode === 'revert' ? await this.#git.revertHeadPlan(row.repoPath, target, now) : await this.#git.redoHeadPlan(row.repoPath, target, now);
      if (head.action === 'refused' && head.reason) reasons.push(head.reason);
      repos.push({ path: row.repoPath, name: path.basename(row.repoPath), files: files.slice(0, CHECKPOINT_FILES_SHOWN), fileCount: files.length, head });
    }
    const firstRow = rows[0];
    const firstLine = mode === 'revert' ? await this.#firstLine(firstRow?.eventId ?? null) : await this.#firstLine((await this.#store.checkpoints.turn(sessionId, turn))[0]?.eventId ?? null);
    const plan: CheckpointPlan = {
      turn,
      firstLine,
      latestTurn: await this.#store.events.countUserMessages(sessionId),
      repos,
      filesOnlyReason: reasons.length > 0 ? `The branch cannot be moved: ${reasons.join('; ')}. Only the files can be reverted.` : null,
    };
    return { plan, current };
  }

  /** Commits the current state of each working tree as a safety group (Redo restores it); answers the group id. */
  async #safety(sessionId: string, kind: 'before-revert' | 'before-redo', turn: number, current: readonly TreeSnapshot[]): Promise<string> {
    const groupId = randomUUID();
    const items: Array<{ snapshot: TreeSnapshot; sha: string }> = [];
    for (const snapshot of current) items.push({ snapshot, sha: await this.#git.commit(snapshot, `Switchboard safety checkpoint (${kind}) of session ${sessionId}`) });
    await this.#write(sessionId, kind, turn, null, groupId, items, (n) => safetyRef(sessionId, groupId, n));
    return groupId;
  }

  /** Applies a plan: the branch first (unless files only), then the files, then the index. */
  async #apply(rows: readonly CheckpointRecord[], current: readonly TreeSnapshot[], plan: CheckpointPlan, filesOnly: boolean, reason: string): Promise<void> {
    try {
      for (const [index, row] of rows.entries()) {
        const snapshot = current[index] as TreeSnapshot;
        const repo = plan.repos[index] as CheckpointRepoPlan;
        const moved = !filesOnly && repo.head.action === 'reset' && snapshot.head !== null && row.head !== null;
        if (moved) await this.#git.moveHead(row.repoPath, row.branch, snapshot.head as string, row.head as string, reason);
        await this.#git.restoreFiles(row.repoPath, row.tree, await this.#git.diff(row.repoPath, snapshot.tree, row.tree));
        // The staged state comes back with HEAD; files only: the index matches today's HEAD (the reverted files show as changes).
        if (moved || repo.head.action === 'none') await this.#git.setIndex(row.repoPath, row.indexTree ?? row.head ?? (await this.#git.emptyTree(row.repoPath)));
        else if (snapshot.head !== null) await this.#git.setIndex(row.repoPath, snapshot.head);
      }
    } catch (error) {
      throw new CheckpointError('revert-failed', `The revert stopped part-way: ${error instanceof Error ? error.message : String(error)}. Redo brings back the state before it.`);
    }
  }

  // ── retention ───────────────────────────────────────────────────────

  /** Deletes a row and its ref (the ref first; a repo that is gone only loses the row). */
  async #deleteRow(row: CheckpointRecord): Promise<void> {
    await this.#git.deleteRef(row.repoPath, row.ref).catch(() => undefined);
    await this.#store.checkpoints.delete(row.id);
  }

  /** Deletes every checkpoint of a session (closed or deleted). */
  async dropSession(sessionId: string): Promise<void> {
    await this.#exclusive(sessionId, async () => {
      for (const row of await this.#store.checkpoints.listOf(sessionId)) await this.#deleteRow(row);
      this.#problems.delete(sessionId);
    });
  }

  /**
   * The retention (developer ruling): per session, turn checkpoints older than 7 days
   * or beyond the newest 100 turns go (whichever keeps fewer), safety captures older
   * than 7 days or beyond the newest 20; every checkpoint of a closed or deleted
   * session goes. Refs are deleted; `git gc` is left to the repo's own cycle.
   * Answers how many rows were deleted.
   */
  async prune(): Promise<number> {
    this.#pruning ??= (async () => {
      let deleted = 0;
      try {
        for (const sessionId of await this.#store.checkpoints.sessionIds()) {
          const session = await this.#store.sessions.get(sessionId);
          const rows = await this.#store.checkpoints.listOf(sessionId);
          const groups = prunableGroups(rows, this.#now(), { closed: !session || session.closedAt !== null });
          if (groups.length === 0) continue;
          const doomed = new Set(groups);
          await this.#exclusive(sessionId, async () => {
            for (const row of rows) {
              if (!doomed.has(row.groupId)) continue;
              await this.#deleteRow(row);
              deleted += 1;
            }
          });
        }
      } finally {
        this.#pruning = null;
      }
      return deleted;
    })();
    return this.#pruning;
  }
}
