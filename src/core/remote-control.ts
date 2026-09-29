/**
 * Remote Control on Switchboard's own sessions (D24, `docs/remote-control.md`):
 * the pure part. The shapes come from `docs/spike-remote.md` → R.6 / R.8, read in
 * the CLI's code and never run (the developer tests them live), so every reply is
 * read defensively: unknown fields are ignored, anything missing that Switchboard
 * needs is an error, and a CLI error is kept verbatim.
 */

/** Where a request answered outside Switchboard was answered (`Question.answeredOn`, the request events). */
export const ANSWERED_ON_CLAUDE_AI = 'claude.ai';

/** D48 P4: a hooked terminal session's request answered in its own terminal first. */
export const ANSWERED_IN_TERMINAL = 'terminal';

/** Where a request answered outside Switchboard was answered: the phone (D24) or, D48 P4, a hooked session's terminal. */
export type AnsweredOn = typeof ANSWERED_ON_CLAUDE_AI | typeof ANSWERED_IN_TERMINAL;

/** A parsed JSON object. */
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * `remote_control_available` of an `initialize` reply's inner `response`: `true`
 * only when the CLI says exactly `true` (anything else, a missing field or no
 * reply, is "not available").
 */
export function remoteControlAvailable(initializeResponse: unknown): boolean {
  return isRecord(initializeResponse) && initializeResponse['remote_control_available'] === true;
}

/** The fields Switchboard keeps from a successful `remote_control` `enabled: true` reply. */
export interface RemoteBridge {
  /** `https://claude.ai/code/session_…`: the link and the QR code. */
  readonly sessionUrl: string;
  /** `cse_…`: the id a later `reattach_session_id` names; `null` when the reply had none (no reattach then). */
  readonly bridgeSessionId: string | null;
}

/** A `remote_control` reply, read. */
export type RemoteControlReply =
  | { readonly ok: true; readonly bridge: RemoteBridge | null }
  | { readonly ok: false; readonly error: string };

/** The `control_response` fields {@link parseRemoteControlReply} reads (`ControlResponseMessage` has them). */
export interface ControlReply {
  /** `success` or `error`. */
  readonly subtype: string;
  readonly response: JsonRecord | null;
  readonly error: string | null;
}

/**
 * Reads the CLI's reply to a `remote_control` request (`docs/spike-remote.md` →
 * R.6: success `{session_url, connect_url, environment_id, bridge_epoch,
 * bridge_session_id}` for `enabled: true`, success `{}` for `enabled: false`).
 * - `error` → its text verbatim (a reply without text says so);
 * - `enabled: true` success without a `session_url` string, or with one that is
 *   not an `https://` URL, is an error that quotes the reply (the link is opened
 *   and turned into a QR code, so nothing else is accepted);
 * - `bridge_session_id` is kept when it is a string, else `null`;
 * - every other field is ignored.
 */
export function parseRemoteControlReply(reply: ControlReply, enabled: boolean): RemoteControlReply {
  if (reply.subtype === 'error') {
    return { ok: false, error: text(reply.error) ?? 'claude answered the remote_control request with an error and no text' };
  }
  if (reply.subtype !== 'success') {
    return { ok: false, error: `claude answered the remote_control request with "${reply.subtype}" (expected success or error)` };
  }
  if (!enabled) return { ok: true, bridge: null };
  const body = reply.response ?? {};
  const sessionUrl = text(body['session_url']);
  if (sessionUrl === null) return { ok: false, error: `claude's remote_control reply has no session_url: ${JSON.stringify(body)}` };
  if (!isHttpsUrl(sessionUrl)) return { ok: false, error: `claude's remote_control reply has a session_url that is not an https URL: ${sessionUrl}` };
  return { ok: true, bridge: { sessionUrl, bridgeSessionId: text(body['bridge_session_id']) } };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
