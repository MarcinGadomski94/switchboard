import type { UserProfileColor } from '../../../core/user-profiles.ts';
import type { RepoContext } from '../context.ts';
import { Table, type TableSpec } from '../table.ts';

/**
 * D165 (migration 0055, `docs/profiles.md`): the user profiles. The password is stored only as a
 * scrypt hash (`user-profiles/password.ts`) and never leaves the server, except to a paired
 * computer over the peer listener (the profiles sync). A deleted profile stays as a tombstone
 * (`deletedAt`) so the paired computers learn it.
 */
export interface UserProfileRecord {
  readonly id: string;
  readonly name: string;
  readonly color: UserProfileColor;
  /** `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`, `null` = no password. */
  readonly passwordHash: string | null;
  /** Hybrid-clock text of the last change (`''` = never changed): the peer sync's last write wins. */
  readonly clock: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  /** D172 (0059): on a tombstone, the profile (its peer-link id) this one was merged into; `null` otherwise. */
  readonly mergedInto: string | null;
  /** D173 (0060): an admin profile (only admins change admins and computer access). */
  readonly admin: boolean;
  /** D173 (0060): the computers (machine ids) the profile may use; `null` = every computer. */
  readonly computers: readonly string[] | null;
}

const SPEC: TableSpec<UserProfileRecord> = {
  table: 'user_profiles',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    name: ['name', 'text'],
    color: ['color', 'text'],
    passwordHash: ['password_hash', 'text'],
    clock: ['clock', 'text'],
    createdAt: ['created_at', 'text'],
    updatedAt: ['updated_at', 'text'],
    deletedAt: ['deleted_at', 'text'],
    mergedInto: ['merged_into', 'text'],
    admin: ['admin', 'bool'],
    computers: ['computers', 'json'],
  },
};

/**
 * D172: the tables (main db) that name a profile by id, re-keyed when one profile is merged into
 * another: `[table, column]`. Crews (team.db) and the settings keys are re-keyed by their owners.
 */
const PROFILE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['sessions', 'user_profile_id'],
  ['devices', 'user_profile_id'],
  ['schedules', 'user_profile_id'],
  ['sidebar_folders', 'user_profile_id'],
  ['folders', 'user_profile_id'],
];

/** The `user_profiles` table. */
export class UserProfileRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<UserProfileRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  /** Every profile (tombstones with `includeDeleted`), Default first, then by creation. */
  async list(options: { readonly includeDeleted?: boolean } = {}): Promise<UserProfileRecord[]> {
    return this.#table.select(options.includeDeleted ? '' : 'deleted_at IS NULL', [], "id <> 'default', created_at, id");
  }

  /** A profile, tombstones included. */
  async get(id: string): Promise<UserProfileRecord | null> {
    return this.#table.get(id);
  }

  async create(input: Pick<UserProfileRecord, 'id' | 'name' | 'color' | 'passwordHash' | 'clock'>): Promise<UserProfileRecord> {
    const ts = this.#ctx.now();
    return this.#table.insert({ ...input, createdAt: ts, updatedAt: ts, deletedAt: null, mergedInto: null, admin: false, computers: null });
  }

  async update(id: string, patch: Partial<Pick<UserProfileRecord, 'name' | 'color' | 'passwordHash' | 'clock' | 'deletedAt' | 'mergedInto' | 'admin' | 'computers'>>): Promise<UserProfileRecord | null> {
    return this.#table.update(id, { ...patch, updatedAt: this.#ctx.now() });
  }

  /** Writes a paired computer's record as it is (the sync's merge decided it wins). */
  async put(record: UserProfileRecord): Promise<void> {
    if (this.#table.get(record.id)) this.#table.update(record.id, { name: record.name, color: record.color, passwordHash: record.passwordHash, clock: record.clock, deletedAt: record.deletedAt, mergedInto: record.mergedInto, admin: record.admin, computers: record.computers, updatedAt: this.#ctx.now() });
    else this.#table.insert({ ...record });
  }

  /** D172: removes a row outright (a local copy of a profile that became this computer's own Default). Never synced. */
  remove(id: string): void {
    this.#ctx.db.prepare('DELETE FROM user_profiles WHERE id = ?').run(id);
  }

  /** D172: every main-db reference to profile `from` now names `to` (a merge). Answers the rows changed. */
  rekey(from: string, to: string): number {
    if (from === to) return 0;
    let changed = 0;
    this.#ctx.db.exec('BEGIN');
    try {
      for (const [table, column] of PROFILE_COLUMNS) changed += Number(this.#ctx.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(to, from).changes);
      this.#ctx.db.exec('COMMIT');
    } catch (error) {
      this.#ctx.db.exec('ROLLBACK');
      throw error;
    }
    return changed;
  }

  /** The profile of every session (`id → user_profile_id`): the scope's in-memory index at start. */
  sessionProfiles(): Map<string, string> {
    const out = new Map<string, string>();
    for (const row of this.#ctx.db.prepare('SELECT id, user_profile_id FROM sessions').all()) out.set(String(row['id']), String(row['user_profile_id']));
    return out;
  }

  /** Moves sessions to a profile (`docs/profiles.md` → *Move to profile*). */
  setSessionProfile(sessionIds: readonly string[], userProfileId: string): void {
    const statement = this.#ctx.db.prepare('UPDATE sessions SET user_profile_id = ? WHERE id = ?');
    for (const id of sessionIds) statement.run(userProfileId, id);
  }

  /** Every session of a profile (open and closed). */
  sessionsOf(userProfileId: string): string[] {
    return this.#ctx.db.prepare('SELECT id FROM sessions WHERE user_profile_id = ?').all(userProfileId).map((row) => String(row['id']));
  }
}
