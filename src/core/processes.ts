/**
 * D127 · the processes a session leaves running (`docs/processes.md`): the marker and the
 * build defaults Switchboard puts in every CLI's environment, how a process is named and
 * classified, the parsers of the OS listings, the tree tracking used where the environment
 * cannot be read (Windows, hooked terminal sessions), the auto-stop decision, the timeline
 * label, and the `process_keep` tool's definition. Pure: no I/O, the clock is passed in.
 */
import type { BackgroundTask, SessionActivity, SessionProcess, SessionProcessKind } from './api.ts';
import type { SessionStatus } from './model.ts';
import { backgroundWait, isLongRunningCommand } from './derive/background.ts';

/** The variable every CLI Switchboard spawns carries (its session's id); descendants inherit it, also once they detach. */
export const SESSION_MARKER_ENV = 'SWITCHBOARD_SESSION';

/**
 * D127 decision 1: what every CLI Switchboard spawns gets in its environment, so the .NET
 * builds its agents run leave no build servers behind:
 * - `MSBUILDDISABLENODEREUSE=1`: MSBuild's worker nodes exit with the build (no `/nodeReuse:true` nodes);
 * - `DOTNET_CLI_USE_MSBUILD_SERVER=0`: no MSBuild server process (.NET 7+);
 * - `UseSharedCompilation=false`: MSBuild reads every environment variable as a property, and this
 *   property makes the Csc / Vbc tasks compile in-process instead of through the Roslyn compiler
 *   server (`VBCSCompiler`), which otherwise lingers for minutes after the last build.
 * The trade-off: builds are slower (every build starts its nodes and loads the compiler afresh).
 */
export const AGENT_BUILD_ENV: Readonly<Record<string, string>> = {
  MSBUILDDISABLENODEREUSE: '1',
  DOTNET_CLI_USE_MSBUILD_SERVER: '0',
  UseSharedCompilation: 'false',
};

/** The environment a session's CLI gets on top of its base environment: the build defaults and the marker. */
export function sessionProcessEnv(sessionId: string): Record<string, string> {
  return { ...AGENT_BUILD_ENV, [SESSION_MARKER_ENV]: sessionId };
}

/** How often the processes are sampled. */
export const PROCESS_SAMPLE_MS = 30_000;

/** How long a stopped process gets after SIGTERM (`taskkill /T`) before SIGKILL (`/F`). */
export const PROCESS_STOP_GRACE_MS = 5_000;

/** The idle delay's default (Settings → Processes; `processes.idleStopMinutes`). */
export const IDLE_STOP_DEFAULT_MINUTES = 10;

/** The idle delay's bounds (whole minutes; 0 = the idle stop is off). */
export const IDLE_STOP_MIN_MINUTES = 0;
export const IDLE_STOP_MAX_MINUTES = 1_440;

/** The longest command line kept for display. */
export const PROCESS_COMMAND_MAX = 300;

// ── naming and classification ─────────────────────────────────────────────

const BUILD_SERVER = [
  // MSBuild worker nodes kept for reuse, and the MSBuild server.
  /MSBuild(?:\.dll|\.exe)?\b[^\n]*[/-]nodemode:\d/i,
  /[/-]nodeReuse:true\b/i,
  // The Roslyn compiler server.
  /\bVBCSCompiler\b/i,
  // The Razor build server.
  /\brzc\.dll\b[^\n]*\bserver\b/i,
  /\bdotnet(?:\.exe)?\s+build-server\b/i,
];

const TEST_HOST = [
  /\btesthost(?:\.[\w-]+)*(?:\.exe|\.dll)?\b/i,
  /\bvstest\.console\b/i,
  /\bdotnet(?:\.exe)?\s+(?:test|vstest)\b/i,
  /\b(?:vitest|jest)\b(?![\w.-]*\.config)/i,
  /\bplaywright(?:\.\w+)?\s+test\b/i,
  /\bpytest\b/i,
];

/**
 * What a process is (D127): `build-server` (MSBuild nodes kept for reuse, the MSBuild server,
 * `VBCSCompiler`, the Razor server, `dotnet build-server`), `test-host` (vstest, testhost,
 * `dotnet test`, vitest / jest / playwright test / pytest), `dev-server` (the 2026-10-16
 * long-running commands of `derive/background.ts`: `dotnet run` / `watch`, `npm run dev`, `vite`, …)
 * or `other`.
 */
