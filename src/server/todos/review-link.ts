import type { HubBus, HubMessage } from '../hub/bus.ts';
import type { TodoService } from './service.ts';

/**
 * D76 (`docs/todos.md` → *Review*): listens for the review queue's `reviewResolved`
 * (lane B; `src/core/reviews.ts`) and moves the items in review whose run session the
 * resolved card was about ({@link TodoService.resolveReview}): merged / committed /
 * dismissed → done, discarded → open, sent back → in progress. One resolution at a time.
 */
export class TodoReviewLink {
  readonly #bus: HubBus;
  readonly #todos: TodoService;
  readonly #onError: (error: unknown) => void;
  #unsubscribe: (() => void) | null = null;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: { readonly bus: HubBus; readonly todos: TodoService; readonly onError?: (error: unknown) => void }) {
    this.#bus = options.bus;
    this.#todos = options.todos;
    this.#onError = options.onError ?? ((error) => console.error('switchboard todo review:', error));
  }

  /** Starts listening. */
  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#bus.subscribe((message) => this.#onMessage(message));
  }

  /** Stops listening; waits for the resolution in flight. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.idle();
  }

  /** Resolves once the resolutions in flight are applied (tests). */
  async idle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.#tail;
      await seen;
    } while (seen !== this.#tail);
  }

  #onMessage(message: HubMessage): void {
    if (message.name !== 'reviewResolved') return;
    const { sessionId, outcome } = message.payload;
    this.#tail = this.#tail
      .then(() => this.#todos.resolveReview(sessionId, outcome))
      .then(
        () => undefined,
        (error: unknown) => this.#onError(error),
      );
  }
}
