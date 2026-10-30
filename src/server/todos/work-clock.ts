import type { Session } from '../../core/api.ts';
import { isRemoteId } from '../../core/peers.ts';
import type { Store } from '../db/store.ts';
import type { HubBus, HubMessage } from '../hub/bus.ts';

/** Options of {@link TodoWorkClock}. */
export interface TodoWorkClockOptions {
  readonly store: Store;
  readonly bus: HubBus;
  readonly onError?: (error: unknown) => void;
}

/**
 * D147 (`docs/todos.md` → *Actual vs. estimate*): an item's actual time is its agent's
 * **working** time. This clock tells the todo repository which of this machine's sessions are
 * working, from every `sessionUpdated`: a session works while its status reads `run` (a turn,
 * its subagents or a wake-up it waits on; `docs/derivations.md` → *Session status*, D143: a
 * background app left running or a GitHub wait is no work). `need` (a question, a permission, a
 * turn that ended waiting for the developer, D124), `idle`, `done`, `fail` and `paused` stop it.
 * The repository splits the time among the items in progress the session works on.
 *
 * At {@link start} the spans a crash left open are closed at their session's last known working
 * moment (its newest event); at {@link stop} the open ones close now. A paired machine's sessions
 * are its own machine's to measure.
 */
export class TodoWorkClock {
  readonly #options: TodoWorkClockOptions;
  readonly #onError: (error: unknown) => void;
  #unsubscribe: (() => void) | null = null;

  constructor(options: TodoWorkClockOptions) {
    this.#options = options;
    this.#onError = options.onError ?? ((error) => console.error('switchboard todo work clock:', error));
  }

  /** Closes the spans left open by the last run, then listens to the sessions' updates. */
  async start(): Promise<void> {
    if (this.#unsubscribe) return;
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
    if (message.name !== 'sessionUpdated') return;
    const session: Session = message.payload;
    if (isRemoteId(session.id)) return;
    this.#options.store.todos.setWorking(session.id, session.status === 'run' && session.closedAt == null).catch((error: unknown) => this.#onError(error));
  }
}