export function classifyProcess(command: string): SessionProcessKind {
  if (BUILD_SERVER.some((pattern) => pattern.test(command))) return 'build-server';
  if (TEST_HOST.some((pattern) => pattern.test(command))) return 'test-host';
  if (isLongRunningCommand(command)) return 'dev-server';
  return 'other';
}

/** The base name of a path (either separator), without `.exe`. */
function baseName(value: string): string {
  const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return value.slice(cut + 1).replace(/\.exe$/i, '');
}

/** Splits a command line into words (double-quoted parts kept whole; good enough for display). */
function words(command: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (let match = pattern.exec(command); match; match = pattern.exec(command)) out.push(match[1] ?? match[2] ?? '');
  return out;
}

const RUNNERS = new Set(['node', 'dotnet', 'python', 'python3', 'bun', 'deno', 'ruby', 'java']);
const PACKAGE_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'yarn']);

/** A short name for a process: what it is for the known kinds, else its program (plus the script a runner runs). */
export function processName(command: string): string {
  if (/MSBuild(?:\.dll|\.exe)?\b[^\n]*[/-]nodemode:\d/i.test(command)) return 'MSBuild node';
  if (/\bVBCSCompiler\b/i.test(command)) return 'VBCSCompiler';
  if (/\brzc\.dll\b/i.test(command)) return 'Razor build server';
  if (/\bvstest\.console\b/i.test(command)) return 'vstest.console';
  if (/\btesthost/i.test(command)) return 'testhost';
  const parts = words(command.trim());
  const program = baseName(parts[0] ?? '');
  if (program === '') return 'process';
  if (PACKAGE_MANAGERS.has(program)) return [program, ...parts.slice(1, 3)].join(' ');
  if (RUNNERS.has(program)) {
    // `node -e <code>`, `python -c <code>`: the code is no name.
    const inline = parts.slice(1).find((part) => part === '-e' || part === '--eval' || part === '-c' || part === '-p');
    if (inline !== undefined) return `${program} ${inline}`;
    const args = parts.slice(1).filter((part) => !part.startsWith('-'));
    const first = args[0];
    if (first === undefined) return program;
    // `dotnet test`, `dotnet watch`: a verb; `node …/vite.js`, `dotnet App.dll`: a script.
    return /[/\\.]/.test(first) ? `${program} ${baseName(first)}` : `${program} ${first}`;
  }
  return program;
}

/** A command line for display: the home folder as `~`, cut to {@link PROCESS_COMMAND_MAX} characters. */
export function shortCommand(command: string, home: string | null): string {
  let text = command.replace(/\s+/g, ' ').trim();
  if (home && home.length > 1) text = text.split(home).join('~');
  return text.length > PROCESS_COMMAND_MAX ? `${text.slice(0, PROCESS_COMMAND_MAX - 1)}…` : text;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'cmd', 'powershell', 'pwsh']);

/** `true` for a shell (a CLI's tool runs its commands in one: those are the agent's work, not the CLI's own helpers). */
export function isShellCommand(command: string): boolean {
  const first = words(command.trim())[0] ?? '';
  return SHELLS.has(baseName(first).replace(/^-/, '').toLowerCase());
}

/** Switchboard's own MCP helpers (the built-in `switchboard` server, D100-T2's access server): never listed. */
export function isSwitchboardHelper(command: string): boolean {
  return /\bsb-(?:access-)?mcp(?:\.ts|\.js|\.mjs|\.cjs)?\b|--switchboard-mcp\b/.test(command);
}

// ── the OS listings ──────────────────────────────────────────────────────

/** One process as a listing gives it. */
export interface ListedProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
  /** When it started (epoch ms; from its elapsed time on macOS / Linux: second precision). */
  readonly startedAtMs: number;
  /** CPU % as `ps` reports it (lifetime average on macOS / Linux), `null` where it is not read. */
  readonly cpuPct: number | null;
  readonly command: string;
  /** The session id of its {@link SESSION_MARKER_ENV}, `null` without one (or where the environment is not read). */
  readonly marker: string | null;
}

