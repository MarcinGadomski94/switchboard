import type { HubEventName, HubEvents } from '../../core/api.ts';

/**
 * The in-process event bus behind `/hub` (M2.3, D5). Services publish the
 * contract's events here (`contracts/local-api.md` → Event hub: names and
 * payloads locked); the SSE hub (`hub.ts`) forwards every message to each
 * connected browser. Publishing never throws and never waits: listeners run
 * synchronously and a failing listener is reported, not propagated.
 * Who publishes what: `docs/hub.md`.
 */

/** One published event: a contract name with its payload. */
export type HubMessage = { readonly [K in HubEventName]: { readonly name: K; readonly payload: HubEvents[K] } }[HubEventName];

/** A bus subscriber. */
export type HubListener = (message: HubMessage) => void;

/** Options for {@link HubBus}. */
export interface HubBusOptions {
  /** Called when a listener throws (default: `console.error`). */
  readonly onError?: (error: unknown) => void;
}

/** Typed publish/subscribe for the `/hub` events. */
export class HubBus {
  readonly #listeners = new Set<HubListener>();
  readonly #onError: (error: unknown) => void;

  constructor(options: HubBusOptions = {}) {
    this.#onError = options.onError ?? ((error) => console.error('switchboard hub:', error));
  }

  /** Publishes one event to every subscriber, in subscription order. */
  publish<K extends HubEventName>(name: K, payload: HubEvents[K]): void {
    const message = { name, payload } as HubMessage;
    for (const listener of [...this.#listeners]) {
      try {
        listener(message);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  /** Subscribes to every event; returns the unsubscribe function. */
  subscribe(listener: HubListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Number of subscribers (the SSE hub counts as one). */
  get listenerCount(): number {
    return this.#listeners.size;
  }
}
