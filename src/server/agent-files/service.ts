/**
 * D180 · side panel Files (contract and rules: `src/core/agent-files.ts`).
 *
 * Reads files for the loopback UI only. Which files: those inside one of the
 * agent's roots (its folder, its separate copies, the repos it works in), and
 * those its conversation touched (tool calls and paths named in its replies).
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_DIR_MAX,
  AGENT_FILE_TEXT_BYTES,
  AGENT_FILE_TEXT_LINES,
  AGENT_FILES_MAX,
  AGENT_PAGE_ASSET_BYTES,
  AGENT_PAGE_BYTES,
  AGENT_PAGE_LEFT_MAX,
  type AgentDirEntry,
  type AgentDirListing,
  type AgentFileErrorCode,
  type AgentFileKind,
  type AgentFileList,
  type AgentFileMeta,
  type AgentFileOpenHow,
  type AgentFileRef,
  type AgentFileRoot,
  type AgentFileSource,
  type AgentFileText,
  type AgentPageInfo,
  type AgentPageLeft,
  type AgentPageLeftWhy,
  extensionOf,
  fileKindByName,
  isNetworkPath,
  isPageName,
  languageByName,
  mentionedPathRefs,
  mimeByName,
  opensInApp,
} from '../../core/agent-files.ts';
import { looksSecret } from '../../core/workspace-move.ts';
import type { SessionWorksIn } from '../../core/workspace-move.ts';
import { dataUrl, type PageEdit, pageMetaTag, type PageRefKind, refTarget, scanPage, withEdits } from './page.ts';

/** HTTP status per error code. */
export const AGENT_FILE_STATUS: Readonly<Record<AgentFileErrorCode, number>> = { outside: 403, missing: 404, secret: 409, remote: 409, 'too-large': 413, invalid: 422 };

