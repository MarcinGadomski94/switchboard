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
 *
 * D43 (CLI 2.1.284, read in its code): a background `Workflow` call's result is
 * `Workflow launched in background. Task ID: <id>\nSummary: <meta.description>…`
 * (`tool_use_result` `{status: "async_launched", taskId, taskType: "local_workflow",
 * workflowName, runId, summary, …}`), and every task the CLI runs streams a
 * `system/task_started` (`task_type` `local_bash`, `local_agent`, `local_workflow`,
 * `remote_agent`, `monitor_mcp`, `mcp_task`, …) and, once, a terminal
 * `system/task_updated` + `system/task_notification`. So every background
 * `task_started` starts a pending task too ({@link BackgroundTracker.started}), unless
 * the call that started it registers it (matched by task id or `tool_use_id`).
 */
import type { BackgroundTask, BackgroundTaskKind, SessionActivity } from '../api.ts';
import { SUMMARY_MAX, toolSummary } from './activity.ts';
import { AGENT_TASK_TYPE, isTaskFinished } from './agents.ts';
import { AGENT_TOOLS } from './event-kind.ts';

/**
 * 2026-10-16 (`docs/derivations.md` → *Session status* → *Waiting on background work*):
 * a CLI-reported task that is no shell, no wake-up and no subagent (`mcp_task`, a type
 * Switchboard does not know) keeps the session `run` for at most this long without a sign
 * of life (its start, a `task_progress` / `task_updated`); then it reads as left running,
 * not waited on. D143: a shell never keeps `run` ({@link isShellTask}).
 */
export const BACKGROUND_WAIT_MS = 30 * 60_000;

/**
 * 2026-10-16: the stale guard of a wake-up (D143: GitHub waits, shells, no longer count):
 * 2 hours past its `wakeAt` it no longer keeps the session `run`. The same 2 hours as the
 * stale-subagent guard (`SUBAGENT_QUIET_MS`).
 */
export const BACKGROUND_QUIET_MS = 2 * 3600_000;

/**
 * 2026-10-16: a command the agent leaves running rather than waits on: a dev server or a
 * watcher (`npm run dev`, `pnpm start`, `next dev`, `vite` (not `vite build`), `dotnet watch` / `dotnet run`,
 * `docker compose up` without `-d`, `tail -f`, `nodemon`, `uvicorn`, `python -m
 * http.server`, any `--watch` that is no GitHub wait). Such a task never keeps `run`.
 */
