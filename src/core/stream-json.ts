/**
 * Typed view of the Claude Code CLI's stream-json stdout (`--output-format
 * stream-json --verbose`, CLI 2.1.283; `docs/spike-m0.md` → *Stream-json output*
 * and *The control protocol*). One stdout line = one JSON object =
 * one {@link StreamMessage}. The parser never throws: a line that is not JSON is
 * an `invalid` message, and a JSON object of a type it does not know is `other`,
 * so a newer CLI that adds message types keeps working.
 *
 * Every message keeps the parsed object as `raw`, verbatim, for callers that need
 * a field this view does not lift out.
 */

/** A parsed JSON object. */
export type JsonRecord = Record<string, unknown>;

/** One content block of an `assistant` line (the CLI writes one block per line). */
export type AssistantBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking' }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: JsonRecord }
  | { readonly type: 'other'; readonly blockType: string };

/** One `tool_result` block of a `user` line. */
export interface ToolResultBlock {
  readonly toolUseId: string;
  /** The result content as text (string content, or the text blocks joined with `\n`). */
  readonly text: string;
  readonly isError: boolean;
}

/** A usage window of a `rate_limit_event` (utilization 0–1, reset as epoch seconds). */
export interface RateLimitWindow {
  readonly utilization: number | null;
  readonly resetsAt: number | null;
}

/** The fields shared by every parsed message. */
interface Base {
  /** The object as parsed. */
  readonly raw: JsonRecord;
  /** The line's `uuid`, when it has one (every line but `control_*`). */
  readonly uuid: string | null;
  /** The line's `session_id`, when it has one. */
  readonly sessionId: string | null;
}

/** `system/init`: repeated at the start of every turn (a metadata refresh, not a new session). */
export interface InitMessage extends Base {
  readonly kind: 'init';
  readonly cwd: string | null;
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly tools: readonly string[];
  readonly version: string | null;
}

/** `system/hook_started` / `system/hook_response`. */
export interface HookMessage extends Base {
  readonly kind: 'hook';
  readonly phase: 'started' | 'response';
  readonly hookName: string | null;
}

/** `assistant`: one content block; lines of one message share `messageId`. */
export interface AssistantMessage extends Base {
  readonly kind: 'assistant';
  readonly messageId: string | null;
  readonly model: string | null;
  /** The Agent `tool_use` id when a subagent wrote the line, else `null` (main agent). */
  readonly parentToolUseId: string | null;
  readonly blocks: readonly AssistantBlock[];
}

/** `user` carrying `tool_result` blocks. */
export interface ToolResultMessage extends Base {
  readonly kind: 'tool-result';
  readonly parentToolUseId: string | null;
  readonly results: readonly ToolResultBlock[];
  /** The structured `tool_use_result`, verbatim. */
  readonly toolUseResult: unknown;
}

/** `user` with `isReplay: true`: the CLI took up a stdin message (`--replay-user-messages`). */
export interface ReplayMessage extends Base {
  readonly kind: 'replay';
  readonly text: string;
}

/**
 * Any other `user` line: an interrupt marker (`[Request interrupted by user…]`),
 * a subagent's prompt (with `parentToolUseId`), or text the parser does not classify.
 */
export interface UserTextMessage extends Base {
  readonly kind: 'user-text';
  readonly parentToolUseId: string | null;
  readonly text: string;
  /** `true` for `[Request interrupted by user]` and `[Request interrupted by user for tool use]`. */
  readonly interrupt: boolean;
}

/** `result/*`: ends a turn. */
export interface ResultMessage extends Base {
  readonly kind: 'result';
  /** `success`, `error_max_turns`, `error_during_execution`, … */
  readonly subtype: string;
  readonly isError: boolean;
  /** The final text (`result`), absent on error results. */
  readonly text: string | null;
  readonly terminalReason: string | null;
  readonly errors: readonly string[];
  /** `origin.kind === "task-notification"`: no stdin message behind it (a background agent finished). */
  readonly taskNotification: boolean;
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  readonly totalCostUsd: number | null;
}

