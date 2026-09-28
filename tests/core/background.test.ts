import { describe, expect, it } from 'vitest';
import { ActivityTracker } from '../../src/core/derive/activity.ts';
import {
  BackgroundTracker,
  backgroundSummary,
  endsTask,
  githubCommand,
  isGithubWait,
  parseTaskNotification,
} from '../../src/core/derive/background.ts';

/**
 * D30 background work (`src/core/derive/background.ts`, `docs/derivations.md` →
 * *Background work*): which calls start a background task, when it ends, and how
 * the live activity shows it while no turn runs.
 */

const T0 = Date.parse('2026-09-28T10:00:00.000Z');
const iso = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

/** The CLI's texts (the D30 probe and CLI 2.1.283's code). */
const BASH_STARTED = (id: string): string =>
  `Command running in background with ID: ${id}. Output is being written to: /tmp/tasks/${id}.output. You will be notified when it completes. To check interim output, use Read on that file path.`;
const AGENT_LAUNCHED = (id: string): string =>
  `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.) agentId: ${id} (internal ID - do not mention to user.)`;
const MONITOR_STARTED = (id: string): string =>
  `Monitor started (task ${id}, timeout 300000ms). You will be notified on each event. Keep working — do not poll or sleep.`;
const GH_WAIT = 'cd /work/repo && for i in $(seq 1 60); do gh run view 4242 --json status --jq .status | grep -qx completed && break; sleep 20; done';

function world() {
  let clock = T0;
  const tracker = new BackgroundTracker({ now: () => new Date(clock) });
  return {
    tracker,
    tick(seconds: number) {
      clock += seconds * 1000;
    },
  };
}

describe('GitHub waits and summaries', () => {
  it('a command that uses gh run, gh pr checks or gh workflow is a GitHub wait', () => {
    expect(isGithubWait('gh run view 42')).toBe(true);
    expect(isGithubWait('gh run watch 42 --exit-status')).toBe(true);
    expect(isGithubWait(GH_WAIT)).toBe(true);
    expect(isGithubWait('until gh pr checks 17; do sleep 30; done')).toBe(true);
    expect(isGithubWait('gh  pr   checks 17 --watch')).toBe(true);
    expect(isGithubWait('gh workflow run deploy.yml')).toBe(true);
    expect(isGithubWait('gh pr view 17')).toBe(false);
    expect(isGithubWait('npm run dev')).toBe(false);
    expect(isGithubWait('sigh run')).toBe(false);
    expect(isGithubWait('echo "high runway"')).toBe(false);
  });

  it('the summary of a GitHub wait is its gh command, cut at the next shell separator', () => {
    expect(githubCommand(GH_WAIT)).toBe('gh run view 4242 --json status --jq .status');
    expect(githubCommand('cd x && for i in $(seq 1 60); do gh run view 42 --json status; sleep 20; done')).toBe('gh run view 42 --json status');
    expect(githubCommand('gh pr checks 17 --watch && echo ok')).toBe('gh pr checks 17 --watch');
    expect(githubCommand('$(gh run list --limit 1)')).toBe('gh run list --limit 1');
    expect(githubCommand('npm test')).toBeNull();
    expect(githubCommand(`gh run view ${'9'.repeat(200)}`)).toHaveLength(80);
  });

  it('backgroundSummary: D19 summaries, the gh command for a GitHub wait, a monitor\'s description, a wake-up\'s reason', () => {
    expect(backgroundSummary('Bash', { command: 'npm run dev\n# later' })).toBe('npm run dev');
    expect(backgroundSummary('Bash', { command: GH_WAIT, run_in_background: true })).toBe('gh run view 4242 --json status --jq .status');
    expect(backgroundSummary('Agent', { description: 'Review the diff', run_in_background: true })).toBe('Review the diff');
    expect(backgroundSummary('Task', {})).toBe('Task');
    expect(backgroundSummary('Monitor', { description: 'Deploy log', command: 'tail -f deploy.log' })).toBe('Deploy log');
    expect(backgroundSummary('Monitor', { command: 'tail -f deploy.log\nmore' })).toBe('tail -f deploy.log');
    expect(backgroundSummary('Monitor', { command: 'gh run watch 42' })).toBe('gh run watch 42');
    expect(backgroundSummary('Monitor', {})).toBe('Monitor');
    expect(backgroundSummary('ScheduleWakeup', { delaySeconds: 600, reason: 'Check the CI run again' })).toBe('Check the CI run again');
    expect(backgroundSummary('ScheduleWakeup', { delaySeconds: 600 })).toBe('ScheduleWakeup');
  });
});

