/**
 * Background work (D30; `docs/derivations.md` → *Background work*): the tasks the
 * main agent started in the background and whose end the CLI has not reported yet,
 * derived in memory from the process's stream-json and never guessed. The recorder
 * feeds a {@link BackgroundTracker}; its {@link BackgroundTracker.list} is
 * `Session.activity.background`, and while no turn runs a non-empty list makes the
 * session's activity `background` (`ActivityTracker.snapshot`). Pure: the clock
 * is injected, nothing is stored.
 *
 * What the CLI 2.1.283 streams (the D30 probe, `tools/fake-claude/fixtures/bg-bash.ndjson`):
 * the call's `tool_use`, then its `tool_result` confirming the start (`Command
 * running in background with ID: <id>` with `tool_use_result.backgroundTaskId`,
 * `Async agent launched successfully` with `tool_use_result.agentId`, `Monitor
 * started (task <id>, …)`); when the task ends, `system/task_notification`
 * (`task_id`, `tool_use_id`, `status`), then the CLI's own turn. The
 * `<task-notification>` user message that turn answers is written to the
 * transcript only, never to stdout (not even with `--replay-user-messages`); a
 * stdout `user` line with that text is handled anyway ({@link parseTaskNotification}).
 */
import type { BackgroundTask, BackgroundTaskKind } from '../api.ts';
import { SUMMARY_MAX, toolSummary } from './activity.ts';
import { isTaskFinished } from './agents.ts';
import { AGENT_TOOLS } from './event-kind.ts';

/** A command that waits for GitHub Actions (D30): `gh run …`, `gh pr checks …`, `gh workflow …`. */
const GITHUB_WAIT = /\bgh\s+(?:run|pr\s+checks|workflow)\b/;

/**
 * A `Bash` result that confirms a background start (the CLI's four wordings: run
 * in the background, backgrounded by the user, moved to the background for a
 * message, moved to the background after its timeout); group 1 = the task id.
 */
