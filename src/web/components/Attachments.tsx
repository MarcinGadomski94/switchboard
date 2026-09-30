import { type ClipboardEvent, type DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { AttachmentUpload } from '../../core/api.ts';
import { type Attachment, formatSize } from '../../core/attachments.ts';
import { ApiError } from '../api/client.ts';
import {
  type DraftAttachment,
  acceptFiles,
  attachmentUrl,
  chipOf,
  dragHasFiles,
  filesFromTransfer,
  guessKind,
  kindGlyph,
  INLINE_IMAGE_MAX_BYTES,
  bytesToBase64,
  downscalePlan,
  pastedName,
} from './attachments.ts';
import './attachments.css';

/** An upload call: one file (`{ name, data }`) → the stored attachment. */
export type Uploader = (body: AttachmentUpload) => Promise<Attachment>;

/** The name with the extension of the type it was re-encoded to (a downscaled WebP → `.jpg`). */
function renamedFor(name: string, from: string, to: string): string {
  if (from === to || !to.startsWith('image/')) return name;
  const ext = to === 'image/jpeg' ? 'jpg' : to.slice(6);
  return /\.[A-Za-z0-9]{1,5}$/.test(name) ? name.replace(/\.[A-Za-z0-9]{1,5}$/, `.${ext}`) : `${name}.${ext}`;
}

/**
 * Reads a file for upload (browser only): an image over the limits is downscaled
 * on a canvas first ({@link downscalePlan}); returns the bytes as base64, the
 * size sent and a thumbnail URL (an object URL the caller revokes).
 */
async function readForUpload(file: File): Promise<{ readonly data: string; readonly size: number; readonly previewUrl: string | null; readonly type: string }> {
  let blob: Blob = file;
  if (guessKind(file.type, file.name) === 'image' && typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      const plan = downscalePlan(file.type, bitmap.width, bitmap.height, file.size);
      if (plan) {
        const canvas = document.createElement('canvas');
        canvas.width = plan.width;
        canvas.height = plan.height;
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0, plan.width, plan.height);
        let out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, plan.type, 0.9));
        // Still too large for inline (a busy PNG): JPEG, lower quality; the server sends a larger one as a file.
        for (const quality of [0.85, 0.7]) {
          if (!out || out.size <= INLINE_IMAGE_MAX_BYTES) break;
          out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
        }
        if (out) blob = out;
      }
      bitmap.close();
    } catch {
      // Not decodable here: sent as it is (the server sniffs it).
    }
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const previewUrl = guessKind(blob.type || file.type, file.name) === 'image' ? URL.createObjectURL(blob) : null;
  return { data: bytesToBase64(bytes), size: bytes.length, previewUrl, type: blob.type || file.type };
}

function uploadError(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown; errors?: Array<{ message?: unknown }> } | null;
    const message = typeof body?.message === 'string' ? body.message : typeof body?.errors?.[0]?.message === 'string' ? body.errors[0].message : null;
    if (error.status === 413) return message ?? 'too large';
    return message ?? (error.status === 0 ? 'the service could not be reached' : `HTTP ${error.status}`);
  }
  return error instanceof Error ? error.message : String(error);
}

/** What {@link useAttachmentDraft} gives a composer or a form. */
export interface AttachmentDraft {
  readonly items: readonly DraftAttachment[];
  /** Why the last files were refused (caps), one line; `null` = none. */
  readonly notice: string | null;
  /** Adds files (paste, drop, the picker): read, downscaled when needed, and uploaded at once when the draft has an uploader. */
  add(files: readonly File[]): void;
  /** Adds attachments the server has (a Stop's withdrawn message). */
  restore(attachments: readonly Attachment[], sessionId: string): void;
  remove(key: string): void;
  /** Empties the draft (after a send). */
  clear(): void;
  /**
   * Forms: uploads every chip not uploaded yet with `upload` (at Start), in
   * order; returns the ids, or throws the first failure (the chip shows it).
   */
  uploadAll(upload: Uploader): Promise<string[]>;
}

