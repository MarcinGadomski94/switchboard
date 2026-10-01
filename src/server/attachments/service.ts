import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ATTACHMENT_RETENTION_DAYS,
  type Attachment,
  type AttachedFile,
  type UserContentBlock,
  attachedFilesText,
  fileCapProblem,
  inlineBlock,
  kindOf,
  messageCapProblem,
  pdfPageCount,
  planDelivery,
  safeFileName,
  servedType,
  sniffType,
} from '../../core/attachments.ts';
import type { AttachmentRecord } from '../db/repos/attachments.ts';
import type { Store } from '../db/store.ts';

/** The attachments' folder inside the data folder. */
export const ATTACHMENTS_DIR = 'attachments';

/** The folder of staged uploads (the New-session form's, before their session exists). */
export const STAGED_DIR = '_staged';

/** A refusal of an attachment call, sent as `{ error, message }` (422 `invalid` with `errors` for a field). */
export class AttachmentError extends Error {
  override name = 'AttachmentError';
  readonly status: number;
  readonly code: string;
  readonly field: string | null;
  constructor(status: number, code: string, message: string, field: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }

  /** The answer's body. */
  body(): Record<string, unknown> {
    if (this.status === 422 && this.field !== null) return { error: 'invalid', errors: [{ field: this.field, message: this.message }] };
    return { error: this.code, message: this.message };
  }
}

/** A message's attachments, ready for the agent (D57): the listing, the inline blocks and the files' lines. */
export interface PreparedAttachments {
  /** The listing the message's event keeps (each with its delivery), in the order given. */
  readonly refs: readonly Attachment[];
  /** The images and PDFs that go inline, as content blocks, in order. */
  readonly blocks: readonly UserContentBlock[];
  /** `Attached files: …` with the absolute paths of the ones that go as files; `''` for none. */
  readonly filesText: string;
}

/** No attachments. */
export const NO_ATTACHMENTS: PreparedAttachments = { refs: [], blocks: [], filesText: '' };

/** A session id or attachment id that may name a folder or file (never a path). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Base64 (standard alphabet, padding optional, whitespace allowed between lines). */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The listing of a stored row. */
export function toAttachment(record: AttachmentRecord, delivery?: Attachment['delivery']): Attachment {
  return { id: record.id, name: record.name, size: record.size, kind: record.kind, mediaType: record.mediaType, ...(delivery ? { delivery } : {}) };
}

/**
 * `attachments` of a message or start body: absent → `[]`; a list of distinct
 * ids → it; anything else → `null`.
 */
export function parseAttachmentIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && SAFE_ID.test(id))) return null;
  return new Set(value).size === value.length ? (value as string[]) : null;
}

/** Options of {@link AttachmentService}. */
export interface AttachmentServiceOptions {
  readonly dataDir: string;
  readonly store: Store;
  readonly now?: () => Date;
}

/**
 * D57 · the attachments' storage (`docs/chat.md` → *Attachments*,
 * `docs/security.md` → *Attachments*): `<dataDir>/attachments/<session id>/<id>-<name>`
 * (folder 0700, files 0600), one `attachments` row each. Uploads are sniffed
 * (images / PDFs by their magic bytes, everything else is a file), capped, and
 * never written outside that folder (ids are checked, names sanitized). A
 * message's attachments become content blocks (inline) or the lines naming their
 * paths (files). Anything older than 30 days, and whatever no row or session
 * owns any more, is removed at start ({@link cleanup}).
 */
export class AttachmentService {
  readonly #root: string;
  readonly #store: Store;
  readonly #now: () => Date;

  constructor(options: AttachmentServiceOptions) {
    this.#root = path.join(options.dataDir, ATTACHMENTS_DIR);
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
  }

  /** The attachments' root folder. */
  get root(): string {
    return this.#root;
  }

