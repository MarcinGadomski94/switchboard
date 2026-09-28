import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FolderKind } from '../../src/core/model.ts';
import type { FolderRecord } from '../../src/server/db/repos/folders.ts';
import type { Store } from '../../src/server/db/store.ts';
import type { FolderRef } from '../../src/server/folders/ref.ts';
import { openTempStore } from './store.ts';

/**
 * Saves `folder` in the store as a user would through Settings → Folders (D14),
 * without the live check (test workspaces often have no router `AGENTS.md`): its
 * canonical path from disk (the path itself when it does not exist), the kind
 * given, and the default mark when no folder has it yet (or `isDefault`).
 */
export async function seedFolder(
  store: Store,
  folder: string,
  options: { readonly kind?: FolderKind; readonly isDefault?: boolean } = {},
): Promise<FolderRecord> {
  const resolved = path.resolve(folder);
  const canonicalPath = await realpath(resolved).catch(() => resolved);
  const existing = await store.folders.getByCanonicalPath(canonicalPath);
  const record = existing ?? (await store.folders.create({ path: resolved, canonicalPath, kind: options.kind ?? 'workspace' }));
  if (options.isDefault || !(await store.folders.getDefault())) return (await store.folders.setDefault(record.id)) ?? record;
  return record;
}

/**
 * {@link seedFolder} into the database of a data folder before a server starts
 * there (`tests/helpers/server-process.ts`, the E2E specs): opens the store
 * (creating and migrating it), saves the folder and closes it again.
 */
export async function seedFolderInDataDir(
  dataDir: string,
  folder: string,
  options: { readonly kind?: FolderKind; readonly isDefault?: boolean } = {},
): Promise<FolderRecord> {
  const store = await openTempStore(dataDir);
  try {
    return await seedFolder(store, folder, options);
  } finally {
    await store.close();
  }
}

/** A {@link FolderRef} for a folder that is not saved (supervisor / worktree-manager tests). */
export function folderRef(root: string, kind: FolderKind = 'workspace', id: string | null = null): FolderRef {
  return { id, path: root, root, kind };
}

/** A saved folder as a {@link FolderRef}. */
export function refOf(record: FolderRecord): FolderRef {
  return { id: record.id, path: record.path, root: record.canonicalPath, kind: record.kind };
}
