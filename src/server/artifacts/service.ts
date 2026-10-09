import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Artifact, ArtifactAuthor, ArtifactDetail, ArtifactKind, ArtifactListItem, ArtifactSaveResult } from '../../core/api.ts';
import {
  ARTIFACT_IMAGE_MAX,
  ARTIFACT_IMAGE_TYPES,
  ARTIFACT_TEXT_MAX,
  ARTIFACT_VERSIONS_MAX,
  ARTIFACTS_PER_SESSION_MAX,
  artifactExtension,
  checkArtifactLanguage,
  checkArtifactTitle,
  isArtifactKind,
  textContentProblem,
  utf8Size,
} from '../../core/artifacts.ts';
import { sniffType } from '../../core/attachments.ts';
import type { ArtifactRecord, ArtifactVersionInput, ArtifactVersionRecord } from '../db/repos/artifacts.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { toArtifact } from '../sessions/wire.ts';
import type { HubBus } from '../hub/bus.ts';

/** The data folder's subfolder for image versions: `<dataDir>/artifacts/<id>/<n>.<ext>`. */
export const ARTIFACTS_DIR = 'artifacts';

/** An artifact id as {@link ArtifactService} makes them (10 hex characters); anything else names no artifact. */
const ARTIFACT_ID = /^[a-f0-9]{10}$/;

/** A refusal, sent as `{ error, message }` with `status`. */
export class ArtifactError extends Error {
  override name = 'ArtifactError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  /** The answer's body. */
  body(): { readonly error: string; readonly message: string } {
    return { error: this.code, message: this.message };
  }
}

/** Options of {@link ArtifactService}. */
export interface ArtifactServiceOptions {
  readonly store: Store;
  readonly bus: HubBus;
  readonly dataDir: string;
  /** Publishes the session's `sessionUpdated` (the header's Artifacts count). */
  readonly announce?: (sessionId: string) => Promise<void>;
  /** A new artifact id (tests pin it). */
  readonly newId?: () => string;
}

/** A version's bytes as the `raw` route serves them. */
export interface ArtifactRaw {
  readonly artifact: ArtifactRecord;
  readonly version: ArtifactVersionRecord;
  readonly bytes: Buffer;
}

/** The raw fields of a save (`ArtifactSaveInput` as it arrived). */
type SaveBody = Readonly<Record<string, unknown>>;

/**
 * D89 · artifacts saved on purpose (`docs/artifacts.md`): the session's agent saves
 * them through `/agent/v1/artifacts` (`artifact_save`), the developer through
 * `POST /api/sessions/{id}/artifacts` (Save as artifact). A save with the id of one
 * of the session's artifacts adds a version. Text versions live in the database;
 * image versions in `<dataDir>/artifacts/<id>/<n>.<ext>` (folder 0700, files 0600).
 * A `path` (the agent's only) is copied at save time, and only from inside the
 * session's working folders (its folder, its working folder, its worktrees),
 * symbolic links resolved first. Every change publishes `artifactsChanged` and the
 * session's `sessionUpdated`.
 */
export class ArtifactService {
  readonly #store: Store;
  readonly #bus: HubBus;
  readonly #root: string;
  readonly #dataDir: string;
  readonly #announce: ((sessionId: string) => Promise<void>) | null;
  readonly #newId: () => string;

  constructor(options: ArtifactServiceOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#dataDir = options.dataDir;
    this.#root = path.join(options.dataDir, ARTIFACTS_DIR);
    this.#announce = options.announce ?? null;
    this.#newId = options.newId ?? (() => randomBytes(5).toString('hex'));
  }

