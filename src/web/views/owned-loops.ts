/**
 * D94 (`docs/loops.md`): the Switchboard loops' cards (Schedules & loops, the
 * session's loop strip) and the New loop… / Edit form. Pure: the cards come from
 * `Session.ownedLoops` (`GET /api/sessions` + `sessionUpdated`).
 */
import type { OwnedLoop, OwnedLoopInput, Session, SessionListItem } from '../../core/api.ts';
import { parseCron } from '../../core/cron.ts';
import { LOOP_EVERY_MAX, LOOP_LABEL_MAX, LOOP_MAX_RUNS_MAX, LOOP_PROMPT_MAX, loopStateText } from '../../core/owned-loops.ts';
import type { SessionStatus } from '../../core/model.ts';
import type { SessionMachine } from '../../core/peers.ts';
import { displayTitle } from '../../core/session-title.ts';
import { NEED_BORDER, UNKNOWN, formatExpiry, formatNextFire } from './loops.ts';

/** The line on a CLI-native (derived) card: Switchboard only observes those. */
export const CLI_MANAGED_NOTE = 'Managed by the CLI';

/** The empty value of the Expires fact. */
export const NO_EXPIRY = 'no expiry';

const STATUS_VAR: Record<SessionStatus, string> = {
  need: 'var(--status-need)',
  run: 'var(--status-run)',
  done: 'var(--status-done)',
  fail: 'var(--status-fail)',
  idle: 'var(--status-idle)',
  paused: 'var(--status-idle)',
};

/** One fact of a Switchboard loop card. */
export interface OwnedLoopFact {
  readonly k: string;
  readonly v: string;
  /** The exact time behind a relative value (a tooltip). */
  readonly title?: string;
}

/** A Switchboard loop's card as rendered. */
export interface OwnedLoopCardModel {
  readonly id: string;
  readonly sessionId: string;
  readonly sessionName: string;
  readonly status: SessionStatus;
  readonly dot: string;
  readonly border: string;
  readonly title: string;
  /** The prompt's first line. */
  readonly promptLine: string;
  readonly facts: readonly OwnedLoopFact[];
  readonly state: OwnedLoop['state'];
  /** `active`, `paused`, `ended: <reason>`. */
  readonly stateText: string;
  /** Why the last due time was skipped, when it was. */
  readonly lastError: string | null;
  readonly machine: SessionMachine | null;
  /** The session is closed (no actions but Cancel). */
  readonly closed: boolean;
  readonly loop: OwnedLoop;
}

/** The prompt's first non-empty line. */
export function promptLine(prompt: string): string {
  return prompt.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? '';
}

/** Runs: `12`, `12 of 20`, plus `(3 skipped)`. */
export function runsText(loop: Pick<OwnedLoop, 'runs' | 'maxRuns' | 'skipped'>): string {
  return `${loop.runs}${loop.maxRuns !== null ? ` of ${loop.maxRuns}` : ''}${loop.skipped > 0 ? ` (${loop.skipped} skipped)` : ''}`;
}

/** The card's facts: Schedule · Next · Expires · Runs. */
export function ownedLoopFacts(loop: OwnedLoop, now: Date): OwnedLoopFact[] {
  const exact = (iso: string | null): string | undefined => (iso ? new Date(iso).toLocaleString() : undefined);
  const next = loop.state === 'active' ? formatNextFire(loop.nextFireAt, now) : loop.state === 'paused' ? 'paused' : UNKNOWN;
  const nextTitle = exact(loop.nextFireAt);
  const expiresTitle = exact(loop.expiresAt);
  return [
    { k: 'Schedule', v: loop.scheduleText },
    { k: 'Next', v: next, ...(nextTitle ? { title: nextTitle } : {}) },
    { k: 'Expires', v: loop.expiresAt === null ? NO_EXPIRY : formatExpiry(loop.expiresAt, now), ...(expiresTitle ? { title: expiresTitle } : {}) },
    { k: 'Runs', v: runsText(loop) },
  ];
}

/** One card per Switchboard loop of every session that has not ended, oldest first. */
export function ownedLoopCards(sessions: readonly SessionListItem[], now: Date, options: { readonly includeEnded?: boolean } = {}): OwnedLoopCardModel[] {
  const cards: OwnedLoopCardModel[] = [];
  for (const session of sessions) {
    for (const loop of session.ownedLoops ?? []) {
      if (loop.state === 'ended' && options.includeEnded !== true) continue;
      cards.push(ownedLoopCard(session, loop, now));
    }
  }
  return cards.sort((a, b) => a.loop.createdAt.localeCompare(b.loop.createdAt));
}

/** One Switchboard loop's card. */
export function ownedLoopCard(session: SessionListItem, loop: OwnedLoop, now: Date): OwnedLoopCardModel {
  return {
    id: loop.id,
    sessionId: session.id,
    sessionName: displayTitle(session),
    status: session.status,
    dot: STATUS_VAR[session.status],
    border: session.status === 'need' ? NEED_BORDER : 'var(--border-card)',
    title: loop.title,
    promptLine: promptLine(loop.prompt),
    facts: ownedLoopFacts(loop, now),
    state: loop.state,
    stateText: loopStateText(loop),
    lastError: loop.lastError,
    machine: session.machine ?? null,
    closed: session.closedAt != null,
    loop,
  };
}

