import type { Session } from '../../../core/api.ts';
import { FRESH_BUSY_REASON, FRESH_HOOKED_REASON } from '../../../core/fresh-session.ts';
import { isClosed } from '../../../core/session-close.ts';
import { turnBusy } from './needs-you.ts';

/**
 * D83 · the fresh-session offer above the composer (`docs/fresh-session.md`): which
 * sessions get it, and the **Not now** snoozes this browser remembers. Pure, for
 * the unit tests (storage is passed in).
 */

/** `localStorage` key of the snoozes (session id → the percent at **Not now**). */
export const FRESH_SNOOZE_KEY = 'switchboard.freshSnoozes';

/** At most this many snoozes are kept (the newest). */
const MAX_SNOOZES = 50;

/** The minimal storage this needs (`window.localStorage`; tests pass a map). */
export interface SnoozeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function readAll(storage: SnoozeStorage | null): Record<string, number> {
  try {
    const raw = storage?.getItem(FRESH_SNOOZE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  } catch {
    return {};
  }
}

/** The percent the session's offer was snoozed at, `null` when it was not. */
export function loadSnooze(storage: SnoozeStorage | null, sessionId: string): number | null {
  return readAll(storage)[sessionId] ?? null;
}

/** Remembers (a number) or forgets (`null`) the session's snooze. */
export function saveSnooze(storage: SnoozeStorage | null, sessionId: string, percent: number | null): void {
  const all = readAll(storage);
  delete all[sessionId];
  if (percent !== null) all[sessionId] = percent;
  const kept = Object.entries(all).slice(-MAX_SNOOZES);
  try {
    storage?.setItem(FRESH_SNOOZE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage blocked: the snooze lasts this page only.
  }
}

/**
 * A session that can be continued in a fresh one: Switchboard runs it (not a hooked
 * terminal session), it is open, attached, has a context meter, and no switch or
 * take-over is under way.
 */
export function freshEligible(session: Pick<Session, 'hooked' | 'closedAt' | 'attached' | 'context' | 'providerSwitch' | 'accountSwitching' | 'movedTo'> | null): boolean {
  if (!session) return false;
  if (session.hooked === true || isClosed(session) || session.attached === false || session.movedTo) return false;
  if (!session.context) return false;
  return !session.providerSwitch && session.accountSwitching !== true;
}

/**
 * A turn runs (or waits for the developer): the offer waits for its end. A live
 * activity counts unless it is only `background` (D30: the turn is over and the
 * agent left tasks running, e.g. a dev server or a watcher). Background work the
 * session waits on keeps its status `run`, which counts already; the rest never
 * ends a turn, so it must not hold the offer back for good (Fixes after 2.0, the
 * v2 clean slate). The route refuses on the same terms (`continueFresh`).
 */
export function freshBusy(session: Pick<Session, 'status' | 'turnWait'> | null, activity: { readonly state: string } | null | undefined): boolean {
  return session !== null && (turnBusy(session) || (activity !== null && activity !== undefined && activity.state !== 'background'));
}

/**
 * A session's ⋯ menu (the sidebar row's): **Continue in a fresh session** at any
 * percent. Not shown for a closed or moved session; shown disabled, with why, for
 * a hooked terminal session, while a turn runs, or while a switch or continuation runs.
 */
export function freshActionState(
  session: Pick<Session, 'hooked' | 'closedAt' | 'attached' | 'status' | 'turnWait' | 'providerSwitch' | 'accountSwitching' | 'movedTo' | 'freshContinue'>,
): { readonly shown: boolean; readonly disabledReason: string | null } {
  if (isClosed(session) || session.movedTo) return { shown: false, disabledReason: null };
  if (session.hooked === true) return { shown: true, disabledReason: FRESH_HOOKED_REASON };
  if (session.attached === false) return { shown: true, disabledReason: 'The session continues in a terminal: attach it here first.' };
  if (session.freshContinue) return { shown: true, disabledReason: 'Already continuing in a fresh session.' };
  if (session.providerSwitch || session.accountSwitching === true) return { shown: true, disabledReason: 'A switch is running: wait for it to finish.' };
  if (turnBusy(session)) return { shown: true, disabledReason: FRESH_BUSY_REASON };
  return { shown: true, disabledReason: null };
}

/** The sessions this tab asked to continue (the bar or a ⋯ menu): their view opens the fresh session once it exists. */
const asked = new Set<string>();

/** Remembers that this tab asked for `sessionId`'s continuation. */
export function markFreshAsked(sessionId: string): void {
  asked.add(sessionId);
}

/** Forgets it (a refusal, or once followed); answers whether it was asked. */
export function takeFreshAsked(sessionId: string): boolean {
  return asked.delete(sessionId);
}

/** `true` while this tab waits for `sessionId`'s fresh session. */
export function freshAsked(sessionId: string): boolean {
  return asked.has(sessionId);
}
