/**
 * D89 (`docs/artifacts.md`): artifacts are saved on purpose, like Claude's
 * artifacts on claude.ai. An artifact is a deliverable the developer should see
 * (a report, a plan, a doc, a diagram, a mockup, a table), saved by the session's
 * agent with the `switchboard` MCP tool `artifact_save`, or by the developer from a
 * chat message. Saving again with the same id adds a version. These are the rules
 * the server, the UI and the MCP helper share. Pure: no I/O.
 *
 * Replaces the automatic Artifacts derivation (gap #9, `docs/derivations.md` →
 * *Artifacts*, replaced by D89).
 */
import type { Artifact, ArtifactKind } from './api.ts';
import type { TodoToolDefinition } from './todos.ts';

/** D89: the kinds, in the order the UI lists them. */
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['markdown', 'code', 'html', 'mermaid', 'svg', 'image', 'csv'];

/** D89: `true` for one of {@link ARTIFACT_KINDS}. */
export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

/** D89: `true` for a kind stored as text (every kind but `image`): it has a source view and a version diff. */
export function isTextKind(kind: ArtifactKind): boolean {
  return kind !== 'image';
}

/** D89: the largest text version (UTF-8 bytes): 2 MiB. */
export const ARTIFACT_TEXT_MAX = 2 * 1024 * 1024;

/** D89: the largest image version (bytes): 10 MiB. */
export const ARTIFACT_IMAGE_MAX = 10 * 1024 * 1024;

/** D89: the body limit of a save (`POST`): a 2 MiB text as JSON, escapes included, with room to spare. */
export const ARTIFACT_SAVE_BODY_MAX = 3 * ARTIFACT_TEXT_MAX + 64 * 1024;

/** D89: the longest title (characters, one line). */
export const ARTIFACT_TITLE_MAX = 120;

/** D89: the most artifacts one session keeps (a runaway agent stops here). */
export const ARTIFACTS_PER_SESSION_MAX = 200;

/** D89: the most versions one artifact keeps. */
export const ARTIFACT_VERSIONS_MAX = 100;

/** D89: the most CSV rows the viewer shows (the header included); the rest is counted, not drawn. */
export const ARTIFACT_CSV_ROWS_MAX = 500;

/** D89: the image types an `image` artifact may be (sniffed from the file's bytes) and their file extensions. */
export const ARTIFACT_IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** A check's answer: the value, or why it cannot be one. */
export type ArtifactCheck<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** D89: a title trimmed (1–120 characters, one line), or why it cannot be one. */
export function checkArtifactTitle(title: unknown): ArtifactCheck<string> {
  if (typeof title !== 'string') return { ok: false, message: 'title must be a string' };
  const trimmed = title.trim();
  if (trimmed === '') return { ok: false, message: 'title must not be empty' };
  if (/[\r\n]/.test(trimmed)) return { ok: false, message: 'title must be one line' };
  if (trimmed.length > ARTIFACT_TITLE_MAX) return { ok: false, message: `title must be at most ${ARTIFACT_TITLE_MAX} characters` };
  return { ok: true, value: trimmed };
}

