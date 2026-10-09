import type { ArtifactAuthor, ArtifactKind } from '../../../core/api.ts';
import type { RepoContext } from '../context.ts';
import { transaction } from '../database.ts';
import { type Row, StoreError, Table, type TableSpec } from '../table.ts';

/** D89 (0039): an artifact saved on purpose, with its latest version's number and size. */
export interface ArtifactRecord {
  readonly id: string;
  readonly sessionId: string | null;
  readonly title: string;
  readonly kind: ArtifactKind;
  readonly language: string | null;
  readonly createdBy: ArtifactAuthor;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The latest version's number (= how many versions there are). */
  readonly versions: number;
  /** The latest version's size in bytes. */
  readonly size: number;
}

/** D89 (0039): one version of an artifact. */
export interface ArtifactVersionRecord {
  readonly artifactId: string;
  readonly n: number;
  /** A text kind's text; `null` for an image. */
  readonly content: string | null;
  /** An image's file, relative to the data folder (`artifacts/<id>/<n>.<ext>`); `null` for text. */
  readonly file: string | null;
  /** An image's sniffed type; `null` for text. */
  readonly mediaType: string | null;
  readonly size: number;
  readonly createdBy: ArtifactAuthor;
  readonly createdAt: string;
}

/** A version to add ({@link ArtifactRepository.create} / {@link ArtifactRepository.addVersion}). */
export interface ArtifactVersionInput {
  readonly content: string | null;
  readonly file: string | null;
  readonly mediaType: string | null;
  readonly size: number;
  readonly createdBy: ArtifactAuthor;
}

const VERSION_SPEC: TableSpec<ArtifactVersionRecord> = {
  table: 'artifact_versions',
  key: 'artifactId',
  fields: {
    artifactId: ['artifact_id', 'text'],
    n: ['n', 'int'],
    content: ['content', 'text'],
    file: ['file', 'text'],
    mediaType: ['media_type', 'text'],
    size: ['size', 'int'],
    createdBy: ['created_by', 'text'],
    createdAt: ['created_at', 'text'],
  },
};

/** The artifact columns plus its latest version's number and size. */
const SELECT = `SELECT a.id, a.session_id, a.title, a.kind, a.language, a.created_by, a.created_at, a.updated_at,
  v.n AS versions, v.size AS size
  FROM artifacts_saved a JOIN artifact_versions v ON v.artifact_id = a.id AND v.n = (SELECT MAX(n) FROM artifact_versions WHERE artifact_id = a.id)`;

function fromRow(row: Row): ArtifactRecord {
  return {
    id: String(row['id']),
    sessionId: row['session_id'] === null ? null : String(row['session_id']),
    title: String(row['title']),
    kind: String(row['kind']) as ArtifactKind,
    language: row['language'] === null ? null : String(row['language']),
    createdBy: String(row['created_by']) as ArtifactAuthor,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    versions: Number(row['versions']),
    size: Number(row['size']),
  };
}

/** D89: saved artifacts and their versions (`docs/artifacts.md`, `docs/database.md` → 0039). */
export class ArtifactRepository {
  readonly #ctx: RepoContext;
  readonly #versions: Table<ArtifactVersionRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#versions = new Table(ctx.db, VERSION_SPEC);
  }

  /** Creates an artifact with its first version (in one transaction). */
  async create(input: {
    readonly id: string;
    readonly sessionId: string | null;
    readonly title: string;
    readonly kind: ArtifactKind;
    readonly language: string | null;
    readonly version: ArtifactVersionInput;
  }): Promise<ArtifactRecord> {
    transaction(this.#ctx.db, () => {
      const ts = this.#ctx.now();
      this.#versions
        .statement('INSERT INTO artifacts_saved (id, session_id, title, kind, language, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.id, input.sessionId, input.title, input.kind, input.language, input.version.createdBy, ts, ts);
      this.#insertVersion(input.id, 1, input.version, ts);
    });
    const created = await this.get(input.id);
    if (!created) throw new StoreError('not-found', `artifact ${input.id} vanished`);
    return created;
  }

  /** Adds version `latest + 1` to artifact `id` (its title and language may change with it); `null` when there is no such artifact. */
  async addVersion(id: string, input: { readonly title: string; readonly language: string | null; readonly version: ArtifactVersionInput }): Promise<ArtifactRecord | null> {
    const added = transaction(this.#ctx.db, () => {
      const row = this.#versions.statement('SELECT MAX(n) AS n FROM artifact_versions WHERE artifact_id = ?').get(id);
      const latest = Number(row?.['n'] ?? 0);
      if (latest === 0) return false;
      const ts = this.#ctx.now();
      this.#insertVersion(id, latest + 1, input.version, ts);
      this.#versions.statement('UPDATE artifacts_saved SET title = ?, language = ?, updated_at = ? WHERE id = ?').run(input.title, input.language, ts, id);
      return true;
    });
    return added ? this.get(id) : null;
  }

  #insertVersion(id: string, n: number, version: ArtifactVersionInput, ts: string): void {
    this.#versions
      .statement('INSERT INTO artifact_versions (artifact_id, n, content, file, media_type, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, n, version.content, version.file, version.mediaType, version.size, version.createdBy, ts);
  }

  async get(id: string): Promise<ArtifactRecord | null> {
    const row = this.#versions.statement(`${SELECT} WHERE a.id = ?`).get(id);
    return row ? fromRow(row) : null;
  }

  /** Artifacts (of one session when `sessionId` is given), the most recently saved first. */
  async list(query: { readonly sessionId?: string } = {}): Promise<ArtifactRecord[]> {
    const rows =
      query.sessionId === undefined
        ? this.#versions.statement(`${SELECT} ORDER BY a.updated_at DESC, a.rowid DESC`).all()
        : this.#versions.statement(`${SELECT} WHERE a.session_id = ? ORDER BY a.updated_at DESC, a.rowid DESC`).all(query.sessionId);
    return rows.map(fromRow);
  }

  /** How many artifacts session `sessionId` has. */
  async count(sessionId: string): Promise<number> {
    const row = this.#versions.statement('SELECT COUNT(*) AS n FROM artifacts_saved WHERE session_id = ?').get(sessionId);
    return Number(row?.['n'] ?? 0);
  }

  /** An artifact's versions, oldest first, without their text. */
  async versions(id: string): Promise<ArtifactVersionRecord[]> {
    return this.#versions
      .statement('SELECT artifact_id, n, NULL AS content, file, media_type, size, created_by, created_at FROM artifact_versions WHERE artifact_id = ? ORDER BY n')
      .all(id)
      .map((row) => this.#versions.fromRow(row));
  }

  /** One version with its text, `null` when there is none. */
  async version(id: string, n: number): Promise<ArtifactVersionRecord | null> {
    const row = this.#versions.statement('SELECT * FROM artifact_versions WHERE artifact_id = ? AND n = ?').get(id, n);
    return row ? this.#versions.fromRow(row) : null;
  }

  /** Deletes an artifact and its versions (their files are the caller's). */
  async delete(id: string): Promise<boolean> {
    const result = this.#versions.statement('DELETE FROM artifacts_saved WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }
}
