import type { NewSession } from '../../core/api.ts';
import { SESSION_START_KIND } from '../../core/first-turn.ts';
import { type RefusalBody, worktreeRefusal } from '../api/worktree-errors.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';
import type { ApiContext } from '../routes.ts';
import { WorktreeError } from '../worktrees/manager.ts';
import { buildFirstTurn } from './first-turn.ts';
import { validateNewSession } from './validate.ts';

/** What {@link startNewSession} needs (a subset of the route context). */
export type SessionStartContext = Pick<ApiContext, 'config' | 'store' | 'providers' | 'supervisor' | 'worktrees'>;

/** Options for {@link startNewSession}. */
export interface StartNewSessionOptions {
  /** Runs once the session is stored and its worktrees are linked, before its process starts (M7.1 links the scheduled run here). */
  readonly beforeSpawn?: (session: SessionRecord) => Promise<void>;
}

/** Result of {@link startNewSession}: the started session, or a refusal to send as it is. */
export type StartNewSessionOutcome =
  | { readonly ok: true; readonly session: NewSession; readonly record: SessionRecord }
  | { readonly ok: false; readonly status: number; readonly body: RefusalBody };

/**
 * The `POST /api/sessions` flow (M2.1 / M2.2 / M5.2 / M6.1), shared with the
 * scheduler (M7.1): validate the NewSession (422 with `{errors}`; read-only
 * solutions through the workspace scan), create its worktrees first (gap #1;
 * refusals as {@link worktreeRefusal}), build the first stdin message (M5.2: the
 * task + the confirmed answers; with no task the answers wait in the outbox) and
 * start the process. A supervisor refusal is thrown (a `SupervisorError`) after the
 * worktrees created for it are discarded again.
 */
export async function startNewSession(context: SessionStartContext, body: unknown, options: StartNewSessionOptions = {}): Promise<StartNewSessionOutcome> {
  const { store, supervisor, providers, worktrees } = context;
  const scan = providers.solutions;
  const readOnly = scan
    ? async (solution: string): Promise<boolean> => {
        // The scanner's own rule (M6.1, docs/solutions.md) resolves the name like the worktree manager does.
        if (scan.isReadOnly) return scan.isReadOnly(solution);
        const groups = await scan.solutions();
        return groups.some((group) => group.solutions.some((s) => s.name === solution && s.rule === 'read-only'));
      }
    : undefined;
  const result = await validateNewSession(body, {
    nameTaken: async (name) => (await store.sessions.getByName(name)) !== null,
    ...(readOnly ? { readOnly } : {}),
  });
  if (!result.ok) return { ok: false, status: 422, body: { error: 'invalid', errors: result.errors } };
  const input = result.value;
  // M2.2 / gap #1: the worktrees exist before the process starts and are linked to the session before its spawn.
  let created: WorktreeRecord[] = [];
  if (input.worktrees) {
    try {
      created = await worktrees.createForSession(input.name, input.solutions);
    } catch (error) {
      if (!(error instanceof WorktreeError)) throw error;
      return { ok: false, ...worktreeRefusal(error, 'solutions') };
    }
  }
  try {
    // M5.2: the task + the confirmed session-start answers are the first stdin message; with no task the
    // process starts idle and the answers wait in the outbox for the developer's first message.
    const firstTurn = await buildFirstTurn(input, {
      workspaceRoot: context.config.workspaceRoot,
      worktrees: created,
      resolveRepo: (solution) => worktrees.resolveRepo(solution),
    });
    const record = await supervisor.start(input, firstTurn.message, {
      beforeSpawn: async (session) => {
        await worktrees.assign(created, session.id);
        if (firstTurn.message === '') await store.pendingMessages.enqueue({ sessionId: session.id, kind: SESSION_START_KIND, text: firstTurn.block });
        if (options.beforeSpawn) await options.beforeSpawn(session);
      },
    });
    return { ok: true, session: input, record };
  } catch (error) {
    if (created.length > 0 && (await store.sessions.getByName(input.name)) === null) await worktrees.discard(created);
    throw error;
  }
}
