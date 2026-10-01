/**
 * The orphan reaper's own process (`docs/providers.md` → *Servers that outlive
 * Switchboard*). Started by `reaper.ts` with a pipe on its stdin; Switchboard
 * writes one line per CLI server it starts (`+<pid>`) and ends (`-<pid>`). When
 * the pipe ends, Switchboard is gone (a clean exit, a crash or a SIGKILL alike),
 * so every server still listed is stopped: SIGTERM to its process group, SIGKILL
 * after {@link KILL_AFTER_MS}. It runs in its own process group, so a terminal's
 * Ctrl-C reaches Switchboard, not the reaper.
 */
import { LineSplitter } from '../../core/stream-json.ts';

/** How long a server gets after SIGTERM before SIGKILL. */
const KILL_AFTER_MS = 2_000;

const live = new Set<number>();

/** Signals `pid`'s process group, else `pid` alone (Windows has no groups); `false` once it is gone. */
function signal(pid: number, sig: NodeJS.Signals): boolean {
  for (const target of process.platform === 'win32' ? [pid] : [-pid, pid]) {
    try {
      process.kill(target, sig);
      return true;
    } catch {
      // gone, or not a group leader: try the next form
    }
  }
  return false;
}

function reap(): void {
  const left = [...live].filter((pid) => signal(pid, 'SIGTERM'));
  if (left.length === 0) process.exit(0);
  setTimeout(() => {
    for (const pid of left) signal(pid, 'SIGKILL');
    process.exit(0);
  }, KILL_AFTER_MS);
}

const splitter = new LineSplitter((line) => {
  const found = /^([+-])(\d+)$/.exec(line.trim());
  if (!found) return;
  const pid = Number(found[2]);
  if (found[1] === '+') live.add(pid);
  else live.delete(pid);
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => splitter.push(chunk));
process.stdin.once('end', reap);
process.stdin.once('error', reap);
// Only the pipe ends the reaper (a signal sent to Switchboard's group must not take it first).
process.on('SIGINT', () => undefined);
process.on('SIGHUP', () => undefined);
