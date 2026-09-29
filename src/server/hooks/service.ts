import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { HooksStatus, Session, TerminalSession } from '../../core/api.ts';
import { type HookCommand, DeliveryLimiter, HOOK_MESSAGE_MAX, type TerminalAgentRow, parseTerminalAgents, rewakeSupported, waiterText } from '../../core/hooks.ts';
import { textLabel, userMessageKind } from '../../core/derive/event-kind.ts';
import { ANSWERED_IN_TERMINAL } from '../../core/remote-control.ts';
import type { SessionStatus } from '../../core/model.ts';
import type { ToolDecision } from '../../core/stdin.ts';
import type { ServerConfig } from '../config.ts';
import type { EventRecord } from '../db/repos/events.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { runCommand, succeeded } from '../exec.ts';
import type { HubBus } from '../hub/bus.ts';
import type { QuestionPipeline } from '../inbox/pipeline.ts';
import { toEvent, toSession } from '../sessions/wire.ts';
import { claudeConfigDir, findTranscriptFile, importTerminalTurns } from '../supervisor/attach.ts';
import { childEnv } from '../supervisor/argv.ts';
import { SupervisorError } from '../supervisor/supervisor.ts';
import { HookInstallError, hooksState, installHooks, readHookSettings, removeHooks } from './installer.ts';

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
 *   released only to a live waiter (the `asyncRewake` hook of SessionStart / Stop)
 *   while the session is idle; every pending message is claimed exactly once
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
}

interface OpenRequest {
  readonly requestId: string;
  readonly claudeSessionId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly suggestions: readonly unknown[];
  readonly batch: boolean;
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
  readonly #terminals = new Map<string, Terminal>();
  readonly #requests = new Map<string, OpenRequest>();
  readonly #waiters = new Map<string, Waiter>();
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

  constructor(options: HookServiceOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#bus = options.bus;
    this.#questions = options.questions;
    this.#tokenFile = options.hookTokenFile;
    this.#env = options.env ?? process.env;
    this.#listAgentsOption = options.listAgents;
    this.#cliVersionOption = options.cliVersion;
    this.#limit = options.limit;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((error) => console.error('switchboard hooks:', error));
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
  }

  /** Stops the polls and answers every held hook call with no decision / no message. */
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#syncTimer);
    clearInterval(this.#livenessTimer);
    for (const timer of this.#pumpTimers.values()) clearTimeout(timer);
    for (const request of [...this.#requests.values()]) this.#finishRequest(request, { status: 204, body: null });
    for (const waiter of [...this.#waiters.values()]) this.#finishWaiter(waiter, { status: 204, body: null });
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

  /** `GET /api/terminal-sessions`: the interactive terminal sessions on this machine (Switchboard's own left out). */
  async listTerminals(): Promise<TerminalSession[]> {
    const rows = await this.#listAgents(true);
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

  /** `true` when `sessionId` is an open hooked session. */
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
    for (const request of [...this.#requests.values()]) {
      if (request.sessionId === sessionId) this.#finishRequest(request, { status: 204, body: null });
    }
  }

  // ── messages ─────────────────────────────────────────────────────────

  /**
   * A chat message to a hooked session: shown at once as the developer's message
   * with the D44 clock (`queued: turn`), queued in the mailbox, delivered by the
   * next waiter once the session is idle; the transcript's copy marks it delivered.
   */
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const record = await this.#store.sessions.get(sessionId);
    if (!record || !record.hooked) throw new SupervisorError('not-found', `no hooked session ${sessionId}`);
    if (record.closedAt !== null) throw new SupervisorError('closed', 'the session is closed (unhooked): hook into it again first');
    const trimmed = text.trim();
    // A message reaches the model as text: a slash command would not run (it stays in the terminal).
    if (/^\/[a-z][\w:-]*(\s|$)/i.test(trimmed)) {
      throw new HookError(409, 'hooked-unavailable', 'Slash commands stay in the terminal: a message from Switchboard reaches the model as text, not as a command.');
    }
    if (trimmed.length > HOOK_MESSAGE_MAX) throw new HookError(422, 'invalid', `a message to a terminal session is at most ${HOOK_MESSAGE_MAX} characters`);
    const main = (await this.#store.agents.listBySession(sessionId)).find((agent) => agent.kind === 'main');
    const event = await this.#store.events.append({
      sessionId,
      agentId: main?.id ?? null,
      kind: userMessageKind(trimmed),
      label: textLabel(trimmed),
      payload: { type: 'user', text: trimmed, origin: 'user', delivered: false, queued: 'turn' },
    });
    this.#publishEvent(event);
    await this.#store.pendingMessages.enqueue({ sessionId, kind: HOOK_MESSAGE_KIND, text: trimmed });
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
    if (terminal?.running || terminal?.ended || this.#woken(claudeSessionId)) return;
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
      terminal = { claudeSessionId, pid: null, cwd: null, transcriptPath: null, entrypoint, lastHookAt: null, running: false, ended: false };
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
        const woken = this.#awaitingTurn.get(cs);
        if (woken) woken.started = true;
        break;
      }
      case 'PostToolUse':
        this.#answeredInTerminal(cs, input['tool_name'], input['tool_input']);
        break;
      case 'Stop':
        terminal.running = false;
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

  /** `POST /hook/v1/waiter`: held until a message is released for its session (exit 2) or it is superseded / its session ends (no message). */
  async onWaiter(body: unknown, onAbort: OnAbort): Promise<HookAnswer> {
    const found = this.#terminalOf(body);
    if (!found || this.#closed || found.terminal.ended) return { status: 204, body: null };
    const cs = found.terminal.claudeSessionId;
    return new Promise<HookAnswer>((resolve) => {
      const previous = this.#waiters.get(cs);
      if (previous) this.#finishWaiter(previous, { status: 204, body: null });
      const waiter: Waiter = { claudeSessionId: cs, done: false, finish: resolve };
      this.#waiters.set(cs, waiter);
      onAbort(() => {
        if (waiter.done) return;
        waiter.done = true;
        if (this.#waiters.get(cs) === waiter) this.#waiters.delete(cs);
      });
      void this.#pump(cs);
    });
  }

  #finishWaiter(waiter: Waiter, answer: HookAnswer): void {
    if (waiter.done) return;
    waiter.done = true;
    if (this.#waiters.get(waiter.claudeSessionId) === waiter) this.#waiters.delete(waiter.claudeSessionId);
    waiter.finish(answer);
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
    let result = await importTerminalTurns({ store: this.#store, session: record, mainAgentId: main.id, transcript, onEvent, fromStart });
    // A sync point the file no longer has (/clear, a compaction): read the newest chain whole (stored entries are skipped).
    if (!result.found) result = await importTerminalTurns({ store: this.#store, session: record, mainAgentId: main.id, transcript, onEvent, fromStart: true });
    if (result.imported > 0) await this.#publishSession(sessionId);
  }

  async #pollTranscripts(): Promise<void> {
    for (const record of await this.#store.sessions.list({ closed: false })) {
      if (!record.hooked) continue;
      const transcript = await this.#transcriptOf(record);
      if (!transcript) continue;
      try {
        const info = await stat(transcript);
        const key = `${info.size}:${info.mtimeMs}`;
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
    }
  }

  async #setStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const record = await this.#store.sessions.get(sessionId);
    if (!record || record.status === status) return;
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
    this.#bus.publish('event', { sessionId: event.sessionId, event: toEvent(event) });
  }
}
