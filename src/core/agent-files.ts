/**
 * D180 · side panel (Details | Changes | Files), 2026-11-17. The contract
 * between `src/server/api/agent-files.ts` and the v2 agent view's side panel. It is
 * not a decision yet and is not in `docs/handoff/contracts/local-api.md`.
 *
 * Routes. They exist for the loopback UI only: never for a paired phone (refused by
 * name, `DEVICE_REFUSED` in `src/server/devices/local-only.ts`) or a paired computer
 * (not on `PEER_API_ALLOW`). A request for an agent that lives on a paired computer
 * (an `r~…` id) is forwarded there like every session route and refused by that
 * computer (403 `peer-forbidden`); 409 `remote` is what this server answers itself
 * when nothing forwards.
 *
 * - `GET  /api/sessions/{id}/files`                         → {@link AgentFileList}
 * - `GET  /api/sessions/{id}/files/roots`                   → {@link AgentFileRoots}
 * - `GET  /api/sessions/{id}/files/dir?path=`               → {@link AgentDirListing} (inside a root; no path = the first root)
 * - `GET  /api/sessions/{id}/files/meta?path=`              → {@link AgentFileMeta}
 * - `GET  /api/sessions/{id}/files/text?path=&offset=&limit=&confirm=1` → {@link AgentFileText}
 * - `GET  /api/sessions/{id}/files/raw?path=&confirm=1`     → the bytes (`Range` supported)
 * - `GET  /api/sessions/{id}/files/page?path=&scripts=1&confirm=1&v=` → an HTML file as a page ("A page" below)
 * - `GET  /api/sessions/{id}/files/page/info?path=&scripts=1&confirm=1&v=` → {@link AgentPageInfo}
 * - `POST /api/sessions/{id}/files/open` `{ path, how }`    → 204 ({@link AgentFileOpenHow})
 *
 * `path` may be absolute, or as the agent wrote it (relative): the server resolves it
 * against the agent's working folder and roots and answers with the absolute path.
 *
 * Which files may be opened (`AgentFileMeta.allowedBy`):
 * - `root`: the file's real path is inside one of the agent's roots (its folder, its
 *   separate copies, the repos it works in);
 * - `conversation`: the file is one a tool call of the agent named (Write, Edit, Read:
 *   also a call you refused, it is recorded when the agent makes it) or one its reply
 *   named. So an agent can make any file on this computer show in ITS panel, to you;
 *   nothing goes back to the agent. Open question for a real feature: ask before
 *   showing a file from outside the roots.
 * Anything else answers 403 `outside`: also git's own files (`.git`) and network or
 * device paths (never touched at all). Browsing (`/dir`) only ever lists roots.
 *
 * `POST …/files/open` with `how: 'app'` answers 422 `invalid` for anything but a
 * document, a picture, sound or film ({@link opensInApp}).
 *
 * A page (`…/files/page`, an `.html` / `.htm` file only, 422 `invalid` otherwise; a
 * page over {@link AGENT_PAGE_BYTES} answers 413). The answer is a small document
 * that frames the file's page; both are sandboxed without `allow-same-origin` (an
 * opaque origin: no cookie, storage or API of this app) under the rules of
 * `pagePolicy` (`src/server/agent-files/page.ts`): nothing is fetched from an
 * address, and the frame may hold nothing but the page, so a link, a redirect or a
 * script cannot send it to another address. The rules are stated three times (the
 * answer's header, a `<meta>` in the frame document, a `<meta>` in the page), since
 * a header can be taken off on the way (the frame helper does that for this app's
 * own host) and not every browser was tried.
 *
 * Without `scripts=1` (the view's default) the page's scripts do not run. Then
 * nothing in the page can read what is put into it or open a connection: what the
 * scan reads as a hint (`<link rel="preconnect">` and the like) is set aside.
 * With `scripts=1` they run, and the rules cannot keep what the page holds in: a
 * browser's CSP does not cover WebRTC (Chrome does not know the `webrtc` directive)
 * or a `preconnect` a script adds, so a script can send the page's text, and the
 * files put into it, to a host of its choosing. That is why scripts are asked for
 * per page, by the developer.
 *
 * The stylesheets, pictures and (with scripts) scripts the page points at with a
 * relative address are put into it when they are files of a folder of the agent
 * that holds the page itself (never of another project of the agent, never a file
 * that is only named in its conversation), by their extension, never one that looks
 * like it holds secrets, up to {@link AGENT_PAGE_ASSET_BYTES} together. Everything
 * else stays as written and is not loaded: {@link AgentPageInfo.left} says what and
 * why. Known limits: what a stylesheet pulls in itself (pictures, fonts, `@import`),
 * a module's imports, films and sounds are not loaded; the page's `<base>` is not
 * used; the page and its text files are read as UTF-8 (or UTF-16 with its mark),
 * whatever a `<meta charset>` says; links to other pages are not followed; a link
 * inside the agent's folders that leads elsewhere is still followed by the server
 * before it is refused (as everywhere in these routes).
 *
 * Errors: `{ error: AgentFileErrorCode, message }` with 403 `outside`, 404 `missing`,
 * 409 `secret` (the file looks like it holds secrets: ask again with `confirm=1`),
 * 409 `remote`, 413 `too-large`, 422 `invalid`.
 */

