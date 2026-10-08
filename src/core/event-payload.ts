/**
 * Payloads of the session events the supervisor records (`SessionEvent.payload`,
 * `docs/derivations.md` → *Events*). `type` tells them apart; the event `kind`
 * (plan / impl / loop / ask / ok / tool / text / error) is the timeline color and
 * comes from the derivations in `derive/event-kind.ts`.
 *
 * Long strings inside tool inputs, tool results and a turn's `result` are cut at
 * {@link PAYLOAD_TEXT_LIMIT} characters (`inputTruncated` / `resultTruncated` mark
 * it); the full data stays in the CLI's transcript. Message text (assistant text,
 * a subagent's prompt; a user message is never cut) is stored in full up to the
 * safety cap {@link MESSAGE_TEXT_LIMIT} (Fix · long messages, `docs/derivations.md`
 * → *What is clipped*).
 */

import type { CliProviderId, HandoverSource } from './cli-providers.ts';
import type { Attachment } from './attachments.ts';
import type { AnsweredOn } from './remote-control.ts';

/** Longest string kept in a tool input or result (and a turn's `result` text) of an event payload. */
export const PAYLOAD_TEXT_LIMIT = 4000;

/**
 * Fix · long messages: longest message text (assistant text, a subagent's prompt)
 * kept in an event payload, a safety cap against pathological sizes only (about
 * 1 MB of text; ASSUMED long-messages-cap). A longer text is stored cut with
 * `truncated: true`.
 */
export const MESSAGE_TEXT_LIMIT = 1_000_000;

/** Where a user message came from. */
export type UserMessageOrigin =
  /** The New-session task (first stdin message). */
  | 'task'
  /** Typed in the chat (`POST /messages`). */
  | 'user'
  /** D7 resume: "Continue.". */
  | 'resume'
  /** Sent by the service itself (restart note, stale answers; M2.4 / M3.1). */
  | 'service'
  /** Typed in a terminal while the session was detached; imported from the transcript on Attach (M4.1). */
  | 'terminal'
  /** D25: a prompt of the remote session a teleported session is a local copy of; imported from the local copy's transcript. */
  | 'remote';

/**
 * D44: why a message the agent has not taken up yet waits (`docs/derivations.md`
 * → *Queued messages*):
 * - `turn`: it was written while a turn ran (or behind other messages still
 *   waiting), so the CLI takes it up after that turn;
 * - `resume`: it was sent while the session had no live process, so it goes to
 *   the agent when the session's resumed process takes it up (a chat message
 *   resumes the session; answers wait in the outbox until the next run).
 */
export type QueuedReason = 'turn' | 'resume';

/**
 * A user message Switchboard wrote to stdin (`delivered` flips when the CLI's
 * `isReplay` echo arrives), or one a terminal sent while the session was detached
 * (origin `terminal`, imported from the transcript, always delivered).
 */
export interface UserPayload {
  readonly type: 'user';
  readonly text: string;
  readonly origin: UserMessageOrigin;
  readonly delivered: boolean;
  /**
   * Additive (D44): present while the message waits for the agent to take it up,
   * with the reason; removed once the CLI took it up (the turn that starts on it,
   * or its replay, whichever comes first) and absent on messages that never waited.
   */
  readonly queued?: QueuedReason;
  /**
   * Additive (D50): a Stop took the message back before the agent took it up (it
   * was queued, or its turn had not started): the CLI never runs it, its text went
   * back into the composer, and the chat no longer shows it. Absent otherwise.
   */
  readonly withdrawn?: true;
  /**
   * Additive (D72): the message was handed to a hooked session's terminal, which
   * ended before taking it up (the transcript never had it); after **Continue in
   * Switchboard** it shows as not sent with **Resend**
   * (`POST /api/sessions/{id}/events/{eventId}/resend`). Absent otherwise.
   */
  readonly notSent?: true;
  /**
   * Additive (D57): the images and files the message carried (no bytes, no path;
   * served by `GET /api/sessions/{id}/attachments/{attachmentId}`), each with how
   * it reached the agent. A transcript's image without its bytes has `id: null`
   * (a placeholder). Absent on a message without attachments.
   */
  readonly attachments?: readonly Attachment[];
  /**
   * Additive (D57): the text as it went to the agent when that differs from
   * `text`: the message plus the attached files' paths (`Attached files: …`).
   * Absent otherwise.
   */
  readonly sentText?: string;
}

