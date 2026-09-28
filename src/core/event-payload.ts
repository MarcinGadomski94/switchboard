/**
 * Payloads of the session events the supervisor records (`SessionEvent.payload`,
 * `docs/derivations.md` → *Events*). `type` tells them apart; the event `kind`
 * (plan / impl / loop / ask / ok / tool / text / error) is the timeline color and
 * comes from the derivations in `derive/event-kind.ts`.
 *
 * Long strings inside payloads are cut at {@link PAYLOAD_TEXT_LIMIT} characters
 * (`truncated: true` marks it); the full data stays in the CLI's transcript.
 */

/** Longest string kept in an event payload. */
export const PAYLOAD_TEXT_LIMIT = 4000;

/** Where a user message came from. */
export type UserMessageOrigin =
  /** The New-session task (first stdin message). */
  | 'task'
  /** Typed in the chat (`POST /messages`). */
  | 'user'
  /** D7 resume: "Continue.". */
  | 'resume'
  /** Sent by the service itself (restart note, stale answers; M2.4 / M3.1). */
  | 'service';

/** A user message Switchboard wrote to stdin. `delivered` flips when the CLI's `isReplay` echo arrives. */
export interface UserPayload {
  readonly type: 'user';
  readonly text: string;
  readonly origin: UserMessageOrigin;
  readonly delivered: boolean;
}

/** Assistant text; the text blocks of one `message.id` are merged into one event. */
export interface AssistantPayload {
  readonly type: 'assistant';
  readonly text: string;
  readonly messageId: string | null;
}

/** A subagent's prompt (a `user` text line carrying `parent_tool_use_id`). */
export interface AgentPromptPayload {
  readonly type: 'agent-prompt';
  readonly text: string;
}

/** A tool call, paired with its `tool_result` (the event's `endTs` is set then). */
export interface ToolPayload {
  readonly type: 'tool';
  readonly name: string;
  readonly toolUseId: string;
  /** The tool input (long strings cut). */
  readonly input: Readonly<Record<string, unknown>>;
  /** `true` when a string of `input` was cut. */
  readonly inputTruncated?: boolean;
  /** Set once the `tool_result` arrived. */
  readonly result?: string;
  readonly resultTruncated?: boolean;
  readonly isError?: boolean;
  /** For AskUserQuestion: the `can_use_tool` request id (= batch id) once it arrived. */
  readonly requestId?: string;
  /** For AskUserQuestion: the request's state. */
  readonly requestState?: RequestState;
}

/** State of a `can_use_tool` request as the supervisor sees it. */
export type RequestState = 'open' | 'responded' | 'cancelled' | 'stale';

/** A permission request (`can_use_tool` for any tool but AskUserQuestion). */
export interface RequestPayload {
  readonly type: 'request';
  readonly requestId: string;
  readonly toolName: string;
  readonly toolUseId: string | null;
  /** The tool input, verbatim (long strings cut). */
  readonly input: Readonly<Record<string, unknown>>;
  readonly agentId: string | null;
  readonly description: string | null;
  readonly decisionReason: string | null;
  readonly state: RequestState;
  /** `allow` / `deny` once responded. */
  readonly behavior?: string;
}

/** An automatic denial (`system/permission_denied`). */
export interface DeniedPayload {
  readonly type: 'denied';
  readonly toolName: string | null;
  readonly toolUseId: string | null;
  readonly message: string | null;
}

/** A turn's `result` (not recorded for turns Switchboard interrupted to stop the process). */
export interface ResultPayload {
  readonly type: 'result';
  readonly subtype: string;
  readonly isError: boolean;
  readonly text: string | null;
  readonly terminalReason: string | null;
  readonly errors: readonly string[];
  /** A background agent's result (no stdin message behind it). */
  readonly taskNotification: boolean;
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  readonly costUsd: number | null;
}

/** What happened to the process. */
export type LifecycleAction =
  | 'started'
  | 'resumed'
  | 'attached'
  | 'paused'
  | 'detached'
  | 'exited'
  | 'failed'
  | 'stopped'
  /** M2.4: spawned with `--resume` when the service started again (D7). */
  | 'recovered'
  /** M2.4: a process left running by a crashed service was stopped before the resume. */
  | 'leftover-stopped'
  /** M2.4: the session was not resumed after the restart (`message` says why). */
  | 'not-resumed';

/** A process lifecycle step. */
export interface LifecyclePayload {
  readonly type: 'lifecycle';
  readonly action: LifecycleAction;
  readonly pid?: number | null;
  readonly code?: number | null;
  readonly signal?: string | null;
  /** How a Switchboard-initiated stop ended: `eof`, or the signal it escalated to. */
  readonly stoppedBy?: string;
  /** Last stderr lines of a process that failed. */
  readonly stderr?: string;
  readonly message?: string;
  /** M2.4: the pid of the process left from before the restart. */
  readonly leftoverPid?: number;
}

/** `system/init.permissionMode` differs from the requested mode (D6: an unsupported `auto` silently becomes `default`). */
export interface ModeMismatchPayload {
  readonly type: 'mode-mismatch';
  readonly requested: string;
  readonly observed: string | null;
}

/** Every event payload the supervisor writes. */
export type EventPayload =
  | UserPayload
  | AssistantPayload
  | AgentPromptPayload
  | ToolPayload
  | RequestPayload
  | DeniedPayload
  | ResultPayload
  | LifecyclePayload
  | ModeMismatchPayload;

/** `text` cut to {@link PAYLOAD_TEXT_LIMIT} characters. */
export function clip(text: string, limit = PAYLOAD_TEXT_LIMIT): { text: string; truncated: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}

/** A copy of `input` whose string values (at any depth) are cut to the limit. */
export function clipInput(input: Readonly<Record<string, unknown>>, limit = PAYLOAD_TEXT_LIMIT): {
  input: Record<string, unknown>;
  truncated: boolean;
} {
  let truncated = false;
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const cut = clip(value, limit);
      if (cut.truncated) truncated = true;
      return cut.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) out[key] = walk(inner);
      return out;
    }
    return value;
  };
  return { input: walk(input) as Record<string, unknown>, truncated };
}
