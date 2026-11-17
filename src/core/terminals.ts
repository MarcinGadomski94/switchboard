/**
 * D170 · Terminals (`docs/terminals.md`): a real shell (PowerShell, cmd, bash, zsh, …) in a
 * pseudo-terminal on this computer or a paired one, shown in the browser. This module is the
 * part both sides share: the shells, the socket's frames (JSON text frames, checked on the way
 * in), the limits and the environment a terminal gets (Switchboard's own secrets removed).
 *
 * Phase 2 (the agents' CLI tab) hosts an interactive `claude --resume <id>` in the same terminal
 * layer: the service takes any argv, so a terminal is "a program in a pseudo-terminal", a shell
 * being the common case.
 */

/** The shells a terminal can start (`default`: PowerShell on Windows, the login shell elsewhere). */
export const TERMINAL_SHELLS = ['default', 'pwsh', 'powershell', 'cmd', 'bash', 'zsh', 'sh'] as const;
/** One of {@link TERMINAL_SHELLS}. */
export type TerminalShell = (typeof TERMINAL_SHELLS)[number];

/** How many terminals may be open on one computer at once. */
export const TERMINAL_MAX_OPEN = 16;
/** How much of a terminal's latest output is kept for a client that (re)attaches (bytes of text). */
export const TERMINAL_SCROLLBACK_CHARS = 256 * 1024;
/** A terminal nobody has attached to for this many hours is closed (the default of `terminals.idleHours`; 0 = never). */
export const TERMINAL_IDLE_DEFAULT_HOURS = 12;
/** The bounds of `terminals.idleHours`. */
export const TERMINAL_IDLE_MAX_HOURS = 168;
/** {@link TERMINAL_IDLE_DEFAULT_HOURS} in ms. */
export const TERMINAL_IDLE_MS = TERMINAL_IDLE_DEFAULT_HOURS * 3600_000;

/** The stored `terminals.idleHours` read defensively (the default for anything else). */
export function terminalIdleHours(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= TERMINAL_IDLE_MAX_HOURS ? value : TERMINAL_IDLE_DEFAULT_HOURS;
}
/** The largest input frame a client may send (characters). */
export const TERMINAL_INPUT_MAX = 64 * 1024;
/** Columns / rows a terminal may have. */
export const TERMINAL_SIZE_MIN = 2;
export const TERMINAL_SIZE_MAX = 1000;

/** A terminal as the API lists it. */
export interface TerminalInfo {
  readonly id: string;
  /** What it runs, for its title ("PowerShell", "zsh", …). */
  readonly title: string;
  readonly shell: TerminalShell | 'program';
  /** The folder it started in. */
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly createdAt: string;
  /** The last input or output (ISO). */
  readonly lastActiveAt: string;
  /** How many browser tabs / phones are attached now. */
  readonly clients: number;
  /** `null` while it runs; its end when the program exited (the terminal stays listed until closed). */
  readonly exited: { readonly code: number | null; readonly signal: number | null } | null;
}

/** `GET /api/terminals`: this computer's terminals of the request's profile, and what a new one may use. */
export interface TerminalsView {
  readonly terminals: readonly TerminalInfo[];
  /** The shells this computer has (the first is the default). */
  readonly shells: ReadonlyArray<{ readonly id: TerminalShell; readonly label: string }>;
  /** The home folder (always allowed as a start folder). */
  readonly home: string;
  readonly max: number;
}

/** What the browser sends on the socket. */
export type TerminalClientFrame =
  | { readonly t: 'in'; readonly d: string }
  | { readonly t: 'resize'; readonly cols: number; readonly rows: number };

/** What the server sends on the socket. */
export type TerminalServerFrame =
  /** First frame: the terminal and its recent output (replayed so a reload sees where it was). */
  | { readonly t: 'hello'; readonly info: TerminalInfo; readonly scrollback: string }
  | { readonly t: 'out'; readonly d: string }
  | { readonly t: 'exit'; readonly code: number | null; readonly signal: number | null }
  /** The terminal was closed (by Close, the idle limit or Switchboard stopping): the socket ends. */
  | { readonly t: 'closed'; readonly reason: 'closed' | 'idle' | 'stopping' };

function sizeOk(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= TERMINAL_SIZE_MIN && value <= TERMINAL_SIZE_MAX;
}

/** A client frame read defensively; `null` for anything malformed or too big (it is dropped). */
export function parseClientFrame(text: string): TerminalClientFrame | null {
  if (text.length > TERMINAL_INPUT_MAX + 64) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Record<string, unknown>;
  if (frame['t'] === 'in' && typeof frame['d'] === 'string' && frame['d'].length <= TERMINAL_INPUT_MAX) return { t: 'in', d: frame['d'] };
  if (frame['t'] === 'resize' && sizeOk(frame['cols']) && sizeOk(frame['rows'])) return { t: 'resize', cols: frame['cols'], rows: frame['rows'] };
  return null;
}

/** A start size read defensively (the default 80 × 24 when absent or out of range). */
export function terminalSize(cols: unknown, rows: unknown): { readonly cols: number; readonly rows: number } {
  return { cols: sizeOk(cols) ? cols : 80, rows: sizeOk(rows) ? rows : 24 };
}

/**
 * Names Switchboard never passes into a terminal: everything `SWITCHBOARD_*` (its data folder,
 * port, test and internal switches, the D127 session marker `SWITCHBOARD_SESSION`, …), and what the
 * launcher added to Switchboard's own process (`npm_*` when started through npm, Vitest's). The
 * user's own variables (a `GITHUB_TOKEN` they exported, …) stay: it is their shell. The install
 * token and the hook token are files, never environment variables.
 */
const SCRUBBED = [/^SWITCHBOARD_/i, /^npm_/i, /^VITEST/i, /^__VITEST/i];

/**
 * The environment of a new terminal: the computer's own, minus {@link SCRUBBED} (so no
 * Switchboard token or internal ever reaches a shell), plus a colour terminal type.
 */
export function terminalEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SCRUBBED.some((pattern) => pattern.test(name))) continue;
    env[name] = value;
  }
  env['TERM'] = 'xterm-256color';
  env['COLORTERM'] = 'truecolor';
  return env;
}

/** A shell's label in the UI. */
export function shellLabel(shell: TerminalShell, platform: string): string {
  switch (shell) {
    case 'pwsh':
      return 'PowerShell 7';
    case 'powershell':
      return 'Windows PowerShell';
    case 'cmd':
      return 'Command Prompt';
    case 'bash':
      return 'bash';
    case 'zsh':
      return 'zsh';
    case 'sh':
      return 'sh';
    default:
      return platform === 'win32' ? 'PowerShell' : 'Login shell';
  }
}
