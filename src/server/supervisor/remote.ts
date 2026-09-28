import { randomUUID } from 'node:crypto';
import type { RemotePayload } from '../../core/event-payload.ts';
import { ANSWERED_ON_CLAUDE_AI, type AnsweredOn, type RemoteControlReply, parseRemoteControlReply, remoteControlAvailable } from '../../core/remote-control.ts';
import { type ControlRequestLine, type RemoteControlRequest, initializeLine, remoteControlLine } from '../../core/stdin.ts';
import type { ControlResponseMessage } from '../../core/stream-json.ts';
import type { SessionPatch, SessionRecord } from '../db/repos/sessions.ts';

/**
 * Remote Control on a supervised process (D24, `docs/remote-control.md`): the
 * `initialize` handshake at spawn, the Remote toggle, the reattach after a new
 * process (pause/resume, restart recovery, attach), and whether a withdrawn
 * request was answered on claude.ai. One {@link LiveRemote} per live process.
 */

/** How long the `initialize` reply may take (no model call; M0.2 saw it at once). */
export const INITIALIZE_TIMEOUT_MS = 20_000;

/** How long a `remote_control` reply may take (the CLI registers the bridge with claude.ai first). */
export const REMOTE_CONTROL_TIMEOUT_MS = 60_000;

/** Why a Remote toggle was refused (the routes map these to HTTP statuses). */
export type RemoteControlErrorCode = 'not-live' | 'remote-unavailable' | 'remote-failed';

/** A refused or failed Remote toggle. For `remote-failed` the message is the CLI's error text, verbatim. */
export class RemoteControlError extends Error {
  override name = 'RemoteControlError';
  readonly code: RemoteControlErrorCode;
  constructor(code: RemoteControlErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** What a {@link LiveRemote} needs from the supervisor, for its one live process. */
export interface RemoteHost {
  /**
   * Writes one stdin control request to the process **now** (synchronously) and
   * resolves its `control_response`; `null` when it could not be written, or no
   * reply came within `timeoutMs`, or the process ended first.
   */
  request(line: ControlRequestLine, timeoutMs: number): Promise<ControlResponseMessage | null>;
  /** The session as stored now (`null` if it is gone). */
  session(): Promise<SessionRecord | null>;
  /** Stores Remote fields on the session. */
  update(patch: SessionPatch): Promise<void>;
  /** Records a chat event (`remote` payload) for the session. */
  record(kind: 'text' | 'error', label: string, payload: RemotePayload): Promise<void>;
  /** Announces the session (`sessionUpdated`). */
  publish(): Promise<void>;
  /** `true` while this process is still the session's live process and Switchboard is not stopping it. */
  current(): boolean;
  /**
   * D31: the `initialize` reply's inner `response` (`null` when it failed or never
   * came), for what else the supervisor keeps from it (the models list). Called
   * once, while the process is current, before a reattach and the publish.
   */
  initialized?(response: Record<string, unknown> | null): Promise<void>;
}

/** The bridge on the live process: none, being started (enable / reattach sent), or up. */
export type BridgeState = 'off' | 'starting' | 'on';

/**
 * Remote Control state of one live `claude` process. Every step runs one at a
 * time (the handshake, then toggles in the order they came), so a toggle never
 * overlaps the reattach. Nothing is ever retried: a failure is stored, recorded
 * in the chat with the CLI's text and reported.
 */
export class LiveRemote {
  readonly #host: RemoteHost;
  #available: boolean | null = null;
  #bridge: BridgeState = 'off';
  #chain: Promise<void> = Promise.resolve();

  constructor(host: RemoteHost) {
    this.#host = host;
  }

  /** What `initialize` reported (`remote_control_available`); `null` until it answered. */
  get available(): boolean | null {
    return this.#available;
  }

  /** The bridge on this process. */
  get bridge(): BridgeState {
    return this.#bridge;
  }

  /**
   * Where a request the CLI just withdrew (`control_cancel_request`) was answered:
   * `claude.ai` while the bridge is on (or being started) and Switchboard is not
   * stopping the process (a stop's interrupt withdraws open requests too, M0.2);
   * `null` otherwise. `docs/spike-remote.md` → R.6: "when the phone answers first
   * … writes `control_cancel_request` to stdout".
   */
  answeredOn(): AnsweredOn | null {
    return this.#bridge !== 'off' && this.#host.current() ? ANSWERED_ON_CLAUDE_AI : null;
  }

  /**
   * At spawn: writes `initialize` at once (before any user message), stores
   * `remote_control_available` from its reply, hands the reply to the host (D31:
   * the models list), and when Remote is on for the session re-enables it with
   * `reattach_session_id` (D7: pause/resume, restart recovery, attach). A failed
   * reattach turns Remote off and says why in the chat. Never throws.
   */
  handshake(): Promise<void> {
    const reply = this.#host.request(initializeLine(`sb-init-${randomUUID()}`), INITIALIZE_TIMEOUT_MS);
    return this.#serial(async () => {
      const response = await reply;
      this.#available = response !== null && response.subtype === 'success' && remoteControlAvailable(response.response);
      if (!this.#host.current()) return;
      await this.#host.update({ remoteAvailable: this.#available });
      await this.#host.initialized?.(response !== null && response.subtype === 'success' ? response.response : null);
      const session = await this.#host.session();
      if (session?.remoteEnabled) await this.#reattach(session);
      await this.#host.publish();
    });
  }

  /**
   * The Remote toggle (`PUT /api/sessions/{id}/remote`). On: `remote_control`
   * `enabled: true` with the session's display title, `keep_session_on_exit: true`
   * and, when an earlier bridge left its `cse_…` id, `reattach_session_id`; the
   * reply's link and id are stored. Off: `enabled: false`; the link and id stay.
   * Already in the asked state: nothing is sent.
   * @throws {RemoteControlError} `not-live`, `remote-unavailable`, or `remote-failed`
   * with the CLI's error text verbatim (Remote stays off after a failed "on"; a
   * stored entry that could not be reattached is dropped, so the next "on" starts
   * a new one).
   */
  set(enabled: boolean): Promise<void> {
    return this.#serial(() => (enabled ? this.#turnOn() : this.#turnOff()));
  }

  #serial(work: () => Promise<void>): Promise<void> {
    const run = this.#chain.then(work);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #session(): Promise<SessionRecord> {
    const session = this.#host.current() ? await this.#host.session() : null;
    if (!session || !this.#host.current()) throw new RemoteControlError('not-live', 'Remote Control needs a running claude process: resume the session first');
    return session;
  }

  async #turnOn(): Promise<void> {
    const session = await this.#session();
    if (this.#available !== true) {
      throw new RemoteControlError(
        'remote-unavailable',
        'claude reports that Remote Control is not available for this session (its initialize reply did not say remote_control_available: true)',
      );
    }
    if (session.remoteEnabled && this.#bridge === 'on') return;
    const request = enableRequest(session);
    const reattach = request.reattachSessionId !== undefined;
    this.#bridge = 'starting';
    const reply = await this.#send(request);
    if (!reply.ok) {
      this.#bridge = 'off';
      if (this.#host.current()) {
        // Never retried: a stored entry that could not be reattached is dropped, so the next "on" starts a new one.
        await this.#host.update({ remoteEnabled: false, ...(reattach ? { remoteBridgeId: null, remoteSessionUrl: null } : {}) });
        await this.#host.record('error', `Remote Control could not be turned on: ${reply.error}`, { type: 'remote', action: 'failed', enabled: true, reattach, error: reply.error });
        await this.#host.publish();
      }
      throw new RemoteControlError('remote-failed', reply.error);
    }
    await this.#bridgeUp(request, reply, 'Remote Control on');
  }

  async #turnOff(): Promise<void> {
    const session = await this.#session();
    if (!session.remoteEnabled && this.#bridge === 'off') return;
    if (this.#bridge !== 'off') {
      const reply = await this.#send({ enabled: false });
      // The process ended meanwhile: its bridge ended with it, so Remote is off as asked.
      if (!reply.ok && this.#host.current()) {
        await this.#host.record('error', `Remote Control could not be turned off: ${reply.error}`, { type: 'remote', action: 'failed', enabled: false, error: reply.error });
        await this.#host.publish();
        throw new RemoteControlError('remote-failed', reply.error);
      }
    }
    this.#bridge = 'off';
    await this.#host.update({ remoteEnabled: false });
    await this.#host.record('text', 'Remote Control off', { type: 'remote', action: 'off' });
    await this.#host.publish();
  }

  /** D7: Remote was on for the session; its new process reconnects the stored claude.ai entry. */
  async #reattach(session: SessionRecord): Promise<void> {
    if (this.#available !== true) {
      await this.#reattachFailed(
        'Remote Control is not available in the new claude process (its initialize reply did not say remote_control_available: true)',
        session.remoteBridgeId !== null,
      );
      return;
    }
    const request = enableRequest(session);
    this.#bridge = 'starting';
    const reply = await this.#send(request);
    if (!reply.ok) {
      this.#bridge = 'off';
      // A stop that cut the reattach short changes nothing: the next process tries again.
      if (this.#host.current()) await this.#reattachFailed(reply.error, request.reattachSessionId !== undefined);
      return;
    }
    await this.#bridgeUp(request, reply, 'Remote Control on again');
  }

