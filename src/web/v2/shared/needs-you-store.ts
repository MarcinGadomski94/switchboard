import type { InboxItem, SystemInfo } from '../../../core/api.ts';
import type { MemoryEntry } from '../../../core/memory.ts';
import type { MachineState } from '../../../core/peers.ts';
import type { TeamNeedsYouItem } from '../../../core/team.ts';
import { usageGridLines } from '../../shell/format.ts';
import type { AnsweredWhere } from '../glossary.ts';
import { type AnswerAction, type AnsweredInfo, summaryOf } from './answer-model.ts';
import { type NeedsItem, type UsageAlert, memoryScopeOf, mergeNeedsYou } from './needs-you-model.ts';

/**
 * D131 · the "Needs you" store's logic (DOM-free; `needs-you.ts` wires it to the
 * page). The store (`docs/v2.md` → *Needs you*): one client-side copy
 * of everything waiting for the developer, shared by every v2 view (the rail and
 * phone badges, the top bar, Home, the Needs-you page, each agent's chat, the
 * Board, Crews). Answering anywhere answers it everywhere: the item leaves every
 * list at once and every card of it turns compact ("You answered …").
 *
 * - Reads `GET /api/inbox` (this computer's and the paired ones'), `GET
 *   /api/team/needs-you?teamId=all`, the proposed notes of the scopes the Inbox
 *   names, and the usage in `GET /api/system`; merged by `mergeNeedsYou`.
 * - Live: reads again on `/hub` `inboxChanged`, `teamChanged`, `memoryChanged`,
 *   `planChanged`, a paired computer's state change, and when the hub stream
 *   reopens; usage follows `system`.
 * - **Undo:** an answer waits {@link UNDO_WINDOW_MS} before it is sent (the toast's
 *   Undo takes it back); it is sent at once when the page is hidden or closed.
 * - A refused answer brings the item back with the server's reason.
 *
 * The factory ({@link createNeedsYouStore}) takes its I/O, so the merge, the hiding
 * and the undo are unit-tested without a browser.
 */

/** How long an answer can be taken back before it is sent (ms). */
export const UNDO_WINDOW_MS = 5_000;

/** Where the browser keeps the usage alerts it dismissed. */
export const DISMISSED_ALERTS_KEY = 'switchboard.v2.dismissedAlerts';

/** What the store reads and calls (the real ones by default). */
export interface NeedsYouDeps {
  readonly inbox: () => Promise<readonly InboxItem[]>;
  readonly team: () => Promise<readonly TeamNeedsYouItem[]>;
  /** The proposed notes of a scope, on a paired computer when `machineId` is set. */
  readonly notes: (scope: string, machineId: string | null) => Promise<readonly MemoryEntry[]>;
  readonly system: () => Promise<SystemInfo>;
  /** Sends an answer; throws with the server's reason when refused. */
  readonly send: (item: NeedsItem, action: AnswerAction) => Promise<void>;
  readonly now: () => number;
  readonly storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  readonly undoMs: number;
}

/** The store's state. */
export interface NeedsYouSnapshot {
  /** Everything waiting, newest first (answered items left out). */
  readonly items: readonly NeedsItem[];
  /** `true` once the Inbox was read at least once. */
  readonly loaded: boolean;
  /** Why the Inbox could not be read (`null` when it could). */
  readonly error: string | null;
  /** Answers given on this page (newest kept), by item key: the compact cards. */
  readonly answered: ReadonlyMap<string, AnsweredInfo>;
  /** Answers waiting out their Undo window, by item key. */
  readonly pending: ReadonlySet<string>;
  /** Why an answer was refused, by item key (cleared on the next answer). */
  readonly errors: ReadonlyMap<string, string>;
}

