import type { InboxItem, Session } from '../../../core/api.ts';
import { type PushEventKind, type PushPayload, shortText } from '../../../core/devices.ts';
import { isRemoteId } from '../../../core/peers.ts';
import type { HubBus, HubMessage } from '../../hub/bus.ts';

/**
 * D73: which `/hub` happenings become a push to paired devices
 * (`docs/devices.md` → *Notifications*). This machine's own sessions and Inbox
 * only (a paired machine's items notify through that machine's own devices):
 *
 * - **permission** / **questions** / **inbox**: a new Inbox item (a permission
 *   request, a question batch, a system item such as a failed scheduled run),
 *   found by comparing the Inbox after each `inboxChanged` with the items seen
 *   before (the items present at start are known, never announced);
 * - **turnFinished**: a session whose status was `run` becomes `idle` or `done`
 *   (it went idle after working);
 * - **errors**: a session's status becomes `fail`.
 *
 * Each becomes a short payload (title, body ≤ 140 characters, deep link, tag);
 * {@link PushNotifierOptions.deliver} sends it to every device whose toggle for the
 * kind is on.
 */

/** One notification to deliver. */
export interface PushNotice {
  readonly kind: PushEventKind;
  readonly payload: PushPayload;
  readonly urgency: 'high' | 'normal';
}

/** Options of {@link PushNotifier}. */
export interface PushNotifierOptions {
  readonly bus: HubBus;
  /** This machine's Inbox (`listInbox`). */
  readonly inbox: () => Promise<readonly InboxItem[]>;
  /** Sends a notice to the devices that want its kind. */
  readonly deliver: (notice: PushNotice) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

/** A session's shown name: its title, else its name. */
function sessionName(session: Session): string {
  const title = (session as Session & { readonly title?: string | null }).title;
  return (typeof title === 'string' && title.trim()) || session.name;
}

/** The notice of a new Inbox item. */
export function inboxNotice(item: InboxItem): PushNotice {
  const who = item.sourceTitle ?? item.source;
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
  readonly #status = new Map<string, Session['status']>();
  #seen: Set<string> | null = null;
  #inboxRun: Promise<void> = Promise.resolve();
  #inboxAgain = false;
  #inboxQueued = false;
  #unsubscribe: (() => void) | null = null;

  constructor(options: PushNotifierOptions) {
    this.#options = options;
    this.#onError = options.onError ?? ((error) => console.error('switchboard push:', error));
  }

  /** Starts listening; the current Inbox items are known (not announced). */
  async start(): Promise<void> {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#options.bus.subscribe((message) => this.#onMessage(message));
    try {
      this.#seen = new Set((await this.#options.inbox()).map((item) => item.id));
    } catch (error) {
      this.#seen = new Set();
      this.#onError(error);
    }
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
    if (isRemoteId(session.id)) return;
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
    if (this.#seen === null) return;
    const items = await this.#options.inbox();
    const seen = this.#seen;
    this.#seen = new Set(items.map((item) => item.id));
    for (const item of items) {
      if (seen.has(item.id) || item.machine) continue;
      this.#send(inboxNotice(item));
    }
  }

  #send(notice: PushNotice): void {
    this.#options.deliver(notice).catch((error: unknown) => this.#onError(error));
  }
}
