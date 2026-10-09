/**
 * Loop cards of the Schedules & loops view (SPEC → Schedules & loops: "Two loop
 * cards: iteration strip, 3 facts, note, Open session"; D9, M7.2). Pure: the
 * cards come from `Session.loops` (`GET /api/sessions` + `sessionUpdated`), which
 * the server derives from observed events (`docs/derivations.md` → *Loop cards*).
 * Unknown values show "—"; nothing is made up.
 */
import type { Loop, LoopIterationResult, Session, TerminalLoop } from '../../core/api.ts';
import { terminalStatus } from '../../core/terminal-status.ts';
import { loopNotExpired } from '../../core/derive/loops.ts';
import type { SessionStatus } from '../../core/model.ts';
import { type SessionMachine, offlineReason } from '../../core/peers.ts';
import { displayTitle } from '../../core/session-title.ts';

/** At most this many strip cells (the newest iterations); the prototype shows 12–17. */
export const MAX_STRIP_CELLS = 30;

/** The dash for an unknown value (D9). */
export const UNKNOWN = '—';

/** The prototype's border of a card whose session needs the developer. */
export const NEED_BORDER = 'oklch(0.45 0.08 70)';

/** One fact: mono label + value. */
export interface LoopFact {
  readonly k: string;
  readonly v: string;
}

/** One card as rendered. */
export interface LoopCardModel {
  readonly id: string;
  readonly sessionId: string;
  /** What the card names the session by (D22: its title, else its name). */
  readonly sessionName: string;
  readonly status: SessionStatus;
  /** Session status dot color (CSS). */
  readonly dot: string;
  /** Card border color (CSS): amber while the session needs the developer. */
  readonly border: string;
  /** Subtitle: the loop's label, else its kind. */
  readonly kind: string;
  readonly cells: readonly LoopIterationResult[];
  readonly facts: readonly [LoopFact, LoopFact, LoopFact];
  readonly note: string | null;
  /** D52: the paired machine the loop runs on (its tag); `null` on this machine. */
  readonly machine: SessionMachine | null;
  /**
   * D52: a loop of a terminal session Switchboard does not follow: its claude
   * session id (the card offers "Hook into…" instead of "Open session"); `null`
   * for a session's loop.
   */
  readonly terminalId: string | null;
  /** D52: why the card's action cannot be used now (the machine is offline); `null` when it can. */
  readonly blocked: string | null;
}

/** D52: why a terminal loop's card has no "Open session". */
export const TERMINAL_LOOP_NOTE = 'A terminal session Switchboard does not follow: read from its transcript. Hook into it to open it.';

const STATUS_VAR: Record<SessionStatus, string> = {
  need: 'var(--status-need)',
  run: 'var(--status-run)',
  done: 'var(--status-done)',
  fail: 'var(--status-fail)',
  idle: 'var(--status-idle)',
  paused: 'var(--status-idle)',
};

/** Strip cell colors (the prototype's `rs()` map: g done, r fail, a need, b run, n none). */
export const CELL_COLOR: Record<LoopIterationResult, string> = {
  ok: 'var(--status-done)',
  fail: 'var(--status-fail)',
  need: 'var(--status-need)',
  run: 'var(--status-run)',
  none: 'var(--status-none)',
};

