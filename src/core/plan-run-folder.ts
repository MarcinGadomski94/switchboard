import { PLAN_SIDEBAR_FOLDER_PREFIX } from './plans-jira.ts';
import type { Plan, PlanState } from './plans.ts';
import { SIDEBAR_FOLDER_DEPTH_MAX, SIDEBAR_FOLDER_NAME_MAX, type SidebarLayout, cutSidebarFolderName, descendantIds, folderDepth, folderOfSession, parentOf, runParentFolder, runSubfolder } from './sidebar-layout.ts';

/**
 * D130 (`docs/plans.md` → *The runs' sidebar subfolder*): the Start dialog's prefill of the plan's
 * runs' sidebar subfolder: the plan's title cut to the sidebar's 60 characters at a word break; when
 * the source session already sits in a D119 "Plan · …" subfolder (a Jira folder import), that
 * folder's name, so the runs go into it as it is (the server then uses that folder, no second one
 * nested in it).
 */
export function planRunFolderDefault(layout: SidebarLayout, sourceSessionId: string, planTitle: string): string {
  const folderId = folderOfSession(layout, sourceSessionId);
  const own = folderId === null ? undefined : layout.folders.find((folder) => folder.id === folderId);
  if (own && own.name.startsWith(PLAN_SIDEBAR_FOLDER_PREFIX)) return own.name;
  return cutSidebarFolderName(planTitle);
}

/** D150: the parent picker's value for the sidebar's top level (also what `sidebarParent` takes besides `null`). */
export const RUN_PARENT_ROOT = 'root';

/** D150: one option of the Start dialog's parent picker. */
export interface RunParentOption {
  /** A folder's id, or {@link RUN_PARENT_ROOT}. */
  readonly value: string;
  /** The folder's name, indented by its level (non-breaking spaces, so a native select shows them). */
  readonly label: string;
  /** 0 = the top level; 1 = a top-level folder; … */
  readonly depth: number;
}

/**
 * D150 (`docs/plans.md` → *The runs' sidebar subfolder*): the Start dialog's parent picker: "Top
 * level", then every sidebar folder of this machine's layout in tree order (all levels), indented
 * by its level. No new folder is made from the dialog.
 */
export function runParentOptions(layout: SidebarLayout, topLevel = 'Top level'): RunParentOption[] {
  return [{ value: RUN_PARENT_ROOT, label: topLevel, depth: 0 }, ...layout.folders.map((folder) => {
    const depth = folderDepth(layout, folder.id);
    return { value: folder.id, label: `${'   '.repeat(Math.max(0, depth - 1))}${folder.name}`, depth };
  })];
}

/** D150: the picker's default: the source session's folder (today's place), {@link RUN_PARENT_ROOT} when it sits at the top level. */
export function runParentDefault(layout: SidebarLayout, sourceSessionId: string): string {
  return folderOfSession(layout, sourceSessionId) ?? RUN_PARENT_ROOT;
}

/** D150: the Start body's `sidebarParent` for a picker value: `undefined` = not picked (the source's folder, today's default; older servers unchanged). */
export function runParentBody(picked: string | null): { readonly sidebarParent?: string | null } {
  if (picked === null) return {};
  return { sidebarParent: picked === RUN_PARENT_ROOT ? null : picked };
}

/**
 * D150: why Start would refuse this parent and subfolder name, in the developer's words (`null` =
 * fine). The same rules as the server ({@link runSubfolder} / {@link runParentFolder}).
 */
export function runParentProblem(layout: SidebarLayout, input: { readonly sourceSessionId: string; readonly parent: string; readonly name: string }): string | null {
  const parentId = input.parent === RUN_PARENT_ROOT ? null : input.parent;
  const name = input.name.trim();
  if (name.length > SIDEBAR_FOLDER_NAME_MAX) return null; // The name field says so itself.
  const answer = name === '' ? runParentFolder(layout, { sourceId: input.sourceSessionId, parentId }) : runSubfolder(layout, { sourceId: input.sourceSessionId, name, newId: 'preview', parentId });
  if (answer.ok) return null;
  if (parentId !== null && !layout.folders.some((folder) => folder.id === parentId)) return 'That folder is gone. Pick another one.';
  if (name === '') return 'Name a subfolder to put the steps at the top level, or pick a folder.';
  return `That folder is ${SIDEBAR_FOLDER_DEPTH_MAX} levels deep and can’t hold another one. Pick another folder, or clear the name to put the steps straight into it.`;
}

// ── D151: moving a project's runs folder ────────────────────────────────

/**
 * D151 (`docs/plans.md` → *Moving the runs' folder (D151)*): a plan whose runs go into a sidebar
 * folder (its stored `sidebarFolder`, D130 / D150; the D119 "Plan · …" folder when the plan was
 * started into it), as the folder-move rule reads it.
 */