/** How the panel shows a file. `binary` = no preview: facts about the file and "open in its app". */
export type AgentFileKind = 'text' | 'markdown' | 'image' | 'pdf' | 'audio' | 'video' | 'csv' | 'binary';

/** Why a file is on the agent's list. */
export type AgentFileSource = 'wrote' | 'edited' | 'read' | 'mentioned';

/** One file the conversation touched. */
export interface AgentFileRef {
  /** Absolute path in the OS's own form. */
  readonly path: string;
  /** The last path segment. */
  readonly name: string;
  /** The folder, absolute. */
  readonly dir: string;
  readonly sources: readonly AgentFileSource[];
  /** The exact strings the agent wrote for this file in its replies (without a line suffix): what the chat turns into links. */
  readonly mentionedAs: readonly string[];
  /** The first line the agent pointed at (1-based), `null` when none. */
  readonly line: number | null;
  /** `false` when the file is gone (deleted or moved since). */
  readonly exists: boolean;
  /**
   * Additive (D180): when the newest event that touched the file happened (ISO): the tool call
   * that wrote, edited or read it, or the reply that named it; `null` when not known (absent
   * from a computer before 2.5.1).
   */
  readonly at?: string | null;
}

/** `GET …/files`: newest first. */
export interface AgentFileList {
  readonly files: readonly AgentFileRef[];
  /** More than {@link AGENT_FILES_MAX} were found. */
  readonly truncated: boolean;
}

/** A folder the agent may be browsed in. */
export interface AgentFileRoot {
  readonly path: string;
  /** A short name for the tree: the folder's own name, a repo's name, a branch. */
  readonly label: string;
  readonly kind: 'folder' | 'worktree' | 'repo';
}

/** `GET …/files/roots`. */
export interface AgentFileRoots {
  readonly roots: readonly AgentFileRoot[];
}

/** One row of a folder. */
export interface AgentDirEntry {
  readonly name: string;
  readonly path: string;
  readonly type: 'dir' | 'file';
  /** Bytes; `null` for a folder. */
  readonly size: number | null;
  /** ISO time; `null` when it could not be read. */
  readonly modifiedAt: string | null;
}

/** `GET …/files/dir`: folders first, then files, by name. */
export interface AgentDirListing {
  readonly dir: string;
  /** The root this folder is in. */
  readonly root: string;
  /** The folder above, `null` at a root. */
  readonly parent: string | null;
  readonly entries: readonly AgentDirEntry[];
  /** More than {@link AGENT_DIR_MAX} entries. */
  readonly truncated: boolean;
}

/** `GET …/files/meta`. */
export interface AgentFileMeta {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly kind: AgentFileKind;
  readonly mime: string;
  /** A highlight.js language name for `text`, `null` when unknown. */
  readonly language: string | null;
  /** Why the file looks like it holds secrets (never a value), `null` when it does not. */
  readonly secret: string | null;
  readonly allowedBy: 'root' | 'conversation';
}

/** `GET …/files/text`: a run of lines. */
export interface AgentFileText {
  readonly path: string;
  /** Index of the first line returned (0-based). */
  readonly offset: number;
  readonly lines: readonly string[];
  /** All lines of the file; `null` when the file is too big to count cheaply. */
  readonly totalLines: number | null;
  /** There are lines after these. */
  readonly more: boolean;
}