/** Strip cells: the newest {@link MAX_STRIP_CELLS} iterations, padded with empty cells up to a known cap. */
export function stripCells(loop: Pick<Loop, 'iterations' | 'cap'>): LoopIterationResult[] {
  const cells = loop.iterations.map((it) => it.result);
  if (loop.cap !== null && loop.cap > cells.length) {
    while (cells.length < Math.min(loop.cap, MAX_STRIP_CELLS)) cells.push('none');
  }
  return cells.slice(-MAX_STRIP_CELLS);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function two(n: number): string {
  return String(n).padStart(2, '0');
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** A next firing: `15:00` today, `tomorrow 02:00`, `Mon 07:00` within a week, else `10-05 15:00` (local time). */
export function formatNextFire(iso: string | null, now: Date): string {
  if (iso === null) return UNKNOWN;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return UNKNOWN;
  const clock = `${two(at.getHours())}:${two(at.getMinutes())}`;
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (days === 0) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[at.getDay()]} ${clock}`;
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${clock}`;
}

/** An expiry relative to now: `in 6 days`, `in 1 day`, `in 5 h`, `in 12 min`, `expired`. */
export function formatExpiry(iso: string | null, now: Date): string {
  if (iso === null) return UNKNOWN;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return UNKNOWN;
  // One minute of slack, so a job that expires in 7 days reads "in 7 days" right after it was made.
  const left = at - now.getTime() + 60_000;
  if (at <= now.getTime()) return 'expired';
  const days = Math.floor(left / 86_400_000);
  if (days >= 1) return `in ${days} ${days === 1 ? 'day' : 'days'}`;
  const hours = Math.floor(left / 3_600_000);
  if (hours >= 1) return `in ${hours} h`;
  return `in ${Math.max(1, Math.floor(left / 60_000))} min`;
}

/** The breaker fact: `tripped (2)` with a known state, `2 in a row` with a count only, else "—". */
export function formatBreaker(loop: Pick<Loop, 'breakerCount' | 'breakerState'>): string {
  if (loop.breakerState && loop.breakerCount !== null) return `${loop.breakerState} (${loop.breakerCount})`;
  if (loop.breakerState) return loop.breakerState;
  if (loop.breakerCount !== null) return `${loop.breakerCount} in a row`;
  return UNKNOWN;
}

/** The three facts: Iteration / cap · Next / expires · Breaker. */
export function loopFacts(loop: Loop, now: Date): readonly [LoopFact, LoopFact, LoopFact] {
  const value = (n: number | null): string => (n === null ? UNKNOWN : String(n));
  return [
    { k: 'Iteration / cap', v: `${value(loop.iteration)} / ${value(loop.cap)}` },
    { k: 'Next / expires', v: `${formatNextFire(loop.nextFireAt, now)} / ${formatExpiry(loop.expiresAt, now)}` },
    { k: 'Breaker', v: formatBreaker(loop) },
  ];
}

/**
 * One card per loop of every session, in the order the loops started (oldest
 * first); loops that started at the same moment follow their sessions' start,
 * then the server's order.
 */
export function loopCards(sessions: readonly Session[], now: Date, terminalLoops: readonly TerminalLoop[] = []): LoopCardModel[] {
  const cards: Array<LoopCardModel & { readonly createdAt: string; readonly sessionCreatedAt: string; readonly index: number }> = [];
  for (const session of sessions) {
    for (const loop of session.loops ?? []) {
      // D93: a page left open past a loop's expiry drops its card (the row goes at the next refresh).
      if (!loopNotExpired(loop, now)) continue;
      cards.push({
        index: cards.length,
        sessionCreatedAt: session.createdAt,
        id: loop.id,
        sessionId: session.id,
        sessionName: displayTitle(session),
        status: session.status,
        dot: STATUS_VAR[session.status],
        border: session.status === 'need' ? NEED_BORDER : 'var(--border-card)',
        kind: loop.label?.trim() || loop.kind,
        cells: stripCells(loop),
        facts: loopFacts(loop, now),
        note: loop.note?.trim() || null,
        createdAt: loop.createdAt,
        machine: session.machine ?? null,
        terminalId: null,
        // "Open session" of a peer's session works offline too: it opens on the last known snapshot (D48).
        blocked: null,
      });
    }
  }
  // D52: loops of terminal sessions Switchboard does not follow (this machine's and the paired machines').
  for (const entry of terminalLoops) {
    const loop = entry.loop;
    if (!loopNotExpired(loop, now)) continue;
    const status = terminalStatus(entry.terminal.status);
    cards.push({
      index: cards.length,
      sessionCreatedAt: entry.terminal.startedAt ?? loop.createdAt,
      id: loop.id,
      sessionId: entry.terminal.id,
      sessionName: entry.terminal.name?.trim() || `Terminal · ${baseName(entry.terminal.cwd) || 'session'}`,
      status,
      dot: STATUS_VAR[status],
      border: status === 'need' ? NEED_BORDER : 'var(--border-card)',
      kind: loop.label?.trim() || loop.kind,
      cells: stripCells(loop),
      facts: loopFacts(loop, now),
      note: loop.note?.trim() || null,
      createdAt: loop.createdAt,
      machine: entry.machine ?? null,
      terminalId: entry.terminal.id,
      blocked: offlineReason(entry.machine),
    });
  }
  cards.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sessionCreatedAt.localeCompare(b.sessionCreatedAt) || a.index - b.index);
  return cards.map(({ createdAt: _createdAt, sessionCreatedAt: _sessionCreatedAt, index: _index, ...card }) => card);
}

/** The last part of a path (either separator). */
function baseName(folder: string | null): string {
  return (folder ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}
