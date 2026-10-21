/**
 * D124 (`docs/derivations.md` → *Session status* → *Waiting for you at a turn's end*):
 * whether a session whose turn is over is **done** or **waits for the developer**
 * (an answer, a decision, an action), from two signals:
 *
 * 1. the agent's own declaration, the `switchboard` MCP tool `turn_status`
 *    (`done` / `waiting_for_you` / `blocked`, with a one-line `ask`), and
 * 2. a conservative **text check** of the turn's last assistant text
 *    ({@link detectWaiting}) for turns that end without a declaration (a CLI
 *    without the tool, an agent that forgot it).
 *
 * The declaration always wins over the text check, both ways. No model call is
 * made (developer ruling 2026-10-21: options 1 + 2, no AI classifier). Pure: the
 * server keeps the inputs (`src/server/sessions/turn-status.ts`), this decides.
 */
import type { SessionStatus } from '../model.ts';

/** What the agent declares about the turn it ends (`turn_status`'s `status`). */
export const TURN_STATUSES = ['done', 'waiting_for_you', 'blocked'] as const;

/** One of {@link TURN_STATUSES}. */
export type TurnStatus = (typeof TURN_STATUSES)[number];

/** The longest `ask` the tool takes (characters). */
export const TURN_ASK_MAX = 300;

/** The longest ask the text check derives (characters). */
export const DETECTED_ASK_MAX = 200;

/** The text check reads only this many characters at the end of the turn's last text. */
export const TEXT_CHECK_WINDOW = 600;

/** `true` for one of {@link TURN_STATUSES}. */
export function isTurnStatus(value: unknown): value is TurnStatus {
  return typeof value === 'string' && (TURN_STATUSES as readonly string[]).includes(value);
}

/**
 * Additive (D124): how a session's last turn ended, as stored (`sessions.turn_wait`) and sent
 * (`Session.turnWait`). Cleared when a new turn starts (the developer's message, any turn the
 * CLI starts), by the session's **Not waiting** and by a Dismiss of its Inbox item.
 */
export interface TurnWait {
  /** `done` is kept only when declared (it beats the text check of the same turn). */
  readonly status: TurnStatus;
  /** What the developer must do or answer (one line); `null` for `done`. */
  readonly ask: string | null;
  /** `declared` = the agent's `turn_status`; `detected` = the text check (shown with a subtle "detected" hint). */
  readonly source: 'declared' | 'detected';
  /** When it was declared or detected (ISO); one needs-you episode per value. */
  readonly at: string;
}

/** `true` when the turn waits for the developer (`waiting_for_you` / `blocked`). */
export function turnWaits(wait: TurnWait | null | undefined): wait is TurnWait & { readonly status: 'waiting_for_you' | 'blocked' } {
  return wait !== null && wait !== undefined && (wait.status === 'waiting_for_you' || wait.status === 'blocked');
}

/**
 * The status a session reads (D124): its derived status, except that a session whose turn is over
 * and that is **not working** (`done`, `idle` or `paused`; 1.23: a subagent, a GitHub wait or
 * counted background work keeps `run`, which wins) and whose turn waits for the developer
 * ({@link turnWaits}) reads `need`. A failed turn stays `fail`; a closed session is never `need`.
 */
export function effectiveSessionStatus(status: SessionStatus, wait: TurnWait | null | undefined, closed = false): SessionStatus {
  if (closed || !turnWaits(wait)) return status;
  return status === 'done' || status === 'idle' || status === 'paused' ? 'need' : status;
}

/** How a turn ended, for {@link turnEndWait}. */
export interface TurnEndInput {
  /** The declaration made during this turn (`turn_status`), else `null`. */
  readonly declared: TurnWait | null;
  /** The turn's last assistant text (the `result`'s text), `null` when none. */
  readonly text: string | null;
  /** `success` only is text-checked (an error or a stop the developer made is no question). */
  readonly outcome: 'success' | 'error' | 'stopped';
  /** Now (ISO): the `at` of a detected wait. */
  readonly at: string;
}

/**
 * What a turn's end leaves on the session: the declaration when there is one (it wins both ways:
 * a declared `done` keeps a question-like text from reading as waiting), else the text check's
 * `waiting_for_you` (`source: detected`), else `null` (done).
 */
export function turnEndWait(input: TurnEndInput): TurnWait | null {
  if (input.declared) return input.declared;
  if (input.outcome !== 'success') return null;
  const detected = detectWaiting(input.text);
  return detected ? { status: 'waiting_for_you', ask: detected.ask, source: 'detected', at: input.at } : null;
}

// ── the text check ──────────────────────────────────────────────────────

/** Phrases that ask the developer for something (whole words, case-insensitive). */
const WAITING_PHRASES: readonly RegExp[] = [
  /\blet me know\b/i,
  /\bshall i\b/i,
  /\bshould i\b/i,
  /\bdo you want\b/i,
  /\bwould you like\b/i,
  /\bwant me to\b/i,
  /\byour call\b/i,
  /\bup to you\b/i,
  /\bwaiting (?:for|on) you\b/i,
  /\bawaiting your\b/i,
  /\bneed you to\b/i,
  /\bneed your\b/i,
  /\bquestions? (?:is |are )?(?:still )?open\b/i,
  /\bopen questions?\b/i,
  /\bcan you confirm\b/i,
  /\bplease confirm\b/i,
  /\btell me\b/i,
  /\bwhich (?:one )?(?:do|would) you prefer\b/i,
  /\bonce you\b/i,
];