/** D89: a code language (`ts`, `c++`, `objective-c`, `f#`): letters, digits, `+ # . _ -`, at most 40; `null` for none. */
export function checkArtifactLanguage(language: unknown): ArtifactCheck<string | null> {
  if (language === undefined || language === null) return { ok: true, value: null };
  if (typeof language !== 'string') return { ok: false, message: 'language must be a string' };
  const trimmed = language.trim().toLowerCase();
  if (trimmed === '') return { ok: true, value: null };
  if (!/^[a-z0-9+#._-]{1,40}$/.test(trimmed)) return { ok: false, message: 'language must be a short name such as ts, python or sql' };
  return { ok: true, value: trimmed };
}

/** The UTF-8 size of a text, in bytes. */
export function utf8Size(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** D89: why a text version cannot be stored (`null` when it can): empty, over {@link ARTIFACT_TEXT_MAX}, or an `svg` that is not SVG markup. */
export function textContentProblem(kind: ArtifactKind, content: string): string | null {
  if (content.trim() === '') return 'content must not be empty';
  if (utf8Size(content) > ARTIFACT_TEXT_MAX) return `content must be at most ${ARTIFACT_TEXT_MAX / 1024 / 1024} MB`;
  if (kind === 'svg' && !/<svg[\s>]/i.test(content)) return 'an svg artifact must be SVG markup (<svg …>)';
  return null;
}

/** Common code languages and their file extensions (the rest download as `.txt`). */
const CODE_EXTENSIONS: Readonly<Record<string, string>> = {
  ts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  js: 'js',
  javascript: 'js',
  jsx: 'jsx',
  json: 'json',
  py: 'py',
  python: 'py',
  rb: 'rb',
  ruby: 'rb',
  go: 'go',
  rust: 'rs',
  rs: 'rs',
  java: 'java',
  kotlin: 'kt',
  kt: 'kt',
  swift: 'swift',
  cs: 'cs',
  csharp: 'cs',
  'c#': 'cs',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  shell: 'sh',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  html: 'html',
  markdown: 'md',
  md: 'md',
  php: 'php',
  diff: 'diff',
  dockerfile: 'dockerfile',
  hcl: 'tf',
  terraform: 'tf',
};

/** D89: the file extension of a version: by kind; `code` by its language; `image` by its media type. */
export function artifactExtension(kind: ArtifactKind, language: string | null = null, mediaType: string | null = null): string {
  switch (kind) {
    case 'markdown':
      return 'md';
    case 'html':
      return 'html';
    case 'mermaid':
      return 'mmd';
    case 'svg':
      return 'svg';
    case 'csv':
      return 'csv';
    case 'image':
      return (mediaType && ARTIFACT_IMAGE_TYPES[mediaType]) || 'bin';
    case 'code':
      return (language && CODE_EXTENSIONS[language]) || 'txt';
  }
}

/** D89: a download's file name: the title made safe, plus the extension. */
export function artifactFileName(title: string, extension: string): string {
  // eslint-disable-next-line no-control-regex
  const base = title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 100) || 'artifact';
  return `${base}.${extension}`;
}

/**
 * D89: the title a chat message's "Save as artifact" proposes: its first Markdown
 * heading, else its first non-empty line, without Markdown markup, cut to
 * {@link ARTIFACT_TITLE_MAX}; `Untitled` when nothing is left.
 */
export function messageArtifactTitle(text: string): string {
  const lines = text.split('\n');
  const inFence = (index: number): boolean => lines.slice(0, index).filter((line) => /^\s*(```|~~~)/.test(line)).length % 2 === 1;
  const headingAt = lines.findIndex((line, index) => /^\s{0,3}#{1,6}\s+\S/.test(line) && !inFence(index));
  const raw = headingAt >= 0 ? (lines[headingAt] ?? '') : (lines.find((line) => line.trim() !== '' && !/^\s*(```|~~~)/.test(line)) ?? '');
  const plain = raw
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain === '') return 'Untitled';
  return plain.length > ARTIFACT_TITLE_MAX ? `${plain.slice(0, ARTIFACT_TITLE_MAX - 1)}…` : plain;
}

/** D89: a code text as one fenced Markdown block (the fence longer than any run of backticks inside), so the chat renderer highlights it. */
export function codeFence(text: string, language: string | null): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language ?? ''}\n${text.replace(/\n$/, '')}\n${fence}`;
}

/** Result of {@link parseCsv}. */
export interface CsvTable {
  readonly rows: readonly (readonly string[])[];
  /** How many rows there were in all (`rows` holds at most the cap). */
  readonly total: number;
}

/**
 * D89: a CSV text as rows (RFC 4180: `,` separated, `"` quoted, `""` inside
 * quotes, CRLF or LF line ends; a trailing line end adds no row), at most
 * `maxRows` of them kept.
 */
export function parseCsv(text: string, maxRows: number = ARTIFACT_CSV_ROWS_MAX): CsvTable {
  const rows: string[][] = [];
  let total = 0;
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false;
  const endRow = (): void => {
    row.push(cell);
    total++;
    if (rows.length < maxRows) rows.push(row);
    row = [];
    cell = '';
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"' && cell === '') {
      quoted = true;
      started = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
      started = true;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else {
      cell += char;
      started = true;
    }
  }
  if (started || cell !== '' || row.length > 0) endRow();
  return { rows, total };
}

/** One line of {@link lineDiff}. */
export interface DiffLine {
  readonly op: 'same' | 'add' | 'del';
  readonly text: string;
}

/** D89: above this many lines on either side, {@link lineDiff} shows the whole old text removed and the new one added. */
export const LINE_DIFF_MAX_LINES = 20_000;

/**
 * D89: the line diff between two versions (Myers' O(ND) algorithm, the old
 * text's lines first where both changed). Texts over {@link LINE_DIFF_MAX_LINES}
 * lines, or whose edit distance passes `maxEdits`, come back as all removed then all added.
 */
