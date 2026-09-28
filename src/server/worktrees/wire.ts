import type { Worktree } from '../../core/api.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';

/** A worktree row as the API and the `worktreeRemovable` hub event return it. */
export function toWorktree(record: WorktreeRecord): Worktree {
  return {
    id: record.id,
    repo: record.repo,
    branch: record.branch,
    path: record.path,
    sessionId: record.sessionId,
    prNumber: record.prNumber,
    prState: record.prState,
    removable: record.removable,
  };
}
