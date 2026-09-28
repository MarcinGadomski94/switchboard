import path from 'node:path';
import type { ArtifactType, EventKind, SessionStatus } from '../../core/model.ts';
import {
  type EventPayload,
  type RequestPayload,
  type RequestState,
  type ToolPayload,
  type UserMessageOrigin,
  type UserPayload,
  clip,
  clipInput,
} from '../../core/event-payload.ts';
import { AGENT_TASK_TYPE, agentStatusFromTask, isTaskFinished, subagentFromToolUse } from '../../core/derive/agents.ts';
import {
  createdBranches,
  diffArtifactName,
  fileArtifactType,
  findPullRequests,
  locateFile,
  runsGh,
  solutionFolder,
} from '../../core/derive/artifacts.ts';
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
import type { StreamMessage } from '../../core/stream-json.ts';
import { readingFromRateLimit } from '../../core/usage.ts';
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
}

interface ToolEntry {
  readonly eventId: number;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
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

/**
 * Turns one process's stream-json messages into stored state
 * (`docs/derivations.md`): events (chat, timeline, terminal tail), agents,
 * artifacts, usage readings and the session's CLI fields. It also keeps the
 * bookkeeping the session status is derived from: pending turns, open
 * `can_use_tool` requests, running subagents and the last turn's outcome.
 *
 * One instance per process; calls must be serialized (the supervisor queues them).
 */
export class StreamRecorder {
  readonly #store: Store;
  readonly #sessionId: string;
  readonly #sessionName: string;
  readonly #root: string | null;
  #requestedMode: string | null;
  readonly #mainAgentId: string;
  readonly #onEvent: (event: EventRecord) => void;
  readonly #onPermissionFallback: ((mode: string) => void) | undefined;

  /** User messages written to stdin whose turn has not produced its `result` yet. */
  #pendingTurns = 0;
  /** The CLI runs a turn of its own (a background agent finishing, `origin.kind: task-notification`). */
  #cliTurn = false;
  #lastOutcome: TurnOutcome | null = null;
  /** Set while Switchboard stops the process: the interrupted turn's result is not an outcome. */
  #stopping = false;
  readonly #openRequests = new Map<string, OpenRequest>();
  readonly #runningAgents = new Set<string>();
  readonly #textByMessage = new Map<string, { eventId: number; text: string }>();
  readonly #tools = new Map<string, ToolEntry>();
  readonly #agentByToolUse = new Map<string, string>();
  readonly #pendingUserEvents: Array<{ eventId: number; text: string }> = [];
  /** Bash commands of the current turn whose result was an error (rebuild detection, gap #7). */
  readonly #failedCommands = new Set<string>();
  #modeMismatchFlagged = false;
  #observedMode: string | null;
  #cliVersion: string | null;
  #lastTranscriptUuid: string | null;

  constructor(options: RecorderOptions) {
    this.#store = options.store;
    this.#sessionId = options.session.id;
    this.#sessionName = options.session.name;
    this.#root = options.session.cwd;
    this.#requestedMode = options.session.requestedPermissionMode;
    this.#mainAgentId = options.mainAgentId;
    this.#onEvent = options.onEvent;
    this.#onPermissionFallback = options.onPermissionFallback;
    this.#observedMode = options.session.observedPermissionMode;
    this.#cliVersion = options.session.cliVersion;
    this.#lastTranscriptUuid = options.session.lastTranscriptUuid;
  }

  /** The inputs of the live status derivation. */
  statusInput(): LiveStatusInput {
    return {
      live: true,
      openRequests: this.#openRequests.size,
      turnRunning: this.#pendingTurns > 0 || this.#cliTurn,
      runningAgents: this.#runningAgents.size,
      lastOutcome: this.#lastOutcome,
    };
  }

