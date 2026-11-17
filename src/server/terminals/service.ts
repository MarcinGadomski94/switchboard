import { randomUUID } from 'node:crypto';
import { access, constants } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TERMINAL_IDLE_MS,
  TERMINAL_MAX_OPEN,
  TERMINAL_SCROLLBACK_CHARS,
  type TerminalInfo,
  type TerminalServerFrame,
  type TerminalShell,
  shellLabel,
  terminalEnv,
} from '../../core/terminals.ts';

/**
 * D170 · the terminals of this computer (`docs/terminals.md`): programs (a shell, or in phase 2
 * an agent's interactive CLI) running in a pseudo-terminal, each owned by the profile that opened
 * it (D165: strictly only mine), with any number of attached clients (browser tabs, a phone, a
 * paired computer's browser through the peer link), a scrollback replayed on attach, an idle
 * limit and a cap. Everything ends when Switchboard stops.
 */

/** The pseudo-terminal of one program (the subset of node-pty's `IPty` this service uses). */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** Starts a program in a pseudo-terminal. */
export type PtySpawner = (file: string, args: readonly string[], options: { cols: number; rows: number; cwd: string; env: Record<string, string>; name: string }) => PtyProcess;

/** Thrown for a refusal the routes answer with its status. */
export class TerminalError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TerminalError';
    this.status = status;
    this.code = code;
  }
}

/** One attached client (a socket). */
export interface TerminalClient {
  send(frame: TerminalServerFrame): void;
  close(): void;
}

/** What a terminal runs. */
export interface TerminalProgram {
  readonly file: string;
  readonly args: readonly string[];
  readonly title: string;
  readonly shell: TerminalShell | 'program';
}

interface Terminal {
  readonly id: string;
  /** Its profile (D172: re-keyed when that profile is merged into another). */
  owner: string | null;
  readonly program: TerminalProgram;
  readonly cwd: string;
  readonly createdAt: number;
  cols: number;
  rows: number;
  lastActiveAt: number;
  /** Since when no client has been attached (`null` while one is). */
  unattendedSince: number | null;
  pty: PtyProcess;
  scrollback: string;
  readonly clients: Set<TerminalClient>;
  exited: { code: number | null; signal: number | null } | null;
  readonly disposers: Array<{ dispose(): void }>;
  /** D171: told once when the program ends. */
  onEnd?: ((why: 'exited' | 'closed' | 'idle' | 'stopping') => void) | undefined;
}