/** A "You:" item addressed to the developer ("You: publish workspace 42."), capital Y as a list label. */
const YOU_ITEM = /(?:^|[\s:;(•*\-–])\**You\**\s*:\**\s+\S/m;

/** Phrases that say nothing is left for the developer (they lower a phrase or "You:" match). */
const DONE_GUARDS: readonly RegExp[] = [
  /\bno (?:further )?(?:action|input|changes?) (?:is |are )?(?:needed|required)\b/i,
  /\bnothing (?:else )?(?:is )?(?:left|needed|pending|required|to do)\b/i,
  /\bnothing (?:more )?(?:for you )?to do\b/i,
  /\bnothing (?:is )?waiting (?:for|on) you\b/i,
  /\byou don'?t need to do anything\b/i,
  /\ball done\b/i,
  /\bthat'?s it\b/i,
  /\bdone\.?\s*$/i,
];

/** Polite closers of a finished summary: dropped before the check ("Let me know if you need anything else."). */
const POLITE_CLOSERS: readonly RegExp[] = [
  /^(?:please )?let me know if (?:you )?(?:need|want|have|would like|'d like) anything else[^.!?]*[.!]?$/i,
  /^(?:please )?let me know if you have (?:any )?(?:other |more |further )?questions[^.!?]*[.!]?$/i,
  /^if you have (?:any )?(?:other |more |further )?questions[^.!?]*[.!]?$/i,
  /^(?:is there )?anything else(?: (?:i can|you'?d like|you want)[^?]*)?\?$/i,
  /^happy to help[^.!?]*[.!]?$/i,
];

/** Markdown and list noise around a line's words. */
function plain(line: string): string {
  return line
    .replace(/^\s*(?:[-*+•]|\d+[.)]|#{1,6}|>)\s+/, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The text without code blocks, inline code's question marks and URLs (a `?` there asks nothing). */
function withoutCode(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, '\n')
    .replace(/`([^`\n]*)`/g, (_match, inner: string) => inner.replace(/\?/g, ''))
    .replace(/\bhttps?:\/\/\S+/g, 'the link');
}

/** A line's sentences (split after `.`, `!`, `?` or `…` followed by a space). */
function sentencesOf(line: string): string[] {
  return line
    .split(/(?<=[.!?…])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

/** A sentence that is a question: it ends with `?` (closing quotes, brackets or emphasis allowed). */
function isQuestion(sentence: string): boolean {
  return /\?["'”’)\]*_]*$/.test(sentence);
}

function cut(text: string, max: number): string {
  const folded = text.replace(/\s+/g, ' ').trim();
  return folded.length > max ? `${folded.slice(0, max - 1).trimEnd()}…` : folded;
}

/**
 * D124 · the text check: does a turn's last assistant text wait for the developer? Conservative
 * rules on its last {@link TEXT_CHECK_WINDOW} characters (code blocks, inline code's `?` and URLs
 * ignored; polite closers such as "Let me know if you need anything else." dropped first):
 *
 * - **waiting** when its final sentence is a question (it ends with `?`), whatever else it says;
 * - else **done** when a done guard is there ("no action needed", "nothing left", "all done",
 *   ending on "done.");
 * - else **waiting** on an asking phrase ("let me know", "shall I", "should I", "do you want",
 *   "would you like", "your call", "waiting for you", "need you to", "need your", "questions are
 *   still open", "open question", "can you confirm", "please confirm", "tell me", "which do you
 *   prefer", "once you", …) or a "You:" item addressed to the developer;
 * - else **done**.
 *
 * @returns the ask when waiting (the last question sentence, else the last sentence, without
 * Markdown, cut to {@link DETECTED_ASK_MAX} characters), `null` when done or there is no text.
 */
export function detectWaiting(text: string | null | undefined): { readonly ask: string } | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const cleaned = withoutCode(text);
  const tail = cleaned.length > TEXT_CHECK_WINDOW ? cleaned.slice(-TEXT_CHECK_WINDOW) : cleaned;
  const sentences = tail
    .split('\n')
    .map(plain)
    .filter((line) => line !== '')
    .flatMap(sentencesOf)
    .filter((sentence) => !POLITE_CLOSERS.some((closer) => closer.test(sentence)));
  if (sentences.length === 0) return null;
  const body = sentences.join(' ');
  const last = sentences[sentences.length - 1] as string;
  const askOf = (): string => {
    const question = [...sentences].reverse().find(isQuestion);
    return cut(question ?? last, DETECTED_ASK_MAX);
  };
  if (isQuestion(last)) return { ask: cut(last, DETECTED_ASK_MAX) };
  if (DONE_GUARDS.some((guard) => guard.test(body))) return null;
  if (WAITING_PHRASES.some((phrase) => phrase.test(body)) || YOU_ITEM.test(sentences.join('\n'))) return { ask: askOf() };
  return null;
}
