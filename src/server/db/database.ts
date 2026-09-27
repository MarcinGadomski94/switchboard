import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** File name of the database inside the data folder (decisions gap #18). */
export const DB_FILE = 'switchboard.db';

/** How long a statement waits for a lock held by another connection, in ms. */
export const BUSY_TIMEOUT_MS = 5_000;

/**
 * Opens (and creates) a SQLite database with Switchboard's connection settings:
 * WAL journal, foreign keys on, `busy_timeout`, `synchronous = NORMAL`. The parent
 * folder is created (0700) when missing. `:memory:` is accepted for throwaway use,
 * but tests use temp files.
 */
export async function openDatabase(file: string): Promise<DatabaseSync> {
  if (file !== ':memory:') {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: BUSY_TIMEOUT_MS });
  try {
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Runs `fn` inside one `BEGIN IMMEDIATE … COMMIT` transaction and rolls back when it
 * throws. `fn` is synchronous on purpose: node:sqlite is synchronous, and an `await`
 * inside a transaction would let unrelated statements join it. Nested calls run
 * inside the outer transaction.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