export interface RunFolderOwner {
  readonly planId: string;
  readonly title: string;
  readonly state: PlanState;
  /** The runs' folder (its id in this machine's sidebar layout). */
  readonly folderId: string;
}

/**
 * D151: the plans whose runs go into a sidebar folder (`Plan.sidebarFolder`), as the folder-move
 * rule reads them (the UIs; a paired computer's plan too: with the shared layout its folder ids are
 * this computer's, otherwise they match no folder here).
 */
export function runFolderOwners(plans: readonly Pick<Plan, 'id' | 'title' | 'state' | 'sidebarFolder'>[]): RunFolderOwner[] {
  return plans.flatMap((plan) => (plan.sidebarFolder ? [{ planId: plan.id, title: plan.title, state: plan.state, folderId: plan.sidebarFolder.id }] : []));
}

/** D151: why a running project's runs folder cannot move (the 409's message and the UI's reason). */
export function runFolderRunningText(title: string): string {
  return `The project “${title}” is running: pause it to move its folder.`;
}

/** The ids of folder `folderId` and every folder inside it: what moves with it. */
function movingIds(layout: SidebarLayout, folderId: string): Set<string> {
  return new Set([folderId, ...descendantIds(layout, folderId)]);
}

/**
 * D151: the running project whose runs folder moving folder `folderId` into `parentId` (`null` =
 * the top level) would move: the folder itself, or a folder that holds it (the runs folder goes
 * with it). `null` = the move may go ahead. Only a project that is **running** holds its folder:
 * paused, done, cancelled and draft ones do not (a draft has no runs folder yet). A re-order among
 * the same siblings (`parentId` `undefined`, or the folder's present parent) changes no place and is
 * never held. A folder that does not exist is left to the tree's own checks.
 */
export function runFolderMoveBlock(layout: SidebarLayout, folderId: string, parentId: string | null | undefined, owners: readonly RunFolderOwner[]): RunFolderOwner | null {
  const folder = layout.folders.find((f) => f.id === folderId);
  if (!folder || parentId === undefined || parentOf(folder) === parentId) return null;
  return runFolderHolder(layout, folderId, owners);
}

/**
 * D151: the running project that holds folder `folderId` where it is (its runs folder is that
 * folder or inside it), whatever the target: a move to any other parent is refused; `null` = none.
 */
export function runFolderHolder(layout: SidebarLayout, folderId: string, owners: readonly RunFolderOwner[]): RunFolderOwner | null {
  if (!layout.folders.some((f) => f.id === folderId)) return null;
  const moving = movingIds(layout, folderId);
  return owners.find((owner) => owner.state === 'running' && moving.has(owner.folderId)) ?? null;
}

/** D151: a folder's place as the developer reads it: its path from the top level, " › " between the names (`''` for an unknown id). */
export function folderPathText(layout: SidebarLayout, folderId: string): string {
  const names = new Map(layout.folders.map((f) => [f.id, f.name]));
  return folderPathIds(layout, folderId)
    .map((id) => names.get(id) ?? '')
    .join(' › ');
}

/** D151: one project whose runs folder a folder move took elsewhere, and the folder's new path. */
export interface RunFolderMoved {
  readonly planId: string;
  readonly path: string;
}

/** D151: the activity line of a moved runs folder. */
export function runFolderMovedText(path: string): string {
  return `Runs folder moved to ${path}`;
}

/**
 * D151: the projects whose runs folder now sits somewhere else after a move from `before` to
 * `after` (the folder itself or a folder holding it changed its parent): each with the folder's new
 * path. A re-order among siblings changes no path and is not listed.
 */
export function movedRunFolders(before: SidebarLayout, after: SidebarLayout, owners: readonly RunFolderOwner[]): RunFolderMoved[] {
  const out: RunFolderMoved[] = [];
  for (const owner of owners) {
    if (!after.folders.some((f) => f.id === owner.folderId) || !before.folders.some((f) => f.id === owner.folderId)) continue;
    const path = folderPathText(after, owner.folderId);
    if (folderPathIds(before, owner.folderId).join('/') !== folderPathIds(after, owner.folderId).join('/')) out.push({ planId: owner.planId, path });
  }
  return out;
}

function folderPathIds(layout: SidebarLayout, folderId: string): string[] {
  const byId = new Map(layout.folders.map((f) => [f.id, f]));
  const ids: string[] = [];
  let at = byId.get(folderId);
  while (at && ids.length <= layout.folders.length) {
    ids.unshift(at.id);
    const parent = parentOf(at);
    at = parent === null ? undefined : byId.get(parent);
  }
  return ids;
}
