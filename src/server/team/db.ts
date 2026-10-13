import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ACTIVITY_CAP, type TeamActivityRecord, type TeamHandoffRecord, type TeamMemberRecord, type TeamRecord, type TeamRequestRecord } from '../../core/team.ts';
import { type TeamAccessRecord, readAccessRecord } from '../../core/team-access.ts';
import { readActivityRecord, readHandoffRecord, readMemberRecord, readRequestRecord, readTeamRecord } from '../../core/team-sync.ts';
import { openDatabase, transaction } from '../db/database.ts';
import { type Migration, makeMigration, migrate } from '../db/migrate.ts';

/**
 * D100 · Team's own SQLite file (`docs/team.md` → *Storage*): `<dataDir>/team.db`,
 * separate from `switchboard.db` so Team can be removed by deleting the file. It is
 * opened only while Team is switched on (and created then); it has its own small
 * migration list, run by the main database's runner (`db/migrate.ts`).
 *
 * Records are stored as JSON next to the columns the sync and the lists need
 * (`clock`, `deleted`, `team_id`): the shapes are `core/team.ts`'s and the reader
 * of a row is the same one that reads a paired machine's record
 * (`core/team-sync.ts`), so a row this build cannot read is skipped, never a crash.
 */

/** The file inside the data folder. */
export const TEAM_DB_FILE = 'team.db';

/** Team's migrations (never edited once released; add a new one). */
export const TEAM_MIGRATIONS: readonly Migration[] = [
  makeMigration(
    1,
    'team',
    `-- D100: Team (docs/team.md). One JSON document per record; the columns are what sync and lists read.
CREATE TABLE teams (
  id      TEXT PRIMARY KEY,
  clock   TEXT NOT NULL,
  data    TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
CREATE TABLE members (
  id       TEXT PRIMARY KEY,
  team_id  TEXT NOT NULL,
  clock    TEXT NOT NULL,
  deleted  INTEGER NOT NULL DEFAULT 0,
  data     TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
CREATE INDEX members_team ON members (team_id);
CREATE TABLE handoffs (
  id       TEXT PRIMARY KEY,
  team_id  TEXT NOT NULL,
  clock    TEXT NOT NULL,
  deleted  INTEGER NOT NULL DEFAULT 0,
  data     TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
CREATE INDEX handoffs_team ON handoffs (team_id);
CREATE TABLE requests (
  id       TEXT PRIMARY KEY,
  team_id  TEXT NOT NULL,
  clock    TEXT NOT NULL,
  deleted  INTEGER NOT NULL DEFAULT 0,
  data     TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
CREATE INDEX requests_team ON requests (team_id);
CREATE TABLE activity (
  id       TEXT PRIMARY KEY,
  team_id  TEXT NOT NULL,
  at       TEXT NOT NULL,
  data     TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
CREATE INDEX activity_team_at ON activity (team_id, at);
`,
  ),
  makeMigration(
    2,
    'team_access',
    `-- D100-T2: access requests (docs/team.md -> Access requests). Metadata only: names, hosts, fields, keychain references; never a secret value.
CREATE TABLE access (
  id       TEXT PRIMARY KEY,
  team_id  TEXT NOT NULL,
  clock    TEXT NOT NULL,
  deleted  INTEGER NOT NULL DEFAULT 0,
  data     TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
CREATE INDEX access_team ON access (team_id);
`,
  ),
];

type SyncedTable = 'members' | 'handoffs' | 'requests' | 'access';

/** The Team database (one connection, synchronous `node:sqlite` behind async methods like the main store). */
export class TeamDb {
  readonly #db: DatabaseSync;
  readonly file: string;
  #closed = false;

  private constructor(db: DatabaseSync, file: string) {
    this.#db = db;
    this.file = file;
  }

