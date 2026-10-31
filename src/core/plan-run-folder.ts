import { PLAN_SIDEBAR_FOLDER_PREFIX } from './plans-jira.ts';
import { SIDEBAR_FOLDER_DEPTH_MAX, SIDEBAR_FOLDER_NAME_MAX, type SidebarLayout, cutSidebarFolderName, folderDepth, folderOfSession, runParentFolder, runSubfolder } from './sidebar-layout.ts';

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
