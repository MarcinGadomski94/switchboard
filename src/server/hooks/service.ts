import { randomUUID } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { HookStatus, HooksStatus, Session, SessionActivity, SessionEvent, TerminalSession } from '../../core/api.ts';
import { type HookCommand, DeliveryLimiter, HOOK_MESSAGE_MAX, type TerminalAgentRow, parseTerminalAgents, rewakeSupported, waiterText } from '../../core/hooks.ts';
import { textLabel, userMessageKind } from '../../core/derive/event-kind.ts';
import { type Attachment, attachmentsLabel, messageWithFiles } from '../../core/attachments.ts';
import type { UserPayload } from '../../core/event-payload.ts';
import { toolSummary } from '../../core/derive/activity.ts';
import { NO_TURN, type TranscriptTurn, hookedActivity, transcriptTurn } from '../../core/derive/hooked-activity.ts';
import { hookDelivery } from '../../core/derive/hooked-status.ts';
import { parseTranscript } from '../../core/transcript-sync.ts';
import { ANSWERED_IN_TERMINAL } from '../../core/remote-control.ts';
import type { SessionStatus } from '../../core/model.ts';
import type { ToolDecision } from '../../core/stdin.ts';
import type { ServerConfig } from '../config.ts';
import { AttachmentService, NO_ATTACHMENTS, type PreparedAttachments } from '../attachments/service.ts';
import type { EventRecord } from '../db/repos/events.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { runCommand, succeeded } from '../exec.ts';
import type { HubBus } from '../hub/bus.ts';
import type { QuestionPipeline } from '../inbox/pipeline.ts';
import { registerHookSource, toEvent, toSession } from '../sessions/wire.ts';
import { claudeConfigDir, findTranscriptFile, importTerminalTurns } from '../supervisor/attach.ts';
import { childEnv } from '../supervisor/argv.ts';
import { SupervisorError } from '../supervisor/supervisor.ts';
import { LatestThrottle } from '../supervisor/activity-throttle.ts';
import type { LoopEventInput } from '../../core/derive/loops.ts';
import { TranscriptLoopEvents } from '../loops/terminal.ts';
import { HookInstallError, hooksState, installHooks, readHookSettings, removeHooks } from './installer.ts';
import { type StopHow, type StopProcessOptions, processAlive, stopProcess } from './terminal-stop.ts';
import { type TerminalLiveness, judgeTerminal } from '../../core/hooked-continue.ts';

/**
 * D48 P4 "hook into hand-started terminal sessions" (`docs/peers.md` → *Hooked
 * terminal sessions*; the design of `docs/spike-remote-pc.md`). Every Switchboard
 * does this for its own machine; a paired machine reaches it through the peer
 * API like any other route.
 *
 * - **Registry:** `claude agents --json` (what runs) plus what Switchboard's hooks
 *   report (`POST /hook/v1/event`: transcript path, running / idle, ended).
 *   Sessions Switchboard itself runs (`entrypoint: sdk-cli`, or a supervised
 *   session's id) are never listed and their hook calls are answered at once.
 * - **Hooking** makes a Switchboard session (`hooked`, origin `terminal`, no
 *   process) whose chat is imported from the transcript (`importTerminalTurns`,
 *   again after every hook event and whenever the file grows).
 * - **Permissions:** the PermissionRequest hook's call is held open; the request
 *   becomes an Inbox item or, for AskUserQuestion, a question batch (the question
 *   pipeline); the developer's answer goes back as the hook's output. The
 *   terminal's own dialog is open meanwhile: answered there first (the tool's
 *   PostToolUse, or the turn ending), the item closes and the hook call gets no
 *   decision.
 * - **Messages:** a mailbox per session (`pending_messages`, kind `hook-message`),
 *   released to a live waiter (the `asyncRewake` hook of SessionStart / Stop) as
 *   soon as possible, also while a turn runs (ruling D48-midturn-policy: the CLI
 *   folds it in at the next tool boundary); every pending message is claimed exactly once
 *   (marked delivered before the waiter is answered), one wake-up per turn, and at
 *   most `DELIVERY_MAX` wake-ups a minute. One waiter per session: a newer one
 *   supersedes the older (answered with no message); a waiter ends with its
 *   session (SessionEnd, the process exiting) and is otherwise kept as long as the
 *   session lives (developer ruling: unlimited life).
 */

/** `pending_messages.kind` of a message to a hooked session. */
export const HOOK_MESSAGE_KIND = 'hook-message';

/** How often a hooked session's transcript is checked for growth. */
export const SYNC_POLL_MS = 1_500;

/** D53: how often a hooked session's transcript is checked while its turn runs (ASSUMED D53-poll: 500 ms; one `stat` per file). */
export const ACTIVE_POLL_MS = 500;

/** D53: how much of a transcript's end is read for the live activity (a turn longer than this starts at the tail's first line). */
export const ACTIVITY_TAIL_BYTES = 256 * 1024;

/** D53: a hooked session's `/hub` `activity` events go out at most this often (the newest value always goes out). */
export const ACTIVITY_EVENT_MS = 1_000;

/** How often `claude agents --json` is asked while anything is hooked or waiting. */
export const LIVENESS_POLL_MS = 10_000;

/** A wake-up whose turn never started (no UserPromptSubmit) stops blocking the next one after this long. */
export const WOKEN_TURN_TIMEOUT_MS = 120_000;

/** A listing of `claude agents --json` is reused this long. */
const AGENTS_CACHE_MS = 3_000;

/** A hook's answer: HTTP status and JSON body. */
export interface HookAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** Registers what to do when the hook's HTTP call goes away before it was answered. */
export type OnAbort = (abort: () => void) => void;

/** What the hooks told about one terminal session. */
interface Terminal {
  claudeSessionId: string;
  pid: number | null;
  cwd: string | null;
  transcriptPath: string | null;
  entrypoint: string | null;
  lastHookAt: number | null;
  running: boolean;
  ended: boolean;
  /** D53: the newest UserPromptSubmit / Stop seen (epoch ms). */
  startedAt: number | null;
  stoppedAt: number | null;
}

interface OpenRequest {
  readonly requestId: string;
  readonly claudeSessionId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly suggestions: readonly unknown[];
  readonly batch: boolean;
  /** D53: when the hook call came (epoch ms): the `waiting` activity's start. */
  readonly openedAt: number;
  done: boolean;
  readonly finish: (answer: HookAnswer) => void;
}

interface Waiter {
  readonly claudeSessionId: string;
  done: boolean;
  readonly finish: (answer: HookAnswer) => void;
}

/** Options of {@link HookService}. */
export interface HookServiceOptions {
  readonly config: ServerConfig;
  readonly store: Store;
  readonly bus: HubBus;
  readonly questions: QuestionPipeline;
  /** The hook token (`<dataDir>/hook-token`); the hook entries name its file. */
  readonly hookTokenFile: string;
  /** The CLI's config dir comes from here (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
  readonly env?: NodeJS.ProcessEnv;
  /** `claude agents --json` (tests pass their own). */
  readonly listAgents?: () => Promise<TerminalAgentRow[] | null>;
  /** `claude --version` output (tests pass their own). */
  readonly cliVersion?: () => Promise<string | null>;
  /** The delivery limit (tests shorten it). */
  readonly limit?: { readonly max: number; readonly windowMs: number };
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
  /** D65: how a hooked terminal's `claude` is stopped (tests shorten the grace time / replace the signal). */
  readonly stop?: StopProcessOptions;
}

