/**
 * D83 · Fresh session when the context fills (`docs/fresh-session.md`): the
 * rules and copy shared by the server and the UI. Pure.
 *
 * When a supervised session's context reaches the threshold (Settings → Sessions,
 * default {@link FRESH_OFFER_DEFAULT_PCT} %), a bar above the composer offers
 * **Continue in a fresh session**: the agent writes a handover in one turn, a new
 * session starts in the same folder / worktree / branch on the same CLI, model and
 * account with the handover as its first message, takes the old session's sidebar
 * place, todo list and pin, and the old session is closed (linked both ways).
 */

/** Settings → Sessions: the offer's default threshold (% of the context window). */
export const FRESH_OFFER_DEFAULT_PCT = 80;
/** The threshold's bounds (whole %). */
export const FRESH_OFFER_MIN_PCT = 50;
export const FRESH_OFFER_MAX_PCT = 95;
/** The thresholds the Settings select offers (every 5 %). */
export const FRESH_OFFER_PCT_CHOICES: readonly number[] = Array.from({ length: (FRESH_OFFER_MAX_PCT - FRESH_OFFER_MIN_PCT) / 5 + 1 }, (_, i) => FRESH_OFFER_MIN_PCT + i * 5);

/** **Not now** snoozes the offer until the context grew this many points more. */
export const FRESH_SNOOZE_POINTS = 10;

/** The action (the bar's button, the session's ⋯ menu). */
export const FRESH_ACTION_LABEL = 'Continue in a fresh session';
export const FRESH_CONTINUE = 'Continue';
export const FRESH_NOT_NOW = 'Not now';

/** The bar's text: `Context 82% — Continue in a fresh session`. */
export function freshOfferText(percent: number): string {
  return `Context ${Math.round(percent)}% — ${FRESH_ACTION_LABEL}`;
}

/** The steps a continuation shows (`Session.freshContinue.step`). */
export type FreshStep = 'handover' | 'starting';

/** What the bar says while a continuation runs. */
export function freshStepText(step: FreshStep): string {
  return step === 'handover' ? 'Writing the handover for the fresh session…' : 'Starting the fresh session…';
}

/** Why a hooked terminal session cannot continue in a fresh session (the refusal and the menu's tooltip). */
export const FRESH_HOOKED_REASON =
  "A hooked terminal session runs its own claude in its terminal: Switchboard cannot ask it for a handover or start its next session. Run /clear or start a new session there, or use Continue in Switchboard first.";

/** Why it is refused while a turn runs (the offer comes back once the turn ends). */
export const FRESH_BUSY_REASON = 'A turn is running: wait for it to end, then continue in a fresh session.';

/** The chat dividers (linked to the other session). */
export function continuedFromLabel(title: string): string {
  return `Continued from ${title}`;
}
export function continuedInLabel(title: string): string {
  return `Continued in ${title}`;
}

/** What {@link freshOfferState} reads. */
export interface FreshOfferInput {
  /** Settings → Sessions → *Offer a fresh session when the context fills* (`sessions.freshOffer`). */
  readonly enabled: boolean;
  /** `sessions.freshOfferPct`. */
  readonly thresholdPct: number;
  /** The context meter's percent (`Session.context.percent`), `null` while unknown. */
  readonly percent: number | null;
  /** A hooked terminal session, a closed one, a demo session without a meter: never offered. */
  readonly eligible: boolean;
  /** A turn runs (status `run` / `need`, or live activity): the offer waits for its end. */
  readonly busy: boolean;
  /** The percent at which the developer chose **Not now**, `null` when not snoozed. */
  readonly snoozedAt: number | null;
}

/** `true` when the bar shows: on, eligible, not busy, at or past the threshold, and past a snooze by {@link FRESH_SNOOZE_POINTS}. */
export function freshOfferState(input: FreshOfferInput): boolean {
  if (!input.enabled || !input.eligible || input.busy || input.percent === null) return false;
  if (input.percent < input.thresholdPct) return false;
  return input.snoozedAt === null || input.percent >= input.snoozedAt + FRESH_SNOOZE_POINTS;
}

/**
 * A snooze stored for a session stays until the context drops below the
 * threshold again (a compaction, a fresh start): then it is forgotten, so the
 * next time the context fills the offer shows at the threshold again.
 */
export function keepSnooze(snoozedAt: number | null, percent: number | null, thresholdPct: number): number | null {
  if (snoozedAt === null || percent === null) return snoozedAt;
  return percent < thresholdPct ? null : snoozedAt;
}

/** The longest session title (D22). */
const TITLE_MAX = 80;
/** The longest session name (kebab-case). */
const NAME_MAX = 64;

/**
 * The new session's title: the old title, numbered (`Fix login (2)`); a session
 * that was itself continued counts on (`Fix login (3)`), never `(2) (2)`.
 */
export function freshTitle(oldTitle: string, continued: boolean, n: number): string {
  const base = continued ? oldTitle.replace(/\s\(\d+\)$/, '') : oldTitle;
  const suffix = ` (${n})`;
  return `${base.slice(0, TITLE_MAX - suffix.length).trimEnd()}${suffix}`;
}

/**
 * The new session's name candidate `n` (kebab-case, unique by the caller's
 * loop): `fix-login-2`; a continued session's own `-<n>` is replaced, so a chain
 * reads `fix-login`, `fix-login-2`, `fix-login-3`.
 */
export function freshName(oldName: string, continued: boolean, n: number): string {
  const base = continued ? oldName.replace(/-\d+$/, '') : oldName;
  const suffix = `-${n}`;
  return `${base.slice(0, NAME_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
}

/** The number a continued session's title carries (`Fix login (3)` → 3), else 1. */
export function continuationNumber(title: string, continued: boolean): number {
  if (!continued) return 1;
  const match = /\s\((\d+)\)$/.exec(title);
  return match ? Number(match[1]) : 1;
}
