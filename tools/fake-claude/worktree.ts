import path from 'node:path';
import { resolveInside } from './scenarios.ts';
import { runGit } from './teleport.ts';

/**
 * D38 (`docs/fake-claude.md` → *Scenarios*): `[fake:worktree-add <repo> <branch> <path>]`
 * in a stdin user message plays the `tx-main` tool turn as a `Bash` call that
 * adds a git worktree, and the fake **really runs** it, as an agent following
 * the answers block's worktree instruction would: `git -C <repo> worktree add -b
 * <branch> <path>` (from the repo's current HEAD; argv only). `<repo>` and
 * `<path>` are relative to the cwd and must stay inside it.
 */

/** A parsed `[fake:worktree-add]` token: absolute repo and worktree paths, the new branch. */
export interface WorktreeAddSpec {
  readonly repo: string;
  readonly branch: string;
  readonly path: string;
}

/** The token in `text`: its spec, `{ error }` when malformed or leaving the cwd, `null` without one. */
export function worktreeAddToken(text: string, cwd: string): WorktreeAddSpec | { error: string } | null {
  const match = /\[fake:worktree-add\s+(\S+)\s+(\S+)\s+(\S+)\]/.exec(text);
  if (!match) return /\[fake:worktree-add(?:\s|\])/.test(text) ? { error: 'expected [fake:worktree-add <repo> <branch> <path>]' } : null;
  const repo = resolveInside(cwd, match[1] ?? '');
  const target = resolveInside(cwd, match[3] ?? '');
  if (repo === null || target === null) return { error: `refusing ${match[0]}: a path leaves the cwd` };
  return { repo, branch: match[2] ?? '', path: target };
}

/** A path quoted for the displayed command when it needs it (spaces, quotes, `$`, …). */
function quoted(value: string): string {
  return /^[A-Za-z0-9_./@:+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command the Bash call shows (what an agent would type). */
export function worktreeAddCommand(spec: WorktreeAddSpec): string {
  return `git -C ${quoted(spec.repo)} worktree add -b ${quoted(spec.branch)} ${quoted(spec.path)}`;
}

/** What running the command gave: the Bash result text (git's stdout + stderr) and whether it failed. */
export interface WorktreeAddResult {
  readonly text: string;
  readonly isError: boolean;
}

/** Runs `git worktree add -b <branch> <path>` in `<repo>` (argv only, `shell: false`). */
export async function addWorktree(spec: WorktreeAddSpec, env: NodeJS.ProcessEnv): Promise<WorktreeAddResult> {
  const result = await runGit(spec.repo, ['worktree', 'add', '-b', spec.branch, spec.path], env);
  const text = [result.stdout, result.stderr].map((part) => part.trim()).filter(Boolean).join('\n') || `worktree added at ${path.basename(spec.path)}`;
  return { text: result.code === 0 ? text : `Exit code ${String(result.code)}\n${text}`, isError: result.code !== 0 };
}
