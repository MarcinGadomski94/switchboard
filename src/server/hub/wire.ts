import type { HubEvents } from '../../core/api.ts';
import type { HubBus } from './bus.ts';

/**
 * Services that already emit hub events through their own `on()` (M2.1
 * `SessionSupervisor`, M2.2 `WorktreeManager`). Structural, so tests can pass
 * stand-ins and later services can be added without touching this file's callers.
 */
export interface HubSources {
  readonly supervisor?: {
    on(name: 'sessionUpdated', listener: (payload: HubEvents['sessionUpdated']) => void): () => void;
    on(name: 'event', listener: (payload: HubEvents['event']) => void): () => void;
    on(name: 'activity', listener: (payload: HubEvents['activity']) => void): () => void;
  };
  readonly worktrees?: {
    on(name: 'worktreeRemovable', listener: (payload: HubEvents['worktreeRemovable']) => void): () => void;
  };
}

/**
 * Forwards the services' notifications to the bus unchanged (same names and
 * payloads as the contract). Returns the function that stops forwarding.
 */
export function forwardServiceEvents(bus: HubBus, sources: HubSources): () => void {
  const offs: Array<() => void> = [];
  const { supervisor, worktrees } = sources;
  if (supervisor) {
    offs.push(supervisor.on('sessionUpdated', (session) => bus.publish('sessionUpdated', session)));
    offs.push(supervisor.on('event', (event) => bus.publish('event', event)));
    // D19: the live activity, at most one per second per session (the supervisor throttles).
    offs.push(supervisor.on('activity', (activity) => bus.publish('activity', activity)));
  }
  if (worktrees) offs.push(worktrees.on('worktreeRemovable', (worktree) => bus.publish('worktreeRemovable', worktree)));
  return () => {
    for (const off of offs.splice(0)) off();
  };
}
