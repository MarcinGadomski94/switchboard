/**
 * Crash recovery (M2.4, D7): what the service does with the sessions it finds when
 * it starts. `docs/supervisor.md` → *Restart recovery* has the rules and the
 * reasons; the short version:
 *
 * - A session whose process was live (`run` / `need`, attached) is resumed with
 *   `--resume <claudeSessionId>`: `run` gets {@link RESTART_MESSAGE}, `need` stays
 *   idle and {@link RESTART_NOTE} waits in its outbox for its answers.
 * - Never two live processes on one id (they fork the conversation, M0.4): a process
 *   left behind by a service that died (its recorded pid, listed by
 *   `claude agents --json` with the same session id) is stopped first with SIGINT →
 *   SIGTERM → SIGKILL. When that cannot be made sure of, the session is left
 *   `paused` with an error event instead of being resumed.
 */
import { realpath } from 'node:fs/promises';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { runCommand, succeeded } from '../exec.ts';
import { childEnv } from './argv.ts';
import { DEFAULT_STOP_TIMEOUTS, type SessionSupervisor, SupervisorError } from './supervisor.ts';

/** The stdin message a `run` session gets after a restart (D7). */
export const RESTART_MESSAGE = 'Switchboard restarted. Continue.';

/** The note a `need` session gets together with its answers (its next message) after a restart. */
export const RESTART_NOTE = 'Switchboard restarted.';

/** `pending_messages.kind` of {@link RESTART_NOTE}. */
export const RESTART_NOTE_KIND = 'restart-note';

/** One row of `claude agents --json` (M0.1: `[{pid, cwd, kind, startedAt, sessionId, name, status}]`). */
export interface LiveClaudeProcess {
  readonly pid: number;
  readonly sessionId: string;
}

/** Lists the live claude processes; `null` when the list could not be read. */
export type LiveProcessLister = () => Promise<LiveClaudeProcess[] | null>;

/** OS process access (tests replace it). */
export interface ProcessControl {
  /** `true` while a process with this pid exists. */
  isAlive(pid: number): boolean;
  /** Sends `signal`; `false` when there is no such process. */
  kill(pid: number, signal: NodeJS.Signals): boolean;
}

/** {@link ProcessControl} on the real OS (`process.kill`). */
export const osProcesses: ProcessControl = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: it exists but belongs to someone else.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  kill(pid, signal) {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  },
};

