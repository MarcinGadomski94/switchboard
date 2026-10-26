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
  /** Saves and clears of this page still on their way to the server (a read waits for them). */
  readonly writing: Set<Promise<unknown>>;
  /** Counts this page's saves and clears: a read that ran while one started is read again. */
  writes: number;
}

/** A draft scope: a session id, or `null` for this machine's own drafts. */
export type DraftScope = string | null;

const sessions = new Map<string, Entry>();

/** A read waits at most this long for this page's own saves (then reads anyway). */
const WRITE_WAIT_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** The cache key of a scope (no session id is empty). */
function keyOf(scope: DraftScope): string {
  return scope ?? '';
}

function entry(scope: DraftScope): Entry {
  const key = keyOf(scope);
  let found = sessions.get(key);
  if (!found) {
    found = { values: new Map(), loaded: false, reading: null, again: false, writing: new Set(), writes: 0 };
    const kept = stored()[key];
    if (kept) for (const [field, value] of Object.entries(kept)) found.values.set(field, value);
    sessions.set(key, found);
  }
  return found;
}

/** The value this page last knew for the field (`undefined` = none known yet, `null` never). */
export function knownDraft(sessionId: DraftScope, field: string): unknown {
  return entry(sessionId).values.get(field);
}

/** `true` once the session's drafts were read at least once on this page. */
export function draftsLoaded(sessionId: DraftScope): boolean {
  return sessions.get(keyOf(sessionId))?.loaded === true;
}

/** Records what this page saved (`null` = cleared), so a revisit starts from it. */
export function rememberDraft(sessionId: DraftScope, field: string, value: unknown | null): void {
  const target = entry(sessionId);
  if (value === null) target.values.delete(field);
  else target.values.set(field, value);
  persist(sessionId, target);
}

/**
 * Fix after 2.0 (v2 drafts): a save or clear of this page (`value`: what it writes,
 * `null` = cleared) on its way to the server. The value is remembered at once, and
 * until `done` settles every read of the scope waits for it; a read already running
 * when it starts is read again. So a read can never answer the server's value from
 * before this page's own save (coming back to an agent while the save made on the
 * way out is still travelling used to show the older, often empty, draft).
 */
export function trackDraftWrite(sessionId: DraftScope, field: string, value: unknown | null, done: Promise<unknown>): void {
  rememberDraft(sessionId, field, value);
  const target = entry(sessionId);
  target.writes += 1;
  const settled = done.then(
    () => undefined,
    () => undefined,
  );
  target.writing.add(settled);
  void settled.then(() => target.writing.delete(settled));
}

function store(sessionId: DraftScope, target: Entry, drafts: readonly SessionDraft[]): ReadonlyMap<string, unknown> {
  target.values.clear();
  for (const draft of drafts) target.values.set(draft.field, draft.value);
  target.loaded = true;
  persist(sessionId, target);
  return target.values;
}

/**
 * Fix after 2.0 (v2 drafts): what this page knows is kept in the tab's
 * `sessionStorage` too, so a reload shows the draft at once (no empty field until
 * the server answers; the read that follows still decides). Best effort: without
 * storage, or past {@link STORED_MAX} characters, the page simply reads the server.
 */
const STORAGE_KEY = 'switchboard.drafts.v1';
const STORED_MAX = 1_000_000;
let storedCache: Record<string, Record<string, unknown>> | null = null;

/** The parts of `sessionStorage` used here (typed locally: this module is type-checked for Node too). */
interface TabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): TabStorage | null {
  try {
    return (globalThis as { sessionStorage?: TabStorage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

function stored(): Record<string, Record<string, unknown>> {
  if (storedCache) return storedCache;
  storedCache = {};
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) storedCache = parsed as Record<string, Record<string, unknown>>;
  } catch {
    // A broken entry: start empty.
  }
  return storedCache;
}

function persist(scope: DraftScope, target: Entry): void {
  const all = stored();
  const key = keyOf(scope);
  if (target.values.size === 0) delete all[key];
  else all[key] = Object.fromEntries(target.values);
  try {
    const text = JSON.stringify(all);
    if (text.length > STORED_MAX) storage()?.removeItem(STORAGE_KEY);
    else storage()?.setItem(STORAGE_KEY, text);
  } catch {
    // Full or blocked storage: the server read covers it.
  }
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
        // This page's own saves first: the server answers what they wrote.
        // (bounded: a save that never settles must not hold the field's restore forever).
        const until = Date.now() + WRITE_WAIT_MS;
        while (target.writing.size > 0 && Date.now() < until) await Promise.race([Promise.all([...target.writing]), delay(until - Date.now())]);
        const writes = target.writes;
        try {
          const drafts = await (sessionId === null ? api.machineDrafts() : api.sessionDrafts(sessionId));
          // A save started while the read ran: its answer may predate it, so read again.
          if (target.writes !== writes && Date.now() < until) target.again = true;
          else store(sessionId, target, drafts);
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
  storedCache = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // No storage.
  }
}
