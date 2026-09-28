import type { FastifyReply } from 'fastify';
import { WorktreeError, type WorktreeErrorCode } from '../worktrees/manager.ts';

/** HTTP status of each worktree manager refusal (M2.2, `docs/worktrees.md`). */
export const WORKTREE_ERROR_STATUS: Record<WorktreeErrorCode, number> = {
  'workspace-not-configured': 409,
  'workspace-missing': 409,
  'solution-not-found': 422,
  'solution-ambiguous': 422,
  'read-only': 422,
  'no-commits': 409,
  'branch-exists': 409,
  'path-exists': 409,
  'session-not-found': 404,
  detached: 409,
  'not-found': 404,
  removed: 409,
  uncommitted: 409,
  unpushed: 409,
  'git-failed': 409,
};

/**
 * Sends a worktree refusal: a 422 as the usual validation body
 * `{ error: "invalid", errors: [{ field, message }] }` (`field` names the request
 * field that picked the solution), anything else as `{ error: <code>, message }`.
 * Rethrows anything that is not a {@link WorktreeError}.
 */
export function sendWorktreeError(reply: FastifyReply, error: unknown, field: string): FastifyReply {
  if (!(error instanceof WorktreeError)) throw error;
  const refusal = worktreeRefusal(error, field);
  return reply.code(refusal.status).send(refusal.body);
}

/** A worktree refusal as an HTTP status + body (the shapes of {@link sendWorktreeError}; M7.1 also records it on a failed scheduled run). */
export function worktreeRefusal(error: WorktreeError, field: string): { readonly status: number; readonly body: RefusalBody } {
  const status = WORKTREE_ERROR_STATUS[error.code];
  if (status === 422) return { status, body: { error: 'invalid', errors: [{ field, message: error.message }] } };
  return { status, body: { error: error.code, message: error.message } };
}

/** A refusal body: `{ error: "invalid", errors }` for a 422, else `{ error: <code>, message }`. */
export interface RefusalBody {
  readonly error: string;
  readonly message?: string;
  readonly errors?: ReadonlyArray<{ readonly field: string; readonly message: string }>;
}
