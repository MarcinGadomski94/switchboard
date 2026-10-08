import type { InboxItem, Session } from '../../../core/api.ts';
import { type PushEventKind, type PushPayload, shortText } from '../../../core/devices.ts';
import type { HubBus, HubMessage } from '../../hub/bus.ts';

/**
 * D73: which `/hub` happenings become a push to paired devices
 * (`docs/devices.md` → *Notifications*). This machine's sessions and Inbox, and
 * (developer ruling 2026-10-08) the paired machines' (D48): their events reach
 * the local bus through the peer streams, which carry only what happened on that
 * machine (never an echo of ours), with remote ids `r~<machine>~<id>`:
 *
 * - **permission** / **questions** / **inbox**: a new Inbox item (a permission
 *   request, a question batch, a system item such as a failed scheduled run),
 *   found by comparing the merged Inbox (this machine's and the paired machines'
 *   cached ones) after each `inboxChanged` with the items announced before. Each
 *   item id is announced once (a machine that drops and reconnects does not
 *   announce its items again), and only while it is fresh: created after the
 *   notifier started (less a minute of clock slack) and within the last
 *   {@link FRESH_MS} (old items a reconnecting machine lists are not news);
 * - **turnFinished**: a session whose status was `run` becomes `idle` or `done`
 *   (it went idle after working);
 * - **errors**: a session's status becomes `fail`.
 *
 * Each becomes a short payload (title, body ≤ 140 characters, deep link, tag);
 * {@link PushNotifierOptions.deliver} sends it to every device whose toggle for the
 * kind is on.
 */

/** An Inbox item is announced only when created within this long (a reconnect's old items are not news). */
export const FRESH_MS = 10 * 60_000;

/** Clock slack between machines when judging an item's age. */
const SLACK_MS = 60_000;

/** Announced ids are remembered this long (then forgotten; they are long out of the fresh window). */
const REMEMBER_MS = 24 * 60 * 60_000;

/** One notification to deliver. */
export interface PushNotice {
  readonly kind: PushEventKind;
  readonly payload: PushPayload;
  readonly urgency: 'high' | 'normal';
}

/** Options of {@link PushNotifier}. */
export interface PushNotifierOptions {
  readonly bus: HubBus;
  /** This machine's Inbox (`listInbox`) and the paired machines' (cached, remote ids). */
  readonly inbox: () => Promise<readonly InboxItem[]>;
  /** Epoch ms (tests pass a fake clock). */
  readonly now?: () => number;
  /** Sends a notice to the devices that want its kind. */
  readonly deliver: (notice: PushNotice) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

/** A session's shown name: its title, else its name; a paired machine's with `· <machine>`. */
function sessionName(session: Session): string {
  const title = (session as Session & { readonly title?: string | null }).title;
  const name = (typeof title === 'string' && title.trim()) || session.name;
  return session.machine ? `${name} · ${session.machine.name}` : name;
}

/** The notice of a new Inbox item. */
export function inboxNotice(item: InboxItem): PushNotice {
  const source = item.sourceTitle ?? item.source;
  const who = item.machine ? `${source} · ${item.machine.name}` : source;
  const url = item.sessionId ? `/sessions/${encodeURIComponent(item.sessionId)}` : '/inbox';
  if (item.kind === 'permission') {
    return {
      kind: 'permission',
      urgency: 'high',
      payload: { kind: 'permission', title: shortText(`${who} needs permission`, 80), body: shortText(item.title || item.detail || 'A permission request is waiting.'), url, tag: `inbox-${item.id}` },
    };
  }
  if (item.kind === 'questions') {
    const first = item.questions?.[0]?.text ?? item.title;
    return {
      kind: 'questions',
      urgency: 'high',
      payload: { kind: 'questions', title: shortText(`${who} needs you`, 80), body: shortText(first || item.label), url, tag: `inbox-${item.id}` },
    };
  }
  return {
    kind: 'inbox',
    urgency: 'normal',
    payload: { kind: 'inbox', title: shortText(item.label || 'Inbox', 80), body: shortText(item.title || item.detail || who), url: '/inbox', tag: `inbox-${item.id}` },
  };
}

/** Listens to the bus and turns happenings into {@link PushNotice}s. */
export class PushNotifier {
  readonly #options: PushNotifierOptions;
  readonly #onError: (error: unknown) => void;
  readonly #now: () => number;
  readonly #status = new Map<string, Session['status']>();
  /** Item id → when it was announced (or known at start). */
  readonly #announced = new Map<string, number>();
  #startedAt: number | null = null;
  #inboxRun: Promise<void> = Promise.resolve();
  #inboxAgain = false;
  #inboxQueued = false;
  #unsubscribe: (() => void) | null = null;