  async #reattachFailed(error: string, reattach: boolean): Promise<void> {
    await this.#host.update({ remoteEnabled: false });
    await this.#host.record('error', `Remote Control could not reconnect: ${error}`, { type: 'remote', action: 'failed', enabled: true, reattach, error });
  }

  async #bridgeUp(request: RemoteControlRequest, reply: Extract<RemoteControlReply, { ok: true }>, label: string): Promise<void> {
    this.#bridge = 'on';
    const url = reply.bridge?.sessionUrl ?? '';
    await this.#host.update({
      remoteEnabled: true,
      remoteSessionUrl: url,
      remoteBridgeId: reply.bridge?.bridgeSessionId ?? request.reattachSessionId ?? null,
    });
    await this.#host.record('text', `${label} · ${url}`, { type: 'remote', action: 'on', reattach: request.reattachSessionId !== undefined, url });
    await this.#host.publish();
  }

  async #send(request: RemoteControlRequest): Promise<RemoteControlReply> {
    const reply = await this.#host.request(remoteControlLine(`sb-remote-${randomUUID()}`, request), REMOTE_CONTROL_TIMEOUT_MS);
    if (reply === null) {
      return {
        ok: false,
        error: this.#host.current()
          ? `claude did not answer the remote_control request within ${REMOTE_CONTROL_TIMEOUT_MS / 1000} s`
          : 'the claude process ended before it answered the remote_control request',
      };
    }
    return parseRemoteControlReply(reply, request.enabled);
  }
}

/** `remote_control` `enabled: true` for the session: its display title, the entry kept on exit, the stored `cse_…` id to reattach. */
function enableRequest(session: SessionRecord): RemoteControlRequest {
  return {
    enabled: true,
    name: session.title ?? session.name,
    keepSessionOnExit: true,
    ...(session.remoteBridgeId ? { reattachSessionId: session.remoteBridgeId } : {}),
  };
}
