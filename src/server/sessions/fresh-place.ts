import type { Session } from '../../core/api.ts';
import { inheritPlace } from '../../core/sidebar-layout.ts';
import type { RecordChanges } from '../../core/sidebar-records.ts';
import type { SidebarLayoutRepository } from '../db/repos/sidebar.ts';
import type { HubBus, HubMessage } from '../hub/bus.ts';

/** Options of {@link FreshPlaces}. */
export interface FreshPlacesOptions {
  readonly bus: HubBus;
  readonly sidebar: SidebarLayoutRepository;
  /** D71: the records a write changed go to the paired machines the layout is shared with. */
  readonly synced: (changes: RecordChanges) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * D83 (`docs/fresh-session.md` → *Sidebar place*): a fresh session takes the
 * sidebar place (pinned, folder, loose position) of the session it continues.
 * This machine's own continuations are placed by {@link adopt} as they start; a
 * paired machine's arrive here as namespaced `sessionUpdated`s (its sessions are
 * placed in this machine's layout by their remote ids), so the listener adopts
 * every session that names a `continuedFrom` and is not placed yet. Idempotent:
 * a placed session is left alone (so a later move by the developer wins).
 */
export class FreshPlaces {
  readonly #options: FreshPlacesOptions;
  readonly #onError: (error: unknown) => void;
  /** Ids already handled (each fresh session is placed once). */
  readonly #done = new Set<string>();
  #unsubscribe: (() => void) | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: FreshPlacesOptions) {
    this.#options = options;
    this.#onError = options.onError ?? ((error) => console.error('switchboard fresh session place:', error));
  }

  /** Starts listening to the sessions' updates. */
  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#options.bus.subscribe((message) => this.#onMessage(message));
  }

  /** Stops listening; waits for a write in flight. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.#queue;
  }

  /** Puts `newId` where `oldId` is (when it is placed and `newId` is not); answers whether the layout changed. */
  async adopt(oldId: string, newId: string): Promise<boolean> {
    this.#done.add(newId);
    const write = await this.#options.sidebar.change((layout) => inheritPlace(layout, oldId, newId));
    if (!write) return false;
    this.#options.bus.publish('sidebarLayoutChanged', write.layout);
    this.#options.synced(write.changes);
    return true;
  }

  #onMessage(message: HubMessage): void {
    if (message.name !== 'sessionUpdated') return;
    const session: Session = message.payload;
    const from = session.continuedFrom?.sessionId;
    if (!from || this.#done.has(session.id) || (session.closedAt ?? null) !== null) return;
    this.#done.add(session.id);
    this.#queue = this.#queue.then(() => this.adopt(from, session.id).then(() => undefined)).catch((error: unknown) => this.#onError(error));
  }
}