const BASH_STARTED =
  /Command (?:running in background with ID: |was manually backgrounded by user with ID: |was moved to the background \(ID: |did not complete within its \d+s timeout and was moved to the background \(ID: )([A-Za-z0-9_-]+)/;

/**
 * The CLI's wordings for a background command that ends with the turn (no
 * notification can follow once the agent gave its final response): not a wait.
 */
const ENDS_WITH_TURN = /terminated when you give your final response|stopped when your turn ends|reaches you between your tool calls if it exits in time/;

/** An async `Agent` / `Task` launch; the `agentId: <id>` in its text. */
const AGENT_LAUNCHED = 'Async agent launched successfully';
const AGENT_ID = /agentId: ([A-Za-z0-9_-]+)/;

/**
 * `true` when an `Agent` / `Task` call's `tool_result` text is the CLI's async
 * launch notice ("Async agent launched successfully …"): the agent runs in the
 * background, so the text is no result of its work (D36: its chat shows no
 * Result block).
 */
export function isAsyncAgentLaunch(text: string): boolean {
  return text.includes(AGENT_LAUNCHED);
}

/** A `Monitor` start; group 1 = the task id. */
const MONITOR_STARTED = /Monitor started \(task ([^,\s)]+)/;

/** The tools that can start background work, by kind. */
function kindOf(name: string): BackgroundTaskKind | null {
  if (name === 'Bash') return 'bash';
  if (AGENT_TOOLS.includes(name)) return 'agent';
  if (name === 'Monitor') return 'monitor';
  if (name === 'ScheduleWakeup') return 'wakeup';
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstLine(value: string): string {
  return value.trim().split('\n', 1)[0]?.trim() ?? '';
}

function clip(value: string): string {
  return value.length > SUMMARY_MAX ? `${value.slice(0, SUMMARY_MAX - 1)}…` : value;
}

/** `true` when a shell command waits for GitHub Actions: it runs `gh run`, `gh pr checks` or `gh workflow` (D30). */
export function isGithubWait(command: string): boolean {
  return GITHUB_WAIT.test(command);
}

/**
 * The `gh …` command inside a GitHub wait, up to the next shell separator
 * (`;`, `|`, `&`, `)`, a line break): `cd repo && for i in $(seq 1 60); do gh run
 * view 42 --json status; sleep 20; done` → `gh run view 42 --json status`. At most
 * {@link SUMMARY_MAX} characters; `null` when the command has none.
 */
export function githubCommand(command: string): string | null {
  const match = GITHUB_WAIT.exec(command);
  if (!match) return null;
  const rest = command.slice(match.index);
  const end = rest.search(/[;|&)\n]/);
  return clip((end < 0 ? rest : rest.slice(0, end)).trim());
}

/**
 * A background task's summary: a GitHub wait → its `gh …` command; any other
 * `Bash` / `Agent` → D19's {@link toolSummary} (the command's first line, the
 * description); a `Monitor` → its description, else its command's first line; a
 * `ScheduleWakeup` → its reason's first line; else the tool name.
 */
export function backgroundSummary(name: string, input: Readonly<Record<string, unknown>>): string {
  const kind = kindOf(name);
  const command = str(input['command']);
  const gh = command && (kind === 'bash' || kind === 'monitor') ? githubCommand(command) : null;
  if (gh) return gh;
  if (kind === 'monitor') {
    const text = str(input['description']) ?? command;
    return clip(text ? firstLine(text) : name);
  }
  if (kind === 'wakeup') {
    const reason = str(input['reason']);
    return clip(reason ? firstLine(reason) : name);
  }
  return toolSummary(name, input);
}

/** A task end the CLI reported (`system/task_notification`, or a `<task-notification>` text). */
export interface TaskNotification {
  readonly taskId: string | null;
  readonly toolUseId: string | null;
  readonly status: string | null;
}

function tag(text: string, name: string): string | null {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(text);
  return match?.[1]?.trim() || null;
}

/**
 * A `<task-notification>` message (the text the CLI gives the model when a
 * background task ends, as in the transcript): its `<task-id>`, `<tool-use-id>`
 * and `<status>`; `null` for any other text.
 */
export function parseTaskNotification(text: string): TaskNotification | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<task-notification>')) return null;
  const taskId = tag(trimmed, 'task-id');
  const toolUseId = tag(trimmed, 'tool-use-id');
  if (taskId === null && toolUseId === null) return null;
  return { taskId, toolUseId, status: tag(trimmed, 'status') };
}

/**
 * `true` when a `<task-notification>` text ends its task: a final status
 * (`completed`, `failed`, `killed`, `stopped`, …; `isTaskFinished`). A monitor's
 * event notices (no final status) leave the monitor pending.
 */
export function endsTask(notification: TaskNotification): boolean {
  return isTaskFinished(notification.status);
}

/** A background call's `tool_result`, as the recorder has it. */
export interface BackgroundResult {
  /** The result content as text. */
  readonly text: string;
  readonly isError: boolean;
  /** The line's structured `tool_use_result` (`backgroundTaskId`, `agentId`, …), when the line held only this result. */
  readonly detail?: unknown;
}

/** What a confirmed start adds: the task's id, or `null` when the result does not confirm a background start. */
function startedId(kind: BackgroundTaskKind, result: BackgroundResult, input: Readonly<Record<string, unknown>>, toolUseId: string): string | null {
  if (result.isError) return null;
  const detail = record(result.detail);
  switch (kind) {
    case 'bash': {
      const id = str(detail?.['backgroundTaskId']) ?? BASH_STARTED.exec(result.text)?.[1] ?? null;
      return id !== null && !ENDS_WITH_TURN.test(result.text) ? id : null;
    }
    case 'agent': {
      if (detail?.['status'] !== 'async_launched' && !result.text.includes(AGENT_LAUNCHED)) return null;
      return str(detail?.['agentId']) ?? AGENT_ID.exec(result.text)?.[1] ?? toolUseId;
    }
    case 'monitor': {
      const match = MONITOR_STARTED.exec(result.text);
      return match ? (str(detail?.['taskId']) ?? match[1] ?? toolUseId) : null;
    }
    case 'wakeup': {
      const delay = input['delaySeconds'];
      if (input['stop'] === true || typeof delay !== 'number' || !Number.isFinite(delay) || delay <= 0) return null;
      return toolUseId;
    }
  }
}

/** Options for {@link BackgroundTracker}. */
export interface BackgroundTrackerOptions {
  /** Clock (tests pass a fake one). */
  readonly now?: () => Date;
}

interface Call {
  readonly kind: BackgroundTaskKind;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly startedAt: Date;
  /** The CLI reported the task's end before its `tool_result` confirmed the start. */
  ended: boolean;
}

/**
 * The main agent's pending background tasks (D30):
 * - **added** from a `tool_use` ({@link called}) plus the `tool_result` that
 *   confirms the background start ({@link resulted}): a `Bash` whose result says it
 *   runs in the background (not one the CLI ends with the turn), an async `Agent` /
 *   `Task`, a `Monitor`, a `ScheduleWakeup` (`wakeAt` = the call's time +
 *   `delaySeconds`; not with `stop: true`);
 * - **removed** on its task notification ({@link notified}: the `tool_use` id,
 *   else the task id), for a wake-up when the next turn starts
 *   ({@link turnStarted}), and all of them when the process ends ({@link clear}).
 *   A `Monitor` stays until its own notification.
 */
export class BackgroundTracker {
  readonly #now: () => Date;
  /** Calls that may start background work, by `tool_use` id, until their result. */
  readonly #calls = new Map<string, Call>();
  /** Pending tasks by `tool_use` id, in start order. */
  readonly #tasks = new Map<string, BackgroundTask>();

  constructor(options: BackgroundTrackerOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  /** A main-agent `tool_use`: remembered when its tool can start background work. */
  called(toolUseId: string, name: string, input: Readonly<Record<string, unknown>>): void {
    const kind = kindOf(name);
    if (kind === null || toolUseId === '') return;
    this.#calls.set(toolUseId, { kind, name, input, startedAt: this.#now(), ended: false });
  }

  /** The `tool_result` of a call: adds the task when it confirms a background start. Returns `true` when a task was added. */
  resulted(toolUseId: string, result: BackgroundResult): boolean {
    const call = this.#calls.get(toolUseId);
    if (!call) return false;
    this.#calls.delete(toolUseId);
    if (call.ended) return false;
    const id = startedId(call.kind, result, call.input, toolUseId);
    if (id === null) return false;
    const command = str(call.input['command']);
    const github = command !== null && (call.kind === 'bash' || call.kind === 'monitor') && isGithubWait(command);
    const delay = call.input['delaySeconds'];
    const task: BackgroundTask = {
      id,
      toolUseId,
      kind: call.kind,
      summary: backgroundSummary(call.name, call.input),
      startedAt: call.startedAt.toISOString(),
      ...(call.kind === 'wakeup' && typeof delay === 'number' ? { wakeAt: new Date(call.startedAt.getTime() + delay * 1000).toISOString() } : {}),
      github,
    };
    this.#tasks.set(toolUseId, task);
    return true;
  }

  /**
   * The CLI reported a task's end: the pending task with that `tool_use` id, else
   * with that task id, is removed. A call still waiting for its result is marked,
   * so its result adds nothing. Returns `true` when a pending task was removed.
   */
  notified(taskId: string | null, toolUseId: string | null): boolean {
    if (toolUseId !== null && this.#tasks.delete(toolUseId)) return true;
    if (taskId !== null) {
      for (const [key, task] of this.#tasks) {
        if (task.id === taskId) {
          this.#tasks.delete(key);
          return true;
        }
      }
    }
    const call = toolUseId !== null ? this.#calls.get(toolUseId) : undefined;
    if (call) call.ended = true;
    return false;
  }

  /** A new turn started: the wake-ups have fired (or a message came first); calls of the earlier turn without a result are dropped. */
  turnStarted(): void {
    for (const [key, task] of this.#tasks) if (task.kind === 'wakeup') this.#tasks.delete(key);
    this.#calls.clear();
  }

  /** The process ended (exit, pause): nothing is pending any more. */
  clear(): void {
    this.#calls.clear();
    this.#tasks.clear();
  }

  /** The pending tasks, oldest first. */
  list(): BackgroundTask[] {
    // A stable sort: tasks started in the same millisecond keep their start order.
    return [...this.#tasks.values()].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  }
}
