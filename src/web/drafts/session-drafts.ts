/**
 * D88 · drafts follow you: what this page knows of each session's drafts
 * (`GET /api/sessions/{id}/drafts`), kept for the page's life so returning to a
 * session shows its drafts at once, and read again on `/hub` `draftChanged`. No
 * React here (the hook is `useDraft.ts`).
 *
 * A **scope** is a session id, or `null` for this machine's own drafts (ruling
 * 2026-10-09: the New-session form, `GET /api/drafts`).
 */
import type { SessionDraft } from '../../core/drafts.ts';
import { api } from '../api/client.ts';

interface Entry {
  /** The last known value per field (a field with no draft has no entry). */
  readonly values: Map<string, unknown>;
  loaded: boolean;
  reading: Promise<ReadonlyMap<string, unknown>> | null;
  /** Another read was asked for while one ran. */
  again: boolean;
}

/** A draft scope: a session id, or `null` for this machine's own drafts. */
export type DraftScope = string | null;

const sessions = new Map<string, Entry>();

/** The cache key of a scope (no session id is empty). */
function keyOf(scope: DraftScope): string {
  return scope ?? '';
}

function entry(scope: DraftScope): Entry {
  const key = keyOf(scope);
  let found = sessions.get(key);
  if (!found) {
    found = { values: new Map(), loaded: false, reading: null, again: false };
    sessions.set(key, found);
  }
  return found;
}

/** The value this page last knew for the field (`undefined` = none known yet, `null` never). */
export function knownDraft(sessionId: DraftScope, field: string): unknown {
  return sessions.get(keyOf(sessionId))?.values.get(field);
}

/** `true` once the session's drafts were read at least once on this page. */
export function draftsLoaded(sessionId: DraftScope): boolean {
  return sessions.get(keyOf(sessionId))?.loaded === true;
}

/** Records what this page saved (`null` = cleared), so a revisit starts from it. */
export function rememberDraft(sessionId: DraftScope, field: string, value: unknown | null): void {
  const values = entry(sessionId).values;
  if (value === null) values.delete(field);
  else values.set(field, value);
}

function store(target: Entry, drafts: readonly SessionDraft[]): ReadonlyMap<string, unknown> {
  target.values.clear();
  for (const draft of drafts) target.values.set(draft.field, draft.value);
  target.loaded = true;
  return target.values;
}

/**
 * Reads the session's drafts from the server (one read at a time per session; a
 * request during a read runs one more read after it). Never rejects: a failed read
 * answers what was known.
 */
export function readDrafts(sessionId: DraftScope): Promise<ReadonlyMap<string, unknown>> {
  const target = entry(sessionId);
  if (target.reading) {
    target.again = true;
    return target.reading;
  }
  const run = async (): Promise<ReadonlyMap<string, unknown>> => {
    try {
      do {
        target.again = false;
        try {
          store(target, await (sessionId === null ? api.machineDrafts() : api.sessionDrafts(sessionId)));
        } catch {
          // Offline peer, an older machine without the route: keep what is known.
        }
      } while (target.again);
      return target.values;
    } finally {
      target.reading = null;
    }
  };
  target.reading = run();
  return target.reading;
}

/** The session's drafts as this page knows them, read from the server only when it never was. */
export function draftsOnce(sessionId: DraftScope): Promise<ReadonlyMap<string, unknown>> {
  const known = sessions.get(keyOf(sessionId));
  if (known?.loaded) return Promise.resolve(known.values);
  return known?.reading ?? readDrafts(sessionId);
}

/** For tests: forgets every session. */
export function resetDraftCache(): void {
  sessions.clear();
}
