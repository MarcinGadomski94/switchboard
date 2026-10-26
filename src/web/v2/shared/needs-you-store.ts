import type { InboxItem, SystemInfo } from '../../../core/api.ts';
import type { MemoryEntry } from '../../../core/memory.ts';
// Project memory (D107) hook (docs/memory-removal.md): the imports above.
import type { MachineState } from '../../../core/peers.ts';
import type { TeamNeedsYouItem } from '../../../core/team.ts';
import { usageGridLines } from '../../shell/format.ts';
import type { AnsweredWhere } from '../glossary.ts';
import { type AnswerAction, type AnsweredInfo, summaryOf } from './answer-model.ts';
import { type NeedsItem, type UsageAlert, memoryScopeOf, mergeNeedsYou } from './needs-you-model.ts';
import { usageWarningAlerts } from './usage-warning-model.ts';

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
 * - **The transient answered line** (fix after 2.0): an answered item's compact line
 *   outside the chat's history (the card at a chat's end) shows for
 *   {@link ANSWERED_LINE_MS}, or until its Undo window ends when that is later, then
 *   leaves ({@link ANSWERED_FADE_MS} fade, none with reduced motion) and stays gone
 *   for that answer (`settled`, keyed by item key + answer time) even while the
 *   server still lists the item; forgotten with the answer itself.
 *
 * The factory ({@link createNeedsYouStore}) takes its I/O, so the merge, the hiding
 * and the undo are unit-tested without a browser.
 */

/** How long an answer can be taken back before it is sent (ms). */
export const UNDO_WINDOW_MS = 5_000;

/** How long an answered item's transient compact line shows (ms; at least until its Undo window ends). */
export const ANSWERED_LINE_MS = 4_000;

/** How long the transient compact line takes to fade out and collapse (ms; 0 with reduced motion). */
export const ANSWERED_FADE_MS = 240;

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
  /** How long the transient answered line shows; {@link ANSWERED_LINE_MS} when absent. */
  readonly lineMs?: number;
  /** How long it fades; {@link ANSWERED_FADE_MS} when absent. */
  readonly fadeMs?: number;
  /** `true` when the developer asked for reduced motion: the line goes without a fade. */
  readonly reducedMotion?: () => boolean;
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
  /** Item keys whose transient answered line is fading out now. */
  readonly leaving: ReadonlySet<string>;
  /** Item keys whose transient answered line is gone (for their current answer). */
  readonly settled: ReadonlySet<string>;
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

const EMPTY: NeedsYouSnapshot = { items: [], loaded: false, error: null, answered: new Map(), pending: new Set(), errors: new Map(), leaving: new Set(), settled: new Set() };

/**
 * The usage alerts of a `GET /api/system` reading: an account out of usage, or
 * paying from paid extra usage, and (fix after 2.0) each Max usage warning in
 * force ("Usage warning", `usage-warning-model.ts`).
 */
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
  out.push(...usageWarningAlerts(system, now));
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
  const lineMs = deps.lineMs ?? ANSWERED_LINE_MS;
  const fadeMs = deps.fadeMs ?? ANSWERED_FADE_MS;
  /** The transient line's timers, by item key. */
  const lineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Keys whose line's time is up but whose answer still waits out its Undo window. */
  const lineDue = new Set<string>();
  /** Fading lines and gone lines: item key → the answer time they belong to. */
  const leaving = new Map<string, string>();
  const settled = new Map<string, string>();
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
    const current = (marks: ReadonlyMap<string, string>): Set<string> => new Set([...marks].filter(([key, at]) => answered.get(key)?.at === at).map(([key]) => key));
    snapshot = { items, loaded, error, answered: new Map(answered), pending: new Set(pending.keys()), errors: new Map(errors), leaving: current(leaving), settled: current(settled) };
    for (const listener of listeners) listener();
  };

  /** Stops `key`'s transient line timers. */
  const stopLine = (key: string): void => {
    const timer = lineTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    lineTimers.delete(key);
    lineDue.delete(key);
  };
  /** The line of answer `at` leaves: a fade, then gone (at once with reduced motion). */
  const settle = (key: string, at: string): void => {
    stopLine(key);
    if (answered.get(key)?.at !== at) return;
    if (fadeMs <= 0 || deps.reducedMotion?.()) {
      settled.set(key, at);
    } else {
      leaving.set(key, at);
      lineTimers.set(
        key,
        setTimeout(() => {
          lineTimers.delete(key);
          leaving.delete(key);
          if (answered.get(key)?.at === at) settled.set(key, at);
          emit();
        }, fadeMs),
      );
    }
    while (settled.size > 200) settled.delete(settled.keys().next().value as string);
    emit();
  };
  /** Starts the line of answer `at`: it shows {@link lineMs}, and never leaves while its Undo window is open. */
  const startLine = (key: string, at: string): void => {
    stopLine(key);
    leaving.delete(key);
    settled.delete(key);
    lineTimers.set(
      key,
      setTimeout(() => {
        lineTimers.delete(key);
        if (pending.has(key)) lineDue.add(key);
        else settle(key, at);
      }, lineMs),
    );
  };

  /** Forgets a hidden key once the server no longer lists it (sent and gone). */
  const prune = (): void => {
    const listed = new Set(mergeNeedsYou({ inbox, team, notes, usage: [], computers }).map((item) => item.key));
    for (const key of hidden) if (!pending.has(key) && !listed.has(key) && !key.startsWith('usage:')) hidden.delete(key);
    // A gone line's record lives as long as its answer (`answered`, the newest 200): it only ever hides that answer's
    // line, so an item the server lists again (or a new answer) shows normally (`AnswerSlot` prefers a live item).
    for (const key of settled.keys()) if (!answered.has(key)) settled.delete(key);
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
    // Team is always on (D132); a failed read only means no crew items this time.
    team = teamResult.status === 'fulfilled' ? teamResult.value : [];
    prune();
    emit();
  };

  const commit = async (key: string): Promise<void> => {
    const entry = pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(key);
    // The Undo window is over: a line whose time is already up leaves now.
    const at = answered.get(key)?.at;
    if (lineDue.has(key) && at) settle(key, at);
    try {
      await deps.send(entry.item, entry.action);
    } catch (caught) {
      hidden.delete(key);
      answered.delete(key);
      stopLine(key);
      leaving.delete(key);
      settled.delete(key);
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
      const at = new Date(deps.now()).toISOString();
      answered.delete(item.key);
      answered.set(item.key, { key: item.key, summary: summaryOf(item, action), at, where, kind: item.kind, title: item.title });
      while (answered.size > 200) answered.delete(answered.keys().next().value as string);
      startLine(item.key, at);
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
      stopLine(key);
      leaving.delete(key);
      settled.delete(key);
      emit();
      return true;
    },
    async flush() {
      await Promise.all([...pending.keys()].map((key) => commit(key)));
    },
  };
}

