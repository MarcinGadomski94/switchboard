import { type SidebarFolder, type SidebarLayout, normalizeFolders, parentOf } from '../../../core/sidebar-layout.ts';
import type { RepoContext } from '../context.ts';
import { transaction } from '../database.ts';

interface FolderRow {
  readonly id: string;
  readonly name: string;
  readonly collapsed: number;
  readonly parent_id: string | null;
}

interface PlaceRow {
  readonly session_id: string;
  readonly folder_id: string | null;
}

/**
 * D54 · the sidebar's pins and folders (migrations 0019 and 0021: D58's
 * subfolders, `docs/sidebar.md`). The
 * whole layout is small, so it is read and written as one value: the rules live
 * in `src/core/sidebar-layout.ts`, and {@link update} applies one of them inside
 * a single transaction (read, change, write), so two tabs writing at once never
 * interleave.
 */
export class SidebarLayoutRepository {
  readonly #ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
  }

  /** The stored layout (empty when nothing was ever pinned or foldered). */
  async read(): Promise<SidebarLayout> {
    return this.#read();
  }

  /**
   * Applies `change` to the stored layout and stores its answer; `null` from
   * `change` (e.g. no such folder) changes nothing and answers `null`.
   */
  async update(change: (layout: SidebarLayout) => SidebarLayout | null): Promise<SidebarLayout | null> {
    return transaction(this.#ctx.db, () => {
      const next = change(this.#read());
      if (next === null) return null;
      this.#write(next);
      return this.#read();
    });
  }

  #read(): SidebarLayout {
    const db = this.#ctx.db;
    const folders = db.prepare('SELECT id, name, collapsed, parent_id FROM sidebar_folders ORDER BY position, created_at, id').all() as unknown as FolderRow[];
    const places = db.prepare('SELECT session_id, folder_id FROM sidebar_places ORDER BY position, session_id').all() as unknown as PlaceRow[];
    const byFolder = new Map<string, string[]>(folders.map((f) => [f.id, []]));
    const pinned: string[] = [];
    for (const place of places) {
      if (place.folder_id === null) pinned.push(place.session_id);
      else byFolder.get(place.folder_id)?.push(place.session_id);
    }
    const out: SidebarFolder[] = folders.map((f) => ({ id: f.id, name: f.name, collapsed: f.collapsed === 1, sessionIds: byFolder.get(f.id) ?? [], parentId: f.parent_id }));
    // D58: tree order (each folder followed by its subfolders); siblings by position.
    return { pinned, folders: normalizeFolders(out) };
  }

  #write(layout: SidebarLayout): void {
    const db = this.#ctx.db;
    const now = this.#ctx.now();
    // D58: parents before children (the foreign key), and positions per parent.
    const folders = normalizeFolders(layout.folders);
    db.prepare('DELETE FROM sidebar_places').run();
    const upsert = db.prepare(
      'INSERT INTO sidebar_folders (id, name, position, collapsed, created_at, parent_id) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (id) DO UPDATE SET name = excluded.name, position = excluded.position, collapsed = excluded.collapsed, parent_id = excluded.parent_id',
    );
    const positions = new Map<string | null, number>();
    for (const folder of folders) {
      const parent = parentOf(folder);
      const position = positions.get(parent) ?? 0;
      positions.set(parent, position + 1);
      upsert.run(folder.id, folder.name, position, folder.collapsed ? 1 : 0, now, parent);
    }
    // Folders that are gone: their kept subfolders were moved above, so the cascade only meets gone ones.
    const keep = new Set(folders.map((f) => f.id));
    for (const row of db.prepare('SELECT id FROM sidebar_folders').all() as unknown as Array<{ id: string }>) {
      if (!keep.has(row.id)) db.prepare('DELETE FROM sidebar_folders WHERE id = ?').run(row.id);
    }
    const place = db.prepare('INSERT INTO sidebar_places (session_id, folder_id, position) VALUES (?, ?, ?)');
    const seen = new Set<string>();
    const put = (sessionId: string, folderId: string | null, position: number): void => {
      if (seen.has(sessionId)) return; // one place per session (the first wins)
      seen.add(sessionId);
      place.run(sessionId, folderId, position);
    };
    layout.pinned.forEach((id, i) => put(id, null, i));
    for (const folder of folders) folder.sessionIds.forEach((id, j) => put(id, folder.id, j));
  }
}
