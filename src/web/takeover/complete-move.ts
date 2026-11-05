import type { TakeoverPreview, TargetPlacement } from '../../core/takeover.ts';
import {
  type WorkspaceFileChoice,
  type WorkspaceFileTargetState,
  defaultChoice,
  formatBytes,
  newWorkspacePath,
  targetBaseName,
  worksInEvidenceLabel,
  worksInSourceLabel,
} from '../../core/workspace-move.ts';

/**
 * D152 (`docs/peers.md` → *A complete move (D152)*): the move dialog's pure
 * parts beyond D110's folders: the workspace root to create on the target, the
 * per-repo use / clone choice, the workspace files' ticks, and (a crew move) the
 * choices shared by teammates that use the same workspace or repo. No React.
 */

/** Everything the developer chose for one move (one session, or one teammate of a crew move). */
export interface MoveChoice {
  /** D110 / D152: `null` = the target's saved folders. */
  readonly placement: TargetPlacement | null;
  readonly clonePaths: Readonly<Record<string, string>>;
  /** `null` = not decided yet (the defaults apply once the preview lists the files). */
  readonly files: WorkspaceFileChoice | null;
  /**
   * D152 follow-up 2026-11-05: the source paths of the repos left out of the move.
   * Absent / empty (the default) = every repo the agent works in is carried, the
   * ones it only read or ran commands in too (it will likely need them there).
   */
  readonly excludeRepos?: readonly string[];
}

/** An empty choice (the remembered folders, if any, come with the first preview). */
export const EMPTY_CHOICE: MoveChoice = { placement: null, clonePaths: {}, files: null };

/** The request fields of a choice (`placement` left out while it is `null` and `keepNull` is off: the remembered folders apply). */
export function choiceBody(choice: MoveChoice, keepNull = false): { placement?: TargetPlacement | null; clonePaths?: Record<string, string>; workspaceFiles?: WorkspaceFileChoice; excludeRepos?: string[] } {
  return {
    ...(choice.placement !== null ? { placement: choice.placement } : keepNull ? { placement: null } : {}),
    ...(Object.keys(choice.clonePaths).length > 0 ? { clonePaths: { ...choice.clonePaths } } : {}),
    ...(choice.files ? { workspaceFiles: choice.files } : {}),
    ...(choice.excludeRepos && choice.excludeRepos.length > 0 ? { excludeRepos: [...choice.excludeRepos] } : {}),
  };
}

/** D152 follow-up 2026-11-05: the choice with the repo at source `path` carried (`on`) or left out. */
export function withRepoCarried(choice: MoveChoice, path: string, on: boolean): MoveChoice {
  const out = new Set(choice.excludeRepos ?? []);
  if (on) out.delete(path);
  else out.add(path);
  const { excludeRepos: _old, ...rest } = choice;
  return out.size > 0 ? { ...rest, excludeRepos: [...out] } : rest;
}

/** One repo the agent works in, as the move dialog's carry list shows it. */
export interface CarryRow {
  readonly name: string;
  /** Where it is on the source (what `excludeRepos` names). */
  readonly path: string;
  /** Why it is listed: "edited", "read", "commands", "its separate copy", … */
  readonly why: string;
  /** Its key in the target's plan (`null` when left out: it is not planned). */
  readonly key: string | null;
  readonly carried: boolean;
}

/** D152 follow-up 2026-11-05: the repos the dialog lets the developer carry or leave out (a workspace session's), in the source's (ranked) order. */
export function carryRows(preview: TakeoverPreview, choice: MoveChoice): CarryRow[] {
  // The developer's choice decides (the preview may still be the one asked before the last tick).
  const excluded = new Set(choice.excludeRepos ?? []);
  const planned = new Set(preview.target.repos.map((repo) => repo.key));
  return (preview.source.repos ?? []).map((repo): CarryRow => {
    const carried = !excluded.has(repo.path);
    const evidence = worksInEvidenceLabel(repo.evidence);
    const why = evidence !== '' ? evidence : repo.found ? worksInSourceLabel(repo.found) : '';
    return { name: repo.name, path: repo.path, why, key: carried && planned.has(repo.key) ? repo.key : null, carried };
  });
}