let nextKey = 0;

/**
 * D57 · the draft's attachments: a composer passes `upload` (the session's
 * `POST …/attachments`), so each file uploads as soon as it is added; a
 * New-session form passes none and uploads them at Start ({@link AttachmentDraft.uploadAll}).
 * Object URLs of thumbnails are revoked when a chip goes or the draft unmounts.
 */
export function useAttachmentDraft(upload?: Uploader): AttachmentDraft {
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  const urls = useRef(new Set<string>());

  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    },
    [],
  );

  const patch = useCallback((key: string, change: Partial<DraftAttachment>): void => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }, []);

  const send = useCallback(
    async (key: string, name: string, data: string, uploader: Uploader): Promise<string> => {
      patch(key, { state: 'uploading', error: null });
      try {
        const stored = await uploader({ name, data });
        patch(key, { state: 'ready', id: stored.id, kind: stored.kind, name: stored.name, size: stored.size, data: undefined });
        return stored.id as string;
      } catch (error) {
        patch(key, { state: 'error', error: uploadError(error) });
        throw error;
      }
    },
    [patch],
  );

  const add = useCallback(
    (files: readonly File[]): void => {
      if (files.length === 0) return;
      const now = new Date();
      const named = files.map((file) => ({ file, name: pastedName(file, now), size: file.size }));
      const { accepted, problems } = acceptFiles(itemsRef.current, named);
      setNotice(problems.length > 0 ? problems.join(' · ') : null);
      const fresh = accepted.map((index) => {
        const entry = named[index] as (typeof named)[number];
        const item: DraftAttachment = { key: `att-${++nextKey}`, name: entry.name, size: entry.size, kind: guessKind(entry.file.type, entry.name), previewUrl: null, state: 'reading', id: null, error: null };
        return { item, file: entry.file };
      });
      if (fresh.length === 0) return;
      setItems((current) => [...current, ...fresh.map((entry) => entry.item)]);
      for (const { item, file } of fresh) {
        void (async () => {
          try {
            const read = await readForUpload(file);
            if (read.previewUrl) urls.current.add(read.previewUrl);
            const name = renamedFor(item.name, file.type, read.type);
            // A chip removed meanwhile is gone: nothing more happens for it.
            if (!itemsRef.current.some((current) => current.key === item.key)) {
              if (read.previewUrl) URL.revokeObjectURL(read.previewUrl);
              return;
            }
            patch(item.key, { previewUrl: read.previewUrl, size: read.size, name, data: read.data, state: uploadRef.current ? 'uploading' : 'ready' });
            if (uploadRef.current) await send(item.key, name, read.data, uploadRef.current).catch(() => undefined);
          } catch (error) {
            patch(item.key, { state: 'error', error: error instanceof Error ? error.message : String(error) });
          }
        })();
      }
    },
    [patch, send],
  );

  const restore = useCallback((attachments: readonly Attachment[], sessionId: string): void => {
    if (attachments.length === 0) return;
    setItems((current) => [...current, ...attachments.map((attachment) => chipOf(attachment, `att-${++nextKey}`, attachment.id ? attachmentUrl(sessionId, attachment.id) : null))]);
  }, []);

  const remove = useCallback((key: string): void => {
    setItems((current) => {
      const gone = current.find((item) => item.key === key);
      if (gone?.previewUrl && urls.current.has(gone.previewUrl)) {
        URL.revokeObjectURL(gone.previewUrl);
        urls.current.delete(gone.previewUrl);
      }
      return current.filter((item) => item.key !== key);
    });
    setNotice(null);
  }, []);

  const clear = useCallback((): void => {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
    setItems([]);
    setNotice(null);
  }, []);

  const uploadAll = useCallback(
    async (uploader: Uploader): Promise<string[]> => {
      const ids: string[] = [];
      for (const item of itemsRef.current) {
        if (item.state === 'ready' && item.id !== null) ids.push(item.id);
        else if (item.data !== undefined) ids.push(await send(item.key, item.name, item.data, uploader));
        else throw new Error(`${item.name}: ${item.error ?? 'not read yet'}`);
      }
      return ids;
    },
    [send],
  );

  return { items, notice, add, restore, remove, clear, uploadAll };
}

