import { setTimeout as sleep } from 'node:timers/promises';
import type { Session } from '../../core/api.ts';
import { withSwitchboardHooks } from '../../core/hooks.ts';
import { SESSION_MARKER_ENV } from '../../core/processes.ts';
import { terminalEnv, terminalSize } from '../../core/terminals.ts';
import { DEFAULT_USER_PROFILE_ID } from '../../core/user-profiles.ts';
import type { Store } from '../db/store.ts';
import type { HookedContinuer } from '../hooks/continue.ts';
import type { HookService } from '../hooks/service.ts';
import type { HubBus } from '../hub/bus.ts';
import { toSession } from '../sessions/wire.ts';
import { type SessionSupervisor, SupervisorError } from '../supervisor/supervisor.ts';
import { TerminalError, type TerminalService } from '../terminals/service.ts';

/** A refusal the routes answer with its status and body. */
export class CliModeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CliModeError';
    this.status = status;
    this.code = code;
  }
}

/** Options of {@link CliModeService}. */
export interface CliModeServiceOptions {
  readonly store: Store;
  readonly bus: HubBus;
  readonly supervisor: SessionSupervisor;
  readonly hooks: HookService;
  readonly continuer: HookedContinuer;
  readonly terminals: TerminalService;
  /** How long Back to chat mode waits for the CLI to exit after Ctrl-C (ms) before it closes the terminal. */
  readonly exitGraceMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** The chat line when an agent comes back to chat mode without its terminal (a restart). */
export const CLI_MODE_RESTART_LABEL = 'Back in chat mode: its CLI terminal ended with the Switchboard restart';
/** The chat line when the CLI terminal could not start (the agent stays in chat mode). */
export const CLI_MODE_FAILED_LABEL = 'Back in chat mode: the CLI could not start';

/**
 * D171 · the agent's CLI tab (`docs/terminals.md` → *CLI mode*): an agent switches between
 * **chat mode** (Switchboard's headless process, as before) and **CLI mode** (the same conversation
 * as the interactive `claude`, its native TUI, in a D170 terminal of its computer).
 *
 * - **Enter** ({@link enter}): the supervisor stops the headless process (a running turn: refused
 *   unless `stopTurn`, then the D7 interrupt first) and marks the session hooked (D48: the terminal's
 *   claude is followed through its hooks, so the Chat tab, the live line, questions and permissions
 *   in Needs you, and the composer's messages, delivered at its next idle, work as for a hooked
 *   terminal session); the terminal runs `claude --resume <id>` with the same launch context and the
 *   D48 hooks passed **for this process only** (`--settings`), owned by the agent's profile.
 * - **Back to chat mode** ({@link back}): Ctrl-C twice (the TUI's own exit), the terminal closed
 *   after a grace, then D72's Continue in Switchboard (the same record resumes headless).
 * - The CLI exiting by itself (or its terminal closed / swept) is Back to chat mode too; a restart
 *   ends every terminal, so {@link recover} puts a session still marked back in chat mode (idle).
 */
export class CliModeService {
  readonly #o: CliModeServiceOptions;
  /** Sessions whose Back to chat mode runs now (their terminal's end is that one's, not a new one). */
  readonly #switching = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: CliModeServiceOptions) {
    this.#o = options;
  }

  /** One switch at a time (enter / back / an ended terminal), in order. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.catch(() => undefined).then(work);
    this.#queue = run;
    return run;
  }

  async #session(sessionId: string): Promise<Session> {
    const record = await this.#o.store.sessions.get(sessionId);
    if (!record) throw new CliModeError(404, 'not-found', `no session ${sessionId}`);
    const session = await toSession(this.#o.store, record, this.#o.supervisor.activity(sessionId));
    this.#o.bus.publish('sessionUpdated', session);
    return session;
  }

  /**
   * `POST /api/sessions/{id}/cli-mode` `{ stopTurn?, cols?, rows? }`: the agent switches to CLI mode.
   * Answers the session (its `cliMode.terminalId`).
   * @throws {CliModeError} 404 `not-found`; 409 `turn-running` / `cli-mode` / `not-available` / `chat` /
   * `hooked` / `closed` / `moved` / `folder-missing`; 503 `unavailable` / `too-many` (the terminal).
   */
  enter(sessionId: string, body: unknown): Promise<Session> {
    return this.#serial(() => this.#enter(sessionId, body));
  }

