import { realpath } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Session } from '../../core/api.ts';
import type { UserPayload } from '../../core/event-payload.ts';
import { type TerminalLiveness, type UnseenBubble, messagesToResend } from '../../core/hooked-continue.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import type { HubBus } from '../hub/bus.ts';
import { toEvent, toSession } from '../sessions/wire.ts';
import { type SessionSupervisor, SupervisorError } from '../supervisor/supervisor.ts';
import { HOOK_MESSAGE_KIND, HookError, type HookService } from './service.ts';

/** How long the continue waits for a stopped terminal's `claude` to leave the registry (ms). */
export const GONE_WAIT_MS = 15_000;

/** What the route sends: the continued session, or a refusal (`status`, `{ error, message, … }`). */
export type ContinueHookedOutcome =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly status: number; readonly body: { readonly error: string; readonly message: string; readonly [key: string]: unknown } };

/** Options of {@link HookedContinuer}. */
export interface HookedContinuerOptions {
  readonly store: Store;
  readonly bus: HubBus;
  readonly hooks: HookService;
  readonly supervisor: SessionSupervisor;
  /** How long a stopped terminal may take to leave the registry (default {@link GONE_WAIT_MS}). */
  readonly goneWaitMs?: number;
  readonly pollMs?: number;
}

function refused(status: number, error: string, message: string, extra: Record<string, unknown> = {}): ContinueHookedOutcome {
  return { ok: false, status, body: { error, message, ...extra } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** HTTP status of a supervisor refusal (as the session routes map them). */
function supervisorStatus(error: SupervisorError): number {
  if (error.code === 'not-found') return 404;
  if (error.code === 'closing') return 503;
  return 409;
}

/**
 * D72 "Continue in Switchboard" for a hooked terminal session
 * (`POST /api/sessions/{id}/continue-in-switchboard`, `docs/peers.md` →
 * *Continuing a hooked session in Switchboard (D72)*):
 *
 * 1. refused unless the session is an open hooked one (409 `not-hooked` / `closed`),
 *    and its folder exists (409 `folder-missing`);
 * 2. **the terminal**: judged from the live registry, SessionEnd, the hook's pid
 *    (`HookService.terminalLiveness`). Unknown → 409 `terminal-unknown` (never taken
 *    as gone). Running without `confirmStopTerminal` → 409 `terminal-running` (with
 *    its pid). Running and confirmed → stopped with the D65 terminal stop
 *    (`HookService.stopTerminal`: SIGTERM / `taskkill`, the force after 10 s), then
 *    waited for until the registry no longer lists it (bounded); a failed stop
 *    changes nothing else (502 `stop-failed` / `agents-unavailable` with the reason);
 * 3. the transcript's last turns are imported, then the **same record** becomes a
 *    Switchboard-run session (`SessionSupervisor.continueHooked`: `--resume`, no
 *    message, the divider), its hook state is released (waiter, held permission
 *    calls, live line);
 * 4. **messages the model never saw** (ASSUMED D72-pending): the mailbox's
 *    `hook-message`s and bubbles handed to a waiter but missing from the transcript
 *    go to the new process as one message ({@link messagesToResend}); their old
 *    bubbles are withdrawn (the chat shows the new one after the divider instead).
 *
 * One continue runs at a time (a second call waits for the first, then finds the
 * session no longer hooked: 409 `not-hooked`).
 */
export class HookedContinuer {
  readonly #store: Store;
  readonly #bus: HubBus;
  readonly #hooks: HookService;
  readonly #supervisor: SessionSupervisor;
  readonly #goneWaitMs: number;
  readonly #pollMs: number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: HookedContinuerOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#hooks = options.hooks;
    this.#supervisor = options.supervisor;
    this.#goneWaitMs = options.goneWaitMs ?? GONE_WAIT_MS;
    this.#pollMs = options.pollMs ?? 200;
  }

  /** Continues the hooked session `sessionId` (see the class comment); `body` is `{ confirmStopTerminal? }`. */
  continue(sessionId: string, body: unknown): Promise<ContinueHookedOutcome> {
    const run = this.#queue.catch(() => undefined).then(() => this.#continueNow(sessionId, body));
    this.#queue = run;
    return run;
  }

  async #continueNow(sessionId: string, body: unknown): Promise<ContinueHookedOutcome> {
    if (body !== undefined && body !== null && !isRecord(body)) {
      return { ok: false, status: 422, body: { error: 'invalid', message: 'the body must be { confirmStopTerminal?: boolean }', errors: [{ field: '', message: 'the body must be an object' }] } };
    }
    const raw = isRecord(body) ? body['confirmStopTerminal'] : undefined;
    if (raw !== undefined && raw !== null && typeof raw !== 'boolean') {
      return { ok: false, status: 422, body: { error: 'invalid', message: 'confirmStopTerminal must be true or false', errors: [{ field: 'confirmStopTerminal', message: 'confirmStopTerminal must be true or false' }] } };
    }
    const confirm = raw === true;

    const record = await this.#store.sessions.get(sessionId);
    if (!record) return refused(404, 'not-found', `no session ${sessionId}`);
    const name = record.title ?? record.name;
    if (!record.hooked) return refused(409, 'not-hooked', `${name} is not a hooked terminal session: it already runs under Switchboard (or never ran in a terminal)`);
    if (record.closedAt !== null) return refused(409, 'closed', `${name} is closed (unhooked): reopen it first`);
    const folder = record.cwd ?? record.root;
    if (!folder) return refused(409, 'folder-missing', `${name} has no known folder (its terminal never reported one), so it cannot run here`);
    let cwd: string;
    try {
      cwd = await realpath(folder);
    } catch {
      return refused(409, 'folder-missing', `the folder ${name} ran in does not exist any more: ${folder}`);
    }

    // The terminal: never two live processes on one conversation (M0.4).
    const liveness = await this.#hooks.terminalLiveness(sessionId);
    if (!liveness) return refused(409, 'not-hooked', `${name} is not a hooked terminal session`);
    if (liveness.state === 'unknown') return refused(409, 'terminal-unknown', `Not continued: ${liveness.reason}.`);
    if (liveness.state === 'running') {
      if (!confirm) {
        return refused(409, 'terminal-running', `${name}'s claude is still running in its terminal (pid ${liveness.pid}): continuing it here stops it there first. Confirm to stop it and continue.`, { pid: liveness.pid });
      }
      try {
        await this.#hooks.stopTerminal(sessionId);
      } catch (error) {
        if (error instanceof HookError) return refused(error.status, error.code, `Not continued: ${error.message}`);
        throw error;
      }
      const after = await this.#waitGone(sessionId);
      if (after.state !== 'gone') {
        const why = after.state === 'running' ? `the terminal's claude (pid ${after.pid}) is still listed as running` : after.reason;
        return refused(502, 'stop-failed', `Not continued: ${why}.`);
      }
    }

    // The conversation as the terminal left it, then the same record runs under Switchboard.
    await this.#hooks.syncNow(sessionId);
    const bubbles = await this.#unseenBubbles(record);
    const mailbox = (await this.#store.pendingMessages.pending(sessionId)).filter((message) => message.kind === HOOK_MESSAGE_KIND);
    let continued: SessionRecord;
    try {
      continued = await this.#supervisor.continueHooked(sessionId, cwd);
    } catch (error) {
      if (error instanceof SupervisorError) return refused(supervisorStatus(error), error.code, `Not continued: ${error.message}`);
      throw error;
    }
    await this.#hooks.released(sessionId, record.claudeSessionId);

    // D72-pending: what the model never saw goes to the new process once; the old bubbles give way to the new one.
    const resend = messagesToResend(bubbles, mailbox.map((message) => message.text));
    for (const message of mailbox) await this.#store.pendingMessages.markDelivered(message.id);
    for (const bubble of bubbles) await this.#withdraw(bubble.eventId);
    if (resend.length > 0) continued = await this.#supervisor.sendMessage(sessionId, resend.join('\n\n'), 'user');
    return { ok: true, session: await toSession(this.#store, continued, this.#supervisor.activity(sessionId)) };
  }

  /** Polls the terminal's liveness until it is gone or the wait is over (the last judgement). */
  async #waitGone(sessionId: string): Promise<TerminalLiveness> {
    const until = Date.now() + this.#goneWaitMs;
    for (;;) {
      const now = (await this.#hooks.terminalLiveness(sessionId)) ?? ({ state: 'gone' } as const);
      if (now.state === 'gone' || Date.now() >= until) return now;
      await sleep(this.#pollMs);
    }
  }

  /** The session's user bubbles that still wait (sent from Switchboard, not in the transcript). */
  async #unseenBubbles(record: SessionRecord): Promise<UnseenBubble[]> {
    const out: UnseenBubble[] = [];
    for (const event of await this.#store.events.list(record.id)) {
      const payload = event.payload as Partial<UserPayload> | null;
      if (payload?.type !== 'user' || payload.delivered !== false || payload.withdrawn === true || payload.origin !== 'user') continue;
      out.push({ eventId: event.id, text: payload.sentText ?? payload.text ?? '' });
    }
    return out;
  }

  /** A waiting bubble gives way (D50's `withdrawn`: the chat no longer shows it; its text went out again). */
  async #withdraw(eventId: number): Promise<void> {
    const event = await this.#store.events.get(eventId);
    if (!event) return;
    const { queued: _queued, ...rest } = event.payload as UserPayload;
    const updated = await this.#store.events.update(eventId, { payload: { ...rest, withdrawn: true } });
    if (updated) this.#bus.publish('event', { sessionId: updated.sessionId, event: toEvent(updated) });
  }
}
