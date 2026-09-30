import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.ts';

/** Folder of the plain SQL migrations shipped with the server. */
export const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

/** Table that records the applied migrations. */
export const MIGRATIONS_TABLE = 'schema_migrations';

/** Migration file names: `NNNN_name.sql` (4-digit version, lowercase name). */
const FILE_PATTERN = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/;

/**
 * Checksums an applied migration may also carry, per version: the file was
 * reworded after release without changing what it does, so databases that ran the
 * earlier text are still current. Only for edits that leave the effect identical;
 * anything else needs a new migration.
 * - 0002: the example tool's name in the file (not in the databases it already
 *   ran on) was renamed when the repository went public (2026-09-30).
 */
export const LEGACY_CHECKSUMS: ReadonlyMap<number, readonly string[]> = new Map([
  [2, ['f2b7c4b7ea05f28959187e8420eb3649d599445ec32481cdff0c977e2213b375']],
]);

/** `true` when `recorded` is `migration`'s checksum or one of its {@link LEGACY_CHECKSUMS}. */
export function checksumMatches(migration: Migration, recorded: string, legacy: ReadonlyMap<number, readonly string[]> = LEGACY_CHECKSUMS): boolean {
  return migration.checksum === recorded || (legacy.get(migration.version) ?? []).includes(recorded);
}

/** One plain SQL migration. */
export interface Migration {
  /** From the file name; unique, ascending. */
  readonly version: number;
  /** From the file name, without the version and extension. */
  readonly name: string;
  /** The file's SQL (line endings normalized to `\n`). */
  readonly sql: string;
  /** sha256 hex of {@link sql}; an applied migration must never change. */
  readonly checksum: string;
}

/** What {@link migrate} did. */
export interface MigrationResult {
  /** Versions applied by this call, ascending. Empty when the database was current. */
  readonly applied: number[];
  /** The database version after the call (0 = empty). */
  readonly version: number;
}

/** An applied migration as recorded in {@link MIGRATIONS_TABLE}. */
export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

/** A migration problem: bad file names, an edited migration, a newer database, or a failing script. */
export class MigrationError extends Error {
  override name = 'MigrationError';
}

/** sha256 hex of `sql` after normalizing line endings (checkouts with CRLF keep the same checksum). */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(normalize(sql)).digest('hex');
}

function normalize(sql: string): string {
  return sql.replace(/\r\n?/g, '\n');
}

/** Builds a {@link Migration} from its parts (tests and {@link loadMigrations}). */
export function makeMigration(version: number, name: string, sql: string): Migration {
  const text = normalize(sql);
  return { version, name, sql: text, checksum: checksumOf(text) };
}

/**
 * Reads every `NNNN_name.sql` in `dir`, sorted by version.
 * @throws {MigrationError} for a `.sql` file with another name or a duplicate version.
 */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = FILE_PATTERN.exec(file);
    if (!match) throw new MigrationError(`migration file "${file}" does not match NNNN_name.sql`);
    const version = Number(match[1]);
    if (version === 0) throw new MigrationError(`migration file "${file}": version 0000 is reserved`);
    migrations.push(makeMigration(version, match[2] ?? '', await readFile(path.join(dir, file), 'utf8')));
  }
  checkOrder(migrations);
  return migrations;
}

function checkOrder(migrations: readonly Migration[]): void {
  for (let i = 1; i < migrations.length; i += 1) {
    const previous = migrations[i - 1];
    const current = migrations[i];
    if (previous && current && current.version <= previous.version) {
      throw new MigrationError(`duplicate or unordered migration version ${current.version}`);
    }
  }
}

/** Applied migrations, ascending; empty when the table does not exist yet. */
export function appliedMigrations(db: DatabaseSync): AppliedMigration[] {
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(MIGRATIONS_TABLE);
  if (!table) return [];
  return db
    .prepare(`SELECT version, name, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version`)
    .all()
    .map((row) => ({
      version: Number(row['version']),
      name: String(row['name']),
      checksum: String(row['checksum']),
      appliedAt: String(row['applied_at']),
    }));
}

/**
 * Brings `db` up to date: every migration not yet recorded runs in its own
 * transaction together with its `schema_migrations` row, so a failing script leaves
 * nothing behind. Running it again on a current database changes nothing.
 * @throws {MigrationError} when an applied migration's checksum differs from the file
 * (migrations are never edited), when the database has a version this build does not
 * know (made by a newer Switchboard), or when a script fails.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[], now: () => Date = () => new Date()): MigrationResult {
  checkOrder(migrations);
  db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    applied_at  TEXT NOT NULL
  ) STRICT`);

  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  const applied = appliedMigrations(db);
  for (const row of applied) {
    const migration = known.get(row.version);
    if (!migration) {
      throw new MigrationError(
        `the database has migration ${row.version} (${row.name}), which this build does not know; it was made by a newer Switchboard`,
      );
    }
    if (!checksumMatches(migration, row.checksum)) {
      throw new MigrationError(
        `migration ${row.version} (${row.name}) was changed after it was applied; add a new migration instead of editing it`,
      );
    }
  }

  const done = new Set(applied.map((row) => row.version));
  const newlyApplied: number[] = [];
  for (const migration of migrations) {
    if (done.has(migration.version)) continue;
    try {
      transaction(db, () => {
        db.exec(migration.sql);
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new MigrationError(`foreign key violations after the script: ${JSON.stringify(violations)}`);
        }
        db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`).run(
          migration.version,
          migration.name,
          migration.checksum,
          now().toISOString(),
        );
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new MigrationError(`migration ${migration.version} (${migration.name}) failed: ${reason}`, { cause: error });
    }
    newlyApplied.push(migration.version);
  }

  const last = migrations.at(-1);
  return { applied: newlyApplied, version: last ? last.version : 0 };
}
