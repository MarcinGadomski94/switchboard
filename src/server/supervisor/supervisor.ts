import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { AttachWarningReason, NewSession, ResumeCommand, Session, SessionActivity, SessionEvent, SessionModelInput } from '../../core/api.ts';
import { mainAgentName } from '../../core/derive/agents.ts';
import { type StopReason, deriveSessionStatus } from '../../core/derive/status.ts';
import type { LifecycleAction, LifecyclePayload, ModelPayload, RequestPayload, ToolPayload, UserMessageOrigin } from '../../core/event-payload.ts';
import { DEFAULT_MODEL_VALUE, type ModelChoice, checkModelChoice, modelStepLabel, normalizeEffort, normalizeModel, parseInitializeModels } from '../../core/model-choice.ts';
import type { SessionStatus } from '../../core/model.ts';
import {
  type ControlRequestLine,
  type ToolDecision,
  controlErrorLine,
  controlSuccessLine,
  effortLine,
  interruptLine,
  setModelLine,
  setPermissionModeLine,
  userMessageLine,
} from '../../core/stdin.ts';
import { type CanUseToolMessage, type ControlResponseMessage, type InitMessage, type StreamMessage, parseStreamLine } from '../../core/stream-json.ts';
import type { EventRecord } from '../db/repos/events.ts';
import type { PendingMessageRecord } from '../db/repos/pending-messages.ts';
import type { SessionPatch, SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import type { FolderRef } from '../folders/ref.ts';
import { toEvent, toSession } from '../sessions/wire.ts';
import { type ClaudeStart, DEFAULT_PERMISSION_MODE, buildClaudeArgs, childEnv, resumeCommand } from './argv.ts';
import { attachWarningMessage, attachWarnings, claudeConfigDir, findTranscriptFile, importTerminalTurns } from './attach.ts';
import { ClaudeProcess, type ProcessExit } from './process.ts';
import type { LiveProcessLister } from './recovery.ts';
import { StreamRecorder } from './recorder.ts';
import { ACTIVITY_INTERVAL_MS, LatestThrottle } from './activity-throttle.ts';
import { LiveRemote, RemoteControlError } from './remote.ts';
import type { AnsweredOn } from '../../core/remote-control.ts';
import { closeNeedsConfirm } from '../../core/session-close.ts';
import { withSolutions } from '../../core/session-solutions.ts';

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
  /**
   * The CLI withdrew the request (`control_cancel_request`): never answer it. After
   * an interrupt (M0.2) `answeredOn` is `null`; D24: while Remote Control is on and
   * Switchboard is not stopping the process it is `claude.ai`: the phone answered first.
   */
  cancelled?(sessionId: string, requestId: string, answeredOn?: AnsweredOn | null): void | Promise<void>;
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

/**
 * Where a new session works (D14, `docs/folders.md`): its folder and the folder
 * its process runs in: the workspace root for a workspace folder; the repo, or
 * the repo's worktree when the session has one, for a repo folder.
 */
export interface SessionPlace {
  readonly folder: FolderRef;
  /** The process's working folder (canonicalized when the session is stored). */
  readonly cwd: string;
}

/**
 * What {@link SessionSupervisor.start} stores: a validated NewSession, or a session
 * the service starts itself (gap #4 reindex, schedules) without a work type, mode
 * or phase (the database allows them `null`, docs/database.md).
 */
export type SessionStartInput = Omit<NewSession, 'workType' | 'mode' | 'phase'> & {
  readonly workType: NewSession['workType'] | null;
  readonly mode: NewSession['mode'] | null;
  readonly phase: NewSession['phase'] | null;
};

/**
 * What {@link SessionSupervisor.adopt} stores for a terminal conversation moved
 * into Switchboard (D16): no session-start answers, no worktrees, no ultracode.
 */
export interface AdoptInput {
  /** Kebab-case and unique (the caller checked it). */
  readonly name: string;
  /** D22: the conversation's title (trimmed, at most 80 characters), `null` when it has none. */
  readonly title?: string | null;
  /** Stored as the session's task (its first prompt); never sent. */
  readonly task: string;
  /** The conversation's CLI session id: the session is bound to it, never to a new one. */
  readonly claudeSessionId: string;
  readonly solutions: readonly string[];
  /** The conversation's transcript, imported as the session's events before the spawn. */
  readonly transcript: string;
}

/**
 * What {@link SessionSupervisor.teleport} stores for a local copy of a remote
 * session (D25): no session-start answers, the repo's one solution, its worktree.
 */
export interface TeleportInput {
  /** Kebab-case and unique (the caller derived it, D22). */
  readonly name: string;
  /** D22: the typed title, else `Remote <short id>`. */
  readonly title: string | null;
  /** The remote session, `session_<X>` (`src/core/remote-session.ts`): passed as `--teleport` and stored as `remoteSource`. */
  readonly remoteSource: string;
  /** The repo folder's one solution. */
  readonly solutions: readonly string[];
  /** Optional first message, written right after the spawn (stored as the task); empty = none (idle). */
  readonly task: string;
}

/** Options of {@link SessionSupervisor.teleport}. */
export interface TeleportOptions {
  /** Runs after the session is stored, before its process is spawned (link its worktree). */
  readonly beforeSpawn?: (session: SessionRecord) => Promise<void>;
}

/** How long a `--teleport` process may take to report `system/init` before it is stopped (ms; see {@link SupervisorOptions.teleportInitTimeoutMs}). */
export const DEFAULT_TELEPORT_INIT_TIMEOUT_MS = 120_000;

/** Notifications for the `/hub` (M2.3), same names and payloads as the contract. */
export interface SupervisorEvents {
  readonly sessionUpdated: Session;
  readonly event: { readonly sessionId: string; readonly event: SessionEvent };
  /** D19: a session's live activity changed (at most one per `activityIntervalMs` per session; `null` = no turn runs). */
  readonly activity: { readonly sessionId: string; readonly activity: SessionActivity | null };
}

/** Options for {@link SessionSupervisor}. */
export interface SupervisorOptions {
  readonly store: Store;
  /** CLI argv prefix (`SWITCHBOARD_CLAUDE_BIN`). */
  readonly claudeCommand: readonly string[];
  /** Dev-only flags appended to every spawn (`SWITCHBOARD_CLAUDE_EXTRA_ARGS`). */
  readonly claudeExtraArgs?: readonly string[];
  /** Base environment of the children (default `process.env`); scrubbed by `childEnv`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly timeouts?: Partial<StopTimeouts>;
  readonly controlHandler?: ControlRequestHandler;
  /**
   * `claude agents --json` for the "Attach here" warning (M4.1: `claudeAgentsLister`
   * in recovery.ts), run in the session's cwd (D14). Without one, liveness is
   * unknown and every attach asks first.
   */
  readonly listLive?: LiveProcessLister;
  /** Called when processing a line or an exit throws (default: `console.error`). */
  readonly onError?: (error: unknown) => void;
  /** D19: the minimum gap between two `activity` notifications of one session (default {@link ACTIVITY_INTERVAL_MS}). */
  readonly activityIntervalMs?: number;
  /**
   * D25: how long a `--teleport` process may take to report `system/init` (the
   * git fetch + checkout and the history download happen before it) before it is
   * stopped and the teleport refused (default {@link DEFAULT_TELEPORT_INIT_TIMEOUT_MS}).
   */
  readonly teleportInitTimeoutMs?: number;
}

/** Options of {@link SessionSupervisor.close} (D33). */
export interface CloseOptions {
  /** The developer confirmed stopping a session whose process is live, or that runs or waits. */
  readonly confirm?: boolean;
  /**
   * Runs once the session is stored as closed, before `sessionUpdated` is
   * published (the route closes its open questions and permission requests there,
   * so the published session no longer counts them).
   */
  readonly beforePublish?: (sessionId: string) => Promise<void>;
}

/** Options of {@link SessionSupervisor.attach}. */
export interface AttachOptions {
  /** Attach even when a terminal may still hold the session (the developer confirmed the warning). */
  readonly confirm?: boolean;
}

/** Why the supervisor refused a call. `code` maps to an HTTP status in the routes. */
export type SupervisorErrorCode =
  | 'not-found'
  | 'folder-missing'
  | 'detached'
  | 'already-running'
  | 'request-not-open'
  | 'closing'
  | 'attach-warning'
  /** D24: Remote Control needs a live process. */
  | 'not-live'
  /** D24: the process's `initialize` did not report `remote_control_available: true`. */
  | 'remote-unavailable'
  /** D24: the `remote_control` request failed; the message is the CLI's text, verbatim. */
  | 'remote-failed'
  /** D25: the CLI refused the teleport; the message is its text, verbatim. */
  | 'teleport-failed'
  /** D25: the teleport never reported `system/init`. */
  | 'teleport-timeout'
  /** D31: a model or effort that is not on offer (the route's 422; {@link ModelChoiceError} names the field). */
  | 'invalid-model'
  /** D31: the CLI refused the `set_model` / `apply_flag_settings` request; the message is its text, verbatim. */
  | 'model-failed'
  /** D33: closing a session whose process is live, or that runs or waits, needs `confirm`. */
  | 'close-needs-confirm'
  /** D33: the session is closed; reopen it first (a message, Resume or Attach). */
  | 'closed';

/** A refusal of the supervisor. */
export class SupervisorError extends Error {
  override name = 'SupervisorError';
  readonly code: SupervisorErrorCode;
  constructor(code: SupervisorErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** D31: a model or effort choice refused before anything was sent or stored (`checkModelChoice`); `field` is `model` or `effort`. */
export class ModelChoiceError extends SupervisorError {
  override name = 'ModelChoiceError';
  readonly field: 'model' | 'effort';
  constructor(field: 'model' | 'effort', message: string) {
    super('invalid-model', message);
    this.field = field;
  }
}

/** D31: how long a `set_model` or `apply_flag_settings` reply may take (the CLI may check the model with its server first; the probe saw it at once). */
export const MODEL_CONTROL_TIMEOUT_MS = 30_000;

/** "Attach here" without `confirm` while a terminal may still hold the session (M4.1, gap #5): nothing was spawned. */
export class AttachWarningError extends SupervisorError {
  override name = 'AttachWarningError';
  readonly reasons: readonly AttachWarningReason[];
  constructor(reasons: readonly AttachWarningReason[]) {
    super('attach-warning', attachWarningMessage(reasons));
    this.reasons = reasons;
  }
}

/**
 * D25: a teleport the CLI refused or never finished (`docs/supervisor.md` →
 * *Teleport*). Nothing is left of the session: its process is stopped and its
 * row deleted. `message` is the CLI's own text when it printed one (verbatim).
 */
export class TeleportError extends SupervisorError {
  override name = 'TeleportError';
  constructor(code: 'teleport-failed' | 'teleport-timeout', message: string) {
    super(code, message);
  }
}

interface Waiter {
  readonly match: (message: StreamMessage) => boolean;
  readonly resolve: (matched: boolean) => void;
}

/** D25: what a `--teleport` process tracks until (and after) its first `system/init`. */
interface TeleportState {
  /** Resolves with the first `system/init` once it is handled, or `null` when the process ended first. */
  readonly init: Promise<InitMessage | null>;
  readonly resolveInit: (message: InitMessage | null) => void;
  initSeen: boolean;
  /** Why the init cannot be used (no session id, an id another session has); `null` = fine. */
  initError: string | null;
  /** Lines before `init` that were not JSON, and error results: the CLI's refusal when stderr has none. */
  readonly output: string[];
  /** The remote history still has to be imported from the local copy's transcript. */
  importPending: boolean;
}

/** One live `claude` process of a session. */
interface Live {
  readonly sessionId: string;
  readonly proc: ClaudeProcess;
  readonly recorder: StreamRecorder;
  /** D19: the session's `activity` notifications, at most one per interval. */
  readonly activity: LatestThrottle<SessionActivity | null>;
  readonly waiters: Set<Waiter>;
  /** Serializes line and exit handling. */
  queue: Promise<void>;
  /** Resolves once the exit has been handled. */
  finished: Promise<void>;
  stopping: StopReason | null;
  /** How a stop ended the process: `eof` or the last signal sent. */
  stoppedBy: string | null;
  status: SessionStatus;
  /** D24: Remote Control on this process (`initialize`, the bridge; remote.ts). */
  readonly remote: LiveRemote;
  /** D25: set on a `--teleport` process (its first spawn only). */
  readonly teleport: TeleportState | null;
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
  readonly #env: NodeJS.ProcessEnv;
  readonly #timeouts: StopTimeouts;
  readonly #handler: ControlRequestHandler;
  readonly #onError: (error: unknown) => void;
  readonly #listLive: LiveProcessLister | null;
  readonly #live = new Map<string, Live>();
  /** Attach calls run one at a time per session (the check and the spawn must not interleave). */
  readonly #attaching = new Map<string, Promise<unknown>>();
  /** D31: model / effort changes run one at a time per session (each compares against what the one before stored). */
  readonly #modelChanges = new Map<string, Promise<unknown>>();
  /** D38: solution fill-ins run one at a time per session (each reads what the one before stored). */
  readonly #solutionUpdates = new Map<string, Promise<unknown>>();
  readonly #listeners = {
    sessionUpdated: new Set<Listener<'sessionUpdated'>>(),
    event: new Set<Listener<'event'>>(),
    activity: new Set<Listener<'activity'>>(),
  };
  readonly #activityIntervalMs: number;
  readonly #teleportInitTimeoutMs: number;
  /** D25: sessions whose teleport has not reported `init` yet: stored, but not announced (they may be deleted again). */
  readonly #starting = new Set<string>();
  /** D33: closes in progress, by session (a second close waits for the first; messages are refused meanwhile). */
  readonly #closingSessions = new Map<string, Promise<SessionRecord>>();
  #closing = false;
  /** Session commands wait for this while restart recovery runs ({@link SessionSupervisor.holdCommands}). */
  #gate: Promise<void> = Promise.resolve();

  constructor(options: SupervisorOptions) {
    this.#store = options.store;
    this.#command = options.claudeCommand;
    this.#extraArgs = options.claudeExtraArgs ?? [];
    this.#env = options.env ?? process.env;
    this.#timeouts = { ...DEFAULT_STOP_TIMEOUTS, ...options.timeouts };
    this.#handler = options.controlHandler ?? {};
    this.#onError = options.onError ?? ((error) => console.error('switchboard supervisor:', error));
    this.#listLive = options.listLive ?? null;
    this.#activityIntervalMs = options.activityIntervalMs ?? ACTIVITY_INTERVAL_MS;
    this.#teleportInitTimeoutMs = options.teleportInitTimeoutMs ?? DEFAULT_TELEPORT_INIT_TIMEOUT_MS;
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

  /**
   * D25: `true` while the session's teleport has not reported `system/init` yet.
   * Such a session is stored but not announced: the lists leave it out until it
   * has started, since a refused teleport deletes it again.
   */
  isStarting(sessionId: string): boolean {
    return this.#starting.has(sessionId);
  }

  /** The live process's pid, or `null`. */
  pid(sessionId: string): number | null {
    return this.#live.get(sessionId)?.proc.pid ?? null;
  }

  /**
   * D19: what the session's running turn is doing now (`Session.activity`,
   * `docs/derivations.md` → *Live activity*); `null` without a live process or
   * while no turn runs. Always current (the `activity` notifications are throttled).
   */
  activity(sessionId: string): SessionActivity | null {
    return this.#live.get(sessionId)?.recorder.activity() ?? null;
  }

  // ── commands ───────────────────────────────────────────────────────────

  /**
   * Stores a new session and starts its process with a new `--session-id` in
   * `place.cwd` (D14: the session's folder, or its repo worktree); the session
   * remembers its folder (`folderId`, `root`, `rootKind`) for resume, restart
   * recovery, worktrees, diffs, artifacts and loops. The first stdin message is
   * `firstMessage` (default: the task text; `POST /api/sessions` passes the M5.2
   * first-turn payload, `sessions/first-turn.ts`); an empty one leaves the process idle.
   * The input must already be validated (sessions/validate.ts; D22: its `title`
   * is stored, `null` when absent; D38: with `worktrees` its `branch`, the branch
   * the session's worktrees are on, is stored too). `options.beforeSpawn`
   * runs once the session is stored and before its process starts (M2.2 links the
   * session's worktrees there).
   */
  async start(input: SessionStartInput, place: SessionPlace, firstMessage: string = input.task, options: StartOptions = {}): Promise<SessionRecord> {
    this.#assertOpen();
    const cwd = await canonicalFolder(place.cwd);
    const session = await this.#store.sessions.create({
      name: input.name,
      title: input.title ?? null,
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
      folderId: place.folder.id,
      root: place.folder.root,
      rootKind: place.folder.kind,
      requestedPermissionMode: DEFAULT_PERMISSION_MODE,
      branch: input.worktrees ? (input.branch ?? null) : null,
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
    this.#assertNotClosed(session);
    if (!session.attached) throw new SupervisorError('detached', 'the session continues in a terminal; attach it first');
    let live = this.#live.get(sessionId);
    if (live?.stopping) {
      await live.finished;
      live = undefined;
      // D33: the stop may have been a close.
      this.#assertNotClosed(await this.#get(sessionId));
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
    this.#assertNotClosed(session);
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

  // ── close and reopen (D33, docs/supervisor.md → Close and reopen) ────────

  /**
   * D33 Close (`POST /api/sessions/{id}/close`). A session whose process is live,
   * or whose status says it runs or waits (`run` / `need`), is closed only with
   * `options.confirm` (else `close-needs-confirm`); its process is then stopped
   * the way {@link pause} stops it (D7: interrupt, EOF, exit; open requests go
   * stale), so the conversation stays resumable, and a `run` / `need` status
   * without a process becomes `paused`. Then `closedAt` is stored, a `closed`
   * lifecycle event recorded, `options.beforePublish` runs (the route closes the
   * session's Inbox items there) and `sessionUpdated` is published. Worktrees and
   * branches are not touched. Idempotent: a closed session is returned as it is,
   * and a second call while a close runs waits for it. While a close runs and once
   * it is done, messages, Resume and Attach are refused (`closed`).
   * @throws {SupervisorError} `not-found`, `close-needs-confirm`, `closing`.
   */
  async close(sessionId: string, options: CloseOptions = {}): Promise<SessionRecord> {
    await this.#gate;
    this.#assertOpen();
    const running = this.#closingSessions.get(sessionId);
    if (running) return running;
    const session = await this.#get(sessionId);
    if (session.closedAt !== null) return session;
    const live = this.#live.get(sessionId);
    if (closeNeedsConfirm({ live: live !== undefined, status: session.status }) && options.confirm !== true) {
      const what = session.status === 'need' ? 'waiting for you' : session.status === 'run' ? 'running' : 'running a claude process';
      throw new SupervisorError(
        'close-needs-confirm',
        `${session.title ?? session.name} is ${what}: closing it stops its process (the conversation stays resumable). Confirm to stop and close it.`,
      );
    }
    const run = this.#closeNow(sessionId, options);
    this.#closingSessions.set(sessionId, run);
    try {
      return await run;
    } finally {
      this.#closingSessions.delete(sessionId);
    }
  }

  async #closeNow(sessionId: string, options: CloseOptions): Promise<SessionRecord> {
    const live = this.#live.get(sessionId);
    if (live) await this.#stop(live, 'pause');
    const stopped = await this.#get(sessionId);
    if (!this.#live.has(sessionId) && (stopped.status === 'run' || stopped.status === 'need')) {
      // A status left from a process that is gone: the session no longer runs or waits.
      await this.#store.sessions.update(sessionId, { status: 'paused' });
      await this.#setMainAgentStatus(sessionId, 'paused');
    }
    await this.#store.sessions.update(sessionId, { closedAt: new Date().toISOString() });
    await this.#recordStandalone(sessionId, 'closed', LIFECYCLE_LABELS.closed);
    if (options.beforePublish) {
      try {
        await options.beforePublish(sessionId);
      } catch (error) {
        this.#onError(error);
      }
    }
    await this.#emitSession(sessionId);
    return this.#get(sessionId);
  }

  /**
   * D33 Reopen (`POST /api/sessions/{id}/reopen`): clears `closedAt`, records a
   * `reopened` lifecycle event and publishes `sessionUpdated`. No process is
   * started: the session stays as it was closed (paused / idle / ended), and the
   * next message resumes it as usual. Idempotent (an open session is returned as
   * it is); a close still running is waited for first.
   * @throws {SupervisorError} `not-found`, `closing`.
   */
  async reopen(sessionId: string): Promise<SessionRecord> {
    await this.#gate;
    this.#assertOpen();
    await this.#get(sessionId);
    const running = this.#closingSessions.get(sessionId);
    if (running) await running.catch(() => undefined);
    const session = await this.#get(sessionId);
    if (session.closedAt === null) return session;
    await this.#store.sessions.update(sessionId, { closedAt: null });
    await this.#recordStandalone(sessionId, 'reopened', LIFECYCLE_LABELS.reopened);
    await this.#emitSession(sessionId);
    return this.#get(sessionId);
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
    this.#assertNotClosed(session);
    const command = { resumeCommand: resumeCommand(session.claudeSessionId) };
    if (this.#live.has(sessionId)) return command;
    const transcript = await findTranscriptFile(claudeConfigDir(this.#env), session.claudeSessionId);
    if (options.confirm !== true) {
      const lister = this.#listLive;
      const listLive = lister ? () => lister(session.cwd) : null;
      const reasons = await attachWarnings({ transcript, claudeSessionId: session.claudeSessionId, listLive, now: Date.now() });
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

  // ── terminal conversations moved in (D16, docs/supervisor.md → Continue in Switchboard) ─

  /**
   * The transcript of a CLI session id, `<configDir>/projects/*\/<id>.jsonl` with
   * the children's `CLAUDE_CONFIG_DIR` (else `~/.claude`); `null` when there is none.
   */
  findTranscript(claudeSessionId: string): Promise<string | null> {
    return findTranscriptFile(claudeConfigDir(this.#env), claudeSessionId);
  }

  /**
   * Why moving a terminal conversation now might split it (D16): the Attach-here
   * check (M4.1) for an id no session has yet: its transcript changed less than 2
   * minutes ago, `claude agents --json` (run in `cwd`) lists it, or that list
   * cannot be read. Empty = no terminal seems to hold it.
   */
  conversationWarnings(claudeSessionId: string, transcript: string | null, cwd: string): Promise<AttachWarningReason[]> {
    const lister = this.#listLive;
    return attachWarnings({ transcript, claudeSessionId, listLive: lister ? () => lister(cwd) : null, now: Date.now() });
  }

  /**
   * D16: stores a session bound to an existing conversation (`input.claudeSessionId`,
   * never a new id) in `place` (its saved folder; cwd = where the conversation
   * started), imports the transcript's turns as its events (the Attach-here import:
   * the whole chain, since the session has no sync point yet), then spawns
   * `--resume <id>` with the baseline flags and **no** message: the process stays
   * idle (lifecycle `moved`) until the developer writes. The caller has checked
   * that no session has the id and that no terminal holds it (or the developer
   * confirmed). No work type, mode or phase; no worktrees; no first message.
   */
  async adopt(input: AdoptInput, place: SessionPlace): Promise<SessionRecord> {
    await this.#gate;
    this.#assertOpen();
    const cwd = await canonicalFolder(place.cwd);
    const session = await this.#store.sessions.create({
      name: input.name,
      title: input.title ?? null,
      task: input.task,
      claudeSessionId: input.claudeSessionId,
      status: 'idle',
      workType: null,
      mode: null,
      phase: null,
      coordination: null,
      qaStack: null,
      qaConfluenceUrl: null,
      qaFigmaUrls: [],
      solutions: [...input.solutions],
      worktrees: false,
      ultracode: false,
      attached: true,
      cwd,
      folderId: place.folder.id,
      root: place.folder.root,
      rootKind: place.folder.kind,
      // D16: moved in from a terminal (its mode line reads "terminal · moved").
      origin: 'terminal',
      requestedPermissionMode: DEFAULT_PERMISSION_MODE,
    });
    await this.#store.agents.create({ sessionId: session.id, kind: 'main', name: mainAgentName(null, session.solutions), status: 'idle' });
    await this.#importTranscript(session, input.transcript);
    this.#assertOpen();
    const live = await this.#spawn(await this.#get(session.id), { kind: 'resume', claudeSessionId: session.claudeSessionId }, 'moved');
    await this.#enqueue(live, () => this.#refreshStatus(live));
    // The session is new to every client: announce it even when its status did not change.
    await this.#emitSession(session.id);
    return this.#get(session.id);
  }

  // ── remote sessions continued locally (D25, docs/supervisor.md → Teleport) ─

  /**
   * D25: stores a session that is a local copy of the remote session
   * `input.remoteSource` and spawns `claude -p --teleport <session_X>` with the
   * baseline flags (no `--session-id`) in `place.cwd` (the caller made it a new,
   * clean worktree of a repo folder). The CLI checks the tree and the repo, fetches
   * and checks out the remote session's branch there and loads its history. The
   * optional first message (`input.task`) goes out right after the spawn.
   *
   * The session is not announced (and the lists leave it out, {@link isStarting})
   * until the process reports `system/init`. That `init` gives the local copy's
   * session id, stored as the session's `claudeSessionId` (later spawns
   * `--resume` it); then the remote history is imported from the local copy's
   * transcript (origin `remote`; once no message is pending, else after the first
   * turn's `result`). Resolves with the stored session.
   *
   * @throws {TeleportError} `teleport-failed` when the process ends before `init`
   * (its stderr, else its non-JSON stdout, verbatim) or reports an unusable one;
   * `teleport-timeout` when no `init` came within the timeout (the process is
   * stopped). Either way the session row is deleted again; the caller removes the
   * worktree. Nothing is retried.
   */
  async teleport(input: TeleportInput, place: SessionPlace, options: TeleportOptions = {}): Promise<SessionRecord> {
    await this.#gate;
    this.#assertOpen();
    const cwd = await canonicalFolder(place.cwd);
    const session = await this.#store.sessions.create({
      name: input.name,
      title: input.title,
      task: input.task.trim(),
      // Provisional until `system/init` names the local copy (never passed to the CLI).
      claudeSessionId: `teleport-pending-${randomUUID()}`,
      status: 'idle',
      workType: null,
      mode: null,
      phase: null,
      coordination: null,
      qaStack: null,
      qaConfluenceUrl: null,
      qaFigmaUrls: [],
      solutions: [...input.solutions],
      worktrees: true,
      ultracode: false,
      attached: true,
      cwd,
      folderId: place.folder.id,
      root: place.folder.root,
      rootKind: place.folder.kind,
      remoteSource: input.remoteSource,
      requestedPermissionMode: DEFAULT_PERMISSION_MODE,
    });
    this.#starting.add(session.id);
    try {
      await this.#store.agents.create({ sessionId: session.id, kind: 'main', name: mainAgentName(null, session.solutions), status: 'idle' });
      if (options.beforeSpawn) await options.beforeSpawn(session);
      const live = await this.#spawn(session, { kind: 'teleport', remoteSession: input.remoteSource }, 'teleported', input.remoteSource);
      const state = live.teleport as TeleportState;
      if (input.task.trim() !== '') await this.#send(live, input.task.trim(), 'task');
      else await this.#enqueue(live, () => this.#refreshStatus(live));
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.#teleportInitTimeoutMs);
      });
      const outcome = await Promise.race([state.init, timeout]);
      clearTimeout(timer);
      if (outcome === 'timeout') {
        const seconds = Math.round(this.#teleportInitTimeoutMs / 1000);
        await this.#stop(live, 'pause');
        const said = teleportOutput(live.proc.stderrTail(), state.output);
        throw new TeleportError(
          'teleport-timeout',
          `claude did not report the local copy's session (no system/init) within ${seconds} s and was stopped. ` +
            'The CLI may report it only once it takes a message: try again with a first message.' +
            (said ? `\n${said}` : ''),
        );
      }
      if (outcome === null) {
        const exit = await live.proc.exited;
        await live.finished;
        throw new TeleportError('teleport-failed', teleportOutput(live.proc.stderrTail(), state.output) || exitText(exit));
      }
      if (state.initError !== null) {
        await this.#stop(live, 'pause');
        throw new TeleportError('teleport-failed', state.initError);
      }
      this.#starting.delete(session.id);
      // The session is new to every client: announce it now that it has started.
      await this.#emitSession(session.id);
      return this.#get(session.id);
    } catch (error) {
      const live = this.#live.get(session.id);
      if (live) await this.#stop(live, 'pause');
      await this.#store.sessions.delete(session.id);
      this.#starting.delete(session.id);
      throw error;
    }
  }

  /**
   * D25: the first `system/init` of a `--teleport` process (inside its line
   * queue): its `session_id` becomes the session's `claudeSessionId`, then the
   * remote history is imported when no message is pending.
   */
  async #teleportInit(live: Live, state: TeleportState, message: InitMessage): Promise<void> {
    state.initSeen = true;
    const id = message.sessionId;
    if (!id) {
      state.initError = 'claude reported system/init without a session_id, so the local copy cannot be resumed.';
      return;
    }
    const clash = await this.#store.sessions.getByClaudeSessionId(id);
    if (clash && clash.id !== live.sessionId) {
      state.initError = `claude reported the local copy's session id ${id}, which the session ${clash.title ?? clash.name} already has.`;
      return;
    }
    await this.#store.sessions.update(live.sessionId, { claudeSessionId: id });
    if (!live.recorder.turnBusy()) await this.#importRemoteHistory(live, state);
  }

  /**
   * D25: the remote history (the chain the teleport put in front of the local
   * copy's turns) from the local copy's transcript, as events (the Attach import
   * from the start of the chain, prompts with origin `remote`; entries already
   * stored are skipped). No transcript yet: it stays pending for the next turn's
   * end. A failure is recorded, never fatal.
   */
  async #importRemoteHistory(live: Live, state: TeleportState): Promise<void> {
    const session = await this.#get(live.sessionId);
    const transcript = await findTranscriptFile(claudeConfigDir(this.#env), session.claudeSessionId);
    if (!transcript) return;
    state.importPending = false;
    try {
      await importTerminalTurns({
        store: this.#store,
        session,
        mainAgentId: await this.#mainAgentId(session),
        transcript,
        onEvent: (event) => this.#emitEvent(event),
        origin: 'remote',
        fromStart: true,
      });
    } catch (error) {
      this.#onError(error);
      await this.recordServiceEvent(session.id, 'error', 'Could not read the remote history', {
        type: 'lifecycle',
        action: 'teleported',
        message: error instanceof Error ? error.message : String(error),
      });
    }
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

  /**
   * D38: adds the solutions the session does not name yet to `Session.solutions`
   * (in order, after the ones it has; `withSolutions`), stores them and publishes
   * `sessionUpdated`. Called when an agent writes into a solution (the recorder)
   * and when a worktree the agent created is adopted (`WorktreeAdoption`). With
   * `publish: 'always'` the session is published even when nothing was added (an
   * adopted worktree changes its Diff and Solutions chips). Runs one at a time per
   * session. `null` when there is no such session.
   */
  async addSolutions(sessionId: string, solutions: readonly string[], options: { readonly publish?: 'changed' | 'always' } = {}): Promise<SessionRecord | null> {
    const previous = this.#solutionUpdates.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.#addSolutionsNow(sessionId, solutions, options.publish ?? 'changed'));
    this.#solutionUpdates.set(sessionId, run);
    try {
      return await run;
    } finally {
      if (this.#solutionUpdates.get(sessionId) === run) this.#solutionUpdates.delete(sessionId);
    }
  }

  async #addSolutionsNow(sessionId: string, solutions: readonly string[], publish: 'changed' | 'always'): Promise<SessionRecord | null> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) return null;
    const next = withSolutions(session.solutions, solutions);
    const stored = next ? ((await this.#store.sessions.update(sessionId, { solutions: next })) ?? session) : session;
    if (next || publish === 'always') await this.#emitSession(sessionId);
    return stored;
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
    return live ? this.#controlOn(live, line, timeoutMs) : null;
  }

  /** {@link controlRequest} on one live process; the line is written synchronously (D24: `initialize` before any user message). */
  #controlOn(live: Live, line: ControlRequestLine, timeoutMs: number): Promise<ControlResponseMessage | null> {
    if (live.stopping || !live.proc.write(line)) return Promise.resolve(null);
    const box: { response?: ControlResponseMessage } = {};
    // Registered right after the write, before any stdout line can be processed.
    return this.#waitFor(
      live,
      (message) => {
        if (message.kind !== 'control-response' || message.requestId !== line.request_id) return false;
        box.response = message;
        return true;
      },
      timeoutMs,
    ).then((answered) => (answered ? (box.response ?? null) : null));
  }

  // ── Remote Control (D24, remote.ts, docs/remote-control.md) ────────────

  /**
   * Turns Remote Control on or off for the session's live process (`PUT
   * /api/sessions/{id}/remote`); the session as stored afterwards. Remote stays on
   * across pause/resume and restart recovery: each new process reattaches it.
   * @throws {SupervisorError} `not-found`; `not-live` without a live process (or
   * while it is being stopped); `remote-unavailable` when its `initialize` did not
   * report `remote_control_available: true`; `remote-failed` with the CLI's error
   * text, verbatim.
   */
  async setRemote(sessionId: string, enabled: boolean): Promise<SessionRecord> {
    await this.#gate;
    this.#assertOpen();
    await this.#get(sessionId);
    const live = this.#live.get(sessionId);
    if (!live || live.stopping || !live.proc.running) {
      throw new SupervisorError('not-live', 'Remote Control needs a running claude process: resume the session first');
    }
    try {
      await live.remote.set(enabled);
    } catch (error) {
      if (error instanceof RemoteControlError) throw new SupervisorError(error.code, error.message);
      throw error;
    }
    return this.#get(sessionId);
  }

  // ── model and effort (D31, docs/model-effort.md) ──────────────────────

  /**
   * Changes the session's model and / or effort (`PUT /api/sessions/{id}/model`);
   * the session as stored afterwards. A field left out of `input` keeps its stored
   * value; `null` (or `default` for the model) goes back to the CLI's default.
   * The choice is checked against the models the session's last process reported
   * (`checkModelChoice`), then, when the session has a live process that is not
   * being stopped, sent to it: `set_model` when the model changes,
   * `apply_flag_settings {effortLevel}` when the effort does (each reply awaited,
   * {@link MODEL_CONTROL_TIMEOUT_MS}); without one it is only stored. Either way
   * the stored choice is what every later spawn passes as `--model` / `--effort`,
   * a chat step line records it (`Model: Opus 5.5 · effort: high`, a `model`
   * event) and the session is published. A choice equal to the stored one does nothing.
   * @throws {ModelChoiceError} a model or effort not on offer (nothing sent or stored).
   * @throws {SupervisorError} `not-found`; `closing`; `model-failed` with the CLI's
   * text verbatim when it refused (or did not answer) a request: the stored choice
   * is unchanged, except that a model the CLI already took before it refused the
   * effort is stored (the process runs on it).
   */
  async setModel(sessionId: string, input: SessionModelInput): Promise<SessionRecord> {
    await this.#gate;
    this.#assertOpen();
    await this.#get(sessionId);
    const previous = this.#modelChanges.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.#setModelNow(sessionId, input));
    this.#modelChanges.set(sessionId, run);
    try {
      return await run;
    } finally {
      if (this.#modelChanges.get(sessionId) === run) this.#modelChanges.delete(sessionId);
    }
  }

  async #setModelNow(sessionId: string, input: SessionModelInput): Promise<SessionRecord> {
    this.#assertOpen();
    const session = await this.#get(sessionId);
    const available = session.modelOptions;
    const next: ModelChoice = {
      model: input.model !== undefined ? normalizeModel(input.model) : session.model,
      effort: input.effort !== undefined ? normalizeEffort(input.effort) : session.effort,
    };
    const problem = checkModelChoice(next, available);
    if (problem) throw new ModelChoiceError(problem.field, problem.message);
    const modelChanged = next.model !== session.model;
    const effortChanged = next.effort !== session.effort;
    if (!modelChanged && !effortChanged) return session;

    let live = this.#applying(sessionId);
    if (live && modelChanged) {
      const failure = await this.#modelRequest(live, setModelLine(`sb-model-${randomUUID()}`, next.model ?? DEFAULT_MODEL_VALUE), 'set_model');
      if (failure === 'gone') live = null;
      else if (failure !== null) {
        await this.#recordModel(sessionId, 'error', `Could not change the model: ${failure}`, { type: 'model', action: 'failed', ...next, request: 'set_model', error: failure });
        await this.#emitSession(sessionId);
        throw new SupervisorError('model-failed', failure);
      }
    }
    if (live && effortChanged) {
      const failure = await this.#modelRequest(live, effortLine(`sb-effort-${randomUUID()}`, next.effort), 'apply_flag_settings');
      if (failure === 'gone') live = null;
      else if (failure !== null) {
        if (modelChanged) {
          // The process took the model before it refused the effort: store what it runs on.
          const taken: ModelChoice = { model: next.model, effort: session.effort };
          await this.#store.sessions.update(sessionId, { model: taken.model });
          await this.#recordModel(sessionId, 'text', modelStepLabel(taken, available), { type: 'model', action: 'changed', ...taken, live: true });
        }
        await this.#recordModel(sessionId, 'error', `Could not change the effort: ${failure}`, {
          type: 'model',
          action: 'failed',
          ...next,
          request: 'apply_flag_settings',
          error: failure,
        });
        await this.#emitSession(sessionId);
        throw new SupervisorError('model-failed', failure);
      }
    }
    await this.#store.sessions.update(sessionId, { model: next.model, effort: next.effort });
    await this.#recordModel(sessionId, 'text', modelStepLabel(next, available), { type: 'model', action: 'changed', ...next, live: live !== null });
    await this.#emitSession(sessionId);
    return this.#get(sessionId);
  }

  /** D31: the session's live process when a control request can go to it now (not being stopped, stdin open); else `null`. */
  #applying(sessionId: string): Live | null {
    const live = this.#live.get(sessionId);
    return live && !live.stopping && live.proc.running && !live.proc.inputClosed ? live : null;
  }

  /**
   * D31: one `set_model` / `apply_flag_settings` request on a live process. `null`
   * = accepted; `gone` = the process ended (or is being stopped) before it answered,
   * so the change is only stored for the next spawn; else the CLI's error text,
   * verbatim, or why there was no answer.
   */
  async #modelRequest(live: Live, line: ControlRequestLine, subtype: 'set_model' | 'apply_flag_settings'): Promise<string | 'gone' | null> {
    const reply = await this.#controlOn(live, line, MODEL_CONTROL_TIMEOUT_MS);
    if (reply === null) {
      if (this.#applying(live.sessionId) !== live) return 'gone';
      return `claude did not answer the ${subtype} request within ${MODEL_CONTROL_TIMEOUT_MS / 1000} s`;
    }
    if (reply.subtype === 'success') return null;
    if (reply.subtype === 'error') return reply.error?.trim() ? reply.error : `claude answered the ${subtype} request with an error and no text`;
    return `claude answered the ${subtype} request with "${reply.subtype}" (expected success or error)`;
  }

  /** D31: a `model` event: through the live process's recorder (in its line order) when there is one, else stored directly. */
  async #recordModel(sessionId: string, kind: 'text' | 'error', label: string, payload: ModelPayload): Promise<void> {
    const live = this.#live.get(sessionId);
    if (live) {
      await this.#enqueue(live, async () => {
        await live.recorder.recordLifecycle(kind, label, payload);
      });
      return;
    }
    const event = await this.#store.events.append({ sessionId, kind, label, payload });
    this.#emitEvent(event);
  }

  // ── restart recovery (M2.4, recovery.ts) ──────────────────────────────

  /**
   * Holds `sendMessage`, `pause`, `resume`, `detach`, `attach` (and D33's `close` / `reopen`) until the returned
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

  /** D33: refuses work on a closed session (or one being closed): it has to be reopened first. */
  #assertNotClosed(session: SessionRecord): void {
    if (session.closedAt !== null || this.#closingSessions.has(session.id)) {
      throw new SupervisorError('closed', `the session ${session.title ?? session.name} is closed: reopen it from History first`);
    }
  }

  async #get(sessionId: string): Promise<SessionRecord> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) throw new SupervisorError('not-found', `no session ${sessionId}`);
    return session;
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

  async #spawn(session: SessionRecord, start: ClaudeStart, action: LifecycleAction, message?: string): Promise<Live> {
    // D14: a session always runs in its own stored cwd (its folder or its repo worktree), never a global root.
    const cwd = session.cwd;
    if (!cwd) throw new SupervisorError('folder-missing', `the session ${session.name} has no working folder`);
    const permissionMode = DEFAULT_PERMISSION_MODE;
    const prepared =
      (await this.#store.sessions.update(session.id, {
        cwd,
        requestedPermissionMode: permissionMode,
        stopReason: null,
        endedAt: null,
        // D24: unknown (not available) until this process's `initialize` answers.
        remoteAvailable: false,
      })) ?? session;
    const mainAgentId = await this.#mainAgentId(prepared);
    const holder: { live?: Live } = {};
    const activity = new LatestThrottle<SessionActivity | null>({
      intervalMs: this.#activityIntervalMs,
      send: (value) => this.#emitActivity(session.id, value),
    });
    const recorder = new StreamRecorder({
      store: this.#store,
      session: prepared,
      mainAgentId,
      onEvent: (event) => this.#emitEvent(event),
      onActivity: (value) => activity.push(value),
      // D6: `auto` is not available for this model; its control_response needs no waiter.
      onPermissionFallback: (mode) => void holder.live?.proc.write(setPermissionModeLine(`sb-mode-${randomUUID()}`, mode)),
      // D24: a withdrawn request was answered on claude.ai while Remote Control is on.
      answeredOn: () => holder.live?.remote.answeredOn() ?? null,
      // D25: a `--teleport` process may report `init` before it takes a message.
      startupInit: start.kind === 'teleport',
      // D38: a solution an agent writes into joins the session's solutions.
      onSolutionWritten: async (solution) => {
        await this.addSolutions(session.id, [solution]);
      },
    });
    let teleport: TeleportState | null = null;
    if (start.kind === 'teleport') {
      let resolveInit: (value: InitMessage | null) => void = () => undefined;
      const init = new Promise<InitMessage | null>((resolve) => {
        resolveInit = resolve;
      });
      teleport = { init, resolveInit, initSeen: false, initError: null, output: [], importPending: true };
    }
    // D22: the CLI's display name is the session's title (as it is now: a rename applies from the next spawn), else its name.
    // D31: the stored model and effort (neither is inherited on `--resume`); `null` = the CLI's default, no flag.
    const args = buildClaudeArgs({ start, name: prepared.title ?? prepared.name, permissionMode, model: prepared.model, effort: prepared.effort, extraArgs: this.#extraArgs });
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
      activity,
      waiters: new Set(),
      queue: Promise.resolve(),
      finished: Promise.resolve(),
      stopping: null,
      stoppedBy: null,
      status: prepared.status,
      remote: new LiveRemote({
        request: (line, timeoutMs) => (holder.live ? this.#controlOn(holder.live, line, timeoutMs) : Promise.resolve(null)),
        session: () => this.#store.sessions.get(session.id),
        update: async (patch) => {
          await this.#store.sessions.update(session.id, patch);
        },
        record: (kind, label, payload) => this.#enqueue(live, async () => {
          await recorder.recordLifecycle(kind, label, payload);
        }),
        publish: () => this.#emitSession(session.id),
        current: () => this.#live.get(session.id) === live && !live.stopping && live.proc.running,
        // D31: the models this process offers (kept on the session; a reply without a list keeps the last one).
        initialized: async (response) => {
          const options = parseInitializeModels(response);
          if (options !== null) await this.#store.sessions.update(session.id, { modelOptions: options });
        },
      }),
      teleport,
    };
    holder.live = live;
    this.#live.set(session.id, live);
    // D24: `initialize` goes out first (before any user message); its reply says whether Remote Control is available.
    live.remote.handshake().catch((error: unknown) => this.#onError(error));
    live.finished = proc.exited.then((exit) => this.#enqueue(live, () => this.#onExit(live, exit)));
    await this.#store.sessions.update(session.id, { pid: proc.pid });
    await this.#enqueue(live, async () => {
      await recorder.recordLifecycle('text', LIFECYCLE_LABELS[action], { type: 'lifecycle', action, pid: proc.pid, ...(message ? { message } : {}) });
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
    // D24: read before the recorder closes the request (the recorder asks the same question).
    const answeredOn = message.kind === 'control-cancel' ? live.remote.answeredOn() : null;
    if (message.kind === 'control-request') {
      live.proc.write(controlErrorLine(message.requestId, `Switchboard does not handle control request subtype "${message.subtype}"`));
    }
    const teleport = live.teleport;
    if (teleport && !teleport.initSeen) {
      // D25: what the CLI printed before `init` is its refusal when stderr has none.
      if (message.kind === 'invalid' && line.trim() !== '') teleport.output.push(line.trim());
      if (message.kind === 'result' && message.isError) teleport.output.push(...(message.errors.length > 0 ? message.errors : [message.text ?? message.subtype]));
      if (message.kind === 'init') await this.#teleportInit(live, teleport, message);
    }
    await live.recorder.handle(message);
    if (teleport && message.kind === 'init' && teleport.initSeen) teleport.resolveInit(message);
    if (teleport?.importPending && teleport.initSeen && teleport.initError === null && message.kind === 'result' && !message.taskNotification) {
      await this.#importRemoteHistory(live, teleport);
    }
    if (message.kind === 'can-use-tool' && this.#handler.canUseTool) {
      try {
        await this.#handler.canUseTool({ session: await this.#get(live.sessionId), request: message });
      } catch (error) {
        this.#onError(error);
      }
    }
    if (message.kind === 'control-cancel' && this.#handler.cancelled) {
      try {
        await this.#handler.cancelled(live.sessionId, message.requestId, answeredOn);
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
    // D25: a `--teleport` process that ended before `init` (a no-op once `init` resolved it).
    live.teleport?.resolveInit(null);
    const orphaned = await live.recorder.closeOpenRequests();
    if (orphaned.length > 0 && this.#handler.orphaned) {
      try {
        await this.#handler.orphaned(live.sessionId, orphaned);
      } catch (error) {
        this.#onError(error);
      }
    }
    await live.recorder.closeRunningAgents();
    // D19: no turn runs once the process is gone.
    live.recorder.endActivity();
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

  #emitActivity(sessionId: string, activity: SessionActivity | null): void {
    if (this.#starting.has(sessionId)) return;
    for (const listener of this.#listeners.activity) {
      try {
        listener({ sessionId, activity });
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  #emitEvent(record: EventRecord): void {
    const listeners = this.#listeners.event;
    if (listeners.size === 0 || this.#starting.has(record.sessionId)) return;
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
    if (listeners.size === 0 || this.#starting.has(sessionId)) return;
    const record = await this.#store.sessions.get(sessionId);
    if (!record) return;
    const session = await toSession(this.#store, record, this.activity(sessionId));
    for (const listener of listeners) {
      try {
        listener(session);
      } catch (error) {
        this.#onError(error);
      }
    }
  }
}

/** D25: what a `--teleport` process said before `init`: its stderr, else its non-JSON stdout lines and error results (verbatim, trimmed). */
function teleportOutput(stderr: string, output: readonly string[]): string {
  return stderr.trim() || output.join('\n').trim();
}

/** How a process ended, in words (when it printed nothing). */
function exitText(exit: ProcessExit): string {
  if (exit.spawnError) return `Could not start claude: ${exit.spawnError.message}`;
  return `claude exited (${exit.signal ? `signal ${exit.signal}` : `code ${String(exit.code)}`}) before it reported the local copy's session`;
}

/** `folder` resolved on disk. @throws {SupervisorError} `folder-missing` when it is not there. */
async function canonicalFolder(folder: string): Promise<string> {
  try {
    return await realpath(folder);
  } catch {
    throw new SupervisorError('folder-missing', `the session's folder does not exist: ${folder}`);
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
  moved: 'Moved from a terminal',
  teleported: 'Continued from a remote session',
  closed: 'Closed',
  reopened: 'Reopened',
};