/**
 * Drop-zone handlers for an element (the chat, the composer, a form's message
 * field): it lights up (`dragging`) only while the drag carries files, and a drop
 * adds them.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handlers = {
    onDragEnter: (event: DragEvent<HTMLElement>): void => {
      if (!enabled || !dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver: (event: DragEvent<HTMLElement>): void => {
      if (!enabled || !dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: DragEvent<HTMLElement>): void => {
      if (!enabled || !dragHasFiles(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLElement>): void => {
      depth.current = 0;
      setDragging(false);
      if (!enabled) return;
      const files = filesFromTransfer(event.dataTransfer);
      if (files.length === 0) return;
      event.preventDefault();
      onFiles(files);
    },
  };
  return { dragging, handlers };
}

/**
 * A paste handler for a text field (ASSUMED D57-paste): a paste that carries
 * files (a screenshot, an image copied in the browser, copied files where the
 * browser exposes them) attaches them and inserts no text; a text paste is untouched.
 */
export function pasteFiles(onFiles: (files: File[]) => void, enabled = true) {
  return (event: ClipboardEvent<HTMLElement>): void => {
    if (!enabled) return;
    const files = filesFromTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    onFiles(files);
  };
}

/**
 * The 📎 button: a file picker (several files). The `<input type="file">` is made
 * on click and never sits in the page (the forms' field lists stay as they were).
 */
