import { CHAT_PERMISSION_MODE } from '../../core/chats.ts';
import path from 'node:path';
import { resultTurnTokens } from '../../core/todo-actuals.ts';
import { resultInsightFields } from '../../core/insights.ts';
import { type ModelTotals, resultModelTotals } from '../../core/usage-breakdown.ts';
import type { BackgroundTask, SessionActivity } from '../../core/api.ts';
import { type Attachment, attachmentsLabel } from '../../core/attachments.ts';
import type { EventKind, SessionStatus } from '../../core/model.ts';
import {
  type EventPayload,
  type LifecyclePayload,
  type RequestPayload,
  type RequestState,
  type ToolPayload,
  type UserLoopMark,
  type UserMessageOrigin,
  type UserPayload,
  clip,
  clipInput,
  clipMessage,
} from '../../core/event-payload.ts';
import { type ContextInput, type ContextState, readContextState, reduceContext } from '../../core/context-meter.ts';
import { ActivityTracker } from '../../core/derive/activity.ts';
import { QueueTracker, type Withdrawn, queuedReason, withoutQueued } from '../../core/derive/queued.ts';
import { STOPPED_LABEL, isInterruptedResult, stopTimeoutText } from '../../core/stop-turn.ts';
import { BackgroundTracker, endsTask, isSubagentTask, parseTaskNotification } from '../../core/derive/background.ts';
import { AGENT_TASK_TYPE, agentStatusFromTask, isTaskFinished, subagentFromToolUse } from '../../core/derive/agents.ts';
import { type SessionPlace, sessionSolutionFolder } from '../../core/derive/artifacts.ts';
import {
  AGENT_TOOLS,
  WRITE_TOOLS,
  bashCommand,
  resultEventKind,
  textLabel,
  toolEventKind,
  toolLabel,
  userMessageKind,
} from '../../core/derive/event-kind.ts';
import type { LiveStatusInput, TurnOutcome } from '../../core/derive/status.ts';
import type { AnsweredOn } from '../../core/remote-control.ts';
import { writtenSolution } from '../../core/session-solutions.ts';
import { type StreamMessage, progressNoteText } from '../../core/stream-json.ts';
import { readingFromRateLimit } from '../../core/usage.ts';
import { type WorkflowLaunch, workflowLaunch } from '../../core/derive/workflows.ts';
import type { AgentRecord } from '../db/repos/agents.ts';
import type { EventRecord } from '../db/repos/events.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { DEFAULT_PERMISSION_MODE, FALLBACK_PERMISSION_MODE } from './argv.ts';

/** Options for {@link StreamRecorder}. */
export interface RecorderOptions {
  readonly store: Store;
  readonly session: SessionRecord;
  /** The session's main agent (events without `parent_tool_use_id` belong to it). */
  readonly mainAgentId: string;
  /** Called after every event insert or update. */
  readonly onEvent: (event: EventRecord) => void;
  /**
   * D6: `auto` was requested but the CLI reports another mode (the model does not
   * support it): the supervisor sends `set_permission_mode` with this mode.
   */
  readonly onPermissionFallback?: (mode: string) => void;
  /** D19: called whenever the live activity ({@link StreamRecorder.activity}) changes, with the new value. */
  readonly onActivity?: (activity: SessionActivity | null) => void;
  /**
   * D24: where a request the CLI withdraws (`control_cancel_request`) was answered:
   * `claude.ai` while Remote Control is on (the phone answered first), else `null`.
   * The request's event then carries `answeredOn`.
   */
  readonly answeredOn?: () => AnsweredOn | null;
  /** Clock of the live activity's timestamps (tests pass a fake one). */
  readonly now?: () => Date;
  /** 2026-10-16: the wait window of a CLI-reported background task that is no shell (default `BACKGROUND_WAIT_MS`, 30 min; D143: shells are never waited on). */
  readonly backgroundWaitMs?: number;
  /** 2026-10-16: the stale guard of a wake-up (default `BACKGROUND_QUIET_MS`, 2 h). */
  readonly backgroundQuietMs?: number;
  /**
   * D25: the process may report `system/init` at startup, before it takes any
   * message (a `--teleport` spawn, `docs/supervisor.md` → *Teleport*). The first
   * `init` that arrives while no stdin message is pending then opens no turn (the
   * session stays idle); every later `init` opens one as usual.
   */
  readonly startupInit?: boolean;
  /**
   * D38: an agent of the session wrote a file into this solution (a successful
   * Write / Edit / NotebookEdit; `writtenSolution`, the D21 derivation). The
   * supervisor adds it to `Session.solutions` when it is missing. Awaited in order.
   */
  readonly onSolutionWritten?: (solution: string) => Promise<void>;
  /**
   * D49: the context meter changed (a main-agent usage, a result's windows, a
   * compaction, a turn start) and is stored on the session: the supervisor
   * publishes `sessionUpdated`.
   */
  readonly onContext?: () => void;
  /**
   * D51: what this process says about Workflow runs (`src/server/workflows/`): a
   * launch (the `Workflow` call's result), a `task_progress` snapshot of a task's
   * `workflow_progress`, a task's end. Called in stream order.
   */
  readonly onWorkflow?: (signal: WorkflowSignal) => void;
  /**
   * D124: a turn starts (`message`: a message is written to stdin; `stream`: the CLI opens a turn,
   * its `system/init`): the session's turn wait is cleared. Awaited in order.
   */
  readonly onTurnStart?: (from: 'message' | 'stream') => Promise<void>;
  /**
   * D124: the main turn ended (its `result`; not one Switchboard interrupted to stop the process),
   * with its outcome and last text: the session's turn wait is decided. Awaited before the status
   * is derived again.
   */
  readonly onTurnEnd?: (end: { readonly outcome: TurnOutcome; readonly text: string | null }) => Promise<void>;
}

/** D51: one thing the stream says about a Workflow run ({@link RecorderOptions.onWorkflow}). */
export type WorkflowSignal =
  | { readonly kind: 'launched'; readonly launch: WorkflowLaunch; readonly toolUseId: string }
  | { readonly kind: 'progress'; readonly taskId: string; readonly progress: readonly unknown[] }
  | { readonly kind: 'ended'; readonly taskId: string; readonly status: string };

interface ToolEntry {
  readonly eventId: number;
  readonly name: string;
  /**
   * A write tool's `file_path` / `notebook_path` (M4.3), else `null`. Not the whole input: the
   * entry lives until the call's result, and the process for days (1.24 perf: kept inputs were
   * every Write / Edit's content since the CLI started).
   */
  readonly file: string | null;
  readonly command: string | null;
  /** The agent whose `tool_use` it is (M4.3: a write places that agent). */
  readonly agentId: string;
}

interface OpenRequest {
  readonly eventId: number;
  readonly toolName: string;
  /** `true` when the request is shown on the AskUserQuestion tool event itself. */
  readonly onToolEvent: boolean;
}

/** 2026-10-16: the tool a subagent ends its work with (its final report to the agent that started it). */
const SUBAGENT_HANDBACK = 'SubagentHandback';

/**
 * 2026-10-16 · the open runs of the subagent tasks. One task id can run several times: the
 * orchestrator resumes a background agent with `SendMessage`, and the CLI reports the new run
 * under the **same** task id (its own `tool_use_id`, its own `agents` row). A run is keyed by
 * the `tool_use` that started it (else the task id); an end without a known run ends the
 * task's latest open run.
 */
class OpenRuns {
  readonly #runs = new Map<string, string[]>();
  /** Runs already ended: a late end naming one of them ends nothing (never the next run). */
  readonly #ended = new Set<string>();

  start(taskId: string, runKey: string): void {
    this.#ended.delete(runKey);
    const list = this.#runs.get(taskId) ?? [];
    if (!list.includes(runKey)) list.push(runKey);
    this.#runs.set(taskId, list);
  }

