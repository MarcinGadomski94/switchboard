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
  | { readonly behavior: 'allow'; readonly updatedInput: Readonly<Record<string, unknown>> }
  | { readonly behavior: 'deny'; readonly message: string };

/** `{"type":"user","message":{"role":"user","content":<text>}}`. */
export function userMessageLine(text: string): UserMessageLine {
  return { type: 'user', message: { role: 'user', content: text } };
}

/** The interrupt control request (D7 pause). */
export function interruptLine(requestId: string): ControlRequestLine {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
}

/** The `set_permission_mode` control request (D6 fallback, `docs/spike-m0.md` → *D6: auto mode headless*). */
export function setPermissionModeLine(requestId: string, mode: string): ControlRequestLine {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode } };
}

/** A success reply to a CLI control request. */
export function controlSuccessLine(requestId: string, response: unknown): ControlResponseLine {
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

/** An error reply to a CLI control request Switchboard does not handle. */
export function controlErrorLine(requestId: string, error: string): ControlResponseLine {
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } };
}