/** Assistant text; the text blocks of one `message.id` are merged into one event. */
export interface AssistantPayload {
  readonly type: 'assistant';
  readonly text: string;
  readonly messageId: string | null;
  /**
   * Additive (Fix · long messages): `true` = the text was cut at
   * {@link MESSAGE_TEXT_LIMIT}; `false` = restored from the transcript and whole.
   * Absent on whole new text, and on events stored before the fix, whose text was
   * cut at {@link PAYLOAD_TEXT_LIMIT} when longer ({@link textCutAt}).
   */
  readonly truncated?: boolean;
}

/** A subagent's prompt (a `user` text line carrying `parent_tool_use_id`). */
export interface AgentPromptPayload {
  readonly type: 'agent-prompt';
  readonly text: string;
  /** Additive (Fix · long messages): as {@link AssistantPayload.truncated}. */
  readonly truncated?: boolean;
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
  /** D24: the request was answered outside Switchboard (`claude.ai`: Remote Control; its state is `cancelled`). */
  readonly answeredOn?: AnsweredOn;
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
  /** D24: the request was answered outside Switchboard (`claude.ai`: Remote Control; its state is `cancelled`). */
  readonly answeredOn?: AnsweredOn;
}

/** An automatic denial (`system/permission_denied`). */
export interface DeniedPayload {
  readonly type: 'denied';
  readonly toolName: string | null;
  readonly toolUseId: string | null;
  readonly message: string | null;
  /** The CLI's `decision_reason` (`Classifier unavailable`: auto mode's check gave no verdict). */
  readonly decisionReason?: string | null;
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
  /**
   * Additive (D50): the developer stopped this turn (Stop / Esc): the CLI's
   * interrupted result (`error_during_execution`, `terminal_reason` `aborted_*`).
   * The event is the chat's small "Stopped" line, kind `text`, and not a failure.
   */
  readonly stopped?: true;
}

/**
 * D50: a Stop the CLI did not acknowledge in time (kind `error`): the chat's error
 * line; the composer offers Pause, which ends the process (D7). Nothing is killed.
 */
export interface StopPayload {
  readonly type: 'stop';
  readonly outcome: 'timeout';
  /** How long Switchboard waited (ms). */
  readonly waitedMs: number;
  /** What did not come: the interrupt's `control_response`, or the interrupted turn's `result`. */
  readonly missing: 'ack' | 'result';
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
  | 'not-resumed'
  /** D16: a terminal conversation continued in Switchboard (`--resume` of its id, no message). */
  | 'moved'
  /** D25: a local copy of a remote session was started (`--teleport <session_X>`; `message` names the remote session). */
  | 'teleported'
  /** D33: the developer closed the session (its process, if any, was stopped as by Pause first). */
  | 'closed'
  /** D33: the developer reopened a closed session (no process is started). */
  | 'reopened'
  /** D62 P5: the session switched to another CLI (the chat's divider; `from`, `to`, `handoverBy`). */
  | 'switched'
  /** D63: the session moved to another account profile of its CLI (the chat's divider; `fromProfile`, `toProfile`, `reason`). */
  | 'account-switched'
  /** D65: the session was taken over from another machine (the chat's divider "Taken over from <machine>"; `fromMachine`). */
  | 'taken-over'
  /** D65: the session was taken over to another machine (a note on the closed source session: "Moved to <machine>"). */
  | 'moved-away'
  /** D72: a hooked terminal session now runs under Switchboard (`--resume` of its id; the chat's divider "Continued in Switchboard (was a terminal session)"). */
  | 'continued'
  /** D83: the new session of a continuation started (the chat's divider "Continued from <old session>"; `linkedSessionId`, `linkedTitle`). */
  | 'continued-from'
  /** D83: the session was continued in a fresh one and closed (the divider "Continued in <new session>"; `linkedSessionId`, `linkedTitle`). */
  | 'continued-in';

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
  /** D62 P5 (`switched`): the CLI the session left, the one it runs on now, who wrote the handover, the exported chat. */
  readonly from?: CliProviderId;
  readonly to?: CliProviderId;
  readonly handoverBy?: HandoverSource;
  readonly exportPath?: string | null;
  /** D63 (`account-switched`): the profile names the session left and runs on now, and why ("session limit, resets 14:05"). */
  readonly fromProfile?: string;
  readonly toProfile?: string;
  readonly reason?: string;
  /** D65 (`taken-over` / `moved-away`): the other machine's name and the session's id there. */
  readonly machine?: string;
  readonly machineId?: string;
  readonly remoteSessionId?: string;
  /** D83 (`continued-from` / `continued-in`): the other session of the continuation (its id on the same machine; a peer's is namespaced in the UI) and its title then. */
  readonly linkedSessionId?: string;
  readonly linkedTitle?: string;
}