  /** Ends the run `runKey` when it is open, else the task's latest; the ended run's key, `null` when none was open. */
  end(taskId: string, runKey: string | null): string | null {
    const list = this.#runs.get(taskId);
    if (!list || list.length === 0) return null;
    let at = runKey !== null ? list.indexOf(runKey) : -1;
    if (at < 0 && runKey !== null && runKey !== taskId && this.#ended.has(runKey)) return null;
    if (at < 0) at = list.length - 1;
    const [key] = list.splice(at, 1);
    if (list.length === 0) this.#runs.delete(taskId);
    if (key !== undefined) this.#ended.add(key);
    return key ?? null;
  }

  /** `true` for a run that ended already (a late end naming it is stale). */
  isEnded(runKey: string): boolean {
    return this.#ended.has(runKey);
  }

  latest(taskId: string): string | null {
    return this.#runs.get(taskId)?.at(-1) ?? null;
  }

  has(taskId: string): boolean {
    return this.#runs.has(taskId);
  }

  tasks(): string[] {
    return [...this.#runs.keys()];
  }

  /** Every open run (`[taskId, runKey]`), oldest first per task. */
  all(): Array<readonly [string, string]> {
    return [...this.#runs].flatMap(([taskId, keys]) => keys.map((key) => [taskId, key] as const));
  }

  clear(): void {
    this.#runs.clear();
    this.#ended.clear();
  }
}

/**
 * Turns one process's stream-json messages into stored state
 * (`docs/derivations.md`): events (chat, timeline, terminal tail), agents,
 * usage readings and the session's CLI fields. It also keeps the
 * bookkeeping the session status is derived from: pending turns, open
 * `can_use_tool` requests, running subagents and the last turn's outcome.
 *
 * One instance per process; calls must be serialized (the supervisor queues them).
 */
export class StreamRecorder {
  readonly #store: Store;
  readonly #sessionId: string;
  readonly #sessionName: string;
  /** Where the session works (D14): its folder, its kind and its cwd; `null` before it has a cwd. */
  readonly #place: SessionPlace | null;
  #requestedMode: string | null;
  readonly #mainAgentId: string;
  readonly #onEvent: (event: EventRecord) => void;
  readonly #onPermissionFallback: ((mode: string) => void) | undefined;
  readonly #onActivity: ((activity: SessionActivity | null) => void) | undefined;
  readonly #answeredOn: (() => AnsweredOn | null) | undefined;
  /** D19: what the running turn does now (in memory only). */
  readonly #activity: ActivityTracker;
  /** D30: the main agent's pending background tasks (in memory only). */
  readonly #background: BackgroundTracker;
  /** The last activity reported to `onActivity`, as JSON. */
  #activityKey = 'null';
  /**
   * 2026-10-16 (the stale-subagent guard): when each running subagent (a `local_agent`
   * task, a pending async agent or workflow) last gave a sign of life (epoch ms), by task
   * id: its start, progress, update or a line of its own (`parent_tool_use_id`).
   */
  readonly #subagentSeen = new Map<string, number>();
  /** The task id of a subagent by the `tool_use` that started it (its lines carry that id). */
  readonly #subagentByToolUse = new Map<string, string>();
  /** 2026-10-16: the non-subagent background tasks waited on at the last {@link expireBackgroundWaits}, by `tool_use` id. */
  #waitedKeys = new Set<string>();

  /**
   * User messages written to stdin that the CLI has not taken up yet (no replay
   * echo yet). Each one is work still to come: the session runs until it is taken up.
   */
  #pendingTurns = 0;
  /**
   * A turn runs: opened by `system/init` or by the replay of a stdin message,
   * closed by its `result`. One result closes the turn whatever it took up: the
   * CLI folds messages queued while a turn runs into that turn (a `queued_command`
   * attachment, replayed at once) and ends them all with that turn's one `result`,
   * whose origin may be a task notification (the stuck-`run` fix of 2026-09-29).
   */
  #turnOpen = false;
  /** The open turn took up at least one stdin message of ours (a replay echo came). */
  #turnTookUp = false;
  #lastOutcome: TurnOutcome | null = null;
  /** Set while Switchboard stops the process: the interrupted turn's result is not an outcome. */
  #stopping = false;
  /**
   * D50: the developer stopped the turn (Stop / Esc) and no message was sent since:
   * an interrupted result is the stop's (outcome `stopped`, the "Stopped" line), not a failure.
   */
  #stopRequested = false;
  /** D50: the "Stopped" line of the current stop is written (a late second aborted result adds none). */
  #stopLineWritten = false;
  readonly #openRequests = new Map<string, OpenRequest>();
  /** The running subagent tasks' open runs (`local_agent` tasks; 2026-10-16: a resumed task is a run of its own). */
  readonly #runningAgents = new OpenRuns();
  /** 2026-10-16: the task id of a subagent's starting call (its `agents` row's), for attributing a resumed run's lines. */
  readonly #taskOfToolUse = new Map<string, string>();
  readonly #textByMessage = new Map<string, { eventId: number; text: string; parts: string[] }>();
  readonly #tools = new Map<string, ToolEntry>();
  readonly #agentByToolUse = new Map<string, string>();
  /** The stdin messages the CLI has not echoed yet, and which of them wait (D44). */
  readonly #queue = new QueueTracker();
  /** Bash commands of the current turn whose result was an error (rebuild detection, gap #7). */
  readonly #failedCommands = new Set<string>();
  #modeMismatchFlagged = false;
  #observedMode: string | null;
  #cliVersion: string | null;
  #lastTranscriptUuid: string | null;
  /** D25: the next `init` may be the startup one ({@link RecorderOptions.startupInit}). */
  #startupInit: boolean;
  readonly #onSolutionWritten: ((solution: string) => Promise<void>) | undefined;
  /** D49: the context meter (`sessions.context`), as stored. */
  #context: ContextState;
  readonly #onContext: (() => void) | undefined;
  readonly #onWorkflow: ((signal: WorkflowSignal) => void) | undefined;
  readonly #onTurnStart: ((from: 'message' | 'stream') => Promise<void>) | undefined;
  readonly #onTurnEnd: ((end: { readonly outcome: TurnOutcome; readonly text: string | null }) => Promise<void>) | undefined;
  readonly #now: () => Date;
  readonly #profileId: string;

  constructor(options: RecorderOptions) {
    this.#store = options.store;
    this.#sessionId = options.session.id;
    this.#sessionName = options.session.name;
    // D63: the Claude Code profile this process's usage readings belong to.
    this.#profileId = options.session.profileId ?? 'default-claude';
    const cwd = options.session.cwd;
    this.#place = cwd ? { root: options.session.root ?? cwd, kind: options.session.rootKind ?? 'workspace', cwd } : null;
    this.#requestedMode = options.session.requestedPermissionMode;
    this.#mainAgentId = options.mainAgentId;
    this.#onEvent = options.onEvent;
    this.#onPermissionFallback = options.onPermissionFallback;
    this.#onActivity = options.onActivity;
    this.#answeredOn = options.answeredOn;
    this.#activity = new ActivityTracker({ mainAgentId: options.mainAgentId, ...(options.now ? { now: options.now } : {}) });
    this.#background = new BackgroundTracker({
      ...(options.now ? { now: options.now } : {}),
      ...(options.backgroundWaitMs !== undefined ? { waitWindowMs: options.backgroundWaitMs } : {}),
      ...(options.backgroundQuietMs !== undefined ? { quietMs: options.backgroundQuietMs } : {}),
    });
    this.#observedMode = options.session.observedPermissionMode;
    this.#cliVersion = options.session.cliVersion;
    this.#lastTranscriptUuid = options.session.lastTranscriptUuid;
    this.#startupInit = options.startupInit ?? false;
    this.#onSolutionWritten = options.onSolutionWritten;
    this.#context = readContextState(options.session.context);
    this.#onContext = options.onContext;
    this.#onWorkflow = options.onWorkflow;
    this.#onTurnStart = options.onTurnStart;
    this.#onTurnEnd = options.onTurnEnd;
    this.#now = options.now ?? (() => new Date());
  }

  /** 1.24 perf (tests): how many tool calls the recorder still holds (a call is dropped with its result). */
  retainedToolCalls(): number {
    return this.#tools.size;
  }

  /** The inputs of the live status derivation. */
  statusInput(): LiveStatusInput {
    return {
      live: true,
      openRequests: this.#openRequests.size,
      turnRunning: this.#pendingTurns > 0 || this.#turnOpen,
      // 2026-10-16: a pending async agent or background workflow is a running subagent too (it keeps `run`).
      runningAgents: this.#runningSubagentIds().size,
      // 2026-10-16: a wake-up or another background task the agent waits on keeps `run` too; D143: never a background shell (a dev server, a GitHub wait).
      backgroundWaits: this.#background.waitCount(),
      lastOutcome: this.#lastOutcome,
    };
  }

  /** The running subagents' task ids: `local_agent` tasks, and the pending async agents and workflows. */
  #runningSubagentIds(): Set<string> {
    const ids = new Set(this.#runningAgents.tasks());
    for (const task of this.#background.list()) if (isSubagentTask(task)) ids.add(task.id);
    return ids;
  }

  /**
   * 2026-10-16: the subagent started by the call `toolUseId` handed back (its final report):
   * its pending background task and its running task end as completed.
   */
  async #subagentHandedBack(toolUseId: string): Promise<void> {
    const taskId =
      this.#taskOfToolUse.get(toolUseId) ??
      this.#subagentByToolUse.get(toolUseId) ??
      (await this.#store.agents.findByToolUseId(this.#sessionId, toolUseId))?.taskId ??
      this.#background.list().find((task) => task.toolUseId === toolUseId)?.id ??
      null;
    this.#taskNotified(taskId, toolUseId);
    // The handback ends the task's LATEST open run (a resumed agent's lines keep its first call as their parent).
    if (taskId !== null) await this.#onTaskEnd(taskId, 'completed');
  }

  /** A sign of life of the subagent with this task id. */
  #touchSubagent(taskId: string): void {
    if (taskId !== '') this.#subagentSeen.set(taskId, this.#now().getTime());
  }

  /**
   * 2026-10-16 · the stale-subagent guard: a running subagent with no sign of life for
   * `quietMs` (it never reported its end: a lost notification, a CLI that dropped it) is
   * taken as stopped (its card idle, the background wait gone), so the session can go
   * idle. Returns the ended ones (`taskId`, how long they were quiet) for the log.
   */
  async expireQuietSubagents(quietMs: number): Promise<{ readonly taskId: string; readonly quietMs: number }[]> {
    const now = this.#now().getTime();
    const ended: { taskId: string; quietMs: number }[] = [];
    const started = new Map(this.#background.list().map((task) => [task.id, Date.parse(task.startedAt)]));
    for (const taskId of this.#runningSubagentIds()) {
      let seen = this.#subagentSeen.get(taskId);
      if (seen === undefined) {
        const at = started.get(taskId);
        seen = at !== undefined && Number.isFinite(at) ? at : now;
        this.#subagentSeen.set(taskId, seen);
      }
      if (now - seen < quietMs) continue;
      this.#taskNotified(taskId, null);
      await this.#onTaskEnd(taskId, 'stopped');
      while (this.#runningAgents.has(taskId)) await this.#onTaskEnd(taskId, 'stopped');
      ended.push({ taskId, quietMs: now - seen });
    }
    if (ended.length > 0) this.#syncActivity();
    return ended;
  }

  /** `true` while a subagent runs (the stale-subagent sweep only looks at such recorders). */
  hasRunningSubagents(): boolean {
    return this.#runningSubagentIds().size > 0;
  }

  /**
   * 2026-10-16: `true` while a background task that is no subagent is waited on, or was at
   * the last {@link expireBackgroundWaits} (the sweep then re-checks its window once more).
   */
  hasBackgroundWaits(): boolean {
    return this.#waitedKeys.size > 0 || this.#background.waitCount() > 0;
  }

  /**
   * 2026-10-16 · the background waits' clock (*Waiting on background work*): a plain
   * shell past its window, a GitHub wait or a wake-up past the stale guard stops counting
   * as waited on. Returns the tasks that stopped since the last check (for the log); the
   * activity follows at once, the status is the caller's to refresh.
   */
  expireBackgroundWaits(): BackgroundTask[] {
    const now = new Map(this.#background.list().map((task) => [task.toolUseId, task] as const));
    const stopped: BackgroundTask[] = [];
    for (const key of this.#waitedKeys) {
      const task = now.get(key);
      if (task && !task.waiting) stopped.push(task);
    }
    this.#waitedKeys = new Set([...now.values()].filter((task) => task.waiting && !isSubagentTask(task)).map((task) => task.toolUseId));
    // The activity carries each task's `waiting`: a change goes out (deduplicated by its JSON).
    this.#syncActivity();
    return stopped;
  }

  /** `true` while a turn runs or waits for an answer (an interrupt then produces a `result`). */
  turnBusy(): boolean {
    return this.#pendingTurns > 0 || this.#turnOpen || this.#openRequests.size > 0;
  }

  get lastOutcome(): TurnOutcome | null {
    return this.#lastOutcome;
  }

  /** Ids of the open `can_use_tool` requests. */
  openRequestIds(): string[] {
    return [...this.#openRequests.keys()];
  }

  hasOpenRequest(requestId: string): boolean {
    return this.#openRequests.has(requestId);
  }

  /** Marks the start of a Switchboard-initiated stop. */
  beginStop(): void {
    this.#stopping = true;
  }

  /** `true` while a turn is open (started by `init` or a replay, not ended by its `result`). */
  get turnOpen(): boolean {
    return this.#turnOpen;
  }

  /**
   * D50: the developer stops the running turn (the supervisor then writes the
   * interrupt): the interrupted result that follows is the stop's, until the next
   * message is sent.
   */
  beginInterrupt(): void {
    this.#stopRequested = true;
    this.#stopLineWritten = false;
  }

  /**
   * D50: takes back the messages the agent has not taken up (they were queued, or
   * their turn had not started; {@link QueueTracker.withdraw}), oldest first. Each
   * is no pending turn any more; its event loses `queued` and gets `withdrawn`
   * (re-sent on `/hub`, so every chat drops the bubble). Returns them with their text.
   */
  async withdrawQueued(): Promise<Withdrawn[]> {
    const withdrawn = this.#queue.withdraw();
    this.#pendingTurns = Math.max(0, this.#pendingTurns - withdrawn.length);
    for (const message of withdrawn) {
      await this.#patchPayload<UserPayload>(message.eventId, (payload) => ({ ...withoutQueued(payload), withdrawn: true }));
    }
    return withdrawn;
  }

  /**
   * D50: requests still open after a stopped turn ended (the CLI withdraws them
   * with `control_cancel_request`; this is the fallback when it did not): closed
   * as `cancelled`. Returns the ids it closed.
   */
  async cancelRequests(requestIds: readonly string[]): Promise<string[]> {
    const closed: string[] = [];
    for (const id of requestIds) {
      const open = this.#openRequests.get(id);
      if (!open) continue;
      this.#openRequests.delete(id);
      this.#activity.requestClosed(id);
      await this.#setRequestState(open, 'cancelled');
      closed.push(id);
    }
    this.#syncActivity();
    return closed;
  }

  /** D50 background: the main agent's pending background tasks (D30 / D43), oldest first. */
  backgroundTasks(): BackgroundTask[] {
    return this.#background.list();
  }

  /**
   * D50 background: the CLI answered a `stop_task` for this task but reported no
   * end within the wait: the task ends here as stopped (the background wait and, for
   * a background agent, its card).
   */
  async endBackgroundTask(taskId: string): Promise<void> {
    this.#taskNotified(taskId, null);
    await this.#onTaskEnd(taskId, 'stopped');
    this.#syncActivity();
  }

  /** D50: the CLI did not acknowledge a Stop in time (or its turn did not end): the chat's error line. */
  async recordStopTimeout(waitedMs: number, missing: 'ack' | 'result'): Promise<EventRecord> {
    return this.#append('error', stopTimeoutText(waitedMs), { type: 'stop', outcome: 'timeout', waitedMs, missing });
  }

  /**
   * D19: what the running turn is doing now (`docs/derivations.md` → *Live
   * activity*), with the pending background tasks (D30); while no turn runs, the
   * background wait, else `null`.
   */
  activity(): SessionActivity | null {
    return this.#activity.snapshot(this.#background.list());
  }

  /** D19: the process ended: no turn runs any more; D30: no background task is pending either. */
  endActivity(): void {
    this.#activity.endTurn();
    this.#background.clear();
    this.#waitedKeys.clear();
    this.#subagentSeen.clear();
    this.#subagentByToolUse.clear();
    this.#syncActivity();
  }

  /** Opens the turn for the status (a no-op while one is open). */
  #openTurn(): void {
    if (this.#turnOpen) return;
    this.#turnOpen = true;
    this.#turnTookUp = false;
  }

  /** A turn starts (D19); D30: when none ran, the wake-ups have fired. */
  #startTurn(): void {
    if (!this.#activity.running) this.#background.turnStarted();
    this.#activity.startTurn();
  }

  /** 2026-10-16: a sign of life of a pending background task (by its task id, else its call). */
  #touchBackground(taskId: string | null, toolUseId: string | null): void {
    if (!(taskId !== null && this.#background.touch(taskId)) && toolUseId !== null) this.#background.touch(toolUseId);
  }

  /** D30: the CLI reported a task's end (`system/task_notification`, or a `<task-notification>` text). */
  #taskNotified(taskId: string | null, toolUseId: string | null): void {
    this.#background.notified(taskId, toolUseId);
  }

  /** Reports the activity to `onActivity` when it differs from the last one reported. */
  #syncActivity(): void {
    const activity = this.activity();
    const key = JSON.stringify(activity);
    if (key === this.#activityKey) return;
    this.#activityKey = key;
    this.#onActivity?.(activity);
  }

  /** D51: a task's final status (any task: the workflow service keeps only its runs' task ids). */
  #workflowEnded(taskId: string, status: string | null): void {
    if (taskId !== '' && status !== null && isTaskFinished(status)) this.#onWorkflow?.({ kind: 'ended', taskId, status });
  }

  // ── events ─────────────────────────────────────────────────────────────

  async #append(kind: EventKind, label: string, payload: EventPayload, extra: {
    agentId?: string | null;
    uuid?: string | null;
    messageId?: string | null;
    toolUseId?: string | null;
  } = {}): Promise<EventRecord> {
    const event = await this.#store.events.append({
      sessionId: this.#sessionId,
      agentId: extra.agentId === undefined ? this.#mainAgentId : extra.agentId,
      kind,
      label,
      payload,
      uuid: extra.uuid ?? null,
      messageId: extra.messageId ?? null,
      toolUseId: extra.toolUseId ?? null,
    });
    await this.#store.sessions.update(this.#sessionId, { lastActivityAt: event.ts });
    this.#onEvent(event);
    return event;
  }