/** The store's interface (see {@link createNeedsYouStore}). */
export interface NeedsYouStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => NeedsYouSnapshot;
  /** Starts reading (and listening) while at least one view holds it. */
  readonly retain: () => () => void;
  readonly reload: () => Promise<void>;
  /** Usage changed (`system` hub event / `GET /api/system`). */
  readonly usageChanged: (system: SystemInfo | null) => void;
  /** Live states of the paired computers. */
  readonly computersChanged: (states: Readonly<Record<string, MachineState>>) => void;
  /** Answers `item` (hidden at once everywhere; sent after the Undo window). */
  readonly answer: (item: NeedsItem, action: AnswerAction, where: AnsweredWhere) => void;
  /** Takes back an answer still in its Undo window; `false` when already sent. */
  readonly undo: (key: string) => boolean;
  /** Sends every answer still waiting now (page hidden / closed). */
  readonly flush: () => Promise<void>;
}

const EMPTY: NeedsYouSnapshot = { items: [], loaded: false, error: null, answered: new Map(), pending: new Set(), errors: new Map() };

/** The usage alerts of a `GET /api/system` reading: an account out of usage, or paying from paid extra usage. */
export function usageAlerts(system: SystemInfo | null, now: number, firstSeen: (key: string) => string): UsageAlert[] {
  if (!system) return [];
  const out: UsageAlert[] = [];
  for (const line of usageGridLines(system, now)) {
    if (line.credits) {
      const key = `credits:${line.key}`;
      out.push({ key, title: 'Out of usage, now using paid extra', text: `${line.label} · ${line.credits.text}. Agents keep working.`, createdAt: firstSeen(key) });
    } else if (line.spent && line.outUntil) {
      const key = `out:${line.key}:${line.outUntil}`;
      out.push({ key, title: `${line.label} is out of usage`, text: `${line.outUntil.replace(/^out /, 'Out ')}. Agents switch to another account automatically when one is set up.`, createdAt: firstSeen(key) });
    }
  }
  return out;
}