/**
 * Why something a page points at is not shown with it: `remote` another address
 * (nothing is ever fetched); `site-root` it starts at the site's root, which a file
 * alone does not tell; `missing` no such file, or it cannot be read; `outside` not in
 * a folder of the agent that holds the page (or one of git's own files); `kind` not a
 * stylesheet, a script or a picture; `secret` it looks like it holds secrets;
 * `too-large` the page's files together are over {@link AGENT_PAGE_ASSET_BYTES}, or
 * too many to look up.
 */
export type AgentPageLeftWhy = 'remote' | 'site-root' | 'missing' | 'outside' | 'kind' | 'secret' | 'too-large';

/** One thing a page points at that is not loaded. */
export interface AgentPageLeft {
  /** The address as a browser reads it from the page (character references decoded, the spaces around it dropped). */
  readonly ref: string;
  readonly why: AgentPageLeftWhy;
}

/** `GET …/files/page/info`: what an HTML file is shown with as a page. */
export interface AgentPageInfo {
  /** How many files (stylesheets, pictures and, with scripts, scripts) are put into it; one used twice counts once. */
  readonly loaded: number;
  /** The addresses it points at that are not loaded, each once, in the page's order: the first {@link AGENT_PAGE_LEFT_MAX}. A script is not among them while scripts are off. */
  readonly left: readonly AgentPageLeft[];
  /** How many more were left out than `left` lists. */
  readonly leftMore: number;
  /** The page has scripts of its own (a `<script>` or an `on…` attribute): they run only with `scripts=1`. */
  readonly scripted: boolean;
}

/** `POST …/files/open`: with the OS's own app for the file, or its folder with the file selected. */
export type AgentFileOpenHow = 'app' | 'folder';

export type AgentFileErrorCode = 'outside' | 'missing' | 'secret' | 'remote' | 'too-large' | 'invalid';

/** Lines per `/text` answer when `limit` is not given, and the most one answer holds. */
export const AGENT_FILE_TEXT_LINES = 2000;
/** A text file bigger than this is never read whole. */
export const AGENT_FILE_TEXT_BYTES = 2 * 1024 * 1024;
/** Entries per `/dir` answer. */
export const AGENT_DIR_MAX = 2000;
/** Files per `/files` answer. */
export const AGENT_FILES_MAX = 500;
/** An HTML file bigger than this is not shown as a page. */
export const AGENT_PAGE_BYTES = 4 * 1024 * 1024;
/** The most a page's own stylesheets, scripts and pictures may weigh together. */
export const AGENT_PAGE_ASSET_BYTES = 8 * 1024 * 1024;
/** Entries of {@link AgentPageInfo.left}. */
export const AGENT_PAGE_LEFT_MAX = 50;

// ── Kinds by name (pure; the server may still look at the bytes for an unknown name) ──

const KIND_BY_EXT: Readonly<Record<string, AgentFileKind>> = {
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', ico: 'image', avif: 'image',
  pdf: 'pdf',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio', opus: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video',
  csv: 'csv', tsv: 'csv',
};

const BINARY_EXT: ReadonlySet<string> = new Set([
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'o', 'obj', 'lib', 'a', 'pdb', 'class', 'pyc', 'wasm',
  'zip', '7z', 'gz', 'tgz', 'tar', 'rar', 'nupkg', 'snupkg', 'apk', 'aab', 'ipa', 'jar', 'iso', 'dmg', 'msi',
  'db', 'sqlite', 'sqlite3', 'mdf', 'ldf',
  'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'odt', 'ods',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'psd', 'ai', 'sketch', 'fig', 'heic', 'tif', 'tiff',
  'pfx', 'p12', 'keystore', 'jks', 'snk',
]);

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', opus: 'audio/opus',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
};

/** highlight.js names of lowlight's `common` set only (an unknown language stays plain). */
const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', webmanifest: 'json',
  cs: 'csharp', csx: 'csharp',
  xml: 'xml', xaml: 'xml', axml: 'xml', csproj: 'xml', props: 'xml', targets: 'xml', resx: 'xml', config: 'xml', html: 'xml', htm: 'xml', razor: 'xml', cshtml: 'xml', svg: 'xml', plist: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', rb: 'ruby', php: 'php', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', m: 'objectivec', mm: 'objectivec',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', lua: 'lua', r: 'r', pl: 'perl', vb: 'vbnet',
  ini: 'ini', toml: 'ini', editorconfig: 'ini', properties: 'ini',
  diff: 'diff', patch: 'diff',
};

