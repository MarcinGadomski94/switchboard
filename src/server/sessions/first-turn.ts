import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { NewSession } from '../../core/api.ts';
import { type SessionStartAnswers, firstTurnPayload, sessionStartBlock } from '../../core/first-turn.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';
import type { RepoLocation } from '../worktrees/manager.ts';

/** What {@link sessionStartAnswers} needs besides the NewSession. */
export interface FirstTurnSources {
  /** `SWITCHBOARD_WORKSPACE_ROOT` (canonicalized here). */
  readonly workspaceRoot: string | null;
  /** The worktrees created for the session (M2.2, in `solutions` order); empty without worktrees. */
  readonly worktrees: readonly WorktreeRecord[];
  /** The main checkout a solution name means (`WorktreeManager.resolveRepo`). */
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
export async function sessionStartAnswers(session: NewSession, sources: FirstTurnSources): Promise<SessionStartAnswers> {
  let root: string | null = null;
  if (sources.workspaceRoot) {
    try {
      root = await realpath(sources.workspaceRoot);
    } catch {
      root = null;
    }
  }
  const folders: string[] = [];
  for (const solution of session.solutions) {
    let folder: string | null = null;
    if (root) {
      const record = sources.worktrees.find((w) => w.repo === solution);
      let repoPath = record?.repoPath ?? null;
      if (repoPath === null) {
        try {
          repoPath = (await sources.resolveRepo(solution)).repoPath;
        } catch {
          repoPath = null;
        }
      }
      if (repoPath !== null) folder = folderUnder(root, repoPath);
    }
    folders.push(folder ?? solution.replace(/\\/g, '/'));
  }
  const worktrees = sources.worktrees.map((record) => {
    const index = session.solutions.indexOf(record.repo);
    return { folder: folders[index] ?? record.repo, path: record.path, branch: record.branch };
  });
  return { session, folders, worktrees };
}

/** The first stdin message and the answers block of a new session (see `src/core/first-turn.ts`). */
export interface FirstTurn {
  /** Task + block; `''` when the task is empty (the process starts idle). */
  readonly message: string;
  readonly block: string;
}

/** Builds the first-turn payload of a new session (M5.2). */
export async function buildFirstTurn(session: NewSession, sources: FirstTurnSources): Promise<FirstTurn> {
  const block = sessionStartBlock(await sessionStartAnswers(session, sources));
  return { message: firstTurnPayload(session.task, block), block };
}
