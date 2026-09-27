import { type ChildProcess, spawn } from 'node:child_process';
import { LineSplitter } from '../../core/stream-json.ts';

/** How a process ended. */
export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Set when the process could not be started (e.g. `ENOENT` for a missing CLI). */
  readonly spawnError: Error | null;
}

/** Options for {@link ClaudeProcess}. */
export interface ClaudeProcessOptions {
  /** Argv prefix of the CLI (`SWITCHBOARD_CLAUDE_BIN`), e.g. `["claude"]` or `[node, fake-claude/main.ts]`. */
  readonly command: readonly string[];
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Called with every complete stdout line, in order. */
  readonly onLine: (line: string) => void;
}

/** Bytes of stderr kept for failure reports. */
const STDERR_TAIL = 8_192;

/**
 * One `claude` child process: spawned with an argv array and `shell: false`, stdin
 * kept open, stdout split into lines. `exited` resolves once the process has ended
 * **and** its stdout has been drained, so every line reaches `onLine` first.
 */
export class ClaudeProcess {
  readonly #child: ChildProcess;
  readonly #exited: Promise<ProcessExit>;
  #stderr = '';
  #ended = false;
  #inputClosed = false;

  constructor(options: ClaudeProcessOptions) {
    const [cmd, ...prefix] = options.command;
    if (!cmd) throw new Error('empty CLI command');
    const child = spawn(cmd, [...prefix, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;
    const splitter = new LineSplitter(options.onLine);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => splitter.push(chunk));
    child.stdout?.on('end', () => splitter.flush());
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL);
    });
    // A child that exits while we write must not crash the service (EPIPE).
    child.stdin?.on('error', () => undefined);
    this.#exited = new Promise<ProcessExit>((resolve) => {
      let settled = false;
      const settle = (exit: ProcessExit): void => {
        if (settled) return;
        settled = true;
        this.#ended = true;
        this.#inputClosed = true;
        splitter.flush();
        resolve(exit);
      };
      child.once('error', (error: Error) => {
        // Only a failed spawn has no pid; later errors (a failed kill) are not an exit.
        if (child.pid === undefined) setImmediate(() => settle({ code: null, signal: null, spawnError: error }));
      });
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => settle({ code, signal, spawnError: null }));
    });
  }

  /** The child's pid, `null` when it could not be started. */
  get pid(): number | null {
    return this.#child.pid ?? null;
  }

  /** `true` until the process has ended. */
  get running(): boolean {
    return !this.#ended;
  }

  /** `true` once stdin was closed (or the process ended). */
  get inputClosed(): boolean {
    return this.#inputClosed;
  }

  /** Resolves when the process has ended and stdout is drained. */
  get exited(): Promise<ProcessExit> {
    return this.#exited;
  }

  /** The last few KB of stderr. */
  stderrTail(): string {
    return this.#stderr;
  }

  /** Writes `line` as one JSON line to stdin; `false` when stdin is already closed. */
  write(line: object): boolean {
    if (this.#inputClosed || !this.#child.stdin || this.#child.stdin.destroyed) return false;
    this.#child.stdin.write(`${JSON.stringify(line)}\n`);
    return true;
  }

  /** Closes stdin (EOF): the running turn finishes, then the CLI exits. */
  endInput(): void {
    if (this.#inputClosed) return;
    this.#inputClosed = true;
    this.#child.stdin?.end();
  }

  /** Sends `signal`; `false` when the process has already ended. */
  kill(signal: NodeJS.Signals): boolean {
    if (this.#ended) return false;
    return this.#child.kill(signal);
  }

  /** Resolves `true` if the process ends within `ms`, else `false`. */
  async waitForExit(ms: number): Promise<boolean> {
    if (this.#ended) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const ended = await Promise.race([this.#exited.then(() => true as const), timeout]);
    clearTimeout(timer);
    return ended;
  }
}