  /**
   * Opens (creating when missing) `<dataDir>/team.db` and brings it up to date.
   * @throws when the file cannot be opened or a migration fails (a broken file): the caller hides nothing then.
   */
  static async open(dataDir: string, migrations: readonly Migration[] = TEAM_MIGRATIONS): Promise<TeamDb> {
    const file = path.join(dataDir, TEAM_DB_FILE);
    const db = await openDatabase(file);
    try {
      migrate(db, migrations);
      // A quick read of every table: a file that is not a database (or lost a table) fails here, not later.
      for (const table of ['teams', 'members', 'handoffs', 'requests', 'activity', 'access']) db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    } catch (error) {
      db.close();
      throw error;
    }
    return new TeamDb(db, file);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  get closed(): boolean {
    return this.#closed;
  }

  #rows<T>(sql: string, params: readonly (string | number)[], read: (value: unknown) => T | null): T[] {
    const out: T[] = [];
    for (const row of this.#db.prepare(sql).all(...params)) {
      try {
        const value = read(JSON.parse(String(row['data'])));
        if (value) out.push(value);
      } catch {
        // A row this build cannot read is skipped.
      }
    }
    return out;
  }

  // ── teams ─────────────────────────────────────────────────────────────

  teams(): TeamRecord[] {
    return this.#rows('SELECT data FROM teams ORDER BY id', [], readTeamRecord);
  }

  putTeam(record: TeamRecord): void {
    this.#db.prepare('INSERT INTO teams (id, clock, data) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET clock = excluded.clock, data = excluded.data').run(record.id, record.clock, JSON.stringify(record));
  }

  // ── members, hand-offs, requests ──────────────────────────────────────

  #put(table: SyncedTable, record: { readonly id: string; readonly teamId: string; readonly clock: string; readonly deleted: boolean }): void {
    this.#db
      .prepare(`INSERT INTO ${table} (id, team_id, clock, deleted, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET team_id = excluded.team_id, clock = excluded.clock, deleted = excluded.deleted, data = excluded.data`)
      .run(record.id, record.teamId, record.clock, record.deleted ? 1 : 0, JSON.stringify(record));
  }

  /** Every member (tombstones too: the sync needs them). */
  members(): TeamMemberRecord[] {
    return this.#rows('SELECT data FROM members ORDER BY rowid', [], readMemberRecord);
  }

  putMember(record: TeamMemberRecord): void {
    this.#put('members', record);
  }

  handoffs(): TeamHandoffRecord[] {
    return this.#rows('SELECT data FROM handoffs ORDER BY rowid', [], readHandoffRecord);
  }

  putHandoff(record: TeamHandoffRecord): void {
    this.#put('handoffs', record);
  }

  requests(): TeamRequestRecord[] {
    return this.#rows('SELECT data FROM requests ORDER BY rowid', [], readRequestRecord);
  }

  putRequest(record: TeamRequestRecord): void {
    this.#put('requests', record);
  }

  /** D100-T2: every access record (tombstones too). */
  access(): TeamAccessRecord[] {
    return this.#rows('SELECT data FROM access ORDER BY rowid', [], readAccessRecord);
  }

  putAccess(record: TeamAccessRecord): void {
    this.#put('access', record);
  }

  // ── activity ──────────────────────────────────────────────────────────

  /** A team's activity, newest first (`before` = older than that time). */
  activity(teamId: string, limit = ACTIVITY_CAP, before?: string): TeamActivityRecord[] {
    return before === undefined
      ? this.#rows('SELECT data FROM activity WHERE team_id = ? ORDER BY at DESC, id DESC LIMIT ?', [teamId, limit], readActivityRecord)
      : this.#rows('SELECT data FROM activity WHERE team_id = ? AND at < ? ORDER BY at DESC, id DESC LIMIT ?', [teamId, before, limit], readActivityRecord);
  }

  /** Adds lines (an id already here is skipped) and drops the team's oldest beyond {@link ACTIVITY_CAP}. */
  addActivity(lines: readonly TeamActivityRecord[]): void {
    if (lines.length === 0) return;
    transaction(this.#db, () => {
      const insert = this.#db.prepare('INSERT OR IGNORE INTO activity (id, team_id, at, data) VALUES (?, ?, ?, ?)');
      for (const line of lines) insert.run(line.id, line.teamId, line.at, JSON.stringify(line));
      for (const teamId of new Set(lines.map((line) => line.teamId))) {
        this.#db
          .prepare('DELETE FROM activity WHERE team_id = ? AND id NOT IN (SELECT id FROM activity WHERE team_id = ? ORDER BY at DESC, id DESC LIMIT ?)')
          .run(teamId, teamId, ACTIVITY_CAP);
      }
    });
  }

  /** Runs `fn` in one transaction. */
  transaction<T>(fn: () => T): T {
    return transaction(this.#db, fn);
  }
}
