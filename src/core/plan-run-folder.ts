import { PLAN_SIDEBAR_FOLDER_PREFIX } from './plans-jira.ts';
import { type SidebarLayout, cutSidebarFolderName, folderOfSession } from './sidebar-layout.ts';

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
