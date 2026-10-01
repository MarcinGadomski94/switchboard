import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import type { Writable } from 'node:stream';

/**
 * Servers that outlive Switchboard (`docs/providers.md` → *Servers that outlive
 * Switchboard*): a CLI run as a server (`opencode serve`) does not watch its
 * stdin, so a Switchboard that is killed before its own shutdown stops it (a
 * SIGKILL, a crash, launchd's exit timeout) would leave it running. Such servers
 * are registered here; one small reaper process per Switchboard
 * (`reaper-main.ts`, started with the first registration) holds the list and
 * stops whatever is still listed once Switchboard's end of its stdin closes.
 * A clean stop unregisters the server first, so the reaper then has nothing to do.
 */

/** The reaper's entry script. */
export const REAPER_ENTRY = path.join(import.meta.dirname, 'reaper-main.ts');

let reaper: { readonly child: ChildProcess; readonly stdin: Writable } | null = null;
const registered = new Set<number>();

function ensureReaper(): Writable | null {
  if (reaper && reaper.child.exitCode === null && reaper.child.signalCode === null && !reaper.stdin.destroyed) return reaper.stdin;
  try {
    // Own process group (`detached`): a Ctrl-C to Switchboard's group must not end the reaper before Switchboard.
    const child = spawn(process.execPath, [REAPER_ENTRY], { stdio: ['pipe', 'ignore', 'ignore'], shell: false, detached: true, windowsHide: true });
    const stdin = child.stdin;
    if (!stdin) return null;
    stdin.on('error', () => undefined);
    child.on('error', () => undefined);
    // Neither the child nor the pipe keeps Switchboard's event loop alive.
    child.unref();
    (stdin as Writable & { unref?: () => void }).unref?.();
    reaper = { child, stdin };
    // A reaper started again (the first one died) learns the servers still running.
    for (const pid of registered) stdin.write(`+${pid}\n`);
    return stdin;
  } catch {
    return null;
  }
}

/** Registers a running server's pid (its process group leader, see {@link serverSpawnOptions}). */
export function registerServer(pid: number): void {
  registered.add(pid);
  const stdin = ensureReaper();
  if (stdin && registered.has(pid)) stdin.write(`+${pid}\n`);
}

/** Unregisters a server that has exited (or is being stopped by Switchboard itself). */
export function unregisterServer(pid: number): void {
  if (!registered.delete(pid)) return;
  if (reaper && !reaper.stdin.destroyed) reaper.stdin.write(`-${pid}\n`);
}

/** Spawn options for such a server: its own process group (POSIX), so it and its children are stopped together. */
export const serverSpawnOptions: { readonly detached: boolean } = { detached: process.platform !== 'win32' };

/** Signals the server's process group (POSIX), else the process alone; `false` when nothing was signalled. */
export function signalServer(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid !== undefined && serverSpawnOptions.detached) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // the group is gone; fall through to the process itself
    }
  }
  return child.kill(signal);
}
