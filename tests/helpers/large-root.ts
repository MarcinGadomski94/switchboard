import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';

/**
 * D144: a synthetic **non-git, multi-repo root** shaped like the developer's slow
 * session (a big folder that is no repository, one declared solution that is a git
 * repo, agent-made git worktrees under the solution's `.claude/worktrees`, each with
 * its own `node_modules`, and a large sibling tree). Built in a temp folder; never
 * a real project.
 */
export interface LargeRoot {
  /** The non-git root (canonical path). */
  readonly root: string;
  /** The declared solution's name. */
  readonly solution: string;
  /** `<root>/microfrontends/<solution>`: the one git repo the session names. */
  readonly repo: string;
  /** The linked worktrees under `<repo>/.claude/worktrees/`. */
  readonly worktrees: readonly string[];
  /** How many files the builder wrote (sibling tree, node_modules, repo). */
  readonly fileCount: number;
}

/** Options of {@link makeLargeRoot}. */
export interface LargeRootOptions {
  /** Files in the sibling tree (spread over nested folders, a fake `node_modules` included). Default 20 000. */
  readonly siblingFiles?: number;
  /** Tracked files in the solution repo. Default 400. */
  readonly repoFiles?: number;
  /** Linked worktrees under `.claude/worktrees`. Default 3. */
  readonly worktrees?: number;
  /** Files in each worktree's ignored `node_modules`. Default 1 000. */
  readonly worktreeNodeModules?: number;
  /** Uncommitted changes left in the solution repo (half modified, half new). Default 5. */
  readonly changes?: number;
  /** git environment (an isolated config). */
  readonly env: NodeJS.ProcessEnv;
}

async function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<string> {
  const result = await runCommand(['git'], args, { cwd, env, timeoutMs: 120_000 });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${failureText(result)}`);
  return result.stdout.trim();
}

/** Writes `count` small files under `dir`, `perFolder` per folder, nested two levels deep. */
async function spread(dir: string, count: number, perFolder = 100): Promise<void> {
  const jobs: Array<Promise<void>> = [];
  for (let i = 0; i < count; i++) {
    const folder = path.join(dir, `d${Math.floor(i / (perFolder * 10))}`, `e${Math.floor(i / perFolder) % 10}`);
    jobs.push(
      (async () => {
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, `f${i}.txt`), `file ${i}\n`);
      })(),
    );
    if (jobs.length >= 256) await Promise.all(jobs.splice(0));
  }
  await Promise.all(jobs);
}

/** Builds the synthetic root under `parent` (see {@link LargeRoot}). */
export async function makeLargeRoot(parent: string, options: LargeRootOptions): Promise<LargeRoot> {
  const env = options.env;
  const siblingFiles = options.siblingFiles ?? 20_000;
  const repoFiles = options.repoFiles ?? 400;
  const worktreeCount = options.worktrees ?? 3;
  const worktreeNodeModules = options.worktreeNodeModules ?? 1_000;
  const changes = options.changes ?? 5;
  const solution = 'doctor-platform';
  await mkdir(path.join(parent, 'big root'), { recursive: true });
  const root = await realpath(path.join(parent, 'big root'));
  await writeFile(path.join(root, 'AGENTS.md'), '# Router\n');

  // The large sibling tree: plain folders, a fake node_modules and a hidden folder, none of them a repo.
  const siblingShare = Math.max(1, Math.floor(siblingFiles / 4));
  await spread(path.join(root, 'documents'), siblingShare);
  await spread(path.join(root, 'assets', 'node_modules'), siblingShare);
  await spread(path.join(root, 'archive', 'nested', 'deeper'), siblingShare);
  await spread(path.join(root, '.cache'), siblingFiles - 3 * siblingShare);

  // The solution: a git repo with tracked files, `.claude/worktrees` and `node_modules` ignored.
  const repo = path.join(root, 'microfrontends', solution);
  await mkdir(repo, { recursive: true });
  await git(repo, env, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n.claude/worktrees/\n');
  await spread(path.join(repo, 'src'), repoFiles);
  await git(repo, env, 'add', '-A');
  await git(repo, env, 'commit', '-q', '-m', 'init');
  const canonicalRepo = await realpath(repo);

  const worktrees: string[] = [];
  for (let i = 0; i < worktreeCount; i++) {
    const dir = path.join(canonicalRepo, '.claude', 'worktrees', `agent-${i}`);
    await mkdir(path.dirname(dir), { recursive: true });
    await git(canonicalRepo, env, 'worktree', 'add', '-q', '-b', `agent-${i}`, dir);
    await spread(path.join(dir, 'node_modules'), worktreeNodeModules);
    // A change of its own, so a worktree that were counted would show.
    await writeFile(path.join(dir, `worktree-${i}.md`), `worktree ${i}\n`);
    worktrees.push(dir);
  }

  // The uncommitted changes in the solution repo.
  for (let i = 0; i < changes; i++) {
    if (i % 2 === 0) await writeFile(path.join(canonicalRepo, 'src', 'd0', 'e0', `f${i}.txt`), `changed ${i}\n`);
    else await writeFile(path.join(canonicalRepo, `new-${i}.md`), `new ${i}\n`);
  }
  return { root, solution, repo: canonicalRepo, worktrees, fileCount: siblingFiles + repoFiles + worktreeCount * worktreeNodeModules };
}
