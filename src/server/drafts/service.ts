import {
  type ComposerDraft,
  DRAFTS_PER_SESSION_MAX,
  DRAFT_VALUE_MAX,
  type SessionDraft,
  draftIsEmpty,
  draftKind,
  draftSize,
  isDraftField,
  parseDraftValue,
} from '../../core/drafts.ts';
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

/**
 * D88 · drafts follow you (`docs/chat.md` → *Drafts*): this machine's sessions'
 * unsent field values. Saving an empty value clears the draft; every save and
 * clear publishes `draftChanged`; last write wins (the UI's focus rule keeps a
 * field being typed in from being overwritten). The composer's attachment chips
 * are answered only while their upload still exists in the session.
 */
export class DraftService {
  readonly #store: Store;
  readonly #bus: HubBus;

  constructor(options: { readonly store: Store; readonly bus: HubBus }) {
    this.#store = options.store;
    this.#bus = options.bus;
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
    const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const client = typeof input['client'] === 'string' && CLIENT_PATTERN.test(input['client']) ? input['client'] : null;
    if (!('value' in input)) throw new DraftError(422, 'invalid', 'The body needs a value.');
    if (draftSize(input['value']) > DRAFT_VALUE_MAX) throw new DraftError(413, 'too-large', `A draft may be at most ${DRAFT_VALUE_MAX / 1024} KB.`);
    const value = parseDraftValue(field, input['value']);
    if (value === null) throw new DraftError(422, 'invalid', 'That is not a value of this field.');
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

  /** Clears the draft (`DELETE …/drafts/{field}`; sent, saved, cancelled). Idempotent. */
  async delete(sessionId: string, field: string, client: unknown): Promise<void> {
    this.#field(field);
    await this.#session(sessionId);
    await this.#clear(sessionId, field, typeof client === 'string' && CLIENT_PATTERN.test(client) ? client : null);
  }

  async #clear(sessionId: string, field: string, client: string | null): Promise<void> {
    if (await this.#store.drafts.delete(sessionId, field)) this.#bus.publish('draftChanged', { sessionId, field, client });
  }
}