export function AttachButton({ onFiles, disabled = false, className = '' }: { readonly onFiles: (files: File[]) => void; readonly disabled?: boolean; readonly className?: string }) {
  const pick = (): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      if (files.length > 0) onFiles(files);
    });
    input.click();
  };
  return (
    <button
      type="button"
      className={`sb-button sb-attach-button ${className}`}
      data-testid="attach-button"
      aria-label="Attach files"
      title="Attach images or files (or paste / drop them)"
      disabled={disabled}
      onClick={pick}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
        <path
          d="M10.8 4.6 5.6 9.8a1.3 1.3 0 0 0 1.8 1.8l5.6-5.6a2.6 2.6 0 0 0-3.7-3.7L3.7 7.9a3.9 3.9 0 0 0 5.5 5.5l4.4-4.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** The draft's chips above a text field: image thumbnails, files with their icon, name and size; each removable. */
export function AttachmentChips({ items, notice, onRemove }: { readonly items: readonly DraftAttachment[]; readonly notice?: string | null; readonly onRemove: (key: string) => void }) {
  if (items.length === 0 && !notice) return null;
  return (
    <div className="sb-attach-chips" data-testid="attachment-chips">
      {items.map((item) => (
        <div
          key={item.key}
          className="sb-attach-chip"
          data-testid="attachment-chip"
          data-kind={item.kind}
          data-state={item.state}
          data-attachment-id={item.id ?? undefined}
          title={item.error ? `${item.name}: ${item.error}` : `${item.name} · ${formatSize(item.size)}`}
        >
          {item.kind === 'image' && item.previewUrl ? (
            <img className="sb-attach-thumb" data-testid="attachment-thumb" src={item.previewUrl} alt={item.name} />
          ) : (
            <span className="sb-attach-icon" data-testid="attachment-icon" data-kind={item.kind}>
              {kindGlyph(item.kind)}
            </span>
          )}
          {item.kind === 'image' && item.previewUrl ? null : (
            <span className="sb-attach-meta">
              <span className="sb-attach-name" data-testid="attachment-name">
                {item.name}
              </span>
              <span className="sb-attach-size" data-testid="attachment-size">
                {item.state === 'error' ? (item.error ?? 'failed') : item.state === 'ready' ? formatSize(item.size) : 'attaching…'}
              </span>
            </span>
          )}
          <button type="button" className="sb-attach-remove" data-testid="attachment-remove" aria-label={`Remove ${item.name}`} title={`Remove ${item.name}`} onClick={() => onRemove(item.key)}>
            ×
          </button>
        </div>
      ))}
      {notice ? (
        <div className="sb-attach-notice" data-testid="attachment-notice" role="alert">
          {notice}
        </div>
      ) : null}
    </div>
  );
}

/** A larger view of an image (click or Esc closes it). */
export function ImageLightbox({ src, name, onClose }: { readonly src: string; readonly name: string; readonly onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="sb-attach-lightbox" role="dialog" aria-modal="true" aria-label={name} data-testid="attachment-lightbox" onClick={onClose}>
      <img src={src} alt={name} data-testid="attachment-lightbox-image" />
      <div className="sb-attach-lightbox-name">{name}</div>
    </div>
  );
}

/**
 * D57 · a sent message's attachments in its bubble: image thumbnails (a click
 * opens them larger), PDFs and other files as chips with name and size (a PDF
 * opens in a new tab, other files download). An image the transcript named
 * without its bytes, or one cleaned up since, shows the placeholder "image".
 */
export function MessageAttachments({ sessionId, attachments }: { readonly sessionId: string; readonly attachments: readonly Attachment[] }) {
  const [open, setOpen] = useState<{ readonly src: string; readonly name: string } | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  if (attachments.length === 0) return null;
  return (
    <div className="sb-msg-attachments" data-testid="message-attachments">
      {attachments.map((attachment, index) => {
        const key = attachment.id ?? `placeholder-${index}`;
        if (attachment.kind === 'image' && (attachment.id === null || broken.has(attachment.id))) {
          return (
            <span key={key} className="sb-msg-image-placeholder" data-testid="message-image-placeholder" title={attachment.id === null ? 'The image is not in the transcript' : 'The image was cleaned up'}>
              image
            </span>
          );
        }
        if (attachment.kind === 'image' && attachment.id !== null) {
          const src = attachmentUrl(sessionId, attachment.id);
          const id = attachment.id;
          return (
            <button key={key} type="button" className="sb-msg-image" data-testid="message-image" data-attachment-id={id} title={attachment.name} onClick={() => setOpen({ src, name: attachment.name })}>
              <img src={src} alt={attachment.name} onError={() => setBroken((current) => new Set([...current, id]))} />
            </button>
          );
        }
        const href = attachment.id !== null ? attachmentUrl(sessionId, attachment.id, attachment.kind !== 'pdf') : undefined;
        return (
          <a
            key={key}
            className="sb-attach-chip sb-msg-file"
            data-testid="message-file"
            data-kind={attachment.kind}
            data-attachment-id={attachment.id ?? undefined}
            data-delivery={attachment.delivery}
            href={href}
            {...(attachment.kind === 'pdf' ? { target: '_blank', rel: 'noopener noreferrer' } : { download: attachment.name })}
            title={`${attachment.name} · ${formatSize(attachment.size)}${attachment.delivery === 'file' ? ' · sent as a file path' : ''}`}
          >
            <span className="sb-attach-icon" data-kind={attachment.kind}>
              {kindGlyph(attachment.kind)}
            </span>
            <span className="sb-attach-meta">
              <span className="sb-attach-name" data-testid="message-file-name">
                {attachment.name}
              </span>
              <span className="sb-attach-size" data-testid="message-file-size">
                {formatSize(attachment.size)}
              </span>
            </span>
          </a>
        );
      })}
      {open ? <ImageLightbox src={open.src} name={open.name} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