/** The choice once a preview arrived: its placement, and the default ticks when none were made yet. */
export function choiceAfterPreview(choice: MoveChoice, preview: TakeoverPreview): MoveChoice {
  return { ...choice, placement: preview.placement, files: choice.files ?? (preview.source.workspaceFiles ? defaultChoice(preview.source.workspaceFiles, preview.target.workspaceFiles) : null) };
}

/** `placement` with repo `key` set to be cloned (`clone`) or used from a folder there (`use`, the default). */
export function withRepoMode(placement: TargetPlacement | null, key: string, mode: 'use' | 'clone'): TargetPlacement {
  const modes: Record<string, 'use' | 'clone'> = { ...(placement?.repoModes ?? {}) };
  if (mode === 'clone') modes[key] = 'clone';
  else delete modes[key];
  const { repoModes: _old, ...rest } = placement ?? { roots: [] };
  return { ...rest, roots: [...(placement?.roots ?? [])], ...(Object.keys(modes).length > 0 ? { repoModes: modes } : {}) };
}

/** `placement` creating the workspace root at `path` (`null`: no new root; use an existing folder instead). */
export function withNewWorkspace(placement: TargetPlacement | null, path: string | null, useExisting = false): TargetPlacement | null {
  const { newWorkspace: _old, ...rest } = placement ?? { roots: [] };
  const next: TargetPlacement = { ...rest, roots: [...(placement?.roots ?? [])], ...(path !== null ? { newWorkspace: { path, ...(useExisting ? { useExisting: true } : {}) } } : {}) };
  return next.roots.length === 0 && !next.newWorkspace && !next.repoPaths && !next.repoModes ? null : next;
}

/** The repo's use / clone choice. */
export function repoModeOf(placement: TargetPlacement | null, key: string): 'use' | 'clone' {
  return placement?.repoModes?.[key] === 'clone' ? 'clone' : 'use';
}

/** What the dialog shows about the workspace root: whether to show the section, the source's root, the suggested folder name. */
export interface WorkspaceView {
  /** A workspace session: the section is shown. */
  readonly show: boolean;
  /** The workspace's root on the source. */
  readonly sourceRoot: string | null;
  /** The source root's folder name (the new folder's suggested name). */
  readonly suggestedName: string;
  /** The target has (or the chosen folders hold) the workspace: no new root needed. */
  readonly found: boolean;
  /** The developer asked for a new root (its path as asked), else `null`. */
  readonly creating: string | null;
}

/** The workspace section of a preview. */
export function workspaceView(preview: TakeoverPreview, placement: TargetPlacement | null): WorkspaceView {
  const folder = preview.source.folder;
  const show = folder?.kind === 'workspace';
  const sourceRoot = show ? (folder?.path ?? null) : null;
  return {
    show,
    sourceRoot,
    suggestedName: sourceRoot ? targetBaseName(sourceRoot) : 'workspace',
    found: preview.target.folder?.kind === 'workspace' && !placement?.newWorkspace,
    creating: placement?.newWorkspace?.path ?? null,
  };
}

/** What the new-root inputs give (shown before Move as "Will create …"): the path or why not yet. */
export function newRootFrom(mode: 'parent' | 'full', parent: string, name: string, full: string): { readonly path: string | null; readonly problem: string | null } {
  return mode === 'full' ? newWorkspacePath({ full }) : newWorkspacePath({ parent, name });
}

/** One row of the workspace files list. */
export interface FileRow {
  readonly name: string;
  readonly size: string;
  readonly ticked: boolean;
  /** Why it cannot be ticked (over a cap; already there; a different file there), `null` when it can. */
  readonly disabled: string | null;
  /** Why it looks like it holds a secret, `null` when it does not. */
  readonly secret: string | null;
  readonly state: WorkspaceFileTargetState | null;
  /** The target side in words. */
  readonly target: string;
  /** The root AGENTS.md of a new root: always copied. */
  readonly required: boolean;
}

