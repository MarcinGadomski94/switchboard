/**
 * The stdin lines Switchboard writes to a supervised `claude` process
 * (`--input-format stream-json`; `docs/spike-m0.md` → *Streaming input*,
 * *Interrupting a running turn*, *The control protocol*). Each builder returns
 * the object; the supervisor writes it as one JSON line.
 */

/** A user message: runs one turn that ends with a `result`. */
export interface UserMessageLine {
  readonly type: 'user';
  readonly message: { readonly role: 'user'; readonly content: string };
}

/** A control request Switchboard sends (interrupt, get_usage, …). */
export interface ControlRequestLine {
  readonly type: 'control_request';
  readonly request_id: string;
  readonly request: { readonly subtype: string } & Readonly<Record<string, unknown>>;
}

/** The reply to a CLI `control_request`. */
export interface ControlResponseLine {
  readonly type: 'control_response';
  readonly response:
    | { readonly subtype: 'success'; readonly request_id: string; readonly response: unknown }
    | { readonly subtype: 'error'; readonly request_id: string; readonly error: string };
}

/**
 * A `can_use_tool` decision (the inner `response` of a success reply). Allow once
 * passes the input back unchanged (plus `answers` for AskUserQuestion) and never
 * `updatedPermissions` (D6); deny carries a fixed message.
 */
export type ToolDecision =
  | {
      readonly behavior: 'allow';
      readonly updatedInput: Readonly<Record<string, unknown>>;
      /** D48 P4 only (a hooked session's "Always allow"); never sent to a supervised process (D6). */
      readonly updatedPermissions?: readonly unknown[];
    }
  | { readonly behavior: 'deny'; readonly message: string };

/** `{"type":"user","message":{"role":"user","content":<text>}}`. */
export function userMessageLine(text: string): UserMessageLine {
  return { type: 'user', message: { role: 'user', content: text } };
}

/** Options of {@link interruptLine}. */
export interface InterruptOptions {
  /**
   * D50 Stop: `cancel_queued: true`: the CLI also cancels every main-thread command
   * still in its queue (the stdin messages written while the turn ran), so none of
   * them runs after the interrupt (CLI 2.1.284, capability `interrupt_cancel_queued_v1`;
   * `docs/supervisor.md` → *Stop the current turn*). Absent = a plain interrupt (D7
   * Pause: the process ends anyway).
   */
  readonly cancelQueued?: boolean;
}

/** The interrupt control request (D7 pause; D50 stop with `cancelQueued`). */
export function interruptLine(requestId: string, options: InterruptOptions = {}): ControlRequestLine {
  const request = options.cancelQueued ? { subtype: 'interrupt', cancel_queued: true } : { subtype: 'interrupt' };
  return { type: 'control_request', request_id: requestId, request };
}

/** The `set_permission_mode` control request (D6 fallback, `docs/spike-m0.md` → *D6: auto mode headless*). */
export function setPermissionModeLine(requestId: string, mode: string): ControlRequestLine {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode } };
}

/**
 * The `initialize` control request (`docs/spike-m0.md` → `ctl-init`,
 * `docs/spike-remote.md` → *Control-protocol probe*): no model call; its reply
 * carries `remote_control_available` (D24). Sent once per process, at spawn.
 */
export function initializeLine(requestId: string): ControlRequestLine {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'initialize', hooks: null } };
}

/** What a `remote_control` control request asks (D24; `docs/spike-remote.md` → R.6). */
export interface RemoteControlRequest {
  /** `true` starts (or reattaches) the bridge, `false` ends it. */
  readonly enabled: boolean;
  /** The claude.ai entry's name (the session's display title). Only with `enabled: true`. */
  readonly name?: string;
  /** A stored `cse_…` id: reconnect that claude.ai entry instead of creating one. Only with `enabled: true`. */
  readonly reattachSessionId?: string;
  /** Keep the claude.ai entry when the process ends (pause / restart), so a later reattach finds it. */
  readonly keepSessionOnExit?: boolean;
}

/**
 * The `remote_control` control request, in the shape the Agent SDK's
 * `enableRemoteControl` sends (`docs/spike-remote.md` → R.6, code-read, never run):
 * `{"subtype":"remote_control","enabled":true,"name":…,"reattach_session_id":…,"keep_session_on_exit":…}`,
 * or `{"subtype":"remote_control","enabled":false}`.
 */
export function remoteControlLine(requestId: string, request: RemoteControlRequest): ControlRequestLine {
  const body: Record<string, unknown> = { subtype: 'remote_control', enabled: request.enabled };
  if (request.enabled) {
    if (request.name !== undefined) body['name'] = request.name;
    if (request.reattachSessionId !== undefined) body['reattach_session_id'] = request.reattachSessionId;
    if (request.keepSessionOnExit !== undefined) body['keep_session_on_exit'] = request.keepSessionOnExit;
  }
  return { type: 'control_request', request_id: requestId, request: body as ControlRequestLine['request'] };
}

/**
 * D31: the `set_model` control request (the Agent SDK's `setModel`; probed on CLI
 * 2.1.283, `docs/model-effort.md`): `{"subtype":"set_model","model":<value>}`.
 * `default` goes back to the CLI's default model. A success reply has no body;
 * an unknown model is `{"subtype":"error","error":"Model '<x>' not found","error_code":"catalog_unknown"}`.
 */
export function setModelLine(requestId: string, model: string): ControlRequestLine {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'set_model', model } };
}

/**
 * D31: the effort change, `apply_flag_settings` with `effortLevel` (the Agent SDK's
 * `applyFlagSettings({ effortLevel })`; CLI 2.1.283 has no `set_effort`, probed):
 * `{"subtype":"apply_flag_settings","settings":{"effortLevel":<level | null>}}`.
 * `null` goes back to the CLI's default effort. The CLI does not check the level
 * (an unknown one is a silent success), so Switchboard checks it first.
 */
export function effortLine(requestId: string, effort: string | null): ControlRequestLine {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'apply_flag_settings', settings: { effortLevel: effort } } };
}

/** A success reply to a CLI control request. */
export function controlSuccessLine(requestId: string, response: unknown): ControlResponseLine {
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

/** An error reply to a CLI control request Switchboard does not handle. */
export function controlErrorLine(requestId: string, error: string): ControlResponseLine {
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } };
}
