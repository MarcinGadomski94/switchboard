/**
 * D57 · Paste and attach images and files (`docs/decisions.md` → D57,
 * `docs/chat.md` → *Attachments*). The pure rules shared by the server (upload,
 * storage, the stdin line) and the UI (the composer's chips): the caps, which
 * files are sniffed as images / PDFs, which go to the agent **inline** (content
 * blocks in the stream-json user message) and which as **files** (saved in the
 * data folder, their paths in the message text), safe stored names, and the
 * content blocks themselves.
 *
 * CLI evidence (2.1.284 / 2.1.285, read-only in the binary): a stream-json user
 * message's `content` may be an array of `text`, `image` (`source: {type:
 * "base64", media_type: image/jpeg|png|gif|webp, data}`) and `document`
 * (`source: {type: "base64", media_type: "application/pdf", data}`) blocks; the
 * CLI's image limits are `maxWidth 2000`, `maxHeight 2000`, `maxBase64Size
 * 5 242 880`, `targetRawSize 3 932 160`; a PDF it reads is at most 20 MiB and
 * 100 pages; a request is at most 32 MiB.
 */

/** Largest file one upload takes (20 MiB, ASSUMED D57-caps). */
export const ATTACHMENT_FILE_MAX = 20 * 1024 * 1024;

/** Largest sum of the files one message carries (50 MiB, ASSUMED D57-caps). */
export const ATTACHMENT_MESSAGE_MAX = 50 * 1024 * 1024;

/** Most files one message carries (ASSUMED D57-caps). */
export const ATTACHMENTS_PER_MESSAGE_MAX = 20;

/**
 * Largest request body of an upload (the JSON `{ name, data }` with the file as
 * base64: 4/3 of {@link ATTACHMENT_FILE_MAX} plus room for the name).
 */
export const ATTACHMENT_UPLOAD_BODY_MAX = Math.ceil((ATTACHMENT_FILE_MAX * 4) / 3) + 64 * 1024;

/** Longest name kept (characters, before the extension is re-attached). */
export const ATTACHMENT_NAME_MAX = 120;

/** The CLI's own image limits (2.1.284 `cP`): an image above them is resized by the CLI, or refused. */
export const CLI_IMAGE_LIMITS = { maxEdge: 2000, maxBase64Size: 5_242_880, targetRawSize: 3_932_160 } as const;

/** Largest image sent inline (raw bytes): the CLI's `targetRawSize`. A larger one goes as a file. */
export const INLINE_IMAGE_MAX = CLI_IMAGE_LIMITS.targetRawSize;

/** Largest PDF sent inline (raw bytes): the CLI's own PDF limit (20 MiB). */
export const INLINE_PDF_MAX = 20 * 1024 * 1024;

/** Most pages of a PDF sent inline (the CLI's / API's limit). */
export const INLINE_PDF_PAGES_MAX = 100;

/**
 * Most base64 characters one message carries inline (ASSUMED D57-inline-budget:
 * the API's 32 MiB request limit less 8 MiB for the conversation, as the CLI's
 * own `TWo` budget). What does not fit goes as a file.
 */
export const INLINE_BUDGET_BASE64 = 32 * 1024 * 1024 - 8 * 1024 * 1024;

/** How long an attachment is kept (days); older ones are removed at start (ASSUMED D57-retention). */
export const ATTACHMENT_RETENTION_DAYS = 30;

/** The image types the CLI takes inline. */
export const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** A sniffed inline type. */
export type SniffedType = (typeof INLINE_IMAGE_TYPES)[number] | 'application/pdf';

/** What an attachment is: an image or a PDF (sniffed from its bytes), else any other file. */
export type AttachmentKind = 'image' | 'pdf' | 'file';

/** How it reached the agent: as a content block, or as a path in the message text. */
export type AttachmentDelivery = 'inline' | 'file';

/**
 * An attachment as the API answers an upload (`POST …/attachments`) and as a
 * message's event lists it (`UserPayload.attachments`): no path, no bytes.
 */
export interface Attachment {
  /** Its id (a UUID); `null` for an image a transcript names without its bytes (shown as a placeholder). */
  readonly id: string | null;
  /** The file name (sanitized). */
  readonly name: string;
  /** Size in bytes (0 when unknown). */
  readonly size: number;
  readonly kind: AttachmentKind;
  /** The served content type: the sniffed image / PDF type, else `application/octet-stream`. */
  readonly mediaType: string;
  /** Set on a sent message: inline (content block) or file (a path in the text). */
  readonly delivery?: AttachmentDelivery;
}

/**
 * The image / PDF type of `bytes` from its magic bytes, else `null` (the name and
 * the browser's claim are never trusted; SVG, HTML and everything else are files).
 */
