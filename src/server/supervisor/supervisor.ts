import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { AttachWarningReason, NewSession, ResumeCommand, Session, SessionEvent } from '../../core/api.ts';
import { mainAgentName } from '../../core/derive/agents.ts';
import { type StopReason, deriveSessionStatus } from '../../core/derive/status.ts';
import type { LifecycleAction, LifecyclePayload, RequestPayload, ToolPayload, UserMessageOrigin } from '../../core/event-payload.ts';
import type { SessionStatus } from '../../core/model.ts';
import { type ControlRequestLine, type ToolDecision, controlErrorLine, controlSuccessLine, interruptLine, userMessageLine } from '../../core/stdin.ts';
import { type CanUseToolMessage, type ControlResponseMessage, type StreamMessage, parseStreamLine } from '../../core/stream-json.ts';
import type { EventRecord } from '../db/repos/events.ts';
import type { PendingMessageRecord } from '../db/repos/pending-messages.ts';
import type { SessionPatch, SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { toEvent, toSession } from '../sessions/wire.ts';
import { type ClaudeStart, DEFAULT_PERMISSION_MODE, buildClaudeArgs, childEnv, resumeCommand } from './argv.ts';
import { attachWarningMessage, attachWarnings, claudeConfigDir, findTranscriptFile, importTerminalTurns } from './attach.ts';
import { ClaudeProcess, type ProcessExit } from './process.ts';
import type { LiveProcessLister } from './recovery.ts';
import { StreamRecorder } from './recorder.ts';

/** How long each step of a D7 stop may take before the next escalation (ms). */
export interface StopTimeouts {
  /** The interrupt's `control_response`. */
  readonly ack: number;
  /** The interrupted turn's `result` (only when a turn was running). */
  readonly result: number;
  /** Exit after EOF. */
  readonly exit: number;
  /** Exit after each signal (SIGINT, then SIGTERM, then SIGKILL). */
  readonly signal: number;
}

/** Defaults: the CLI answers an interrupt in well under a second (M0.1, M0.4). */
export const DEFAULT_STOP_TIMEOUTS: StopTimeouts = { ack: 5_000, result: 10_000, exit: 10_000, signal: 3_000 };

/** The message D7 sends on Resume. */
export const RESUME_MESSAGE = 'Continue.';

/** Context of a `can_use_tool` request handed to the question pipeline (M3.1). */
export interface CanUseToolContext {
  readonly session: SessionRecord;
  readonly request: CanUseToolMessage;
}

/**
 * The question pipeline's hooks (M3.1). The supervisor records the request as an
 * `ask` event and keeps the session in `need` until {@link SessionSupervisor.respond}
 * writes the reply; the pipeline stores batches / permission items and answers them.
 */
export interface ControlRequestHandler {
  /** A `can_use_tool` request arrived (AskUserQuestion = a question batch; anything else = a permission item). */
  canUseTool?(context: CanUseToolContext): void | Promise<void>;
  /** The CLI withdrew the request (`control_cancel_request`, after an interrupt): never answer it. */
  cancelled?(sessionId: string, requestId: string): void | Promise<void>;
  /** The process ended with these requests still open: they are stale. */
  orphaned?(sessionId: string, requestIds: readonly string[]): void | Promise<void>;
  /**
   * These outbox messages (`pending_messages`) just went out ahead of a stdin user
   * message (M3.1: a queued stale batch's answers are delivered now).
   */
  pendingDelivered?(sessionId: string, messages: readonly PendingMessageRecord[]): void | Promise<void>;
}

/** Options of {@link SessionSupervisor.start}. */
export interface StartOptions {
  /** Runs after the session is stored, before its process is spawned (M2.2: link its worktrees). */
  readonly beforeSpawn?: (session: SessionRecord) => Promise<void>;
}

/** Notifications for the `/hub` (M2.3), same names and payloads as the contract. */
export interface SupervisorEvents {
  readonly sessionUpdated: Session;
  readonly event: { readonly sessionId: string; readonly event: SessionEvent };
}

/** Options for {@link SessionSupervisor}. */
export interface SupervisorOptions {
  readonly store: Store;
  /** CLI argv prefix (`SWITCHBOARD_CLAUDE_BIN`). */
  readonly claudeCommand: readonly string[];
  /** Dev-only flags appended to every spawn (`SWITCHBOARD_CLAUDE_EXTRA_ARGS`). */
  readonly claudeExtraArgs?: readonly string[];
  /** `SWITCHBOARD_WORKSPACE_ROOT`; sessions cannot start while it is `null`. */
  readonly workspaceRoot: string | null;
  /** Base environment of the children (default `process.env`); scrubbed by `childEnv`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly timeouts?: Partial<StopTimeouts>;
  readonly controlHandler?: ControlRequestHandler;
  /**
   * `claude agents --json` for the "Attach here" warning (M4.1: `claudeAgentsLister`
   * in recovery.ts). Without one, liveness is unknown and every attach asks first.
   */
  readonly listLive?: LiveProcessLister;
  /** Called when processing a line or an exit throws (default: `console.error`). */
  readonly onError?: (error: unknown) => void;
}

/** Options of {@link SessionSupervisor.attach}. */
export interface AttachOptions {
  /** Attach even when a terminal may still hold the session (the developer confirmed the warning). */
  readonly confirm?: boolean;
}

/** Why the supervisor refused a call. `code` maps to an HTTP status in the routes. */
export type SupervisorErrorCode =
  | 'not-found'
  | 'workspace-not-configured'
  | 'workspace-missing'
  | 'detached'
  | 'already-running'
  | 'request-not-open'
  | 'closing'
  | 'attach-warning';

/** A refusal of the supervisor. */
export class SupervisorError extends Error {
  override name = 'SupervisorError';
  readonly code: SupervisorErrorCode;
  constructor(code: SupervisorErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** "Attach here" without `confirm` while a terminal may still hold the session (M4.1, gap #5): nothing was spawned. */
export class AttachWarningError extends SupervisorError {
  override name = 'AttachWarningError';
  readonly reasons: readonly AttachWarningReason[];
  constructor(reasons: readonly AttachWarningReason[]) {
    super('attach-warning', attachWarningMessage(reasons));
    this.reasons = reasons;
  }
}

interface Waiter {
  readonly match: (message: StreamMessage) => boolean;
  readonly resolve: (matched: boolean) => void;
}

/** One live `claude` process of a session. */
interface Live {
  readonly sessionId: string;
  readonly proc: ClaudeProcess;
  readonly recorder: StreamRecorder;
  readonly waiters: Set<Waiter>;
  /** Serializes line and exit handling. */
  queue: Promise<void>;
  /** Resolves once the exit has been handled. */
  finished: Promise<void>;
  stopping: StopReason | null;
  /** How a stop ended the process: `eof` or the last signal sent. */
  stoppedBy: string | null;
  status: SessionStatus;
}

type Listener<K extends keyof SupervisorEvents> = (payload: SupervisorEvents[K]) => void;

/**
 * Runs one long-lived `claude` process per session (`docs/handoff/ARCHITECTURE.md`
 * → *Claude Code integration*; D6, D7): start, send messages, pause, resume,
 * detach / attach. Every stdout line is parsed (src/core/stream-json.ts) and
 * recorded (recorder.ts); the status is derived after each line
 * (src/core/derive/status.ts, `docs/derivations.md`).
 */
export class SessionSupervisor {
  readonly #store: Store;
  readonly #command: readonly string[];
  readonly #extraArgs: readonly string[];
  readonly #root: string | null;
  readonly #env: NodeJS.ProcessEnv;
  readonly #timeouts: StopTimeouts;
  readonly #handler: ControlRequestHandler;
  readonly #onError: (error: unknown) => void;
  readonly #listLive: LiveProcessLister | null;
  readonly #live = new Map<string, Live>();
  /** Attach calls run one at a time per session (the check and the spawn must not interleave). */
  readonly #attaching = new Map<string, Promise<unknown>>();
  readonly #listeners = { sessionUpdated: new Set<Listener<'sessionUpdated'>>(), event: new Set<Listener<'event'>>() };
  #closing = false;
  /** Session commands wait for this while restart recovery runs ({@link SessionSupervisor.holdCommands}). */
  #gate: Promise<void> = Promise.resolve();

  constructor(options: SupervisorOptions) {
    this.#store = options.store;
    this.#command = options.claudeCommand;
    this.#extraArgs = options.claudeExtraArgs ?? [];
    this.#root = options.workspaceRoot;
    this.#env = options.env ?? process.env;
    this.#timeouts = { ...DEFAULT_STOP_TIMEOUTS, ...options.timeouts };
    this.#handler = options.controlHandler ?? {};
    this.#onError = options.onError ?? ((error) => console.error('switchboard supervisor:', error));
    this.#listLive = options.listLive ?? null;
  }

  /** Subscribes to a notification; returns the unsubscribe function. */
  on<K extends keyof SupervisorEvents>(name: K, listener: Listener<K>): () => void {
    const set = this.#listeners[name] as Set<Listener<K>>;
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Number of live supervised processes (gap #11). */
  get liveCount(): number {
    return this.#live.size;
  }

  /** `true` while the session has a live process. */
  isLive(sessionId: string): boolean {
    return this.#live.has(sessionId);
  }

  /** The live process's pid, or `null`. */
  pid(sessionId: string): number | null {
    return this.#live.get(sessionId)?.proc.pid ?? null;
  }

  // ── commands ───────────────────────────────────────────────────────────

  /**
   * Stores a new session and starts its process in the workspace root with a new
   * `--session-id`. The first stdin message is `firstMessage` (the task text until
   * M5.2 adds the confirmed session-start answers); an empty one leaves the process idle.
   * The input must already be validated (sessions/validate.ts). `options.beforeSpawn`
   * runs once the session is stored and before its process starts (M2.2 links the
   * session's worktrees there).
   */
  async start(input: NewSession, firstMessage: string = input.task, options: StartOptions = {}): Promise<SessionRecord> {
    this.#assertOpen();
    const cwd = await this.#workspaceCwd();
    const session = await this.#store.sessions.create({
      name: input.name,
      task: input.task,
      claudeSessionId: randomUUID(),
      status: 'idle',
      workType: input.workType,
      mode: input.mode,
      phase: input.phase,
      coordination: input.coordination,
      qaStack: input.qa?.stack ?? null,
      qaConfluenceUrl: input.qa?.confluenceUrl ?? null,
      qaFigmaUrls: [...(input.qa?.figmaUrls ?? [])],
      solutions: [...input.solutions],
      worktrees: input.worktrees,
      ultracode: input.ultracode,
      attached: true,
      cwd,
      requestedPermissionMode: DEFAULT_PERMISSION_MODE,
    });
    await this.#store.agents.create({
      sessionId: session.id,
      kind: 'main',
      name: mainAgentName(session.mode, session.solutions),
      status: 'idle',
    });
    if (options.beforeSpawn) await options.beforeSpawn(session);
    const live = await this.#spawn(session, { kind: 'new', claudeSessionId: session.claudeSessionId }, 'started');
    if (firstMessage.trim() !== '') await this.#send(live, firstMessage, 'task');
    else await this.#enqueue(live, () => this.#refreshStatus(live));
    return this.#get(session.id);
  }

  /**
   * Sends a user message. A session without a live process is resumed with
   * `--resume` and gets the message instead of "Continue.". Refused while detached.
   */
  async sendMessage(sessionId: string, text: string, origin: UserMessageOrigin = 'user'): Promise<SessionRecord> {
    await this.#gate;
    this.#assertOpen();
    const session = await this.#get(sessionId);
    if (!session.attached) throw new SupervisorError('detached', 'the session continues in a terminal; attach it first');
    let live = this.#live.get(sessionId);
    if (live?.stopping) {
      await live.finished;
      live = undefined;
    }
    if (!live) live = await this.#spawn(await this.#get(sessionId), { kind: 'resume', claudeSessionId: session.claudeSessionId }, 'resumed');
    await this.#send(live, text, origin);
    return this.#get(sessionId);
  }

  /**
   * Sends a user message only to a live process that is not being stopped (M3.1:
   * a stale batch's answers go out at once while the session runs). Never spawns:
   * returns `false` and writes nothing when there is no such process (or the service
   * is closing), so the caller can queue the message for the session's next run.
   */
  async sendToLive(sessionId: string, text: string, origin: UserMessageOrigin = 'service'): Promise<boolean> {
    await this.#gate;
    if (this.#closing) return false;
    const live = this.#live.get(sessionId);
    if (!live || live.stopping || !live.proc.running) return false;
    await this.#send(live, text, origin);
    return true;
  }

  /** D7 Pause: interrupt, EOF, exit (escalating on timeout). The session ends `paused`. */
  async pause(sessionId: string): Promise<SessionRecord> {
    await this.#gate;
    const session = await this.#get(sessionId);
    const live = this.#live.get(sessionId);
    if (live) await this.#stop(live, 'pause');
    return live ? this.#get(sessionId) : session;
  }

  /** D7 Resume: `--resume <claudeSessionId>` + "Continue.". */
  async resume(sessionId: string): Promise<SessionRecord> {
    await this.#gate;
    this.#assertOpen();
    const session = await this.#get(sessionId);
    if (!session.attached) throw new SupervisorError('detached', 'the session continues in a terminal; attach it first');
    if (this.#live.has(sessionId)) throw new SupervisorError('already-running', 'the session already has a live process');
    const live = await this.#spawn(session, { kind: 'resume', claudeSessionId: session.claudeSessionId }, 'resumed');
    await this.#send(live, RESUME_MESSAGE, 'resume');
    return this.#get(sessionId);
  }

  /** "Continue in terminal": the D7 stop, then the session is no longer attached. */
  async detach(sessionId: string): Promise<ResumeCommand> {
    await this.#gate;
    const session = await this.#get(sessionId);
    const live = this.#live.get(sessionId);
    if (live) {
      await this.#stop(live, 'detach');
    } else if (session.attached) {
      await this.#store.sessions.update(sessionId, { attached: false, detachedAt: new Date().toISOString() });
      await this.#recordStandalone(sessionId, 'detached', 'Continued in a terminal');
      await this.#emitSession(sessionId);
    }
    return { resumeCommand: resumeCommand(session.claudeSessionId) };
  }

  /**
   * "Attach here" (M4.1, `docs/supervisor.md` → *Attach here*). When the session
   * has a live process nothing happens (never two live processes on one id).
   * Otherwise, unless `options.confirm`, it first checks whether a terminal may
   * still hold the session (transcript changed < 2 min ago, or `claude agents
   * --json` lists the id, or that list cannot be read) and throws
   * {@link AttachWarningError} without spawning. Then it imports the turns the
   * terminal added (transcript entries after the sync point) as events, and spawns
   * `--resume` with the baseline flags and no message: the process stays idle
   * until the developer writes.
   */
  async attach(sessionId: string, options: AttachOptions = {}): Promise<ResumeCommand> {
    await this.#gate;
    const previous = this.#attaching.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.#attachNow(sessionId, options));
    this.#attaching.set(sessionId, run);
    try {
      return await run;
    } finally {
      if (this.#attaching.get(sessionId) === run) this.#attaching.delete(sessionId);
    }
  }

  async #attachNow(sessionId: string, options: AttachOptions): Promise<ResumeCommand> {
    this.#assertOpen();
    const session = await this.#get(sessionId);
    const command = { resumeCommand: resumeCommand(session.claudeSessionId) };
    if (this.#live.has(sessionId)) return command;
    const transcript = await findTranscriptFile(claudeConfigDir(this.#env), session.claudeSessionId);
    if (options.confirm !== true) {
      const reasons = await attachWarnings({ transcript, claudeSessionId: session.claudeSessionId, listLive: this.#listLive, now: Date.now() });
      if (reasons.length > 0) throw new AttachWarningError(reasons);
    }
    this.#assertOpen();
    if (this.#live.has(sessionId)) return command;
    if (transcript) await this.#importTranscript(await this.#get(sessionId), transcript);
    const attached = (await this.#store.sessions.update(sessionId, { attached: true, detachedAt: null })) ?? session;
    const live = await this.#spawn(attached, { kind: 'resume', claudeSessionId: session.claudeSessionId }, 'attached');
    await this.#enqueue(live, () => this.#refreshStatus(live));
    return command;
  }

  /** Sync back (M4.1): the terminal's turns from the transcript become events; a failure is recorded, never fatal. */
  async #importTranscript(session: SessionRecord, transcript: string): Promise<void> {
    try {
      const result = await importTerminalTurns({
        store: this.#store,
        session,
        mainAgentId: await this.#mainAgentId(session),
        transcript,
        onEvent: (event) => this.#emitEvent(event),
      });
      if (!result.found) {
        await this.recordServiceEvent(session.id, 'error', 'Could not sync the terminal\'s turns', {
          type: 'lifecycle',
          action: 'attached',
          message: `The last transcript entry Switchboard saw (${session.lastTranscriptUuid ?? 'none'}) is not in ${transcript}; nothing was imported.`,
        });
      }
    } catch (error) {
      this.#onError(error);
      await this.recordServiceEvent(session.id, 'error', 'Could not sync the terminal\'s turns', {
        type: 'lifecycle',
        action: 'attached',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Writes the reply to an open `can_use_tool` request (M3.1: answers, Allow once, Deny). */
  async respond(sessionId: string, requestId: string, decision: ToolDecision): Promise<void> {
    const live = this.#live.get(sessionId);
    if (!live || live.stopping || !live.recorder.hasOpenRequest(requestId) || !live.proc.write(controlSuccessLine(requestId, decision))) {
      throw new SupervisorError('request-not-open', 'the request is not open on a live process');
    }
    await this.#enqueue(live, async () => {
      await live.recorder.markResponded(requestId, decision.behavior);
      await this.#refreshStatus(live);
    });
  }

  // ── control requests Switchboard asks (M9.2 usage meter, docs/usage.md) ─

  /**
   * The sessions whose live process is between turns: no turn running, no open
   * request, not being stopped, stdin open. A control request such as `get_usage`
   * goes only there (M0.3 probed it between turns only).
   */
  idleLiveSessionIds(): string[] {
    return [...this.#live.values()]
      .filter((live) => !live.stopping && live.proc.running && !live.proc.inputClosed && !live.recorder.turnBusy())
      .map((live) => live.sessionId);
  }

  /**
   * Writes one stdin `control_request` (e.g. `get_usage`) to the session's live
   * process and resolves its `control_response`; `null` when the session has no
   * live process, is being stopped, or no response came within `timeoutMs` (the
   * process ended first, or it did not answer). The response is not an event.
   */
  async controlRequest(sessionId: string, line: ControlRequestLine, timeoutMs: number): Promise<ControlResponseMessage | null> {
    const live = this.#live.get(sessionId);
    if (!live || live.stopping || !live.proc.write(line)) return null;
    const box: { response?: ControlResponseMessage } = {};
    // Registered right after the write, before any stdout line can be processed.
    const answered = await this.#waitFor(
      live,
      (message) => {
        if (message.kind !== 'control-response' || message.requestId !== line.request_id) return false;
        box.response = message;
        return true;
      },
      timeoutMs,
    );
    return answered ? (box.response ?? null) : null;
  }

  // ── restart recovery (M2.4, recovery.ts) ──────────────────────────────

  /**
   * Holds `sendMessage`, `pause`, `resume`, `detach` and `attach` until the returned
   * function is called: the service listens while restart recovery runs, and a
   * command that raced it could spawn a second process on an id whose leftover is
   * still being stopped (M0.4). The recovery steps below are not held.
   */
  holdCommands(): () => void {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#gate = this.#gate.then(() => held);
    return release;
  }

  /**
   * D7 service restart: spawns `--resume <claudeSessionId>` with the baseline flags
   * (lifecycle `recovered`) and sends `message` as a service message, or nothing
   * (the process stays idle) when it is `null`. The caller has already made sure no
   * other process holds the id (recovery.ts).
   */
  async resumeAfterRestart(sessionId: string, message: string | null): Promise<SessionRecord> {
    this.#assertOpen();
    const session = await this.#get(sessionId);
    if (this.#live.has(sessionId)) throw new SupervisorError('already-running', 'the session already has a live process');
    const live = await this.#spawn(session, { kind: 'resume', claudeSessionId: session.claudeSessionId }, 'recovered');
    if (message !== null) await this.#send(live, message, 'service');
    else await this.#enqueue(live, () => this.#refreshStatus(live));
    return this.#get(sessionId);
  }

  /**
   * Clears what a service that died without stopping its processes left behind for
   * a session with no live process here: requests still marked open become stale
   * (never answered, M0.2) and go to the `orphaned` hook, running subagents become
   * idle, the recorded pid is cleared. Returns the stale request ids.
   */
  async settleAfterCrash(sessionId: string): Promise<string[]> {
    if (this.#live.has(sessionId)) return [];
    const stale: string[] = [];
    for (const event of await this.#store.events.list(sessionId)) {
      const payload = event.payload as Partial<ToolPayload> & Partial<RequestPayload> & { type?: unknown };
      let next: unknown = null;
      if (payload?.type === 'tool' && payload.requestState === 'open' && payload.requestId) {
        stale.push(payload.requestId);
        next = { ...payload, requestState: 'stale' };
      } else if (payload?.type === 'request' && payload.state === 'open' && payload.requestId) {
        stale.push(payload.requestId);
        next = { ...payload, state: 'stale' };
      }
      if (next === null) continue;
      const updated = await this.#store.events.update(event.id, { payload: next });
      if (updated) this.#emitEvent(updated);
    }
    if (stale.length > 0 && this.#handler.orphaned) {
      try {
        await this.#handler.orphaned(sessionId, stale);
      } catch (error) {
        this.#onError(error);
      }
    }
    const endedAt = new Date().toISOString();
    for (const agent of await this.#store.agents.listBySession(sessionId)) {
      if (agent.kind !== 'main' && (agent.status === 'run' || agent.status === 'need')) {
        await this.#store.agents.update(agent.id, { status: 'idle', statusText: null, endedAt });
      }
    }
    await this.#store.sessions.update(sessionId, { pid: null });
    return stale;
  }

  /** Records a lifecycle event for a session without a live process (restart recovery). */
  async recordServiceEvent(sessionId: string, kind: 'text' | 'error', label: string, payload: LifecyclePayload): Promise<void> {
    const event = await this.#store.events.append({ sessionId, kind, label, payload });
    this.#emitEvent(event);
  }

  /**
   * Leaves a session without a live process `paused` after a restart (a pause or
   * detach the crash cut short, or a session that could not be resumed safely);
   * `detached` also ends the attachment.
   */
  async markPausedAfterRestart(sessionId: string, detached = false): Promise<SessionRecord> {
    if (this.#live.has(sessionId)) throw new SupervisorError('already-running', 'the session already has a live process');
    const now = new Date().toISOString();
    await this.#store.sessions.update(sessionId, {
      status: 'paused',
      stopReason: null,
      pid: null,
      ...(detached ? { attached: false, detachedAt: now } : {}),
    });
    await this.#setMainAgentStatus(sessionId, 'paused');
    await this.#emitSession(sessionId);
    return this.#get(sessionId);
  }

  /** Stops every live process (service shutdown). Their stored status is kept so a restart can resume them (D7, M2.4). */
  async shutdown(): Promise<void> {
    this.#closing = true;
    await Promise.all([...this.#live.values()].map((live) => this.#stop(live, 'shutdown')));
  }

  // ── internals ──────────────────────────────────────────────────────────

  #assertOpen(): void {
    if (this.#closing) throw new SupervisorError('closing', 'the service is shutting down');
  }

  async #get(sessionId: string): Promise<SessionRecord> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) throw new SupervisorError('not-found', `no session ${sessionId}`);
    return session;
  }

  async #workspaceCwd(): Promise<string> {
    if (!this.#root) throw new SupervisorError('workspace-not-configured', 'SWITCHBOARD_WORKSPACE_ROOT is not set');
    try {
      return await realpath(this.#root);
    } catch {
      throw new SupervisorError('workspace-missing', `the workspace root does not exist: ${this.#root}`);
    }
  }

  async #mainAgentId(session: SessionRecord): Promise<string> {
    const agents = await this.#store.agents.listBySession(session.id);
    const main = agents.find((agent) => agent.kind === 'main');
    if (main) return main.id;
    const created = await this.#store.agents.create({
      sessionId: session.id,
      kind: 'main',
      name: mainAgentName(session.mode, session.solutions),
      status: session.status,
    });
    return created.id;
  }

  async #spawn(session: SessionRecord, start: ClaudeStart, action: LifecycleAction): Promise<Live> {
    const cwd = session.cwd ?? (await this.#workspaceCwd());
    const permissionMode = DEFAULT_PERMISSION_MODE;
    const prepared =
      (await this.#store.sessions.update(session.id, {
        cwd,
        requestedPermissionMode: permissionMode,
        stopReason: null,
        endedAt: null,
      })) ?? session;
    const mainAgentId = await this.#mainAgentId(prepared);
    const recorder = new StreamRecorder({
      store: this.#store,
      session: prepared,
      mainAgentId,
      onEvent: (event) => this.#emitEvent(event),
    });
    const args = buildClaudeArgs({ start, name: prepared.name, permissionMode, extraArgs: this.#extraArgs });
    const holder: { live?: Live } = {};
    const proc = new ClaudeProcess({
      command: this.#command,
      args,
      cwd,
      env: childEnv(this.#env),
      onLine: (line) => {
        const live = holder.live;
        if (live) void this.#enqueue(live, () => this.#onLine(live, line));
      },
    });
    const live: Live = {
      sessionId: session.id,
      proc,
      recorder,
      waiters: new Set(),
      queue: Promise.resolve(),
      finished: Promise.resolve(),
      stopping: null,
      stoppedBy: null,
      status: prepared.status,
    };
    holder.live = live;
    this.#live.set(session.id, live);
    live.finished = proc.exited.then((exit) => this.#enqueue(live, () => this.#onExit(live, exit)));
    await this.#store.sessions.update(session.id, { pid: proc.pid });
    await this.#enqueue(live, async () => {
      await recorder.recordLifecycle('text', LIFECYCLE_LABELS[action], { type: 'lifecycle', action, pid: proc.pid });
    });
    return live;
  }

  #enqueue(live: Live, work: () => Promise<void>): Promise<void> {
    const next = live.queue.then(work).catch((error: unknown) => this.#onError(error));
    live.queue = next;
    return next;
  }

  /**
   * Writes one stdin user message. The session's undelivered `pending_messages`
   * (the outbox: the M2.4 restart note, M3.1 stale answers) go first, in the same
   * message, and are marked delivered once written.
   */
  async #send(live: Live, text: string, origin: UserMessageOrigin): Promise<void> {
    await this.#enqueue(live, async () => {
      const pending = await this.#store.pendingMessages.pending(live.sessionId);
      const full = [...pending.map((message) => message.text), text].join('\n\n');
      await live.recorder.recordUserMessage(full, origin);
      if (live.proc.write(userMessageLine(full))) {
        for (const message of pending) await this.#store.pendingMessages.markDelivered(message.id);
        if (pending.length > 0 && this.#handler.pendingDelivered) {
          try {
            await this.#handler.pendingDelivered(live.sessionId, pending);
          } catch (error) {
            this.#onError(error);
          }
        }
      }
      await this.#refreshStatus(live);
    });
  }

  async #onLine(live: Live, line: string): Promise<void> {
    const message = parseStreamLine(line);
    if (message.kind === 'control-request') {
      live.proc.write(controlErrorLine(message.requestId, `Switchboard does not handle control request subtype "${message.subtype}"`));
    }
    await live.recorder.handle(message);
    if (message.kind === 'can-use-tool' && this.#handler.canUseTool) {
      try {
        await this.#handler.canUseTool({ session: await this.#get(live.sessionId), request: message });
      } catch (error) {
        this.#onError(error);
      }
    }
    if (message.kind === 'control-cancel' && this.#handler.cancelled) {
      try {
        await this.#handler.cancelled(live.sessionId, message.requestId);
      } catch (error) {
        this.#onError(error);
      }
    }
    for (const waiter of live.waiters) {
      if (waiter.match(message)) {
        live.waiters.delete(waiter);
        waiter.resolve(true);
      }
    }
    await this.#refreshStatus(live);
  }

  /** Resolves `true` when a matching message is processed, `false` on timeout or exit. */
  #waitFor(live: Live, match: (message: StreamMessage) => boolean, ms: number): Promise<boolean> {
    if (!live.proc.running) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        match,
        resolve: (matched) => {
          clearTimeout(timer);
          resolve(matched);
        },
      };
      const timer = setTimeout(() => {
        live.waiters.delete(waiter);
        resolve(false);
      }, ms);
      live.waiters.add(waiter);
    });
  }

  /**
   * The D7 stop: mark the reason → interrupt `control_request` → its
   * `control_response` (+ the running turn's `result`) → EOF → exit; on timeout
   * SIGINT → SIGTERM → SIGKILL. Resolves once the exit is recorded.
   */
  async #stop(live: Live, reason: StopReason): Promise<void> {
    if (live.stopping) {
      await live.finished;
      return;
    }
    live.stopping = reason;
    live.recorder.beginStop();
    if (reason !== 'shutdown') await this.#store.sessions.update(live.sessionId, { stopReason: reason });
    const t = this.#timeouts;
    const busy = live.recorder.turnBusy();
    const requestId = `sb-interrupt-${randomUUID()}`;
    const acked = this.#waitFor(live, (m) => m.kind === 'control-response' && m.requestId === requestId, t.ack);
    const ended = busy ? this.#waitFor(live, (m) => m.kind === 'result' && !m.taskNotification, t.result) : Promise.resolve(true);
    if (live.proc.write(interruptLine(requestId))) {
      await Promise.all([acked, ended]);
    }
    live.proc.endInput();
    live.stoppedBy = 'eof';
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
      if (await live.proc.waitForExit(signal === 'SIGINT' ? t.exit : t.signal)) break;
      live.stoppedBy = signal;
      live.proc.kill(signal);
    }
    await live.proc.exited;
    await live.finished;
  }

  async #onExit(live: Live, exit: ProcessExit): Promise<void> {
    for (const waiter of live.waiters) waiter.resolve(false);
    live.waiters.clear();
    const orphaned = await live.recorder.closeOpenRequests();
    if (orphaned.length > 0 && this.#handler.orphaned) {
      try {
        await this.#handler.orphaned(live.sessionId, orphaned);
      } catch (error) {
        this.#onError(error);
      }
    }
    await live.recorder.closeRunningAgents();
    const now = new Date().toISOString();
    const patch: { -readonly [K in keyof SessionPatch]: SessionPatch[K] } = { pid: null, stopReason: null };
    const base = { pid: live.proc.pid, code: exit.code, signal: exit.signal };
    const stoppedBy = live.stoppedBy ?? undefined;
    if (live.stopping === 'shutdown') {
      await live.recorder.recordLifecycle('text', 'Stopped with the service', { type: 'lifecycle', action: 'stopped', ...base, stoppedBy });
    } else {
      const status = deriveSessionStatus({
        live: false,
        stopReason: live.stopping,
        exitCode: exit.code,
        signal: exit.signal,
        spawnFailed: exit.spawnError !== null,
        lastOutcome: live.recorder.lastOutcome,
      });
      patch.status = status;
      if (status === 'done' || status === 'fail') patch.endedAt = now;
      if (live.stopping === 'detach') {
        patch.attached = false;
        patch.detachedAt = now;
      }
      if (live.stopping === 'pause') {
        await live.recorder.recordLifecycle('text', 'Paused', { type: 'lifecycle', action: 'paused', ...base, stoppedBy });
      } else if (live.stopping === 'detach') {
        await live.recorder.recordLifecycle('text', 'Continued in a terminal', { type: 'lifecycle', action: 'detached', ...base, stoppedBy });
      } else if (status === 'fail') {
        const message = exit.spawnError
          ? `Could not start claude: ${exit.spawnError.message}`
          : `claude exited unexpectedly (${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`})`;
        await live.recorder.recordLifecycle('error', message, {
          type: 'lifecycle',
          action: 'failed',
          ...base,
          stderr: live.proc.stderrTail(),
          message,
        });
      } else {
        await live.recorder.recordLifecycle('text', 'claude exited', { type: 'lifecycle', action: 'exited', ...base });
      }
    }
    await this.#store.sessions.update(live.sessionId, patch);
    if (patch.status) await this.#setMainAgentStatus(live.sessionId, patch.status);
    live.status = patch.status ?? live.status;
    if (this.#live.get(live.sessionId) === live) this.#live.delete(live.sessionId);
    await this.#emitSession(live.sessionId);
  }

  /** Re-derives the live status; call only from inside the live's queue. */
  async #refreshStatus(live: Live): Promise<void> {
    if (live.stopping || !live.proc.running) return;
    const status = deriveSessionStatus(live.recorder.statusInput());
    if (status === live.status) return;
    live.status = status;
    await this.#store.sessions.update(live.sessionId, { status });
    await this.#setMainAgentStatus(live.sessionId, status);
    await this.#emitSession(live.sessionId);
  }

  async #setMainAgentStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const main = (await this.#store.agents.listBySession(sessionId)).find((agent) => agent.kind === 'main');
    if (main && main.status !== status) await this.#store.agents.update(main.id, { status });
  }

  /** A lifecycle event for a session without a live process. */
  async #recordStandalone(sessionId: string, action: LifecycleAction, label: string): Promise<void> {
    const event = await this.#store.events.append({ sessionId, kind: 'text', label, payload: { type: 'lifecycle', action } });
    this.#emitEvent(event);
  }

  #emitEvent(record: EventRecord): void {
    const listeners = this.#listeners.event;
    if (listeners.size === 0) return;
    const payload = { sessionId: record.sessionId, event: toEvent(record) };
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  async #emitSession(sessionId: string): Promise<void> {
    const listeners = this.#listeners.sessionUpdated;
    if (listeners.size === 0) return;
    const record = await this.#store.sessions.get(sessionId);
    if (!record) return;
    const session = await toSession(this.#store, record);
    for (const listener of listeners) {
      try {
        listener(session);
      } catch (error) {
        this.#onError(error);
      }
    }
  }
}

const LIFECYCLE_LABELS: Record<LifecycleAction, string> = {
  started: 'Started',
  resumed: 'Resumed',
  attached: 'Attached',
  paused: 'Paused',
  detached: 'Continued in a terminal',
  exited: 'claude exited',
  failed: 'claude failed',
  stopped: 'Stopped with the service',
  recovered: 'Resumed after a Switchboard restart',
  'leftover-stopped': 'Stopped the claude process left from before the restart',
  'not-resumed': 'Not resumed after the restart',
};
