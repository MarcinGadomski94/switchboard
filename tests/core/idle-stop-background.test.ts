import { describe, expect, it } from 'vitest';
import type { SessionActivity } from '../../src/core/api.ts';
import { BACKGROUND_SHELL_WAIT_MS, BackgroundTracker } from '../../src/core/derive/background.ts';
import { autoStopAt, autoStopReason, sessionWorking } from '../../src/core/processes.ts';

/**
 * Todo c63771cf14c1 (`docs/processes.md` → *A session's own background commands*): on
 * 2026-11-05 a release test run an agent started with Bash `run_in_background` was SIGTERMed by
 * D127's idle stop after ~11 min while the agent waited on it (D143: a background shell never
 * counted as work). The whole chain here, from the CLI's own texts: the background tracker →
 * the session's live activity → `sessionWorking` → the idle stop's decision. Before D164 the
 * build read as not working and the decision was `idle`; now it is `null` while the build runs,
 * and a dev server left running is still stopped after the delay.
 */

const T0 = Date.parse('2026-11-05T10:00:00.000Z');
const MINUTE = 60_000;
const DELAY = 10 * MINUTE;

/** The CLI's confirmation of a background Bash (CLI 2.1.283's text, as `background.test.ts`). */
const BASH_STARTED = (id: string): string =>
  `Command running in background with ID: ${id}. Output is being written to: /tmp/tasks/${id}.output. You will be notified when it completes. To check interim output, use Read on that file path.`;

function world() {
  let clock = T0;
  const tracker = new BackgroundTracker({ now: () => new Date(clock) });
  const start = (toolUseId: string, taskId: string, command: string): void => {
    tracker.called(toolUseId, 'Bash', { command, run_in_background: true });
    tracker.resulted(toolUseId, { text: BASH_STARTED(taskId), isError: false, detail: { backgroundTaskId: taskId } });
  };
  /** The session's live activity while no turn runs: what the process tracker reads (`ProcessSessions.activity`). */
  const activity = (): SessionActivity | null => {
    const background = tracker.list();
    return background.length === 0 ? null : ({ state: 'background', since: new Date(clock).toISOString(), background, agents: [] } as unknown as SessionActivity);
  };
  /** The idle stop's decision for an idle session (its turn ended at T0) at the clock now. */
  const decision = (): ReturnType<typeof autoStopReason> =>
    autoStopReason({ closed: false, working: sessionWorking('done', activity()), idleSinceMs: T0, nowMs: clock, delayMs: DELAY });
  return {
    tracker,
    start,
    activity,
    decision,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe('the idle stop and a session’s own background commands', () => {
  it('a full test run in the background keeps the session working: no idle stop at 11 min, nor at 20', () => {
    const w = world();
    w.start('t1', 'b-tests', 'SWITCHBOARD_TEST_SECRET_STORE=memory npx vitest run tests/server');
    expect(sessionWorking('done', w.activity())).toBe(true);
    w.advance(11 * MINUTE);
    expect(w.decision()).toBeNull();
    expect(autoStopAt({ working: sessionWorking('done', w.activity()), idleSinceMs: T0, delayMs: DELAY })).toBeNull();
    w.advance(9 * MINUTE);
    expect(w.decision()).toBeNull();
    // It ends: the agent is woken; with the turn over again, the idle countdown starts from now.
    expect(w.tracker.notified('b-tests', 't1')).toBe(true);
    expect(sessionWorking('done', w.activity())).toBe(false);
  });

  it('a dev server left running is no work: its session is idle, and its processes stop after the delay', () => {
    const w = world();
    w.start('t2', 'b-dev', 'npm run dev');
    expect(sessionWorking('done', w.activity())).toBe(false);
    w.advance(DELAY - 1);
    expect(w.decision()).toBeNull();
    w.advance(1);
    expect(w.decision()).toBe('idle');
  });

  it('a build next to a dev server: the session works until the build ends, then the dev server is left behind', () => {
    const w = world();
    w.start('t3', 'b-dev', 'pnpm dev');
    w.start('t4', 'b-apk', './gradlew assembleDebug && adb install -r app-debug.apk');
    expect(sessionWorking('done', w.activity())).toBe(true);
    w.tracker.notified('b-apk', 't4');
    expect(sessionWorking('done', w.activity())).toBe(false);
  });

  it('a command still pending past the 2 h limit (hung) no longer holds the session', () => {
    const w = world();
    w.start('t5', 'b-hung', 'node scripts/migrate.js');
    w.advance(BACKGROUND_SHELL_WAIT_MS - MINUTE);
    expect(sessionWorking('done', w.activity())).toBe(true);
    w.advance(2 * MINUTE);
    expect(sessionWorking('done', w.activity())).toBe(false);
  });
});