  #folder(sessionId: string | null): string {
    if (sessionId === null) return path.join(this.#root, STAGED_DIR);
    if (!SAFE_ID.test(sessionId) || sessionId === STAGED_DIR) throw new AttachmentError(404, 'not-found', `no session ${sessionId}`);
    return path.join(this.#root, sessionId);
  }

  /** The absolute path of a stored attachment's file. */
  pathOf(record: AttachmentRecord): string {
    return path.join(this.#folder(record.sessionId), record.file);
  }

  /**
   * Stores one uploaded file (`{ name, data }`, base64) for `sessionId` (`null` =
   * staged for a New-session start). 422 for a body that is not that, an empty
   * file or one over the cap.
   */
  async upload(sessionId: string | null, body: unknown): Promise<Attachment> {
    const input = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    if (!input || typeof input['data'] !== 'string') throw new AttachmentError(422, 'invalid', 'the body must be { name, data } with the file as base64', 'data');
    const data = input['data'].replace(/\s+/g, '');
    if (!BASE64.test(data) || data.length % 4 === 1) throw new AttachmentError(422, 'invalid', 'data must be base64', 'data');
    const bytes = Buffer.from(data, 'base64');
    const problem = fileCapProblem(bytes.length);
    if (problem) throw new AttachmentError(problem.startsWith('a file is at most') ? 413 : 422, 'too-large', problem, 'data');
    const name = safeFileName(input['name']);
    const sniffed = sniffType(bytes);
    const kind = kindOf(sniffed);
    const id = randomUUID();
    const file = `${id}-${name}`;
    const folder = this.#folder(sessionId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    // The row first: the start's cleanup removes files no row owns, so a file never exists without its row.
    const record = await this.#store.attachments.create({
      id,
      sessionId,
      name,
      mediaType: servedType(sniffed),
      kind,
      size: bytes.length,
      file,
      pages: kind === 'pdf' ? pdfPageCount(bytes) : null,
      createdAt: this.#now().toISOString(),
    });
    try {
      // `wx`: never overwrite (the id is new); 0600: only the user reads it.
      await writeFile(path.join(folder, file), bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      await this.#store.attachments.delete(id);
      throw error;
    }
    return toAttachment(record);
  }

  /** A session's attachment and its file's path, or `null` (unknown, another session's, staged, or its file is gone). */
  async find(sessionId: string, id: string): Promise<{ readonly record: AttachmentRecord; readonly path: string } | null> {
    if (!SAFE_ID.test(id) || !SAFE_ID.test(sessionId)) return null;
    const record = await this.#store.attachments.get(id);
    if (!record || record.sessionId !== sessionId) return null;
    const file = this.pathOf(record);
    try {
      if (!(await stat(file)).isFile()) return null;
    } catch {
      return null;
    }
    return { record, path: file };
  }

  /**
   * The rows of `ids` for a message of `sessionId` (`null` = staged ones, for a
   * start), checked: every id known there, at most 20, at most 50 MiB together.
   * @throws {AttachmentError} 422 on field `attachments`.
   */
  async resolve(sessionId: string | null, ids: readonly string[]): Promise<AttachmentRecord[]> {
    if (ids.length === 0) return [];
    const records = await this.#store.attachments.listIn(sessionId, ids);
    if (records.length !== ids.length) {
      const known = new Set(records.map((record) => record.id));
      const missing = ids.filter((id) => !known.has(id));
      throw new AttachmentError(422, 'invalid', `unknown attachment${missing.length > 1 ? 's' : ''} ${missing.join(', ')} (upload it to this ${sessionId === null ? 'start' : 'session'} first)`, 'attachments');
    }
    const problem = messageCapProblem(records.map((record) => record.size));
    if (problem) throw new AttachmentError(422, 'invalid', problem, 'attachments');
    return records;
  }

  /** Moves staged uploads into their new session's folder (a New-session start). */
  async bind(records: readonly AttachmentRecord[], sessionId: string): Promise<AttachmentRecord[]> {
    const out: AttachmentRecord[] = [];
    if (records.length === 0) return out;
    const folder = this.#folder(sessionId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    for (const record of records) {
      // The row first (the cleanup keeps files their row owns), back again when the move fails.
      const bound = (await this.#store.attachments.bind(record.id, sessionId)) ?? { ...record, sessionId };
      try {
        await rename(this.pathOf(record), this.pathOf(bound));
      } catch (error) {
        await this.#store.attachments.unbind(record.id);
        throw error;
      }
      out.push(bound);
    }
    return out;
  }

  /**
   * A message's attachments for the agent (D57 ruling): images and PDFs inline as
   * content blocks when the CLI takes them (`planDelivery`), everything else as
   * the lines naming their absolute paths. `inline: false` (a hooked terminal
   * session) sends every one as a file. D62: `pdfs: false` (a CLI that takes
   * images only, Codex) sends PDFs as files.
   */
  async prepare(records: readonly AttachmentRecord[], options: { readonly inline: boolean; readonly pdfs?: boolean }): Promise<PreparedAttachments> {
    if (records.length === 0) return NO_ATTACHMENTS;
    const plan = planDelivery(records.map((record) => ({ kind: record.kind, size: record.size, ...(record.pages !== null ? { pages: record.pages } : {}) })), options);
    const refs: Attachment[] = [];
    const blocks: UserContentBlock[] = [];
    const files: AttachedFile[] = [];
    for (const [index, record] of records.entries()) {
      const delivery = record.kind === 'pdf' && options.pdfs === false ? 'file' : (plan[index] ?? 'file');
      refs.push(toAttachment(record, delivery));
      if (delivery === 'inline' && record.kind !== 'file') {
        const bytes = await readFile(this.pathOf(record));
        blocks.push(inlineBlock(record.kind, record.mediaType, bytes.toString('base64'), record.name));
      } else {
        files.push({ path: this.pathOf(record), size: record.size });
      }
    }
    return { refs, blocks, filesText: attachedFilesText(files) };
  }

  /**
   * D57: an image of a transcript's user line (Attach, a move, a teleport, a hooked
   * session) with its bytes: stored as the session's attachment so the chat shows
   * it. Bytes that are not an image the CLI takes → `null` (the chat shows a placeholder).
   */
  async saveTranscriptImage(sessionId: string, base64: string, index: number): Promise<Attachment | null> {
    const bytes = Buffer.from(base64, 'base64');
    const sniffed = sniffType(bytes);
    if (kindOf(sniffed) !== 'image' || bytes.length === 0) return null;
    const ext = (sniffed ?? 'image/png').slice('image/'.length).replace('jpeg', 'jpg');
    return this.upload(sessionId, { name: `image-${index + 1}.${ext}`, data: base64 });
  }

  /**
   * The start's cleanup (ASSUMED D57-retention): attachments older than
   * {@link ATTACHMENT_RETENTION_DAYS} days (rows and files), folders of sessions
   * that no longer exist, and files no row owns. Never throws (errors go to `onError`).
   */
  async cleanup(onError: (error: unknown) => void = () => undefined): Promise<{ readonly removed: number }> {
    let removed = 0;
    const cutoff = new Date(this.#now().getTime() - ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    try {
      for (const record of await this.#store.attachments.olderThan(cutoff)) {
        await this.#store.attachments.delete(record.id);
        await rm(this.pathOf(record), { force: true }).catch(onError);
        removed++;
      }
      const rows = await this.#store.attachments.list();
      const owned = new Map<string, Set<string>>();
      for (const record of rows) {
        const key = record.sessionId ?? STAGED_DIR;
        let files = owned.get(key);
        if (!files) owned.set(key, (files = new Set()));
        files.add(record.file);
      }
      let folders: string[];
      try {
        folders = await readdir(this.#root);
      } catch {
        return { removed };
      }
      for (const folder of folders) {
        const full = path.join(this.#root, folder);
        const files = owned.get(folder);
        const isSession = folder === STAGED_DIR || (SAFE_ID.test(folder) && (await this.#store.sessions.get(folder)) !== null);
        if (!files && !isSession) {
          await rm(full, { recursive: true, force: true }).catch(onError);
          continue;
        }
        let entries: string[];
        try {
          entries = await readdir(full);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (files?.has(entry)) continue;
          await rm(path.join(full, entry), { recursive: true, force: true }).catch(onError);
          removed++;
        }
      }
    } catch (error) {
      onError(error);
    }
    return { removed };
  }
}