const LONG_RUNNING = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b`,
    String.raw`\b(?:next|nuxt|astro|remix)\s+(?:dev|start)\b`,
    String.raw`\bvite(?!\s+(?:build|optimize)\b)(?:\s|$|[;&|)])`,
    String.raw`\bdotnet\s+(?:watch|run)\b`,
    String.raw`\bdocker(?:-|\s+)compose\s+up\b(?![^\n;&|]*\s-d\b)(?![^\n;&|]*--detach\b)`,
    String.raw`\b(?:tail|journalctl)\b[^\n;&|]*\s-f\b`,
    String.raw`\b(?:nodemon|uvicorn|gunicorn|http-server|live-server)\b`,
    String.raw`\bpython3?\s+-m\s+http\.server\b`,
    String.raw`\b(?:flask|rails)\s+(?:run|s|server)\b`,
    String.raw`\bwebpack(?:-dev-server|\s+serve)\b`,
    String.raw`--watch\b`,
  ].join('|'),
);

/**
 * `true` when a shell command is a dev server or a watcher the agent leaves running (2026-10-16),
 * never a GitHub wait. D127 classifies processes with it (`dev-server`); D143: no background
 * shell keeps `run` any more, this one or another.
 */
export function isLongRunningCommand(command: string): boolean {
  return !GITHUB_WAIT.test(command) && LONG_RUNNING.test(command);
}

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

/** 2026-10-16: the tool that resumes a background agent (its input's `to` = the agent id). */
const SEND_MESSAGE = 'SendMessage';

/**
 * 2026-10-16: a `SendMessage` result that says a background agent runs again (resumed, or
 * launched again in the background): its words, or its structured status. A message to a
 * teammate that runs no agent ("Message sent …") is not one.
 */
const AGENT_RESUMED = /\bresum(?:ed|ing)\b[^\n]*\bagent\b|\bagent\b[^\n]*\bresum(?:ed|ing)\b|Async agent launched|running in the background/i;
const RESUMED_STATUSES: readonly unknown[] = ['async_launched', 'resumed', 'running'];

/**
 * D123 (2026-10-20): a `SendMessage` result that refuses the resume ("Agent … was stopped by
 * the user and won't be resumed", "will not be resumed", "not resumed"): never a start, even
 * though its words name an agent and "resumed".
 */
const RESUME_REFUSED = /\b(?:won['’]?t|will\s+not|not|never|cannot|can['’]?t)\s+(?:be\s+)?resum(?:ed|ing|e)\b|\bstopped by the user\b/i;

/** D123: a message queued for a still running agent ("Message queued for delivery to <id> …"); group 1 = the id. */
const MESSAGE_QUEUED = /\bqueued for delivery to ([A-Za-z0-9_-]+)/i;

/** D123: what a `SendMessage` result says about the agent it addressed. */
type SendMessageOutcome =
  /** The CLI refused it (`success: false`, or refusing words): no run, whatever else the line says. */
  | { readonly kind: 'refused' }
  /** A run under `id`; `queued` = the message waits for a run that may still be pending. */
  | { readonly kind: 'start'; readonly id: string; readonly queued: boolean };

/** D123: the JSON object a `SendMessage` result's text may be (`{"success":…,"message":…}`), else `null`. */
function jsonObject(text: string): Readonly<Record<string, unknown>> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return record(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

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

/**
 * D43: a `Workflow` result that confirms a background launch (in this process, or in
 * a remote CCR session); group 1 = the task id.
 */
const WORKFLOW_LAUNCHED = /Workflow launched (?:in background|in a remote CCR session)\. Task ID: ([A-Za-z0-9_-]+)/;

/** D43: the `Summary: …` line of a `Workflow` launch; group 1 = the summary (the script's `meta.description`). */
const WORKFLOW_SUMMARY = /(?:^|\s)Summary: ([^\n]+)/;

/** D43: the `tool_use_result.status` of a `Workflow` launch. */
const WORKFLOW_LAUNCH_STATUSES: readonly unknown[] = ['async_launched', 'remote_launched'];

/** The tools that can start background work, by kind. */
function kindOf(name: string): BackgroundTaskKind | null {
  if (name === 'Bash') return 'bash';
  if (AGENT_TOOLS.includes(name)) return 'agent';
  // 2026-10-16: `SendMessage` to a background agent resumes it (a new run of the same task).
  if (name === SEND_MESSAGE) return 'agent';
  if (name === 'Monitor') return 'monitor';
  if (name === 'ScheduleWakeup') return 'wakeup';
  if (name === 'Workflow') return 'workflow';
  return null;
}

/** `system/task_started.task_type` of a shell (a background `Bash`, a `Monitor`). */
const BASH_TASK_TYPE = 'local_bash';

/** D143: a CLI-reported task type that is a shell or a watcher (`local_bash`, `monitor_mcp`, …). */
const SHELL_TASK_TYPE = /bash|shell|monitor/i;

/**
 * D143 (`docs/derivations.md` → *Session status* → *Waiting on background work*): a
 * background shell or watcher: a background `Bash` (a dev server, a build, a GitHub wait,
 * `sleep 300; …`), a `Monitor`, or a CLI-reported task of a shell type (`local_bash`,
 * `monitor_mcp`). Such a task never keeps the session working once its turn is over: the
 * agent is idle (or needs you / done) with a background app left running.
 */
export function isShellTask(kind: BackgroundTaskKind, taskType: string | null = null): boolean {
  return kind === 'bash' || kind === 'monitor' || (taskType !== null && SHELL_TASK_TYPE.test(taskType));
}

/** D43: a workflow's `task_type` (`local_workflow`). */
const WORKFLOW_TASK_TYPE = /workflow/;

/**
 * D43: the kind of a task the CLI reports by its `task_type`: `local_bash` → `bash`,
 * `local_agent` → `agent`, a workflow type (`local_workflow`) → `workflow`, anything
 * else (`remote_agent`, `monitor_mcp`, `mcp_task`, a type Switchboard does not know)
 * → `task`.
 */
export function taskKind(taskType: string | null): BackgroundTaskKind {
  if (taskType === BASH_TASK_TYPE) return 'bash';
  if (taskType === AGENT_TASK_TYPE) return 'agent';
  if (taskType !== null && WORKFLOW_TASK_TYPE.test(taskType)) return 'workflow';
  return 'task';
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
 * `ScheduleWakeup` → its reason's first line; D43: a `Workflow` → its description,
 * else its name (its result's `Summary:` comes first, {@link workflowSummary}); else
 * the tool name.
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
  if (kind === 'workflow') {
    const text = str(input['description']) ?? str(input['name']);
    return clip(text ? firstLine(text) : name);
  }
  return toolSummary(name, input);
}

/**
 * D43: a background `Workflow`'s summary: the result text's `Summary:` line (the
 * script's `meta.description`), else the result's structured `summary`, else the
 * `task_started` description, else the call's `description` / `name`
 * ({@link backgroundSummary}). At most {@link SUMMARY_MAX} characters.
 */
export function workflowSummary(result: BackgroundResult, input: Readonly<Record<string, unknown>>, startDescription: string | null = null): string {
  const detail = record(result.detail);
  const text = str(WORKFLOW_SUMMARY.exec(result.text)?.[1]) ?? str(detail?.['summary']) ?? str(startDescription);
  return text ? clip(firstLine(text)) : backgroundSummary('Workflow', input);
}

/** D43: a task the CLI reported (`system/task_started`), as the recorder has it. */
export interface TaskStart {
  /** `task_id`. */
  readonly taskId: string;
  /** `tool_use_id`: the call that started it; `null` when the line has none. */
  readonly toolUseId: string | null;
  /** `task_type` (`local_bash`, `local_agent`, `local_workflow`, …). */
  readonly taskType: string | null;
  readonly description: string | null;
  /** `is_backgrounded`: `false` for a foreground task (a foreground subagent, a long foreground shell); `null` when the line has none (a workflow's). */
  readonly backgrounded: boolean | null;
  /** `workflow_name`: a workflow's `meta.name`. */
  readonly workflowName?: string | null;
  /** `ambient: true`: a task the CLI keeps out of its own background list. */
  readonly ambient?: boolean;
}

/**
 * D43: the summary of a task known only from its `system/task_started`: its
 * description (a workflow without one: its name; else the task type), the `gh …`
 * command of a shell that waits for GitHub Actions. At most {@link SUMMARY_MAX}
 * characters.
 */
export function startedSummary(start: TaskStart): string {
  const text = str(start.description) ?? str(start.workflowName ?? null) ?? str(start.taskType) ?? 'task';
  const gh = taskKind(start.taskType) === 'bash' ? githubCommand(text) : null;
  return gh ?? clip(firstLine(text));
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

/**
 * 2026-10-16 / D123: what a `SendMessage` result means for a background agent. The
 * structured result wins over the words: the line's `tool_use_result`, else the text
 * when it is a JSON object. `success: false` is a refusal; `resumedAgentId`, or a
 * `status` in {@link RESUMED_STATUSES}, a run under that agent's id; a message
 * "queued for delivery" a run that may be the one already pending. Only then the
 * words: refusing ones ({@link RESUME_REFUSED}) never count, resuming ones
 * ({@link AGENT_RESUMED}) do. `null`: no agent run (a message to a teammate, …).
 */
function sendMessageOutcome(result: BackgroundResult, input: Readonly<Record<string, unknown>>, toolUseId: string): SendMessageOutcome | null {
  if (result.isError) return null;
  const detail = record(result.detail);
  const json = jsonObject(result.text);
  const field = (key: string): unknown => detail?.[key] ?? json?.[key];
  if (field('success') === false) return { kind: 'refused' };
  const message = str(field('message')) ?? result.text;
  const agentId = (): string => str(field('agentId')) ?? AGENT_ID.exec(message)?.[1] ?? str(input['to']) ?? toolUseId;
  const resumed = str(field('resumedAgentId'));
  if (resumed !== null) return { kind: 'start', id: resumed, queued: false };
  if (RESUMED_STATUSES.includes(field('status'))) return { kind: 'start', id: agentId(), queued: false };
  const queued = MESSAGE_QUEUED.exec(message);
  if (queued) return { kind: 'start', id: str(field('agentId')) ?? str(input['to']) ?? queued[1] ?? toolUseId, queued: true };
  if (RESUME_REFUSED.test(message)) return { kind: 'refused' };
  return AGENT_RESUMED.test(message) ? { kind: 'start', id: agentId(), queued: false } : null;
}

/** What a confirmed start adds: the task's id, or `null` when the result does not confirm a background start. */
function startedId(kind: BackgroundTaskKind, result: BackgroundResult, input: Readonly<Record<string, unknown>>, toolUseId: string, name = ''): string | null {
  if (result.isError) return null;
  const detail = record(result.detail);
  if (name === SEND_MESSAGE) {
    const outcome = sendMessageOutcome(result, input, toolUseId);
    return outcome?.kind === 'start' ? outcome.id : null;
  }
  switch (kind) {
    case 'bash': {
      const id = str(detail?.['backgroundTaskId']) ?? BASH_STARTED.exec(result.text)?.[1] ?? null;
      return id !== null && !ENDS_WITH_TURN.test(result.text) ? id : null;
    }
    case 'agent': {
      // 2026-10-16: the launch notice, its structured status, or (another wording) a call asked to run in the background.
      if (detail?.['status'] !== 'async_launched' && !result.text.includes(AGENT_LAUNCHED) && input['run_in_background'] !== true) return null;
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
    case 'workflow': {
      // D43: the text's `Task ID:`, else the structured launch's `taskId` (a script that failed to compile is no launch).
      if (typeof detail?.['error'] === 'string') return null;
      const launched = WORKFLOW_LAUNCH_STATUSES.includes(detail?.['status']) ? str(detail?.['taskId']) : null;
      return WORKFLOW_LAUNCHED.exec(result.text)?.[1] ?? launched;
    }
    case 'task':
      return null;
  }
}

/** Options for {@link BackgroundTracker}. */
export interface BackgroundTrackerOptions {
  /** Clock (tests pass a fake one). */
  readonly now?: () => Date;
  /** 2026-10-16: how long a CLI-reported task that is no shell counts as waited on without a sign of life (default {@link BACKGROUND_WAIT_MS}). */
  readonly waitWindowMs?: number;
  /** 2026-10-16: the stale guard of a wake-up (default {@link BACKGROUND_QUIET_MS}). */
  readonly quietMs?: number;
}

/** 2026-10-16: what the tracker knows of a pending task beyond its wire shape. */
interface Life {
  /** Its last sign of life (epoch ms); a wake-up: its `wakeAt`. */
  seen: number;
  /** D143: a shell or watcher ({@link isShellTask}): never waited on. */
  readonly shell: boolean;
}

interface Call {
  readonly kind: BackgroundTaskKind;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly startedAt: Date;
  /** The CLI reported the task's end before its `tool_result` confirmed the start. */
  ended: boolean;
}

/** D43: a `system/task_started` the tracker holds, with its arrival. */
interface Started extends TaskStart {
  readonly at: Date;
}

/** D43: the pending task of a `system/task_started` no known call registers. */
function taskFromStart(start: Started): BackgroundTask {
  const kind = taskKind(start.taskType);
  return {
    id: start.taskId,
    toolUseId: start.toolUseId ?? start.taskId,
    kind,
    summary: startedSummary(start),
    startedAt: start.at.toISOString(),
    github: kind === 'bash' && isGithubWait(start.description ?? ''),
  };
}

/**
 * The main agent's pending background tasks (D30), and every other background task
 * the CLI reports (D43):
 * - **added** from a `tool_use` ({@link called}) plus the `tool_result` that
 *   confirms the background start ({@link resulted}): a `Bash` whose result says it
 *   runs in the background (not one the CLI ends with the turn), an async `Agent` /
 *   `Task`, a `Monitor`, a `ScheduleWakeup` (`wakeAt` = the call's time +
 *   `delaySeconds`; not with `stop: true`), D43: a `Workflow` launched in the
 *   background;
 * - D43: **added** from every background `system/task_started` ({@link started}),
 *   unless a task with that task id or `tool_use_id` is pending already. The start of
 *   a call still waiting for its result is held for that result (the call's task,
 *   so no double entry; a call whose result is an error or a command that ends with
 *   the turn adds nothing). A foreground task (`is_backgrounded: false`) counts once
 *   a `system/task_updated` moves it to the background; an `ambient` one never;
 * - **removed** on its task notification ({@link notified}: the `tool_use` id,
 *   else the task id) or, D43, a terminal `system/task_updated` ({@link updated}),
 *   for a wake-up when the next turn starts ({@link turnStarted}), and all of them
 *   when the process ends ({@link clear}). A `Monitor` stays until its own
 *   notification.
 */
export class BackgroundTracker {
  readonly #now: () => Date;
  /** Calls that may start background work, by `tool_use` id, until their result. */
  readonly #calls = new Map<string, Call>();
  /** Pending tasks by `tool_use` id (D43: by task id without one), in start order. */
  readonly #tasks = new Map<string, BackgroundTask>();
  /** D43: background `task_started` lines of calls that wait for their result, by `tool_use` id. */
  readonly #held = new Map<string, Started>();
  /** D43: foreground tasks (`is_backgrounded: false`) of the running turn, by task id. */
  readonly #foreground = new Map<string, Started>();
  /** 2026-10-16: each pending task's last sign of life and whether it is a dev server, by its key in {@link #tasks}. */
  readonly #life = new Map<string, Life>();
  readonly #waitWindowMs: number;
  readonly #quietMs: number;

  constructor(options: BackgroundTrackerOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#waitWindowMs = options.waitWindowMs ?? BACKGROUND_WAIT_MS;
    this.#quietMs = options.quietMs ?? BACKGROUND_QUIET_MS;
  }

  /** A main-agent `tool_use`: remembered when its tool can start background work. */
  called(toolUseId: string, name: string, input: Readonly<Record<string, unknown>>): void {
    const kind = kindOf(name);
    if (kind === null || toolUseId === '') return;
    this.#calls.set(toolUseId, { kind, name, input, startedAt: this.#now(), ended: false });
  }

  /**
   * The `tool_result` of a call: adds the task when it confirms a background start
   * (D43: or when the CLI reported the call's task with `system/task_started`, unless
   * the result is an error or a command that ends with the turn). Returns `true` when
   * a task was added.
   */
  resulted(toolUseId: string, result: BackgroundResult): boolean {
    const call = this.#calls.get(toolUseId);
    if (!call) return false;
    this.#calls.delete(toolUseId);
    const start = this.#held.get(toolUseId) ?? null;
    this.#held.delete(toolUseId);
    if (call.ended) return false;
    // D123: a SendMessage the CLI refused starts nothing; one queued for a run still pending adds none (that run goes on).
    const message = call.name === SEND_MESSAGE ? sendMessageOutcome(result, call.input, toolUseId) : null;
    if (message?.kind === 'refused') return false;
    if (message?.kind === 'start' && message.queued && this.#pending(message.id, null)) return false;
    const confirmed = startedId(call.kind, result, call.input, toolUseId, call.name);
    const reported = start !== null && !result.isError && !(call.kind === 'bash' && ENDS_WITH_TURN.test(result.text)) ? start.taskId : null;
    const id = confirmed ?? reported;
    if (id === null) return false;
    const command = str(call.input['command']);
    const github = command !== null && (call.kind === 'bash' || call.kind === 'monitor') && isGithubWait(command);
    const delay = call.input['delaySeconds'];
    const task: BackgroundTask = {
      id,
      toolUseId,
      kind: call.kind,
      summary: call.kind === 'workflow' ? workflowSummary(result, call.input, start?.description ?? null) : backgroundSummary(call.name, call.input),
      startedAt: call.startedAt.toISOString(),
      ...(call.kind === 'wakeup' && typeof delay === 'number' ? { wakeAt: new Date(call.startedAt.getTime() + delay * 1000).toISOString() } : {}),
      github,
    };
    this.#add(task, isShellTask(call.kind));
    return true;
  }

  /**
   * D43: a `system/task_started`. A background task becomes pending, unless one with
   * the same task id or `tool_use_id` is pending already, or its call still waits for
   * its result (held for {@link resulted}). A foreground task waits for a
   * {@link updated} that moves it to the background; an `ambient` one is ignored.
   * Returns `true` when a task was added.
   */
  started(start: TaskStart): boolean {
    if (start.taskId === '' || start.ambient === true || this.#pending(start.taskId, start.toolUseId)) return false;
    const entry: Started = { ...start, at: this.#now() };
    if (start.backgrounded === false) {
      this.#foreground.set(start.taskId, entry);
      return false;
    }
    return this.#place(entry);
  }

  /**
   * D43: a `system/task_updated`: a terminal status ends the task like its
   * notification ({@link notified}, by task id); `is_backgrounded: true` moves a
   * foreground task to the background ({@link started}'s rules). Returns `true` when
   * the pending list changed.
   */
  updated(taskId: string, status: string | null, backgrounded: boolean | null): boolean {
    if (taskId === '') return false;
    if (isTaskFinished(status)) return this.notified(taskId, null);
    const entry = backgrounded === true ? this.#foreground.get(taskId) : undefined;
    if (!entry) return false;
    this.#foreground.delete(taskId);
    if (this.#pending(entry.taskId, entry.toolUseId)) return false;
    return this.#place(entry);
  }

  /**
   * The CLI reported a task's end: the pending task with that `tool_use` id, else
   * with that task id, is removed. A call still waiting for its result is marked,
   * so its result adds nothing. Returns `true` when a pending task was removed.
   */
  notified(taskId: string | null, toolUseId: string | null): boolean {
    if (taskId !== null) this.#foreground.delete(taskId);
    // D43: a start held for its call's result is known by its task id too.
    let callId = toolUseId;
    if (callId === null && taskId !== null) {
      for (const [key, held] of this.#held) if (held.taskId === taskId) callId = key;
    }
    if (callId !== null) this.#held.delete(callId);
    if (toolUseId !== null && this.#delete(toolUseId)) return true;
    if (taskId !== null) {
      for (const [key, task] of this.#tasks) {
        if (task.id === taskId) {
          this.#delete(key);
          return true;
        }
      }
    }
    const call = callId !== null ? this.#calls.get(callId) : undefined;
    if (call) call.ended = true;
    return false;
  }

  /**
   * A new turn started: the wake-ups have fired (or a message came first); calls of
   * the earlier turn without a result are dropped, and so are its foreground tasks
   * (D43: a turn ends only once they did).
   */
  turnStarted(): void {
    for (const [key, task] of this.#tasks) if (task.kind === 'wakeup') this.#delete(key);
    this.#calls.clear();
    this.#held.clear();
    this.#foreground.clear();
  }

  /** The process ended (exit, pause): nothing is pending any more. */
  clear(): void {
    this.#calls.clear();
    this.#tasks.clear();
    this.#life.clear();
    this.#held.clear();
    this.#foreground.clear();
  }

  /**
   * 2026-10-16: a sign of life of the pending task with this task id (or `tool_use` id):
   * its `task_started`, a `task_progress` / non-terminal `task_updated`, a monitor's event
   * notice. It restarts the wait window of a plain shell and the stale guard of a GitHub
   * wait. Returns `true` when a pending task had that id.
   */
  touch(id: string): boolean {
    if (id === '') return false;
    let touched = false;
    for (const [key, task] of this.#tasks) {
      if (task.id !== id && task.toolUseId !== id) continue;
      const life = this.#life.get(key);
      if (life && task.kind !== 'wakeup') life.seen = this.#now().getTime();
      touched = true;
    }
    return touched;
  }

  /**
   * The pending tasks, oldest first, each with `waiting` (2026-10-16, *Session status*
   * → *Waiting on background work*): an async agent or a workflow always (the
   * stale-subagent guard is the recorder's); D143: a shell or watcher never (a background
   * `Bash` of any command, a GitHub wait included, a `Monitor`, a `local_bash` /
   * `monitor_mcp` task); a wake-up until `quietMs` past its time; any other CLI-reported
   * task while quiet for less than `waitWindowMs`.
   */
  list(): BackgroundTask[] {
    const now = this.#now().getTime();
    const tasks = [...this.#tasks].map(([key, task]) => ({ ...task, waiting: this.#waits(task, this.#life.get(key), now) }));
    // A stable sort: tasks started in the same millisecond keep their start order.
    return tasks.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  }

  /** 2026-10-16: how many pending tasks that are no subagent are waited on (the recorder's status input). */
  waitCount(): number {
    return this.list().filter((task) => task.waiting && !isSubagentTask(task)).length;
  }

  #waits(task: BackgroundTask, life: Life | undefined, now: number): boolean {
    if (isSubagentTask(task)) return true;
    // D143: a background shell / watcher (a dev server, a build, a GitHub wait) is left running, never waited on.
    if (life?.shell ?? isShellTask(task.kind)) return false;
    const quiet = life ? now - life.seen : 0;
    if (task.kind === 'wakeup') return quiet < this.#quietMs;
    return quiet < this.#waitWindowMs;
  }

  /** Removes a pending task by its key, with what the tracker knew of it. */
  #delete(key: string): boolean {
    this.#life.delete(key);
    return this.#tasks.delete(key);
  }

  /** `true` when a pending task has this task id or this `tool_use` id. */
  #pending(taskId: string, toolUseId: string | null): boolean {
    for (const task of this.#tasks.values()) if (task.id === taskId || (toolUseId !== null && task.toolUseId === toolUseId)) return true;
    return false;
  }

  /** A background start: held while its call waits for its result, else pending. */
  #place(entry: Started): boolean {
    const call = entry.toolUseId !== null ? this.#calls.get(entry.toolUseId) : undefined;
    if (call && entry.toolUseId !== null) {
      if (!call.ended) this.#held.set(entry.toolUseId, entry);
      return false;
    }
    const task = taskFromStart(entry);
    this.#add(task, isShellTask(task.kind, entry.taskType));
    return true;
  }

  /**
   * Adds a pending task; one pending under the same task id or `tool_use` id is replaced
   * (D43: no double entry). 2026-10-16: its life starts now (a wake-up's at its `wakeAt`).
   */
  #add(task: BackgroundTask, shell = false): void {
    for (const [key, pending] of this.#tasks) if (pending.id === task.id || pending.toolUseId === task.toolUseId) this.#delete(key);
    this.#tasks.set(task.toolUseId, task);
    const wakeAt = task.wakeAt ? Date.parse(task.wakeAt) : Number.NaN;
    this.#life.set(task.toolUseId, { seen: Number.isFinite(wakeAt) ? wakeAt : this.#now().getTime(), shell });
  }
}

/**
 * Subagent work (2026-10-16, `docs/derivations.md` → *Session status* → *Waiting on
 * subagents*): the pending tasks that are agents working for the session, an async
 * `Agent` / `Task` and a background `Workflow`. Shells, monitors, wake-ups and other
 * tasks are not subagents (a dev server may run for hours).
 */
export function isSubagentTask(task: Pick<BackgroundTask, 'kind'>): boolean {
  return task.kind === 'agent' || task.kind === 'workflow';
}

/**
 * How many subagents the pending tasks stand for: one per async agent; a workflow's
 * agents not done yet once its run is known (D51), else one.
 */
export function pendingSubagentCount(tasks: readonly Pick<BackgroundTask, 'kind' | 'workflow'>[]): number {
  let count = 0;
  for (const task of tasks) {
    if (task.kind === 'agent') count += 1;
    else if (task.kind === 'workflow') {
      const run = task.workflow;
      count += run && run.agentCount > 0 ? Math.max(1, run.agentCount - run.doneCount) : 1;
    }
  }
  return count;
}

/**
 * The main turn is over but subagents still work (`state: background` with a subagent
 * task pending): their count and when the oldest started; `null` otherwise (a turn runs,
 * nothing is pending, or only shells / monitors / wake-ups are).
 */
export function waitingOnSubagents(activity: Pick<SessionActivity, 'state' | 'background'> | null | undefined): { readonly count: number; readonly since: string } | null {
  if (!activity || activity.state !== 'background') return null;
  const subagents = (activity.background ?? []).filter(isSubagentTask);
  if (subagents.length === 0) return null;
  const since = subagents.reduce((oldest, task) => (task.startedAt < oldest ? task.startedAt : oldest), subagents[0]?.startedAt ?? '');
  return { count: pendingSubagentCount(subagents), since };
}

/**
 * 2026-10-16: `true` when the agent waits on this pending task (it keeps the session
 * `run`): the task's `waiting`, else (an older machine's payload, without the field) by
 * kind: a subagent or a wake-up (D143: a GitHub wait is a shell, no longer waited on).
 */
export function isWaitTask(task: Pick<BackgroundTask, 'kind' | 'github' | 'waiting'>): boolean {
  if (task.waiting !== undefined) return task.waiting;
  return isSubagentTask(task) || task.kind === 'wakeup';
}

/**
 * D143 (`docs/processes.md` → *Background apps of an agent*): how many background apps the
 * agent left running: its pending background tasks it does not wait on (a dev server, a
 * watcher, any other background shell, a task past its window). No subagent, no wake-up.
 * 0 without an activity.
 */
export function backgroundAppCount(activity: Pick<SessionActivity, 'background'> | null | undefined): number {
  return (activity?.background ?? []).filter((task) => !isWaitTask(task) && !isSubagentTask(task) && task.kind !== 'wakeup').length;
}

/** D143: `1 background app`, `3 background apps` (D127's words); `null` for 0. */
export function backgroundAppsText(count: number): string | null {
  return count > 0 ? `${count} background app${count === 1 ? '' : 's'}` : null;
}

/**
 * 2026-10-16 (*Session status* → *Waiting on background work*): what a session whose
 * main turn is over waits on, the most telling first: its subagents (with their count),
 * a GitHub Actions wait, another background task, a wake-up (with its time). `since` =
 * when the oldest such task started. `null` while a turn runs, or when nothing pending is
 * waited on (only dev servers / watchers, or tasks past their window).
 */
export type BackgroundWait =
  | { readonly kind: 'subagents'; readonly count: number; readonly since: string }
  | { readonly kind: 'github' | 'background'; readonly since: string }
  | { readonly kind: 'wakeup'; readonly since: string; readonly wakeAt: string | null };

/** The kinds of {@link BackgroundWait}, the most telling first. */
export type BackgroundWaitKind = BackgroundWait['kind'];

function oldestStart(tasks: readonly Pick<BackgroundTask, 'startedAt'>[]): string {
  return tasks.reduce((oldest, task) => (task.startedAt < oldest ? task.startedAt : oldest), tasks[0]?.startedAt ?? '');
}

/** The wait of a session's activity ({@link BackgroundWait}); `null` without one. */
export function backgroundWait(activity: Pick<SessionActivity, 'state' | 'background'> | null | undefined): BackgroundWait | null {
  if (!activity || activity.state !== 'background') return null;
  const waited = (activity.background ?? []).filter(isWaitTask);
  const subagents = waited.filter(isSubagentTask);
  if (subagents.length > 0) return { kind: 'subagents', count: pendingSubagentCount(subagents), since: oldestStart(subagents) };
  const github = waited.filter((task) => task.github);
  if (github.length > 0) return { kind: 'github', since: oldestStart(github) };
  const other = waited.filter((task) => task.kind !== 'wakeup');
  if (other.length > 0) return { kind: 'background', since: oldestStart(other) };
  const wakeups = waited.filter((task) => task.kind === 'wakeup');
  if (wakeups.length === 0) return null;
  const next = wakeups.reduce((soonest, task) => ((task.wakeAt ?? '') < (soonest.wakeAt ?? '') ? task : soonest), wakeups[0] as BackgroundTask);
  return { kind: 'wakeup', since: oldestStart(wakeups), wakeAt: next.wakeAt ?? null };
}