/** The lower-case extension of a file name without the dot, `''` when it has none. */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** The kind a name tells; `null` when the name does not say (the server then looks at the bytes: text or binary). */
export function fileKindByName(name: string): AgentFileKind | null {
  const ext = extensionOf(name);
  if (ext in KIND_BY_EXT) return KIND_BY_EXT[ext] ?? null;
  if (BINARY_EXT.has(ext)) return 'binary';
  if (ext in LANGUAGE_BY_EXT) return 'text';
  return null;
}

/** The media type the raw route answers with for a name; `application/octet-stream` when unknown. */
export function mimeByName(name: string): string {
  return MIME_BY_EXT[extensionOf(name)] ?? 'application/octet-stream';
}

/** Whether a file of this name can be shown as a page (`…/files/page`): an HTML file. */
export function isPageName(name: string): boolean {
  const ext = extensionOf(name);
  return ext === 'html' || ext === 'htm';
}

/**
 * What "Open in its app" may hand to the operating system: documents, pictures, sound
 * and film, which their apps only show. An allow-list on purpose: which program an
 * extension starts is the system's choice (on Windows a `.py` runs, a `.url` or `.chm`
 * launches, `.html` and `.svg` run script in the browser), so a list of what must not
 * be opened can never be complete.
 */
const OPENS_IN_APP: ReadonlySet<string> = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'yml', 'yaml', 'toml', 'ini',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tif', 'tiff', 'heic',
  'pdf',
  'mp3', 'wav', 'ogg', 'm4a', 'flac', 'opus',
  'mp4', 'webm', 'mov', 'mkv',
  'docx', 'xlsx', 'pptx', 'odt', 'ods',
]);

/** Whether "Open in its app" is offered for a file of this name ({@link OPENS_IN_APP}). */
export function opensInApp(name: string): boolean {
  return OPENS_IN_APP.has(extensionOf(name));
}

/**
 * `true` for a network or device path as written (`\\host\share\…`, `//host/share/…`,
 * `\\?\…`, `\\.\…`). The server never touches one an agent named: opening it makes
 * Windows connect to that host and sign in there.
 */
export function isNetworkPath(written: string): boolean {
  return /^[\\/]{2}/.test(written.trim());
}

/** The highlight.js language of a name, `null` when unknown. */
export function languageByName(name: string): string | null {
  const base = (name.split(/[\\/]/).pop() ?? name).toLowerCase();
  if (base === 'makefile') return 'makefile';
  return LANGUAGE_BY_EXT[extensionOf(name)] ?? null;
}

// ── Paths in a reply (pure; the server and the chat must agree on these) ──────────

/** A path found in text. */
export interface PathRef {
  /** The path exactly as written, without its line suffix and trailing punctuation. */
  readonly path: string;
  /** The line it points at (1-based), `null` without one. */
  readonly line: number | null;
  /** Where the whole match (path + line suffix) starts in the text. */
  readonly index: number;
  /** Length of the whole match. */
  readonly length: number;
}

const SEGMENT = '[^\\\\/:*?"<>|\\s`\'()\\[\\]{}]+';
const WINDOWS_ABSOLUTE = `[A-Za-z]:[\\\\/](?:${SEGMENT}[\\\\/])*${SEGMENT}`;
const POSIX_ABSOLUTE = '(?<![\\w.:/~\\\\-])/(?:[\\w.@+~-]+/)+[\\w.@+~-]+';
const RELATIVE = '(?<![\\w@.:/\\\\~-])(?:\\.{1,2}[\\\\/])?(?:[\\w@+~-][\\w.@+~-]*[\\\\/])+[\\w@+~-][\\w.@+~-]*\\.[A-Za-z][A-Za-z0-9]{0,7}';
const LINE_SUFFIX = '(?::(\\d{1,6})(?::\\d{1,5})?|#L(\\d{1,6}))?';
const IN_PROSE = new RegExp(`(${WINDOWS_ABSOLUTE}|${POSIX_ABSOLUTE}|${RELATIVE})${LINE_SUFFIX}`, 'g');