/** A refusal of a hooks action, sent as `{ error, message }`. */
export class HookError extends Error {
  override name = 'HookError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A kebab-case short name from a terminal's name or folder. */
function kebab(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'terminal'
  );
}

/** The D48 P4 service of this machine. */
export class HookService {
  readonly #config: ServerConfig;
  readonly #store: Store;
  readonly #bus: HubBus;
  readonly #questions: QuestionPipeline;
  readonly #tokenFile: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #listAgentsOption: (() => Promise<TerminalAgentRow[] | null>) | undefined;
  readonly #cliVersionOption: (() => Promise<string | null>) | undefined;
  readonly #limit: { readonly max: number; readonly windowMs: number } | undefined;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #stopOptions: StopProcessOptions;
  readonly #terminals = new Map<string, Terminal>();
  readonly #requests = new Map<string, OpenRequest>();
  readonly #waiters = new Map<string, Waiter>();
  /** Sessions that had a waiter since Switchboard started (a missing waiter is then "stopped", not "never armed"). */
  readonly #waiterSeen = new Set<string>();
  readonly #limiters = new Map<string, DeliveryLimiter>();
  /**
   * Sessions woken and not yet back at a turn end (one wake-up per turn): when it
   * was woken and whether the turn it started was seen (UserPromptSubmit). Cleared
   * by the Stop after that turn, or after {@link WOKEN_TURN_TIMEOUT_MS} without one.
   */
  readonly #awaitingTurn = new Map<string, { readonly at: number; started: boolean }>();
  /** Claude session ids Switchboard itself runs (their hooks are answered at once). */
  readonly #supervised = new Set<string>();
  readonly #pumps = new Map<string, Promise<void>>();
  readonly #pumpTimers = new Map<string, NodeJS.Timeout>();
  readonly #syncs = new Map<string, { running: Promise<void> | null; again: boolean }>();
  readonly #sizes = new Map<string, string>();
  #agents: { at: number; rows: TerminalAgentRow[] | null } | null = null;
  #cli: { at: number; version: string | null } | null = null;
  #lastBackup: string | null = null;
  #syncTimer: NodeJS.Timeout | undefined;
  #livenessTimer: NodeJS.Timeout | undefined;
  #closed = false;
  readonly #loopFiles = new TranscriptLoopEvents();
  readonly #eventListeners = new Set<(payload: { readonly sessionId: string; readonly event: SessionEvent }) => void>();
  /** D53: each hooked session's live activity as last published (and its JSON, to publish only changes). */
  readonly #activity = new Map<string, { readonly value: SessionActivity | null; readonly json: string }>();
  /** D53: each transcript's turn, read again only when its size or mtime changed. */
  readonly #turns = new Map<string, { readonly key: string; readonly turn: TranscriptTurn; readonly mtimeMs: number }>();
  /** D53: each hooked session's delivery state as last published (a change publishes the session). */
  readonly #statusJson = new Map<string, string>();
  /** D53: the `/hub` `activity` events per session, at most one a second (the contract's limit, as for a supervised session). */
  readonly #activityEvents = new Map<string, LatestThrottle<SessionActivity | null>>();
  #activeTimer: NodeJS.Timeout | undefined;

  /** D57: a hooked session's imported prompt images are stored as its attachments (in this machine's data folder). */
  readonly #saveImage: { readonly saveImage: (sessionId: string, base64: string, index: number) => Promise<Attachment | null> };