describe('task notifications as text', () => {
  it('parses <task-notification> with its task id, tool use id and status; other text is not one', () => {
    const text = [
      '<task-notification>',
      '<task-id>b6kg3qgya</task-id>',
      '<tool-use-id>toolu_01AB</tool-use-id>',
      '<output-file>/tmp/tasks/b6kg3qgya.output</output-file>',
      '<status>completed</status>',
      '<summary>Background command "sleep 5; echo done" completed (exit code 0)</summary>',
      '</task-notification>',
    ].join('\n');
    const parsed = parseTaskNotification(text);
    expect(parsed).toEqual({ taskId: 'b6kg3qgya', toolUseId: 'toolu_01AB', status: 'completed' });
    expect(endsTask(parsed!)).toBe(true);
    expect(parseTaskNotification('<task-notification> <task-id>t1</task-id> <status>killed</status> </task-notification>')).toEqual({ taskId: 't1', toolUseId: null, status: 'killed' });
    expect(endsTask({ taskId: 'm1', toolUseId: null, status: null })).toBe(false);
    expect(parseTaskNotification('Please check <task-notification>')).toBeNull();
    expect(parseTaskNotification('<task-notification></task-notification>')).toBeNull();
    expect(parseTaskNotification('hello')).toBeNull();
  });
});