  async #session(sessionId: string): Promise<SessionRecord> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) throw new ArtifactError(404, 'not-found', `no session ${sessionId}`);
    return session;
  }

  /** Artifact `artifactId` of session `sessionId`, else 404. */
  async #artifact(sessionId: string, artifactId: string): Promise<ArtifactRecord> {
    const record = ARTIFACT_ID.test(artifactId) ? await this.#store.artifacts.get(artifactId) : null;
    if (!record || record.sessionId !== sessionId) throw new ArtifactError(404, 'not-found', `no artifact ${artifactId} in this session (artifact_list shows the ids)`);
    return record;
  }

  /** The session's artifacts, newest first. */
  async list(sessionId: string): Promise<Artifact[]> {
    await this.#session(sessionId);
    return (await this.#store.artifacts.list({ sessionId })).map(toArtifact);
  }

  /** One artifact, its versions and one version's text (the latest unless `version` names another). */
  async detail(sessionId: string, artifactId: string, version?: unknown): Promise<ArtifactDetail> {
    await this.#session(sessionId);
    const record = await this.#artifact(sessionId, artifactId);
    const n = version === undefined || version === null || version === '' ? record.versions : Number(version);
    if (!Number.isInteger(n) || n < 1) throw new ArtifactError(422, 'invalid', 'version must be a whole number from 1');
    const chosen = await this.#store.artifacts.version(record.id, n);
    if (!chosen) throw new ArtifactError(404, 'not-found', `artifact ${artifactId} has no version ${n} (it has ${record.versions})`);
    const versions = await this.#store.artifacts.versions(record.id);
    return { ...toArtifact(record), versionList: versions.map(versionInfo), version: { ...versionInfo(chosen), content: chosen.content } };
  }

  /** A version's bytes (text as UTF-8), for the `raw` route. */
  async raw(sessionId: string, artifactId: string, n: unknown): Promise<ArtifactRaw> {
    await this.#session(sessionId);
    const record = await this.#artifact(sessionId, artifactId);
    const number = Number(n);
    const version = Number.isInteger(number) && number >= 1 ? await this.#store.artifacts.version(record.id, number) : null;
    if (!version) throw new ArtifactError(404, 'not-found', `artifact ${artifactId} has no version ${String(n)}`);
    if (version.content !== null) return { artifact: record, version, bytes: Buffer.from(version.content, 'utf8') };
    const file = this.#fileOf(version.file);
    try {
      return { artifact: record, version, bytes: await readFile(file) };
    } catch {
      throw new ArtifactError(404, 'not-found', `the file of artifact ${artifactId} version ${version.n} is gone`);
    }
  }

  /** An image version's absolute path; refuses anything outside the artifacts folder. */
  #fileOf(relative: string | null): string {
    const file = path.resolve(this.#dataDir, relative ?? '');
    if (relative === null || !file.startsWith(this.#root + path.sep)) throw new ArtifactError(404, 'not-found', 'no such artifact file');
    return file;
  }

  /**
   * Saves an artifact for session `sessionId` (D89): a new one, or with `id` a new
   * version of one of its artifacts. `author` = who saves; only the agent may give a
   * `path`. 404 unknown session / artifact; 422 a bad field; 409 too many artifacts
   * or versions; 413 too large.
   */
  async save(sessionId: string, body: unknown, author: ArtifactAuthor): Promise<ArtifactSaveResult> {
    const session = await this.#session(sessionId);
    const input: SaveBody = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as SaveBody) : {};
    const title = checkArtifactTitle(input['title']);
    if (!title.ok) throw new ArtifactError(422, 'invalid', title.message);
    const kind = input['kind'];
    if (!isArtifactKind(kind)) throw new ArtifactError(422, 'invalid', 'kind must be one of markdown, code, html, mermaid, svg, image, csv');
    const language = checkArtifactLanguage(input['language']);
    if (!language.ok) throw new ArtifactError(422, 'invalid', language.message);
    const id = typeof input['id'] === 'string' && input['id'].trim() !== '' ? input['id'].trim().replace(/^\[|\]$/g, '') : null;
    const existing = id === null ? null : await this.#artifact(sessionId, id);
    if (existing && existing.kind !== kind) throw new ArtifactError(422, 'invalid', `artifact ${existing.id} is ${existing.kind}: a new version keeps its kind (save a new artifact for another kind)`);
    if (existing && existing.versions >= ARTIFACT_VERSIONS_MAX) throw new ArtifactError(409, 'too-many', `artifact ${existing.id} has ${ARTIFACT_VERSIONS_MAX} versions, the most it keeps: save a new artifact`);
    if (!existing && (await this.#store.artifacts.count(sessionId)) >= ARTIFACTS_PER_SESSION_MAX) {
      throw new ArtifactError(409, 'too-many', `this session has ${ARTIFACTS_PER_SESSION_MAX} artifacts, the most it keeps: update one with its id instead`);
    }
    const content = await this.#content(session, kind, input, author);
    const artifactId = existing?.id ?? (await this.#freshId());
    const n = existing ? existing.versions + 1 : 1;
    let version: ArtifactVersionInput;
    if (content.kind === 'image') {
      const relative = path.join(ARTIFACTS_DIR, artifactId, `${n}.${artifactExtension('image', null, content.mediaType)}`);
      await mkdir(path.join(this.#root, artifactId), { recursive: true, mode: 0o700 });
      await writeFile(path.join(this.#dataDir, relative), content.bytes, { mode: 0o600 });
      version = { content: null, file: relative.split(path.sep).join('/'), mediaType: content.mediaType, size: content.bytes.length, createdBy: author };
    } else {
      version = { content: content.text, file: null, mediaType: null, size: utf8Size(content.text), createdBy: author };
    }
    const lang = kind === 'code' ? language.value : null;
    const saved = existing
      ? await this.#store.artifacts.addVersion(existing.id, { title: title.value, language: lang, version })
      : await this.#store.artifacts.create({ id: artifactId, sessionId, title: title.value, kind, language: lang, version });
    if (!saved) throw new ArtifactError(404, 'not-found', `no artifact ${artifactId} in this session`);
    await this.#changed(sessionId, saved.id, 'saved');
    return { artifact: toArtifact(saved), version: saved.versions, created: existing === null };
  }

  async #freshId(): Promise<string> {
    for (;;) {
      const id = this.#newId();
      if (!(await this.#store.artifacts.get(id))) return id;
    }
  }

  /** The version's text or image bytes, from `content` or (the agent's) `path`. */
  async #content(
    session: SessionRecord,
    kind: ArtifactKind,
    input: SaveBody,
    author: ArtifactAuthor,
  ): Promise<{ readonly kind: 'text'; readonly text: string } | { readonly kind: 'image'; readonly bytes: Buffer; readonly mediaType: string }> {
    const hasContent = typeof input['content'] === 'string';
    const hasPath = typeof input['path'] === 'string' && input['path'].trim() !== '';
    if (hasContent && hasPath) throw new ArtifactError(422, 'invalid', 'give content or path, not both');
    if (hasPath && author !== 'agent') throw new ArtifactError(422, 'invalid', 'path is for the agent (artifact_save); give content');
    if (kind === 'image') {
      if (!hasPath) throw new ArtifactError(422, 'invalid', 'an image artifact needs path: a png, jpg, gif or webp file in the session\'s working folders');
      const bytes = await this.#readSessionFile(session, input['path'] as string, ARTIFACT_IMAGE_MAX);
      const sniffed = sniffType(bytes);
      if (!sniffed || !ARTIFACT_IMAGE_TYPES[sniffed]) throw new ArtifactError(422, 'invalid', 'the file is not a png, jpg, gif or webp image');
      return { kind: 'image', bytes, mediaType: sniffed };
    }
    let text: string;
    if (hasPath) {
      const bytes = await this.#readSessionFile(session, input['path'] as string, ARTIFACT_TEXT_MAX);
      if (bytes.includes(0)) throw new ArtifactError(422, 'invalid', `the file is not text: a ${kind} artifact is text`);
      text = bytes.toString('utf8');
    } else if (hasContent) {
      text = input['content'] as string;
    } else {
      throw new ArtifactError(422, 'invalid', 'give content (the text) or path (a file to copy in)');
    }
    const problem = textContentProblem(kind, text);
    if (problem) throw new ArtifactError(problem.startsWith('content must be at most') ? 413 : 422, problem.startsWith('content must be at most') ? 'too-large' : 'invalid', problem);
    return { kind: 'text', text };
  }

  /**
   * A file the agent names: relative to the session's working folder, and (symbolic
   * links resolved) inside its folder, its working folder or one of its worktrees;
   * a regular file of at most `max` bytes.
   */
  async #readSessionFile(session: SessionRecord, given: string, max: number): Promise<Buffer> {
    const base = session.cwd ?? session.root;
    if (!base) throw new ArtifactError(422, 'invalid', 'this session has no working folder to copy a file from: give content');
    let real: string;
    try {
      real = await realpath(path.resolve(base, given.trim()));
    } catch {
      throw new ArtifactError(422, 'invalid', `no file ${given}`);
    }
    const worktrees = await this.#store.worktrees.list({ sessionId: session.id });
    const roots = [session.root, session.cwd, ...worktrees.map((worktree) => worktree.path)].filter((dir): dir is string => typeof dir === 'string' && dir !== '');
    const realRoots = await Promise.all(roots.map((dir) => realpath(dir).catch(() => null)));
    const inside = realRoots.some((dir) => dir !== null && real.startsWith(dir + path.sep));
    if (!inside) throw new ArtifactError(422, 'invalid', `${given} is outside the session's working folders`);
    const info = await stat(real);
    if (!info.isFile()) throw new ArtifactError(422, 'invalid', `${given} is not a file`);
    if (info.size === 0) throw new ArtifactError(422, 'invalid', `${given} is empty`);
    if (info.size > max) throw new ArtifactError(413, 'too-large', `${given} is larger than ${max / 1024 / 1024} MB`);
    return readFile(real);
  }

  /** Deletes an artifact with every version (and its image files). */
  async remove(sessionId: string, artifactId: string): Promise<void> {
    await this.#session(sessionId);
    const record = await this.#artifact(sessionId, artifactId);
    await this.#store.artifacts.delete(record.id);
    await rm(path.join(this.#root, record.id), { recursive: true, force: true });
    await this.#changed(sessionId, record.id, 'deleted');
  }

  /** Every artifact of this machine as the Artifacts page lists it (session name, title and folder), newest first. */
  async listAll(): Promise<ArtifactListItem[]> {
    const records = await this.#store.artifacts.list();
    const sessions = new Map((await this.#store.sessions.list()).map((session) => [session.id, session]));
    return records.map((record) => {
      const session = record.sessionId ? (sessions.get(record.sessionId) ?? null) : null;
      return {
        ...toArtifact(record),
        sessionName: session?.name ?? null,
        sessionTitle: session ? (session.title ?? session.name) : null,
        folder: session?.folderId ?? null,
        folderPath: session?.root ?? null,
      };
    });
  }

  async #changed(sessionId: string, artifactId: string, change: 'saved' | 'deleted'): Promise<void> {
    this.#bus.publish('artifactsChanged', { sessionId, artifactId, change });
    await this.#announce?.(sessionId).catch(() => undefined);
  }
}

function versionInfo(version: Pick<ArtifactVersionRecord, 'n' | 'size' | 'createdBy' | 'createdAt'>): ArtifactDetail['versionList'][number] {
  return { n: version.n, size: version.size, createdBy: version.createdBy, createdAt: version.createdAt };
}
