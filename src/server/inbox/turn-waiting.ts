import type { Session } from '../../core/api.ts';
import { turnWaits } from '../../core/derive/turn-status.ts';
import { isRemoteId } from '../../core/peers.ts';
import type { HubBus, HubMessage } from '../hub/bus.ts';
import type { SystemItemService } from './system-items.ts';

/** Options of {@link TurnWaitingInbox}. */
export interface TurnWaitingInboxOptions {
  readonly bus: HubBus;
  readonly systemItems: Pick<SystemItemService, 'turnWaitingNotice' | 'closeTurnWaitingNotices' | 'openTurnWaitingNotices'>;
  readonly onError?: (error: unknown) => void;
}

/** The longest session title in an item's title. */
const TITLE_MAX = 80;

/** One needs-you episode of a session: its turn wait's time. */
function episodeKey(sessionId: string, at: string): string {
  return `turn-waiting:${sessionId}:${at}`;
}

/** A session's shown name (its title, else its name), cut. */
function sessionTitle(session: Session): string {
  const title = (session.title ?? '').trim() || session.name;
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title;
}

/**
 * D124 (`docs/inbox.md` → *Waiting for you*): follows this machine's sessions (`sessionUpdated`)
 * and keeps one "Waiting for you: <session>" Inbox item per needs-you episode: raised when a
 * session reads `need` because its turn waits for the developer (its `turn_status`, or the text
 * check), closed by itself (`new-turn`) once that wait is gone (a new turn, Not waiting) or the
 * session is closed. Paired machines raise their own sessions' items (merged into this Inbox like
 * every system item); phones and the devices' push see them through the same path.
 */
export class TurnWaitingInbox {
  readonly #options: TurnWaitingInboxOptions;
  readonly #onError: (error: unknown) => void;
  /** Session id → the episode key of its open item. */
  #open = new Map<string, string>();
  /** One change at a time per session. */
  readonly #runs = new Map<string, Promise<void>>();
  #unsubscribe: (() => void) | null = null;

  constructor(options: TurnWaitingInboxOptions) {
    this.#options = options;
    this.#onError = options.onError ?? ((error) => console.error('switchboard turn waiting:', error));
  }

  /** Reads the open items, then follows the sessions. */
  async start(): Promise<void> {
    if (this.#unsubscribe) return;
    this.#open = await this.#options.systemItems.openTurnWaitingNotices();
    this.#unsubscribe = this.#options.bus.subscribe((message) => this.#onMessage(message));
  }

  /** Stops following; waits for the changes in flight. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.idle();
  }

  /** Resolves once the changes in flight are done (tests). */
  async idle(): Promise<void> {
    while (this.#runs.size > 0) await Promise.all([...this.#runs.values()].map((run) => run.catch(() => undefined)));
  }

  #onMessage(message: HubMessage): void {
    if (message.name !== 'sessionUpdated') return;
    const session: Session = message.payload;
    // A paired machine raises its own sessions' items.
    if (isRemoteId(session.id) || session.machine) return;
    const wait = session.turnWait;
    const waiting = session.status === 'need' && turnWaits(wait) && !session.closedAt;
    const key = waiting ? episodeKey(session.id, wait.at) : null;
    const notice = waiting ? { ask: wait.ask ?? '', at: wait.at, detected: wait.source === 'detected' } : null;
    const open = this.#open.get(session.id) ?? null;
    // Nothing changed; or nothing to raise or close (a turn that still works with its wait decided reads `run`: not yet).
    if (key === open) return;
    this.#queue(session.id, async () => {
      const current = this.#open.get(session.id) ?? null;
      if (current !== null && current !== key) {
        await this.#options.systemItems.closeTurnWaitingNotices(session.id, key === null ? 'new-turn' : 'superseded', key);
        this.#open.delete(session.id);
      }
      if (key !== null && notice !== null && current !== key) {
        await this.#options.systemItems.turnWaitingNotice({
          sessionId: session.id,
          title: `Waiting for you: ${sessionTitle(session)}`,
          source: sessionTitle(session),
          detail: notice.ask,
          dedupe: key,
          at: notice.at,
          detected: notice.detected,
        });
        this.#open.set(session.id, key);
      }
    });
  }

  #queue(sessionId: string, work: () => Promise<void>): void {
    const previous = this.#runs.get(sessionId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(work)
      .catch((error: unknown) => this.#onError(error));
    this.#runs.set(sessionId, run);
    void run.finally(() => {
      if (this.#runs.get(sessionId) === run) this.#runs.delete(sessionId);
    });
  }
}
