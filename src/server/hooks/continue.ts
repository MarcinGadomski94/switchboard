import { realpath } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Session } from '../../core/api.ts';
import type { UserPayload } from '../../core/event-payload.ts';
import { type TerminalLiveness, type UnseenBubble, splitUnseen } from '../../core/hooked-continue.ts';
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
 * 1. refused unless the session is a hooked one (409 `not-hooked`; 409 `closed` only
 *    when it was taken over elsewhere) and its folder exists (409 `folder-missing`);
 *    a closed (unhooked) one is reopened (D33) right before it is converted;
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
 * 4. **messages the model never saw** (developer ruling D72-pending, {@link splitUnseen}):
 *    the mailbox's `hook-message`s go to the new process as one message (their old
 *    bubbles are withdrawn, the new one follows the divider); a bubble handed to a
 *    waiter that never reached the transcript is marked `notSent` (the chat's
 *    **Resend**, {@link HookedContinuer.resend}).
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
    // D72 ruling (2026-10-05): a closed (unhooked) session is offered too and reopened first (below); one taken over elsewhere never.
    if (record.movedTo) return refused(409, 'closed', `${name} was taken over to ${record.movedTo.machineName}: continue it there`);
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
      // D33 reopen semantics: `closedAt` cleared, the `reopened` lifecycle line; no process starts here.
      if (record.closedAt !== null) await this.#supervisor.reopen(sessionId);
      continued = await this.#supervisor.continueHooked(sessionId, cwd);
    } catch (error) {
      if (error instanceof SupervisorError) return refused(supervisorStatus(error), error.code, `Not continued: ${error.message}`);
      throw error;
    }
    await this.#hooks.released(sessionId, record.claudeSessionId);

    // D72-pending (developer ruling 2026-10-05): the mailbox goes to the new process once (its bubbles give way to the
    // new one); a message handed to the terminal that never reached it is shown as not sent, with Resend.
    const split = splitUnseen(bubbles, mailbox.map((message) => message.text));
    for (const message of mailbox) await this.#store.pendingMessages.markDelivered(message.id);
    for (const eventId of split.resent) await this.#patch(eventId, (payload) => ({ ...payload, withdrawn: true }));
    for (const eventId of split.notSent) await this.#patch(eventId, (payload) => ({ ...payload, notSent: true }));
    if (split.texts.length > 0) continued = await this.#supervisor.sendMessage(sessionId, split.texts.join('\n\n'), 'user');
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

  /** Changes a waiting bubble (it loses the D44 clock) and publishes it. */
  async #patch(eventId: number, change: (payload: Omit<UserPayload, 'queued'>) => UserPayload): Promise<void> {
    const event = await this.#store.events.get(eventId);
    if (!event) return;
    const { queued: _queued, ...rest } = event.payload as UserPayload;
    const updated = await this.#store.events.update(eventId, { payload: change(rest) });
    if (updated) this.#bus.publish('event', { sessionId: updated.sessionId, event: toEvent(updated) });
  }

  /**
   * D72 **Resend** (`POST /api/sessions/{id}/events/{eventId}/resend`): a bubble marked
   * not sent goes to the (now Switchboard-run) session as a new message; the old bubble
   * gives way (D50's `withdrawn`) once it was sent.
   */
  async resend(sessionId: string, eventIdText: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly status: number; readonly body: { readonly error: string; readonly message: string } }> {
    const record = await this.#store.sessions.get(sessionId);
    if (!record) return { ok: false, status: 404, body: { error: 'not-found', message: `no session ${sessionId}` } };
    const eventId = /^[1-9][0-9]{0,15}$/.test(eventIdText) ? Number(eventIdText) : Number.NaN;
    const event = Number.isNaN(eventId) ? null : await this.#store.events.get(eventId);
    const payload = event && event.sessionId === sessionId ? (event.payload as Partial<UserPayload> | null) : null;
    if (!event || !payload) return { ok: false, status: 404, body: { error: 'not-found', message: `no message ${eventIdText} in session ${sessionId}` } };
    if (payload.type !== 'user' || payload.notSent !== true || payload.withdrawn === true) {
      return { ok: false, status: 409, body: { error: 'not-resendable', message: 'only a message marked not sent can be sent again' } };
    }
    if (record.hooked) return { ok: false, status: 409, body: { error: 'hooked-unavailable', message: 'continue the session in Switchboard first' } };
    try {
      await this.#supervisor.sendMessage(sessionId, payload.sentText ?? payload.text ?? '', 'user');
    } catch (error) {
      if (error instanceof SupervisorError) return { ok: false, status: supervisorStatus(error), body: { error: error.code, message: error.message } };
      throw error;
    }
    await this.#patch(eventId, (rest) => {
      const { notSent: _notSent, ...kept } = rest;
      return { ...kept, withdrawn: true };
    });
    return { ok: true };
  }

}