/** A refusal the route turns into `{ error, message }`. */
export class AgentFileError extends Error {
  readonly code: AgentFileErrorCode;
  constructor(code: AgentFileErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The part of a session this needs. */
export interface AgentFileSession {
  readonly id: string;
  readonly cwd: string | null;
  readonly root: string | null;
}

/** What the service reads from the rest of the server. */
export interface AgentFileDeps {
  /** The repos the agent works in (`providers.diff.worksIn`); empty without a provider. */
  worksIn(sessionId: string): Promise<SessionWorksIn>;
  /** Paths named by the session's tool calls with one of `names` (`store.events.editedFilePathTimes`); D180: with the newest call's time when known. */
  toolPaths(sessionId: string, names: readonly string[]): Promise<ReadonlyArray<string | { readonly path: string; readonly at: string | null }>>;
  /** The agent's reply texts, newest first; D180: with each reply's time when known. */
  replyTexts(sessionId: string, limit: number): Promise<ReadonlyArray<string | { readonly text: string; readonly at: string | null }>>;
  readonly platform: NodeJS.Platform;
  /** `SWITCHBOARD_OPEN_COMMAND`: an argv prefix for the OS openers (tests), else `null`. */
  readonly openPrefix: readonly string[] | null;
}

/** How many reply texts are read for mentioned paths. */
const REPLY_TEXTS = 400;
/** Bytes read to tell text from binary. */
const SNIFF_BYTES = 8 * 1024;
/** Bytes read for the secrets check. */
const SECRET_BYTES = 64 * 1024;
/** A longer line is cut (a minified bundle would otherwise freeze the panel). */
const LINE_MAX = 5000;
/** A text file bigger than this is not read here at all (413 `too-large`). */
const TEXT_MAX_BYTES = 256 * 1024 * 1024;
/** An agent's roots and its conversation's files are worked out at most this often (each costs git processes or whole-conversation reads; a file's every request needs them). */
const ROOTS_TTL_MS = 5000;
const CONVERSATION_TTL_MS = 3000;
/** Agents whose roots / conversation are kept, and file facts kept (per path, time and size). */
const SESSIONS_KEPT = 200;
const META_KEPT = 500;
/** Different files a page points at that are looked up on disk; what comes after is left out. */
const PAGE_LOOKUPS_MAX = 400;
/** A built page is kept this long (a view asks for its facts, then for the page), and at most this many. */
const PAGE_TTL_MS = 4000;
const PAGES_KEPT = 3;

/** How a page is asked for. */
export interface PageOptions {
  /** The file looks like it holds secrets and the developer asked for it anyway. */
  readonly confirm: boolean;
  /** Let the page's own scripts run (and put them into it). */
  readonly scripts: boolean;
  /** Anything that is new when the page is asked for anew (Reload): another build. */
  readonly version?: string | undefined;
}

/** A page ready to be framed, and what it is shown with. */
export interface BuiltPage {
  readonly html: string;
  readonly info: AgentPageInfo;
}

/** One file put into a page. */
interface PageFile {
  readonly real: string;
  /** Its bytes as a `data:` address. */
  readonly url: string;
  /** The bytes put in (text as UTF-8). */
  readonly size: number;
}

/**
 * The media type a page's file is put into it with, by its name: a stylesheet
 * (`.css`), a script (`.js`, `.mjs`) or a picture. `null`: not one of those for the
 * tag that points at it, so it is never put into a page (a page cannot pull in a
 * notes or settings file by calling it a stylesheet).
 */
function pageFileType(kind: PageRefKind, name: string): string | null {
  const ext = extensionOf(name);
  if (kind === 'style') return ext === 'css' ? 'text/css;charset=utf-8' : null;
  if (kind === 'script') return ext === 'js' || ext === 'mjs' ? 'text/javascript;charset=utf-8' : null;
  if (kind === 'image') return fileKindByName(name) === 'image' ? mimeByName(name) : null;
  return null;
}

/** A value worked out a moment ago (the promise, so callers at the same time share one run). */
interface Kept<T> {
  readonly at: number;
  readonly tag: string;
  readonly value: Promise<T>;
}

/** `work()`'s answer for `key`, reused while it is younger than `ttl` and `tag` is the same; a failure is not kept. */
function keptFor<T>(map: Map<string, Kept<T>>, key: string, tag: string, ttl: number, limit: number, work: () => Promise<T>): Promise<T> {
  const had = map.get(key);
  const now = Date.now();
  if (had && had.tag === tag && now - had.at < ttl) return had.value;
  const value = work();
  map.delete(key);
  map.set(key, { at: now, tag, value });
  if (map.size > limit) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  value.catch(() => {
    if (map.get(key)?.value === value) map.delete(key);
  });
  return value;
}

const TOOL_SOURCES: ReadonlyArray<readonly [readonly string[], AgentFileSource]> = [
  [['Write'], 'wrote'],
  [['Edit', 'MultiEdit', 'NotebookEdit'], 'edited'],
  [['Read'], 'read'],
];

interface FoundFile {
  readonly real: string;
  readonly sources: Set<AgentFileSource>;
  readonly mentionedAs: Set<string>;
  line: number | null;
  exists: boolean;
  modified: number;
  /** D180: the newest event that touched it (ISO), `null` when unknown. */
  at: string | null;
}

export class AgentFileService {
  readonly #deps: AgentFileDeps;
  readonly #roots = new Map<string, Kept<AgentFileRoot[]>>();
  readonly #conversations = new Map<string, Kept<Map<string, FoundFile>>>();
  readonly #metas = new Map<string, AgentFileMeta>();
  readonly #pages = new Map<string, Kept<BuiltPage>>();

  constructor(deps: AgentFileDeps) {
    this.#deps = deps;
  }

  #key(file: string): string {
    return this.#deps.platform === 'win32' ? file.toLowerCase() : file;
  }

  /** `true` when `file` is `root` or below it (both real paths). */
  #inside(root: string, file: string): boolean {
    const relative = path.relative(this.#key(root), this.#key(file));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  /** The agent's roots: its folder, its workspace root, and where it works (real, existing folders). Worked out at most every few seconds. */
  roots(session: AgentFileSession): Promise<AgentFileRoot[]> {
    return keptFor(this.#roots, session.id, `${session.cwd ?? ''}\u0000${session.root ?? ''}`, ROOTS_TTL_MS, SESSIONS_KEPT, () => this.#findRoots(session));
  }

  async #findRoots(session: AgentFileSession): Promise<AgentFileRoot[]> {
    const roots: AgentFileRoot[] = [];
    const add = async (folder: string | null | undefined, label: string | null, kind: AgentFileRoot['kind']): Promise<void> => {
      if (!folder) return;
      try {
        const real = await realpath(folder);
        if (!(await stat(real)).isDirectory()) return;
        if (roots.some((root) => this.#key(root.path) === this.#key(real))) return;
        roots.push({ path: real, label: label ?? (path.basename(real) || real), kind });
      } catch {
        // A folder that is gone is no root.
      }
    };
    await add(session.cwd, null, 'folder');
    await add(session.root, null, 'folder');
    let worksIn: SessionWorksIn = { repos: [] };
    try {
      worksIn = await this.#deps.worksIn(session.id);
    } catch {
      // Without the repos the folder is still a root.
    }
    for (const repo of worksIn.repos) {
      const worktree = repo.kind === 'worktree';
      await add(repo.path, worktree && repo.branch ? `${repo.name} · ${repo.branch}` : repo.name, worktree ? 'worktree' : 'repo');
    }
    return roots;
  }

  /** The absolute forms a path as written may mean, most likely first. */
  #candidates(written: string, session: AgentFileSession, roots: readonly AgentFileRoot[]): string[] {
    let text = written.trim();
    // A network or device path an agent named is never touched (`isNetworkPath`).
    if (isNetworkPath(text)) return [];
    if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) text = path.join(os.homedir(), text.slice(1));
    if (path.isAbsolute(text)) return [path.normalize(text)];
    const bases = [session.cwd, session.root, ...roots.map((root) => root.path)].filter((base): base is string => typeof base === 'string' && base !== '');
    const seen = new Set<string>();
    const out: string[] = [];
    for (const base of bases) {
      const candidate = path.resolve(base, text);
      if (!seen.has(this.#key(candidate))) {
        seen.add(this.#key(candidate));
        out.push(candidate);
      }
    }
    return out;
  }

  /** The real path of the existing file or folder `written` names, `null` when there is none. */
  async #resolve(written: string, session: AgentFileSession, roots: readonly AgentFileRoot[], want: 'file' | 'any'): Promise<string | null> {
    for (const candidate of this.#candidates(written, session, roots)) {
      try {
        const real = await realpath(candidate);
        const info = await stat(real);
        if (want === 'any' || info.isFile()) return real;
      } catch {
        // Try the next base.
      }
    }
    return null;
  }

  /** Every file the conversation touched, keyed by {@link #key}. Read at most every few seconds (whole-conversation reads). */
  #conversation(session: AgentFileSession, roots: readonly AgentFileRoot[]): Promise<Map<string, FoundFile>> {
    return keptFor(this.#conversations, session.id, roots.map((root) => root.path).join('\u0000'), CONVERSATION_TTL_MS, SESSIONS_KEPT, () => this.#readConversation(session, roots));
  }

  async #readConversation(session: AgentFileSession, roots: readonly AgentFileRoot[]): Promise<Map<string, FoundFile>> {
    const found = new Map<string, FoundFile>();
    const note = async (real: string, source: AgentFileSource, exists: boolean, at: string | null = null): Promise<FoundFile> => {
      const key = this.#key(real);
      let entry = found.get(key);
      if (!entry) {
        let modified = 0;
        if (exists) {
          try {
            modified = (await stat(real)).mtimeMs;
          } catch {
            exists = false;
          }
        }
        entry = { real, sources: new Set(), mentionedAs: new Set(), line: null, exists, modified, at: null };
        found.set(key, entry);
      }
      entry.sources.add(source);
      if (at !== null && (entry.at === null || at > entry.at)) entry.at = at;
      return entry;
    };

    for (const [names, source] of TOOL_SOURCES) {
      let written: ReadonlyArray<string | { readonly path: string; readonly at: string | null }> = [];
      try {
        written = await this.#deps.toolPaths(session.id, names);
      } catch {
        written = [];
      }
      for (const raw of written) {
        const item = typeof raw === 'string' ? raw : raw.path;
        const at = typeof raw === 'string' ? null : raw.at;
        const real = await this.#resolve(item, session, roots, 'file');
        if (real) await note(real, source, true, at);
        else {
          // A file the agent named in a tool call and that is gone: still listed, marked missing.
          const first = this.#candidates(item, session, roots)[0];
          if (first) await note(first, source, false, at);
        }
      }
    }

    // A bare name or a tail the agent writes after touching the file ("tabs.tsx:98") means that file.
    const byTail = (mention: string): string | null => {
      const wanted = this.#key(mention.replace(/\\/g, '/'));
      const hits = [...found.values()].filter((entry) => {
        const full = this.#key(entry.real.replace(/\\/g, '/'));
        return full === wanted || full.endsWith(`/${wanted}`);
      });
      return hits.length === 1 && hits[0] ? hits[0].real : null;
    };

    let texts: ReadonlyArray<string | { readonly text: string; readonly at: string | null }> = [];
    try {
      texts = await this.#deps.replyTexts(session.id, REPLY_TEXTS);
    } catch {
      texts = [];
    }
    for (const raw of texts) {
      const text = typeof raw === 'string' ? raw : raw.text;
      const at = typeof raw === 'string' ? null : raw.at;
      for (const ref of mentionedPathRefs(text)) {
        const real = (await this.#resolve(ref.path, session, roots, 'file')) ?? byTail(ref.path);
        if (!real) continue;
        const entry = await note(real, 'mentioned', true, at);
        entry.mentionedAs.add(ref.path);
        if (entry.line === null && ref.line !== null) entry.line = ref.line;
      }
    }
    return found;
  }

  /** `GET …/files`: what the conversation touched, most recently changed first. */
  async list(session: AgentFileSession): Promise<AgentFileList> {
    const roots = await this.roots(session);
    const found = [...(await this.#conversation(session, roots)).values()].sort((a, b) => Number(b.exists) - Number(a.exists) || b.modified - a.modified);
    const files: AgentFileRef[] = found.slice(0, AGENT_FILES_MAX).map((entry) => ({
      path: entry.real,
      name: path.basename(entry.real),
      dir: path.dirname(entry.real),
      sources: (['wrote', 'edited', 'read', 'mentioned'] as const).filter((source) => entry.sources.has(source)),
      mentionedAs: [...entry.mentionedAs],
      line: entry.line,
      exists: entry.exists,
      at: entry.at,
    }));
    return { files, truncated: found.length > AGENT_FILES_MAX };
  }

  /** The real path `input` names and why it may be opened; throws `missing` / `outside`. */
  async allow(session: AgentFileSession, input: string, want: 'file' | 'any' = 'file'): Promise<{ readonly real: string; readonly allowedBy: 'root' | 'conversation'; readonly roots: readonly AgentFileRoot[] }> {
    if (typeof input !== 'string' || input.trim() === '' || input.includes('\0')) throw new AgentFileError('invalid', 'path is required');
    if (isNetworkPath(input)) throw new AgentFileError('outside', 'Network paths are not opened here.');
    const roots = await this.roots(session);
    let real = await this.#resolve(input, session, roots, want);
    let conversation: Map<string, FoundFile> | null = null;
    if (!real) {
      // As the agent wrote it ("tabs.tsx"): one of the conversation's files by its tail.
      conversation = await this.#conversation(session, roots);
      const wanted = this.#key(input.trim().replace(/\\/g, '/'));
      const hits = [...conversation.values()].filter((entry) => entry.exists && (entry.mentionedAs.has(input.trim()) || this.#key(entry.real.replace(/\\/g, '/')).endsWith(`/${wanted}`)));
      if (hits.length === 1 && hits[0]) real = hits[0].real;
    }
    if (!real) throw new AgentFileError('missing', `No such file: ${input}`);
    // git's own files are not something to read here (not listed when browsing either).
    if (real.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git')) throw new AgentFileError('outside', 'git’s own files are not shown here.');
    if (roots.some((root) => this.#inside(root.path, real))) return { real, allowedBy: 'root', roots };
    if (want === 'file') {
      conversation ??= await this.#conversation(session, roots);
      if (conversation.get(this.#key(real))?.exists) return { real, allowedBy: 'conversation', roots };
    }
    throw new AgentFileError('outside', 'This file is outside the agent’s folders and its conversation never touched it.');
  }

  /** `GET …/files/dir`: one folder of a root. */
  async dir(session: AgentFileSession, input: string | null): Promise<AgentDirListing> {
    const roots = await this.roots(session);
    if (roots.length === 0) throw new AgentFileError('missing', 'This agent has no folder to browse.');
    let folder = roots[0]?.path ?? '';
    if (input !== null && input.trim() !== '') {
      const allowed = await this.allow(session, input, 'any');
      if (allowed.allowedBy !== 'root') throw new AgentFileError('outside', 'Only the agent’s folders can be browsed.');
      folder = allowed.real;
    }
    if (!(await stat(folder)).isDirectory()) throw new AgentFileError('invalid', 'Not a folder.');
    const root = roots.filter((candidate) => this.#inside(candidate.path, folder)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) throw new AgentFileError('outside', 'Only the agent’s folders can be browsed.');
    const names = await readdir(folder, { withFileTypes: true });
    const entries: AgentDirEntry[] = [];
    for (const item of names) {
      // git's own folder is not something to read here.
      if (item.name === '.git') continue;
      const full = path.join(folder, item.name);
      try {
        let info = await lstat(full);
        if (info.isSymbolicLink()) {
          // A link is shown only when it stays inside the roots.
          const target = await realpath(full);
          if (!roots.some((candidate) => this.#inside(candidate.path, target))) continue;
          info = await stat(target);
        }
        if (info.isDirectory()) entries.push({ name: item.name, path: full, type: 'dir', size: null, modifiedAt: info.mtime.toISOString() });
        else if (info.isFile()) entries.push({ name: item.name, path: full, type: 'file', size: info.size, modifiedAt: info.mtime.toISOString() });
      } catch {
        // Unreadable: left out.
      }
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
    const parent = this.#key(folder) === this.#key(root.path) ? null : path.dirname(folder);
    return { dir: folder, root: root.path, parent, entries: entries.slice(0, AGENT_DIR_MAX), truncated: entries.length > AGENT_DIR_MAX };
  }

  /** The first `bytes` of a file. */
  async #head(file: string, bytes: number): Promise<Buffer> {
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /** `GET …/files/meta` for an allowed real path. */
  async metaOf(real: string, allowedBy: 'root' | 'conversation'): Promise<AgentFileMeta> {
    const info = await stat(real);
    if (!info.isFile()) throw new AgentFileError('invalid', 'Not a file.');
    // The facts of one version of a file are worked out once (a film asks for its bytes in many ranges, and the secrets check reads 64 KiB each time).
    const key = `${this.#key(real)}\u0000${info.mtimeMs}\u0000${info.size}\u0000${allowedBy}`;
    const kept = this.#metas.get(key);
    if (kept) return kept;
    const meta = await this.#readMeta(real, allowedBy, info.size, info.mtime);
    this.#metas.set(key, meta);
    if (this.#metas.size > META_KEPT) {
      const oldest = this.#metas.keys().next();
      if (!oldest.done) this.#metas.delete(oldest.value);
    }
    return meta;
  }

  async #readMeta(real: string, allowedBy: 'root' | 'conversation', size: number, modified: Date): Promise<AgentFileMeta> {
    const name = path.basename(real);
    let kind: AgentFileKind | null = fileKindByName(name);
    let sample: Buffer | null = null;
    if (kind === null) {
      sample = await this.#head(real, SNIFF_BYTES);
      kind = looksText(sample) ? 'text' : 'binary';
    }
    const textual = kind === 'text' || kind === 'markdown' || kind === 'csv';
    let secret: string | null = null;
    if (textual) {
      const head = await this.#head(real, SECRET_BYTES);
      secret = looksSecret(name, decodeText(head));
    } else {
      secret = looksSecret(name, null);
    }
    return {
      path: real,
      name,
      size,
      modifiedAt: modified.toISOString(),
      kind,
      mime: textual ? 'text/plain; charset=utf-8' : mimeByName(name),
      language: textual ? languageByName(name) : null,
      secret,
      allowedBy,
    };
  }

  /** `GET …/files/text`. */
  async text(real: string, meta: AgentFileMeta, offset: number, limit: number, confirm: boolean): Promise<AgentFileText> {
    if (meta.kind !== 'text' && meta.kind !== 'markdown' && meta.kind !== 'csv') throw new AgentFileError('invalid', 'This file has no text to show.');
    if (meta.secret !== null && !confirm) throw new AgentFileError('secret', `This file looks like it holds secrets (${meta.secret}).`);
    const take = Math.max(1, Math.min(limit, AGENT_FILE_TEXT_LINES));
    const from = Math.max(0, offset);
    const cut = (line: string): string => (line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)} …` : line);
    if (meta.size <= AGENT_FILE_TEXT_BYTES) {
      const all = decodeText(await readFile(real)).split(/\r?\n/);
      if (all.length > 1 && all[all.length - 1] === '') all.pop();
      const lines = all.slice(from, from + take).map(cut);
      return { path: real, offset: from, lines, totalLines: all.length, more: from + lines.length < all.length };
    }
    if (meta.size > TEXT_MAX_BYTES) throw new AgentFileError('too-large', 'This file is too big to read here. Show it in its folder and open it with an editor.');
    const { lines, more } = await readLinesBounded(real, from, take);
    return { path: real, offset: from, lines, totalLines: null, more };
  }

  /**
   * `GET …/files/page` and `…/files/page/info`: an HTML file's page with its own
   * files put into it, and what was left out. One build serves both requests of a
   * view (the facts, then the page): it is kept for a moment under what was asked.
   */
  page(session: AgentFileSession, real: string, meta: AgentFileMeta, options: PageOptions): Promise<BuiltPage> {
    const key = [session.id, this.#key(real), meta.modifiedAt, String(meta.size), options.confirm ? '1' : '0', options.scripts ? '1' : '0', (options.version ?? '').slice(0, 64)].join('\u0000');
    const built = keptFor(this.#pages, key, '', PAGE_TTL_MS, PAGES_KEPT, () => this.#buildPage(session, real, meta, options));
    // A built page can be megabytes: it is let go when its moment has passed, not only when another takes its place.
    setTimeout(() => {
      if (this.#pages.get(key)?.value === built) this.#pages.delete(key);
    }, PAGE_TTL_MS).unref();
    return built;
  }

  /** `GET …/files/page/info`: what the page is shown with ({@link page}'s build). */
  async pageInfo(session: AgentFileSession, real: string, meta: AgentFileMeta, options: PageOptions): Promise<AgentPageInfo> {
    return (await this.page(session, real, meta, options)).info;
  }

  async #buildPage(session: AgentFileSession, real: string, meta: AgentFileMeta, options: PageOptions): Promise<BuiltPage> {
    if (meta.kind !== 'text' || !isPageName(meta.name)) throw new AgentFileError('invalid', 'Only an HTML file can be shown as a page.');
    if (meta.secret !== null && !options.confirm) throw new AgentFileError('secret', `This file looks like it holds secrets (${meta.secret}).`);
    const tooBig = (): AgentFileError => new AgentFileError('too-large', 'This page is too big to show here. Its source can still be read.');
    if (meta.size > AGENT_PAGE_BYTES) throw tooBig();
    let bytes: Buffer;
    try {
      bytes = await readFile(real);
    } catch {
      throw new AgentFileError('missing', 'This file is gone or cannot be read.');
    }
    // Its size was read a moment ago: it may have grown since.
    if (bytes.length > AGENT_PAGE_BYTES) throw tooBig();
    const source = decodeText(bytes);
    const scan = scanPage(source, { scripts: options.scripts });
    const folder = path.dirname(real);
    // A page is given files of the folders of the agent it lives in itself: never of another project, and nothing when it is outside them all.
    const homes = (await this.roots(session)).filter((root) => this.#inside(root.path, real));
    // The page states its own rules first, and what could never load here (or would only open a connection) is set aside.
    const edits: PageEdit[] = [{ start: scan.head, end: scan.head, text: pageMetaTag(options.scripts) }];
    for (const position of scan.aside) edits.push({ start: position, end: position, text: 'data-' });
    const left: AgentPageLeft[] = [];
    const leftRefs = new Set<string>();
    const leave = (ref: string, why: AgentPageLeftWhy): void => {
      if (leftRefs.has(ref)) return;
      leftRefs.add(ref);
      if (left.length < AGENT_PAGE_LEFT_MAX) left.push({ ref, why });
    };
    /** What each file the page names turned out to be, by its path and what it is used as. */
    const files = new Map<string, PageFile | AgentPageLeftWhy>();
    const loaded = new Set<string>();
    let room = AGENT_PAGE_ASSET_BYTES;
    for (const ref of scan.refs) {
      // Its scripts are off: a script is neither put in nor something left out.
      if (ref.kind === 'script' && !options.scripts) continue;
      const target = refTarget(ref.ref);
      if (target.kind === 'none') continue;
      if (target.kind !== 'file') {
        leave(ref.ref, target.kind);
        continue;
      }
      // By its name first: a file that is no stylesheet, script or picture is not even looked at.
      if (pageFileType(ref.kind, target.relative) === null) {
        leave(ref.ref, 'kind');
        continue;
      }
      const wanted = path.resolve(folder, target.relative);
      const known = `${this.#key(wanted)}\u0000${ref.kind}`;
      let file = files.get(known);
      if (file === undefined) {
        file = files.size >= PAGE_LOOKUPS_MAX ? 'too-large' : await this.#pageFile(session, homes, wanted, ref.kind, room);
        files.set(known, file);
      }
      // Each use puts the file in again: each counts against what a page may weigh.
      if (typeof file !== 'string' && file.size > room) file = 'too-large';
      if (typeof file === 'string') {
        leave(ref.ref, file);
        continue;
      }
      room -= file.size;
      loaded.add(this.#key(file.real));
      edits.push({ start: ref.start, end: ref.end, text: `"${file.url}"` });
      // What would undo it: a `srcset` the browser would take instead, an `integrity` of the file's bytes on disk.
      for (const position of ref.aside) edits.push({ start: position, end: position, text: 'data-' });
    }
    return { html: withEdits(source, edits), info: { loaded: loaded.size, left, leftMore: leftRefs.size - left.length, scripted: scan.scripted } };
  }

  /** One file a page names, read to be put into it; or why it is left out. */
  async #pageFile(session: AgentFileSession, homes: readonly AgentFileRoot[], wanted: string, kind: PageRefKind, room: number): Promise<PageFile | AgentPageLeftWhy> {
    // By the path as written first: what is not in the page's own folders is not even looked at.
    if (!homes.some((root) => this.#inside(root.path, wanted))) return 'outside';
    try {
      const allowed = await this.allow(session, wanted);
      // And by where it really is: a link may lead out of them, to another folder of the agent or to a file its conversation named.
      if (!homes.some((root) => this.#inside(root.path, allowed.real))) return 'outside';
      // Again by the real name: a link may lead to a file of another kind.
      const type = pageFileType(kind, allowed.real);
      if (type === null) return 'kind';
      const facts = await this.metaOf(allowed.real, 'root');
      if (facts.secret !== null) return 'secret';
      if (facts.size > room) return 'too-large';
      let bytes = await readFile(allowed.real);
      if (kind !== 'image') {
        const text = decodeText(bytes);
        // The whole text (the file's facts only look at its beginning).
        if (looksSecret(facts.name, text) !== null) return 'secret';
        // Text is put in as UTF-8 whatever the file's own encoding and mark are.
        bytes = Buffer.from(text, 'utf8');
      }
      return { real: allowed.real, url: dataUrl(type, bytes), size: bytes.length };
    } catch (error) {
      // Gone, unreadable or not a path at all: the page shows without it.
      return error instanceof AgentFileError && error.code === 'outside' ? 'outside' : 'missing';
    }
  }

  /** `POST …/files/open`: hands the file to the OS and returns. */
  async open(real: string, how: AgentFileOpenHow): Promise<void> {
    // An allow-list: which program a file starts is the system's choice, so only what its app merely shows is handed over.
    if (how === 'app' && !opensInApp(real)) throw new AgentFileError('invalid', 'Only documents, pictures, sound and film are opened in their app (nothing the system could run). Use Show in folder.');
    const platform = this.#deps.platform;
    // Explorer splits its arguments at commas: a path with one could be read as something else.
    if (platform === 'win32' && real.includes(',')) throw new AgentFileError('invalid', 'Explorer cannot be given a path with a comma. Copy the path instead.');
    let argv: string[];
    if (platform === 'win32') argv = how === 'folder' ? ['explorer', '/select,', real] : ['explorer', real];
    else if (platform === 'darwin') argv = how === 'folder' ? ['open', '-R', real] : ['open', real];
    else argv = ['xdg-open', how === 'folder' ? path.dirname(real) : real];
    const full = [...(this.#deps.openPrefix ?? []), ...argv];
    const command = full[0];
    if (!command) throw new AgentFileError('invalid', 'No opener for this system.');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, full.slice(1), { shell: false, detached: true, stdio: 'ignore' });
      child.once('error', (error) => reject(new AgentFileError('invalid', `Could not open it: ${error.message}`)));
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
}

/**
 * Lines `from` … `from + take` of a big text file, read as a stream. A line is kept
 * only up to {@link LINE_MAX} characters while it is read, so one enormous line (a
 * minified bundle, a data dump) is never held whole; `more`: something follows.
 */
export async function readLinesBounded(file: string, from: number, take: number): Promise<{ readonly lines: string[]; readonly more: boolean }> {
  const lines: string[] = [];
  let index = 0;
  let current = '';
  let cut = false;
  let more = false;
  const done = (): string => {
    const text = current.endsWith('\r') ? current.slice(0, -1) : current;
    return cut || text.length > LINE_MAX ? `${text.slice(0, LINE_MAX)} …` : text;
  };
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 256 * 1024 });
  try {
    scan: for await (const part of stream) {
      const chunk = part as string;
      let start = 0;
      while (start <= chunk.length) {
        const newline = chunk.indexOf('\n', start);
        const end = newline === -1 ? chunk.length : newline;
        if (index >= from + take) {
          // Past the wanted run: any character or line here means there is more.
          if (end > start || newline !== -1) {
            more = true;
            break scan;
          }
        } else if (index >= from && !cut) {
          const room = LINE_MAX + 1 - current.length;
          if (end - start > room) {
            current += chunk.slice(start, start + room);
            cut = true;
          } else current += chunk.slice(start, end);
        }
        if (newline === -1) break;
        if (index >= from && index < from + take) lines.push(done());
        index += 1;
        current = '';
        cut = false;
        start = newline + 1;
      }
    }
  } finally {
    stream.destroy();
  }
  // The last line when the file does not end with a newline.
  if (!more && index >= from && index < from + take && (current !== '' || cut)) lines.push(done());
  return { lines, more };
}

/** No NUL byte and readable as UTF-8 (or UTF-16 with a byte order mark). */
export function looksText(sample: Buffer): boolean {
  if (sample.length === 0) return true;
  if (sample.length >= 2 && ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff))) return true;
  if (sample.includes(0)) return false;
  for (let trim = 0; trim <= 3 && trim < sample.length; trim += 1) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, sample.length - trim));
      return true;
    } catch {
      // A multi-byte character cut at the end of the sample: try a little shorter.
    }
  }
  return false;
}

/** Bytes as text: UTF-8 (its mark dropped), or UTF-16 when the bytes start with its mark. */
export function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(bytes.subarray(start));
}
