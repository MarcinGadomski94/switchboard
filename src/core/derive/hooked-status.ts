/**
 * D53 (`docs/chat.md` → *Live activity line* / *Queued messages*): the parts of a
 * hooked session's live state the web reads too: the staleness hint's threshold
 * and what a message to it waits on. Pure; no Node types (the web bundles it).
 * The derivation itself is `./hooked-activity.ts`.
 */
import type { SessionActivity } from '../api.ts';

/** A running turn with no transcript line and no hook call for this long shows "· no activity for Nm" (ASSUMED D53-stale: 3 minutes). */
export const STALE_AFTER_MS = 3 * 60_000;

/** How long a running turn has been quiet (ms) once that is at least {@link STALE_AFTER_MS} (`quietSince` to `now`); `null` otherwise, and while it waits for the developer or in the background. */
export function staleFor(activity: Pick<SessionActivity, 'state' | 'quietSince'>, now: number): number | null {
  if (!activity.quietSince || activity.state === 'waiting' || activity.state === 'background') return null;
  const at = Date.parse(activity.quietSince);
  if (!Number.isFinite(at)) return null;
  const quiet = now - at;
  return quiet >= STALE_AFTER_MS ? quiet : null;
}

// ── message delivery (D44 clock of a hooked session) ─────────────────────

/**
 * D53: what a message to a hooked session waits on.
 * - `handed`: released to the session's live waiter; the CLI has not taken it up yet.
 * - `turn`: waits for the next turn boundary (a turn runs; or a wake-up is in flight / the rate limit holds it).
 * - `no-waiter`: no waiter was ever registered for the session (it has not run a hook since the hooks were installed).
 * - `waiter-stopped`: the session's waiter was there and is gone (the CLI's timeout killed it, or Switchboard restarted); the CLI re-arms it at the next turn.
 * - `ended`: the terminal session is gone.
 */
export type HookDeliveryState = 'handed' | 'turn' | 'no-waiter' | 'waiter-stopped' | 'ended';

/** D53: the plain words of each {@link HookDeliveryState} (the clock's tooltip and the line under the bubble). */
export const HOOK_DELIVERY_TEXT: Readonly<Record<HookDeliveryState, string>> = {
  handed: 'Waiting for the session to take it up (delivered to its hook)',
  turn: 'Waiting for the next turn boundary',
  'no-waiter': 'No hook listening yet — type anything in that terminal once (the hooks were installed after this session started)',
  'waiter-stopped': 'The hook stopped listening (it expired or Switchboard restarted) — it re-arms at the next turn; update the hooks to prevent this',
  ended: 'Session ended',
};

/** Input of {@link hookDelivery}. */
export interface HookDeliveryInput {
  readonly ended: boolean;
  /** A waiter is held for the session now. */
  readonly waiter: boolean;
  /** The session had a waiter (or its hooks reported) since Switchboard started: no waiter now means it stopped, not that it never was. */
  readonly waiterSeen?: boolean;
  /** A turn runs. */
  readonly running: boolean;
  /** A wake-up was released to a waiter and its turn has not been seen to start. */
  readonly released: boolean;
  /** Messages still in the mailbox (not released yet). */
  readonly queued: number;
}

/**
 * D53: what a hooked session's undelivered message waits on, `null` when nothing
 * needs saying:
 * - the terminal session is gone → `ended`;
 * - released to a waiter, its turn not seen to start → `turn` while a turn runs
 *   (the CLI folds it in at its next tool boundary), else `handed`;
 * - still in the mailbox → `turn` with a waiter (held for the running wake-up or
 *   the rate limit) or while a turn runs (its Stop arms the next waiter), else
 *   `no-waiter`;
 * - nothing waits → `no-waiter` (or `waiter-stopped` when one was seen) when idle
 *   without a waiter (the header note warns before a message is sent), else `null`.
 */
export function hookDelivery(input: HookDeliveryInput): HookDeliveryState | null {
  if (input.ended) return 'ended';
  if (input.released) return input.running ? 'turn' : 'handed';
  if (input.waiter || input.running) return input.queued > 0 ? 'turn' : null;
  return input.waiterSeen === true ? 'waiter-stopped' : 'no-waiter';
}

/** The header note when Switchboard's hooks on the session's machine are older than this version's entries (they lack options such as the waiter's long timeout). */
export function hooksOutdatedText(machineName: string | null): string {
  return `Hooks are outdated on ${machineName ?? 'this machine'} — Update hooks so idle sessions stay reachable`;
}