describe('BackgroundTracker (pure)', () => {
  it('a background Bash is added from its tool_use + the confirming tool_result, and removed by its task notification (tool use id)', () => {
    const w = world();
    w.tracker.called('toolu_1', 'Bash', { command: 'sleep 5; echo done', run_in_background: true });
    w.tick(1);
    expect(w.tracker.list()).toEqual([]);
    expect(w.tracker.resulted('toolu_1', { text: BASH_STARTED('b6kg3qgya'), isError: false, detail: { backgroundTaskId: 'b6kg3qgya' } })).toBe(true);
    expect(w.tracker.list()).toEqual([
      { id: 'b6kg3qgya', toolUseId: 'toolu_1', kind: 'bash', summary: 'sleep 5; echo done', startedAt: iso(0), github: false },
    ]);
    // A notification of something else changes nothing.
    expect(w.tracker.notified('other', 'toolu_9')).toBe(false);
    expect(w.tracker.list()).toHaveLength(1);
    expect(w.tracker.notified('b6kg3qgya', 'toolu_1')).toBe(true);
    expect(w.tracker.list()).toEqual([]);
  });

  it('the task id alone ends a task when the notification has no tool use id; the id comes from the text without tool_use_result', () => {
    const w = world();
    w.tracker.called('toolu_1', 'Bash', { command: GH_WAIT, run_in_background: true });
    w.tracker.resulted('toolu_1', { text: BASH_STARTED('bx1'), isError: false });
    expect(w.tracker.list()[0]).toMatchObject({ id: 'bx1', github: true, summary: 'gh run view 4242 --json status --jq .status' });
    expect(w.tracker.notified('bx1', null)).toBe(true);
    expect(w.tracker.list()).toEqual([]);
  });

  it('only confirmed starts count: a foreground Bash, an error, a command the CLI ends with the turn, other tools', () => {
    const w = world();
    w.tracker.called('t1', 'Bash', { command: 'npm test' });
    w.tracker.resulted('t1', { text: 'ok\n2 passed', isError: false });
    w.tracker.called('t2', 'Bash', { command: 'sleep 99', run_in_background: true });
    w.tracker.resulted('t2', { text: 'Blocked: sleep', isError: true });
    w.tracker.called('t3', 'Bash', { command: 'npm run dev', run_in_background: true });
    w.tracker.resulted('t3', {
      text: `${BASH_STARTED('b3')} If it exits while you are still working you will be notified, but it is terminated when you give your final response and no notification can follow that.`,
      isError: false,
    });
    w.tracker.called('t4', 'Read', { file_path: 'a.ts' });
    w.tracker.resulted('t4', { text: BASH_STARTED('b4'), isError: false });
    w.tracker.called('t5', 'Agent', { description: 'Foreground', subagent_type: 'general-purpose' });
    w.tracker.resulted('t5', { text: 'The agent found 3 files.', isError: false });
    // A result without its call (e.g. a subagent's) adds nothing.
    expect(w.tracker.resulted('t6', { text: BASH_STARTED('b6'), isError: false })).toBe(false);
    expect(w.tracker.list()).toEqual([]);
  });

  it('a command moved to the background after its timeout counts too (the CLI notifies it the same way)', () => {
    const w = world();
    w.tracker.called('t1', 'Bash', { command: 'npm run e2e' });
    w.tracker.resulted('t1', { text: 'Command did not complete within its 120s timeout and was moved to the background (ID: bmv1). Output is being written to: /tmp/x.', isError: false });
    expect(w.tracker.list()).toMatchObject([{ id: 'bmv1', kind: 'bash', summary: 'npm run e2e', github: false }]);
  });

  it('an async Agent, a Monitor (pending until its own notification) and a wake-up; several tasks oldest first', () => {
    const w = world();
    w.tracker.called('ta', 'Agent', { description: 'Review the diff', subagent_type: 'general-purpose', run_in_background: true });
    w.tracker.resulted('ta', { text: AGENT_LAUNCHED('a8d1'), isError: false, detail: { status: 'async_launched', agentId: 'a8d1' } });
    w.tick(10);
    w.tracker.called('tm', 'Monitor', { command: 'gh run watch 42', description: 'CI run 42' });
    w.tracker.resulted('tm', { text: MONITOR_STARTED('mon7'), isError: false });
    w.tick(5);
    w.tracker.called('tw', 'ScheduleWakeup', { delaySeconds: 600, reason: 'Check CI again', prompt: '/loop check CI' });
    w.tracker.resulted('tw', { text: 'Next wake-up scheduled.', isError: false });
    expect(w.tracker.list()).toEqual([
      { id: 'a8d1', toolUseId: 'ta', kind: 'agent', summary: 'Review the diff', startedAt: iso(0), github: false },
      // A monitor's GitHub wait reads like a Bash one: its gh command.
      { id: 'mon7', toolUseId: 'tm', kind: 'monitor', summary: 'gh run watch 42', startedAt: iso(10), github: true },
      { id: 'tw', toolUseId: 'tw', kind: 'wakeup', summary: 'Check CI again', startedAt: iso(15), wakeAt: iso(615), github: false },
    ]);
    // The agent ends (its notification carries the Agent call's id).
    expect(w.tracker.notified('a8d1', 'ta')).toBe(true);
    // The next turn starts: the wake-up has fired; the monitor stays.
    w.tracker.turnStarted();
    expect(w.tracker.list().map((t) => t.kind)).toEqual(['monitor']);
    expect(w.tracker.notified('mon7', null)).toBe(true);
    expect(w.tracker.list()).toEqual([]);
  });

  it('a wake-up with stop: true, a missing delay or an error schedules nothing; an async agent without its id keeps the tool use id', () => {
    const w = world();
    w.tracker.called('w1', 'ScheduleWakeup', { stop: true });
    w.tracker.resulted('w1', { text: 'Loop stopped.', isError: false });
    w.tracker.called('w2', 'ScheduleWakeup', { reason: 'x' });
    w.tracker.resulted('w2', { text: 'ok', isError: false });
    w.tracker.called('w3', 'ScheduleWakeup', { delaySeconds: 60 });
    w.tracker.resulted('w3', { text: 'Scheduling a /loop wakeup requires classifier review.', isError: true });
    expect(w.tracker.list()).toEqual([]);
    w.tracker.called('a1', 'Task', { description: 'Old-style task', run_in_background: true });
    w.tracker.resulted('a1', { text: 'Async agent launched successfully.', isError: false });
    expect(w.tracker.list()).toMatchObject([{ id: 'a1', toolUseId: 'a1', kind: 'agent', summary: 'Old-style task' }]);
  });

  it('a notification that comes before the confirming result: the start adds nothing', () => {
    const w = world();
    w.tracker.called('t1', 'Bash', { command: 'true', run_in_background: true });
    expect(w.tracker.notified('bq', 't1')).toBe(false);
    expect(w.tracker.resulted('t1', { text: BASH_STARTED('bq'), isError: false })).toBe(false);
    expect(w.tracker.list()).toEqual([]);
  });

  it('the process ending (exit, pause) clears every task', () => {
    const w = world();
    w.tracker.called('t1', 'Bash', { command: 'npm run dev', run_in_background: true });
    w.tracker.resulted('t1', { text: BASH_STARTED('b1'), isError: false });
    w.tracker.called('t2', 'Monitor', { command: 'tail -f x' });
    w.tracker.resulted('t2', { text: MONITOR_STARTED('m2'), isError: false });
    w.tracker.called('t3', 'Bash', { command: 'sleep 1', run_in_background: true });
    expect(w.tracker.list()).toHaveLength(2);
    w.tracker.clear();
    expect(w.tracker.list()).toEqual([]);
    // A call cut off by the exit adds nothing later.
    expect(w.tracker.resulted('t3', { text: BASH_STARTED('b3'), isError: false })).toBe(false);
  });
});