/** `ps`'s elapsed time (`[[dd-]hh:]mm:ss`) in seconds; `null` when it is not one. */
export function parseEtime(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

const MARKER = new RegExp(String.raw`(?:^|\s)${SESSION_MARKER_ENV}=([A-Za-z0-9._~-]{1,128})(?=\s|$)`, 'g');

/** The marker's value in a text of `KEY=value` words (the last one wins: the environment comes after the arguments), else `null`. */
export function markerIn(text: string): string | null {
  let found: string | null = null;
  for (const match of text.matchAll(MARKER)) found = match[1] ?? found;
  return found;
}

/** The marker's value in a NUL-separated environment block (`/proc/<pid>/environ`), else `null`. */
export function markerInEnviron(block: string): string | null {
  const prefix = `${SESSION_MARKER_ENV}=`;
  for (const entry of block.split('\0')) if (entry.startsWith(prefix)) return entry.slice(prefix.length) || null;
  return null;
}

/**
 * Parses `ps -o pid=,ppid=,rss=,etime=,pcpu=,command=` lines (with `-E` on macOS the
 * environment follows the command on the same line): rows whose text names the marker
 * when `withEnv`, every row otherwise (marker `null`). RSS is in KB.
 */
export function parsePsListing(text: string, nowMs: number, withEnv: boolean): ListedProcess[] {
  const rows: ListedProcess[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.,]+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const seconds = parseEtime(match[4] as string) ?? (/^\d+$/.test(match[4] as string) ? Number(match[4]) : null);
    if (seconds === null) continue;
    const rest = (match[6] as string).trimEnd();
    const marker = withEnv ? markerIn(rest) : null;
    if (withEnv && marker === null) continue;
    const cpu = Number((match[5] as string).replace(',', '.'));
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      startedAtMs: nowMs - seconds * 1000,
      cpuPct: Number.isFinite(cpu) ? cpu : null,
      command: rest,
      marker,
    });
  }
  return rows;
}

/** Parses `ps -o pid=,command=` lines: pid → command. */
export function parsePsCommands(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) out.set(Number(match[1]), (match[2] as string).trimEnd());
  }
  return out;
}

/**
 * Parses the PowerShell listing (`Get-CimInstance Win32_Process`, `ConvertTo-Json -Compress`) the
 * Windows scanner runs: `ProcessId`, `ParentProcessId`, `Created` (epoch ms, computed in PowerShell),
 * `WorkingSetSize`, `Name`, `CommandLine`. A single object (one process) is accepted too; anything
 * malformed is skipped. No environment: marker `null`.
 */
export function parseWin32Processes(json: string): ListedProcess[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.trim() || '[]');
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const rows: ListedProcess[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const pid = row['ProcessId'];
    const ppid = row['ParentProcessId'];
    const created = parseWinDate(row['Created'] ?? row['CreationDate']);
    if (typeof pid !== 'number' || typeof ppid !== 'number' || created === null) continue;
    const name = typeof row['Name'] === 'string' ? row['Name'] : '';
    const command = typeof row['CommandLine'] === 'string' && row['CommandLine'].trim() !== '' ? row['CommandLine'] : name;
    const rss = typeof row['WorkingSetSize'] === 'number' ? row['WorkingSetSize'] : Number(row['WorkingSetSize'] ?? 0);
    rows.push({ pid, ppid, rssBytes: Number.isFinite(rss) ? rss : 0, startedAtMs: created, cpuPct: null, command, marker: null });
  }
  return rows;
}

/** A Windows creation time: epoch ms, `/Date(ms)/` (Windows PowerShell 5.1's JSON) or an ISO string; else `null`. */
function parseWinDate(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const legacy = /\/Date\((-?\d+)(?:[+-]\d+)?\)\//.exec(value);
  if (legacy) return Number(legacy[1]);
  const iso = Date.parse(value);
  return Number.isNaN(iso) ? null : iso;
}

// ── the tree (Windows, hooked sessions) ──────────────────────────────────

/** A process known by pid and start (a pid alone may be reused). */
export interface KnownProcess {
  readonly pid: number;
  readonly startedAtMs: number;
}

/** How far apart two readings of one process's start may be (ps's elapsed time has second precision). */
export const START_TOLERANCE_MS = 2_000;

