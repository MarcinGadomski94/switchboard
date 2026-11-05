import { scrubCredentials } from './takeover.ts';
import { SECRET_SHAPES } from './workspace-move.ts';

/**
 * The move log (`docs/service.md` → *Following a move*, `docs/peers.md` → *The
 * move log*): one structured service-log line per step transition of a take-over
 * run, on the machine that runs the step. Every line's `msg` starts with
 * {@link MOVE_LOG_PREFIX}, so `grep '"msg":"move:' service.log` finds them all.
 * Pure helpers; the writer is `src/server/takeover/move-log.ts`.
 */

/** Every move-log line's `msg` starts with this. */
export const MOVE_LOG_PREFIX = 'move:';

/** Where a step stands in a line (`state`). `started`: the run itself started (with `step: "start"`). */
export type MoveLogState = 'started' | 'finished' | 'failed' | 'done' | 'rolled-back';

/** Which machine's part a line tells. */
export type MoveLogSide = 'source' | 'target';

/** The longest failure reason a line carries. */
export const MOVE_LOG_REASON_MAX = 300;

/** `Bearer <token>` and `token=` / `password=` style values (headers, query strings, git output). */
const INLINE_SECRETS: ReadonlyArray<RegExp> = [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, /\b((?:access_?)?token|password|passwd|secret|api_?key)=([^\s&;,'"]+)/gi];

/**
 * A failure reason as the move log carries it: one line, URL credentials removed
 * (the take-over's own {@link scrubCredentials}), tokens with a known shape
 * (`SECRET_SHAPES` of the workspace-file check), `Bearer …` and `token=…` values
 * replaced by `[redacted]`, at most {@link MOVE_LOG_REASON_MAX} characters.
 */
export function moveLogReason(error: unknown): string {
  let text = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  text = scrubCredentials(text.replace(/\s*[\r\n]+\s*/g, ' ').trim());
  for (const shape of SECRET_SHAPES) text = text.replace(new RegExp(shape.source, shape.flags.includes('g') ? shape.flags : `${shape.flags}g`), '[redacted]');
  text = text.replace(INLINE_SECRETS[0] as RegExp, (_whole, kind: string) => `${kind} [redacted]`);
  text = text.replace(INLINE_SECRETS[1] as RegExp, (_whole, key: string) => `${key}=[redacted]`);
  return text.length > MOVE_LOG_REASON_MAX ? `${text.slice(0, MOVE_LOG_REASON_MAX - 1)}…` : text;
}

/** A step line's `msg`: `move: <step> <state>` (`move: capture finished`). */
export function moveStepMessage(step: string, state: 'started' | 'finished' | 'failed'): string {
  return `${MOVE_LOG_PREFIX} ${step} ${state}`;
}

/** The final line's `msg`: `move: done`, `move: failed at <step>` or `move: failed at <step>, rolled back`. */
export function moveOutcomeMessage(outcome: { readonly failedAt: string | null; readonly rolledBack: boolean | null }): string {
  if (outcome.failedAt === null) return `${MOVE_LOG_PREFIX} done`;
  if (outcome.rolledBack === true) return `${MOVE_LOG_PREFIX} failed at ${outcome.failedAt}, rolled back`;
  if (outcome.rolledBack === false) return `${MOVE_LOG_PREFIX} failed at ${outcome.failedAt}, rollback left something behind`;
  return `${MOVE_LOG_PREFIX} failed at ${outcome.failedAt}`;
}

/** A run id as a log field: the take-over's op ids are UUIDs; anything else from a peer is not logged as one. */
export function moveLogRunId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : null;
}