/** Options for {@link recoverSessions}. */
export interface RecoveryOptions {
  readonly store: Store;
  readonly supervisor: SessionSupervisor;
  /** `claude agents --json` ({@link claudeAgentsLister}). */
  readonly listLive: LiveProcessLister;
  readonly processes?: ProcessControl;
  /** How long to wait for a leftover to end after each signal (default {@link DEFAULT_STOP_TIMEOUTS}.signal). */
  readonly signalTimeoutMs?: number;
  /** Poll interval while waiting for a leftover to end (default 50 ms). */
  readonly pollMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** What recovery did with one session. */
export type RecoveryAction =
  /** Resumed and sent {@link RESTART_MESSAGE}. */
  | 'resumed'
  /** Resumed idle, {@link RESTART_NOTE} queued. */
  | 'resumed-idle'
  /** A pause (or detach) the crash cut short, finished: `paused`. */
  | 'paused'
  /** Left `paused` because resuming could fork the conversation or the resume failed. */
  | 'not-resumed'
  /** Its process was live but it was not `run` / `need`: only cleaned up. */
  | 'cleaned';

/** One session in the {@link RecoveryReport}. */
export interface RecoveredSession {
  readonly sessionId: string;
  readonly action: RecoveryAction;
  /** The leftover process that was stopped, and how it ended. */
  readonly leftover?: { readonly pid: number; readonly stoppedBy: string };
  /** Why the session was not resumed. */
  readonly reason?: string;
}

/** Result of {@link recoverSessions}. */
export interface RecoveryReport {
  readonly sessions: RecoveredSession[];
}

/** `true` for a session whose process was live and that D7 resumes. */
function wantsResume(session: SessionRecord): boolean {
  return session.attached && (session.status === 'run' || session.status === 'need');
}

/**
 * Runs once at service start, before the API listens (so no request can race it):
 * stops leftovers, cleans up after a crash and resumes the sessions that were live.
 * Sessions are handled in parallel; one that fails does not stop the others.
 */
export async function recoverSessions(options: RecoveryOptions): Promise<RecoveryReport> {
  const { store, supervisor } = options;
  const processes = options.processes ?? osProcesses;
  const onError = options.onError ?? ((error: unknown) => console.error('switchboard recovery:', error));
  const candidates = (await store.sessions.list()).filter((session) => session.pid !== null || wantsResume(session));
  if (candidates.length === 0) return { sessions: [] };

  let listed: Promise<LiveClaudeProcess[] | null> | undefined;
  const list = (): Promise<LiveClaudeProcess[] | null> => {
    listed ??= options.listLive().catch((error: unknown) => {
      onError(error);
      return null;
    });
    return listed;
  };
  const stopOptions = {
    processes,
    timeoutMs: options.signalTimeoutMs ?? DEFAULT_STOP_TIMEOUTS.signal,
    pollMs: options.pollMs ?? 50,
  };

  const recoverOne = async (session: SessionRecord): Promise<RecoveredSession> => {
    let reason: string | null = null;
    let leftover: { pid: number; stoppedBy: string } | undefined;
    const pid = session.pid;

    // 1. A process left behind by the service that died: stop it when it is this session's.
    if (pid !== null && processes.isAlive(pid)) {
      const live = await list();
      if (live === null) {
        reason = `could not check whether pid ${pid} is still this session's claude process (claude agents --json failed)`;
      } else if (live.some((row) => row.pid === pid && row.sessionId === session.claudeSessionId)) {
        const stoppedBy = await stopProcess(pid, stopOptions);
        if (stoppedBy === null) {
          reason = `the claude process left from before the restart (pid ${pid}) did not stop`;
        } else {
          leftover = { pid, stoppedBy };
          await supervisor.recordServiceEvent(session.id, 'text', `Stopped the claude process left from before the restart (pid ${pid})`, {
            type: 'lifecycle',
            action: 'leftover-stopped',
            leftoverPid: pid,
            stoppedBy,
          });
        }
      }
      // Alive but not listed with this id: the pid now belongs to another program.
    }

    // 2. What the crash left in the database (open requests, running subagents, the pid).
    if (pid !== null) await supervisor.settleAfterCrash(session.id);

    const report = (action: RecoveryAction, why?: string): RecoveredSession => ({
      sessionId: session.id,
      action,
      ...(leftover ? { leftover } : {}),
      ...(why ? { reason: why } : {}),
    });
    const notResumed = async (why: string): Promise<RecoveredSession> => {
      await supervisor.markPausedAfterRestart(session.id);
      await supervisor.recordServiceEvent(session.id, 'error', `Not resumed after the restart: ${why}`, {
        type: 'lifecycle',
        action: 'not-resumed',
        message: why,
      });
      return report('not-resumed', why);
    };

    if (!wantsResume(session)) {
      if (reason !== null) onError(new Error(`session ${session.name}: ${reason}`));
      return report('cleaned', reason ?? undefined);
    }

    // 3. A pause / "Continue in terminal" the crash cut short: finish it, never resume.
    if (session.stopReason === 'pause' || session.stopReason === 'detach') {
      if (reason !== null) onError(new Error(`session ${session.name}: ${reason}`));
      const detached = session.stopReason === 'detach';
      await supervisor.markPausedAfterRestart(session.id, detached);
      await supervisor.recordServiceEvent(session.id, 'text', detached ? 'Continued in a terminal' : 'Paused', {
        type: 'lifecycle',
        action: detached ? 'detached' : 'paused',
        message: 'finished after a Switchboard restart',
      });
      return report('paused');
    }

    // 4. Another live process holds the id (e.g. a terminal opened while the service was down).
    if (reason === null) {
      const live = await list();
      const other = live?.find((row) => row.sessionId === session.claudeSessionId && row.pid !== pid && processes.isAlive(row.pid));
      if (other) reason = `the session is open in another claude process (pid ${other.pid}); resume it once that process has ended`;
    }
    if (reason !== null) return notResumed(reason);

    // 5. Resume (D7).
    try {
      if (session.status === 'run') {
        await supervisor.resumeAfterRestart(session.id, RESTART_MESSAGE);
        return report('resumed');
      }
      const queued = (await store.pendingMessages.pending(session.id)).some((message) => message.kind === RESTART_NOTE_KIND);
      if (!queued) await store.pendingMessages.enqueue({ sessionId: session.id, kind: RESTART_NOTE_KIND, text: RESTART_NOTE });
      await supervisor.resumeAfterRestart(session.id, null);
      return report('resumed-idle');
    } catch (error) {
      onError(error);
      // The service is shutting down: keep the stored status so the next start resumes it.
      if (error instanceof SupervisorError && error.code === 'closing') return report('not-resumed', 'the service is shutting down');
      return notResumed(`the resume failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const results = await Promise.all(
    candidates.map((session) =>
      recoverOne(session).catch((error: unknown): RecoveredSession => {
        onError(error);
        return { sessionId: session.id, action: 'not-resumed', reason: error instanceof Error ? error.message : String(error) };
      }),
    ),
  );
  return { sessions: results };
}

/**
 * Stops a process Switchboard no longer owns (no stdin to interrupt it): SIGINT,
 * then SIGTERM, then SIGKILL, each followed by up to `timeoutMs` of polling.
 * Returns how it ended (`exited` if it was gone before the first signal, else the
 * last signal sent), or `null` when it is still alive after SIGKILL.
 */
export async function stopProcess(
  pid: number,
  options: { readonly processes: ProcessControl; readonly timeoutMs: number; readonly pollMs: number },
): Promise<string | null> {
  const { processes, timeoutMs, pollMs } = options;
  let stoppedBy = 'exited';
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
    if (!processes.isAlive(pid)) return stoppedBy;
    stoppedBy = signal;
    processes.kill(pid, signal);
    const deadline = Date.now() + timeoutMs;
    while (processes.isAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  return processes.isAlive(pid) ? null : stoppedBy;
}

/**
 * `claude agents --json` through the configured CLI command (M0.1: no model call;
 * supervised `-p` processes are listed while they run). Runs with the scrubbed child
 * env (so `CLAUDE_CONFIG_DIR` applies) in the workspace root when it exists. Any
 * failure or an unexpected shape → `null`.
 */
export function claudeAgentsLister(options: {
  readonly claudeCommand: readonly string[];
  readonly workspaceRoot: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}): LiveProcessLister {
  return async () => {
    let cwd = process.cwd();
    if (options.workspaceRoot) {
      try {
        cwd = await realpath(options.workspaceRoot);
      } catch {
        // No workspace root on disk: list from the service's own folder.
      }
    }
    const result = await runCommand(options.claudeCommand, ['agents', '--json'], {
      cwd,
      env: childEnv(options.env ?? process.env),
      timeoutMs: options.timeoutMs ?? 30_000,
    });
    if (!succeeded(result)) return null;
    return parseAgentsJson(result.stdout);
  };
}

/** Parses `claude agents --json`; rows without a numeric pid and a string session id are skipped; not an array → `null`. */
export function parseAgentsJson(text: string): LiveClaudeProcess[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: LiveClaudeProcess[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const { pid, sessionId } = row as { pid?: unknown; sessionId?: unknown };
    if (typeof pid === 'number' && Number.isInteger(pid) && typeof sessionId === 'string') rows.push({ pid, sessionId });
  }
  return rows;
}
