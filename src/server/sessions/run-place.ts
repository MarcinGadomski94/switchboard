import type { Session } from '../../core/api.ts';
import { parseRemoteId } from '../../core/peers.ts';
import { placeRun } from '../../core/sidebar-layout.ts';
import type { RecordChanges } from '../../core/sidebar-records.ts';
import type { Store } from '../db/store.ts';
import type { HubBus, HubMessage } from '../hub/bus.ts';
// Team (D100) hook (docs/team-removal.md): a member source's folder before it joined.
import { teamOriginalPlace } from '../team/hooks.ts';

/**
 * How long before this service started a run may have been created and still be placed (a
 * paired machine's clock, a run that started while this one was starting). Older runs (from
 * before this rule, or seen again after a restart) are left where they are.
 */
export const RUN_PLACE_GRACE_MS = 2 * 60_000;

/** Options of {@link RunPlaces}. */
export interface RunPlacesOptions {
  readonly bus: HubBus;
  readonly store: Pick<Store, 'sessions' | 'sidebar'>;
  /** The listed (open) sessions' ids in the service's order (`GET /api/sessions`, `/api/sidebar/place`). */
  readonly listed: () => Promise<string[]>;
  /** The paired machines' sessions (namespaced). */
  readonly remoteSessions: () => readonly Session[];
  /** D71: the records a write changed go to the paired machines the layout is shared with. */
  readonly synced: (changes: RecordChanges) => void;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/**
 * D99 / D76 follow-up 2026-10-19 (`docs/sidebar.md` → *Where runs appear*): a session
 * Switchboard starts on the developer's behalf for a todo (▸ Run in new session) or a plan
 * item goes to its source's sidebar folder, right after the source and its earlier runs
 * ({@link placeRun}), through the D71 layout store (so it syncs like a manual move).
 *
 * A run is a session with a `todoLink` (D76): this machine's runs arrive as `sessionUpdated`s
 * once the link is set (before its process starts), a paired machine's as namespaced ones (its
 * runs are placed in this machine's layout by their remote ids, as D83's `FreshPlaces`
 * does), so the machine that owns the run and the one looking at it both place it. Each run is
 * placed once, and only a new one ({@link RUN_PLACE_GRACE_MS}; not a run's D83 continuation, which
 * takes the old run's place); a placed run is left alone (a
 * later move by the developer wins). A chat source (D106) leaves the run at the root: chats are
 * not in SESSIONS.
 */
export class RunPlaces {
  readonly #options: RunPlacesOptions;
  readonly #onError: (error: unknown) => void;
  readonly #now: () => number;
  /** Ids already handled (each run is placed once). */
  readonly #done = new Set<string>();
  #since = 0;
  #unsubscribe: (() => void) | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: RunPlacesOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((error) => console.error('switchboard run place:', error));
  }

  /** Starts listening to the sessions' updates. */
  start(): void {
    if (this.#unsubscribe) return;
    this.#since = this.#now() - RUN_PLACE_GRACE_MS;
    this.#unsubscribe = this.#options.bus.subscribe((message) => this.#onMessage(message));
  }

  /** Stops listening; waits for a write in flight. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.#queue;
  }

  /** Places run `runId` of source `sourceId` (both this machine's ids or both a peer's remote ids); answers whether the layout changed. */
  async place(sourceId: string, runId: string): Promise<boolean> {
    this.#done.add(runId);
    const { store, remoteSessions } = this.#options;
    const remotes = remoteSessions();
    const remote = parseRemoteId(sourceId) !== null;
    const source = remote ? remotes.find((session) => session.id === sourceId) : await store.sessions.get(sourceId);
    // D106: chats live in CHATS, never in the layout: the run stays at the root.
    if (source?.kind === 'chat') return false;
    const runs = new Set<string>();
    if (!remote) for (const record of await store.sessions.list()) if (record.todoLink?.sourceSessionId === sourceId) runs.add(record.id);
    for (const session of remotes) if (session.todoLink?.sourceSessionId === sourceId) runs.add(session.id);
    runs.delete(runId);
    const listed = await this.#options.listed();
    const member = teamOriginalPlace(store, sourceId);
    const write = await store.sidebar.change((layout) => placeRun(layout, { sourceId, runId, runsOfSource: runs, listed, member }));
    if (!write) return false;
    this.#options.bus.publish('sidebarLayoutChanged', write.layout);
    this.#options.synced(write.changes);
    return true;
  }

  #onMessage(message: HubMessage): void {
    if (message.name !== 'sessionUpdated') return;
    const session: Session = message.payload;
    const from = session.todoLink?.sourceSessionId;
    if (!from || this.#done.has(session.id) || (session.closedAt ?? null) !== null) return;
    this.#done.add(session.id);
    // A run from before this rule (or seen again after a restart), one taken over from another machine (D65), or a run's
    // fresh continuation (D83: it takes the old run's place, `FreshPlaces`) stays where it is.
    const created = Date.parse(session.createdAt);
    if (!Number.isFinite(created) || created < this.#since || session.movedFrom || session.continuedFrom) return;
    this.#queue = this.#queue.then(() => this.place(from, session.id).then(() => undefined)).catch((error: unknown) => this.#onError(error));
  }
}