/** `true` when `row` is the process `known` remembers (same pid, same start within the tolerance). */
export function sameProcess(row: Pick<ListedProcess, 'pid' | 'startedAtMs'>, known: KnownProcess): boolean {
  return row.pid === known.pid && Math.abs(row.startedAtMs - known.startedAtMs) <= START_TOLERANCE_MS;
}

/**
 * The tree of a session where the environment cannot be read: the processes started under
 * its CLI (`roots`) and under any process already known, kept after their parent exits
 * (a detached build node), with the guard against reused pids (a child must have started
 * after its parent; a known pid must still have its start). Returns the known set now.
 */
export function advanceTree(known: readonly KnownProcess[], rows: readonly ListedProcess[], roots: readonly KnownProcess[]): KnownProcess[] {
  const byPid = new Map(rows.map((row) => [row.pid, row] as const));
  const current = new Map<number, KnownProcess>();
  for (const entry of [...roots, ...known]) {
    const row = byPid.get(entry.pid);
    if (row && sameProcess(row, entry)) current.set(entry.pid, { pid: row.pid, startedAtMs: row.startedAtMs });
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (current.has(row.pid)) continue;
      const parent = current.get(row.ppid);
      if (parent && row.startedAtMs + START_TOLERANCE_MS >= parent.startedAtMs) {
        current.set(row.pid, { pid: row.pid, startedAtMs: row.startedAtMs });
        grew = true;
      }
    }
  }
  return [...current.values()];
}

/**
 * The processes of one session worth listing, from its rows (every process that carries its
 * marker or is in its tree, the CLI itself included): never the CLI (`rootPid`), never
 * Switchboard's own MCP helpers, and, while the CLI runs, never its own helpers (a direct
 * child that is not a shell, e.g. an MCP server, with what runs under it): those end with
 * the CLI. A shell under such a helper is the agent's work again (a CLI launched through a
 * launcher runs its tools' shells one level down). What the agent's commands started (under a
 * shell, or detached) stays.
 */
export function sessionLeftovers(rows: readonly ListedProcess[], rootPid: number | null): ListedProcess[] {
  const rootAlive = rootPid !== null && rows.some((row) => row.pid === rootPid);
  const excluded = new Set<number>();
  if (rootPid !== null) excluded.add(rootPid);
  for (const row of rows) if (isSwitchboardHelper(row.command)) excluded.add(row.pid);
  if (rootAlive) for (const row of rows) if (row.ppid === rootPid && !isShellCommand(row.command)) excluded.add(row.pid);
  // Everything under an excluded process (an MCP server's own children, a helper's).
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!excluded.has(row.pid) && excluded.has(row.ppid) && row.ppid !== rootPid && !isShellCommand(row.command)) {
        excluded.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => !excluded.has(row.pid));
}

/** `true` when `pid` runs under `rootPid` (its parent chain in `rows` reaches it). */
export function descendsFrom(rows: readonly Pick<ListedProcess, 'pid' | 'ppid'>[], pid: number, rootPid: number | null): boolean {
  if (rootPid === null) return false;
  const byPid = new Map(rows.map((row) => [row.pid, row.ppid] as const));
  const seen = new Set<number>();
  let current = byPid.get(pid);
  while (current !== undefined && !seen.has(current)) {
    if (current === rootPid) return true;
    seen.add(current);
    current = byPid.get(current);
  }
  return false;
}

/**
 * Whether the automatic stop may take a leftover: a detached one (or any once the CLI is gone)
 * always; one still under the running CLI only when it is a build server, a test host or a dev
 * server, so an `other` process there (an MCP server the CLI started through a shell, say) is
 * listed but only ever stopped by hand.
 */
export function autoStoppable(kind: SessionProcessKind, underLiveCli: boolean): boolean {
  return !underLiveCli || kind !== 'other';
}

/** The pids of `pid` and everything under it in `rows`, `pid` first. */
export function subtreeOf(rows: readonly Pick<ListedProcess, 'pid' | 'ppid'>[], pid: number): number[] {
  const out = [pid];
  for (let i = 0; i < out.length; i++) for (const row of rows) if (row.ppid === out[i] && !out.includes(row.pid)) out.push(row.pid);
  return out;
}

// ── auto-stop ────────────────────────────────────────────────────────────

/** Why Switchboard stops a session's processes by itself. */
export type AutoStopReason = 'closed' | 'idle';

