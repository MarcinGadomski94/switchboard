import {
  type ComposerDraft,
  DRAFTS_PER_SESSION_MAX,
  DRAFT_VALUE_MAX,
  MACHINE_DRAFTS_MAX,
  type SessionDraft,
  draftIsEmpty,
  draftKind,
  draftSize,
  isDraftField,
  isMachineDraftField,
  parseDraftValue,
} from '../../core/drafts.ts';
import { parseRemoteId } from '../../core/peers.ts';
import { SESSION_CLOSED_REASON } from '../../core/session-close.ts';
import { isBatchWaiting } from '../inbox/wire.ts';
import type { Store } from '../db/store.ts';
import type { DraftRecord } from '../db/repos/drafts.ts';
import type { HubBus } from '../hub/bus.ts';

/** Why a draft call was refused (sent as `{ error, message }` with {@link status}). */
export class DraftError extends Error {
  override name = 'DraftError';
  readonly status: number;
  readonly code: 'not-found' | 'invalid' | 'too-large' | 'too-many';
  constructor(status: number, code: DraftError['code'], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A page id as the UI sends it (`pageClientId`: hex); anything else is not recorded. */
const CLIENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The kinds whose draft names something that can be answered, resolved or removed (the clean-up looks at these). */
const TIED_PREFIXES = ['question:', 'review:', 'commit:', 'todo-edit:'] as const;

/**
 * D88 · drafts follow you (`docs/chat.md` → *Drafts*): this machine's sessions'
 * unsent field values, and (ruling 2026-10-09) this machine's own drafts that
 * belong to no session (the New-session form). Saving an empty value clears the
 * draft; every save and clear publishes `draftChanged`; last write wins (the UI's
 * focus rule keeps a field being typed in from being overwritten). The composer's
 * attachment chips are answered only while their upload still exists in the session.
 *
 * **Clean-up (ruling 2026-10-09):** a draft whose question batch was answered or
 * closed (here, on claude.ai, by a stopped turn), whose review was resolved, or
 * whose todo was deleted or done is deleted at once, with `draftChanged` (`client`
 * `null`), wherever that happened: the service listens to the session's
 * `sessionUpdated`, `reviewsChanged` and `todosChanged` and looks at that session's
 * tied drafts ({@link prune}). Closing a session removes none (its drafts stay until
 * the session is deleted; a batch closed with the session keeps its picks).
 */
export class DraftService {
  readonly #store: Store;
  readonly #bus: HubBus;
  /** The clean-up runs one at a time per session; a trigger during a run asks for one more. */
  readonly #pruning = new Map<string, { run: Promise<void>; again: boolean }>();
  readonly #unsubscribe: () => void;
  readonly #onError: (error: unknown) => void;

  constructor(options: { readonly store: Store; readonly bus: HubBus; readonly onError?: (error: unknown) => void }) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#onError = options.onError ?? ((error) => console.error('switchboard drafts:', error));
    this.#unsubscribe = this.#bus.subscribe((message) => {
      if (message.name === 'sessionUpdated') this.#schedule(message.payload.id);
      else if (message.name === 'reviewsChanged' || message.name === 'todosChanged') this.#schedule(message.payload.sessionId);
    });
  }

  /** Stops listening (the app's close). */
  dispose(): void {
    this.#unsubscribe();
  }

  #schedule(sessionId: unknown): void {
    // A paired machine's session (forwarded events) is cleaned up on that machine.
    if (typeof sessionId !== 'string' || parseRemoteId(sessionId) !== null) return;
    const running = this.#pruning.get(sessionId);
    if (running) {
      running.again = true;
      return;
    }
    const entry = { run: Promise.resolve(), again: false };
    entry.run = (async () => {
      try {
        do {
          entry.again = false;
          try {
            await this.prune(sessionId);
          } catch (error) {
            this.#onError(error);
          }
        } while (entry.again);
      } finally {
        this.#pruning.delete(sessionId);
      }
    })();
    this.#pruning.set(sessionId, entry);
  }

  /** For tests: resolves once no clean-up runs. */
  async idle(): Promise<void> {
    while (this.#pruning.size > 0) await Promise.all([...this.#pruning.values()].map((entry) => entry.run));
  }

  /**
   * Deletes the session's drafts whose target is gone (see the class comment) and
   * publishes `draftChanged` for each; answers the cleared fields.
   */
  async prune(sessionId: string): Promise<string[]> {
    const cleared: string[] = [];
    for (const draft of await this.#store.drafts.listKinds(sessionId, TIED_PREFIXES)) {
      if (!(await this.#orphaned(sessionId, draft.field))) continue;
      if (await this.#store.drafts.delete(sessionId, draft.field)) {
        cleared.push(draft.field);
        this.#bus.publish('draftChanged', { sessionId, field: draft.field, client: null });
      }
    }
    return cleared;
  }

  async #orphaned(sessionId: string, field: string): Promise<boolean> {
    const id = field.slice(field.indexOf(':') + 1);
    switch (draftKind(field)) {
      case 'question': {
        const batch = await this.#store.questions.getBatch(id);
        if (!batch || batch.sessionId !== sessionId) return true;
        // Closed with its session: kept (closed sessions keep their drafts until deleted).
        return !isBatchWaiting(batch) && batch.closedReason !== SESSION_CLOSED_REASON;
      }
      case 'review':
      case 'commit': {
        const review = await this.#store.reviews.get(id);
        return !review || review.sessionId !== sessionId || review.state !== 'pending';
      }
      case 'todo-edit': {
        const todo = await this.#store.todos.get(id);
        return !todo || todo.sessionId !== sessionId || todo.state === 'done';
      }
      default:
        return false;
    }
  }

  async #session(sessionId: string): Promise<void> {
    if (!(await this.#store.sessions.get(sessionId))) throw new DraftError(404, 'not-found', 'No such session.');
  }

  #field(field: string): void {
    if (!isDraftField(field)) throw new DraftError(422, 'invalid', 'Unknown draft field.');
  }

  /** The session's drafts (`GET …/drafts`); composer chips whose upload is gone are left out. */
  async list(sessionId: string): Promise<SessionDraft[]> {
    await this.#session(sessionId);
    const out: SessionDraft[] = [];
    for (const row of await this.#store.drafts.list(sessionId)) {
      const draft = await this.#answer(row);
      if (draft) out.push(draft);
    }
    return out;
  }

  async #answer(row: DraftRecord): Promise<SessionDraft | null> {
    let value = parseDraftValue(row.field, row.value);
    if (value === null) return null;
    if (draftKind(row.field) === 'composer') {
      const composer = value as ComposerDraft;
      if (composer.attachments.length > 0) {
        // Only the uploads that still exist in the session, as stored (name, size, kind, type).
        const stored = await this.#store.attachments.listIn(row.sessionId, composer.attachments.map((a) => a.id));
        value = { ...composer, attachments: stored.map((a) => ({ id: a.id, name: a.name, size: a.size, kind: a.kind, mediaType: a.mediaType })) };
      }
      if (draftIsEmpty(row.field, value)) return null;
    }
    return { field: row.field, value, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
  }

  /**
   * Saves `body.value` for `field` (`PUT …/drafts/{field}`); an empty value clears it
   * (answers `null`). `origin` says who asks (`local`, `device:<id>`, `peer`).
   */
  async put(sessionId: string, field: string, body: unknown, origin: string): Promise<SessionDraft | null> {
    this.#field(field);
    await this.#session(sessionId);
    const { client, value } = this.#input(field, body);
    if (draftIsEmpty(field, value)) {
      await this.#clear(sessionId, field, client);
      return null;
    }
    if (!(await this.#store.drafts.get(sessionId, field)) && (await this.#store.drafts.count(sessionId)) >= DRAFTS_PER_SESSION_MAX) {
      throw new DraftError(409, 'too-many', `A session keeps at most ${DRAFTS_PER_SESSION_MAX} drafts.`);
    }
    const row = await this.#store.drafts.put(sessionId, field, value, client ? `${origin}/${client}` : origin);
    this.#bus.publish('draftChanged', { sessionId, field, client });
    return { field, value: row.value, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
  }

  /** The PUT body's page id and value of `field` (validated, normalized). */
  #input(field: string, body: unknown): { readonly client: string | null; readonly value: unknown } {
    const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const client = typeof input['client'] === 'string' && CLIENT_PATTERN.test(input['client']) ? input['client'] : null;
    if (!('value' in input)) throw new DraftError(422, 'invalid', 'The body needs a value.');
    if (draftSize(input['value']) > DRAFT_VALUE_MAX) throw new DraftError(413, 'too-large', `A draft may be at most ${DRAFT_VALUE_MAX / 1024} KB.`);
    const value = parseDraftValue(field, input['value']);
    if (value === null) throw new DraftError(422, 'invalid', 'That is not a value of this field.');
    return { client, value };
  }

  /** Clears the draft (`DELETE …/drafts/{field}`; sent, saved, cancelled). Idempotent. */
  async delete(sessionId: string, field: string, client: unknown): Promise<void> {
    this.#field(field);
    await this.#session(sessionId);
    await this.#clear(sessionId, field, typeof client === 'string' && CLIENT_PATTERN.test(client) ? client : null);
  }

  async #clear(sessionId: string, field: string, client: string | null): Promise<void> {
    if (await this.#store.drafts.delete(sessionId, field)) this.#bus.publish('draftChanged', { sessionId, field, client });
  }

  // ── this machine's own drafts (no session; ruling 2026-10-09) ──────────

  #machineField(field: string): void {
    if (!isMachineDraftField(field)) throw new DraftError(422, 'invalid', 'Unknown draft field.');
  }

  /** This machine's drafts (`GET /api/drafts`): the New-session form's. */
  async listMachine(): Promise<SessionDraft[]> {
    const out: SessionDraft[] = [];
    for (const row of await this.#store.drafts.listMachine()) {
      const value = parseDraftValue(row.field, row.value);
      if (value !== null && !draftIsEmpty(row.field, value)) out.push({ field: row.field, value, updatedAt: row.updatedAt, updatedBy: row.updatedBy });
    }
    return out;
  }

  /** Saves a machine draft (`PUT /api/drafts/{field}`); an empty value clears it (answers `null`). */
  async putMachine(field: string, body: unknown, origin: string): Promise<SessionDraft | null> {
    this.#machineField(field);
    const { client, value } = this.#input(field, body);
    if (draftIsEmpty(field, value)) {
      await this.#clearMachine(field, client);
      return null;
    }
    if (!(await this.#store.drafts.getMachine(field)) && (await this.#store.drafts.countMachine()) >= MACHINE_DRAFTS_MAX) {
      throw new DraftError(409, 'too-many', `This machine keeps at most ${MACHINE_DRAFTS_MAX} drafts.`);
    }
    const row = await this.#store.drafts.putMachine(field, value, client ? `${origin}/${client}` : origin);
    this.#bus.publish('draftChanged', { sessionId: null, field, client });
    return { field, value: row.value, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
  }

  /** Clears a machine draft (`DELETE /api/drafts/{field}`; started, Clear). Idempotent. */
  async deleteMachine(field: string, client: unknown): Promise<void> {
    this.#machineField(field);
    await this.#clearMachine(field, typeof client === 'string' && CLIENT_PATTERN.test(client) ? client : null);
  }

  async #clearMachine(field: string, client: string | null): Promise<void> {
    if (await this.#store.drafts.deleteMachine(field)) this.#bus.publish('draftChanged', { sessionId: null, field, client });
  }
}
