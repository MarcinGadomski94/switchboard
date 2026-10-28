import { readFile, readdir, readlink } from 'node:fs/promises';
import os from 'node:os';
import { runCommand } from '../exec.ts';

/** A process and the folder it works in. */
export interface ProcessCwd {
  readonly pid: number;
  /** Its command name (short). */
  readonly command: string;
  /** Its working folder, as the OS reports it. */
  readonly cwd: string;
}

/** Reads every process's working folder; `null` when this OS (Windows) or the listing cannot tell. */
export type CwdLister = () => Promise<ProcessCwd[] | null>;

const LIST_TIMEOUT_MS = 15_000;

/**
 * Parses `lsof -F pcn` output: a `p<pid>` line starts a process, `c<command>` names it and each
 * `n<path>` is a file of it (only the cwd with `-d cwd`).
 */
export function parseLsofCwd(stdout: string): ProcessCwd[] {
  const out: ProcessCwd[] = [];
  let pid = 0;
  let command = '';
  for (const line of stdout.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number.parseInt(value, 10) || 0;
      command = '';
    } else if (tag === 'c') {
      command = value;
    } else if (tag === 'n' && pid > 0 && value.startsWith('/')) {
      out.push({ pid, command, cwd: value });
    }
  }
  return out;
}

/**
 * D145 (D127's process tracking extended): the working folders of this user's processes, so a
 * worktree with a process still running inside it is never removed.
 * - **macOS:** `lsof -a -d cwd -u <uid> -F pcn -w` (read-only; one call for every process).
 * - **Linux:** `/proc/<pid>/cwd` of each process this user can read.
 * - **Windows:** not readable without native code: `null` (the caller falls back to the
 *   processes D127 tracks for the session).
 */
export function platformCwdLister(platform: NodeJS.Platform = process.platform): CwdLister {
  if (platform === 'darwin') {
    return async () => {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      const result = await runCommand(['lsof'], ['-a', '-d', 'cwd', ...(uid === null ? [] : ['-u', String(uid)]), '-F', 'pcn', '-w'], {
        cwd: os.tmpdir(),
        timeoutMs: LIST_TIMEOUT_MS,
        env: { PATH: `${process.env['PATH'] ?? ''}:/usr/sbin:/usr/bin:/bin`, LC_ALL: 'C' },
      });
      // lsof exits 1 when one of its selections found nothing; the listing is still good.
      if (result.error !== null || result.stdout.trim() === '') return null;
      return parseLsofCwd(result.stdout);
    };
  }
  if (platform === 'linux') {
    return async () => {
      let entries: string[];
      try {
        entries = await readdir('/proc');
      } catch {
        return null;
      }
      const out: ProcessCwd[] = [];
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const cwd = await readlink(`/proc/${entry}/cwd`);
          const command = (await readFile(`/proc/${entry}/comm`, 'utf8').catch(() => '')).trim();
          out.push({ pid: Number(entry), command, cwd });
        } catch {
          // another user's process, or gone meanwhile
        }
      }
      return out;
    };
  }
  return async () => null;
}