/**
 * `true` while a session works by the 1.23 rules: its status is `run` (a turn, subagents, a
 * background task it waits on), a turn runs (also one waiting on a question mid-turn), or a
 * pending background task is one it waits on.
 */
export function sessionWorking(status: SessionStatus, activity: Pick<SessionActivity, 'state' | 'background'> | null): boolean {
  if (status === 'run') return true;
  if (activity && activity.state !== 'background') return true;
  return backgroundWait(activity as { state: SessionActivity['state']; background: readonly BackgroundTask[] } | null) !== null;
}

/** Input of {@link autoStopReason}. */
export interface AutoStopInput {
  readonly closed: boolean;
  readonly working: boolean;
  /** Since when the session has not worked (epoch ms), `null` when unknown. */
  readonly idleSinceMs: number | null;
  readonly nowMs: number;
  /** The idle delay (ms); 0 = the idle stop is off. */
  readonly delayMs: number;
}

/**
 * D127: whether a session's leftover processes are stopped now, and why: never while it
 * works (or waits on a background task); `closed` at once; `idle` once it has been idle for
 * the delay (never with the delay 0). The processes marked Keep are left out by the caller.
 */
export function autoStopReason(input: AutoStopInput): AutoStopReason | null {
  if (input.working) return null;
  if (input.closed) return 'closed';
  if (input.delayMs <= 0 || input.idleSinceMs === null) return null;
  return input.nowMs - input.idleSinceMs >= input.delayMs ? 'idle' : null;
}

/** When an idle session's processes are due to stop (epoch ms), `null` when they are not (working, delay off, unknown). */
export function autoStopAt(input: Omit<AutoStopInput, 'nowMs' | 'closed'>): number | null {
  if (input.working || input.delayMs <= 0 || input.idleSinceMs === null) return null;
  return input.idleSinceMs + input.delayMs;
}

/** The processes an automatic stop takes: every one not marked Keep. */
export function processesToStop<T extends Pick<SessionProcess, 'keep'>>(processes: readonly T[]): T[] {
  return processes.filter((process) => !process.keep);
}

// ── labels ───────────────────────────────────────────────────────────────

/** A memory size: `850 MB`, `1.9 GB`. */
export function memoryLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

const KIND_WORDS: { readonly [K in SessionProcessKind]: readonly [one: string, many: string] } = {
  'build-server': ['build server', 'build servers'],
  'test-host': ['test host', 'test hosts'],
  'dev-server': ['dev server', 'dev servers'],
  other: ['other process', 'other processes'],
};

/** What a kind reads as (`build server`). */
export function kindLabel(kind: SessionProcessKind): string {
  return KIND_WORDS[kind][0];
}

/** `6 build servers`, `6 build servers and 1 test host`, `2 build servers, 1 test host and 1 other process`. */
export function countsLabel(processes: readonly Pick<SessionProcess, 'kind'>[]): string {
  const order: SessionProcessKind[] = ['build-server', 'test-host', 'dev-server', 'other'];
  const parts: string[] = [];
  for (const kind of order) {
    const n = processes.filter((process) => process.kind === kind).length;
    if (n === 0) continue;
    const [one, many] = KIND_WORDS[kind];
    // A lone "other" kind reads as "processes", not "other processes".
    const word = kind === 'other' && parts.length === 0 && processes.every((process) => process.kind === 'other') ? (n === 1 ? 'process' : 'processes') : n === 1 ? one : many;
    parts.push(`${n} ${word}`);
  }
  if (parts.length <= 1) return parts[0] ?? '0 processes';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Why the stop happened, for the label. */
export type StopCause = { readonly kind: 'idle'; readonly minutes: number } | { readonly kind: 'closed' } | { readonly kind: 'developer' };

/** The timeline's line of a stop: "Stopped 6 build servers (1.9 GB) after 10 min idle". */
export function stoppedLabel(processes: readonly Pick<SessionProcess, 'kind' | 'rssBytes'>[], cause: StopCause): string {
  const bytes = processes.reduce((sum, process) => sum + process.rssBytes, 0);
  const why = cause.kind === 'idle' ? ` after ${cause.minutes} min idle` : cause.kind === 'closed' ? ' when the session was closed' : ' (Stop in Processes)';
  return `Stopped ${countsLabel(processes)} (${memoryLabel(bytes)})${why}`;
}
