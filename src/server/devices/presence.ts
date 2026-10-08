import { PRESENCE_LAPSE_MS } from '../../core/devices.ts';

/**
 * D87 (`docs/devices.md` → *No notifications while Switchboard is open*): which
 * paired devices have Switchboard open in front right now. In memory only (a
 * restart forgets it; the pages report again within a heartbeat).
 *
 * Each open page (a browser tab or the installed app) of a device is a *client*,
 * named by a random id the page makes at load. A client counts as **in front**
 * while all of these hold:
 * - its last report (`PUT /api/device/presence`) said `visible`;
 * - that report is at most {@link PRESENCE_LAPSE_MS} old (the page reports every
 *   30 s while visible, so a page the system froze or killed lapses);
 * - its `/hub` stream (`/hub?client=<id>`) is connected (a dropped stream: the
 *   page is gone or offline, so it could not show a toast).
 *
 * A device is in front while at least one of its clients is. The push notifier
 * sends a device no system notification while it is in front; the page shows the
 * happening as a toast instead (the `/hub` `notice` event).
 */

/** Pages remembered per device (the oldest is forgotten beyond this). */
export const MAX_CLIENTS = 32;

/** One open page of a device. */
interface Client {
  visible: boolean;
  focused: boolean;
  /** Epoch ms of the last report (`null`: none yet, only a stream). */
  reportedAt: number | null;
  /** Its open `/hub` streams (a reconnect may overlap the old one). */
  streams: number;
}

/** What a page reports. */
export interface PresenceReport {
  readonly visible: boolean;
  readonly focused: boolean;
}

/** The D87 presence of the paired devices' pages. */
export class DevicePresence {
  readonly #now: () => number;
  readonly #lapseMs: number;
  /** Device id → client id → client. */
  readonly #devices = new Map<string, Map<string, Client>>();

  constructor(options: { readonly now?: () => number; readonly lapseMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#lapseMs = options.lapseMs ?? PRESENCE_LAPSE_MS;
  }

  #client(deviceId: string, clientId: string): Client {
    let clients = this.#devices.get(deviceId);
    if (!clients) {
      clients = new Map();
      this.#devices.set(deviceId, clients);
    }
    let client = clients.get(clientId);
    if (!client) {
      // A device has a handful of pages at most; a runaway one cannot grow the map without bound.
      if (clients.size >= MAX_CLIENTS) {
        const oldest = clients.keys().next().value;
        if (oldest !== undefined) clients.delete(oldest);
      }
      client = { visible: false, focused: false, reportedAt: null, streams: 0 };
      clients.set(clientId, client);
    }
    return client;
  }

  /** A page's report (visible / hidden, focused). */
  report(deviceId: string, clientId: string, report: PresenceReport): void {
    const client = this.#client(deviceId, clientId);
    client.visible = report.visible;
    client.focused = report.focused;
    client.reportedAt = this.#now();
    this.#prune(deviceId);
  }

  /** A page's `/hub` stream opened; the returned function is called once it closes. */
  connect(deviceId: string, clientId: string): () => void {
    const client = this.#client(deviceId, clientId);
    client.streams += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      client.streams = Math.max(0, client.streams - 1);
      this.#prune(deviceId);
    };
  }

  #live(client: Client, now: number): boolean {
    return client.visible && client.streams > 0 && client.reportedAt !== null && now - client.reportedAt <= this.#lapseMs;
  }

  /** `true` while the device has at least one page open in front. */
  inFront(deviceId: string): boolean {
    const clients = this.#devices.get(deviceId);
    if (!clients) return false;
    const now = this.#now();
    for (const client of clients.values()) if (this.#live(client, now)) return true;
    return false;
  }

  /** How many of the device's pages are in front (tests, diagnostics). */
  inFrontCount(deviceId: string): number {
    const clients = this.#devices.get(deviceId);
    if (!clients) return 0;
    const now = this.#now();
    let count = 0;
    for (const client of clients.values()) if (this.#live(client, now)) count += 1;
    return count;
  }

  /** Forgets a device (revoked). */
  forget(deviceId: string): void {
    this.#devices.delete(deviceId);
  }

  /** Drops the device's clients that have no stream and no recent report. */
  #prune(deviceId: string): void {
    const clients = this.#devices.get(deviceId);
    if (!clients) return;
    const now = this.#now();
    for (const [id, client] of clients) {
      if (client.streams === 0 && (client.reportedAt === null || now - client.reportedAt > this.#lapseMs)) clients.delete(id);
    }
    if (clients.size === 0) this.#devices.delete(deviceId);
  }
}
