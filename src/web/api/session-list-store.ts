import type { HubEvents, Session, SessionListItem } from '../../core/api.ts';
import { withoutAgents } from '../../core/session-list.ts';
import { ApiError } from './client.ts';
import type { ApiState } from './useApi.ts';

/**
 * D95 follow-up 2 (`docs/performance.md` → *Session list in memory*): the pure part
 * of the page's shared session list (no hub, no React), unit tested; the glue is
 * `session-list.ts`.
 */

/** Which list: the open sessions (`GET /api/sessions`) or every one (`?closed=include`). */
export type SessionListVariant = 'open' | 'all';

/** A resync asked for by an update of an unknown session or a paired machine's state change waits this long (folding a burst). */
export const SESSION_LIST_RESYNC_MS = 300;

/** A session as the list keeps it: without its agents (as the list route sends it). */
export const listItem = withoutAgents;

/**
 * The list after `session` was published: its row replaced in place; an unknown
 * one put first (a new local session is the newest) or, for a paired machine's,
 * last (`unknown` then asks for a resync, which brings the server's order); in the
 * open list a closed session leaves it.
 */
export function patchSessionList(
  list: readonly SessionListItem[],
  session: Session | SessionListItem,
  variant: SessionListVariant,
): { readonly list: readonly SessionListItem[]; readonly unknown: boolean } {
  const at = list.findIndex((item) => item.id === session.id);
  const closed = session.closedAt !== null && session.closedAt !== undefined;
  if (variant === 'open' && closed) return { list: at < 0 ? list : list.filter((item) => item.id !== session.id), unknown: false };
  const item = listItem(session);
  if (at >= 0) {
    const next = [...list];
    next[at] = item;
    return { list: next, unknown: false };
  }
  return { list: session.machine ? [...list, item] : [item, ...list], unknown: true };
}

const INITIAL: ApiState<SessionListItem[]> = { data: null, error: null, loading: true, reachable: null, reload: () => undefined };

/** One list's copy, its readers and its resyncs (exported for the unit tests; views use {@link useSessionListOf}). */
export class SessionListStore {
  readonly #variant: SessionListVariant;
  readonly #fetch: () => Promise<SessionListItem[]>;
  readonly #resyncMs: number;
  #state: ApiState<SessionListItem[]>;
  readonly #listeners = new Set<() => void>();
  /** Updates that arrived while a read was in flight: applied over its answer, in order. */
  #pending: Array<Session | SessionListItem> | null = null;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** How many reads of the list this store made (the bench and tests read it). */
  reads = 0;

  constructor(variant: SessionListVariant, fetch: () => Promise<SessionListItem[]>, resyncMs: number = SESSION_LIST_RESYNC_MS) {
    this.#variant = variant;
    this.#fetch = fetch;
    this.#resyncMs = resyncMs;
    this.#state = { ...INITIAL, reload: this.load };
  }

  readonly getState = (): ApiState<SessionListItem[]> => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch: Partial<ApiState<SessionListItem[]>>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }

  /** Reads the list (again); updates arriving meanwhile are applied over the answer. */
  readonly load = (): void => {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const generation = ++this.#generation;
    this.#pending = [];
    this.reads += 1;
    if (!this.#state.loading) this.#set({ loading: true });
    this.#fetch().then(
      (answer) => {
        if (generation !== this.#generation) return;
        let list: readonly SessionListItem[] = answer.map(listItem);
        for (const session of this.#pending ?? []) list = patchSessionList(list, session, this.#variant).list;
        this.#pending = null;
        this.#set({ data: [...list], error: null, loading: false, reachable: true });
      },
      (caught: unknown) => {
        if (generation !== this.#generation) return;
        this.#pending = null;
        const error = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
        this.#set({ error, loading: false, reachable: !error.unreachable });
      },
    );
  };

  /** A `sessionUpdated`: patches the copy (or waits for the read in flight). */
  update(session: HubEvents['sessionUpdated']): void {
    if (this.#pending) {
      this.#pending.push(session);
      return;
    }
    const data = this.#state.data;
    if (data === null) return;
    const patched = patchSessionList(data, session, this.#variant);
    if (patched.list !== data) this.#set({ data: [...patched.list] });
    if (patched.unknown) this.resyncSoon();
  }

  /** Reads the list again shortly (a burst of calls is one read). */
  resyncSoon(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.load();
    }, this.#resyncMs);
  }

  /** Forgets the copy (no reader left: it would go stale without the hub). */
  clear(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#generation += 1;
    this.#pending = null;
    this.#state = { ...INITIAL, reload: this.load };
  }
}

