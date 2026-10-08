import { type DevicePresenceInput, PRESENCE_HEARTBEAT_MS } from '../../core/devices.ts';

/**
 * D87 (`docs/devices.md` → *No notifications while Switchboard is open*): this
 * page tells Switchboard whether it is in front, so a paired device with
 * Switchboard open gets its happenings as toasts, not as system notifications.
 *
 * - The page has a random id ({@link pageClientId}); its `/hub` stream names it
 *   (`/hub?client=<id>`, `useHub.ts`), so the server knows when the page is gone.
 * - It reports `{ client, visible, focused }` (`PUT /api/device/presence`) on
 *   `visibilitychange`, `focus`, `blur`, `pageshow`, `pagehide` (hidden, with
 *   `keepalive` so it leaves while the page unloads), whenever its hub stream
 *   (re)opens, and every {@link PRESENCE_HEARTBEAT_MS} while visible. The server
 *   lets a report lapse after 75 s.
 * - This machine's own UI reports too; the server records only paired devices'
 *   pages (the desktop gets no push).
 *
 * The page wiring is `presence-page.ts`; this module has no DOM, so `tests/web`
 * runs it in Node.
 */

let clientId: string | null = null;

/** A random page id (made once per page load). */
export function pageClientId(): string {
  if (clientId) return clientId;
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  clientId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return clientId;
}

/** What the reporter reads from and does to the page (passed in, so tests run in Node). */
export interface PresenceHost {
  /** `document.visibilityState === 'visible'`. */
  visible(): boolean;
  /** `document.hasFocus()`. */
  focused(): boolean;
  /** Sends one report; `leaving` = the page is unloading (keepalive). Never throws. */
  send(report: DevicePresenceInput, leaving: boolean): void;
  every(run: () => void, ms: number): () => void;
}

/** Reports this page's presence through `host`. */
export class PresenceReporter {
  readonly #host: PresenceHost;
  readonly #client: string;
  #last: string | null = null;
  #stopHeartbeat: (() => void) | null = null;

  constructor(host: PresenceHost, client: string) {
    this.#host = host;
    this.#client = client;
  }

  /** Reports now (`force`: even when nothing changed, e.g. the hub stream reopened or a heartbeat). */
  report(force = false): void {
    const report: DevicePresenceInput = { client: this.#client, visible: this.#host.visible(), focused: this.#host.focused() };
    const key = `${report.visible}/${report.focused}`;
    if (force || key !== this.#last) {
      this.#last = key;
      this.#host.send(report, false);
    }
    this.#heartbeat(report.visible);
  }

  /** The page is unloading (or frozen into the back-forward cache): hidden. */
  leave(): void {
    this.#last = 'false/false';
    this.#heartbeat(false);
    this.#host.send({ client: this.#client, visible: false, focused: false }, true);
  }

  /** The heartbeat runs only while the page is visible. */
  #heartbeat(visible: boolean): void {
    if (visible && !this.#stopHeartbeat) this.#stopHeartbeat = this.#host.every(() => this.report(true), PRESENCE_HEARTBEAT_MS);
    if (!visible && this.#stopHeartbeat) {
      this.#stopHeartbeat();
      this.#stopHeartbeat = null;
    }
  }
}
