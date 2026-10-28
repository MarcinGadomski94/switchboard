import type { SessionActivity, SessionEvent } from '../../core/api.ts';
import type { LifecyclePayload } from '../../core/event-payload.ts';
import type { Store } from '../db/store.ts';
import type { FolderRef } from '../folders/ref.ts';
import { type CwdLister, platformCwdLister } from '../processes/cwd.ts';
import type { SupervisorEvents } from '../supervisor/supervisor.ts';
import { scannedRepos } from './adopt.ts';
import { AgentWorktrees } from './agent-made.ts';
import { type AutoCleanServiceOptions, AutoCleanService } from './auto-clean.ts';
import type { AdoptionRepo } from './manager.ts';

/** What the clean-up needs of the supervisor. */
export interface AutoCleanSessions {
  on(name: 'event', listener: (payload: SupervisorEvents['event']) => void): () => void;
  turnRunning(sessionId: string): boolean;
  activity(sessionId: string): SessionActivity | null;
  isLive(sessionId: string): boolean;
  recordServiceEvent(sessionId: string, kind: 'text' | 'error', label: string, payload: LifecyclePayload): Promise<unknown>;
  announce(sessionId: string): Promise<void>;
}

/** Options of {@link wireAutoClean}. */
export interface AutoCleanWiring {
  readonly store: Store;
  readonly sessions: AutoCleanSessions;
  /** The worktree manager: its `worktreeRemovable` (a merged PR, read by the poll) is merge evidence. */
  readonly worktrees: { on(name: 'worktreeRemovable', listener: (worktree: { readonly id: string }) => void): () => void };
  /** The Inbox: a cleaned-up worktree's "PR merged" item is closed. */
  readonly systemItems?: { worktreeGone(worktreeId: string): Promise<unknown> };
  /** D127: a session's tracked processes (Windows, where working folders cannot be read). */
  readonly trackedProcesses?: (sessionId: string) => Promise<readonly string[]>;
  readonly gitCommand?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly repos?: (folder: FolderRef) => Promise<AdoptionRepo[]>;
  readonly processCwds?: CwdLister;
  readonly log?: (line: string) => void;
  readonly onError?: (error: unknown) => void;
  /** Passed to the service (tests shorten them). */
  readonly service?: Pick<AutoCleanServiceOptions, 'settleMs' | 'sweepMs' | 'firstSweepMs' | 'now'>;
}

/**
 * D145: `true` while the session's agent works: a turn runs, or the agent waits on its helper
 * agents (D143: a background shell is no work).
 */
export function agentWorking(sessions: Pick<AutoCleanSessions, 'turnRunning' | 'activity'>, sessionId: string): boolean {
  if (sessions.turnRunning(sessionId)) return true;
  const activity = sessions.activity(sessionId);
  if (activity === null) return false;
  if (activity.state !== 'background') return true;
  return activity.background.some((task) => task.waiting === true);
}

function lifecycleAction(event: Pick<SessionEvent, 'payload'>): string | null {
  const payload = event.payload as { type?: unknown; action?: unknown } | null;
  return payload && payload.type === 'lifecycle' && typeof payload.action === 'string' ? payload.action : null;
}

/**
 * D145: the automatic clean-up of merged worktrees joined to the app: the agent-made worktree
 * scanner, the service, and its triggers: a session's turn end (its worktrees, after adopting
 * what its agent made), its archiving (`closed`), a merged PR seen by the poll
 * (`worktreeRemovable`), and the periodic sweep ({@link AutoCleanService.start}). Returns the
 * service, the scanner and a function that stops listening.
 */
export function wireAutoClean(wiring: AutoCleanWiring): { readonly autoClean: AutoCleanService; readonly agentMade: AgentWorktrees; readonly off: () => void } {
  const agentMade = new AgentWorktrees({
    store: wiring.store,
    repos: wiring.repos ?? scannedRepos,
    ...(wiring.gitCommand ? { gitCommand: wiring.gitCommand } : {}),
    ...(wiring.env ? { env: wiring.env } : {}),
    ...(wiring.onError ? { onError: wiring.onError } : {}),
  });
  const sessions = wiring.sessions;
  const autoClean = new AutoCleanService({
    store: wiring.store,
    isBusy: (sessionId) => agentWorking(sessions, sessionId),
    isLive: (sessionId) => sessions.isLive(sessionId),
    processCwds: wiring.processCwds ?? platformCwdLister(),
    ...(wiring.trackedProcesses ? { trackedProcesses: wiring.trackedProcesses } : {}),
    record: (sessionId, label, payload) => sessions.recordServiceEvent(sessionId, 'text', label, payload),
    announce: (sessionId) => sessions.announce(sessionId),
    ...(wiring.systemItems ? { worktreeGone: (worktreeId: string) => (wiring.systemItems as NonNullable<AutoCleanWiring['systemItems']>).worktreeGone(worktreeId) } : {}),
    adoptAgentMade: () => agentMade.scan(),
    ...(wiring.gitCommand ? { gitCommand: wiring.gitCommand } : {}),
    ...(wiring.env ? { env: wiring.env } : {}),
    ...(wiring.log ? { log: wiring.log } : {}),
    ...(wiring.onError ? { onError: wiring.onError } : {}),
    ...wiring.service,
  });
  const offEvents = sessions.on('event', ({ sessionId, event }) => {
    const payload = event.payload as { type?: unknown } | null;
    if (payload?.type === 'result') autoClean.requestSession(sessionId, 'turn-end');
    else if (lifecycleAction(event) === 'closed') autoClean.requestSession(sessionId, 'closed');
  });
  const offMerged = wiring.worktrees.on('worktreeRemovable', (worktree) => autoClean.requestWorktree(worktree.id, 'merged'));
  return {
    autoClean,
    agentMade,
    off: () => {
      offEvents();
      offMerged();
    },
  };
}
