import path from 'node:path';
import { type FirstTurnSession, type SessionStartAnswers, firstTurnPayload, repoWorktreeNote, sessionStartBlock } from '../../core/first-turn.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';
import type { FolderRef } from '../folders/ref.ts';
import type { RepoLocation } from '../worktrees/manager.ts';

/** What {@link sessionStartAnswers} needs besides the NewSession. */
export interface FirstTurnSources {
  /** The session's folder (D14): a workspace gets the answers block, a repo only the worktree note. */
  readonly folder: FolderRef;
  /** The worktrees created for the session (M2.2, in `solutions` order); empty without worktrees. */
  readonly worktrees: readonly WorktreeRecord[];
  /** The main checkout a solution name means in the session's folder (`WorktreeManager.resolveRepo`). */
  readonly resolveRepo: (solution: string) => Promise<RepoLocation>;
}

/** `repoPath` relative to `root`, `/`-separated, or `null` when it is not inside it. */
function folderUnder(root: string, repoPath: string): string | null {
  const relative = path.relative(root, repoPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/**
 * Resolves what the first-turn answers block names (M5.2): each solution's
 * workspace folder (from its worktree record, else the worktree manager's
 * resolution; the name as given when neither works, e.g. a folder that is not a
 * git repository) and the worktrees' absolute paths and branches.
 */
export async function sessionStartAnswers(session: FirstTurnSession, sources: FirstTurnSources): Promise<SessionStartAnswers> {
  const root = sources.folder.root;
  const folders: string[] = [];
  for (const solution of session.solutions) {
    const record = sources.worktrees.find((w) => w.repo === solution);
    let repoPath = record?.repoPath ?? null;
    if (repoPath === null) {
      try {
        repoPath = (await sources.resolveRepo(solution)).repoPath;
      } catch {
        repoPath = null;
      }
    }
    const folder = repoPath !== null ? folderUnder(root, repoPath) : null;
    folders.push(folder ?? solution.replace(/\\/g, '/'));
  }
  const worktrees = sources.worktrees.map((record) => {
    const index = session.solutions.indexOf(record.repo);
    return { folder: folders[index] ?? record.repo, path: record.path, branch: record.branch };
  });
  return { session, folders, worktrees };
}

/** The first stdin message and the block appended to the task (see `src/core/first-turn.ts`). */
export interface FirstTurn {
  /** Task + block; `''` when the task is empty (the process starts idle). */
  readonly message: string;
  /** What waits in the outbox when the task is empty; `''` = nothing (a repo folder without a worktree). */
  readonly block: string;
}

/**
 * Builds the first-turn payload of a new session (M5.2; D14): a workspace
 * folder's session gets the session-start answers block, a repo folder's session
 * only the worktree note when it runs in a worktree (no router answers).
 */
export async function buildFirstTurn(session: FirstTurnSession & { readonly task: string }, sources: FirstTurnSources): Promise<FirstTurn> {
  let block = '';
  if (sources.folder.kind === 'workspace') {
    block = sessionStartBlock(await sessionStartAnswers(session, sources));
  } else {
    const worktree = sources.worktrees[0];
    if (worktree) block = repoWorktreeNote({ path: worktree.path, branch: worktree.branch, base: worktree.baseRef ?? 'HEAD', repoPath: worktree.repoPath });
  }
  return { message: firstTurnPayload(session.task, block), block };
}
