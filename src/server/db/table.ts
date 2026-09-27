import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';

/**
 * How a record field is stored: `text`/`int`/`real` as is, `bool` as 0/1, `json` as
 * JSON text. A SQL `NULL` always maps to `null`.
 */
export type FieldType = 'text' | 'int' | 'real' | 'bool' | 'json';

/** Column name + storage type of one record field. */
export type FieldSpec = readonly [column: string, type: FieldType];

/** Maps every field of record `R` (camelCase) to its column (snake_case). */
export type Fields<R> = { readonly [K in keyof R]-?: FieldSpec };

/** A table and its record mapping. */
export interface TableSpec<R> {
  readonly table: string;
  /** The primary-key field. */
  readonly key: keyof R & string;
  readonly fields: Fields<R>;
}

/** A database row as node:sqlite returns it. */
export type Row = Record<string, SQLOutputValue>;

/** Why a repository refused an operation. */
export type StoreErrorCode = 'not-found' | 'conflict' | 'invalid';

/** A repository-level refusal (the database itself throws its own errors for constraint violations). */
export class StoreError extends Error {
  override name = 'StoreError';
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Drops `undefined` values so they do not override defaults. */
export function defined<T extends object>(value: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, field] of Object.entries(value) as Array<[keyof T, T[keyof T]]>) {
    if (field !== undefined) result[key] = field;
  }
  return result;
}

/**
 * Thin typed mapper between records and one table's rows. Column names come only
 * from the {@link TableSpec}, never from callers, so building SQL from them is safe;
 * every value is a bound parameter. All methods are synchronous (node:sqlite is);
 * the repositories wrap them in Promise-returning methods.
 */
export class Table<R extends object> {
  readonly db: DatabaseSync;
  readonly spec: TableSpec<R>;
  readonly #entries: ReadonlyArray<readonly [keyof R & string, FieldSpec]>;
  readonly #statements = new Map<string, StatementSync>();

  constructor(db: DatabaseSync, spec: TableSpec<R>) {
    this.db = db;
    this.spec = spec;
    this.#entries = Object.entries(spec.fields) as Array<[keyof R & string, FieldSpec]>;
  }

  /** A cached prepared statement. */
  statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** Converts a row of this table to a record. */
  fromRow(row: Row): R {
    const record: Record<string, unknown> = {};
    for (const [field, [column, type]] of this.#entries) {
      const value = row[column];
      record[field] = value === null || value === undefined ? null : decode(type, value, `${this.spec.table}.${column}`);
    }
    return record as R;
  }

  #column(field: string): FieldSpec {
    const spec = (this.spec.fields as Record<string, FieldSpec | undefined>)[field];
    if (!spec) throw new StoreError('invalid', `${this.spec.table}: unknown field "${field}"`);
    return spec;
  }

  #pairs(values: Partial<R>): Array<[string, SQLInputValue]> {
    const pairs: Array<[string, SQLInputValue]> = [];
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const [column, type] = this.#column(field);
      pairs.push([column, encode(type, value, `${this.spec.table}.${column}`)]);
    }
    return pairs;
  }

  /** Inserts the defined fields (the table's defaults fill the rest) and returns the stored record. */
  insert(values: Partial<R>): R {
    const pairs = this.#pairs(values);
    const sql = pairs.length === 0
      ? `INSERT INTO ${this.spec.table} DEFAULT VALUES RETURNING *`
      : `INSERT INTO ${this.spec.table} (${pairs.map(([column]) => column).join(', ')}) VALUES (${pairs.map(() => '?').join(', ')}) RETURNING *`;
    const row = this.statement(sql).get(...pairs.map(([, value]) => value));
    if (!row) throw new StoreError('invalid', `${this.spec.table}: insert returned no row`);
    return this.fromRow(row);
  }

  /** The record with primary key `key`, or `null`. */
  get(key: SQLInputValue): R | null {
    const [column] = this.#column(this.spec.key);
    const row = this.statement(`SELECT * FROM ${this.spec.table} WHERE ${column} = ?`).get(key);
    return row ? this.fromRow(row) : null;
  }

  /** Updates the defined fields of record `key`; returns the updated record, or `null` if there is none. */
  update(key: SQLInputValue, patch: Partial<R>): R | null {
    const [keyColumn] = this.#column(this.spec.key);
    const pairs = this.#pairs(patch).filter(([column]) => column !== keyColumn);
    if (pairs.length === 0) return this.get(key);
    const sql = `UPDATE ${this.spec.table} SET ${pairs.map(([column]) => `${column} = ?`).join(', ')} WHERE ${keyColumn} = ? RETURNING *`;
    const row = this.statement(sql).get(...pairs.map(([, value]) => value), key);
    return row ? this.fromRow(row) : null;
  }

  /** Deletes record `key`; `true` if it existed. */
  delete(key: SQLInputValue): boolean {
    const [column] = this.#column(this.spec.key);
    const result = this.statement(`DELETE FROM ${this.spec.table} WHERE ${column} = ?`).run(key);
    return Number(result.changes) > 0;
  }

  /** Records matching a SQL condition (`?` parameters) in the given order. `where` and `orderBy` are trusted SQL written by the repository. */
  select(where: string, params: readonly SQLInputValue[] = [], orderBy = '', limit?: number): R[] {
    let sql = `SELECT * FROM ${this.spec.table}`;
    if (where) sql += ` WHERE ${where}`;
    if (orderBy) sql += ` ORDER BY ${orderBy}`;
    const args = [...params];
    if (limit !== undefined) {
      sql += ' LIMIT ?';
      args.push(limit);
    }
    return this.statement(sql).all(...args).map((row) => this.fromRow(row));
  }

  /** The first record matching the condition, or `null`. */
  first(where: string, params: readonly SQLInputValue[] = [], orderBy = ''): R | null {
    return this.select(where, params, orderBy, 1)[0] ?? null;
  }
}

function decode(type: FieldType, value: SQLOutputValue, where: string): unknown {
  switch (type) {
    case 'text':
      return typeof value === 'string' ? value : String(value);
    case 'int':
    case 'real':
      return Number(value);
    case 'bool':
      return Number(value) === 1;
    case 'json':
      if (typeof value !== 'string') throw new StoreError('invalid', `${where}: expected JSON text`);
      return JSON.parse(value);
  }
}

function encode(type: FieldType, value: unknown, where: string): SQLInputValue {
  if (value === null) return null;
  switch (type) {
    case 'text':
      if (typeof value !== 'string') throw new StoreError('invalid', `${where}: expected a string`);
      return value;
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) throw new StoreError('invalid', `${where}: expected an integer`);
      return value;
    case 'real':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new StoreError('invalid', `${where}: expected a number`);
      return value;
    case 'bool':
      if (typeof value !== 'boolean') throw new StoreError('invalid', `${where}: expected a boolean`);
      return value ? 1 : 0;
    case 'json': {
      const text = JSON.stringify(value);
      if (text === undefined) throw new StoreError('invalid', `${where}: value is not JSON-serializable`);
      return text;
    }
  }
}