/** `system/init.permissionMode` differs from the requested mode (D6: an unsupported `auto` silently becomes `default`). */
export interface ModeMismatchPayload {
  readonly type: 'mode-mismatch';
  readonly requested: string;
  readonly observed: string | null;
  /** Set when Switchboard switched to this mode itself (D6: `auto` → `acceptEdits`); the event is `text`, not `error`. */
  readonly fallback?: string;
}

/**
 * D24: Remote Control on the session's process was turned on or off, or a
 * `remote_control` request failed (`docs/remote-control.md`). The event is `text`
 * (on / off) or `error` (failed); the chat shows it as a step line.
 */
export interface RemotePayload {
  readonly type: 'remote';
  readonly action: 'on' | 'off' | 'failed';
  /** `true` when the request reattached a stored claude.ai entry (`reattach_session_id`), e.g. after a resume. */
  readonly reattach?: boolean;
  /** `on`: the claude.ai link. */
  readonly url?: string;
  /** `failed`: what was asked (`true` = turn on / reconnect, `false` = turn off). */
  readonly enabled?: boolean;
  /** `failed`: the CLI's error text, verbatim (or why there was no reply). */
  readonly error?: string;
}

/**
 * D31: the session's model or effort was changed (`PUT /api/sessions/{id}/model`,
 * `docs/model-effort.md`), or the CLI refused the change. The event is `text`
 * (changed) or `error` (failed); the chat shows it as a step line
 * (`Model: Opus 5.5 · effort: high`, `Could not change the model: <CLI text>`).
 */
export interface ModelPayload {
  readonly type: 'model';
  readonly action: 'changed' | 'failed';
  /** `changed`: the stored model now (`null` = the CLI's default); `failed`: the one that was asked for. */
  readonly model: string | null;
  /** `changed`: the stored effort now (`null` = the CLI's default); `failed`: the one that was asked for. */
  readonly effort: string | null;
  /** `changed`: `true` when the live process took it (control requests), `false` when it was only stored for the next spawn. */
  readonly live?: boolean;
  /** `failed`: the control request the CLI refused (`set_model` or `apply_flag_settings`). */
  readonly request?: 'set_model' | 'apply_flag_settings';
  /** `failed`: the CLI's error text, verbatim (or why there was no reply). */
  readonly error?: string;
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
  | ModeMismatchPayload
  | RemotePayload
  | ModelPayload
  | StopPayload;

/** `text` cut to {@link PAYLOAD_TEXT_LIMIT} characters. */
export function clip(text: string, limit = PAYLOAD_TEXT_LIMIT): { text: string; truncated: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}

/** Fix · long messages: message text cut to the safety cap {@link MESSAGE_TEXT_LIMIT} (stored in full below it). */
export function clipMessage(text: string): { text: string; truncated: boolean } {
  return clip(text, MESSAGE_TEXT_LIMIT);
}

/**
 * Fix · long messages: where a message event's text (assistant text, a subagent's
 * prompt) was cut, in characters; `null` when it is whole (or the payload is no
 * message text). A payload flagged `truncated: true` was cut at its length (the
 * cap); an unflagged one exactly {@link PAYLOAD_TEXT_LIMIT} long was stored before
 * the fix, when every message was cut there (a message of exactly that length
 * reads as cut too: restoring it marks it `truncated: false`).
 */
export function textCutAt(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as { type?: unknown; text?: unknown; truncated?: unknown };
  if ((record.type !== 'assistant' && record.type !== 'agent-prompt') || typeof record.text !== 'string') return null;
  if (record.truncated === true) return record.text.length;
  return record.truncated === undefined && record.text.length === PAYLOAD_TEXT_LIMIT ? PAYLOAD_TEXT_LIMIT : null;
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
