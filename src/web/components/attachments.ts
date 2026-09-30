/**
 * D57 · attachments in the chat composer and the New-session forms (`docs/chat.md`
 * → *Attachments*): the pure model of the draft's chips (what a paste or a drop
 * holds, the caps, what blocks Send, how an image is downscaled first) and the
 * browser helpers that read a file into base64. The views: `Attachments.tsx`.
 */
import {
  ATTACHMENTS_PER_MESSAGE_MAX,
  ATTACHMENT_FILE_MAX,
  ATTACHMENT_MESSAGE_MAX,
  type Attachment,
  type AttachmentKind,
  CLI_IMAGE_LIMITS,
  INLINE_IMAGE_MAX,
  formatSize,
} from '../../core/attachments.ts';

/** Where a chip is: its file being read (and downscaled), uploading, uploaded, or refused. */
export type DraftState = 'reading' | 'uploading' | 'ready' | 'error';

/** One chip of the draft. */
export interface DraftAttachment {
  /** Local key (stable while the chip lives). */
  readonly key: string;
  readonly name: string;
  readonly size: number;
  /** What it shows as: from the browser's type while it is local, the server's (sniffed) once uploaded. */
  readonly kind: AttachmentKind;
  /** An image's thumbnail: an object URL of the local file, or the served attachment's URL. */
  readonly previewUrl: string | null;
  readonly state: DraftState;
  /** The server's id once uploaded. */
  readonly id: string | null;
  /** Why it could not be read or uploaded. */
  readonly error: string | null;
  /** The file as base64 once read (forms upload it at Start). */
  readonly data?: string;
}