export function sniffType(bytes: Uint8Array): SniffedType | null {
  const at = (index: number): number => bytes[index] ?? -1;
  const ascii = (start: number, text: string): boolean => [...text].every((char, index) => at(start + index) === char.charCodeAt(0));
  if (bytes.length >= 8 && at(0) === 0x89 && ascii(1, 'PNG') && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return 'image/png';
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) return 'image/gif';
  if (bytes.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (bytes.length >= 5 && ascii(0, '%PDF-')) return 'application/pdf';
  return null;
}

/** The kind a sniffed type gives. */
export function kindOf(sniffed: SniffedType | null): AttachmentKind {
  if (sniffed === 'application/pdf') return 'pdf';
  return sniffed === null ? 'file' : 'image';
}

/** The content type an attachment is served (and listed) with. */
export function servedType(sniffed: SniffedType | null): string {
  return sniffed ?? 'application/octet-stream';
}

/** Characters never kept in a stored name: separators, control characters and the ones Windows refuses. */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

/**
 * A file name that is safe to store and to show: the last path segment, unsafe
 * characters as `_`, no leading dots or spaces, at most {@link ATTACHMENT_NAME_MAX}
 * characters (the extension kept), `file` when nothing is left. `../../etc/passwd`
 * → `passwd`; `a\b.txt` → `b.txt`.
 */
export function safeFileName(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  const last = raw.split(/[\\/]/).pop() ?? '';
  let clean = last.normalize('NFC').replace(UNSAFE_NAME, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').trim();
  if (clean.length > ATTACHMENT_NAME_MAX) {
    const dot = clean.lastIndexOf('.');
    const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : '';
    clean = `${clean.slice(0, ATTACHMENT_NAME_MAX - ext.length)}${ext}`;
  }
  return clean === '' ? 'file' : clean;
}

/** `12 B`, `12 KB`, `1.2 MB` (1024-based, one decimal under 10). */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
  return `${text} ${units[unit]}`;
}

/** Why a set of attachments is refused (`null` = fine): too many, or too large together. */
export function messageCapProblem(sizes: readonly number[]): string | null {
  if (sizes.length > ATTACHMENTS_PER_MESSAGE_MAX) return `a message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX} attachments`;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total > ATTACHMENT_MESSAGE_MAX) return `a message carries at most ${formatSize(ATTACHMENT_MESSAGE_MAX)} of attachments (these are ${formatSize(total)})`;
  return null;
}

/** Why one file is refused (`null` = fine): empty, or larger than {@link ATTACHMENT_FILE_MAX}. */
export function fileCapProblem(size: number): string | null {
  if (size <= 0) return 'the file is empty';
  if (size > ATTACHMENT_FILE_MAX) return `a file is at most ${formatSize(ATTACHMENT_FILE_MAX)} (this one is ${formatSize(size)})`;
  return null;
}

/**
 * The number of pages a PDF declares (`/Type /Page` objects, not `/Pages`), read
 * from its bytes; a rough count (compressed object streams hide pages), `0` when none is seen.
 */
export function pdfPageCount(bytes: Uint8Array): number {
  let count = 0;
  const pattern = /\/Type\s*\/Page(?![a-zA-Z])/g;
  // In overlapping chunks (a match is short), so a large PDF is never one huge string.
  const chunk = 1 << 20;
  const overlap = 32;
  for (let start = 0; start < bytes.length; start += chunk) {
    const end = Math.min(bytes.length, start + chunk + overlap);
    let text = '';
    for (let index = start; index < end; index += 8192) {
      text += String.fromCharCode(...bytes.subarray(index, Math.min(end, index + 8192)));
    }
    for (const match of text.matchAll(pattern)) {
      // A match that starts in the overlap belongs to the next chunk.
      if ((match.index ?? 0) < chunk) count++;
    }
  }
  return count;
}

/** One attachment of a message as the delivery plan sees it. */
export interface PlanItem {
  readonly kind: AttachmentKind;
  readonly size: number;
  /** PDFs: the page count ({@link pdfPageCount}). */
  readonly pages?: number;
}

/**
 * Which attachments go inline (D57 ruling: images and PDFs, when the CLI takes
 * them) and which as files. With `inline: false` (a hooked terminal session:
 * hooks carry text only) everything is a file. An image larger than
 * {@link INLINE_IMAGE_MAX}, a PDF larger than {@link INLINE_PDF_MAX} or with more
 * than {@link INLINE_PDF_PAGES_MAX} pages, and whatever no longer fits the
 * message's {@link INLINE_BUDGET_BASE64} (in order) goes as a file instead.
 */