/** `rate_limit_event`: a usage reading. */
export interface RateLimitMessage extends Base {
  readonly kind: 'rate-limit';
  readonly status: string | null;
  readonly fiveHour: RateLimitWindow | null;
  readonly sevenDay: RateLimitWindow | null;
}

/** `control_request` with `request.subtype === "can_use_tool"`: a question batch or a permission request. */
export interface CanUseToolMessage extends Base {
  readonly kind: 'can-use-tool';
  readonly requestId: string;
  readonly toolName: string;
  /** The tool input, verbatim. */
  readonly input: JsonRecord;
  readonly toolUseId: string | null;
  /** A subagent's task id when a subagent asks (M0.2 `subagent-perm`). */
  readonly agentId: string | null;
  readonly description: string | null;
  readonly decisionReason: string | null;
}

/** Any other `control_request` the CLI sends (answered with an error by the supervisor). */
export interface ControlRequestMessage extends Base {
  readonly kind: 'control-request';
  readonly requestId: string;
  readonly subtype: string;
  readonly request: JsonRecord;
}

/** `control_cancel_request`: the CLI withdrew an open request (after an interrupt). */
export interface ControlCancelMessage extends Base {
  readonly kind: 'control-cancel';
  readonly requestId: string;
}

/** `control_response`: the CLI's reply to a stdin `control_request` (interrupt, get_usage, …). */
export interface ControlResponseMessage extends Base {
  readonly kind: 'control-response';
  readonly requestId: string;
  /** `success` or `error`. */
  readonly subtype: string;
  readonly response: JsonRecord | null;
  readonly error: string | null;
}

/** `system/task_started`: a subagent (`local_agent`) or a background shell (`local_bash`) started. */
export interface TaskStartedMessage extends Base {
  readonly kind: 'task-started';
  readonly taskId: string;
  readonly toolUseId: string | null;
  readonly description: string | null;
  readonly taskType: string | null;
  readonly subagentType: string | null;
  readonly backgrounded: boolean;
}

/** `system/task_progress`. */
export interface TaskProgressMessage extends Base {
  readonly kind: 'task-progress';
  readonly taskId: string;
  readonly toolUseId: string | null;
  readonly description: string | null;
  readonly lastToolName: string | null;
}

/** `system/task_updated` (`patch.status`: `completed`, `killed`, …). */
export interface TaskUpdatedMessage extends Base {
  readonly kind: 'task-updated';
  readonly taskId: string;
  readonly status: string | null;
}

/** `system/task_notification`: the task's final summary. */
export interface TaskNotificationMessage extends Base {
  readonly kind: 'task-notification';
  readonly taskId: string;
  readonly toolUseId: string | null;
  readonly status: string | null;
  readonly summary: string | null;
}

/** `system/permission_denied`: an automatic denial (no permission host asked). */
export interface PermissionDeniedMessage extends Base {
  readonly kind: 'permission-denied';
  readonly toolName: string | null;
  readonly toolUseId: string | null;
  readonly message: string | null;
}

/** Any JSON object the parser does not lift (`system/thinking_tokens`, `system/commands_changed`, …). */
export interface OtherMessage extends Base {
  readonly kind: 'other';
  readonly type: string;
  readonly subtype: string | null;
}

/** A line that is not a JSON object. */
export interface InvalidLine {
  readonly kind: 'invalid';
  readonly line: string;
  readonly raw: null;
  readonly uuid: null;
  readonly sessionId: null;
}

/** One parsed stdout line. */
export type StreamMessage =
  | InitMessage
  | HookMessage
  | AssistantMessage
  | ToolResultMessage
  | ReplayMessage
  | UserTextMessage
  | ResultMessage
  | RateLimitMessage
  | CanUseToolMessage
  | ControlRequestMessage
  | ControlCancelMessage
  | ControlResponseMessage
  | TaskStartedMessage
  | TaskProgressMessage
  | TaskUpdatedMessage
  | TaskNotificationMessage
  | PermissionDeniedMessage
  | OtherMessage
  | InvalidLine;