  constructor(options: HookServiceOptions) {
    this.#config = options.config;
    this.#store = options.store;
    const attachments = new AttachmentService({ dataDir: options.config.dataDir, store: options.store });
    this.#saveImage = { saveImage: (sessionId, base64, index) => attachments.saveTranscriptImage(sessionId, base64, index) };
    this.#bus = options.bus;
    this.#questions = options.questions;
    this.#tokenFile = options.hookTokenFile;
    this.#env = options.env ?? process.env;
    this.#listAgentsOption = options.listAgents;
    this.#cliVersionOption = options.cliVersion;
    this.#limit = options.limit;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((error) => console.error('switchboard hooks:', error));
    this.#stopOptions = options.stop ?? {};
    // D53: `toSession` adds a hooked session's activity and delivery state from here.
    registerHookSource(this.#store, { activity: (sessionId) => this.activity(sessionId), status: (record) => this.hookStatus(record) });
  }

  /** The CLI's config dir (its `settings.json`, `projects/`, `sessions/`). */
  get configDir(): string {
    return claudeConfigDir(this.#env);
  }

  /** Starts the transcript and liveness polls (once the UI port is ours). */
  start(): void {
    if (this.#closed || this.#syncTimer) return;
    this.#syncTimer = setInterval(() => void this.#pollTranscripts(), SYNC_POLL_MS);
    this.#syncTimer.unref();
    this.#livenessTimer = setInterval(() => void this.#pollLiveness(), LIVENESS_POLL_MS);
    this.#livenessTimer.unref();
    // D53: a running turn's transcript is looked at more often, so its live line follows the tools closely.
    this.#activeTimer = setInterval(() => void this.#pollTranscripts(true), ACTIVE_POLL_MS);
    this.#activeTimer.unref();
  }

  /** Stops the polls and answers every held hook call with no decision / no message. */
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#syncTimer);
    clearInterval(this.#livenessTimer);
    clearInterval(this.#activeTimer);
    for (const throttle of this.#activityEvents.values()) throttle.cancel();
    for (const timer of this.#pumpTimers.values()) clearTimeout(timer);
    for (const request of [...this.#requests.values()]) this.#finishRequest(request, { status: 204, body: null });
    // Not a stop: Switchboard is going away (a restart / update), the hook script keeps trying until it is back.
    for (const waiter of [...this.#waiters.values()]) this.#finishWaiter(waiter, { status: 503, body: null });
    await Promise.all([...this.#pumps.values()].map((pump) => pump.catch(() => undefined)));
    await Promise.all([...this.#syncs.values()].map((slot) => slot.running?.catch(() => undefined)));
  }

  // ── install / status ─────────────────────────────────────────────────

  /** The hook command of this machine (this node, this checkout's script, this port, this token file). */
  async hookCommand(): Promise<HookCommand> {
    return {
      nodePath: process.execPath,
      scriptPath: path.resolve(import.meta.dirname, '..', '..', 'hook', 'sb-hook.ts'),
      port: this.#config.port,
      tokenFile: this.#tokenFile,
      platform: process.platform,
      rewake: rewakeSupported(await this.cliVersion()),
    };
  }

  /** `claude --version` (cached a minute), `null` when it cannot be read. */
  async cliVersion(): Promise<string | null> {
    if (this.#cli && this.#now() - this.#cli.at < 60_000) return this.#cli.version;
    let version: string | null = null;
    if (this.#cliVersionOption) version = await this.#cliVersionOption();
    else {
      const result = await runCommand(this.#config.claudeCommand, ['--version'], { cwd: this.#config.dataDir, env: childEnv(this.#env), timeoutMs: 20_000 });
      version = succeeded(result) ? result.stdout.trim() || null : null;
    }
    this.#cli = { at: this.#now(), version };
    return version;
  }

  /** `GET /api/hooks`. */
  async status(): Promise<HooksStatus> {
    const command = await this.hookCommand();
    const state = await hooksState(this.configDir, command);
    return {
      state: state.state,
      settingsPath: state.path,
      cliVersion: await this.cliVersion(),
      rewake: command.rewake ? 'internal' : 'fallback',
      lastBackup: this.#lastBackup,
      error: state.error,
    };
  }

  /** "Install hooks": Switchboard's entries in the user's settings (backup first; idempotent). */
  async install(): Promise<HooksStatus> {
    try {
      const change = await installHooks(this.configDir, await this.hookCommand());
      if (change.backup) this.#lastBackup = change.backup;
    } catch (error) {
      if (error instanceof HookInstallError) throw new HookError(409, 'settings-unreadable', error.message);
      throw error;
    }
    return this.status();
  }

  /** "Remove hooks": Switchboard's entries out of the user's settings (backup first; nothing else changes). */
  async remove(): Promise<HooksStatus> {
    try {
      const change = await removeHooks(this.configDir);
      if (change.backup) this.#lastBackup = change.backup;
    } catch (error) {
      if (error instanceof HookInstallError) throw new HookError(409, 'settings-unreadable', error.message);
      throw error;
    }
    return this.status();
  }

  // ── terminal sessions ────────────────────────────────────────────────

  async #listAgents(fresh = false): Promise<TerminalAgentRow[] | null> {
    if (!fresh && this.#agents && this.#now() - this.#agents.at < AGENTS_CACHE_MS) return this.#agents.rows;
    let rows: TerminalAgentRow[] | null = null;
    if (this.#listAgentsOption) rows = await this.#listAgentsOption();
    else {
      const result = await runCommand(this.#config.claudeCommand, ['agents', '--json'], { cwd: this.#config.dataDir, env: childEnv(this.#env), timeoutMs: 30_000 });
      rows = succeeded(result) ? parseTerminalAgents(result.stdout) : null;
    }
    this.#agents = { at: this.#now(), rows };
    return rows;
  }

  /** The CLI's own registry entry `<config>/sessions/<pid>.json` → its `entrypoint` (never any other file there: the `.key` files are secrets). */
  async #entrypointOf(pid: number): Promise<string | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(this.configDir, 'sessions', `${pid}.json`), 'utf8'));
      return isRecord(parsed) && typeof parsed['entrypoint'] === 'string' ? parsed['entrypoint'] : null;
    } catch {
      return null;
    }
  }

  /**
   * `GET /api/terminal-sessions`: the interactive terminal sessions on this machine
   * (Switchboard's own left out). D52: `fresh: false` may reuse a listing of the
   * last few seconds (the terminal loops' poll).
   */
  async listTerminals(options: { readonly fresh?: boolean } = {}): Promise<TerminalSession[]> {
    const rows = await this.#listAgents(options.fresh ?? true);
    if (rows === null) throw new HookError(502, 'agents-unavailable', '`claude agents --json` could not be read on this machine');
    const out: TerminalSession[] = [];
    for (const row of rows) {
      if (row.kind !== null && row.kind !== 'interactive') continue;
      const entrypoint = await this.#entrypointOf(row.pid);
      if (entrypoint === 'sdk-cli' || this.#supervised.has(row.sessionId)) continue;
      const record = await this.#store.sessions.getByClaudeSessionId(row.sessionId);
      if (record && !record.hooked) continue;
      const hooked = record !== null && record.hooked && record.closedAt === null;
      const terminal = this.#terminals.get(row.sessionId);
      out.push({
        id: row.sessionId,
        pid: row.pid,
        cwd: row.cwd,
        name: row.name,
        status: row.status,
        waitingFor: row.waitingFor,
        startedAt: row.startedAt === null ? null : new Date(row.startedAt).toISOString(),
        hooked,
        sessionId: hooked && record ? record.id : null,
        hookSeen: terminal?.lastHookAt != null,
        waiter: this.#waiters.has(row.sessionId),
      });
    }
    return out;
  }

  /** `POST /api/terminal-sessions/{id}/hook`: follow that terminal session (`created`: a new Switchboard session). */
  async hook(claudeSessionId: string): Promise<{ readonly session: Session; readonly created: boolean }> {
    const row = (await this.listTerminals()).find((entry) => entry.id === claudeSessionId);
    if (!row) throw new HookError(404, 'not-found', `no terminal session ${claudeSessionId} is running on this machine`);
    const existing = await this.#store.sessions.getByClaudeSessionId(claudeSessionId);
    if (existing && !existing.hooked) throw new HookError(409, 'already-in-switchboard', 'this conversation is already a Switchboard session');
    let record: SessionRecord;
    let created = false;
    if (existing) {
      record = (await this.#store.sessions.update(existing.id, { closedAt: null })) ?? existing;
    } else {
      const base = `term-${kebab(row.name ?? path.basename(row.cwd ?? '') ?? 'terminal')}`;
      let name = base;
      for (let n = 2; await this.#store.sessions.getByName(name); n++) name = `${base}-${n}`;
      const terminal = this.#terminals.get(claudeSessionId);
      record = await this.#store.sessions.create({
        name,
        title: row.name ?? `Terminal · ${path.basename(row.cwd ?? '') || 'session'}`,
        task: '',
        claudeSessionId,
        status: row.status === 'busy' ? 'run' : row.status === 'waiting' ? 'need' : 'idle',
        attached: false,
        cwd: row.cwd,
        root: row.cwd,
        origin: 'terminal',
        hooked: true,
        transcriptPath: terminal?.transcriptPath ?? null,
      });
      await this.#store.agents.create({ sessionId: record.id, kind: 'main', name: 'main', status: record.status });
      created = true;
    }
    await this.#syncNow(record.id, true);
    await this.#publishSession(record.id);
    void this.#pump(claudeSessionId);
    const fresh = (await this.#store.sessions.get(record.id)) ?? record;
    return { session: await toSession(this.#store, fresh), created };
  }

  /**
   * D65: the pid of a hooked session's terminal `claude`, **verified**: the live
   * registry (`claude agents --json`, asked fresh) must list that pid with this
   * session's id (a pid the hooks reported earlier may have been reused since).
   * `null` when the session is not hooked, the terminal is gone, or the registry
   * cannot be read.
   */
  async terminalPid(sessionId: string): Promise<number | null> {
    const record = await this.#store.sessions.get(sessionId);
    if (!record || !record.hooked) return null;
    const rows = await this.#listAgents(true);
    const row = rows?.find((entry) => entry.sessionId === record.claudeSessionId);
    return row ? row.pid : null;
  }

  /**
   * D65: stops a hooked session's terminal `claude` (`terminal-stop.ts`: SIGTERM /
   * `taskkill`, the force after a grace time). Only the verified process
   * ({@link terminalPid}) is touched; a terminal that is already gone is `gone`.
   * Its waiter and held hook calls end as the session's process exits (the
   * liveness poll marks the session `done`).
   * @throws {HookError} `not-hooked` (404), `agents-unavailable` (502: the registry cannot confirm the process), `stop-failed` (502).
   */
  async stopTerminal(sessionId: string): Promise<{ readonly pid: number | null; readonly how: StopHow }> {
    const record = await this.#store.sessions.get(sessionId);
    if (!record || !record.hooked) throw new HookError(404, 'not-hooked', `no hooked terminal session ${sessionId}`);
    const rows = await this.#listAgents(true);
    if (rows === null) throw new HookError(502, 'agents-unavailable', "the terminal's process could not be confirmed: `claude agents --json` could not be read, so nothing was stopped");
    const row = rows.find((entry) => entry.sessionId === record.claudeSessionId);
    if (!row) return { pid: null, how: 'gone' };
    try {
      return { pid: row.pid, how: await stopProcess(row.pid, this.#stopOptions) };
    } catch (error) {
      throw new HookError(502, 'stop-failed', `could not stop the terminal's claude (pid ${row.pid}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * D72: whether a hooked session's terminal `claude` still runs ({@link judgeTerminal}):
   * the live registry asked fresh, the hooks' SessionEnd, the pid the hook reported
   * (is it alive?) and the last hook call. `null` when the session is not hooked.
   */
  async terminalLiveness(sessionId: string): Promise<TerminalLiveness | null> {
    const record = await this.#store.sessions.get(sessionId);
    if (!record || !record.hooked) return null;
    const terminal = this.#terminals.get(record.claudeSessionId);
    const pid = terminal?.pid ?? null;
    const alive = this.#stopOptions.alive ?? processAlive;
    return judgeTerminal({
      registry: await this.#listAgents(true),
      claudeSessionId: record.claudeSessionId,
      ended: terminal?.ended === true,
      hookPid: pid,
      hookPidAlive: pid === null || !Number.isInteger(pid) || pid <= 1 ? null : alive(pid),
      lastHookAt: terminal?.lastHookAt ?? null,
      now: this.#now(),
    });
  }

  /** D72: imports what the hooked session's transcript (and its subagents' files) still has (the last sync before it is continued). */
  async syncNow(sessionId: string): Promise<void> {
    await this.#syncNow(sessionId, false);
  }

  /**
   * D72: the hooked session `sessionId` was continued in Switchboard (it is no longer
   * hooked): its waiter ends (the explicit stop, 204), its held permission calls get
   * no decision (their Inbox items go stale), and what this service kept about its
   * terminal is dropped; its live line ends. Later hook calls for its conversation
   * (Switchboard's own process now) are answered at once.
   */
  async released(sessionId: string, claudeSessionId: string): Promise<void> {
    this.#supervised.add(claudeSessionId);
    const waiter = this.#waiters.get(claudeSessionId);
    if (waiter) this.#finishWaiter(waiter, { status: 204, body: null });
    for (const request of [...this.#requests.values()]) {
      if (request.sessionId === sessionId && !request.done) this.#withdraw(request, false);
    }
    this.#terminals.delete(claudeSessionId);
    this.#awaitingTurn.delete(claudeSessionId);
    this.#limiters.delete(claudeSessionId);
    this.#waiterSeen.delete(claudeSessionId);
    const timer = this.#pumpTimers.get(claudeSessionId);
    if (timer) clearTimeout(timer);
    this.#pumpTimers.delete(claudeSessionId);
    this.#statusJson.delete(sessionId);
    this.#sizes.delete(sessionId);
    if (this.#activity.get(sessionId)?.value) this.#activityEvents.get(sessionId)?.push(null);
    this.#activity.delete(sessionId);
  }

  /** `true` when `sessionId` is an open hooked session. */
  /** D75: `true` while a hooked session's waiter is held (a message sent now reaches the agent at its next idle). */
  async hasWaiter(sessionId: string): Promise<boolean> {
    const record = await this.#store.sessions.get(sessionId);
    return record !== null && record.hooked && record.closedAt === null && this.#waiters.has(record.claudeSessionId);
  }

  async isHooked(sessionId: string): Promise<boolean> {
    const record = await this.#store.sessions.get(sessionId);
    return record !== null && record.hooked;
  }

  async #hookedRecord(claudeSessionId: string): Promise<SessionRecord | null> {
    const record = await this.#store.sessions.getByClaudeSessionId(claudeSessionId);
    return record && record.hooked && record.closedAt === null ? record : null;
  }

  /** The session was closed (unhooked): its held permission calls get no decision. Its queued messages stay for a later re-hook. */
  async unhooked(sessionId: string): Promise<void> {
    // Its waiter is no longer needed (the explicit stop: 204); a later re-hook is armed by the session's next turn.
    const record = await this.#store.sessions.get(sessionId);
    const waiter = record ? this.#waiters.get(record.claudeSessionId) : undefined;
    if (waiter) this.#finishWaiter(waiter, { status: 204, body: null });
    for (const request of [...this.#requests.values()]) {
      if (request.sessionId === sessionId) this.#finishRequest(request, { status: 204, body: null });
    }
    await this.#refreshActivity(sessionId);
  }

  // ── D53 live activity and delivery state ─────────────────────────────

  /**
   * D53: a hooked session's live activity as last derived (`Session.activity`,
   * the `/hub` `activity` event): its transcript's open turn and its hook calls
   * (`hookedActivity`); `null` while no turn runs, and for any other session.
   */
  activity(sessionId: string): SessionActivity | null {
    return this.#activity.get(sessionId)?.value ?? null;
  }

  /** D53: `Session.hookStatus` of a hooked session (`null` for a closed one, and for any other session). */
  async hookStatus(record: SessionRecord): Promise<HookStatus | null> {
    if (!record.hooked || record.closedAt !== null) return null;
    const cs = record.claudeSessionId;
    const terminal = this.#terminals.get(cs);
    const woken = this.#awaitingTurn.get(cs);
    const queued = (await this.#store.pendingMessages.pending(record.id)).filter((message) => message.kind === HOOK_MESSAGE_KIND).length;
    const activity = this.activity(record.id);
    const outdated = (await hooksState(this.configDir, await this.hookCommand())).state === 'outdated';
    const status: HookStatus = {
      waiter: this.#waiters.has(cs),
      hookSeen: terminal?.lastHookAt != null,
      delivery: hookDelivery({
        ended: terminal?.ended === true || record.status === 'done',
        waiter: this.#waiters.has(cs),
        // A waiter was held (or its hooks reported) since Switchboard started: none now means it stopped.
        waiterSeen: this.#waiterSeen.has(cs) || terminal?.lastHookAt != null,
        // The live line, not `terminal.running` (a released wake-up marks it running before the CLI takes it up).
        running: activity !== null,
        released: woken !== undefined && !woken.started,
        queued,
      }),
      ...(outdated ? { hooksOutdated: true } : {}),
    };
    this.#statusJson.set(record.id, JSON.stringify(status));
    return status;
  }

  /** D53: the delivery state of the session changed? Its `sessionUpdated` (the header note, the clock's words). */
  async #refreshStatus(record: SessionRecord): Promise<void> {
    const before = this.#statusJson.get(record.id);
    const after = JSON.stringify(await this.hookStatus(record));
    if (before !== after) await this.#publishSession(record.id);
  }

  #refreshStatusOf(claudeSessionId: string): Promise<void> {
    return (async () => {
      if (this.#closed) return;
      const record = await this.#hookedRecord(claudeSessionId);
      if (record) await this.#refreshStatus(record);
    })().catch((error: unknown) => this.#onError(error));
  }

  /** D53: a transcript's current turn (read again, its last {@link ACTIVITY_TAIL_BYTES}, only when its size or mtime changed). */
  async #turnOf(file: string, sidechain: boolean): Promise<{ readonly turn: TranscriptTurn; readonly mtimeMs: number } | null> {
    let info;
    try {
      info = await stat(file);
    } catch {
      return null;
    }
    const key = `${info.size}:${info.mtimeMs}`;
    const cached = this.#turns.get(file);
    if (cached && cached.key === key) return cached;
    const start = Math.max(0, info.size - ACTIVITY_TAIL_BYTES);
    let text = '';
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(info.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
    // A tail starts inside a line: that line is not whole.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    const value = { key, turn: transcriptTurn(parseTranscript(text), { sidechain }), mtimeMs: info.mtimeMs };
    this.#turns.set(file, value);
    return value;
  }

  /**
   * D53: derives the session's live activity again (its transcript's and running
   * subagents' turns, its hook signals) and publishes the `/hub` `activity` event
   * when it changed; then its delivery state.
   */
  async #refreshActivity(sessionId: string): Promise<void> {
    if (this.#closed) return;
    const record = await this.#store.sessions.get(sessionId);
    if (!record || !record.hooked) return;
    let value: SessionActivity | null = null;
    const terminal = this.#terminals.get(record.claudeSessionId);
    const agents = await this.#store.agents.listBySession(sessionId);
    const main = agents.find((agent) => agent.kind === 'main');
    if (record.closedAt === null && main && record.status !== 'done') {
      const transcript = await this.#transcriptOf(record);
      const read = transcript ? await this.#turnOf(transcript, false) : null;
      let changed = read?.mtimeMs ?? null;
      const subagents: Record<string, TranscriptTurn> = {};
      if (transcript) {
        const running = agents.filter((agent) => agent.kind === 'subagent' && agent.status === 'run' && agent.taskId);
        for (const agent of running) {
          const file = path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents', `agent-${agent.taskId}.jsonl`);
          const sub = await this.#turnOf(file, true);
          if (!sub) continue;
          subagents[agent.id] = sub.turn;
          changed = Math.max(changed ?? 0, sub.mtimeMs);
        }
      }
      const iso = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms).toISOString());
      const request = [...this.#requests.values()].filter((open) => open.sessionId === sessionId && !open.done).sort((a, b) => a.openedAt - b.openedAt)[0];
      value = hookedActivity({
        mainAgentId: main.id,
        transcript: read?.turn ?? NO_TURN,
        transcriptChangedAt: iso(changed),
        subagents,
        hooks: {
          startedAt: iso(terminal?.startedAt),
          stoppedAt: iso(terminal?.stoppedAt),
          ended: terminal?.ended === true,
          permission: request ? { tool: request.toolName, summary: toolSummary(request.toolName, request.input), since: iso(request.openedAt) as string } : null,
          lastHookAt: iso(terminal?.lastHookAt),
        },
      });
    }
    const json = JSON.stringify(value);
    if (this.#activity.get(sessionId)?.json !== json) {
      this.#activity.set(sessionId, { value, json });
      let throttle = this.#activityEvents.get(sessionId);
      if (!throttle) {
        throttle = new LatestThrottle<SessionActivity | null>({ intervalMs: ACTIVITY_EVENT_MS, send: (activity) => this.#bus.publish('activity', { sessionId, activity }) });
        this.#activityEvents.set(sessionId, throttle);
      }
      throttle.push(value);
    }
    await this.#refreshStatus(record);
  }

  // ── messages ─────────────────────────────────────────────────────────

  /**
   * A chat message to a hooked session: shown at once as the developer's message
   * with the D44 clock (`queued: turn`), queued in the mailbox, delivered by the
   * next waiter once the session is idle; the transcript's copy marks it delivered.
   */
  async sendMessage(sessionId: string, text: string, attachments: PreparedAttachments = NO_ATTACHMENTS): Promise<void> {
    const record = await this.#store.sessions.get(sessionId);
    if (!record || !record.hooked) throw new SupervisorError('not-found', `no hooked session ${sessionId}`);
    if (record.closedAt !== null) throw new SupervisorError('closed', 'the session is closed (unhooked): hook into it again first');
    const trimmed = text.trim();
    // A message reaches the model as text: a slash command would not run (it stays in the terminal).
    if (/^\/[a-z][\w:-]*(\s|$)/i.test(trimmed)) {
      throw new HookError(409, 'hooked-unavailable', 'Slash commands stay in the terminal: a message from Switchboard reaches the model as text, not as a command.');
    }
    // D57 (ASSUMED D57-hooked): hooks carry text only, so every attachment is a file on this machine, named by its path.
    const sent = messageWithFiles(trimmed, attachments.filesText);
    if (sent.length > HOOK_MESSAGE_MAX) throw new HookError(422, 'invalid', `a message to a terminal session is at most ${HOOK_MESSAGE_MAX} characters`);
    const main = (await this.#store.agents.listBySession(sessionId)).find((agent) => agent.kind === 'main');
    const payload: UserPayload = {
      type: 'user',
      text: trimmed,
      origin: 'user',
      delivered: false,
      queued: 'turn',
      ...(attachments.refs.length > 0 ? { attachments: attachments.refs } : {}),
      ...(sent !== trimmed ? { sentText: sent } : {}),
    };
    const event = await this.#store.events.append({
      sessionId,
      agentId: main?.id ?? null,
      kind: userMessageKind(trimmed),
      label: trimmed === '' && attachments.refs.length > 0 ? attachmentsLabel(attachments.refs) : textLabel(trimmed),
      payload,
    });
    this.#publishEvent(event);
    await this.#store.pendingMessages.enqueue({ sessionId, kind: HOOK_MESSAGE_KIND, text: sent });
    await this.#store.sessions.update(sessionId, { lastActivityAt: new Date(this.#now()).toISOString() });
    await this.#publishSession(sessionId);
    void this.#pump(record.claudeSessionId);
  }

  /** The question pipeline's "send now if it runs" (a stale batch's answers): the mailbox; always taken. */
  async sendToLive(sessionId: string, text: string): Promise<boolean> {
    const record = await this.#store.sessions.get(sessionId);
    if (!record || record.closedAt !== null) return false;
    await this.#store.pendingMessages.enqueue({ sessionId, kind: HOOK_MESSAGE_KIND, text });
    void this.#pump(record.claudeSessionId);
    return true;
  }

  #limiter(claudeSessionId: string): DeliveryLimiter {
    let limiter = this.#limiters.get(claudeSessionId);
    if (!limiter) {
      limiter = this.#limit ? new DeliveryLimiter(this.#limit.max, this.#limit.windowMs) : new DeliveryLimiter();
      this.#limiters.set(claudeSessionId, limiter);
    }
    return limiter;
  }

  /** Delivers the mailbox when everything allows it; one run at a time per session. */
  #pump(claudeSessionId: string): Promise<void> {
    const previous = this.#pumps.get(claudeSessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.#pumpNow(claudeSessionId));
    this.#pumps.set(claudeSessionId, run);
    void run.finally(() => {
      if (this.#pumps.get(claudeSessionId) === run) this.#pumps.delete(claudeSessionId);
    });
    return run.catch((error: unknown) => this.#onError(error));
  }

  async #pumpNow(claudeSessionId: string): Promise<void> {
    if (this.#closed) return;
    const record = await this.#hookedRecord(claudeSessionId);
    if (!record) return;
    const terminal = this.#terminals.get(claudeSessionId);
    // D48 ruling D48-midturn-policy: delivered as soon as possible, also while a turn runs (the CLI folds it in at the next
    // tool boundary; a turn that ends first starts the next one on it). One wake-up in flight at a time.
    if (terminal?.ended || this.#woken(claudeSessionId)) return;
    const waiter = this.#waiters.get(claudeSessionId);
    if (!waiter || waiter.done) return;
    const pending = (await this.#store.pendingMessages.pending(record.id)).filter((message) => message.kind === HOOK_MESSAGE_KIND);
    if (pending.length === 0) return;
    const limiter = this.#limiter(claudeSessionId);
    const now = this.#now();
    if (!limiter.allows(now)) {
      // The circuit breaker: the messages stay queued until the window lets the next wake-up out.
      if (!this.#pumpTimers.has(claudeSessionId)) {
        const timer = setTimeout(() => {
          this.#pumpTimers.delete(claudeSessionId);
          void this.#pump(claudeSessionId);
        }, Math.max(50, limiter.nextAt(now) - now));
        timer.unref();
        this.#pumpTimers.set(claudeSessionId, timer);
      }
      return;
    }
    // Claimed exactly once: marked delivered before the waiter is answered, so no later waiter can take them again.
    for (const message of pending) await this.#store.pendingMessages.markDelivered(message.id);
    limiter.record(now);
    this.#awaitingTurn.set(claudeSessionId, { at: now, started: false });
    const text = pending.map((message) => message.text).join('\n\n');
    this.#finishWaiter(waiter, { status: 200, body: { message: waiterText(text, await this.#installedRewake()) } });
    if (terminal) terminal.running = true;
    await this.#setStatus(record.id, 'run');
  }

  /** `true` while a wake-up's turn has not ended (the next wake-up waits for it). */
  #woken(claudeSessionId: string): boolean {
    const woken = this.#awaitingTurn.get(claudeSessionId);
    if (!woken) return false;
    if (!woken.started && this.#now() - woken.at > WOKEN_TURN_TIMEOUT_MS) {
      this.#awaitingTurn.delete(claudeSessionId);
      return false;
    }
    return true;
  }

  /** Whether the installed waiter entries carry the internal rewake fields (the stderr text follows what is installed). */
  async #installedRewake(): Promise<boolean> {
    const read = await readHookSettings(this.configDir);
    return JSON.stringify(read.settings?.['hooks'] ?? null).includes('"rewakeMessage"');
  }

  // ── the hook endpoints ───────────────────────────────────────────────

  #terminalOf(body: unknown): { readonly terminal: Terminal; readonly input: Record<string, unknown> } | null {
    if (!isRecord(body) || !isRecord(body['event'])) return null;
    const input = body['event'];
    const claudeSessionId = input['session_id'];
    if (typeof claudeSessionId !== 'string' || claudeSessionId === '') return null;
    const entrypoint = typeof body['entrypoint'] === 'string' ? body['entrypoint'] : null;
    if (entrypoint === 'sdk-cli') {
      this.#supervised.add(claudeSessionId);
      return null;
    }
    let terminal = this.#terminals.get(claudeSessionId);
    if (!terminal) {
      terminal = { claudeSessionId, pid: null, cwd: null, transcriptPath: null, entrypoint, lastHookAt: null, running: false, ended: false, startedAt: null, stoppedAt: null };
      this.#terminals.set(claudeSessionId, terminal);
    }
    if (typeof body['claudePid'] === 'number') terminal.pid = body['claudePid'];
    if (typeof input['cwd'] === 'string') terminal.cwd = input['cwd'];
    if (typeof input['transcript_path'] === 'string') terminal.transcriptPath = input['transcript_path'];
    terminal.entrypoint = entrypoint ?? terminal.entrypoint;
    terminal.lastHookAt = this.#now();
    terminal.ended = false;
    return { terminal, input };
  }

  /** `POST /hook/v1/event` (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd). */
  async onEvent(body: unknown): Promise<void> {
    const found = this.#terminalOf(body);
    if (!found) return;
    const { terminal, input } = found;
    const cs = terminal.claudeSessionId;
    switch (input['hook_event_name']) {
      case 'SessionStart':
        terminal.running = false;
        break;
      case 'UserPromptSubmit': {
        terminal.running = true;
        terminal.startedAt = this.#now();
        const woken = this.#awaitingTurn.get(cs);
        if (woken) woken.started = true;
        break;
      }
      case 'PostToolUse':
        this.#answeredInTerminal(cs, input['tool_name'], input['tool_input']);
        break;
      case 'Stop':
        terminal.running = false;
        terminal.stoppedAt = this.#now();
        // The woken turn (if any) ended; a Stop before it started (a turn already running) does not count.
        if (this.#awaitingTurn.get(cs)?.started) this.#awaitingTurn.delete(cs);
        this.#withdrawAll(cs);
        break;
      case 'SessionEnd':
        terminal.running = false;
        terminal.ended = true;
        this.#awaitingTurn.delete(cs);
        this.#withdrawAll(cs);
        {
          const waiter = this.#waiters.get(cs);
          if (waiter) this.#finishWaiter(waiter, { status: 204, body: null });
        }
        break;
      default:
        break;
    }
    const record = await this.#hookedRecord(cs);
    if (record) {
      if (terminal.transcriptPath && terminal.transcriptPath !== record.transcriptPath) await this.#store.sessions.update(record.id, { transcriptPath: terminal.transcriptPath });
      await this.#setStatus(record.id, this.#statusOf(terminal));
      this.#scheduleSync(record.id);
    }
    await this.#pump(cs);
    // D53: the turn started / ended, a tool ran, the session ended: the live line follows at once.
    if (record) await this.#refreshActivity(record.id);
  }

  #statusOf(terminal: Terminal): SessionStatus {
    if (terminal.ended) return 'done';
    if ([...this.#requests.values()].some((request) => request.claudeSessionId === terminal.claudeSessionId && !request.done)) return 'need';
    return terminal.running ? 'run' : 'idle';
  }

  /**
   * `POST /hook/v1/permission`: held until the developer answers (the hook's
   * output), or answered at once with no decision for a session that is not hooked.
   */
  async onPermission(body: unknown, onAbort: OnAbort): Promise<HookAnswer> {
    const found = this.#terminalOf(body);
    if (!found || this.#closed) return { status: 204, body: null };
    const { terminal, input } = found;
    const record = await this.#hookedRecord(terminal.claudeSessionId);
    if (!record) return { status: 204, body: null };
    const toolName = typeof input['tool_name'] === 'string' ? input['tool_name'] : 'tool';
    const toolInput = isRecord(input['tool_input']) ? input['tool_input'] : {};
    const suggestions = Array.isArray(input['permission_suggestions']) ? input['permission_suggestions'] : [];
    const requestId = `hook-${randomUUID()}`;
    return new Promise<HookAnswer>((resolve) => {
      const request: OpenRequest = {
        requestId,
        claudeSessionId: terminal.claudeSessionId,
        sessionId: record.id,
        toolName,
        input: toolInput,
        suggestions,
        batch: toolName === 'AskUserQuestion',
        openedAt: this.#now(),
        done: false,
        finish: resolve,
      };
      this.#requests.set(requestId, request);
      // The hook process went away (its timeout, the CLI quitting): the item goes stale.
      onAbort(() => {
        if (!request.done) this.#withdraw(request, false);
      });
      void (async () => {
        try {
          await this.#questions.canUseTool({
            session: record,
            request: {
              kind: 'can-use-tool',
              raw: {},
              uuid: null,
              sessionId: null,
              requestId,
              toolName,
              input: toolInput,
              toolUseId: null,
              agentId: null,
              description: null,
              decisionReason: 'The terminal asks for permission (its own dialog is open too: whichever answers first wins)',
              hookSuggestions: suggestions,
            },
          });
          await this.#setStatus(record.id, 'need');
          // D53: "Waiting for permission: <tool>".
          await this.#refreshActivity(record.id);
        } catch (error) {
          this.#onError(error);
          this.#finishRequest(request, { status: 204, body: null });
        }
      })();
    });
  }

  /** The question pipeline's answer to a hooked request: the hook's output. */
  async respond(sessionId: string, requestId: string, decision: ToolDecision): Promise<void> {
    const request = this.#requests.get(requestId);
    if (!request || request.done || request.sessionId !== sessionId) {
      throw new SupervisorError('request-not-open', 'the terminal no longer waits for this answer (answered there, or its hook ended)');
    }
    const output =
      decision.behavior === 'allow'
        ? {
            behavior: 'allow',
            updatedInput: decision.updatedInput,
            ...(decision.updatedPermissions && decision.updatedPermissions.length > 0 ? { updatedPermissions: decision.updatedPermissions } : {}),
          }
        : { behavior: 'deny', message: decision.message };
    this.#finishRequest(request, { status: 200, body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: output } } });
    const terminal = this.#terminals.get(request.claudeSessionId);
    if (terminal) await this.#setStatus(sessionId, this.#statusOf(terminal));
  }

  #finishRequest(request: OpenRequest, answer: HookAnswer): void {
    if (request.done) return;
    request.done = true;
    this.#requests.delete(request.requestId);
    request.finish(answer);
    // D53: no longer "Waiting for permission".
    void this.#refreshActivity(request.sessionId).catch((error: unknown) => this.#onError(error));
  }

  /** Closes a held request that was not answered here: stale, or (a question batch answered at the terminal) answered there. */
  #withdraw(request: OpenRequest, answeredInTerminal: boolean): void {
    this.#finishRequest(request, { status: 204, body: null });
    void this.#questions.cancelled(request.sessionId, request.requestId, answeredInTerminal && request.batch ? ANSWERED_IN_TERMINAL : null).then(
      async () => {
        const terminal = this.#terminals.get(request.claudeSessionId);
        if (terminal) await this.#setStatus(request.sessionId, this.#statusOf(terminal));
      },
      (error: unknown) => this.#onError(error),
    );
  }

  /** PostToolUse of a tool a held request asked about: the terminal answered it (or our answer already did). */
  #answeredInTerminal(claudeSessionId: string, toolName: unknown, toolInput: unknown): void {
    for (const request of [...this.#requests.values()]) {
      if (request.claudeSessionId !== claudeSessionId || request.done || request.toolName !== toolName) continue;
      // AskUserQuestion's input gains `answers`; compare the questions only.
      const same = request.batch ? sameJson(request.input['questions'], isRecord(toolInput) ? toolInput['questions'] : undefined) : sameJson(request.input, toolInput);
      if (same) {
        this.#withdraw(request, true);
        return;
      }
    }
  }

  /** The turn ended (or the session did): every request it held is gone. */
  #withdrawAll(claudeSessionId: string): void {
    for (const request of [...this.#requests.values()]) {
      if (request.claudeSessionId === claudeSessionId && !request.done) this.#withdraw(request, true);
    }
  }

  /**
   * `POST /hook/v1/waiter`: held until a message is released for its session (`200 { message }`, exit 2). `204` is the
   * explicit stop ("no longer needed": superseded by a newer waiter, the session ended or was unhooked, not a session
   * Switchboard hooks); anything else (a dropped connection, `503` at shutdown, an error) is NOT a stop: the hook script
   * retries (`docs/peers.md` → *Waiter lifetime*).
   */
  async onWaiter(body: unknown, onAbort: OnAbort): Promise<HookAnswer> {
    const found = this.#terminalOf(body);
    if (!found || this.#closed || found.terminal.ended) return { status: 204, body: null };
    const cs = found.terminal.claudeSessionId;
    return new Promise<HookAnswer>((resolve) => {
      const previous = this.#waiters.get(cs);
      if (previous) this.#finishWaiter(previous, { status: 204, body: null });
      const waiter: Waiter = { claudeSessionId: cs, done: false, finish: resolve };
      this.#waiters.set(cs, waiter);
      this.#waiterSeen.add(cs);
      onAbort(() => {
        if (waiter.done) return;
        waiter.done = true;
        if (this.#waiters.get(cs) === waiter) this.#waiters.delete(cs);
        void this.#refreshStatusOf(cs);
      });
      // D53: a hook listens now (the header note and the queued message's words follow).
      void this.#pump(cs).then(() => this.#refreshStatusOf(cs));
    });
  }

  #finishWaiter(waiter: Waiter, answer: HookAnswer): void {
    if (waiter.done) return;
    waiter.done = true;
    if (this.#waiters.get(waiter.claudeSessionId) === waiter) this.#waiters.delete(waiter.claudeSessionId);
    waiter.finish(answer);
    void this.#refreshStatusOf(waiter.claudeSessionId);
  }

  /** Waiters held right now (tests; the resource guard: at most one per session). */
  get waiterCount(): number {
    return this.#waiters.size;
  }

  // ── transcript sync, status, liveness ────────────────────────────────

  #scheduleSync(sessionId: string): void {
    void this.#syncNow(sessionId, false);
  }

  /** Imports the transcript's new turns (coalesced per session). */
  #syncNow(sessionId: string, fromStart: boolean): Promise<void> {
    const slot = this.#syncs.get(sessionId) ?? { running: null, again: false };
    this.#syncs.set(sessionId, slot);
    if (slot.running && !fromStart) {
      slot.again = true;
      return slot.running;
    }
    const run = (async () => {
      do {
        slot.again = false;
        await this.#importOnce(sessionId, fromStart);
      } while (slot.again && !this.#closed);
    })()
      .catch((error: unknown) => this.#onError(error))
      .finally(() => {
        slot.running = null;
      });
    slot.running = run;
    return run;
  }

  async #transcriptOf(record: SessionRecord): Promise<string | null> {
    return this.#terminals.get(record.claudeSessionId)?.transcriptPath ?? record.transcriptPath ?? (await findTranscriptFile(this.configDir, record.claudeSessionId));
  }

  async #importOnce(sessionId: string, fromStart: boolean): Promise<void> {
    const record = await this.#store.sessions.get(sessionId);
    if (!record || !record.hooked) return;
    const transcript = await this.#transcriptOf(record);
    if (!transcript) return;
    try {
      await stat(transcript);
    } catch {
      return;
    }
    const main = (await this.#store.agents.listBySession(sessionId)).find((agent) => agent.kind === 'main');
    if (!main) return;
    const onEvent = (event: EventRecord): void => this.#publishEvent(event);
    let result = await importTerminalTurns({ store: this.#store, session: record, mainAgentId: main.id, transcript, onEvent, fromStart, ...this.#saveImage });
    // A sync point the file no longer has (/clear, a compaction): read the newest chain whole (stored entries are skipped).
    if (!result.found) result = await importTerminalTurns({ store: this.#store, session: record, mainAgentId: main.id, transcript, onEvent, fromStart: true, ...this.#saveImage });
    const agentsChanged = await this.#importSubagents(record, transcript, main.id, onEvent);
    if (result.imported > 0 || agentsChanged) await this.#publishSession(sessionId);
    await this.#refreshActivity(sessionId);
  }

  /**
   * D48 ruling D48-hooked-subagents: the session's plain subagents (Agent / Task,
   * background ones too), each from `<session>/subagents/agent-<id>.jsonl` with its
   * `agent-<id>.meta.json` (`agentType`, `description`, `toolUseId`): an agent row
   * (kind `subagent`, `taskId` = the file's agent id, `toolUseId` = the call that
   * started it, so the chat's call opens its chat, D36) and its events. Status:
   * `done` once its file ends with an assistant message that ended its turn
   * (`stop_reason: end_turn`), `idle` when the session ended first, else `run`.
   * Seam for D51: workflow agents' files (`subagents/workflows/…`,
   * `<session>/workflows/…`) are not read here (only `agent-*.jsonl` directly in
   * `subagents/`): D51's `WorkflowService` reads them for every session by its CLI
   * session id, hooked ones included. Returns whether an agent row was added or changed.
   */
  async #importSubagents(record: SessionRecord, transcript: string, mainAgentId: string, onEvent: (event: EventRecord) => void): Promise<boolean> {
    let changed = false;
    for (const file of await subagentFiles(transcript)) {
      const agentId = path.basename(file, '.jsonl').slice('agent-'.length);
      let meta: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
        if (isRecord(parsed)) meta = parsed;
      } catch {
        // No meta (yet): the agent's type and call stay unknown.
      }
      const text = (key: string): string | null => (typeof meta[key] === 'string' && meta[key] !== '' ? (meta[key] as string) : null);
      const agents = await this.#store.agents.listBySession(record.id);
      let agent = agents.find((entry) => entry.kind === 'subagent' && entry.taskId === agentId) ?? null;
      if (!agent) {
        agent = await this.#store.agents.create({
          sessionId: record.id,
          kind: 'subagent',
          name: text('agentType') ?? 'agent',
          description: text('description'),
          subagentType: text('agentType'),
          toolUseId: text('toolUseId'),
          taskId: agentId,
          status: 'run',
        });
        changed = true;
      }
      await importTerminalTurns({ store: this.#store, session: record, mainAgentId, transcript: file, onEvent, subagent: { agentId: agent.id } });
      const status = (await subagentFinished(file)) ? 'done' : (await this.#store.sessions.get(record.id))?.status === 'done' ? 'idle' : 'run';
      if (agent.status !== status) {
        await this.#store.agents.update(agent.id, { status, ...(status === 'run' ? {} : { endedAt: new Date(this.#now()).toISOString() }) });
        changed = true;
      }
    }
    return changed;
  }

  /** Checks the hooked sessions' transcripts for growth (`activeOnly`, D53: only those whose turn runs). */
  async #pollTranscripts(activeOnly = false): Promise<void> {
    if (this.#closed) return;
    for (const record of await this.#store.sessions.list({ closed: false })) {
      if (!record.hooked) continue;
      if (activeOnly && !this.#activity.get(record.id)?.value) continue;
      const transcript = await this.#transcriptOf(record);
      if (!transcript) continue;
      try {
        const info = await stat(transcript);
        // The subagents' files grow on their own (a background agent while the main chain waits).
        const parts = [`${info.size}:${info.mtimeMs}`];
        for (const file of await subagentFiles(transcript)) {
          const sub = await stat(file).catch(() => null);
          if (sub) parts.push(`${sub.size}:${sub.mtimeMs}`);
        }
        const key = parts.join('|');
        if (this.#sizes.get(record.id) !== key) {
          this.#sizes.set(record.id, key);
          this.#scheduleSync(record.id);
        }
      } catch {
        // Gone: the liveness poll decides.
      }
    }
  }

  async #pollLiveness(): Promise<void> {
    const hooked = (await this.#store.sessions.list({ closed: false })).filter((record) => record.hooked && record.status !== 'done');
    if (hooked.length === 0) return;
    const rows = await this.#listAgents(true);
    if (rows === null) return;
    const live = new Set(rows.map((row) => row.sessionId));
    for (const record of hooked) {
      if (live.has(record.claudeSessionId)) continue;
      const terminal = this.#terminals.get(record.claudeSessionId);
      if (terminal?.lastHookAt && this.#now() - terminal.lastHookAt < 15_000) continue;
      if (terminal) {
        terminal.ended = true;
        terminal.running = false;
        const waiter = this.#waiters.get(record.claudeSessionId);
        if (waiter) this.#finishWaiter(waiter, { status: 204, body: null });
        this.#withdrawAll(record.claudeSessionId);
      }
      await this.#setStatus(record.id, 'done');
      await this.#refreshActivity(record.id);
    }
  }

  async #setStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const record = await this.#store.sessions.get(sessionId);
    // D72: a session continued in Switchboard meanwhile is the supervisor's (a poll that started before must not mark it).
    if (!record || !record.hooked || record.status === status) return;
    await this.#store.sessions.update(sessionId, { status });
    const main = (await this.#store.agents.listBySession(sessionId)).find((agent) => agent.kind === 'main');
    if (main) await this.#store.agents.update(main.id, { status });
    await this.#publishSession(sessionId);
  }

  async #publishSession(sessionId: string): Promise<void> {
    const record = await this.#store.sessions.get(sessionId);
    if (record) this.#bus.publish('sessionUpdated', await toSession(this.#store, record));
  }

  #publishEvent(event: EventRecord): void {
    const payload = { sessionId: event.sessionId, event: toEvent(event) };
    this.#bus.publish('event', payload);
    for (const listener of [...this.#eventListeners]) {
      try {
        listener(payload);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  /**
   * D52: a hooked session's loop events, read from its transcript (the loop
   * tracker derives its loops from them: the stored events have no turn ends and
   * no scheduled firings); `null` for any other session or without a transcript.
   */
  async loopEvents(sessionId: string): Promise<readonly LoopEventInput[] | null> {
    const record = await this.#store.sessions.get(sessionId);
    if (!record || !record.hooked) return null;
    const transcript = await this.#transcriptOf(record);
    return transcript ? this.#loopFiles.events(transcript) : null;
  }

  /**
   * D52: every event imported into a hooked session (added or updated), as the
   * supervisor's `event` notification reads, so the loop tracker derives a hooked
   * session's loops like a supervised one's. Returns the unsubscribe.
   */
  on(name: 'event', listener: (payload: { readonly sessionId: string; readonly event: SessionEvent }) => void): () => void {
    if (name !== 'event') return () => undefined;
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }
}

/** D48 P4: the plain subagents' transcripts of a session (`<dir>/<session id>/subagents/agent-*.jsonl`), sorted; workflow agents (D51) are not listed. */
export async function subagentFiles(transcript: string): Promise<string[]> {
  const dir = path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents');
  try {
    return (await readdir(dir)).filter((name) => /^agent-[\w-]+\.jsonl$/.test(name)).sort().map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** `true` when a subagent's file ends with an assistant message that ended its turn (`stop_reason: end_turn`). */
async function subagentFinished(file: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return false;
  }
  const lines = text.split('\n').filter((line) => line.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i] as string) as Record<string, unknown>;
      if (entry['type'] !== 'assistant' && entry['type'] !== 'user') continue;
      const message = entry['message'] as Record<string, unknown> | undefined;
      return entry['type'] === 'assistant' && message?.['stop_reason'] === 'end_turn';
    } catch {
      continue;
    }
  }
  return false;
}
