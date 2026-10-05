import { HybridClock } from '../../../core/hlc.ts';
import type { SidebarLayout } from '../../../core/sidebar-layout.ts';
import {
  type FolderRecord,
  type PlaceGroup,
  type PlaceRecord,
  type RecordChanges,
  type SidebarRecords,
  clocksOf,
  combineSameNamed,
  layoutFromRecords,
  mergeRecords,
  noChanges,
  recordsAfter,
} from '../../../core/sidebar-records.ts';
import type { RepoContext } from '../context.ts';
import { transaction } from '../database.ts';

interface FolderRow {
  readonly id: string;
  readonly name: string;
  readonly name_clock: string;
  readonly parent_id: string | null;
  readonly sort_key: string;
  readonly place_clock: string;
  readonly deleted_clock: string | null;
  readonly collapsed: number;
}

interface PlaceRow {
  readonly session_id: string;
  readonly grp: string;
  readonly folder_id: string | null;
  readonly sort_key: string;
  readonly clock: string;
}

/** A write's outcome: the layout now, and the records it wrote (for the D71 sync). */
export interface SidebarWrite {
  readonly layout: SidebarLayout;
  readonly changes: RecordChanges;
}

/**
 * D54 · the sidebar's pins and folders (D58 subfolders; D71: stored as records
 * with order keys and clocks, migration 0029, `docs/sidebar.md`). The rules live
 * in `src/core/sidebar-layout.ts` (the layout as arrays) and
 * `src/core/sidebar-records.ts` (records, merge): {@link change} applies a rule
 * inside a single transaction (read, change, write only what moved), so two
 * tabs writing at once never interleave, and answers the records it wrote,
 * which the D71 sync sends on to the paired machines.
 */
export class SidebarLayoutRepository {
  readonly #ctx: RepoContext;
  /** D71: this machine's hybrid clock (its id is set by the peers service: {@link useNode}). */
  readonly #clock = new HybridClock('');

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
  }

  /** D71: this machine's id, written into every clock (a deterministic tie-break between machines). */
  useNode(id: string): void {
    this.#clock.node = id;
  }

  /** The stored layout (empty when nothing was ever pinned or foldered). */
  async read(): Promise<SidebarLayout> {
    return layoutFromRecords(this.#records());
  }

  /** D71: the stored records (the sync's full exchange). */
  async records(): Promise<SidebarRecords> {
    return this.#records();
  }

  /**
   * Applies `change` to the stored layout and stores its answer; `null` from
   * `change` (e.g. no such folder) changes nothing and answers `null`.
   */
  async update(change: (layout: SidebarLayout) => SidebarLayout | null): Promise<SidebarLayout | null> {
    return (await this.change(change))?.layout ?? null;
  }

  /** {@link update}, also answering the records written. */
  async change(change: (layout: SidebarLayout) => SidebarLayout | null): Promise<SidebarWrite | null> {
    return transaction(this.#ctx.db, () => {
      const records = this.#records();
      const next = change(layoutFromRecords(records));
      if (next === null) return null;
      const after = recordsAfter(records, next, () => this.#clock.next());
      this.#write(after.changes);
      return { layout: layoutFromRecords(this.#records()), changes: after.changes };
    });
  }

  /** D71: merges a paired machine's records (last write wins per item); answers what changed here. */
  async merge(incoming: RecordChanges): Promise<SidebarWrite> {
    for (const clock of clocksOf(incoming)) this.#clock.observe(clock);
    return transaction(this.#ctx.db, () => {
      const merged = mergeRecords(this.#records(), incoming);
      this.#write(merged.changes);
      return { layout: layoutFromRecords(merged.records), changes: merged.changes };
    });
  }

  /** D71 first enable: combines same-named folders at the same place (`combineSameNamed`); answers what changed. */
  async combineSameNamed(): Promise<SidebarWrite> {
    return (await this.change((layout) => combineSameNamed(layout))) as SidebarWrite;
  }

  #records(): SidebarRecords {
    const db = this.#ctx.db;
    const folders = (db.prepare('SELECT id, name, name_clock, parent_id, sort_key, place_clock, deleted_clock, collapsed FROM sidebar_folders').all() as unknown as FolderRow[]).map(
      (row): FolderRecord => ({
        id: row.id,
        name: row.name,
        nameClock: row.name_clock,
        parentId: row.parent_id,
        order: row.sort_key,
        placeClock: row.place_clock,
        deletedClock: row.deleted_clock,
        collapsed: row.collapsed === 1,
      }),
    );
    const places = (db.prepare('SELECT session_id, grp, folder_id, sort_key, clock FROM sidebar_places').all() as unknown as PlaceRow[]).map(
      (row): PlaceRecord => ({ sessionId: row.session_id, group: row.grp as PlaceGroup, folderId: row.folder_id, order: row.sort_key, clock: row.clock }),
    );
    return { folders, places };
  }

  #write(changes: RecordChanges): void {
    if (noChanges(changes)) return;
    const db = this.#ctx.db;
    const now = this.#ctx.now();
    const folder = db.prepare(
      'INSERT INTO sidebar_folders (id, name, name_clock, parent_id, sort_key, place_clock, deleted_clock, collapsed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_clock = excluded.name_clock, parent_id = excluded.parent_id, sort_key = excluded.sort_key, ' +
        'place_clock = excluded.place_clock, deleted_clock = excluded.deleted_clock, collapsed = excluded.collapsed',
    );
    for (const f of changes.folders) folder.run(f.id, f.name, f.nameClock, f.parentId, f.order, f.placeClock, f.deletedClock, f.collapsed ? 1 : 0, now);
    const place = db.prepare(
      'INSERT INTO sidebar_places (session_id, grp, folder_id, sort_key, clock) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT (session_id) DO UPDATE SET grp = excluded.grp, folder_id = excluded.folder_id, sort_key = excluded.sort_key, clock = excluded.clock',
    );
    for (const p of changes.places) place.run(p.sessionId, p.group, p.group === 'folder' ? p.folderId : null, p.order, p.clock);
  }
}
