import type { Session } from './api.ts';
import { offlineReason } from './peers.ts';

/**
 * D72 "Continue in Switchboard" for hooked sessions (`docs/peers.md` →
 * *Continuing a hooked session in Switchboard (D72)*): the pure parts shared by
 * the service and the UI: the labels and texts, which sessions offer it, how the
 * terminal's liveness is judged from the facts Switchboard has, and which
 * messages go to the new process. No I/O.
 */

/** The action's label (session header, sidebar row menu, History row). */
export const CONTINUE_HOOKED_LABEL = 'Continue in Switchboard';

/** The chat's divider before the first turn of the supervised process. */
export const CONTINUED_DIVIDER = 'Continued in Switchboard (was a terminal session)';

/** The confirmation's text when the terminal's `claude` still runs (the take-over's kind of warning, D65). */
export const STOP_TERMINAL_WARNING =
  "This session's claude is still running in its terminal. Continuing it here stops that claude process first (the terminal window and its shell stay open), then resumes the same conversation as a Switchboard session on the same machine.";

/** The confirmation's button. */
export const STOP_AND_CONTINUE_LABEL = "Stop the terminal's claude and continue";

/** How long a hook call keeps a terminal that the registry no longer lists from counting as gone (the liveness poll's grace, `HookService`). */
export const HOOK_GRACE_MS = 15_000;

/** Body of `POST /api/sessions/{id}/continue-in-switchboard`. */
export interface ContinueHookedInput {
  /** The developer confirmed that the terminal's running `claude` is stopped (required while it runs). */
  readonly confirmStopTerminal?: boolean;
}

/** 409 answer while the terminal's `claude` runs and the stop was not confirmed. */
export interface TerminalRunningRefusal {
  readonly error: 'terminal-running';
  readonly message: string;
  /** The terminal's `claude` process (from `claude agents --json`). */
  readonly pid: number;
}

/**
 * Whether a session offers **Continue in Switchboard**: a hooked session, open or
 * closed (this machine's, or a reachable paired machine's), that was not moved away.
 */
export function offersHookedContinue(session: Pick<Session, 'hooked' | 'closedAt' | 'movedTo' | 'machine'>): boolean {
  if (session.hooked !== true) return false;
  // D72 ruling (2026-10-05): a closed (unhooked) one too: continuing reopens it first. A session taken over elsewhere never.
  if (session.movedTo) return false;
  if (session.machine && offlineReason(session.machine) !== null) return false;
  return true;
}

/** What Switchboard knows about a hooked session's terminal `claude`. */
export interface TerminalFacts {
  /** `claude agents --json` asked fresh: the listed processes, `null` when it could not be read. */
  readonly registry: ReadonlyArray<{ readonly sessionId: string; readonly pid: number }> | null;
  readonly claudeSessionId: string;
  /** The hooks reported SessionEnd (or the liveness poll found it gone). */
  readonly ended: boolean;
  /** The pid the hook script reported (`claudePid`), `null` when unknown. */
  readonly hookPid: number | null;
  /** Whether {@link hookPid} is a live process now (`null` when there is no pid). */
  readonly hookPidAlive: boolean | null;
  /** The last hook call (epoch ms), `null` when none since Switchboard started. */
  readonly lastHookAt: number | null;
  readonly now: number;
}

/** The judgement: `running` (with its pid), `gone`, or `unknown` (why). */
export type TerminalLiveness =
  | { readonly state: 'running'; readonly pid: number }
  | { readonly state: 'gone' }
  | { readonly state: 'unknown'; readonly reason: string };

/**
 * Judges whether the terminal's `claude` still runs (ASSUMED D72-liveness):
 * - the registry lists the session id → `running` (the only state the stop acts on: it stops exactly that pid);
 * - the registry is readable and does not list it → `gone`, unless a hook call came less than
 *   {@link HOOK_GRACE_MS} ago without SessionEnd and the hook's pid is alive or unknown (the
 *   registry may lag behind a session that just started): then `unknown`;
 * - the registry cannot be read → `gone` only when SessionEnd was seen or the hook's pid is
 *   known to be dead, else `unknown`. "Unknown" is never treated as gone.
 */
export function judgeTerminal(facts: TerminalFacts): TerminalLiveness {
  if (facts.registry !== null) {
    const row = facts.registry.find((entry) => entry.sessionId === facts.claudeSessionId);
    if (row) return { state: 'running', pid: row.pid };
    const recent = facts.lastHookAt !== null && facts.now - facts.lastHookAt < HOOK_GRACE_MS;
    if (!facts.ended && recent && facts.hookPidAlive !== false) {
      return { state: 'unknown', reason: "its hooks reported a moment ago but `claude agents --json` does not list it: try again in a few seconds" };
    }
    return { state: 'gone' };
  }
  if (facts.ended || facts.hookPidAlive === false) return { state: 'gone' };
  return { state: 'unknown', reason: "`claude agents --json` could not be read on this machine, so Switchboard cannot tell whether the terminal's claude still runs" };
}

/** A user bubble of the hooked session that the model has not seen (no transcript copy). */
export interface UnseenBubble {
  readonly eventId: number;
  /** The text as it was (to be) sent: `sentText`, else `text`. */
  readonly text: string;
}

/** What happens to the messages the model never saw ({@link splitUnseen}). */
export interface UnseenSplit {
  /** Bubbles of mailbox messages: withdrawn, their texts go to the new process (with the mailbox's own order). */
  readonly resent: readonly number[];
  /** Bubbles handed to a waiter that never reached the transcript: shown as not sent, with Resend. */
  readonly notSent: readonly number[];
  /** The texts sent to the new process as one message: the mailbox, in its order. */
  readonly texts: readonly string[];
}

/**
 * D72 (developer ruling 2026-10-05, D72-pending): the mailbox (`pending_messages`
 * kind `hook-message`, never handed to a waiter) goes to the new process; a bubble
 * handed to a waiter that never reached the transcript (the terminal ended first)
 * is **not** sent again by itself: it is marked not sent, with **Resend**. Bubbles
 * are matched to mailbox entries by their text (each entry once); a mailbox entry
 * without a bubble (a stale question's answers) is sent too.
 */
export function splitUnseen(bubbles: readonly UnseenBubble[], mailbox: readonly string[]): UnseenSplit {
  const left = new Map<string, number>();
  for (const text of mailbox) left.set(text.trim(), (left.get(text.trim()) ?? 0) + 1);
  const resent: number[] = [];
  const notSent: number[] = [];
  for (const bubble of bubbles) {
    const key = bubble.text.trim();
    const count = left.get(key) ?? 0;
    if (count > 0) {
      left.set(key, count - 1);
      resent.push(bubble.eventId);
    } else notSent.push(bubble.eventId);
  }
  return { resent, notSent, texts: mailbox.filter((text) => text.trim() !== '') };
}

/** The bubble's note after Continue in Switchboard when its message never reached the model. */
export const NOT_SENT_NOTE = 'Not sent: the terminal ended before it took this message up.';

/** The note's button. */
export const RESEND_LABEL = 'Resend';
