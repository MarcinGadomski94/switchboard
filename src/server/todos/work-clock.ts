import type { Session, SessionActivity } from '../../core/api.ts';
import { backgroundWait } from '../../core/derive/background.ts';
import type { SessionStatus } from '../../core/model.ts';
import { isRemoteId } from '../../core/peers.ts';
import type { Store } from '../db/store.ts';
import type { HubBus, HubMessage } from '../hub/bus.ts';

/** Options of {@link TodoWorkClock}. */
export interface TodoWorkClockOptions {
  readonly store: Store;
  readonly bus: HubBus;
  /** The items of session `sessionId`'s list changed their live working time (publish its list); none in tests that do not need it. */
  readonly changed?: (sessionId: string) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * D147: whether a session works, for an item's working time: its status reads `run` (a turn, its
 * subagents / workflows, another CLI task it waits on) and it does **not** only wait for a
 * scheduled wake-up (the developer's ruling 2026-10-30: a timer it set is waiting, like a GitHub
 * wait or the developer). The wake-up is read from the existing waiting-on derivation
 * (`backgroundWait`: subagents and other waited-on tasks come first, so a wake-up next to
 * working subagents still works).
 */
export function isWorking(status: SessionStatus, activity: Pick<SessionActivity, 'state' | 'background'> | null | undefined, closed = false): boolean {
  if (closed || status !== 'run') return false;
  return backgroundWait(activity)?.kind !== 'wakeup';
}

/**
 * D147 (`docs/todos.md` → *Actual vs. estimate*): an item's actual time is its agent's
 * **working** time. This clock tells the todo repository which of this machine's sessions are
 * working ({@link isWorking}), from every `sessionUpdated` (status, activity) and every live
 * `activity` (a turn that ends into a wake-up wait keeps `run`, so only the activity says it).
 * `need` (a question, a permission, a turn that ended waiting for the developer, D124), `idle`,
 * `done`, `fail`, `paused`, a closed session and a wake-up wait stop it. The repository splits
 * the time among the items in progress the session works on; the lists whose items' live
 * working time changed are published (`changed`), so the cards' running time follows.
 *
 * At {@link start} the spans a crash left open are closed at their session's last known working
 * moment (its newest event); at {@link stop} the open ones close now. A paired machine's sessions
 * are its own machine's to measure.
 */
export class TodoWorkClock {
  readonly #options: TodoWorkClockOptions;
  readonly #onError: (error: unknown) => void;
  /** The last status and activity heard per session. */
  readonly #seen = new Map<string, { status: SessionStatus; closed: boolean; activity: SessionActivity | null }>();
  #unsubscribe: (() => void) | null = null;

  constructor(options: TodoWorkClockOptions) {
    this.#options = options;
    this.#onError = options.onError ?? ((error) => console.error('switchboard todo work clock:', error));
  }

  /** Closes the spans left open by the last run, then listens to the sessions' updates. */
  async start(): Promise<void> {
    if (this.#unsubscribe) return;
    this.#seen.clear();
    await this.#options.store.todos.closeWorkSpans();
    this.#unsubscribe = this.#options.bus.subscribe((message) => this.#onMessage(message));
  }

  /** Stops listening and closes the open spans now. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.#options.store.todos.stopWorkClock();
  }

  #onMessage(message: HubMessage): void {
    if (message.name === 'sessionUpdated') {
      const session: Session = message.payload;
      if (isRemoteId(session.id)) return;
      this.#seen.set(session.id, { status: session.status, closed: session.closedAt != null, activity: session.activity ?? null });
      this.#apply(session.id);
    } else if (message.name === 'activity') {
      const { sessionId, activity } = message.payload;
      const seen = this.#seen.get(sessionId);
      // Before the session's first update the clock does not know its status: its update follows.
      if (!seen || isRemoteId(sessionId)) return;
      seen.activity = activity;
      this.#apply(sessionId);
    }
  }

  #apply(sessionId: string): void {
    const seen = this.#seen.get(sessionId);
    if (!seen) return;
    const store = this.#options.store;
    store.todos
      .setWorking(sessionId, isWorking(seen.status, seen.activity, seen.closed))
      .then(async (ids) => {
        if (ids.length === 0 || !this.#options.changed) return;
        const lists = new Set<string>();
        for (const id of ids) {
          const item = await store.todos.get(id);
          if (item) lists.add(item.sessionId);
        }
        for (const list of lists) this.#options.changed(list);
      })
      .catch((error: unknown) => this.#onError(error));
  }
}
