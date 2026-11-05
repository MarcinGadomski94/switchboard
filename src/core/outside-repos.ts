import { joinTargetPath, targetBaseName, targetParent } from './workspace-move.ts';

/**
 * D152 follow-up 2026-11-05 (`docs/peers.md` → *A complete move (D152)* → *Repos
 * outside the workspace*): the pure rules for the repos a workspace agent works in
 * that are **not** inside its workspace root (a tool repo next to it, a personal
 * checkout), and for the folders that must never count as a repo or a solution.
 * No file system: the server and the UI share these.
 */

/** The CLIs' own folders: never a repo or a solution of a session (`.claude` holds Claude Code's settings and worktrees). */
export const AGENT_FOLDER_NAMES: ReadonlySet<string> = new Set(['.claude', '.codex', '.opencode']);

function segments(value: string): string[] {
  return value.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
}

/**
 * `true` for a working tree top that is a CLI's own folder (`…/.claude`, `…/.codex`,
 * `…/.opencode`) or Claude Code's worktrees folder itself (`…/.claude/worktrees`):
 * such a folder is never listed as a repo, even when it holds a `.git` entry (a
 * dotfiles checkout of `~/.claude`). A worktree **inside** `.claude/worktrees/<name>`
 * is not one of these: it is its repo's worktree.
 */
export function isAgentFolderTop(top: string): boolean {
  const parts = segments(top);
  const last = parts[parts.length - 1] ?? '';
  if (AGENT_FOLDER_NAMES.has(last)) return true;
  return last === 'worktrees' && parts[parts.length - 2] === '.claude';
}

/**
 * `true` for a name that can never be a workspace solution: empty, `.` / `..`, or
 * whose first segment is a hidden folder (`.claude`, `.worktrees`, `.git`): the
 * workspace scanner never lists hidden folders, so a path-derived name like that is
 * a mistake, not a solution.
 */
export function isHiddenSolutionName(name: string): boolean {
  const first = segments(name)[0];
  return first === undefined || first.startsWith('.');
}

/**
 * `true` when the repo's main checkout `mainPath` is outside the workspace `root`
 * (neither the root nor below it). Either separator, case-insensitive (the two
 * machines may differ in both).
 */
export function isOutsideRoot(root: string, mainPath: string): boolean {
  const base = segments(root).map((part) => part.toLowerCase());
  const full = segments(mainPath).map((part) => part.toLowerCase());
  if (full.length < base.length) return true;
  for (let i = 0; i < base.length; i++) if (base[i] !== full[i]) return true;
  return false;
}

/** What a repo's history shows, for the default carry rule. */
export interface CarryEvidence {
  readonly edited: number;
  readonly commands: number;
}

/**
 * D152 follow-up: a repo outside the workspace is **carried by default** when the
 * agent edited files there, or when it is the repo most of its commands ran in
 * (its commands count is the highest of the session's repos, and above zero). A
 * repo it only read in, or ran a few commands in, is left out by default (the
 * developer can still carry it).
 */
export function carriedByDefault(own: CarryEvidence, mostCommands: number): boolean {
  if (own.edited > 0) return true;
  return own.commands > 0 && own.commands >= mostCommands;
}

/** The part of a move's repos {@link effectiveExclusions} reads. */
export interface ExclusionRepo {
  readonly key: string;
  readonly path: string;
  readonly outside?: boolean;
  readonly carry?: boolean;
}

/** `true` when the outside repo is carried: the developer's choice (`TargetPlacement.outsideCarry`, by repo key), else its default. */
export function outsideCarried(repo: Pick<ExclusionRepo, 'key' | 'carry'>, choice: Readonly<Record<string, boolean>> | undefined): boolean {
  const chosen = choice?.[repo.key];
  return chosen ?? repo.carry !== false;
}

/**
 * The source paths a move leaves out: the developer's `exclude` (`excludeRepos`),
 * plus every repo outside the workspace that is not carried ({@link outsideCarried}:
 * the developer's choice in `placement.outsideCarry`, else its default). An older
 * source sends no `outside` / `carry` (every repo carried, as before).
 */
export function effectiveExclusions(repos: readonly ExclusionRepo[], exclude: readonly string[] | undefined, choice: Readonly<Record<string, boolean>> | undefined): string[] {
  const out = new Set(exclude ?? []);
  for (const repo of repos) {
    if (repo.outside !== true) continue;
    if (outsideCarried(repo, choice)) {
      if (choice?.[repo.key] === true) out.delete(repo.path);
    } else out.add(repo.path);
  }
  return [...out];
}

/**
 * Where an outside repo is cloned on the target by default (shown before Move,
 * changed by the developer): beside the target's workspace root, under the repo's
 * folder name (`D:\code\ws` → `D:\code\tool-repo`), written the target's way.
 */
export function outsideCloneSuggestion(targetRoot: string, sourcePath: string): string {
  return joinTargetPath(targetParent(targetRoot), targetBaseName(sourcePath));
}

/** The dialog's words for an outside repo's default. */
export function outsideDefaultText(carry: boolean | undefined): string {
  return carry === false ? 'left out by default: it only read files or ran a few commands there' : 'carried by default: it worked there';
}
