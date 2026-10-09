/**
 * D88 · drafts follow you (`docs/chat.md` → *Drafts*): the sync of one field's
 * draft with the server, free of React and the DOM so `tests/web` runs it in Node
 * (the hook is `useDraft.ts`).
 *
 * - **Save:** a local change is saved {@link DRAFT_SAVE_MS} after the last one, and
 *   at once when the field loses focus, the page hides or unloads (`keepalive`), or
 *   the field goes away (switching sessions). An empty value clears the draft.
 * - **Clear:** {@link DraftField.clear} when the text was sent, saved or cancelled.
 * - **Conflicts (ruling, recorded in D88):** last write wins on the server. A
 *   remote change (another device or page) is applied only when this field has no
 *   focus and holds nothing unsaved; while it has focus the change waits, and when
 *   it loses focus the field saves its own text if it changed (and so wins), else
 *   reads the server again and applies what is there. What the developer is typing
 *   on this device is never overwritten.
 */
import { DRAFT_SAVE_MS, draftIsEmpty } from '../../core/drafts.ts';

/** What a {@link DraftField} reads from and does to its page (passed in: tests use fakes). */
export interface DraftFieldHost {
  readonly field: string;
  /** The field's current local value. */
  value(): unknown;
  /** Shows `value` (the server's), or the empty field for `null` (the draft was cleared elsewhere). */
  apply(value: unknown): void;
  /** `true` while the developer is in the field (focus within it). */
  focused(): boolean;
  /** Saves (`PUT`; `value` never empty) or clears (`null`: `DELETE`). Rejections are swallowed by the caller. */
  write(value: unknown | null, keepalive: boolean): Promise<void>;
  /** The server's current value of this field (`null` = none), read again. */
  read(): Promise<unknown | null>;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly delayMs?: number;
}

/** The value as stored: its JSON, or `null` for an empty one (no draft). */
export function draftKey(field: string, value: unknown): string | null {
  return value === null || value === undefined || draftIsEmpty(field, value) ? null : JSON.stringify(value);
}

/** One field's draft sync (see the module comment). */
export class DraftField {
  readonly #host: DraftFieldHost;
  /** What the server holds as far as this page knows (`draftKey`). */
  #synced: string | null;
  #timer: unknown = null;
  /** A remote change arrived while the field had focus. */
  #pending = false;
  /** Writes go one after the other, so an older save never lands after a newer one. */
  #chain: Promise<void> = Promise.resolve();
  #disposed = false;
  /**
   * The local value when {@link clear} ran (the text just sent / saved): while the field
   * still shows it, it counts as empty, so it is not saved again (on blur, unmount).
   */
  #sent: string | null | undefined = undefined;

  /** `initial` = the value the field started with (a draft already known to this page, else empty). */
  constructor(host: DraftFieldHost, initial: unknown | null = null) {
    this.#host = host;
    this.#synced = draftKey(host.field, initial);
  }

  #local(): string | null {
    const local = draftKey(this.#host.field, this.#host.value());
    if (this.#sent === undefined) return local;
    if (local === this.#sent) return null;
    this.#sent = undefined;
    return local;
  }

  /** `true` while the local value differs from what the server holds as far as this page knows. */
  get dirty(): boolean {
    return this.#local() !== this.#synced;
  }

  #cancel(): void {
    if (this.#timer !== null) (this.#host.clearTimer ?? clearTimeout)(this.#timer as ReturnType<typeof setTimeout>);
    this.#timer = null;
  }

  #write(local: string | null, keepalive: boolean): Promise<void> {
    this.#synced = local;
    const value = local === null ? null : (JSON.parse(local) as unknown);
    this.#chain = this.#chain.then(() => this.#host.write(value, keepalive)).catch(() => undefined);
    return this.#chain;
  }

  /** The server's value arrived (the first read): shown when the field still holds what it started with. */
  loaded(server: unknown | null): void {
    if (this.#disposed) return;
    const remote = draftKey(this.#host.field, server);
    if (remote === this.#synced) return;
    if (this.dirty) return; // typed before the read came back: the local text wins (and is saved).
    this.#synced = remote;
    this.#host.apply(remote === null ? null : server);
  }

  /** The local value changed: saved after the debounce. */
  changed(): void {
    if (this.#disposed) return;
    this.#cancel();
    if (!this.dirty) return;
    this.#timer = (this.#host.setTimer ?? setTimeout)(() => {
      this.#timer = null;
      void this.flush(false);
    }, this.#host.delayMs ?? DRAFT_SAVE_MS);
  }

  /** Saves now when the local value differs from the server's (blur, hide, unload, unmount). */
  flush(keepalive: boolean): Promise<void> {
    this.#cancel();
    const local = this.#local();
    if (local === this.#synced) return this.#chain;
    return this.#write(local, keepalive);
  }

  /** Clears the draft (sent, saved, cancelled): no save is pending any more. */
  clear(): Promise<void> {
    this.#cancel();
    this.#pending = false;
    this.#sent = draftKey(this.#host.field, this.#host.value());
    return this.#write(null, false);
  }

  /** Another device or page changed the draft; `server` is what the server holds now. */
  remote(server: unknown | null): void {
    if (this.#disposed) return;
    const remote = draftKey(this.#host.field, server);
    if (remote === this.#synced && !this.dirty) return;
    if (this.#host.focused() || this.dirty) {
      // Being typed in (or holding unsaved text): never overwritten; looked at again on blur.
      this.#pending = true;
      return;
    }
    this.#synced = remote;
    this.#host.apply(remote === null ? null : server);
  }

  /** The field lost focus: its own change is saved (last write wins), else a waiting remote change is applied. */
  async blurred(): Promise<void> {
    if (this.#disposed) return;
    if (this.dirty) {
      this.#pending = false;
      await this.flush(false);
      return;
    }
    if (!this.#pending) return;
    this.#pending = false;
    let server: unknown | null;
    try {
      server = await this.#host.read();
    } catch {
      return;
    }
    if (this.#disposed || this.#host.focused() || this.dirty) {
      this.#pending = !this.#disposed;
      return;
    }
    this.remote(server);
  }

  /** The field goes away (another session, a closed form): what is unsaved goes out with `keepalive`. */
  dispose(): void {
    if (this.#disposed) return;
    void this.flush(true);
    this.#disposed = true;
  }
}
