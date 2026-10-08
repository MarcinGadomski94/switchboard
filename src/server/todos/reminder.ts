import type { Session } from '../../core/api.ts';
import type { SessionStatus } from '../../core/model.ts';
import { isRemoteId } from '../../core/peers.ts';
import { todoReminderMessage } from '../../core/todos.ts';
import type { HubBus, HubMessage } from '../hub/bus.ts';
import type { TodoService } from './service.ts';

/**
 * Sends the reminder text to the session; answers `false` when it was not delivered and
 * should not count as sent (a hooked session without a waiter).
 */
export type TodoReminderDelivery = (sessionId: string, text: string) => Promise<boolean>;

/** Options of {@link TodoReminder}. */
export interface TodoReminderOptions {
  readonly bus: HubBus;
  readonly todos: TodoService;
  /** Settings → Sessions → *Remind the agent to finish started todos* (read at every turn's end). */
  readonly enabled: () => Promise<boolean>;
  readonly deliver: TodoReminderDelivery;
  /** Epoch ms (tests pass a fake clock). */
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/**
 * D75 (`docs/todos.md` → *In progress (D75)*): the agent marks a started item done itself
 * (developer ruling). When a turn of one of this machine's sessions ends (its status goes
 * from `run` to `idle` or `done`, as the D73 push notifier reads it) while an item started
 * there (▶ Start or the agent's `todo_start`) is still in progress and the agent did not
 * change it during that turn, Switchboard sends the session **one** reminder message for
 * that item ({@link todoReminderMessage}), at most once per item per start (recorded as
 * `reminded_at`). A hooked terminal session gets it only while its waiter is held; a
 * paired machine's sessions are reminded by their own machine.
 */
export class TodoReminder {
  readonly #options: TodoReminderOptions;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #status = new Map<string, SessionStatus>();
  /** Session id → when its current (or last) turn began (epoch ms). */
  readonly #turnStart = new Map<string, number>();
  /** One check at a time per session (two quick turn ends never send the same reminder twice). */
  readonly #runs = new Map<string, Promise<void>>();
  #unsubscribe: (() => void) | null = null;

  constructor(options: TodoReminderOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((error) => console.error('switchboard todo reminder:', error));
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

  #onMessage(message: HubMessage): void {
    if (message.name !== 'sessionUpdated') return;
    const session: Session = message.payload;
    // A paired machine's session is its own machine's to remind.
    if (isRemoteId(session.id)) return;
    const before = this.#status.get(session.id);
    this.#status.set(session.id, session.status);
    if (before === session.status) return;
    if (session.status === 'run') {
      // A turn began (from idle / done; `need` → `run` continues the same turn).
      if (before !== 'need') this.#turnStart.set(session.id, this.#now());
      return;
    }
    if (before === 'run' && (session.status === 'idle' || session.status === 'done') && session.closedAt == null) this.#queue(session.id);
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
    if (!(await this.#options.enabled())) return;
    // Unknown (the turn began before Switchboard listened): any change by the agent counts as this turn's.
    const turnStartedAt = this.#turnStart.get(sessionId) ?? 0;
    for (const todo of await this.#options.todos.remindable(sessionId, turnStartedAt)) {
      if (!(await this.#options.deliver(sessionId, todoReminderMessage(todo)))) return;
      await this.#options.todos.markReminded(todo.id);
    }
  }
}