/** Options of {@link TerminalService}. */
export interface TerminalServiceOptions {
  /** The pseudo-terminal (default: `@lydell/node-pty`, loaded on first use). */
  readonly spawn?: PtySpawner;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly maxOpen?: number;
  /** How long a terminal with no client attached lives (ms; 0 = forever). */
  readonly idleMs?: number | (() => Promise<number> | number);
  readonly scrollbackChars?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

let defaultSpawner: PtySpawner | null = null;

/** node-pty, loaded lazily (a computer without its native binary still starts; terminals then say why). */
async function loadSpawner(): Promise<PtySpawner> {
  if (defaultSpawner) return defaultSpawner;
  const pty = (await import('@lydell/node-pty')) as unknown as { spawn: (file: string, args: string[], options: Record<string, unknown>) => PtyProcess };
  defaultSpawner = (file, args, options) => pty.spawn(file, [...args], { ...options });
  return defaultSpawner;
}

/** `true` when `file` is an executable on `PATH` (or an absolute path that exists). */
async function onPath(file: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): Promise<string | null> {
  if (path.isAbsolute(file)) return access(file, constants.F_OK).then(() => file, () => null);
  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  const dirs = pathVar.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    if (await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return null;
}

/**
 * The program of a shell on this computer, `null` when it is not installed: Windows → PowerShell 7
 * (`pwsh`), else Windows PowerShell, else `cmd`; macOS / Linux → `$SHELL` (a login shell), else zsh,
 * bash, sh.
 */
export async function resolveShell(shell: TerminalShell, platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): Promise<TerminalProgram | null> {
  const program = async (name: string, args: string[], id: TerminalShell): Promise<TerminalProgram | null> => {
    const file = await onPath(name, env, platform);
    return file ? { file, args, title: shellLabel(id, platform), shell: id } : null;
  };
  if (platform === 'win32') {
    if (shell === 'pwsh') return program('pwsh.exe', ['-NoLogo'], 'pwsh');
    if (shell === 'powershell') return program('powershell.exe', ['-NoLogo'], 'powershell');
    if (shell === 'cmd') return program(env['ComSpec'] && path.isAbsolute(env['ComSpec']) ? env['ComSpec'] : 'cmd.exe', [], 'cmd');
    if (shell === 'bash') return program('bash.exe', ['--login'], 'bash');
    if (shell === 'default') return (await program('pwsh.exe', ['-NoLogo'], 'pwsh')) ?? (await program('powershell.exe', ['-NoLogo'], 'powershell')) ?? program('cmd.exe', [], 'cmd');
    return null;
  }
  if (shell === 'bash' || shell === 'zsh' || shell === 'sh') return program(shell, shell === 'sh' ? [] : ['-l'], shell);
  if (shell === 'pwsh') return program('pwsh', ['-NoLogo'], 'pwsh');
  if (shell === 'default') {
    const login = env['SHELL'];
    if (login && path.isAbsolute(login)) {
      const found = await onPath(login, env, platform);
      if (found) return { file: found, args: ['-l'], title: `${path.basename(found)} (login shell)`, shell: 'default' };
    }
    return (await program('zsh', ['-l'], 'zsh')) ?? (await program('bash', ['-l'], 'bash')) ?? program('sh', [], 'sh');
  }
  return null;
}

/** The shells this computer has, the default first. */
export async function availableShells(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): Promise<Array<{ id: TerminalShell; label: string }>> {
  const candidates: TerminalShell[] = platform === 'win32' ? ['pwsh', 'powershell', 'cmd', 'bash'] : ['zsh', 'bash', 'sh', 'pwsh'];
  const out: Array<{ id: TerminalShell; label: string }> = [{ id: 'default', label: shellLabel('default', platform) }];
  for (const shell of candidates) if (await resolveShell(shell, platform, env)) out.push({ id: shell, label: shellLabel(shell, platform) });
  return out;
}

/** See the module comment. */
export class TerminalService {
  readonly #o: TerminalServiceOptions;
  readonly #terminals = new Map<string, Terminal>();
  readonly #now: () => number;
  #sweep: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  constructor(options: TerminalServiceOptions = {}) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  get platform(): NodeJS.Platform {
    return this.#o.platform ?? process.platform;
  }

  get env(): Readonly<Record<string, string | undefined>> {
    return this.#o.env ?? process.env;
  }

  get home(): string {
    return this.#o.home ?? os.homedir();
  }

  get max(): number {
    return this.#o.maxOpen ?? TERMINAL_MAX_OPEN;
  }

  /** Starts the idle sweep (once a minute). */
  start(): void {
    if (this.#sweep) return;
    this.#sweep = setInterval(() => {
      void this.sweep().catch((error: unknown) => this.#o.onError?.(error));
    }, 60_000);
    this.#sweep.unref?.();
  }

  /** Closes the terminals nobody has attached to for the idle limit. */
  async sweep(): Promise<void> {
    const limit = typeof this.#o.idleMs === 'function' ? await this.#o.idleMs() : (this.#o.idleMs ?? TERMINAL_IDLE_MS);
    if (limit <= 0) return;
    const now = this.#now();
    for (const terminal of [...this.#terminals.values()]) {
      if (terminal.unattendedSince !== null && now - terminal.unattendedSince >= limit) this.#end(terminal, 'idle');
    }
  }

  /** D172: the open terminals of profile `from` now belong to `to` (a merge). */
  rekeyProfile(from: string, to: string): void {
    for (const terminal of this.#terminals.values()) if (terminal.owner === from) terminal.owner = to;
  }

  /** Whether scope `scope` sees terminal `terminal` (`'*'`: everything; else its own profile's). */
  #sees(scope: string | null, terminal: Terminal): boolean {
    if (scope === '*') return true;
    if (scope === null) return false;
    return terminal.owner === scope;
  }

  #info(terminal: Terminal): TerminalInfo {
    return {
      id: terminal.id,
      title: terminal.program.title,
      shell: terminal.program.shell,
      cwd: terminal.cwd,
      cols: terminal.cols,
      rows: terminal.rows,
      createdAt: new Date(terminal.createdAt).toISOString(),
      lastActiveAt: new Date(terminal.lastActiveAt).toISOString(),
      clients: terminal.clients.size,
      exited: terminal.exited,
    };
  }

  /** The terminals scope `scope` sees, newest first. */
  list(scope: string | null): TerminalInfo[] {
    return [...this.#terminals.values()].filter((terminal) => this.#sees(scope, terminal)).sort((a, b) => b.createdAt - a.createdAt).map((terminal) => this.#info(terminal));
  }

  /** A terminal scope `scope` sees, else 404. */
  get(scope: string | null, id: string): TerminalInfo {
    return this.#info(this.#own(scope, id));
  }

  #own(scope: string | null, id: string): Terminal {
    const terminal = this.#terminals.get(id);
    if (!terminal || !this.#sees(scope, terminal)) throw new TerminalError(404, 'not-found', `no terminal ${id}`);
    return terminal;
  }

  /**
   * Starts `program` in folder `cwd` (already checked by the caller) for profile `owner`.
   * @throws {TerminalError} 409 `too-many` at the cap, 503 `unavailable` when the pseudo-terminal cannot load or start.
   */
  async create(input: {
    readonly program: TerminalProgram;
    readonly cwd: string;
    readonly owner: string | null;
    readonly cols: number;
    readonly rows: number;
    readonly env?: Readonly<Record<string, string>>;
    /** D171: called once when the program ends (it exited, or the terminal was closed / swept / stopped). */
    readonly onEnd?: (why: 'exited' | 'closed' | 'idle' | 'stopping') => void;
  }): Promise<TerminalInfo> {
    if (this.#closed) throw new TerminalError(503, 'stopping', 'Switchboard is stopping');
    if (this.#terminals.size >= this.max) throw new TerminalError(409, 'too-many', `At most ${this.max} terminals can be open on this computer. Close one first.`);
    let spawn: PtySpawner;
    try {
      spawn = this.#o.spawn ?? (await loadSpawner());
    } catch (error) {
      throw new TerminalError(503, 'unavailable', `Terminals are not available on this computer: the pseudo-terminal could not load (${error instanceof Error ? error.message : String(error)}).`);
    }
    let pty: PtyProcess;
    try {
      pty = spawn(input.program.file, input.program.args, { cols: input.cols, rows: input.rows, cwd: input.cwd, env: { ...terminalEnv(this.env), ...(input.env ?? {}) }, name: 'xterm-256color' });
    } catch (error) {
      throw new TerminalError(503, 'unavailable', `${input.program.title} could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    const now = this.#now();
    const terminal: Terminal = { id: randomUUID(), owner: input.owner, program: input.program, cwd: input.cwd, createdAt: now, cols: input.cols, rows: input.rows, lastActiveAt: now, unattendedSince: now, pty, scrollback: '', clients: new Set(), exited: null, disposers: [], ...(input.onEnd ? { onEnd: input.onEnd } : {}) };
    const limit = this.#o.scrollbackChars ?? TERMINAL_SCROLLBACK_CHARS;
    terminal.disposers.push(
      pty.onData((data) => {
        terminal.lastActiveAt = this.#now();
        terminal.scrollback = (terminal.scrollback + data).slice(-limit);
        this.#broadcast(terminal, { t: 'out', d: data });
      }),
      pty.onExit((event) => {
        terminal.exited = { code: typeof event.exitCode === 'number' ? event.exitCode : null, signal: typeof event.signal === 'number' && event.signal !== 0 ? event.signal : null };
        this.#broadcast(terminal, { t: 'exit', code: terminal.exited.code, signal: terminal.exited.signal });
        this.#ended(terminal, 'exited');
      }),
    );
    this.#terminals.set(terminal.id, terminal);
    return this.#info(terminal);
  }

  #broadcast(terminal: Terminal, frame: TerminalServerFrame): void {
    for (const client of terminal.clients) {
      try {
        client.send(frame);
      } catch (error) {
        this.#o.onError?.(error);
      }
    }
  }

  /** Attaches `client` (it gets the terminal and its scrollback first); answers the detach. */
  attach(scope: string | null, id: string, client: TerminalClient): () => void {
    const terminal = this.#own(scope, id);
    terminal.clients.add(client);
    terminal.unattendedSince = null;
    client.send({ t: 'hello', info: this.#info(terminal), scrollback: terminal.scrollback });
    if (terminal.exited) client.send({ t: 'exit', code: terminal.exited.code, signal: terminal.exited.signal });
    return () => {
      terminal.clients.delete(client);
      if (terminal.clients.size === 0) terminal.unattendedSince = this.#now();
    };
  }

  /** Types `data` into terminal `id`. */
  input(scope: string | null, id: string, data: string): void {
    const terminal = this.#own(scope, id);
    if (terminal.exited) return;
    terminal.lastActiveAt = this.#now();
    terminal.pty.write(data);
  }

  /** Resizes terminal `id` (the last client to resize wins). */
  resize(scope: string | null, id: string, cols: number, rows: number): void {
    const terminal = this.#own(scope, id);
    if (terminal.exited || (terminal.cols === cols && terminal.rows === rows)) return;
    terminal.cols = cols;
    terminal.rows = rows;
    try {
      terminal.pty.resize(cols, rows);
    } catch (error) {
      this.#o.onError?.(error);
    }
  }

  /** Closes terminal `id`: ends its program (and what runs under it) and its clients' sockets. */
  close(scope: string | null, id: string): void {
    this.#end(this.#own(scope, id), 'closed');
  }

  #end(terminal: Terminal, reason: 'closed' | 'idle' | 'stopping'): void {
    if (!this.#terminals.delete(terminal.id)) return;
    this.#broadcast(terminal, { t: 'closed', reason });
    for (const client of terminal.clients) {
      try {
        client.close();
      } catch {
        // already gone
      }
    }
    terminal.clients.clear();
    for (const disposer of terminal.disposers) disposer.dispose();
    // D171: the reason first (an exit the kill causes is this end, not one of its own).
    this.#ended(terminal, reason);
    if (!terminal.exited) {
      try {
        terminal.pty.kill();
      } catch (error) {
        this.#o.onError?.(error);
      }
    }
  }

  /** D171: the terminal's `onEnd`, once. */
  #ended(terminal: Terminal, why: 'exited' | 'closed' | 'idle' | 'stopping'): void {
    const onEnd = terminal.onEnd;
    if (!onEnd) return;
    terminal.onEnd = undefined;
    try {
      onEnd(why);
    } catch (error) {
      this.#o.onError?.(error);
    }
  }

  /** D171: whether terminal `id` is open (any profile). */
  has(id: string): boolean {
    return this.#terminals.has(id);
  }

  /** D171: types `data` into terminal `id` regardless of profile (the agent's own CLI-mode terminal; Switchboard's own call). */
  write(id: string, data: string): void {
    const terminal = this.#terminals.get(id);
    if (!terminal || terminal.exited) return;
    terminal.pty.write(data);
  }

  /** D171: whether terminal `id`'s program has exited (or the terminal is gone). */
  exited(id: string): boolean {
    const terminal = this.#terminals.get(id);
    return !terminal || terminal.exited !== null;
  }

  /** D171: closes terminal `id` regardless of profile (Switchboard's own call: Back to chat mode). */
  closeAny(id: string): void {
    const terminal = this.#terminals.get(id);
    if (terminal) this.#end(terminal, 'closed');
  }

  /** Every terminal ends (Switchboard stops). */
  closeAll(): void {
    this.#closed = true;
    if (this.#sweep) clearInterval(this.#sweep);
    this.#sweep = null;
    for (const terminal of [...this.#terminals.values()]) this.#end(terminal, 'stopping');
  }
}
