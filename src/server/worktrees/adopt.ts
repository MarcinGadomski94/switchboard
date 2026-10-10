import type { SessionEvent } from '../../core/api.ts';
import { addsWorktree } from '../../core/derive/artifacts.ts';
import { sameSolution } from '../../core/session-solutions.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { type FolderRef, folderOfSession } from '../folders/ref.ts';
import { WorkspaceScanner } from '../solutions/scanner.ts';
import type { SupervisorEvents } from '../supervisor/supervisor.ts';
import type { AdoptionRepo, WorktreeManager } from './manager.ts';

/** Where {@link WorktreeAdoption} hears about session events and records the solutions it adopts in (the SessionSupervisor). */
export interface AdoptionSessions {
  on(name: 'event', listener: (payload: SupervisorEvents['event']) => void): () => void;
  /** Adds solutions to `Session.solutions` and publishes `sessionUpdated` (D38). */
  addSolutions(sessionId: string, solutions: readonly string[], options?: { readonly publish?: 'changed' | 'always' }): Promise<unknown>;
}

/** Options for {@link WorktreeAdoption}. */
export interface WorktreeAdoptionOptions {
  readonly store: Store;
  readonly sessions: AdoptionSessions;
  readonly worktrees: Pick<WorktreeManager, 'adopt'>;
  /**
   * The repositories of a workspace folder's solutions (default: the
   * `WorkspaceScanner`'s writable solutions that are, or hold, a git main checkout).
   */
  readonly repos?: (folder: FolderRef) => Promise<AdoptionRepo[]>;
  /** Called when an adoption fails (default: `console.error`). */
  readonly onError?: (error: unknown) => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The Bash command of a finished, successful tool event (`payload.type` `tool`,
 * name `Bash`, a `result` and no error), else `null`.
 */
export function finishedBashCommand(event: Pick<SessionEvent, 'payload'>): string | null {
  const payload = asRecord(event.payload);
  if (!payload || payload['type'] !== 'tool' || payload['name'] !== 'Bash') return null;
  if (!('result' in payload) || payload['isError'] === true) return null;
  const command = asRecord(payload['input'])?.['command'];
  return typeof command === 'string' ? command : null;
}

/** `true` for the event that ends a turn (`payload.type` `result`). */
export function isTurnEnd(event: Pick<SessionEvent, 'payload'>): boolean {
  return asRecord(event.payload)?.['type'] === 'result';
}

/** The default {@link WorktreeAdoptionOptions.repos}: every writable solution of the workspace scan with a git main checkout. */
export async function scannedRepos(folder: FolderRef): Promise<AdoptionRepo[]> {
  const scan = await new WorkspaceScanner({ root: folder.path }).scan();
  return scan.folders
    .filter((group) => group.rule !== 'read-only')
    .flatMap((group) => group.solutions.flatMap((solution) => (solution.repoPath ? [{ solution: solution.name, repoPath: solution.repoPath }] : [])));
}

/**
 * D38 (`docs/worktrees.md` → *Adopted worktrees*): a workspace session started
 * without picked solutions (Worktrees on) has its agent create a worktree per
 * solution it changes; this service registers each one as the session's
 * (`WorktreeManager.adopt`) and adds its solution to `Session.solutions`
 * (`SessionSupervisor.addSolutions`, which publishes `sessionUpdated`).
 *
 * It listens to the supervisor's `event` notifications and adopts:
 * - after a **main-agent** `Bash` whose command adds a worktree (`addsWorktree`)
 *   finished without an error;
 * - on a **sweep at each turn's end** (a `result` event) of a session with
 *   Worktrees on while one of its solutions (the ones it touched) has no worktree
 *   of the session yet.
 *
 * Workspace sessions only (a repo folder's one solution is fixed, D14). Runs
 * asynchronously, one adoption at a time per session; idempotent (a registered
 * worktree is never registered again); git is only run read-only in main
 * checkouts (`git worktree list --porcelain`, argv only).
 */
export class WorktreeAdoption {
  readonly #store: Store;
  readonly #sessions: AdoptionSessions;
  readonly #worktrees: Pick<WorktreeManager, 'adopt'>;
  readonly #repos: (folder: FolderRef) => Promise<AdoptionRepo[]>;
  readonly #onError: (error: unknown) => void;
  readonly #off: () => void;
  /** Tool events already handled (an event is published again on every update). */
  readonly #handled = new Set<number>();
  /** The main agent's id per session. */
  readonly #mainAgents = new Map<string, string>();
  /** The adoption chain per session. */
  readonly #running = new Map<string, Promise<void>>();
  #closed = false;

  constructor(options: WorktreeAdoptionOptions) {
    this.#store = options.store;
    this.#sessions = options.sessions;
    this.#worktrees = options.worktrees;
    this.#repos = options.repos ?? scannedRepos;
    this.#onError = options.onError ?? ((error) => console.error('switchboard worktree adoption:', error));
    this.#off = options.sessions.on('event', ({ sessionId, event }) => {
      void this.#onEvent(sessionId, event).catch(this.#onError);
    });
  }

  async #onEvent(sessionId: string, event: SessionEvent): Promise<void> {
    if (this.#closed) return;
    if (isTurnEnd(event)) {
      await this.sweep(sessionId);
      return;
    }
    const command = finishedBashCommand(event);
    if (command === null || this.#handled.has(event.id) || !addsWorktree(command)) return;
    this.#handled.add(event.id);
    if (event.agentId !== null && event.agentId !== (await this.#mainAgentId(sessionId))) return;
    await this.adopt(sessionId);
  }

  async #mainAgentId(sessionId: string): Promise<string | null> {
    const cached = this.#mainAgents.get(sessionId);
    if (cached) return cached;
    const main = await this.#store.agents.mainOf(sessionId);
    if (main) this.#mainAgents.set(sessionId, main.id);
    return main?.id ?? null;
  }

  /**
   * The turn-end sweep: adopts when the session (a workspace session with
   * Worktrees on) has a solution in `Session.solutions` without a worktree of its
   * own; else does nothing.
   */
  async sweep(sessionId: string): Promise<void> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session || session.rootKind !== 'workspace' || !session.worktrees || session.solutions.length === 0) return;
    const own = await this.#store.worktrees.list({ sessionId });
    if (session.solutions.every((solution) => own.some((worktree) => sameSolution(worktree.repo, solution)))) return;
    await this.adopt(sessionId);
  }

  /**
   * Adopts the session's own worktrees in the repositories of its folder's
   * solutions and adds their solutions to the session (published even when they
   * were there already). One run at a time per session.
   */
  adopt(sessionId: string): Promise<void> {
    const previous = this.#running.get(sessionId) ?? Promise.resolve();
    const run = previous.then(() => this.#adoptNow(sessionId)).catch(this.#onError);
    this.#running.set(sessionId, run);
    void run.finally(() => {
      if (this.#running.get(sessionId) === run) this.#running.delete(sessionId);
    });
    return run;
  }

  async #adoptNow(sessionId: string): Promise<void> {
    if (this.#closed) return;
    const session: SessionRecord | null = await this.#store.sessions.get(sessionId);
    if (!session || session.rootKind !== 'workspace') return;
    const folder = folderOfSession(session);
    if (!folder) return;
    const adopted = await this.#worktrees.adopt(session, await this.#repos(folder));
    if (adopted.length === 0) return;
    await this.#sessions.addSolutions(sessionId, adopted.map((worktree) => worktree.repo), { publish: 'always' });
  }

  /** Stops listening and waits for the adoptions still running. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#off();
    await Promise.all([...this.#running.values()]);
  }
}