/** The words of a refusal: the server's `message`, else the HTTP status (an `ApiError`, read by shape), else the error's text. */
export function errorText(error: unknown): string {
  const shaped = error as { status?: unknown; body?: unknown; message?: unknown } | null;
  if (shaped && typeof shaped === 'object' && typeof shaped.status === 'number') {
    const body = shaped.body as { message?: unknown } | null;
    if (body && typeof body === 'object' && typeof body.message === 'string') return body.message;
    return shaped.status === 0 ? 'Switchboard is not reachable.' : `HTTP ${shaped.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Builds a store over `deps` (the page uses {@link needsYouStore}). */
export function createNeedsYouStore(deps: NeedsYouDeps): NeedsYouStore {
  let snapshot: NeedsYouSnapshot = EMPTY;
  const listeners = new Set<() => void>();
  let inbox: readonly InboxItem[] | null = null;
  let team: readonly TeamNeedsYouItem[] | null = null;
  let notes: Readonly<Record<string, readonly MemoryEntry[]>> = {};
  let system: SystemInfo | null = null;
  let computers: Readonly<Record<string, MachineState>> = {};
  let loaded = false;
  let error: string | null = null;
  /** Keys answered here: hidden until the server no longer lists them. */
  const hidden = new Set<string>();
  /** Answers in their Undo window. */
  const pending = new Map<string, { readonly item: NeedsItem; readonly action: AnswerAction; readonly timer: ReturnType<typeof setTimeout> }>();
  const answered = new Map<string, AnsweredInfo>();
  const errors = new Map<string, string>();
  const seenAt = new Map<string, string>();
  let readers = 0;
  let generation = 0;

  const dismissed = (): Set<string> => {
    try {
      const raw = deps.storage?.getItem(DISMISSED_ALERTS_KEY);
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      return new Set(Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []);
    } catch {
      return new Set();
    }
  };
  const firstSeen = (key: string): string => {
    let at = seenAt.get(key);
    if (!at) {
      at = new Date(deps.now()).toISOString();
      seenAt.set(key, at);
    }
    return at;
  };

  const emit = (): void => {
    const gone = dismissed();
    const usage = usageAlerts(system, deps.now(), firstSeen).filter((alert) => !gone.has(alert.key));
    const items = mergeNeedsYou({ inbox, team, notes, usage, computers }, hidden);
    snapshot = { items, loaded, error, answered: new Map(answered), pending: new Set(pending.keys()), errors: new Map(errors) };
    for (const listener of listeners) listener();
  };

  /** Forgets a hidden key once the server no longer lists it (sent and gone). */
  const prune = (): void => {
    const listed = new Set(mergeNeedsYou({ inbox, team, notes, usage: [], computers }).map((item) => item.key));
    for (const key of hidden) if (!pending.has(key) && !listed.has(key) && !key.startsWith('usage:')) hidden.delete(key);
  };

  const readNotes = async (items: readonly InboxItem[]): Promise<Record<string, readonly MemoryEntry[]>> => {
    const out: Record<string, readonly MemoryEntry[]> = {};
    for (const item of items) {
      if (item.kind !== 'system' || !(item.actions ?? []).some((a) => a.id === 'open-memory')) continue;
      const scope = memoryScopeOf(item);
      if (!scope || out[scope]) continue;
      try {
        out[scope] = (await deps.notes(scope, item.machine?.id ?? null)).filter((entry) => entry.status === 'proposed');
      } catch {
        // The summary item stays (its Review link still works).
      }
    }
    return out;
  };

  const reload = async (): Promise<void> => {
    const mine = ++generation;
    const [inboxResult, teamResult] = await Promise.allSettled([deps.inbox(), deps.team()]);
    if (mine !== generation) return;
    if (inboxResult.status === 'fulfilled') {
      inbox = inboxResult.value;
      loaded = true;
      error = null;
      notes = await readNotes(inbox);
      if (mine !== generation) return;
    } else {
      error = errorText(inboxResult.reason);
    }
    // Team is optional (off, or an older service): no crew items then.
    team = teamResult.status === 'fulfilled' ? teamResult.value : [];
    prune();
    emit();
  };

  const commit = async (key: string): Promise<void> => {
    const entry = pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(key);
    try {
      await deps.send(entry.item, entry.action);
    } catch (caught) {
      hidden.delete(key);
      answered.delete(key);
      errors.set(key, errorText(caught));
    }
    emit();
    void reload();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    retain() {
      readers += 1;
      if (readers === 1) void reload();
      return () => {
        readers -= 1;
      };
    },
    reload,
    usageChanged(next) {
      system = next;
      emit();
    },
    computersChanged(next) {
      const same = Object.keys(next).length === Object.keys(computers).length && Object.entries(next).every(([id, state]) => computers[id] === state);
      if (same) return;
      computers = next;
      emit();
    },
    answer(item, action, where) {
      if (pending.has(item.key)) return;
      errors.delete(item.key);
      hidden.add(item.key);
      answered.set(item.key, { key: item.key, summary: summaryOf(item, action), at: new Date(deps.now()).toISOString(), where, kind: item.kind, title: item.title });
      while (answered.size > 200) answered.delete(answered.keys().next().value as string);
      if (action.type === 'dismiss-local') {
        // Nothing to send: remembered on this browser.
        try {
          const gone = [...dismissed(), item.id].slice(-50);
          deps.storage?.setItem(DISMISSED_ALERTS_KEY, JSON.stringify(gone));
        } catch {
          // Hidden for this page only.
        }
        emit();
        return;
      }
      const timer = setTimeout(() => void commit(item.key), deps.undoMs);
      pending.set(item.key, { item, action, timer });
      emit();
    },
    undo(key) {
      const entry = pending.get(key);
      if (!entry) return false;
      clearTimeout(entry.timer);
      pending.delete(key);
      hidden.delete(key);
      answered.delete(key);
      emit();
      return true;
    },
    async flush() {
      await Promise.all([...pending.keys()].map((key) => commit(key)));
    },
  };
}

