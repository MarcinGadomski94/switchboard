import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { type ListedProcess, markerInEnviron, parsePsCommands, parsePsListing, parseWin32Processes } from '../../core/processes.ts';
import { runCommand, succeeded } from '../exec.ts';

/**
 * D127 (`docs/processes.md` → *Tracking per OS*): the read-only listings the process
 * tracker samples. Each runs one or two short commands with a time limit, never as root,
 * never with a shell string; a failure is `null` (that sample is skipped).
 *
 * - **macOS:** `ps -E -ww -o pid=,ppid=,rss=,etime=,pcpu=,command= -U <uid>`: the user's own
 *   processes with their environment after the command (readable without root for one's own
 *   processes); then `ps -ww -o pid=,command= -p <pids>` for the clean command lines of the
 *   few that matter.
 * - **Linux:** `ps -u <uid> -ww -o pid=,ppid=,rss=,etimes=,pcpu=,args=`, and each listed
 *   process's `/proc/<pid>/environ` (readable for one's own processes).
 * - **Windows:** one PowerShell call (`Get-CimInstance Win32_Process`): pid, parent pid,
 *   creation time, working set, command line. No environment (reading another process's
 *   environment needs native code), so sessions are followed by their CLI's process tree.
 */
export interface ProcessScanner {
  /** `true` when {@link list} reads each process's marker (macOS, Linux); `false` on Windows (tree tracking only). */
  readonly envReadable: boolean;
  /** Every process of this user (Windows: every process), each with its marker where readable; `null` when the listing failed. */
  list(): Promise<ListedProcess[] | null>;
  /** The clean command lines of `pids` (macOS: `list` mixes the environment in); a pid it cannot read keeps its listed command. */
  commands(pids: readonly number[], listed: readonly ListedProcess[]): Promise<Map<number, string>>;
}

/** Each listing command's time limit. */
const LIST_TIMEOUT_MS = 15_000;

/** The most a listing may print (a busy machine's `ps -E` is a few MB at most). */
const LIST_MAX_BYTES = 64 * 1024 * 1024;

function uid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** macOS: `ps -E` (environment after the command). */
export function macScanner(now: () => number = Date.now): ProcessScanner {
  return {
    envReadable: true,
    async list() {
      const user = uid();
      const result = await runCommand(['ps'], ['-E', '-ww', '-o', 'pid=,ppid=,rss=,etime=,pcpu=,command=', ...(user === null ? ['-A'] : ['-U', String(user)])], {
        cwd: os.tmpdir(),
        timeoutMs: LIST_TIMEOUT_MS,
        maxOutputBytes: LIST_MAX_BYTES,
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LC_ALL: 'C' },
      });
      if (!succeeded(result)) return null;
      return parseAllRows(result.stdout, now());
    },
    async commands(pids, listed) {
      const out = new Map(listed.map((row) => [row.pid, row.command] as const));
      if (pids.length === 0) return out;
      const result = await runCommand(['ps'], ['-ww', '-o', 'pid=,command=', '-p', pids.join(',')], {
        cwd: os.tmpdir(),
        timeoutMs: LIST_TIMEOUT_MS,
        maxOutputBytes: LIST_MAX_BYTES,
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LC_ALL: 'C' },
      });
      // `ps -p` exits 1 when one of the pids is gone; what it printed still counts.
      for (const [pid, command] of parsePsCommands(result.stdout)) out.set(pid, command);
      return out;
    },
  };
}

/** Every row of a `ps -E` listing, each with its marker (or `null`). */
function parseAllRows(text: string, nowMs: number): ListedProcess[] {
  const marked = new Map(parsePsListing(text, nowMs, true).map((row) => [row.pid, row.marker] as const));
  return parsePsListing(text, nowMs, false).map((row) => ({ ...row, marker: marked.get(row.pid) ?? null }));
}

/** Linux: `ps` for the rows, `/proc/<pid>/environ` for the markers. */
export function linuxScanner(now: () => number = Date.now, proc = '/proc'): ProcessScanner {
  return {
    envReadable: true,
    async list() {
      const user = uid();
      const result = await runCommand(['ps'], [...(user === null ? ['-e'] : ['-u', String(user)]), '-ww', '-o', 'pid=,ppid=,rss=,etimes=,pcpu=,args='], {
        cwd: os.tmpdir(),
        timeoutMs: LIST_TIMEOUT_MS,
        maxOutputBytes: LIST_MAX_BYTES,
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LC_ALL: 'C' },
      });
      if (!succeeded(result)) return null;
      const rows = parsePsListing(result.stdout, now(), false);
      return Promise.all(
        rows.map(async (row) => {
          try {
            return { ...row, marker: markerInEnviron(await readFile(`${proc}/${row.pid}/environ`, 'latin1')) };
          } catch {
            return row;
          }
        }),
      );
    },
    async commands(_pids, listed) {
      return new Map(listed.map((row) => [row.pid, row.command] as const));
    },
  };
}

/** The PowerShell script of the Windows listing (creation times as epoch ms, so no date format is parsed). */
export const WIN32_LIST_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Created = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }; WorkingSetSize = [int64]$_.WorkingSetSize; Name = $_.Name; CommandLine = $_.CommandLine } } | ConvertTo-Json -Compress',
].join('; ');

/** Windows: one PowerShell call. */
export function windowsScanner(): ProcessScanner {
  return {
    envReadable: false,
    async list() {
      const result = await runCommand(['powershell.exe'], ['-NoProfile', '-NonInteractive', '-Command', WIN32_LIST_SCRIPT], { cwd: os.tmpdir(), timeoutMs: 30_000, maxOutputBytes: LIST_MAX_BYTES });
      if (!succeeded(result)) return null;
      return parseWin32Processes(result.stdout);
    },
    async commands(_pids, listed) {
      return new Map(listed.map((row) => [row.pid, row.command] as const));
    },
  };
}

/** The scanner of this OS (`null` where none is known). */
export function platformScanner(platform: NodeJS.Platform = process.platform): ProcessScanner | null {
  if (platform === 'darwin') return macScanner();
  if (platform === 'linux') return linuxScanner();
  if (platform === 'win32') return windowsScanner();
  return null;
}