/**
 * The paths written in running text (not inside code): absolute Windows and POSIX
 * paths, and relative ones that have a folder and an extension (`docs/chat.md:74`,
 * `src\\web\\App.tsx#L12`). Prose cannot tell where a path with spaces ends, so those
 * are found only in inline code ({@link pathRefOfCode}). A match is only a candidate:
 * the server decides whether it is a file.
 */
export function findPathRefs(text: string): PathRef[] {
  const found: PathRef[] = [];
  for (const match of text.matchAll(IN_PROSE)) {
    let path = match[1] ?? '';
    let trimmed = 0;
    while (path.length > 1 && /[.,;:!?]$/.test(path)) {
      path = path.slice(0, -1);
      trimmed += 1;
    }
    if (path === '') continue;
    let lineText = trimmed === 0 ? (match[2] ?? match[3]) : undefined;
    let length = trimmed === 0 ? match[0].length : path.length;
    // A Windows path's segment may hold `#`, so `App.tsx#L12` arrives as one piece: split it here.
    const hash = lineText === undefined ? /#L(\d{1,6})$/.exec(path) : null;
    if (hash) {
      length = path.length;
      path = path.slice(0, hash.index);
      lineText = hash[1];
    }
    found.push({ path, line: lineText ? Number(lineText) : null, index: match.index ?? 0, length });
  }
  return found;
}

const CODE_LINE_SUFFIX = /(?::(\d{1,6})(?::\d{1,5})?|#L(\d{1,6}))$/;
const CODE_WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/][^:*?"<>|\r\n]+$/;
const CODE_POSIX_ABSOLUTE = /^~?\/(?:[^/\r\n]+\/)*[^/\r\n]+$/;
const CODE_RELATIVE = /^(?:\.{1,2}[\\/])?[^\\/:*?"<>|\s]+(?:[\\/][^\\/:*?"<>|\s]+)+$/;
const CODE_FILE_NAME = /^[\w@+~-][\w.@+~-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/;
/** A dotfile by its bare name: `.env`, `.gitignore`, `.env.local`. */
const CODE_DOT_FILE = /^\.[A-Za-z][\w-]*(\.[\w-]+)*$/;

/**
 * The path an inline code span holds, when the whole span is one: an absolute path
 * (Windows ones may hold spaces), a relative path with a folder, or a bare file name
 * with an extension (`README.md`), each with an optional `:line` / `#Lline`. `null`
 * for anything else (a command, a symbol). Again only a candidate.
 */
export function pathRefOfCode(code: string): PathRef | null {
  const text = code.trim();
  if (text === '' || text.length > 400 || /[\r\n]/.test(text)) return null;
  const suffix = CODE_LINE_SUFFIX.exec(text);
  const path = suffix ? text.slice(0, suffix.index) : text;
  const lineText = suffix ? (suffix[1] ?? suffix[2]) : undefined;
  if (!(CODE_WINDOWS_ABSOLUTE.test(path) || CODE_POSIX_ABSOLUTE.test(path) || CODE_RELATIVE.test(path) || CODE_FILE_NAME.test(path) || CODE_DOT_FILE.test(path))) return null;
  if (/^\d+(\.\d+)+$/.test(path)) return null; // a version number, not a file
  return { path, line: lineText ? Number(lineText) : null, index: code.indexOf(text), length: text.length };
}

/**
 * Every path candidate of a Markdown reply: the inline code spans that are paths and
 * the paths in its prose. Fenced code blocks are skipped (they are code, not
 * pointers). One entry per distinct path, the first line it was given with.
 */
export function mentionedPathRefs(markdown: string): PathRef[] {
  const withoutFences = markdown.replace(/(^|\n)(```|~~~)[\s\S]*?(\n\2[^\n]*|$)/g, '\n');
  const refs: PathRef[] = [];
  const prose = withoutFences.replace(/`([^`\n]+)`/g, (whole: string, code: string, offset: number) => {
    const ref = pathRefOfCode(code);
    if (ref) refs.push({ ...ref, index: offset + 1 + ref.index });
    return ' '.repeat(whole.length);
  });
  refs.push(...findPathRefs(prose));
  const seen = new Map<string, PathRef>();
  for (const ref of refs.sort((a, b) => a.index - b.index)) {
    const earlier = seen.get(ref.path);
    if (!earlier) seen.set(ref.path, ref);
    else if (earlier.line === null && ref.line !== null) seen.set(ref.path, { ...earlier, line: ref.line });
  }
  return [...seen.values()];
}
