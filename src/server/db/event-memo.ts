import type { EventRecord, EventRepository } from './repos/events.ts';

/** How many values one {@link EventMemo} keeps (the most recently used). */
const MEMO_LIMIT = 256;

/**
 * D95 (`docs/performance.md` → *Incremental derivations*): a value derived from a
 * session's events (a scan of its whole history), kept until an event that can
 * change it is written. After writes, only the events written since are read
 * (`EventRepository.changedSince`); when none of them `affects` the value it
 * stays, else it is computed again. Every write to `events` goes through the
 * repository, so the revision tells exactly when the history changed.
 */
export class EventMemo<T> {
  readonly #entries = new Map<string, { revision: number; value: T }>();
  readonly #affects: (event: EventRecord) => boolean;

  /** `affects`: `true` for an event whose write can change the value. */
  constructor(affects: (event: EventRecord) => boolean) {
    this.#affects = affects;
  }

  /** The value for session `sessionId` (and `key`, when the value has parameters), computed by `compute` when needed. */
  async get(events: EventRepository, sessionId: string, key: string, compute: () => Promise<T>): Promise<T> {
    const id = `${sessionId}\u0000${key}`;
    // The revision first: a write that lands while the value is computed is looked at next time.
    const revision = await events.revision(sessionId);
    const entry = this.#entries.get(id);
    if (entry && entry.revision !== revision) {
      const ids = await events.changedSince(sessionId, entry.revision);
      if (ids !== null && !(await events.byIds(sessionId, ids)).some(this.#affects)) entry.revision = revision;
    }
    if (entry && entry.revision === revision) {
      this.#entries.delete(id);
      this.#entries.set(id, entry);
      return entry.value;
    }
    const value = await compute();
    this.#entries.delete(id);
    this.#entries.set(id, { revision, value });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= MEMO_LIMIT) break;
      this.#entries.delete(oldest);
    }
    return value;
  }
}

/** The `type` of an event's payload (`null` when it has none). */
export function payloadType(event: Pick<EventRecord, 'payload'>): unknown {
  const payload = event.payload;
  return payload && typeof payload === 'object' ? (payload as { type?: unknown }).type : null;
}
