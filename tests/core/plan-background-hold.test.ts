import { describe, expect, it } from 'vitest';
import {
  PLAN_BACKGROUND_HOLD_MS,
  PLAN_BACKGROUND_REASON,
  PLAN_STOPPED_GRACE_MS,
  type PlanItemFacts,
  backgroundHold,
  planBackgroundWait,
  planView,
  stoppedSince,
} from '../../src/core/plans.ts';
import { stepLook } from '../../src/web/v2/projects/project-model.ts';

/**
 * D160 (`docs/plans.md` → *Waiting on a background task*): a running item whose agent ended its
 * turn while a background command it started still runs (a build, a device run) is not D120's
 * `stopped`: it stays `running` with "Waiting on a background task: …", for at most 2 hours; a dev
 * server or watcher never holds it; after the command ends the grace counts from its end.
 */

const NOW = Date.parse('2026-11-09T12:00:00Z');
const IDLE = '2026-11-09T11:30:00Z';
const BUILD = { summary: './gradlew assembleDebug && adb install app.apk', since: '2026-11-09T11:29:00Z' };

function idle(patch: Partial<PlanItemFacts> = {}): PlanItemFacts {
  return {
    id: '1',
    todoId: 't-1',
    key: 'SLIT-1',
    title: 'Lesson page',
    hold: false,
    solutions: [],
    state: 'running',
    reason: null,
    note: null,
    waitingOn: null,
    runSessionId: 's1',
    branch: null,
    prUrl: null,
    checks: null,
    conflicts: 0,
    estimateMinutes: 30,
    position: 1,
    startedAt: '2026-11-09T11:00:00Z',
    waitingSince: null,
    mergedAt: null,
    doneAt: null,
    sessionStatus: 'idle',
    todoDone: false,
    idleSince: IDLE,
    ...patch,
  };
}

const view = (item: PlanItemFacts, now = NOW) => planView({ mode: 'agents', targetBranch: null, maxConcurrency: 3, edges: [], now, items: [item] }).items[0];

describe('D160 · a plan item waits on its agent\'s background command', () => {
  it('picks the oldest background shell / monitor that is no dev server; subagents, workflows and wake-ups are not counted here', () => {
    expect(
      planBackgroundWait([
        { kind: 'bash', summary: 'npm run dev', startedAt: '2026-11-09T11:00:00Z' },
        { kind: 'agent', summary: 'Review', startedAt: '2026-11-09T11:01:00Z' },
        { kind: 'monitor', summary: 'adb logcat until the test ends', startedAt: '2026-11-09T11:40:00Z' },
        { kind: 'bash', summary: BUILD.summary, startedAt: BUILD.since },
        { kind: 'wakeup', summary: 'check the build', startedAt: '2026-11-09T11:02:00Z' },
      ]),
    ).toEqual(BUILD);
    expect(planBackgroundWait([{ kind: 'bash', summary: 'vite', startedAt: BUILD.since }, { kind: 'bash', summary: 'dotnet watch run', startedAt: BUILD.since }])).toBeNull();
    expect(planBackgroundWait([])).toBeNull();
  });

  it('held during a build: running with the reason, never stopped, the step says so', () => {
    const item = idle({ backgroundWait: BUILD });
    expect(stoppedSince(item, 'agents', NOW)).toBeNull();
    const shown = view(item);
    expect(shown).toMatchObject({ state: 'running', reason: `${PLAN_BACKGROUND_REASON}: ${BUILD.summary}`, stoppedSince: null });
    expect(stepLook(shown as never, [shown as never])).toMatchObject({ kind: 'running', detail: `${PLAN_BACKGROUND_REASON}: ${BUILD.summary}` });
    // Without it the same item is D120's stopped.
    expect(view(idle())?.state).toBe('stopped');
  });

  it('a dev server does not hold it (planBackgroundWait leaves it out), and a command older than 2 hours no longer does', () => {
    expect(PLAN_BACKGROUND_HOLD_MS).toBe(2 * 3600_000);
    const old = { summary: BUILD.summary, since: new Date(NOW - PLAN_BACKGROUND_HOLD_MS - 60_000).toISOString() };
    expect(backgroundHold({ backgroundWait: old }, NOW)).toBeNull();
    // The hold's limit passed a minute ago: the grace counts from it, so it is not stopped yet …
    expect(stoppedSince(idle({ backgroundWait: old }), 'agents', NOW)).toBe(new Date(NOW - 60_000).toISOString());
    expect(view(idle({ backgroundWait: old }))?.state).toBe('running');
    // … and is once the grace has passed.
    expect(view(idle({ backgroundWait: old }), NOW + PLAN_STOPPED_GRACE_MS)?.state).toBe('stopped');
  });

  it('after the command ends, the grace counts from its end: no instant flip, stopped once the grace is over', () => {
    const ended = new Date(NOW - 30_000).toISOString();
    const item = idle({ backgroundWait: null, backgroundEndedAt: ended });
    expect(stoppedSince(item, 'agents', NOW)).toBe(ended);
    expect(view(item)?.state).toBe('running');
    expect(view(item, NOW + PLAN_STOPPED_GRACE_MS)?.state).toBe('stopped');
    // An older end than the idle time: the idle time counts (the agent worked after it).
    expect(stoppedSince(idle({ backgroundEndedAt: '2026-11-09T11:00:00Z' }), 'agents', NOW)).toBe(IDLE);
  });

  it('a working session, a question or a done todo are unchanged by a background command', () => {
    expect(view(idle({ sessionStatus: 'run', backgroundWait: BUILD }))).toMatchObject({ state: 'running', reason: null });
    expect(view(idle({ sessionStatus: 'need', backgroundWait: BUILD }))?.state).toBe('question');
    expect(view(idle({ todoDone: true, backgroundWait: BUILD }))).toMatchObject({ state: 'running', reason: null });
  });
});
