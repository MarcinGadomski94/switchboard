import type { Session } from '../../core/api.ts';
import { isRemoteId } from '../../core/peers.ts';
import { todoEnrichMessage } from '../../core/todo-capture.ts';
import type { Store } from '../db/store.ts';
import type { HubBus, HubMessage } from '../hub/bus.ts';
import type { TodoService } from './service.ts';

/**
 * Sends the text to the session; answers `false` when it was not delivered and should not
 * count as asked (a hooked session without a waiter).
 */
export type TodoEnrichDelivery = (sessionId: string, text: string) => Promise<boolean>;

/** Options of {@link TodoEnricher}. */
export interface TodoEnricherOptions {
  readonly bus: HubBus;
  readonly store: Store;
  readonly todos: TodoService;
  /** Settings → Sessions → *Let the agent fill in captured todos* (read at every check). */
  readonly enabled: () => Promise<boolean>;
  readonly deliver: TodoEnrichDelivery;
  readonly onError?: (error: unknown) => void;
}

/** Statuses in which a session's agent is idle: not running a turn, not waiting on the developer. */
const IDLE: ReadonlySet<string> = new Set(['idle', 'done']);

/**
 * D81 (`docs/todos.md` → *Quick capture (D81)*): a captured item is saved bare and marked as
 * waiting for its agent. When that session's agent is next idle (status `idle` / `done`: not
 * running, not waiting on the developer), Switchboard sends it **one** short message asking it
 * to fill the item in with `todo_update` and not to start it ({@link todoEnrichMessage});
 * several pending captures go in one message. Each item is asked at most once
 * (`enrich_asked_at`). Checked whenever one of this machine's sessions' lists changes (a
 * capture) and whenever one of them is announced idle. Not for closed, paused or detached sessions, nor a hooked
 * terminal session without a waiter (it waits: a later check tries again); a paired machine's
 * sessions are asked by their own machine.
 */
export class TodoEnricher {
  readonly #options: TodoEnricherOptions;
  readonly #onError: (error: unknown) => void;
  /** One check at a time per session (a burst of updates never sends the same ask twice). */
  readonly #runs = new Map<string, Promise<void>>();
  #unsubscribe: (() => void) | null = null;

  constructor(options: TodoEnricherOptions) {
    this.#options = options;
    this.#onError = options.onError ?? ((error) => console.error('switchboard todo enrich:', error));
  }

  /** Starts listening to the sessions' updates. */
  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#options.bus.subscribe((message) => this.#onMessage(message));
  }

  /** Stops listening; waits for the checks in flight. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.idle();
  }

  /** Resolves once the checks in flight are done (tests). */
  async idle(): Promise<void> {
    while (this.#runs.size > 0) await Promise.all([...this.#runs.values()].map((run) => run.catch(() => undefined)));
  }

  /** Checks the session now (after a capture: an idle agent is asked at once). */
  poke(sessionId: string): void {
    if (isRemoteId(sessionId)) return;
    this.#queue(sessionId);
  }

  #onMessage(message: HubMessage): void {
    // A change of a session's list (a capture among them): its agent may be idle already.
    if (message.name === 'todosChanged') {
      if (!isRemoteId(message.payload.sessionId)) this.#queue(message.payload.sessionId);
      return;
    }
    if (message.name !== 'sessionUpdated') return;
    const session: Session = message.payload;
    if (isRemoteId(session.id) || session.closedAt != null || !IDLE.has(session.status)) return;
    this.#queue(session.id);
  }

  #queue(sessionId: string): void {
    const previous = this.#runs.get(sessionId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.#check(sessionId))
      .catch((error: unknown) => this.#onError(error));
    this.#runs.set(sessionId, run);
    void run.finally(() => {
      if (this.#runs.get(sessionId) === run) this.#runs.delete(sessionId);
    });
  }

  async #check(sessionId: string): Promise<void> {
    const record = await this.#options.store.sessions.get(sessionId);
    if (!record || record.closedAt !== null || record.detachedAt !== null || !IDLE.has(record.status)) return;
    const pending = await this.#options.todos.pendingEnrichment(sessionId);
    if (pending.length === 0) return;
    if (!(await this.#options.enabled())) return;
    if (!(await this.#options.deliver(sessionId, todoEnrichMessage(pending)))) return;
    await this.#options.todos.markEnrichAsked(pending.map((todo) => todo.id));
  }
}
