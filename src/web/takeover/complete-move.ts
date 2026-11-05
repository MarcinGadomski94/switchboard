import { type MoveStash, type SkippedWorktree, type TargetChanges, groupByRepo, stashConfirmed, stashNote, worktreeLabel } from '../../core/move-worktrees.ts';
import type { TakeoverPreview, TargetPlacement } from '../../core/takeover.ts';
import { type MoveOverwrite, type TargetDiverged, divergedHeadline, overwriteConfirmed, overwriteNote } from '../../core/move-overwrite.ts';
import { outsideCarried, outsideDefaultText } from '../../core/outside-repos.ts';
import {
  type WorkspaceFileChoice,
  type WorkspaceFileTargetState,
  defaultChoice,
  folderNameProblem,
  formatBytes,
  joinTargetPath,
  targetBaseName,
  targetParent,
  newWorkspacePath,
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
  /**
   * D153: the target checkouts whose uncommitted changes the developer confirmed
   * stashing there ("Stash them on <PC>"). Absent / empty = none (a dirty checkout blocks).
   */
  readonly stashTargets?: readonly string[];
  /**
   * D157: the target checkouts whose diverged branch the developer confirmed
   * overwriting there ("Overwrite them on <PC> (keep a backup branch)"). Absent /
   * empty = none (a diverged branch blocks).
   */
  readonly overwriteTargets?: readonly string[];
}

/** An empty choice (the remembered folders, if any, come with the first preview). */
export const EMPTY_CHOICE: MoveChoice = { placement: null, clonePaths: {}, files: null };

