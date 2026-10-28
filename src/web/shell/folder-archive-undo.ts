import type { SidebarFolder, SidebarLayout } from '../../core/sidebar-layout.ts';
import { childFolders, parentOf } from '../../core/sidebar-layout.ts';
import { folderSubtree } from '../../core/sidebar-folder-archive.ts';
import { api } from '../api/client.ts';

/**
 * D141 · Undo of "Delete folder and archive its agents" (both UIs' toasts): the
 * folder tree as it was before the delete, rebuilt through the ordinary sidebar
 * routes (the way v2's Undo of a plain delete already does), after Restore of the
 * agents the delete archived (`POST /api/sessions/{id}/reopen`, a paired
 * computer's through the proxy). Best effort: a step the service refuses (an
 * agent restored or deleted meanwhile) is skipped, the rest goes on.
 */

/** The folder and its subfolders as they were, and the folder's place among its siblings. */
export interface FolderTreeSnapshot {
  /** Tree order: the folder first. */
  readonly folders: readonly SidebarFolder[];
  readonly parentId: string | null;
  readonly index: number;
}

/** The snapshot to take just before the delete. */
export function snapshotFolderTree(layout: SidebarLayout, folderId: string): FolderTreeSnapshot | null {
  const folders = folderSubtree(layout, folderId);
  const root = folders[0];
  if (!root) return null;
  const parentId = parentOf(root);
  return { folders, parentId, index: Math.max(0, childFolders(layout, parentId).findIndex((f) => f.id === folderId)) };
}

/** Restores the archived agents, then rebuilds the tree with every session in its place; answers the final layout. */
export async function undoFolderArchive(snapshot: FolderTreeSnapshot, archivedIds: readonly string[]): Promise<SidebarLayout> {
  await Promise.all(archivedIds.map((id) => api.reopenSession(id).catch(() => undefined)));
  let layout = await api.sidebarLayout();
  const ids = new Map<string, string>();
  for (const folder of snapshot.folders) {
    const parent = folder === snapshot.folders[0] ? snapshot.parentId : (ids.get(parentOf(folder) ?? '') ?? null);
    const known = new Set(layout.folders.map((f) => f.id));
    layout = await api.createSidebarFolder(folder.name, parent);
    const made = layout.folders.find((f) => !known.has(f.id));
    if (!made) continue;
    ids.set(folder.id, made.id);
    if (folder === snapshot.folders[0]) layout = await api.moveSidebarFolder(made.id, snapshot.index, parent);
  }
  for (const folder of snapshot.folders) {
    const id = ids.get(folder.id);
    if (!id) continue;
    for (const [index, sessionId] of folder.sessionIds.entries()) {
      layout = await api.placeSidebarSession({ sessionId, place: 'folder', folderId: id, index }).catch(() => layout);
    }
    if (folder.collapsed) layout = await api.updateSidebarFolder(id, { collapsed: true });
  }
  return layout;
}