/** The types the browser reports for images the CLI takes inline (for the chip's look only: the server sniffs). */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The chip's kind from the browser's type and the name (the server's sniffing decides for real). */
export function guessKind(type: string, name: string): AttachmentKind {
  if (IMAGE_TYPES.has(type.toLowerCase())) return 'image';
  if (type.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  return 'file';
}

/** The parts of a `DataTransfer` the model reads (clipboard or drop). */
export interface TransferLike {
  readonly files?: ArrayLike<File> | null;
  readonly items?: ArrayLike<{ readonly kind: string; getAsFile(): File | null }> | null;
  readonly types?: ArrayLike<string> | null;
}

/**
 * The files a paste or a drop holds: the `file` items (a screenshot on the
 * clipboard, copied files where the browser exposes them), else `files`.
 */
export function filesFromTransfer(transfer: TransferLike | null | undefined): File[] {
  if (!transfer) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return Array.from(transfer.files ?? []);
}

/** `true` while a drag carries files (the drop zone lights up only then, not for dragged text). */
export function dragHasFiles(transfer: TransferLike | null | undefined): boolean {
  return Array.from(transfer?.types ?? []).includes('Files');
}

/**
 * Which of `incoming` (name + size) can join the draft: each at most 20 MiB, at
 * most 20 together, at most 50 MiB together; the rest is refused with the reason
 * (one line per refusal).
 */
export function acceptFiles(
  existing: ReadonlyArray<Pick<DraftAttachment, 'size' | 'state'>>,
  incoming: ReadonlyArray<{ readonly name: string; readonly size: number }>,
): { readonly accepted: number[]; readonly problems: string[] } {
  const live = existing.filter((item) => item.state !== 'error');
  let count = live.length;
  let total = live.reduce((sum, item) => sum + item.size, 0);
  const accepted: number[] = [];
  const problems: string[] = [];
  incoming.forEach((file, index) => {
    if (file.size <= 0) problems.push(`${file.name}: the file is empty`);
    else if (file.size > ATTACHMENT_FILE_MAX) problems.push(`${file.name}: a file is at most ${formatSize(ATTACHMENT_FILE_MAX)} (this one is ${formatSize(file.size)})`);
    else if (count + 1 > ATTACHMENTS_PER_MESSAGE_MAX) problems.push(`${file.name}: a message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX} attachments`);
    else if (total + file.size > ATTACHMENT_MESSAGE_MAX) problems.push(`${file.name}: a message carries at most ${formatSize(ATTACHMENT_MESSAGE_MAX)} of attachments`);
    else {
      accepted.push(index);
      count++;
      total += file.size;
    }
  });
  return { accepted, problems };
}

/** What keeps Send (or Start) waiting: a chip still reading or uploading, or one that failed; `null` = nothing. */
export function attachmentsBlocker(items: readonly DraftAttachment[]): string | null {
  if (items.some((item) => item.state === 'reading' || item.state === 'uploading')) return 'Attaching…';
  if (items.some((item) => item.state === 'error')) return 'Remove the attachments that could not be added';
  return null;
}

/** The ids a message carries (the uploaded chips, in order). */
export function readyIds(items: readonly DraftAttachment[]): string[] {
  return items.filter((item) => item.state === 'ready' && item.id !== null).map((item) => item.id as string);
}

/**
 * The draft to send, or `null` when nothing would go (no text and no attachment)
 * or something still blocks (a chip reading, uploading or failed).
 */
export function messageToSend(draft: string, items: readonly DraftAttachment[]): { readonly text: string; readonly attachments: string[] } | null {
  if (attachmentsBlocker(items) !== null) return null;
  const text = draft.trim();
  const attachments = readyIds(items);
  if (text === '' && attachments.length === 0) return null;
  return { text, attachments };
}

/** The chip of an attachment the server already has (a Stop's withdrawn message): ready, its thumbnail served. */
export function chipOf(attachment: Attachment, key: string, url: string | null): DraftAttachment {
  return {
    key,
    name: attachment.name,
    size: attachment.size,
    kind: attachment.kind,
    previewUrl: attachment.kind === 'image' ? url : null,
    state: attachment.id === null ? 'error' : 'ready',
    id: attachment.id,
    error: attachment.id === null ? 'no longer available' : null,
  };
}

/** How an image is re-encoded before upload, or `null` to send it as it is. */
export interface DownscalePlan {
  readonly width: number;
  readonly height: number;
  readonly type: 'image/png' | 'image/jpeg';
}

/**
 * Whether an image is downscaled in the browser first (ASSUMED D57-downscale): a
 * PNG, JPEG or WebP with an edge over the CLI's 2000 px, or larger than what goes
 * inline (3.75 MB), is redrawn to fit 2000 px (aspect kept; a PNG stays PNG, the
 * others become JPEG). GIFs (animation) and other files are never touched.
 */
export function downscalePlan(type: string, width: number, height: number, size: number): DownscalePlan | null {
  const kind = type.toLowerCase();
  if (kind !== 'image/png' && kind !== 'image/jpeg' && kind !== 'image/webp') return null;
  if (width <= 0 || height <= 0) return null;
  const edge = Math.max(width, height);
  if (edge <= CLI_IMAGE_LIMITS.maxEdge && size <= INLINE_IMAGE_MAX) return null;
  const scale = Math.min(1, CLI_IMAGE_LIMITS.maxEdge / edge);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), type: kind === 'image/png' ? 'image/png' : 'image/jpeg' };
}

/** Base64 of bytes (chunked, so a large file never makes one huge argument list). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** The name an image pasted without one gets (`pasted-image-<HHMMSS>.png`). */
export function pastedName(file: { readonly name: string; readonly type: string }, now: Date = new Date()): string {
  if (file.name && file.name !== 'image.png' && file.name !== 'blob') return file.name;
  const ext = file.type === 'image/jpeg' ? 'jpg' : file.type.startsWith('image/') ? file.type.slice(6) : 'bin';
  const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');
  return `pasted-image-${stamp}.${ext}`;
}

/** The URL of a session's attachment (`?download` makes it a download). */
export function attachmentUrl(sessionId: string, id: string, download = false): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}${download ? '?download' : ''}`;
}

/** The file icon's glyph of a kind. */
export function kindGlyph(kind: AttachmentKind): string {
  return kind === 'pdf' ? 'PDF' : kind === 'image' ? 'IMG' : 'FILE';
}

/** The largest image that goes inline (bytes): a downscaled image over it is re-encoded as JPEG. */
export const INLINE_IMAGE_MAX_BYTES = INLINE_IMAGE_MAX;
