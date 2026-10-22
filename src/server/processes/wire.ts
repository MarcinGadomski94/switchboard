import type { HookService } from '../hooks/service.ts';
import type { Providers } from '../providers.ts';
import type { SessionSupervisor } from '../supervisor/supervisor.ts';
import type { ProcessService, ProcessSessions } from './service.ts';

/**
 * D127: what the process tracker reads about the sessions, from the supervisor (live CLIs,
 * activity, the timeline note, the closes it publishes) and the hooks (hooked terminals' pids;
 * `hooks()` is read late: the app creates the hooks after the tracker).
 */
export function processSessions(supervisor: SessionSupervisor, hooks: () => HookService | null): ProcessSessions {
  return {
    livePid: (sessionId) => supervisor.pid(sessionId),
    activity: (sessionId) => supervisor.activity(sessionId),
    liveSessionIds: () => supervisor.liveSessionIds(),
    hookedRoots: async () => (await hooks()?.terminalRoots()) ?? [],
    record: async (sessionId, label, payload) => {
      await supervisor.recordServiceEvent(sessionId, 'text', label, payload);
    },
    onSessionChanged: (listener) => supervisor.on('sessionUpdated', (session) => listener(session.id)),
  };
}

/** D127: `providers` with a system read that also carries the tracked-process totals (the sidebar footer). */
export function withTrackedProcesses(providers: Providers, processes: Pick<ProcessService, 'totals'>): Providers {
  const system = providers.system;
  if (!system) return providers;
  return {
    ...providers,
    system: {
      system: async (options) => {
        const info = await system.system(options);
        const tracked = processes.totals();
        return tracked ? { ...info, trackedProcesses: tracked } : info;
      },
    },
  };
}