  /** `true` while a turn runs or waits for an answer (an interrupt then produces a `result`). */
  turnBusy(): boolean {
    return this.#pendingTurns > 0 || this.#cliTurn || this.#openRequests.size > 0;
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

  /** Records a user message Switchboard is about to write to stdin (one more pending turn). */
  async recordUserMessage(text: string, origin: UserMessageOrigin): Promise<EventRecord> {
    this.#pendingTurns++;
    const event = await this.#append(userMessageKind(text), textLabel(text), { type: 'user', text, origin, delivered: false });
    this.#pendingUserEvents.push({ eventId: event.id, text });
    return event;
  }

  /** Records a process lifecycle step (`kind` `text`, or `error` for a failure). */
  async recordLifecycle(kind: EventKind, label: string, payload: EventPayload): Promise<EventRecord> {
    return this.#append(kind, label, payload);
  }

  /** Marks an open request answered by Switchboard (M3.1 writes the `control_response`). */
  async markResponded(requestId: string, behavior: string): Promise<void> {
    const open = this.#openRequests.get(requestId);
    if (!open) return;
    this.#openRequests.delete(requestId);
    await this.#setRequestState(open, 'responded', behavior);
  }

  /** The process ended: every open request is stale (never answered, M0.2). Returns their ids. */
  async closeOpenRequests(): Promise<string[]> {
    const ids = [...this.#openRequests.keys()];
    for (const [id, open] of this.#openRequests) {
      this.#openRequests.delete(id);
      await this.#setRequestState(open, 'stale');
    }
    return ids;
  }

  /** The process ended: running subagents were cut off. */
  async closeRunningAgents(): Promise<void> {
    for (const taskId of this.#runningAgents) {
      const agent = await this.#store.agents.findByTaskId(this.#sessionId, taskId);
      if (agent) await this.#store.agents.update(agent.id, { status: 'idle', statusText: null, endedAt: new Date().toISOString() });
    }
    this.#runningAgents.clear();
  }

  async #setRequestState(open: OpenRequest, state: RequestState, behavior?: string): Promise<void> {
    if (open.onToolEvent) {
      await this.#patchPayload<ToolPayload>(open.eventId, (payload) => ({ ...payload, requestState: state }));
    } else {
      await this.#patchPayload<RequestPayload>(open.eventId, (payload) => ({
        ...payload,
        state,
        ...(behavior ? { behavior } : {}),
      }));
    }
  }

  // ── stream ─────────────────────────────────────────────────────────────

  async #agentFor(parentToolUseId: string | null): Promise<string> {
    if (!parentToolUseId) return this.#mainAgentId;
    const cached = this.#agentByToolUse.get(parentToolUseId);
    if (cached) return cached;
    const agent = await this.#store.agents.findByToolUseId(this.#sessionId, parentToolUseId);
    if (!agent) return this.#mainAgentId;
    this.#agentByToolUse.set(parentToolUseId, agent.id);
    return agent.id;
  }

  async #setTranscriptUuid(uuid: string | null, parentToolUseId: string | null): Promise<void> {
    if (!uuid || parentToolUseId || uuid === this.#lastTranscriptUuid) return;
    this.#lastTranscriptUuid = uuid;
    await this.#store.sessions.update(this.#sessionId, { lastTranscriptUuid: uuid });
  }

  /** Records one parsed stdout message. */
  async handle(message: StreamMessage): Promise<void> {
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
        return this.#onTaskStarted(message);
      case 'task-progress':
        return this.#onTaskProgress(message);
      case 'task-updated':
      case 'task-notification':
        return this.#onTaskEnd(message.taskId, message.status);
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
    if (this.#pendingTurns === 0 && !this.#cliTurn) this.#cliTurn = true;
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
    const at = this.#pendingUserEvents.findIndex((pending) => pending.text === message.text);
    const pending = at >= 0 ? this.#pendingUserEvents.splice(at, 1)[0] : this.#pendingUserEvents.shift();
    if (pending) {
      await this.#patchPayload<UserPayload>(
        pending.eventId,
        (payload) => ({ ...payload, delivered: true }),
        message.uuid ? { uuid: message.uuid } : {},
      );
    }
    await this.#setTranscriptUuid(message.uuid, null);
  }

  async #onAssistant(message: Extract<StreamMessage, { kind: 'assistant' }>): Promise<void> {
    const agentId = await this.#agentFor(message.parentToolUseId);
    for (const block of message.blocks) {
      if (block.type === 'text') {
        if (block.text.trim() === '') continue;
        const key = message.messageId ?? message.uuid ?? '';
        const merged = key ? this.#textByMessage.get(key) : undefined;
        if (merged) {
          merged.text = `${merged.text}\n\n${block.text}`;
          const cut = clip(merged.text);
          await this.#update(merged.eventId, {
            label: textLabel(merged.text),
            payload: { type: 'assistant', text: cut.text, messageId: message.messageId },
          });
        } else {
          const cut = clip(block.text);
          const event = await this.#append('text', textLabel(block.text), { type: 'assistant', text: cut.text, messageId: message.messageId }, {
            agentId,
            uuid: message.uuid,
            messageId: message.messageId,
          });
          if (key) this.#textByMessage.set(key, { eventId: event.id, text: block.text });
        }
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
        this.#tools.set(block.id, { eventId: event.id, name: block.name, input: block.input, command, agentId });
        if (AGENT_TOOLS.includes(block.name) && block.id) await this.#createSubagent(block.id, block.input);
      }
    }
    await this.#setTranscriptUuid(message.uuid, message.parentToolUseId);
  }

  async #createSubagent(toolUseId: string, input: Readonly<Record<string, unknown>>): Promise<void> {
    const existing = await this.#store.agents.findByToolUseId(this.#sessionId, toolUseId);
    if (existing) return;
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
  }

  async #onToolResult(message: Extract<StreamMessage, { kind: 'tool-result' }>): Promise<void> {
    for (const result of message.results) {
      const entry = this.#tools.get(result.toolUseId);
      if (!entry) continue;
      const cut = clip(result.text);
      await this.#patchPayload<ToolPayload>(entry.eventId, (payload) => ({
        ...payload,
        result: cut.text,
        ...(cut.truncated ? { resultTruncated: true } : {}),
        isError: result.isError,
      }), { endTs: new Date().toISOString() });
      if (entry.command !== null && result.isError) this.#failedCommands.add(entry.command);
      if (!result.isError) await this.#deriveArtifacts(entry, result.text);
      if (AGENT_TOOLS.includes(entry.name)) await this.#onAgentToolResult(result.toolUseId, result.isError);
    }
    await this.#setTranscriptUuid(message.uuid, message.parentToolUseId);
  }

  /** A foreground Agent call without task events ends with its tool_result. */
  async #onAgentToolResult(toolUseId: string, isError: boolean): Promise<void> {
    const agent = await this.#store.agents.findByToolUseId(this.#sessionId, toolUseId);
    if (!agent || agent.taskId || agent.status !== 'run') return;
    await this.#store.agents.update(agent.id, { status: isError ? 'fail' : 'done', statusText: null, endedAt: new Date().toISOString() });
  }

  async #onUserText(message: Extract<StreamMessage, { kind: 'user-text' }>): Promise<void> {
    if (!message.interrupt && message.parentToolUseId && message.text.trim() !== '') {
      const agentId = await this.#agentFor(message.parentToolUseId);
      const cut = clip(message.text);
      await this.#append('text', textLabel(message.text), { type: 'agent-prompt', text: cut.text }, { agentId, uuid: message.uuid });
    }
    await this.#setTranscriptUuid(message.uuid, message.parentToolUseId);
  }

  async #onResult(message: Extract<StreamMessage, { kind: 'result' }>): Promise<void> {
    if (message.taskNotification || this.#pendingTurns === 0) this.#cliTurn = false;
    else this.#pendingTurns--;
    this.#failedCommands.clear();
    this.#textByMessage.clear();
    if (this.#stopping) return;
    this.#lastOutcome = message.isError ? 'error' : 'success';
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
    }, { uuid: message.uuid });
  }

  async #onRateLimit(message: Extract<StreamMessage, { kind: 'rate-limit' }>): Promise<void> {
    // A free usage reading (M9.2, src/core/usage.ts): utilization × 100, reset epoch seconds → ISO.
    const reading = readingFromRateLimit(message);
    await this.#store.usage.add({
      source: 'rate_limit_event',
      sessionId: this.#sessionId,
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
  }

  async #onCancel(requestId: string): Promise<void> {
    const open = this.#openRequests.get(requestId);
    if (!open) return;
    this.#openRequests.delete(requestId);
    await this.#setRequestState(open, 'cancelled');
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
    if (agent && message.toolUseId) this.#agentByToolUse.set(message.toolUseId, agent.id);
    this.#runningAgents.add(message.taskId);
  }

  async #onTaskProgress(message: Extract<StreamMessage, { kind: 'task-progress' }>): Promise<void> {
    if (!this.#runningAgents.has(message.taskId)) return;
    const agent = await this.#store.agents.findByTaskId(this.#sessionId, message.taskId);
    if (agent && message.description && agent.statusText !== message.description) {
      await this.#store.agents.update(agent.id, { statusText: message.description });
    }
  }

  async #onTaskEnd(taskId: string, status: string | null): Promise<void> {
    if (!isTaskFinished(status)) return;
    const agent = await this.#store.agents.findByTaskId(this.#sessionId, taskId);
    if (agent && agent.status === 'run') {
      const next: SessionStatus = agentStatusFromTask(status);
      await this.#store.agents.update(agent.id, { status: next, statusText: null, endedAt: new Date().toISOString() });
    }
    this.#runningAgents.delete(taskId);
  }

  // ── artifacts (gap #9) ─────────────────────────────────────────────────

  async #branchFor(file: string): Promise<string | null> {
    const worktrees = await this.#store.worktrees.list({ sessionId: this.#sessionId });
    const hit = worktrees.find((w) => file === w.path || file.startsWith(w.path + path.sep));
    return hit?.branch ?? null;
  }

  async #deriveArtifacts(entry: ToolEntry, output: string): Promise<void> {
    if (!this.#root) return;
    if (WRITE_TOOLS.includes(entry.name)) {
      const file = typeof entry.input['file_path'] === 'string'
        ? (entry.input['file_path'] as string)
        : typeof entry.input['notebook_path'] === 'string'
          ? (entry.input['notebook_path'] as string)
          : null;
      if (file) {
        await this.#fileArtifacts(path.resolve(this.#root, file));
        await this.#placeAgent(entry.agentId, path.resolve(this.#root, file));
      }
      return;
    }
    if (entry.name === 'Bash' && entry.command) {
      for (const created of createdBranches(entry.command)) {
        const solution = created.dir ? locateFile(this.#root, path.join(created.dir, '_'), this.#sessionName).solution : null;
        await this.#upsertArtifact(`branch:${this.#sessionId}:${solution ?? ''}:${created.branch}`, 'BRANCH', created.branch, {
          solution,
          branch: created.branch,
        });
      }
      if (runsGh(entry.command)) {
        for (const pr of findPullRequests(output)) {
          await this.#upsertArtifact(`pr:${this.#sessionId}:${pr.owner}/${pr.repo}#${pr.number}`, 'PR', `${pr.repo} #${pr.number}`, {
            solution: pr.repo,
            url: pr.url,
          });
        }
      }
    }
  }

  async #fileArtifacts(file: string): Promise<void> {
    if (!this.#root) return;
    const where = locateFile(this.#root, file, this.#sessionName);
    if (where.outside) return;
    const branch = await this.#branchFor(file);
    const type = fileArtifactType(where.relative);
    if (type) {
      await this.#upsertArtifact(`file:${this.#sessionId}:${where.solution ?? ''}:${where.relative}`, type, where.relative, {
        solution: where.solution,
        branch,
        path: file,
      });
    }
    if (where.solution) {
      const id = `diff:${this.#sessionId}:${where.solution}:${branch ?? ''}`;
      const existing = await this.#store.artifacts.get(id);
      const data = existing?.data as { files?: unknown } | null | undefined;
      const files = Array.isArray(data?.files) ? (data.files as string[]) : [];
      if (!files.includes(where.relative)) files.push(where.relative);
      await this.#upsertArtifact(id, 'DIFF', diffArtifactName(files), { solution: where.solution, branch, data: { files } });
    }
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
    if (!this.#root) return;
    const folder = solutionFolder(this.#root, file, this.#sessionName);
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

  async #upsertArtifact(id: string, type: ArtifactType, name: string, fields: {
    solution?: string | null;
    branch?: string | null;
    path?: string | null;
    url?: string | null;
    data?: unknown;
  }): Promise<void> {
    await this.#store.artifacts.upsert({ id, type, name, sessionId: this.#sessionId, ...fields });
  }
}