describe('the live activity with background tasks (ActivityTracker.snapshot)', () => {
  it('while a turn runs: the turn\'s state, the list rides along; after the turn: `background` since the oldest task; null once none is left', () => {
    let clock = T0;
    const now = () => new Date(clock);
    const activity = new ActivityTracker({ mainAgentId: 'main', now });
    const background = new BackgroundTracker({ now });
    activity.startTurn();
    activity.toolStarted('main', 't1', 'Bash', { command: GH_WAIT, run_in_background: true });
    background.called('t1', 'Bash', { command: GH_WAIT, run_in_background: true });
    clock += 1_000;
    activity.toolEnded('t1');
    background.resulted('t1', { text: BASH_STARTED('b1'), isError: false });
    const during = activity.snapshot(background.list());
    expect(during).toMatchObject({ state: 'thinking', turnStartedAt: iso(0), thinkingTokens: null });
    expect(during?.background).toEqual([
      { id: 'b1', toolUseId: 't1', kind: 'bash', summary: 'gh run view 4242 --json status --jq .status', startedAt: iso(0), github: true },
    ]);
    clock += 2_000;
    activity.endTurn();
    const after = activity.snapshot(background.list());
    expect(after).toEqual({
      turnStartedAt: iso(0),
      state: 'background',
      since: iso(0),
      tool: 'Bash',
      summary: 'gh run view 4242 --json status --jq .status',
      thinkingTokens: null,
      agents: { main: { state: 'background', since: iso(0), startedAt: iso(0), tool: 'Bash', summary: 'gh run view 4242 --json status --jq .status' } },
      background: during?.background,
    });
    background.notified('b1', 't1');
    expect(activity.snapshot(background.list())).toBeNull();
    // Without background tasks nothing changes (D19): idle is null, a turn has an empty list.
    expect(activity.snapshot()).toBeNull();
    activity.startTurn();
    expect(activity.snapshot()?.background).toEqual([]);
  });
});
