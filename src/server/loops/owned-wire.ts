import type { OwnedLoop } from '../../core/api.ts';
import { loopTitle, scheduleText } from '../../core/owned-loops.ts';
import type { SessionLoopRecord } from '../db/repos/session-loops.ts';

/** D94: a stored Switchboard loop as the API and `Session.ownedLoops` send it. */
export function toOwnedLoop(loop: SessionLoopRecord): OwnedLoop {
  return {
    id: loop.id,
    sessionId: loop.sessionId,
    label: loop.label,
    title: loopTitle(loop.label, loop.prompt),
    prompt: loop.prompt,
    schedule: loop.schedule,
    scheduleText: scheduleText(loop.schedule),
    expiresAt: loop.expiresAt,
    maxRuns: loop.maxRuns,
    state: loop.state,
    endedReason: loop.endedReason,
    runs: loop.runs,
    skipped: loop.skipped,
    lastFiredAt: loop.lastFiredAt,
    lastError: loop.lastError,
    nextFireAt: loop.state === 'active' ? loop.nextFireAt : null,
    createdBy: loop.createdBy,
    createdAt: loop.createdAt,
    updatedAt: loop.updatedAt,
  };
}
