/**
 * D91 (`docs/settings.md` → *Apply to open sessions*): the standing instruction (D64)
 * reaches a session only when Switchboard (re)starts its CLI process. These are the
 * shared texts and shapes of applying it to the sessions already open: Settings'
 * **Apply to open sessions**, a session's ⋯ → **Reload instruction**, and the chat's
 * divider of a restart.
 */

/** The chat's divider of a process restarted to pick up the instruction. */
export const INSTRUCTION_UPDATED_DIVIDER = 'Standing instruction updated';

/** Settings' button. */
export const APPLY_INSTRUCTION_LABEL = 'Apply to open sessions';

/** A session's ⋯ menu item (shown while its process runs an older instruction). */
export const RELOAD_INSTRUCTION_LABEL = 'Reload instruction';

/**
 * What a reload did for one session:
 * - `restarted`: the process was idle and restarted with `--resume` (same conversation, no message);
 * - `pending`: a turn runs or the session waits on the developer: applied once it goes idle;
 * - `current`: its process already runs the current instruction;
 * - `not-running`: no process runs (paused, ended, not started): its next start gets it.
 */
export type InstructionReloadOutcome = 'restarted' | 'pending' | 'current' | 'not-running';

/** `POST /api/sessions/{id}/reload-instruction`'s answer (the session is the API's `Session`). */
export interface InstructionReloadResult<S = unknown> {
  readonly outcome: InstructionReloadOutcome;
  readonly session: S;
}

/** One session an apply could not restart (it is left as it was). */
export interface InstructionApplyFailure {
  readonly sessionId: string;
  readonly title: string;
  readonly reason: string;
}

/** `POST /api/settings/standing-instruction/apply`'s answer: what happened to this machine's open sessions. */
export interface InstructionApplyResult {
  /** Restarted now (idle). */
  readonly restarted: readonly string[];
  /** Open, supervised, no process running (paused or between runs): they get it at their next start (counted as applied). */
  readonly notRunning: number;
  /** Busy or waiting on the developer: applied once each goes idle. */
  readonly pending: readonly string[];
  /** Already on the current instruction. */
  readonly current: number;
  /** Hooked terminal sessions and sessions continued in a terminal: Switchboard does not run their process. */
  readonly skipped: number;
  readonly failed: readonly InstructionApplyFailure[];
}

/** The minimal shape of a session the count reads. */
export interface InstructionStaleSession {
  readonly closedAt?: string | null;
  readonly machine?: unknown;
  readonly hooked?: boolean;
  readonly instructionOutdated?: boolean;
}

/** This machine's open sessions whose running process uses an older instruction (a peer's are applied on that machine). */
export function staleInstructionCount(sessions: readonly InstructionStaleSession[]): number {
  return sessions.filter((s) => s.instructionOutdated === true && !s.closedAt && !s.machine && s.hooked !== true).length;
}

/** "3 open sessions use an older instruction" (`null` for none). */
export function staleInstructionText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? '1 open session uses an older instruction' : `${count} open sessions use an older instruction`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The result line after an apply: "Applied to 3 (2 restarted, 1 not running) · 1 after its turn · 1 failed". */
export function applySummary(result: InstructionApplyResult): string {
  const applied = result.restarted.length + result.notRunning;
  const parts: string[] = [];
  const detail = [result.restarted.length > 0 ? `${result.restarted.length} restarted` : null, result.notRunning > 0 ? `${result.notRunning} not running: on their next start` : null].filter(Boolean);
  parts.push(`Applied to ${plural(applied, 'session', 'sessions')}${detail.length > 0 ? ` (${detail.join(', ')})` : ''}`);
  if (result.pending.length > 0) parts.push(`${result.pending.length} after ${result.pending.length === 1 ? 'its' : 'their'} turn`);
  if (result.current > 0) parts.push(`${result.current} already current`);
  if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
  return parts.join(' · ');
}

/** The ⋯ menu's Reload instruction: shown for this machine's open, Switchboard-run session whose process runs an older instruction. */
export function offersInstructionReload(session: InstructionStaleSession & { readonly attached?: boolean }): boolean {
  return session.instructionOutdated === true && !session.closedAt && !session.machine && session.hooked !== true && session.attached !== false;
}

/** The ⋯ menu item's tooltip while a reload waits for the turn's end. */
export const RELOAD_PENDING_TITLE = 'Applies when the running turn ends';