  constructor(options: PushNotifierOptions) {
    this.#options = options;
    this.#onError = options.onError ?? ((error) => console.error('switchboard push:', error));
    this.#now = options.now ?? Date.now;
  }

  /** Starts listening; the current Inbox items are known (not announced). */
  async start(): Promise<void> {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#options.bus.subscribe((message) => this.#onMessage(message));
    const now = this.#now();
    try {
      for (const item of await this.#options.inbox()) this.#announced.set(item.id, now);
    } catch (error) {
      this.#onError(error);
    }
    this.#startedAt = now;
  }

  /** Stops listening; waits for a running Inbox comparison. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.#inboxRun.catch(() => undefined);
  }

  /** Resolves once queued work is done (tests). */
  async idle(): Promise<void> {
    while (this.#inboxQueued) await this.#inboxRun.catch(() => undefined);
    await this.#inboxRun.catch(() => undefined);
  }

  #onMessage(message: HubMessage): void {
    if (message.name === 'inboxChanged') this.#queueInbox();
    else if (message.name === 'sessionUpdated') this.#onSession(message.payload);
  }

  #onSession(session: Session): void {
    const before = this.#status.get(session.id);
    this.#status.set(session.id, session.status);
    if (before === undefined || before === session.status) return;
    const name = sessionName(session);
    const url = `/sessions/${encodeURIComponent(session.id)}`;
    if (session.status === 'fail') {
      this.#send({ kind: 'errors', urgency: 'normal', payload: { kind: 'errors', title: shortText(`${name} failed`, 80), body: 'The session stopped with an error.', url, tag: `session-${session.id}` } });
    } else if (before === 'run' && (session.status === 'idle' || session.status === 'done')) {
      this.#send({ kind: 'turnFinished', urgency: 'normal', payload: { kind: 'turnFinished', title: shortText(`${name} finished`, 80), body: 'The turn is done; the session is waiting for you.', url, tag: `session-${session.id}` } });
    }
  }

  /** Compares the Inbox once more (serialized; bursts of `inboxChanged` fold into one more run). */
  #queueInbox(): void {
    if (this.#inboxQueued) {
      this.#inboxAgain = true;
      return;
    }
    this.#inboxQueued = true;
    this.#inboxRun = this.#inboxRun
      .catch(() => undefined)
      .then(async () => {
        do {
          this.#inboxAgain = false;
          await this.#compareInbox();
        } while (this.#inboxAgain);
      })
      .catch((error: unknown) => this.#onError(error))
      .finally(() => {
        this.#inboxQueued = false;
      });
  }

  async #compareInbox(): Promise<void> {
    if (this.#startedAt === null) return;
    const items = await this.#options.inbox();
    const now = this.#now();
    for (const [id, at] of this.#announced) if (now - at > REMEMBER_MS) this.#announced.delete(id);
    for (const item of items) {
      if (this.#announced.has(item.id)) continue;
      this.#announced.set(item.id, now);
      const created = Date.parse(item.createdAt);
      // Not news: made before the notifier started, or older than the fresh window (a reconnecting machine's backlog).
      if (Number.isFinite(created) && (created < this.#startedAt - SLACK_MS || created < now - FRESH_MS)) continue;
      this.#send(inboxNotice(item));
    }
  }

  #send(notice: PushNotice): void {
    this.#options.deliver(notice).catch((error: unknown) => this.#onError(error));
  }
}