/** The interrupt markers the CLI writes as `user` text (M0.1). */
export const INTERRUPT_MARKERS: readonly string[] = [
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rec(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

/** Text of a message `content`: the string itself, or the `text` blocks joined with `\n`. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is JsonRecord => isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string')
    .map((block) => block['text'] as string)
    .join('\n');
}

function assistantBlock(block: unknown): AssistantBlock {
  if (!isRecord(block)) return { type: 'other', blockType: typeof block };
  const type = str(block['type']) ?? '';
  if (type === 'text') return { type: 'text', text: str(block['text']) ?? '' };
  if (type === 'thinking' || type === 'redacted_thinking') return { type: 'thinking' };
  if (type === 'tool_use') {
    return { type: 'tool_use', id: str(block['id']) ?? '', name: str(block['name']) ?? '', input: rec(block['input']) ?? {} };
  }
  return { type: 'other', blockType: type };
}

function toolResultBlock(block: JsonRecord): ToolResultBlock {
  return {
    toolUseId: str(block['tool_use_id']) ?? '',
    text: contentText(block['content']),
    isError: block['is_error'] === true,
  };
}

function rateWindow(value: unknown): RateLimitWindow | null {
  const window = rec(value);
  if (!window) return null;
  return { utilization: num(window['utilization']), resetsAt: num(window['resetsAt']) };
}

function parseUser(obj: JsonRecord, base: Base): StreamMessage {
  const message = rec(obj['message']);
  const content = message?.['content'];
  const parentToolUseId = str(obj['parent_tool_use_id']);
  if (obj['isReplay'] === true) return { ...base, kind: 'replay', text: contentText(content) };
  if (Array.isArray(content)) {
    const results = content.filter((b): b is JsonRecord => isRecord(b) && b['type'] === 'tool_result').map(toolResultBlock);
    if (results.length > 0) {
      return { ...base, kind: 'tool-result', parentToolUseId, results, toolUseResult: obj['tool_use_result'] };
    }
  }
  const text = contentText(content);
  return { ...base, kind: 'user-text', parentToolUseId, text, interrupt: INTERRUPT_MARKERS.includes(text.trim()) };
}

function parseSystem(obj: JsonRecord, base: Base, subtype: string | null): StreamMessage {
  switch (subtype) {
    case 'init':
      return {
        ...base,
        kind: 'init',
        cwd: str(obj['cwd']),
        model: str(obj['model']),
        permissionMode: str(obj['permissionMode']),
        tools: Array.isArray(obj['tools']) ? obj['tools'].filter((t): t is string => typeof t === 'string') : [],
        version: str(obj['claude_code_version']),
      };
    case 'hook_started':
    case 'hook_response':
      return { ...base, kind: 'hook', phase: subtype === 'hook_started' ? 'started' : 'response', hookName: str(obj['hook_name']) };
    case 'task_started':
      return {
        ...base,
        kind: 'task-started',
        taskId: str(obj['task_id']) ?? '',
        toolUseId: str(obj['tool_use_id']),
        description: str(obj['description']),
        taskType: str(obj['task_type']),
        subagentType: str(obj['subagent_type']),
        backgrounded: obj['is_backgrounded'] === true,
      };
    case 'task_progress':
      return {
        ...base,
        kind: 'task-progress',
        taskId: str(obj['task_id']) ?? '',
        toolUseId: str(obj['tool_use_id']),
        description: str(obj['description']),
        lastToolName: str(obj['last_tool_name']),
      };
    case 'task_updated':
      return { ...base, kind: 'task-updated', taskId: str(obj['task_id']) ?? '', status: str(rec(obj['patch'])?.['status']) };
    case 'task_notification':
      return {
        ...base,
        kind: 'task-notification',
        taskId: str(obj['task_id']) ?? '',
        toolUseId: str(obj['tool_use_id']),
        status: str(obj['status']),
        summary: str(obj['summary']),
      };
    case 'permission_denied':
      return {
        ...base,
        kind: 'permission-denied',
        toolName: str(obj['tool_name']),
        toolUseId: str(obj['tool_use_id']),
        message: str(obj['message']),
      };
    default:
      return { ...base, kind: 'other', type: 'system', subtype };
  }
}

function parseControlRequest(obj: JsonRecord, base: Base): StreamMessage {
  const requestId = str(obj['request_id']) ?? '';
  const request = rec(obj['request']) ?? {};
  const subtype = str(request['subtype']) ?? '';
  if (subtype === 'can_use_tool') {
    return {
      ...base,
      kind: 'can-use-tool',
      requestId,
      toolName: str(request['tool_name']) ?? '',
      input: rec(request['input']) ?? {},
      toolUseId: str(request['tool_use_id']),
      agentId: str(request['agent_id']),
      description: str(request['description']),
      decisionReason: str(request['decision_reason']),
    };
  }
  return { ...base, kind: 'control-request', requestId, subtype, request };
}

/** Parses an already-decoded stdout object. */
export function parseStreamObject(obj: JsonRecord): StreamMessage {
  const type = str(obj['type']) ?? '';
  const subtype = str(obj['subtype']);
  const base: Base = { raw: obj, uuid: str(obj['uuid']), sessionId: str(obj['session_id']) };
  switch (type) {
    case 'system':
      return parseSystem(obj, base, subtype);
    case 'assistant': {
      const message = rec(obj['message']);
      const content = message?.['content'];
      return {
        ...base,
        kind: 'assistant',
        messageId: str(message?.['id']),
        model: str(message?.['model']),
        parentToolUseId: str(obj['parent_tool_use_id']),
        blocks: Array.isArray(content) ? content.map(assistantBlock) : [],
      };
    }
    case 'user':
      return parseUser(obj, base);
    case 'result': {
      const origin = rec(obj['origin']);
      return {
        ...base,
        kind: 'result',
        subtype: subtype ?? '',
        isError: obj['is_error'] === true,
        text: str(obj['result']),
        terminalReason: str(obj['terminal_reason']),
        errors: Array.isArray(obj['errors']) ? obj['errors'].filter((e): e is string => typeof e === 'string') : [],
        taskNotification: origin?.['kind'] === 'task-notification',
        numTurns: num(obj['num_turns']),
        durationMs: num(obj['duration_ms']),
        totalCostUsd: num(obj['total_cost_usd']),
      };
    }
    case 'rate_limit_event': {
      const info = rec(obj['rate_limit_info']);
      const windows = rec(info?.['unifiedWindows']);
      return {
        ...base,
        kind: 'rate-limit',
        status: str(info?.['status']),
        fiveHour: rateWindow(windows?.['five_hour']),
        sevenDay: rateWindow(windows?.['seven_day']),
      };
    }
    case 'control_request':
      return parseControlRequest(obj, base);
    case 'control_cancel_request':
      return { ...base, kind: 'control-cancel', requestId: str(obj['request_id']) ?? '' };
    case 'control_response': {
      const response = rec(obj['response']) ?? {};
      return {
        ...base,
        kind: 'control-response',
        requestId: str(response['request_id']) ?? '',
        subtype: str(response['subtype']) ?? '',
        response: rec(response['response']),
        error: str(response['error']),
      };
    }
    default:
      return { ...base, kind: 'other', type, subtype };
  }
}

/** Parses one stdout line (without its newline). Never throws. */
export function parseStreamLine(line: string): StreamMessage {
  const text = line.trim();
  const invalid: InvalidLine = { kind: 'invalid', line, raw: null, uuid: null, sessionId: null };
  if (!text.startsWith('{')) return invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid;
  }
  return isRecord(parsed) ? parseStreamObject(parsed) : invalid;
}

/**
 * Splits a stdout byte stream into lines. Feed decoded chunks with `push`; each
 * complete line (without `\n` or `\r\n`) is passed to `onLine`. `flush` passes a
 * trailing line that has no newline.
 */
export class LineSplitter {
  #partial = '';
  readonly #onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  push(chunk: string): void {
    this.#partial += chunk;
    let nl = this.#partial.indexOf('\n');
    while (nl >= 0) {
      const line = this.#partial.slice(0, nl).replace(/\r$/, '');
      this.#partial = this.#partial.slice(nl + 1);
      if (line.trim() !== '') this.#onLine(line);
      nl = this.#partial.indexOf('\n');
    }
  }

  flush(): void {
    const rest = this.#partial;
    this.#partial = '';
    if (rest.trim() !== '') this.#onLine(rest);
  }
}