// ── the New loop… / Edit form ───────────────────────────────────────────

/** The schedule kinds of the form. */
export type LoopDraftKind = 'every' | 'cron' | 'at';

/** The form's fields (as typed). */
export interface LoopDraft {
  readonly prompt: string;
  readonly kind: LoopDraftKind;
  /** Minutes (text). */
  readonly every: string;
  readonly cron: string;
  /** `datetime-local` value (local time, `2026-10-09T15:00`). */
  readonly at: string;
  /** `datetime-local` value; `''` = no expiry. */
  readonly expires: string;
  /** `''` = no limit. */
  readonly maxRuns: string;
  readonly label: string;
}

/** A new loop's form: every 30 minutes, no expiry, no run limit. */
export const EMPTY_LOOP_DRAFT: LoopDraft = { prompt: '', kind: 'every', every: '30', cron: '', at: '', expires: '', maxRuns: '', label: '' };

const pad = (value: number): string => String(value).padStart(2, '0');

/** An ISO time as a `datetime-local` value (local time). */
export function localInput(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A loop as the Edit form starts. */
export function draftFromLoop(loop: OwnedLoop): LoopDraft {
  return {
    prompt: loop.prompt,
    kind: loop.schedule.kind,
    every: loop.schedule.kind === 'every' ? String(loop.schedule.minutes) : '30',
    cron: loop.schedule.kind === 'cron' ? loop.schedule.cron : '',
    at: loop.schedule.kind === 'at' ? localInput(loop.schedule.at) : '',
    expires: localInput(loop.expiresAt),
    maxRuns: loop.maxRuns === null ? '' : String(loop.maxRuns),
    label: loop.label ?? '',
  };
}

/** Result of {@link draftInput}. */
export type LoopDraftCheck = { readonly ok: true; readonly input: OwnedLoopInput } | { readonly ok: false; readonly error: string };

function localIso(value: string): string | null {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * The form as the API's `OwnedLoopInput` (the server checks again), or the first
 * problem in words. An Edit sends every field (unchanged ones change nothing;
 * an emptied expiry or run limit removes it).
 */
export function draftInput(draft: LoopDraft, now: Date): LoopDraftCheck {
  const prompt = draft.prompt.trim();
  if (prompt === '') return { ok: false, error: 'Write the prompt Switchboard sends at each firing.' };
  if (prompt.length > LOOP_PROMPT_MAX) return { ok: false, error: `The prompt is at most ${LOOP_PROMPT_MAX} characters.` };
  let schedule: Pick<OwnedLoopInput, 'cron' | 'everyMinutes' | 'at'>;
  if (draft.kind === 'every') {
    const minutes = Number(draft.every);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > LOOP_EVERY_MAX) return { ok: false, error: `Every: a whole number of minutes, 1–${LOOP_EVERY_MAX}.` };
    schedule = { everyMinutes: minutes };
  } else if (draft.kind === 'cron') {
    const parsed = parseCron(draft.cron);
    if (!parsed.ok) return { ok: false, error: `Cron: ${parsed.error}` };
    schedule = { cron: parsed.cron.expression };
  } else {
    const at = localIso(draft.at);
    if (at === null) return { ok: false, error: 'Once at: pick a date and time.' };
    if (Date.parse(at) <= now.getTime()) return { ok: false, error: 'Once at: pick a time in the future.' };
    schedule = { at };
  }
  let expiresAt: string | null = null;
  if (draft.expires.trim() !== '') {
    expiresAt = localIso(draft.expires);
    if (expiresAt === null) return { ok: false, error: 'Expires: pick a date and time, or leave it empty for no expiry.' };
    if (Date.parse(expiresAt) <= now.getTime()) return { ok: false, error: 'Expires: pick a time in the future, or leave it empty for no expiry.' };
  }
  let maxRuns: number | null = null;
  if (draft.maxRuns.trim() !== '') {
    maxRuns = Number(draft.maxRuns);
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > LOOP_MAX_RUNS_MAX) return { ok: false, error: `Max runs: a whole number, 1–${LOOP_MAX_RUNS_MAX}, or empty for no limit.` };
  }
  const label = draft.label.trim();
  if (label.length > LOOP_LABEL_MAX) return { ok: false, error: `The label is at most ${LOOP_LABEL_MAX} characters.` };
  return { ok: true, input: { prompt, ...schedule, expiresAt, maxRuns, label: label === '' ? null : label } };
}

/** A loop action's refusal in words (the API's `message`, else the status). */
export function loopRefusal(status: number, body: unknown): string {
  const message = body !== null && typeof body === 'object' ? (body as { message?: unknown }).message : undefined;
  if (typeof message === 'string' && message !== '') return message;
  return status === 0 ? 'Switchboard is not reachable.' : `HTTP ${status}`;
}