  async #update(id: number, patch: Parameters<Store['events']['update']>[1]): Promise<EventRecord | null> {
    const event = await this.#store.events.update(id, patch);
    if (event) this.#onEvent(event);
    return event;
  }

  async #patchPayload<P extends EventPayload>(id: number, change: (payload: P) => P, extra: { endTs?: string; uuid?: string } = {}): Promise<void> {
    const event = await this.#store.events.get(id);
    if (!event) return;
    await this.#update(id, { payload: change(event.payload as P), ...extra });
  }

  /**
   * Records a user message Switchboard is about to write to stdin (one more pending
   * turn). D44: it is queued (`UserPayload.queued`) when a turn runs or other
   * messages still wait (`turn`), or when `options.resuming` says the process was
   * started for it because the session had none (`resume`); until the CLI takes it up.
   */
  async recordUserMessage(
    text: string,
    origin: UserMessageOrigin,
    options: { readonly resuming?: boolean; readonly attachments?: readonly Attachment[]; readonly sentText?: string; readonly loop?: UserLoopMark; readonly eventId?: number } = {},
  ): Promise<EventRecord> {
    const queued = queuedReason({ turnRunning: this.#pendingTurns > 0 || this.#turnOpen, resuming: options.resuming === true });
    // D50: a new message ends the stop: a later interrupted result is a failure again.
    this.#stopRequested = false;
    this.#pendingTurns++;
    // D124: a new turn is coming: the last turn's wait for the developer is over.
    await this.#onTurnStart?.('message');
    // D57: the attachments' listing (no bytes) and, when the attached files' lines were added, the text as sent.
    const attachments = options.attachments ?? [];
    const sentText = options.sentText !== undefined && options.sentText !== text ? options.sentText : undefined;
    const payload: UserPayload = {
      type: 'user',
      text,
      origin,
      delivered: false,
      ...(queued ? { queued } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(sentText !== undefined ? { sentText } : {}),
      // D94: a Switchboard loop's firing (the chat's "⟳ <label> · run <n>" chip).
      ...(options.loop ? { loop: options.loop } : {}),
    };
    const label = text.trim() === '' && attachments.length > 0 ? attachmentsLabel(attachments) : textLabel(text);
    // D103: a message held for an account with allowance keeps its event (and its place in the chat).
    const adopted = options.eventId !== undefined ? await this.#update(options.eventId, { payload }) : null;
    const event = adopted ?? (await this.#append(userMessageKind(text), label, payload));
    this.#queue.sent(event.id, text, queued, { ...(sentText !== undefined ? { match: sentText } : {}), attachments });
    return event;
  }

  /**
   * D44: the process ended: the messages still queued lose `queued` (the CLI never
   * took them up and nothing sends them again), so no clock stays behind.
   */
  async closeQueued(): Promise<void> {
    for (const eventId of this.#queue.ended()) await this.#clearQueued(eventId);
  }

  /** D44: the message's event loses `queued` (the CLI took it up); re-sent on `/hub` as an `event`. */
  async #clearQueued(eventId: number, extra: { delivered?: true; uuid?: string } = {}): Promise<void> {
    await this.#patchPayload<UserPayload>(
      eventId,
      (payload) => ({ ...withoutQueued(payload), ...(extra.delivered ? { delivered: true } : {}) }),
      extra.uuid ? { uuid: extra.uuid } : {},
    );
  }

  /** Records a process lifecycle step (`kind` `text`, or `error` for a failure). */
  async recordLifecycle(kind: EventKind, label: string, payload: EventPayload): Promise<EventRecord> {
    return this.#append(kind, label, payload);
  }

  /**
   * Sets the pid on a lifecycle event recorded before the process had one (OpenCode's server is
   * spawned after `spawn` returned, so its start line is written with `pid: null`); re-sent on `/hub`.
   * Nothing when the event is gone or is not a lifecycle event.
   */
  async setLifecyclePid(eventId: number, pid: number): Promise<void> {
    const event = await this.#store.events.get(eventId);
    if (!event || (event.payload as { readonly type?: unknown }).type !== 'lifecycle') return;
    await this.#patchPayload<LifecyclePayload>(eventId, (payload) => ({ ...payload, pid }));
  }

  /** Marks an open request answered by Switchboard (M3.1 writes the `control_response`). */
  async markResponded(requestId: string, behavior: string): Promise<void> {
    const open = this.#openRequests.get(requestId);
    if (!open) return;
    this.#openRequests.delete(requestId);
    this.#activity.requestClosed(requestId);
    this.#syncActivity();
    await this.#setRequestState(open, 'responded', behavior);
  }

  /** The process ended: every open request is stale (never answered, M0.2). Returns their ids. */
  async closeOpenRequests(): Promise<string[]> {
    const ids = [...this.#openRequests.keys()];
    for (const [id, open] of this.#openRequests) {
      this.#openRequests.delete(id);
      this.#activity.requestClosed(id);
      await this.#setRequestState(open, 'stale');
    }
    this.#syncActivity();
    return ids;
  }

  /** The process ended: running subagents were cut off. */
  async closeRunningAgents(): Promise<void> {
    for (const [taskId, runKey] of this.#runningAgents.all()) {
      const agent = await this.#runRow(taskId, runKey);
      if (agent && agent.status === 'run') {
        await this.#store.agents.update(agent.id, { status: 'idle', statusText: null, endedAt: new Date().toISOString() });
        this.#activity.agentEnded(agent.id);
      }
    }
    this.#runningAgents.clear();
    this.#syncActivity();
  }

  async #setRequestState(open: OpenRequest, state: RequestState, behavior?: string, answeredOn?: AnsweredOn | null): Promise<void> {
    const where = answeredOn ? { answeredOn } : {};
    if (open.onToolEvent) {
      await this.#patchPayload<ToolPayload>(open.eventId, (payload) => ({ ...payload, requestState: state, ...where }));
    } else {
      await this.#patchPayload<RequestPayload>(open.eventId, (payload) => ({
        ...payload,
        state,
        ...(behavior ? { behavior } : {}),
        ...where,
      }));
    }
  }

  // ── stream ─────────────────────────────────────────────────────────────

  async #agentFor(parentToolUseId: string | null): Promise<string> {
    if (!parentToolUseId) return this.#mainAgentId;
    let id = this.#agentByToolUse.get(parentToolUseId);
    if (!id) {
      const agent = await this.#store.agents.findByToolUseId(this.#sessionId, parentToolUseId);
      if (!agent) return this.#mainAgentId;
      id = agent.id;
      this.#agentByToolUse.set(parentToolUseId, agent.id);
      if (agent.taskId) this.#taskOfToolUse.set(parentToolUseId, agent.taskId);
    }
    // 2026-10-16: a resumed agent's lines keep its first call as their parent: they belong to the task's latest open run.
    const taskId = this.#taskOfToolUse.get(parentToolUseId);
    const latest = taskId !== undefined ? this.#runningAgents.latest(taskId) : null;
    if (taskId !== undefined && latest !== null && latest !== parentToolUseId) {
      const cached = this.#agentByToolUse.get(latest);
      if (cached) return cached;
      const row = await this.#runRow(taskId, latest);
      if (row) return row.id;
    }
    return id;
  }

  async #setTranscriptUuid(uuid: string | null, parentToolUseId: string | null): Promise<void> {
    if (!uuid || parentToolUseId || uuid === this.#lastTranscriptUuid) return;
    this.#lastTranscriptUuid = uuid;
    await this.#store.sessions.update(this.#sessionId, { lastTranscriptUuid: uuid });
  }

  /** Records one parsed stdout message (and reports the live activity when it changed, D19). */
  async handle(message: StreamMessage): Promise<void> {
    // 2026-10-16: a subagent's own line is its sign of life (the stale-subagent guard).
    const parent = 'parentToolUseId' in message ? message.parentToolUseId : null;
    if (typeof parent === 'string') this.#touchSubagent(this.#subagentByToolUse.get(parent) ?? this.#background.list().find((task) => task.toolUseId === parent)?.id ?? '');
    await this.#dispatch(message);
    this.#syncActivity();
  }

  /**
   * D49: what a stdout message changes in the context meter (`src/core/context-meter.ts`):
   * a turn's `init` (its model; the turn after a compaction's clears "compacted"),
   * a **main-agent** assistant line's usage (subagent lines carry a
   * `parent_tool_use_id` and never count), a result's `modelUsage` windows, a
   * main-chain `compact_boundary`.
   */
  #contextInput(message: StreamMessage): ContextInput | null {
    const at = this.#now().toISOString();
    switch (message.kind) {
      case 'init':
        return { kind: 'turn-start', model: message.model };
      case 'assistant': {
        if (message.parentToolUseId !== null) return null;
        const body = message.raw['message'];
        const usage = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)['usage'] : undefined;
        return { kind: 'usage', model: message.model, usage, at };
      }
      case 'result':
        return { kind: 'result', modelUsage: message.raw['modelUsage'] };
      case 'compact-boundary':
        if (message.parentToolUseId !== null) return null;
        return { kind: 'compact', trigger: message.trigger, preTokens: message.preTokens, postTokens: message.postTokens, at };
      default:
        return null;
    }
  }

  async #updateContext(message: StreamMessage): Promise<void> {
    const input = this.#contextInput(message);
    if (input === null) return;
    const next = reduceContext(this.#context, input);
    if (next === this.#context) return;
    this.#context = next;
    await this.#store.sessions.update(this.#sessionId, { context: next });
    this.#onContext?.();
  }

  async #dispatch(message: StreamMessage): Promise<void> {
    await this.#updateContext(message);
    switch (message.kind) {
      case 'init':
        return this.#onInit(message);
      case 'replay':
        return this.#onReplay(message);
      case 'assistant':
        return this.#onAssistant(message);
      case 'tool-result':
        return this.#onToolResult(message);
      case 'user-text':
        return this.#onUserText(message);
      case 'result':
        return this.#onResult(message);
      case 'rate-limit':
        return this.#onRateLimit(message);
      case 'can-use-tool':
        return this.#onCanUseTool(message);
      case 'control-cancel':
        return this.#onCancel(message.requestId);
      case 'task-started':
        this.#touchSubagent(message.taskId);
        this.#background.touch(message.taskId);
        if (message.toolUseId) this.#subagentByToolUse.set(message.toolUseId, message.taskId);
        // D43: every background task the CLI reports counts, whatever its type.
        this.#background.started(message);
        return this.#onTaskStarted(message);
      case 'task-progress':
        this.#touchSubagent(message.taskId);
        this.#background.touch(message.taskId);
        // D51: a workflow's live list of phases and agents.
        if (message.workflowProgress !== null && message.taskId !== '') this.#onWorkflow?.({ kind: 'progress', taskId: message.taskId, progress: message.workflowProgress });
        return this.#onTaskProgress(message);
      case 'task-updated':
        this.#touchSubagent(message.taskId);
        this.#background.touch(message.taskId);
        // D43: a terminal status ends a background task; `is_backgrounded: true` moves a foreground one there.
        this.#background.updated(message.taskId, message.status, message.backgrounded);
        this.#workflowEnded(message.taskId, message.status);
        return this.#onTaskEnd(message.taskId, message.status);
      case 'task-notification':
        // 2026-10-16: a late end of an earlier run of a resumed task ends nothing (the new run goes on).
        if (message.toolUseId !== null && message.taskId !== '' && this.#runningAgents.has(message.taskId) && this.#runningAgents.isEnded(message.toolUseId)) return;
        this.#taskNotified(message.taskId || null, message.toolUseId);
        this.#workflowEnded(message.taskId, message.status);
        return this.#onTaskEnd(message.taskId, message.status, message.toolUseId);
      case 'thinking-tokens': {
        // D19: ticks without `parent_tool_use_id` are the main agent's (the only ones observed).
        const agentId = await this.#agentFor(message.parentToolUseId);
        this.#activity.thinkingTokens(agentId, message.estimatedTokens, message.estimatedTokensDelta);
        return;
      }
      case 'permission-denied':
        await this.#append('ask', `Denied · ${message.toolName ?? 'tool'}${message.decisionReason ? ` (${message.decisionReason})` : ''}`, {
          type: 'denied',
          toolName: message.toolName,
          toolUseId: message.toolUseId,
          message: message.message,
          decisionReason: message.decisionReason,
        }, { toolUseId: message.toolUseId, uuid: message.uuid });
        return;
      default:
        return;
    }
  }

  async #onInit(message: Extract<StreamMessage, { kind: 'init' }>): Promise<void> {
    // D25: a `--teleport` process may report `init` at startup, before any message: that one is no turn.
    const startup = this.#startupInit && this.#pendingTurns === 0 && !this.#turnOpen;
    this.#startupInit = false;
    if (!startup) {
      if (this.#pendingTurns > 0) {
        // D44: the turn starts on the oldest message no turn has started on: it no longer waits.
        const taken = this.#queue.turnStarted();
        if (taken !== null) await this.#clearQueued(taken);
      }
      // `system/init` opens every turn (M0.1): a user message was taken up, or the CLI started one itself.
      this.#openTurn();
      this.#startTurn();
      // D124: any new turn clears the last turn's wait for the developer.
      await this.#onTurnStart?.('stream');
    }
    const patch: { observedPermissionMode?: string | null; cliVersion?: string | null } = {};
    if (message.permissionMode !== this.#observedMode) {
      this.#observedMode = message.permissionMode;
      patch.observedPermissionMode = message.permissionMode;
    }
    if (message.version && message.version !== this.#cliVersion) {
      this.#cliVersion = message.version;
      patch.cliVersion = message.version;
    }
    if (Object.keys(patch).length > 0) await this.#store.sessions.update(this.#sessionId, patch);
    if (this.#requestedMode === DEFAULT_PERMISSION_MODE && message.permissionMode !== DEFAULT_PERMISSION_MODE && this.#onPermissionFallback) {
      // D6: `auto` is not available for this model (the CLI silently reports `default`): switch to the fallback.
      this.#requestedMode = FALLBACK_PERMISSION_MODE;
      await this.#store.sessions.update(this.#sessionId, { requestedPermissionMode: FALLBACK_PERMISSION_MODE });
      this.#onPermissionFallback(FALLBACK_PERMISSION_MODE);
      await this.#append(
        'text',
        `Auto mode is not available for this model: permissions use ${FALLBACK_PERMISSION_MODE}`,
        { type: 'mode-mismatch', requested: DEFAULT_PERMISSION_MODE, observed: message.permissionMode, fallback: FALLBACK_PERMISSION_MODE },
      );
      return;
    }
    if (this.#requestedMode === CHAT_PERMISSION_MODE && message.permissionMode !== CHAT_PERMISSION_MODE && this.#onPermissionFallback) {
      // D106: a chat stays in plan mode: whatever took the CLI out of it, Switchboard sets it back at once (every turn it reports another mode).
      this.#onPermissionFallback(CHAT_PERMISSION_MODE);
      await this.#append('text', `The chat left plan mode (${message.permissionMode ?? 'none'}): set back to plan`, {
        type: 'mode-mismatch',
        requested: CHAT_PERMISSION_MODE,
        observed: message.permissionMode,
        fallback: CHAT_PERMISSION_MODE,
      });
      return;
    }
    if (this.#requestedMode && message.permissionMode !== this.#requestedMode && !this.#modeMismatchFlagged) {
      this.#modeMismatchFlagged = true;
      await this.#append(
        'error',
        `Permission mode mismatch: requested ${this.#requestedMode}, the CLI reports ${message.permissionMode ?? 'none'}`,
        { type: 'mode-mismatch', requested: this.#requestedMode, observed: message.permissionMode },
      );
    }
  }

  async #onReplay(message: Extract<StreamMessage, { kind: 'replay' }>): Promise<void> {
    // D30: a task's end as a replayed `<task-notification>` (not seen on CLI 2.1.283) is no stdin message of ours.
    const notification = parseTaskNotification(message.text);
    if (notification) {
      if (endsTask(notification)) this.#taskNotified(notification.taskId, notification.toolUseId);
      // 2026-10-16: a monitor's event notice is its sign of life.
      else this.#touchBackground(notification.taskId, notification.toolUseId);
      await this.#setTranscriptUuid(message.uuid, null);
      return;
    }
    const taken = this.#queue.replayed(message.text);
    if (taken?.withdrawn) {
      // D50: a message a Stop withdrew had been taken up already (into the turn the Stop aborts): it
      // was delivered after all, so its bubble comes back. It was no pending turn any more.
      await this.#patchPayload<UserPayload>(
        taken.eventId,
        (payload) => {
          const { withdrawn: _withdrawn, ...rest } = withoutQueued(payload);
          return { ...rest, delivered: true };
        },
        message.uuid ? { uuid: message.uuid } : {},
      );
      await this.#setTranscriptUuid(message.uuid, null);
      return;
    }
    // The CLI took up a stdin message (D19: the turn starts, if `init` did not start it already).
    // It is no longer to come: the open turn (its own, or the one it was folded into) answers it.
    this.#openTurn();
    if (this.#pendingTurns > 0) this.#pendingTurns--;
    this.#turnTookUp = true;
    this.#startTurn();
    // Delivered; D44: no longer queued (a message a running turn absorbs is echoed mid-turn, without an `init`).
    if (taken) await this.#clearQueued(taken.eventId, { delivered: true, ...(message.uuid ? { uuid: message.uuid } : {}) });
    await this.#setTranscriptUuid(message.uuid, null);
  }

  async #onAssistant(message: Extract<StreamMessage, { kind: 'assistant' }>): Promise<void> {
    const agentId = await this.#agentFor(message.parentToolUseId);
    for (const block of message.blocks) {
      const note = progressNoteText(block);
      if (block.type === 'thinking' && note === null) this.#activity.thinking(agentId);
      if (note !== null) {
        // D96: a progress note (non-empty thinking text on the newest models): agent text, shown in the chat.
        this.#activity.writing(agentId);
        await this.#recordText(agentId, message, note, true);
      } else if (block.type === 'text') {
        if (block.text.trim() === '') continue;
        this.#activity.writing(agentId);
        await this.#recordText(agentId, message, block.text, false);
      } else if (block.type === 'tool_use') {
        const command = block.name === 'Bash' ? bashCommand(block.input) : null;
        const kind = toolEventKind(block.name, { rerunAfterError: command !== null && this.#failedCommands.has(command) });
        const { input, truncated } = clipInput(block.input);
        const payload: ToolPayload = { type: 'tool', name: block.name, toolUseId: block.id, input, ...(truncated ? { inputTruncated: true } : {}) };
        const event = await this.#append(kind, toolLabel(block.name, block.input), payload, {
          agentId,
          uuid: message.uuid,
          messageId: message.messageId,
          toolUseId: block.id,
        });
        this.#tools.set(block.id, { eventId: event.id, name: block.name, file: writtenFile(block.name, block.input), command, agentId });
        this.#activity.toolStarted(agentId, block.id, block.name, block.input);
        // D30: the main agent's calls that may start background work.
        if (agentId === this.#mainAgentId) this.#background.called(block.id, block.name, block.input);
        // 2026-10-16: a subagent's `SubagentHandback` is its final report: it has finished (the real CLI may stream no task event for it).
        else if (block.name === SUBAGENT_HANDBACK && message.parentToolUseId !== null) await this.#subagentHandedBack(message.parentToolUseId);
        if (AGENT_TOOLS.includes(block.name) && block.id) await this.#createSubagent(block.id, block.input);
      }
    }
    await this.#setTranscriptUuid(message.uuid, message.parentToolUseId);
  }

  /**
   * One text block (or D96 progress note) of an assistant message: the blocks of
   * one message are merged into one event (notes into their own, apart from the
   * text). D96: a note whose text the message already has is not added again (a
   * duplicated line: a retry, a resume, a copied branch).
   */
  async #recordText(agentId: string, message: Extract<StreamMessage, { kind: 'assistant' }>, text: string, note: boolean): Promise<void> {
    const id = message.messageId ?? message.uuid ?? '';
    const key = id ? (note ? `note:${id}` : id) : '';
    const merged = key ? this.#textByMessage.get(key) : undefined;
    const flag = note ? { note: true as const } : {};
    if (merged) {
      if (note && merged.parts.includes(text)) return;
      merged.parts.push(text);
      merged.text = `${merged.text}\n\n${text}`;
      // Fix · long messages: the text is stored in full (up to the safety cap), not cut at the tool limit.
      const cut = clipMessage(merged.text);
      await this.#update(merged.eventId, {
        label: textLabel(merged.text),
        payload: { type: 'assistant', text: cut.text, messageId: message.messageId, ...(cut.truncated ? { truncated: true } : {}), ...flag },
      });
      return;
    }
    const cut = clipMessage(text);
    const event = await this.#append('text', textLabel(text), { type: 'assistant', text: cut.text, messageId: message.messageId, ...(cut.truncated ? { truncated: true } : {}), ...flag }, {
      agentId,
      uuid: message.uuid,
      messageId: message.messageId,
    });
    if (key) this.#textByMessage.set(key, { eventId: event.id, text, parts: [text] });
  }

  async #createSubagent(toolUseId: string, input: Readonly<Record<string, unknown>>): Promise<void> {
    const existing = await this.#store.agents.findByToolUseId(this.#sessionId, toolUseId);
    if (existing) {
      if (existing.status === 'run') this.#activity.agentStarted(existing.id);
      return;
    }
    const seed = subagentFromToolUse(input);
    const agent = await this.#store.agents.create({
      sessionId: this.#sessionId,
      kind: 'subagent',
      name: seed.name,
      description: seed.description,
      subagentType: seed.subagentType,
      toolUseId,
      status: 'run',
    });
    this.#agentByToolUse.set(toolUseId, agent.id);
    this.#activity.agentStarted(agent.id);
  }

  async #onToolResult(message: Extract<StreamMessage, { kind: 'tool-result' }>): Promise<void> {
    for (const result of message.results) {
      this.#activity.toolEnded(result.toolUseId);
      // D30: the structured `tool_use_result` belongs to the line's one result.
      this.#background.resulted(result.toolUseId, {
        text: result.text,
        isError: result.isError,
        ...(message.results.length === 1 ? { detail: message.toolUseResult } : {}),
      });
      const entry = this.#tools.get(result.toolUseId);
      if (!entry) continue;
      // 1.24 perf: the call is over; nothing reads its entry after its result.
      this.#tools.delete(result.toolUseId);
      if (entry.name === 'Workflow' && !result.isError) {
        // D51: the run a Workflow call launched (its run id: the key to its files).
        const launch = workflowLaunch(result.text, message.results.length === 1 ? message.toolUseResult : undefined);
        if (launch) this.#onWorkflow?.({ kind: 'launched', launch, toolUseId: result.toolUseId });
      }
      const cut = clip(result.text);
      await this.#patchPayload<ToolPayload>(entry.eventId, (payload) => ({
        ...payload,
        result: cut.text,
        ...(cut.truncated ? { resultTruncated: true } : {}),
        isError: result.isError,
      }), { endTs: new Date().toISOString() });
      if (entry.command !== null && result.isError) this.#failedCommands.add(entry.command);
      if (!result.isError) await this.#onWrite(entry);
      if (AGENT_TOOLS.includes(entry.name)) await this.#onAgentToolResult(result.toolUseId, result.isError);
    }
    await this.#setTranscriptUuid(message.uuid, message.parentToolUseId);
  }

  /** A foreground Agent call without task events ends with its tool_result. */
  async #onAgentToolResult(toolUseId: string, isError: boolean): Promise<void> {
    const agent = await this.#store.agents.findByToolUseId(this.#sessionId, toolUseId);
    if (agent && agent.taskId && agent.status === 'run' && isError && this.#stopRequested) {
      // D50: a foreground subagent cut off by the Stop (its call's result is the interrupt's error):
      // it is idle, like a subagent a stopped process leaves behind, and no longer keeps the session running.
      await this.#store.agents.update(agent.id, { status: 'idle', statusText: null, endedAt: new Date().toISOString() });
      this.#activity.agentEnded(agent.id);
      this.#runningAgents.end(agent.taskId, agent.toolUseId);
      return;
    }
    if (!agent || agent.taskId || agent.status !== 'run') return;
    await this.#store.agents.update(agent.id, { status: isError ? 'fail' : 'done', statusText: null, endedAt: new Date().toISOString() });
    this.#activity.agentEnded(agent.id);
  }

  async #onUserText(message: Extract<StreamMessage, { kind: 'user-text' }>): Promise<void> {
    // D30: a task's end as a `<task-notification>` user line (not seen on CLI 2.1.283, which keeps it in the transcript).
    const notification = message.parentToolUseId ? null : parseTaskNotification(message.text);
    if (notification) {
      if (endsTask(notification)) this.#taskNotified(notification.taskId, notification.toolUseId);
      // 2026-10-16: a monitor's event notice is its sign of life.
      else this.#touchBackground(notification.taskId, notification.toolUseId);
      await this.#setTranscriptUuid(message.uuid, message.parentToolUseId);
      return;
    }
    if (!message.interrupt && message.parentToolUseId && message.text.trim() !== '') {
      const agentId = await this.#agentFor(message.parentToolUseId);
      const cut = clipMessage(message.text);
      await this.#append('text', textLabel(message.text), { type: 'agent-prompt', text: cut.text, ...(cut.truncated ? { truncated: true } : {}) }, { agentId, uuid: message.uuid });
    }
    await this.#setTranscriptUuid(message.uuid, message.parentToolUseId);
  }

  async #onResult(message: Extract<StreamMessage, { kind: 'result' }>): Promise<void> {
    // The running turn is over, with every message it took up (however many, whatever
    // the result's origin). Without a replay echo for the turn (a stream without
    // `--replay-user-messages`), a result that is not the CLI's own still answers
    // the oldest message we wrote.
    if (!this.#turnTookUp && !message.taskNotification && this.#pendingTurns > 0) this.#pendingTurns--;
    this.#turnOpen = false;
    this.#turnTookUp = false;
    // D19: a turn's result → idle (a queued message's turn starts when the CLI takes it up).
    this.#activity.endTurn();
    this.#failedCommands.clear();
    this.#textByMessage.clear();
    if (this.#stopping) return;
    if (this.#stopRequested && isInterruptedResult(message)) {
      // D50: the turn the developer stopped: the session is idle, ready for the next message.
      this.#lastOutcome = 'stopped';
      // D124: a stopped turn is not text-checked (a declaration made in it still counts).
      await this.#onTurnEnd?.({ outcome: 'stopped', text: null });
      if (this.#stopLineWritten) return;
      this.#stopLineWritten = true;
      await this.#append('text', STOPPED_LABEL, {
        type: 'result',
        subtype: message.subtype,
        isError: message.isError,
        text: null,
        terminalReason: message.terminalReason,
        errors: message.errors,
        taskNotification: message.taskNotification,
        numTurns: message.numTurns,
        durationMs: message.durationMs,
        costUsd: message.totalCostUsd,
        // D78: the turn's tokens (a todo's actuals add them up).
        tokens: resultTurnTokens(message.raw),
        // D108: the split and the model the CLI reported (Insights).
        ...resultInsightFields(message.raw),
        // D134: the CLI's cumulative per-model usage (the Usage breakdown's subagent tokens).
        ...modelTotalsField(message.raw),
        stopped: true,
      }, { uuid: message.uuid });
      return;
    }
    this.#lastOutcome = message.isError ? 'error' : 'success';
    // D124: done or waiting for the developer: its turn_status, else the text check of its last text.
    await this.#onTurnEnd?.({ outcome: this.#lastOutcome, text: message.text });
    const label = message.isError
      ? [message.subtype, message.errors[0]].filter(Boolean).join(': ')
      : textLabel(message.text ?? '') || 'Done';
    const text = message.text === null ? null : clip(message.text).text;
    await this.#append(resultEventKind(message.isError), label, {
      type: 'result',
      subtype: message.subtype,
      isError: message.isError,
      text,
      terminalReason: message.terminalReason,
      errors: message.errors,
      taskNotification: message.taskNotification,
      numTurns: message.numTurns,
      durationMs: message.durationMs,
      costUsd: message.totalCostUsd,
      // D78: the turn's tokens (a todo's actuals add them up).
      tokens: resultTurnTokens(message.raw),
      // D108: the split and the model the CLI reported (Insights).
      ...resultInsightFields(message.raw),
      // D134: the CLI's cumulative per-model usage (the Usage breakdown's subagent tokens).
      ...modelTotalsField(message.raw),
    }, { uuid: message.uuid });
  }

  async #onRateLimit(message: Extract<StreamMessage, { kind: 'rate-limit' }>): Promise<void> {
    // A free usage reading (M9.2, src/core/usage.ts): utilization × 100, reset epoch seconds → ISO.
    const reading = readingFromRateLimit(message);
    await this.#store.usage.add({
      source: 'rate_limit_event',
      sessionId: this.#sessionId,
      profileId: this.#profileId,
      fiveHourPct: reading.fiveHourPct,
      fiveHourResetsAt: reading.fiveHourResetsAt,
      sevenDayPct: reading.sevenDayPct,
      sevenDayResetsAt: reading.sevenDayResetsAt,
      raw: message.raw,
    });
  }

  async #onCanUseTool(message: Extract<StreamMessage, { kind: 'can-use-tool' }>): Promise<void> {
    const tool = message.toolUseId ? this.#tools.get(message.toolUseId) : undefined;
    if (message.toolName === 'AskUserQuestion' && tool) {
      await this.#patchPayload<ToolPayload>(tool.eventId, (payload) => ({ ...payload, requestId: message.requestId, requestState: 'open' }));
      this.#openRequests.set(message.requestId, { eventId: tool.eventId, toolName: message.toolName, onToolEvent: true });
      this.#activity.requestOpened(message.requestId, tool.agentId);
      return;
    }
    const agent = message.agentId ? await this.#store.agents.findByTaskId(this.#sessionId, message.agentId) : null;
    const { input } = clipInput(message.input);
    const event = await this.#append('ask', `Permission · ${toolLabel(message.toolName, message.input)}`, {
      type: 'request',
      requestId: message.requestId,
      toolName: message.toolName,
      toolUseId: message.toolUseId,
      input,
      agentId: message.agentId,
      description: message.description,
      decisionReason: message.decisionReason,
      state: 'open',
    }, { agentId: agent?.id ?? this.#mainAgentId, toolUseId: message.toolUseId });
    this.#openRequests.set(message.requestId, { eventId: event.id, toolName: message.toolName, onToolEvent: false });
    this.#activity.requestOpened(message.requestId, agent?.id ?? this.#mainAgentId);
  }

  async #onCancel(requestId: string): Promise<void> {
    const open = this.#openRequests.get(requestId);
    if (!open) return;
    this.#openRequests.delete(requestId);
    this.#activity.requestClosed(requestId);
    // D24: withdrawn because the phone answered first (Remote Control on), not by an interrupt.
    await this.#setRequestState(open, 'cancelled', undefined, this.#answeredOn?.() ?? null);
  }

  async #onTaskStarted(message: Extract<StreamMessage, { kind: 'task-started' }>): Promise<void> {
    if (message.taskType !== null && message.taskType !== AGENT_TASK_TYPE) return;
    let agent = message.toolUseId ? await this.#store.agents.findByToolUseId(this.#sessionId, message.toolUseId) : null;
    if (agent) {
      agent = await this.#store.agents.update(agent.id, {
        taskId: message.taskId,
        subagentType: message.subagentType ?? agent.subagentType,
        description: agent.description ?? message.description,
        status: 'run',
      });
    } else {
      agent = await this.#store.agents.create({
        sessionId: this.#sessionId,
        kind: 'subagent',
        name: message.subagentType ?? 'agent',
        description: message.description,
        subagentType: message.subagentType,
        toolUseId: message.toolUseId,
        taskId: message.taskId,
        status: 'run',
      });
    }
    if (agent && message.toolUseId) {
      this.#agentByToolUse.set(message.toolUseId, agent.id);
      this.#taskOfToolUse.set(message.toolUseId, message.taskId);
    }
    if (agent) this.#activity.agentStarted(agent.id);
    // 2026-10-16: a task id seen before (a SendMessage resume) is a new run of its own.
    this.#runningAgents.start(message.taskId, message.toolUseId ?? message.taskId);
  }

  async #onTaskProgress(message: Extract<StreamMessage, { kind: 'task-progress' }>): Promise<void> {
    if (!this.#runningAgents.has(message.taskId)) return;
    const agent = await this.#runRow(message.taskId, this.#runningAgents.latest(message.taskId));
    if (agent && message.description && agent.statusText !== message.description) {
      await this.#store.agents.update(agent.id, { statusText: message.description });
    }
  }

  /**
   * A task's end (`task_updated` / `task_notification` with a final status, a handback, a stop):
   * ends the run its `toolUseId` names when open, else the task's latest open run (2026-10-16:
   * a resumed task has several runs, each its own row).
   */
  async #onTaskEnd(taskId: string, status: string | null, toolUseId: string | null = null): Promise<void> {
    if (!isTaskFinished(status)) return;
    const runKey = this.#runningAgents.end(taskId, toolUseId);
    // A stale end (an earlier run's) while a newer run is open: nothing ends.
    if (runKey === null && this.#runningAgents.has(taskId)) return;
    if (!this.#runningAgents.has(taskId)) this.#subagentSeen.delete(taskId);
    const agent = await this.#runRow(taskId, runKey);
    if (agent && agent.status === 'run') {
      const next: SessionStatus = agentStatusFromTask(status);
      await this.#store.agents.update(agent.id, { status: next, statusText: null, endedAt: new Date().toISOString() });
    }
    if (agent) this.#activity.agentEnded(agent.id);
  }

  /** The `agents` row of a task's run: by the run's starting call, else the task's newest row. */
  async #runRow(taskId: string, runKey: string | null): Promise<AgentRecord | null> {
    if (runKey !== null && runKey !== taskId) {
      const row = await this.#store.agents.findByToolUseId(this.#sessionId, runKey);
      if (row) return row;
    }
    return this.#store.agents.findByTaskId(this.#sessionId, taskId);
  }

  // ── written files: the writing agent's place, the session's solutions ─────
  // (D89: the files no longer become artifacts; artifacts are saved on purpose.)

  async #branchFor(file: string): Promise<string | null> {
    const worktrees = await this.#store.worktrees.list({ sessionId: this.#sessionId });
    const hit = worktrees.find((w) => file === w.path || file.startsWith(w.path + path.sep));
    return hit?.branch ?? null;
  }

  /** A successful write (Write / Edit / NotebookEdit …): places its agent (M4.3) and adds the solution to the session's (D38). */
  async #onWrite(entry: ToolEntry): Promise<void> {
    const place = this.#place;
    const file = entry.file;
    if (!place || !file) return;
    await this.#placeAgent(entry.agentId, path.resolve(place.cwd, file));
    // D38: the solution joins the session's solutions (fill-in from what its agents touch).
    const solution = writtenSolution(place, path.resolve(place.cwd, file), this.#sessionName);
    if (solution !== null && this.#onSolutionWritten) await this.#onSolutionWritten(solution);
  }

  /**
   * Where an agent works (M4.3, the agent card's path + ⎇ branch;
   * `docs/derivations.md` → *Agents*): its first successful write into a
   * solution sets `solutionPath` (the repo folder, `solutionFolder`) and `branch`
   * (the session's registered worktree that holds the file, else none). Later
   * writes elsewhere do not move it; a later write into the same solution's
   * worktree fills a missing branch. Workspace-root files place nobody.
   */
  async #placeAgent(agentId: string, file: string): Promise<void> {
    if (!this.#place) return;
    const folder = sessionSolutionFolder(this.#place, file, this.#sessionName);
    if (!folder) return;
    const agent = await this.#store.agents.get(agentId);
    if (!agent) return;
    const branch = await this.#branchFor(file);
    if (agent.solutionPath === null) {
      await this.#store.agents.update(agent.id, { solutionPath: folder, branch });
    } else if (agent.solutionPath === folder && agent.branch === null && branch !== null) {
      await this.#store.agents.update(agent.id, { branch });
    }
  }
}

/** A write tool's (`WRITE_TOOLS`) file: its `file_path`, else its `notebook_path`; `null` for any other call. */
function writtenFile(name: string, input: Readonly<Record<string, unknown>>): string | null {
  if (!WRITE_TOOLS.includes(name)) return null;
  const file = typeof input['file_path'] === 'string' ? input['file_path'] : typeof input['notebook_path'] === 'string' ? input['notebook_path'] : null;
  return file || null;
}

/** D134: `{ modelTotals }` of a raw `result` line (the CLI's cumulative `modelUsage`), `{}` without token counts. */
function modelTotalsField(raw: unknown): { readonly modelTotals?: ModelTotals } {
  const totals = resultModelTotals(raw);
  return totals ? { modelTotals: totals } : {};
}