/** The workspace files list: each file, ticked or not, what is there on the target. */
export function fileRows(preview: TakeoverPreview, choice: WorkspaceFileChoice | null, creatingRoot: boolean): FileRow[] {
  const listing = preview.source.workspaceFiles;
  if (!listing) return [];
  const targets = new Map((preview.target.workspaceFiles ?? []).map((entry) => [entry.name, entry]));
  const ticked = new Set(choice?.copy ?? []);
  return listing.files.map((file): FileRow => {
    const there = targets.get(file.name) ?? null;
    const required = creatingRoot && file.name === 'AGENTS.md' && file.refused === null && (there?.state ?? 'new') === 'new';
    const disabled = file.refused ?? (there?.state === 'same' ? 'already there with the same content' : there?.state === 'conflict' ? (there.reason ?? 'a different file is there') : there?.state === 'refused' ? (there.reason ?? 'cannot be written there') : null);
    const target = there === null ? 'copied' : there.state === 'new' ? 'new there' : there.state === 'same' ? 'already there' : there.state === 'conflict' ? 'different there: skipped' : 'cannot be written there';
    return { name: file.name, size: formatBytes(file.size), ticked: required || (disabled === null && ticked.has(file.name)), disabled: required ? 'it makes the new folder a workspace' : disabled, secret: file.secret, state: there?.state ?? null, target, required };
  });
}

/** The choice with one file ticked or not. */
export function toggleFile(choice: WorkspaceFileChoice | null, name: string, on: boolean): WorkspaceFileChoice {
  const copy = new Set(choice?.copy ?? []);
  if (on) copy.add(name);
  else copy.delete(name);
  return { copy: [...copy], ...(choice?.confirmSecrets ? { confirmSecrets: true } : {}) };
}

/** The ticked files that are marked secret (the confirmation shows when any is). */
export function tickedSecrets(preview: TakeoverPreview, choice: WorkspaceFileChoice | null): string[] {
  const ticked = new Set(choice?.copy ?? []);
  return (preview.source.workspaceFiles?.files ?? []).filter((file) => file.secret !== null && ticked.has(file.name)).map((file) => file.name);
}

/** The "Works in" line of the dialog: the repos the agent works in, from what the source read. */
export function worksInLine(preview: TakeoverPreview): string {
  const repos = preview.source.repos ?? [];
  if (repos.length === 0) return 'No repo found in its history.';
  return repos
    .map((repo) => {
      const evidence = worksInEvidenceLabel(repo.evidence);
      return `${repo.name} (${repo.path}${evidence !== '' ? `; ${evidence}` : ''})`;
    })
    .join(' · ');
}

// ── a crew move: choices shared by teammates ──────────────────────────────

/**
 * D152: a crew move's change of one teammate's choice, applied to the teammates
 * that share it: a new workspace root to every teammate from the same source
 * workspace folder (and the same computer), a repo's use / clone choice and clone
 * path to every teammate that has a repo with the same remote. The other choices
 * (files, picks) stay per teammate.
 */
export function shareChoice(
  choices: Readonly<Record<string, MoveChoice>>,
  previews: Readonly<Record<string, TakeoverPreview | null>>,
  from: string,
  next: MoveChoice,
): Record<string, MoveChoice> {
  const out: Record<string, MoveChoice> = { ...choices, [from]: next };
  const mine = previews[from] ?? null;
  if (!mine) return out;
  const before = choices[from] ?? EMPTY_CHOICE;
  const myFolder = mine.source.folder?.path ?? null;
  const rootChanged = (before.placement?.newWorkspace?.path ?? null) !== (next.placement?.newWorkspace?.path ?? null) || (before.placement?.newWorkspace?.useExisting ?? false) !== (next.placement?.newWorkspace?.useExisting ?? false);
  for (const [id, preview] of Object.entries(previews)) {
    if (id === from || !preview) continue;
    let theirs = out[id] ?? EMPTY_CHOICE;
    if (rootChanged && myFolder !== null && preview.source.folder?.path === myFolder && preview.source.machine.id === mine.source.machine.id) {
      theirs = { ...theirs, placement: withNewWorkspace(theirs.placement, next.placement?.newWorkspace?.path ?? null, next.placement?.newWorkspace?.useExisting === true) };
    }
    for (const repo of mine.source.repos ?? []) {
      const twin = (preview.source.repos ?? []).find((entry) => entry.remoteKey === repo.remoteKey);
      if (!twin) continue;
      const mode = repoModeOf(next.placement, repo.key);
      if (mode !== repoModeOf(before.placement, repo.key)) theirs = { ...theirs, placement: withRepoMode(theirs.placement, twin.key, mode) };
      const path = next.clonePaths[repo.key];
      if (path !== undefined && path !== before.clonePaths[repo.key]) theirs = { ...theirs, clonePaths: { ...theirs.clonePaths, [twin.key]: path } };
    }
    out[id] = theirs;
  }
  return out;
}