export function planDelivery(items: readonly PlanItem[], options: { readonly inline: boolean }): AttachmentDelivery[] {
  let budget = INLINE_BUDGET_BASE64;
  return items.map((item) => {
    if (!options.inline || item.kind === 'file') return 'file';
    if (item.kind === 'image' && item.size > INLINE_IMAGE_MAX) return 'file';
    if (item.kind === 'pdf' && (item.size > INLINE_PDF_MAX || (item.pages ?? 0) > INLINE_PDF_PAGES_MAX)) return 'file';
    const cost = Math.ceil(item.size / 3) * 4;
    if (cost > budget) return 'file';
    budget -= cost;
    return 'inline';
  });
}

/** A content block of a stream-json user message (the shapes the CLI takes). */
export type UserContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly source: { readonly type: 'base64'; readonly media_type: string; readonly data: string } }
  | { readonly type: 'document'; readonly source: { readonly type: 'base64'; readonly media_type: 'application/pdf'; readonly data: string }; readonly title?: string };

/** The block of one inline attachment: an `image` for an image, a `document` (with its name as `title`) for a PDF. */
export function inlineBlock(kind: 'image' | 'pdf', mediaType: string, base64: string, name: string): UserContentBlock {
  if (kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 }, title: name };
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
}

/** One file whose path the message names. */
export interface AttachedFile {
  readonly path: string;
  readonly size: number;
}

/** The heading of the paths the message names. */
export const ATTACHED_FILES_HEADING = 'Attached files:';

/**
 * The lines that tell the agent where the attached files are (D57 ruling: other
 * files are saved and named by their absolute paths):
 * `Attached files:\n- /…/attachments/<session>/<id>-log.txt (12 KB)`; `''` for none.
 */
export function attachedFilesText(files: readonly AttachedFile[]): string {
  if (files.length === 0) return '';
  return [ATTACHED_FILES_HEADING, ...files.map((file) => `- ${file.path} (${formatSize(file.size)})`)].join('\n');
}

/** The text that goes to the agent: the message, then (after a blank line) the attached files' lines. */
export function messageWithFiles(text: string, filesText: string): string {
  if (filesText === '') return text;
  return text.trim() === '' ? filesText : `${text}\n\n${filesText}`;
}

/**
 * The `content` of a stream-json user message: the inline blocks first (as
 * claude.ai sends them), then the text block; a text-only message stays a plain
 * string, as before D57. An empty text adds no text block (the API refuses empty ones).
 */
export function userContent(text: string, blocks: readonly UserContentBlock[]): string | UserContentBlock[] {
  if (blocks.length === 0) return text;
  return text === '' ? [...blocks] : [...blocks, { type: 'text', text }];
}

/** How many images and PDFs a user message's content carries (`[fake: 1 image, 1 document]`, the transcript's placeholders). */
export function mediaCounts(content: unknown): { readonly images: number; readonly documents: number } {
  if (!Array.isArray(content)) return { images: 0, documents: 0 };
  let images = 0;
  let documents = 0;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const type = (block as { type?: unknown }).type;
    if (type === 'image') images++;
    else if (type === 'document') documents++;
  }
  return { images, documents };
}

/** An image block of a transcript's user line: its type and bytes (base64) when the transcript has them. */
export interface TranscriptImage {
  readonly mediaType: string | null;
  readonly data: string | null;
}

/** The image blocks of a user line's `content`, in order (a base64 source gives its data; any other source none). */
export function transcriptImages(content: unknown): TranscriptImage[] {
  if (!Array.isArray(content)) return [];
  const out: TranscriptImage[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null || (block as { type?: unknown }).type !== 'image') continue;
    const source = (block as { source?: unknown }).source;
    const record = typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : null;
    const base64 = record?.['type'] === 'base64' && typeof record['data'] === 'string' && record['data'] !== '' ? record['data'] : null;
    const mediaType = typeof record?.['media_type'] === 'string' ? record['media_type'] : null;
    out.push({ mediaType, data: base64 });
  }
  return out;
}

/** The placeholder name of an image a transcript has no bytes of. */
export const IMAGE_PLACEHOLDER = 'image';

/** The listing of an image a transcript names without its bytes (the bubble shows a placeholder "image"). */
export function placeholderImage(mediaType: string | null = null): Attachment {
  return { id: null, name: IMAGE_PLACEHOLDER, size: 0, kind: 'image', mediaType: mediaType ?? 'image/png' };
}

/** The event label of a message that carries only attachments: `Attached shot.png`, `Attached 3 files`. */
export function attachmentsLabel(attachments: readonly Attachment[]): string {
  if (attachments.length === 1) return `Attached ${attachments[0]?.name ?? 'a file'}`;
  return `Attached ${attachments.length} files`;
}
