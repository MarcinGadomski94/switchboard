import path from 'node:path';
import type { HandoffBranching, SessionBranching } from '../../core/branching.ts';
import type { HandoffStack, ParentStatus, RepoBase } from '../../core/stacking.ts';
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
  /**
   * D38: the branch the agent's own worktrees get (a workspace session with
   * Worktrees on and no solutions picked): the D32 ticket branch, else
   * `session/{name}` (scheduled runs). `null` / omitted without worktrees.
   */
  readonly agentBranch?: string | null;
  /**
   * D40: the session's validated branching (`null` / omitted: none, e.g. a
   * scheduled run) and, per worktree record id, the origin branch it was cut from
   * (`null` for a repo without origin).
   */
  readonly branching?: SessionBranching | null;
  readonly cutFrom?: ReadonlyMap<string, string | null>;
  /**
   * D47: per worktree record id, the repo's resolved base / PR target (`null`
   * without origin) and the parent's status there (`null` when not stacked there).
   */
  readonly stack?: ReadonlyMap<string, { readonly base: Extract<RepoBase, { ok: true }> | null; readonly parentStatus: ParentStatus | null }>;
}

/** `repoPath` relative to `root`, `/`-separated, or `null` when it is not inside it. */
function folderUnder(root: string, repoPath: string): string | null {
  const relative = path.relative(root, repoPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/** The workspace folder a solution names (its worktree's repo, else the manager's resolution, else the name as given). */
async function folderOf(solution: string, sources: FirstTurnSources): Promise<string> {
  const record = sources.worktrees.find((w) => w.repo === solution);
  let repoPath = record?.repoPath ?? null;
  if (repoPath === null) {
    try {
      repoPath = (await sources.resolveRepo(solution)).repoPath;
    } catch {
      repoPath = null;
    }
  }
  const folder = repoPath !== null ? folderUnder(sources.folder.root, repoPath) : null;
  return folder ?? solution.replace(/\\/g, '/');
}

/**
 * D40: what the Branching lines say, or `null` when the session has none: a
 * session with Worktrees on under the ticket rule gets them when it has an epic,
 * a worktree cut from origin, per-repo choices, or no picked solutions (D38: the
 * agent cuts its own worktrees from origin). A task without an epic whose repos
 * all lack an `origin` remote gets none (nothing is cut from origin). D47: a
 * stacked session (`branching.parent`) always gets them, with the parent and each
 * repo's resolved base and PR target (none listed without an up-front worktree, D38).
 */
export async function handoffBranching(session: FirstTurnSession, sources: FirstTurnSources): Promise<HandoffBranching | null> {
  const branching = sources.branching ?? null;
  const task = session.branch ?? null;
  if (!session.worktrees || branching === null || task === null) return null;
  const from = sources.worktrees.map((record) => sources.cutFrom?.get(record.id) ?? null);
  const overridden = Object.keys(branching.bases);
  const parent = branching.parent ?? null;
  const relevant =
    parent !== null || branching.epic !== null || session.solutions.length === 0 || from.some((ref) => ref !== null) || overridden.length > 0 || branching.dropped.length > 0;
  if (!relevant) return null;
  const defaultBases = [
    ...new Set(sources.worktrees.flatMap((record, index) => (overridden.includes(record.repo) ? [] : from[index] ? [from[index] as string] : []))),
  ];
  const overrides: Array<readonly [string, string]> = [];
  for (const solution of overridden) overrides.push([await folderOf(solution, sources), branching.bases[solution] as string]);
  const dropped: string[] = [];
  for (const solution of branching.dropped) dropped.push(await folderOf(solution, sources));
  let stack: HandoffStack | null = null;
  if (parent !== null) {
    const repos = session.solutions.flatMap((solution) => {
      const record = sources.worktrees.find((w) => w.repo === solution);
      if (!record) return [];
      const info = sources.stack?.get(record.id);
      return [{ solution, base: info?.base ?? null, status: info?.parentStatus ?? null }];
    });
    stack = { parent, repos };
  }
  return {
    task,
    epic: branching.epic ? { key: branching.epic.key, branch: branching.epic.branch } : null,
    base: branching.base,
    defaultBases,
    overrides,
    dropped,
    ...(stack !== null ? { stack } : {}),
  };
}

/**
 * Resolves what the first-turn answers block names (M5.2): each solution's
 * workspace folder (from its worktree record, else the worktree manager's
 * resolution; the name as given when neither works, e.g. a folder that is not a
 * git repository) and the worktrees' absolute paths and branches. D40: the
 * branch each worktree was cut from and the Branching lines' input.
 */
export async function sessionStartAnswers(session: FirstTurnSession, sources: FirstTurnSources): Promise<SessionStartAnswers> {
  const folders: string[] = [];
  for (const solution of session.solutions) folders.push(await folderOf(solution, sources));
  const worktrees = sources.worktrees.map((record) => {
    const index = session.solutions.indexOf(record.repo);
    const from = sources.cutFrom?.get(record.id) ?? null;
    return { folder: folders[index] ?? record.repo, path: record.path, branch: record.branch, ...(from !== null ? { from } : {}) };
  });
  return { session, folders, worktrees, agentBranch: sources.agentBranch ?? null, branching: await handoffBranching(session, sources) };
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
 * only the worktree note when it runs in a worktree (no router answers). D56: a
 * simple start in a workspace gets no block (the task alone; the agent asks the
 * router's session-start questions itself); in a repo folder it is as above.
 */
export async function buildFirstTurn(session: FirstTurnSession & { readonly task: string }, sources: FirstTurnSources): Promise<FirstTurn> {
  let block = '';
  if (sources.folder.kind === 'workspace') {
    if (!session.simple) block = sessionStartBlock(await sessionStartAnswers(session, sources));
  } else {
    const worktree = sources.worktrees[0];
    if (worktree) {
      block = repoWorktreeNote({
        path: worktree.path,
        branch: worktree.branch,
        base: worktree.baseRef ?? 'HEAD',
        repoPath: worktree.repoPath,
        branching: await handoffBranching(session, sources),
      });
    }
  }
  return { message: firstTurnPayload(session.task, block), block };
}