/** The request fields of a choice (`placement` left out while it is `null` and `keepNull` is off: the remembered folders apply). */
export function choiceBody(choice: MoveChoice, keepNull = false): { placement?: TargetPlacement | null; clonePaths?: Record<string, string>; workspaceFiles?: WorkspaceFileChoice; excludeRepos?: string[]; stashTargets?: string[]; overwriteTargets?: string[] } {
  return {
    ...(choice.stashTargets && choice.stashTargets.length > 0 ? { stashTargets: [...choice.stashTargets] } : {}),
    ...(choice.overwriteTargets && choice.overwriteTargets.length > 0 ? { overwriteTargets: [...choice.overwriteTargets] } : {}),
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

/** D153: the choice with stashing the changes of the target checkout at `path` confirmed (`on`) or not. */
export function withStash(choice: MoveChoice, path: string, on: boolean): MoveChoice {
  const out = (choice.stashTargets ?? []).filter((entry) => entry !== path);
  if (on) out.push(path);
  const { stashTargets: _old, ...rest } = choice;
  return out.length > 0 ? { ...rest, stashTargets: out } : rest;
}

/** D153: one target checkout with uncommitted changes the restore needs (the stash choice). */
export interface StashRow {
  /** The checkout on the target. */
  readonly path: string;
  /** The repo's name(s) that need it. */
  readonly names: readonly string[];
  readonly changes: TargetChanges | null;
  /** The developer confirmed stashing them. */
  readonly confirmed: boolean;
}

/** D153: the target checkouts with uncommitted changes in the preview, once each (several repos may need one checkout). */
export function stashRows(preview: TakeoverPreview, choice: MoveChoice): StashRow[] {
  const out: Array<{ path: string; names: string[]; changes: TargetChanges | null; confirmed: boolean }> = [];
  for (const repo of preview.target.repos) {
    if (!repo.targetChanges || repo.matchedPath === null) continue;
    const known = out.find((entry) => entry.path === repo.matchedPath);
    if (known) {
      if (!known.names.includes(repo.name)) known.names.push(repo.name);
      continue;
    }
    out.push({ path: repo.matchedPath, names: [repo.name], changes: repo.targetChanges, confirmed: stashConfirmed(choice.stashTargets, repo.matchedPath) });
  }
  return out;
}

/** D157: the choice with overwriting the diverged branch(es) of the target checkout at `path` confirmed (`on`) or not. */
export function withOverwrite(choice: MoveChoice, path: string, on: boolean): MoveChoice {
  const out = (choice.overwriteTargets ?? []).filter((entry) => entry !== path);
  if (on) out.push(path);
  const { overwriteTargets: _old, ...rest } = choice;
  return out.length > 0 ? { ...rest, overwriteTargets: out } : rest;
}

/** D157: one target checkout whose branch has commits the source's does not (the overwrite choice). */
export interface OverwriteRow {
  /** The checkout on the target. */
  readonly path: string;
  /** Each diverged branch there with its headline ("<PC>'s <branch> in <path> has N commits that aren't on <source>"). */
  readonly branches: ReadonlyArray<{ readonly diverged: TargetDiverged; readonly headline: string }>;
  /** The developer confirmed overwriting them (a backup branch kept). */
  readonly confirmed: boolean;
}

/** D157: the target checkouts with a diverged branch in the preview, once each. */
export function overwriteRows(preview: TakeoverPreview, choice: MoveChoice): OverwriteRow[] {
  const target = preview.target.machine.name;
  const source = preview.source.machine.name;
  const out: Array<{ path: string; branches: Array<{ diverged: TargetDiverged; headline: string }>; confirmed: boolean }> = [];
  for (const repo of preview.target.repos) {
    if (!repo.targetDiverged || repo.matchedPath === null) continue;
    const diverged = repo.targetDiverged;
    let row = out.find((entry) => entry.path === repo.matchedPath);
    if (!row) {
      row = { path: repo.matchedPath, branches: [], confirmed: overwriteConfirmed(choice.overwriteTargets, repo.matchedPath) };
      out.push(row);
    }
    if (!row.branches.some((entry) => entry.diverged.branch === diverged.branch)) row.branches.push({ diverged, headline: divergedHeadline(target, repo.matchedPath, source, diverged) });
  }
  return out;
}

/** D157: what a run says about the branches it overwrote (the replaced commits are kept on a backup branch). */
export function overwriteLines(overwrites: readonly MoveOverwrite[] | undefined): string[] {
  return (overwrites ?? []).map((entry) => `${overwriteNote(entry)}.`);
}

/** D153: what a run says about the stashes it made (kept on the target). */
export function stashLines(stashes: readonly MoveStash[] | undefined): string[] {
  return (stashes ?? []).map(stashNote);
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
  // D152 follow-up: the repos outside the workspace have their own section (`outsideRows`).
  return (preview.source.repos ?? []).filter((repo) => repo.outside !== true).map((repo): CarryRow => {
    const carried = !excluded.has(repo.path);
    const evidence = worksInEvidenceLabel(repo.evidence);
    const why = evidence !== '' ? evidence : repo.found ? worksInSourceLabel(repo.found) : '';
    return { name: repo.name, path: repo.path, why, key: carried && planned.has(repo.key) ? repo.key : null, carried };
  });
}

/** D153: one repo of the carry list with its worktrees nested (and the ones the move skips, with the reason). */
export interface CarryGroup {
  /** The repo's main checkout on the source. */
  readonly mainPath: string;
  readonly name: string;
  /** The main checkout's own row, when the agent works in it. */
  readonly main: CarryRow | null;
  /** Its worktrees that travel (each can be left out). */
  readonly worktrees: ReadonlyArray<CarryRow & { readonly label: string }>;
  /** Its worktrees the move does not carry: no remote branch, or merged (a warning when they hold uncommitted changes). */
  readonly skipped: ReadonlyArray<SkippedWorktree & { readonly label: string }>;
}

/** D153: the carry list grouped by repo: one entry per repo, its worktrees nested, the skipped ones with their reason. */
export function carryGroups(preview: TakeoverPreview, choice: MoveChoice): CarryGroup[] {
  const rows = carryRows(preview, choice);
  const repos = (preview.source.repos ?? []).filter((repo) => repo.outside !== true);
  const keyed = rows.map((row, at) => ({ ...row, kind: repos[at]?.kind ?? 'main', mainPath: repos[at]?.mainPath ?? row.path }));
  return groupByRepo(keyed, preview.source.skippedWorktrees ?? []).map((group) => ({
    mainPath: group.mainPath,
    name: group.name,
    main: group.main ? strip(group.main) : null,
    worktrees: group.worktrees.map((row) => ({ ...strip(row), label: worktreeLabel(row) })),
    skipped: group.skipped.map((entry) => ({ ...entry, label: worktreeLabel(entry) })),
  }));
}

function strip<T extends CarryRow>(row: T & { readonly kind?: unknown; readonly mainPath?: unknown }): CarryRow {
  return { name: row.name, path: row.path, why: row.why, key: row.key, carried: row.carried };
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
  return next.roots.length === 0 && !next.newWorkspace && !next.repoPaths && !next.repoModes && !next.outsideCarry ? null : next;
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
  const skipped = preview.source.skippedWorktrees ?? [];
  if (repos.length === 0 && skipped.length === 0) return 'No repo found in its history.';
  // D153: one entry per repo, its worktrees counted under it (never N entries with one name).
  return groupByRepo(repos, skipped)
    .map((group) => {
      const members = [...(group.main ? [group.main] : []), ...group.worktrees];
      const evidence = [...new Set(members.flatMap((repo) => repo.evidence ?? []))];
      const order = ['edited', 'commands', 'read'] as const;
      const words = worksInEvidenceLabel(order.filter((kind) => evidence.includes(kind)));
      const parts = [group.mainPath];
      if (words !== '') parts.push(words);
      if (group.worktrees.length > 0) parts.push(`${group.worktrees.length} worktree${group.worktrees.length === 1 ? '' : 's'} carried`);
      if (group.skipped.length > 0) parts.push(`${group.skipped.length} skipped`);
      return `${group.name} (${parts.join('; ')})`;
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

// ── repos outside the workspace (D152 follow-up 2026-11-05) ───────────────

/** What the developer chose for one repo outside the workspace: use a folder there, clone it, or leave it out. */
export type OutsideMode = 'use' | 'clone' | 'leave';

/** One repo outside the workspace root, as the dialog's **Outside the workspace** section shows it. */
export interface OutsideRow {
  readonly key: string;
  readonly name: string;
  /** Where it is on the source. */
  readonly path: string;
  /** What the agent did there ("edited · commands"), else why it is listed. */
  readonly why: string;
  /** Its default (`SourceRepo.carry`): carried, or left out. */
  readonly defaultCarry: boolean;
  /** The default in words. */
  readonly defaultText: string;
  readonly mode: OutsideMode;
  /** The target's line for it when it is carried (what happens there, or why it cannot), `null` when left out. */
  readonly target: string | null;
  /** The target's plan for it: use, clone, blocked; `null` when left out. */
  readonly action: 'use' | 'clone' | 'blocked' | null;
  /** The checkout it uses there (use), else `null`. */
  readonly usePath: string | null;
  /** Where it is cloned (the developer's path, else the target's suggestion beside the workspace). */
  readonly cloneTo: string | null;
}

/** D152 follow-up: the repos outside the workspace root with their choice and the target's plan for each. */
export function outsideRows(preview: TakeoverPreview, choice: MoveChoice): OutsideRow[] {
  const placement = choice.placement;
  const checks = preview.target.verification?.repos ?? [];
  return (preview.source.repos ?? [])
    .filter((repo) => repo.outside === true)
    .map((repo): OutsideRow => {
      const carried = outsideCarried(repo, placement?.outsideCarry) && !(choice.excludeRepos ?? []).includes(repo.path);
      const plan = carried ? (preview.target.repos.find((entry) => entry.key === repo.key) ?? null) : null;
      const check = checks.find((entry) => entry.key === repo.key) ?? null;
      const evidence = worksInEvidenceLabel(repo.evidence);
      // Use, unless the developer chose to clone it or no checkout of it is there (the target then plans a clone).
      const mode: OutsideMode = !carried ? 'leave' : repoModeOf(placement, repo.key) === 'clone' || plan?.action === 'clone' ? 'clone' : 'use';
      return {
        key: repo.key,
        name: repo.name,
        path: repo.path,
        why: evidence !== '' ? evidence : repo.found ? worksInSourceLabel(repo.found) : '',
        defaultCarry: repo.carry !== false,
        defaultText: outsideDefaultText(repo.carry),
        mode,
        target: plan ? (check?.note ?? plan.summary) : null,
        action: plan?.action ?? null,
        usePath: plan?.matchedPath ?? null,
        cloneTo: choice.clonePaths[repo.key] ?? plan?.cloneTo ?? null,
      };
    });
}

/**
 * D152 follow-up: `placement` with the target's workspace (as the last preview found it)
 * as its folder when it chooses none yet, so a per-repo choice (clone it, another
 * checkout) keeps the workspace the target found instead of asking for folders.
 */
export function withTargetWorkspace(placement: TargetPlacement | null, targetWorkspace: string | null): TargetPlacement {
  const base = placement ?? { roots: [] };
  if (targetWorkspace === null || base.roots.length > 0 || base.newWorkspace) return { ...base, roots: [...base.roots] };
  return { ...base, roots: [targetWorkspace] };
}

/** D152 follow-up: the target's workspace folder in a preview (`null` when it found none). */
export function targetWorkspaceOf(preview: TakeoverPreview): string | null {
  return preview.target.folder?.kind === 'workspace' ? preview.target.folder.path : null;
}

/** D152 follow-up: the choice with an outside repo set to be used from a folder there, cloned, or left out (`targetWorkspace`: {@link withTargetWorkspace}). */
export function withOutsideMode(choice: MoveChoice, key: string, mode: OutsideMode, targetWorkspace: string | null = null): MoveChoice {
  const base = mode === 'leave' ? (choice.placement ?? { roots: [] }) : withTargetWorkspace(choice.placement, targetWorkspace);
  const carry: Record<string, boolean> = { ...(base.outsideCarry ?? {}), [key]: mode !== 'leave' };
  const withCarry: TargetPlacement = { ...base, roots: [...base.roots], outsideCarry: carry };
  const placement = mode === 'leave' ? withCarry : withRepoMode(withCarry, key, mode);
  return { ...choice, placement };
}

/** D152 follow-up: the outside repo's clone folder from a parent folder on the target and a name (shown before Move), or why not yet. */
export function outsideClonePath(parent: string, name: string): { readonly path: string | null; readonly problem: string | null } {
  if (parent.trim() === '') return { path: null, problem: 'Pick the folder to clone it in' };
  const problem = folderNameProblem(name.trim());
  if (problem !== null) return { path: null, problem };
  return { path: joinTargetPath(parent.trim(), name.trim()), problem: null };
}

/** D152 follow-up: the parent and name a clone path splits into (to pre-fill the two fields). */
export function splitClonePath(value: string | null): { readonly parent: string; readonly name: string } {
  if (value === null || value.trim() === '') return { parent: '', name: '' };
  return { parent: targetParent(value), name: targetBaseName(value) };
}

/** D152 follow-up (*Where it runs*): one place the moved agent can run on the target: its workspace root, or one of the repos it carries. */
export interface RunInOption {
  /** `''` = the workspace root; else the repo's path on the source (`placement.runIn.repo`). */
  readonly value: string;
  readonly label: string;
  /** A repo outside the workspace root. */
  readonly outside: boolean;
}

/**
 * D152 follow-up (*Where it runs*): where a workspace agent can run on the target:
 * its workspace root (first, the default), then each repo the move carries (outside
 * ones first: the case this is for). The chosen repo stays listed even while the
 * preview has not caught up.
 */
export function runInOptions(preview: TakeoverPreview, choice: MoveChoice): RunInOption[] {
  const excluded = new Set(choice.excludeRepos ?? []);
  const chosen = choice.placement?.runIn?.repo ?? null;
  const repos = (preview.source.repos ?? []).filter((repo) => repo.path === chosen || (!excluded.has(repo.path) && (repo.outside !== true || outsideCarried(repo, choice.placement?.outsideCarry))));
  const sorted = [...repos.filter((repo) => repo.outside === true), ...repos.filter((repo) => repo.outside !== true)];
  return [
    { value: '', label: 'The workspace root', outside: false },
    ...sorted.map((repo) => ({ value: repo.path, label: `${repo.name}${repo.outside === true ? ' (outside the workspace)' : ''}`, outside: repo.outside === true })),
  ];
}

/** D152 follow-up (*Where it runs*): the source path of the repo the agent runs in on the target, `null` = its workspace root. */
export function runInOf(choice: MoveChoice): string | null {
  return choice.placement?.runIn?.repo ?? null;
}

/**
 * D152 follow-up (*Where it runs*): the choice with the agent running in the repo at
 * source `repoPath` on the target (`null`: its workspace root). Choosing a repo
 * carries it (an outside one is carried, a left-out one put back) and drops a new
 * workspace root the developer had asked for: no workspace is needed there.
 */
export function withRunIn(choice: MoveChoice, preview: TakeoverPreview, repoPath: string | null): MoveChoice {
  const base: TargetPlacement = choice.placement ?? { roots: [] };
  if (repoPath === null) {
    const { runIn: _old, ...rest } = base;
    return { ...choice, placement: { ...rest, roots: [...rest.roots] } };
  }
  const repo = (preview.source.repos ?? []).find((entry) => entry.path === repoPath) ?? null;
  const { newWorkspace: _dropped, ...rest } = base;
  const outsideCarry = repo?.outside === true ? { ...(rest.outsideCarry ?? {}), [repo.key]: true } : rest.outsideCarry;
  const placement: TargetPlacement = { ...rest, roots: [...rest.roots], ...(outsideCarry ? { outsideCarry } : {}), runIn: { repo: repoPath } };
  return withRepoCarried({ ...choice, placement }, repoPath, true);
}