export function lineDiff(before: string, after: string, maxEdits = 4_000): DiffLine[] {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  const whole = (): DiffLine[] => [...a.map((text) => ({ op: 'del' as const, text })), ...b.map((text) => ({ op: 'add' as const, text }))];
  if (a.length > LINE_DIFF_MAX_LINES || b.length > LINE_DIFF_MAX_LINES) return whole();
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = n + m === 0;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) x = v[offset + k + 1] as number;
      else x = (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    v = next;
  }
  if (!found) return whole();
  // Walk the trace back from (n, m).
  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d] as Int32Array;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (vd[offset + k - 1] as number) < (vd[offset + k + 1] as number))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : (vd[offset + prevK] as number);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ op: 'same', text: a[x - 1] as string });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ op: 'add', text: b[y - 1] as string });
      else out.push({ op: 'del', text: a[x - 1] as string });
      x = prevX;
      y = prevY;
    }
  }
  while (x > 0 && y > 0) {
    out.push({ op: 'same', text: a[x - 1] as string });
    x--;
    y--;
  }
  return out.reverse();
}

/** D89: a size as the UI and the tools show it (`812 B`, `14.2 KB`, `1.3 MB`). */
export function artifactSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** D89: one artifact as `artifact_list` prints it: `[id] Title · kind · v3 · 14.2 KB`. */
export function artifactLine(artifact: Pick<Artifact, 'id' | 'title' | 'kind' | 'language' | 'versions' | 'size' | 'createdBy'>): string {
  const kind = artifact.kind === 'code' && artifact.language ? `code (${artifact.language})` : artifact.kind;
  return `[${artifact.id}] ${artifact.title} · ${kind} · v${artifact.versions} · ${artifactSizeLabel(artifact.size)}${artifact.createdBy === 'developer' ? ' · saved by the developer' : ''}`;
}

/** D89: the `artifact_list` text. */
export function artifactListText(artifacts: readonly Artifact[]): string {
  if (artifacts.length === 0) return 'This session has no artifacts yet.';
  return [`This session's artifacts (${artifacts.length}), newest first:`, ...artifacts.map(artifactLine)].join('\n');
}

const ARTIFACT_ID = { type: 'string', description: 'The artifact id, as artifact_save and artifact_list show it in brackets.' } as const;

/** Hints of a tool that only reads. */
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/**
 * D89: the artifact tools of the `switchboard` MCP server (next to the todo tools,
 * same helper, same session token): `artifact_save`, `artifact_list`, `artifact_get`.
 */
export const ARTIFACT_TOOLS: readonly TodoToolDefinition[] = [
  {
    name: 'artifact_save',
    description:
      "Save a deliverable the developer should see as an artifact in Switchboard (a report, plan, doc, diagram, mockup or table), shown in the session's Artifacts tab. Not for ordinary file edits. To revise one, pass its id: that adds a new version of the same artifact; do not create near-duplicates. Give content (the text), or path (a file in the session's working folders, copied now; required for image). Returns the artifact id and version.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `A short title (one line, at most ${ARTIFACT_TITLE_MAX} characters), e.g. "Release plan".` },
        kind: {
          type: 'string',
          enum: [...ARTIFACT_KINDS],
          description: 'markdown (docs, reports, plans), code (one source file; give language), html (a self-contained page or mockup: it runs sandboxed, without network), mermaid (diagram source), svg, image (png / jpg / gif / webp, by path), csv (a table).',
        },
        content: { type: 'string', description: `The artifact's text (at most ${ARTIFACT_TEXT_MAX / 1024 / 1024} MB). Give content or path.` },
        path: { type: 'string', description: `A file to copy in instead of content (absolute, or relative to the session's working folder; it must be inside the session's working folders). Text up to ${ARTIFACT_TEXT_MAX / 1024 / 1024} MB, images up to ${ARTIFACT_IMAGE_MAX / 1024 / 1024} MB.` },
        language: { type: 'string', description: 'For kind code: the language (ts, python, sql, …).' },
        id: { ...ARTIFACT_ID, description: 'To save a new version of an existing artifact of this session: its id. Leave it out to create a new artifact.' },
      },
      required: ['title', 'kind'],
      additionalProperties: false,
    },
    annotations: { title: 'Save an artifact', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'artifact_list',
    description: "List this session's artifacts (id, title, kind, version count, size), newest first. Use it to find the id of an artifact to update.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List artifacts', ...READS },
  },
  {
    name: 'artifact_get',
    description: "Read one of this session's artifacts: its latest version's text, or the version you name.",
    inputSchema: {
      type: 'object',
      properties: { id: ARTIFACT_ID, version: { type: 'integer', minimum: 1, maximum: ARTIFACT_VERSIONS_MAX, description: 'The version number (default: the latest).' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { title: 'Read an artifact', ...READS },
  },
];

/** D89: the sentence the `switchboard` MCP server's instructions add about artifacts. */
export const ARTIFACT_INSTRUCTIONS =
  'Save deliverables the developer should see (reports, plans, docs, diagrams, mockups, tables) with artifact_save; to revise one, save again with its id (a new version) instead of creating a new artifact.';