  async #enter(sessionId: string, body: unknown): Promise<Session> {
    const input = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const record = await this.#o.store.sessions.get(sessionId);
    if (!record) throw new CliModeError(404, 'not-found', `no session ${sessionId}`);
    const { cols, rows } = terminalSize(input['cols'], input['rows']);
    // The D48 hooks for this process only: the developer's own settings files are never touched.
    const settings = withSwitchboardHooks({}, await this.#o.hooks.hookCommand());
    let launch: Awaited<ReturnType<SessionSupervisor['cliModeLaunch']>>;
    try {
      launch = await this.#o.supervisor.cliModeLaunch(sessionId, settings);
      await this.#o.supervisor.enterCliMode(sessionId, { stopTurn: input['stopTurn'] === true });
    } catch (error) {
      if (error instanceof SupervisorError) throw new CliModeError(error.code === 'not-found' ? 404 : error.code === 'closing' ? 503 : 409, error.code, error.message);
      throw error;
    }
    this.#o.hooks.adopted(record.claudeSessionId);
    const [file, ...prefix] = launch.command;
    let terminalId: string;
    try {
      // The terminal's environment as D170's (no SWITCHBOARD_* internals), plus the agent's own: its account, its marker (D127).
      const env = { ...terminalEnv(launch.env), [SESSION_MARKER_ENV]: sessionId };
      const info = await this.#o.terminals.create({
        program: { file: file as string, args: [...prefix, ...launch.args], title: `claude · ${record.title ?? record.name}`, shell: 'program' },
        cwd: launch.cwd,
        owner: record.userProfileId ?? DEFAULT_USER_PROFILE_ID,
        cols,
        rows,
        env,
        onEnd: (why) => void this.#ended(sessionId, why).catch((error: unknown) => this.#o.onError?.(error)),
      });
      terminalId = info.id;
    } catch (error) {
      await this.#o.supervisor.restoreChatMode(sessionId, CLI_MODE_FAILED_LABEL);
      await this.#o.hooks.released(sessionId, record.claudeSessionId);
      if (error instanceof TerminalError) throw new CliModeError(error.status, error.code, error.message);
      throw error;
    }
    await this.#o.store.sessions.update(sessionId, { cliTerminalId: terminalId });
    return this.#session(sessionId);
  }

  /**
   * `DELETE /api/sessions/{id}/cli-mode`: Back to chat mode (the class comment). Answers the session.
   * @throws {CliModeError} 404 `not-found`, 409 `not-cli-mode`, or D72's refusals.
   */
  back(sessionId: string): Promise<Session> {
    return this.#serial(() => this.#back(sessionId));
  }

  async #back(sessionId: string): Promise<Session> {
    const record = await this.#o.store.sessions.get(sessionId);
    if (!record) throw new CliModeError(404, 'not-found', `no session ${sessionId}`);
    const terminalId = record.cliTerminalId;
    if (!terminalId) throw new CliModeError(409, 'not-cli-mode', `${record.title ?? record.name} is in chat mode`);
    this.#switching.add(sessionId);
    try {
      await this.#endTerminal(terminalId);
      return await this.#toChat(sessionId);
    } finally {
      this.#switching.delete(sessionId);
    }
  }

  /** The CLI exits as the developer would end it (Ctrl-C twice), else its terminal is closed (the process tree killed). */
  async #endTerminal(terminalId: string): Promise<void> {
    const { terminals } = this.#o;
    if (terminals.has(terminalId) && !terminals.exited(terminalId)) {
      terminals.write(terminalId, '\x03');
      await sleep(300);
      terminals.write(terminalId, '\x03');
      const until = Date.now() + (this.#o.exitGraceMs ?? 5_000);
      while (!terminals.exited(terminalId) && Date.now() < until) await sleep(100);
    }
    terminals.closeAny(terminalId);
  }

  /** The terminal is gone: D72's continue turns the same record back into a Switchboard-run (headless) session. */
  async #toChat(sessionId: string): Promise<Session> {
    const record = await this.#o.store.sessions.get(sessionId);
    if (!record) throw new CliModeError(404, 'not-found', `no session ${sessionId}`);
    await this.#o.store.sessions.update(sessionId, { cliTerminalId: null });
    const outcome = await this.#o.continuer.continue(sessionId, { confirmStopTerminal: true });
    if (!outcome.ok) {
      // The terminal was ours and is closed: when D72 cannot confirm it (the registry unreadable), the session still leaves CLI mode, idle.
      if (outcome.body.error === 'terminal-unknown' || outcome.body.error === 'agents-unavailable') {
        await this.#o.supervisor.restoreChatMode(sessionId, 'Back in chat mode');
        await this.#o.hooks.released(sessionId, record.claudeSessionId);
        return this.#session(sessionId);
      }
      throw new CliModeError(outcome.status, outcome.body.error, outcome.body.message);
    }
    return outcome.session;
  }

  /** The CLI-mode terminal of `sessionId` ended by itself (the CLI exited, the terminal was closed or swept): back to chat mode. */
  async #ended(sessionId: string, why: 'exited' | 'closed' | 'idle' | 'stopping'): Promise<void> {
    // Switchboard stops: the restart's {@link recover} puts it back in chat mode.
    if (why === 'stopping' || this.#switching.has(sessionId)) return;
    await this.#serial(async () => {
      const record = await this.#o.store.sessions.get(sessionId);
      if (!record?.cliTerminalId || this.#switching.has(sessionId)) return;
      this.#o.terminals.closeAny(record.cliTerminalId);
      await this.#toChat(sessionId).catch((error: unknown) => this.#o.onError?.(error));
    });
  }

  /** At start: a session still in CLI mode lost its terminal with the restart; it is back in chat mode (idle, no process). */
  async recover(): Promise<number> {
    let count = 0;
    for (const record of await this.#o.store.sessions.list({ closed: false })) {
      if (!record.cliTerminalId) continue;
      await this.#o.supervisor.restoreChatMode(record.id, CLI_MODE_RESTART_LABEL);
      await this.#o.hooks.released(record.id, record.claudeSessionId);
      count += 1;
    }
    return count;
  }
}
