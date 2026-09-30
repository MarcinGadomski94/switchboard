import { randomUUID } from 'node:crypto';
import { parseStreamLine } from '../../core/stream-json.ts';
import { initializeLine } from '../../core/stdin.ts';
import { ClaudeProcess } from '../supervisor/process.ts';

/**
 * D61: the argv of the short-lived MCP helper (after the CLI command): the usage
 * poller's (`docs/usage.md`): stream-json in and out, no prompt, no session id. With
 * no user message the CLI makes no model call and writes no transcript; the MCP
 * control requests (`mcp_status`, `mcp_reconnect`, `mcp_toggle`,
 * `mcp_authenticate`, `mcp_oauth_callback_url`, `mcp_clear_auth`) are answered
 * without a turn (`docs/mcp.md` → *The helper process*).
 */
export const MCP_HELPER_ARGS: readonly string[] = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'];

/** A control request's outcome. */
export type ControlOutcome = { readonly ok: true; readonly response: Record<string, unknown> | null } | { readonly ok: false; readonly error: string };

/** Options for {@link McpHelper.start}. */
export interface McpHelperOptions {
  readonly claudeCommand: readonly string[];
  readonly extraArgs?: readonly string[];
  /** The folder: the CLI loads that folder's project and local servers. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/** How long the helper gets after EOF before it is stopped. */
const EXIT_GRACE_MS = 3_000;
const KILL_GRACE_MS = 2_000;

/**
 * One `claude -p --input-format stream-json` process in a folder, driven only by
 * control requests. {@link close} ends it (EOF, then SIGTERM, then SIGKILL): every
 * helper is closed by the code that started it, also on errors and timeouts.
 */
export class McpHelper {
  readonly #proc: ClaudeProcess;
  readonly #pending = new Map<string, (outcome: ControlOutcome) => void>();
  #closed = false;

  private constructor(options: McpHelperOptions) {
    this.#proc = new ClaudeProcess({
      command: options.claudeCommand,
      args: [...MCP_HELPER_ARGS, ...(options.extraArgs ?? [])],
      cwd: options.cwd,
      env: options.env,
      onLine: (line) => this.#onLine(line),
    });
    void this.#proc.exited.then((exit) => {
      const why = exit.spawnError
        ? `could not start claude: ${exit.spawnError.message}`
        : `claude exited (${exit.signal ? `signal ${exit.signal}` : `code ${String(exit.code)}`})${this.#stderrLine()}`;
      for (const resolve of this.#pending.values()) resolve({ ok: false, error: why });
      this.#pending.clear();
    });
  }

  /** Starts a helper and sends `initialize` (no model call). */
  static async start(options: McpHelperOptions, timeoutMs = 30_000): Promise<McpHelper> {
    const helper = new McpHelper(options);
    const init = await helper.#send(initializeLine(`sb-mcp-${randomUUID()}`), timeoutMs);
    if (!init.ok) {
      await helper.close();
      throw new Error(init.error);
    }
    return helper;
  }

  /** `true` until the process ended. */
  get running(): boolean {
    return this.#proc.running;
  }

  /** Sends one control request (`subtype` + fields) and waits up to `timeoutMs` for its answer. */
  request(subtype: string, fields: Readonly<Record<string, unknown>> = {}, timeoutMs = 30_000): Promise<ControlOutcome> {
    return this.#send({ type: 'control_request', request_id: `sb-mcp-${randomUUID()}`, request: { subtype, ...fields } }, timeoutMs);
  }

  #send(line: { readonly type: string; readonly request_id: string; readonly request: object }, timeoutMs: number): Promise<ControlOutcome> {
    if (this.#closed || !this.#proc.running) return Promise.resolve({ ok: false, error: 'the helper process has ended' });
    return new Promise<ControlOutcome>((resolve) => {
      const id = line.request_id;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ ok: false, error: `claude did not answer in ${Math.round(timeoutMs / 1000)} s` });
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
      if (!this.#proc.write(line)) {
        this.#pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: 'the helper process has ended' });
      }
    });
  }

  #onLine(line: string): void {
    const message = parseStreamLine(line);
    if (message.kind !== 'control-response') return;
    const resolve = this.#pending.get(message.requestId);
    if (!resolve) return;
    this.#pending.delete(message.requestId);
    if (message.subtype === 'success') resolve({ ok: true, response: message.response });
    else resolve({ ok: false, error: message.error ?? 'the request failed' });
  }

  #stderrLine(): string {
    const last = this.#proc.stderrTail().trim().split('\n').pop() ?? '';
    return last ? `: ${last}` : '';
  }

  /** Ends the process: EOF, then SIGTERM / SIGKILL if it does not exit. Idempotent. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#proc.endInput();
    if (await this.#proc.waitForExit(EXIT_GRACE_MS)) return;
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      this.#proc.kill(signal);
      if (await this.#proc.waitForExit(KILL_GRACE_MS)) return;
    }
  }
}
