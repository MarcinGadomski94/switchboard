import type { RepoContext } from '../context.ts';

/** What a snapshot holds (D48 ruling D48-cache-persist; D52: `schedules` and `terminal-loops`, key ''; D68: `todos`, key ''). */
export type PeerSnapshotKind = 'sessions' | 'detail' | 'events' | 'schedules' | 'terminal-loops' | 'todos' | 'reviews' | 'artifacts';

/**
 * The last known answers of each paired machine (migration 0018): its open
 * sessions, and the detail and events of the sessions that were opened here,
 * raw as the peer sent them (D52: also its schedules and terminal loops). Read while the machine cannot be reached.
 */
export class PeerSnapshotRepository {
  readonly #ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
  }

  /** Stores (replaces) one snapshot. */
  async put(machineId: string, kind: PeerSnapshotKind, key: string, body: unknown): Promise<void> {
    this.#ctx.db
      .prepare(
        'INSERT INTO peer_snapshots (machine_id, kind, key, body, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (machine_id, kind, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at',
      )
      .run(machineId, kind, key, JSON.stringify(body), this.#ctx.now());
  }

  /** One snapshot's body, `undefined` when there is none (or it cannot be read). */
  async get(machineId: string, kind: PeerSnapshotKind, key: string): Promise<unknown> {
    const row = this.#ctx.db.prepare('SELECT body FROM peer_snapshots WHERE machine_id = ? AND kind = ? AND key = ?').get(machineId, kind, key) as { body: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.body) as unknown;
    } catch {
      return undefined;
    }
  }

  /** Drops the detail / events snapshots of sessions no longer in `keep` (the machine's open sessions); the machine-wide lists stay. */
  async prune(machineId: string, keep: readonly string[]): Promise<void> {
    const rows = this.#ctx.db.prepare("SELECT kind, key FROM peer_snapshots WHERE machine_id = ? AND kind IN ('detail', 'events')").all(machineId) as Array<{ kind: string; key: string }>;
    const wanted = new Set(keep);
    const drop = this.#ctx.db.prepare('DELETE FROM peer_snapshots WHERE machine_id = ? AND kind = ? AND key = ?');
    for (const row of rows) if (!wanted.has(row.key)) drop.run(machineId, row.kind, row.key);
  }

  /** Every snapshot of the machine. */
  async deleteMachine(machineId: string): Promise<void> {
    this.#ctx.db.prepare('DELETE FROM peer_snapshots WHERE machine_id = ?').run(machineId);
  }
}
