import { describe, expect, it } from 'vitest';
import { PLAN_ITEM_STATES, PLAN_PICK_REPOS_REASON, PLAN_STOPPED_NO_MESSAGE, type Plan, type PlanItem } from '../../src/core/plans.ts';
import { MODE_LABELS, STATUS, STEP_LABELS, ordinal } from '../../src/web/v2/glossary.ts';
import {
  BOARD_COLUMNS,
  MODE_ORDER,
  axisPercent,
  boardColumn,
  boardColumns,
  canStart,
  checkStepEdit,
  checkSubfolder,
  earlyStart,
  estimateLine,
  jiraTag,
  modeLabel,
  modeOptions,
  needsProtectedAck,
  projectCounts,
  projectNotesHref,
  projectStatus,
  projectsTimeline,
  protectedAckText,
  readPhoneProjectView,
  readProjectView,
  remoteBlock,
  reopenedNotice,
  sortProjects,
  stepActions,
  stepKind,
  stepLook,
  stepName,
  stepNeedsYou,
  restartableSteps,
  stepOpens,
  timeLeft,
  waitingOn,
} from '../../src/web/v2/projects/project-model.ts';

/**
 * D131 · lane P · the Projects pages' pure rules (`src/web/v2/projects/project-model.ts`): every
 * step state in v2 words (D115 pick, D120 stopped, D121 reopened / early start, D124 needs you),
 * the approval modes and the protected-destination acknowledgement, the board's columns, the
 * step menu with its reasons, the list's counts and order, the Timeline's bars.
 */

const T0 = Date.parse('2026-10-25T08:00:00.000Z');
const iso = (hours: number): string => new Date(T0 + hours * 3_600_000).toISOString();

function item(id: string, patch: Partial<PlanItem> = {}): PlanItem {
  return {
    id,
    todoId: `t-${id}`,
    key: `PROJ-${id}`,
    title: `PROJ-${id} Ticket ${id}`,
    hold: false,
    solutions: [],
    state: 'waiting',
    reason: null,
    note: null,
    storedState: 'pending',
    waitingOn: null,
    dependsOn: [],
    runSessionId: null,
    branch: null,
    prUrl: null,
    checks: null,
    developerMerges: false,
    developerConfirms: false,
    estimateMinutes: 60,
    actualMinutes: null,
    onCriticalPath: false,
    position: Number(id),
    startedAt: null,
    waitingSince: null,
    mergedAt: null,
    doneAt: null,
    spans: [],
    ...patch,
  };
}

function plan(items: readonly PlanItem[], patch: Partial<Plan> = {}): Plan {
  return {
    id: 'p1',
    title: 'PROJ-100 Acme checkout',
    sourceSessionId: 's1',
    targetBranch: 'feature/PROJ-100-acme-epic',
    allowProtectedTarget: false,
    repos: ['acme'],
    baseBranch: 'dev',
    mergeMode: null,
    maxConcurrency: 3,
    usageThreshold: 85,
    answers: null,
    state: 'draft',
    external: null,
    held: null,
    pausedReason: null,
    items,
    edges: [],
    criticalPath: { itemIds: [], minutes: 0 },
    progress: { done: items.filter((entry) => entry.state === 'done').length, total: items.length, percent: 0 },
    estimatedMinutesLeft: 180,
    createdAt: iso(0),
    updatedAt: iso(0),
    startedAt: null,
    finishedAt: null,
    machine: null,
    ...patch,
  };
}

describe('step states', () => {
  it('maps every server state to a v2 kind, status and word (icon + word + colour)', () => {
    for (const state of PLAN_ITEM_STATES) {
      const look = stepLook(item('1', { state }), []);
      expect(STATUS[look.status]).toBeDefined();
      expect(look.label.length).toBeGreaterThan(0);
    }
    expect(stepLook(item('1', { state: 'running' }), [])).toMatchObject({ kind: 'running', status: 'working', label: 'Working' });
    expect(stepLook(item('1', { state: 'running', waitingOn: 'checks' }), []).label).toBe(STEP_LABELS.runningTests);
    expect(stepLook(item('1', { state: 'ready' }), [])).toMatchObject({ kind: 'ready', status: 'queued', label: 'Ready to start' });
    expect(stepLook(item('1', { state: 'question' }), [])).toMatchObject({ kind: 'question', status: 'needs' });
    expect(stepLook(item('1', { state: 'done' }), [])).toMatchObject({ kind: 'done', status: 'done', label: 'Done' });
    expect(stepLook(item('1', { state: 'ready-to-merge' }), [])).toMatchObject({ kind: 'approval', status: 'ready', label: 'Ready for approval' });
    expect(stepLook(item('1', { state: 'to-confirm' }), [])).toMatchObject({ kind: 'confirm', status: 'ready' });
    expect(stepLook(item('1', { state: 'blocked', reason: 'waiting on PROJ-2, which was discarded' }), [])).toMatchObject({ kind: 'blocked', status: 'stopped', label: 'Blocked', detail: 'waiting on PROJ-2, which was discarded' });
  });

  it('D124: a step whose agent waits for you is amber "Needs you" with the ask', () => {
    const look = stepLook(item('1', { state: 'needs-you', reason: 'Which payment provider?' }), []);
    expect(look).toMatchObject({ kind: 'needs', status: 'needs', label: 'Needs you', detail: 'Which payment provider?' });
    expect(STATUS[look.status].tone).toBe('amber');
  });

  it('D120: a stopped step is red "Stopped — needs you" with the agent’s last message', () => {
    const look = stepLook(item('1', { state: 'stopped', reason: 'Not finished: re-run one CI check.' }), []);
    expect(look).toMatchObject({ kind: 'stopped', status: 'stopped', label: 'Stopped — needs you', detail: 'Not finished: re-run one CI check.' });
    expect(STATUS[look.status].tone).toBe('red');
    expect(stepLook(item('1', { state: 'stopped' }), []).detail).toBe(PLAN_STOPPED_NO_MESSAGE);
  });

  it('D115: a step without code projects waits for the project agent to pick them', () => {
    const look = stepLook(item('1', { state: 'waiting', reason: PLAN_PICK_REPOS_REASON }), []);
    expect(look).toMatchObject({ kind: 'pick', status: 'queued', label: 'Waiting for the project agent to pick code projects' });
    expect(stepKind(item('1', { state: 'waiting' }))).toBe('waiting');
  });

  it('a waiting step says what it waits on (open dependencies only)', () => {
    const a = item('1', { state: 'running' });
    const b = item('2', { state: 'done' });
    const c = item('3', { dependsOn: ['1', '2'] });
    expect(waitingOn(c, [a, b, c])).toBe('Waiting on 1');
    expect(stepLook(c, [a, b, c]).detail).toBe('Waiting on 1');
    expect(waitingOn(item('4'), [])).toBeNull();
  });

  it('D121: the reopened notice and the early-start warning come from the note', () => {
    const reopened = item('1', { note: 'Reopened: it was marked merged but its branch isn’t in feature/x; started before PROJ-2 was merged — its branch may lack that work' });
    expect(reopenedNotice(reopened)).toBe('Reopened: it was marked merged but its branch isn’t in feature/x');
    expect(earlyStart(reopened)).toBe('started before PROJ-2 was merged — its branch may lack that work');
    expect(reopenedNotice(item('2', { note: 'merged by you into dev' }))).toBeNull();
    expect(earlyStart(item('3'))).toBeNull();
  });

  it('estimate vs actual', () => {
    expect(estimateLine(item('1', { estimateMinutes: 30, actualMinutes: 45, state: 'done' }))).toBe('est 30m · took 45m');
    expect(estimateLine(item('1', { estimateMinutes: 90, actualMinutes: 20, state: 'running' }))).toBe('est 1.5h · so far 20m');
    expect(estimateLine(item('1', { estimateMinutes: null }))).toBeNull();
  });

  it('which steps need you', () => {
    expect(['question', 'needs-you', 'stopped', 'ready-to-merge', 'to-confirm'].every((state) => stepNeedsYou(item('1', { state: state as PlanItem['state'] })))).toBe(true);
    expect(['waiting', 'ready', 'running', 'done', 'blocked'].some((state) => stepNeedsYou(item('1', { state: state as PlanItem['state'] })))).toBe(false);
  });

  it('a step’s name keeps a title that already starts with its key', () => {
    expect(stepName(item('1'))).toBe('PROJ-1 Ticket 1');
    expect(stepName(item('1', { title: 'API' }))).toBe('PROJ-1 API');
    expect(stepName(item('1', { key: null, title: 'Docs' }))).toBe('Docs');
  });

  it('a click opens the step’s agent when it has one, else its details', () => {
    expect(stepOpens(item('1', { runSessionId: 's9' }))).toEqual({ agent: 's9' });
    expect(stepOpens(item('1'))).toEqual({ detail: true });
    // D139: a failed or stopped step opens its details (Try again / Restart there), not its stopped agent.
    expect(stepOpens(item('1', { runSessionId: 's9', state: 'stopped', storedState: 'running', stoppedBy: 'account' }))).toEqual({ detail: true });
    expect(stepOpens(item('1', { runSessionId: 's9', state: 'blocked', storedState: 'failed' }))).toEqual({ detail: true });
  });
});

describe('approval modes', () => {
  it('the four modes in plain words, and "not chosen yet"', () => {
    expect(MODE_ORDER).toEqual(['agents', 'agents-with-holds', 'developer', 'none']);
    expect(modeLabel('agents')).toBe('Agents combine on their own');
    expect(modeLabel('agents-with-holds')).toBe('Agents combine, I approve marked steps');
    expect(modeLabel('developer')).toBe('I approve each');
    expect(modeLabel('none')).toBe('No combining (finish when done)');
    expect(modeLabel(null)).toBe(MODE_LABELS.unset);
  });

  it('a project without a target offers only "No combining"', () => {
    expect(modeOptions({ targetBranch: null })).toEqual(['none']);
    expect(modeOptions({ targetBranch: 'feature/x' })).toEqual(MODE_ORDER);
  });

  it('the protected-destination acknowledgement: agent modes into dev / main / master / develop', () => {
    expect(needsProtectedAck({ targetBranch: 'dev' }, 'agents')).toBe(true);
    expect(needsProtectedAck({ targetBranch: 'main' }, 'agents-with-holds')).toBe(true);
    expect(needsProtectedAck({ targetBranch: 'dev' }, 'developer')).toBe(false);
    expect(needsProtectedAck({ targetBranch: 'feature/x' }, 'agents')).toBe(false);
    expect(needsProtectedAck({ targetBranch: 'release' }, 'agents', true)).toBe(true);
    expect(protectedAckText({ targetBranch: 'dev' })).toBe('Agents will combine straight into dev');
  });

  it('Start needs a step, a mode and (when needed) the acknowledgement', () => {
    const p = plan([item('1')], { targetBranch: 'dev' });
    expect(canStart(plan([]), 'agents', false)).toEqual({ ok: false, why: 'Add a step first.' });
    expect(canStart(p, null, false).ok).toBe(false);
    expect(canStart(p, 'agents', false)).toEqual({ ok: false, why: 'Tick “Agents will combine straight into dev” to start.' });
    expect(canStart(p, 'agents', true).ok).toBe(true);
    expect(canStart(p, 'developer', false).ok).toBe(true);
  });

  it('D130: the subfolder is at most 60 characters (empty = none)', () => {
    expect(checkSubfolder('')).toBeNull();
    expect(checkSubfolder('Plan · PROJ-10')).toBeNull();
    expect(checkSubfolder('x'.repeat(61))).toBe('At most 60 characters.');
  });
});

describe('the step menu', () => {
  const running = plan([], { state: 'running', mergeMode: 'developer' });
  const ids = (actions: ReturnType<typeof stepActions>) => actions.map((action) => action.id);
  const why = (actions: ReturnType<typeof stepActions>, id: string) => actions.find((action) => action.id === id)?.disabledReason;

  it('has Hold, Reopen, Try again, Mark done, Open change request, Edit and Remove, each with its reason', () => {
    const pending = stepActions(running, item('1'));
    expect(ids(pending)).toEqual(['hold', 'reopen', 'retry', 'restart', 'done', 'change', 'edit', 'remove']);
    expect(why(pending, 'restart')).toBe('Only a step whose agent stopped with an error can be restarted.');
    expect(why(pending, 'hold')).toBeUndefined();
    expect(why(pending, 'reopen')).toBe('Only done steps can be reopened.');
    expect(why(pending, 'retry')).toBe('Only a failed step can be tried again.');
    expect(why(pending, 'change')).toBe('No change request yet.');
    expect(why(pending, 'edit')).toBeUndefined();
    expect(why(pending, 'remove')).toBeUndefined();
  });

  it('a held step offers Release hold', () => {
    expect(ids(stepActions(running, item('1', { hold: true })))[0]).toBe('release');
  });

  it('D121: a done step of a running project can be reopened, not held, edited or removed', () => {
    const done = stepActions(running, item('1', { state: 'done', storedState: 'done' }));
    expect(why(done, 'reopen')).toBeUndefined();
    expect(why(done, 'hold')).toBe('Done steps can’t be held; reopen it instead.');
    expect(why(done, 'edit')).toBe('Only a step that hasn’t started can be edited.');
    expect(why(done, 'remove')).toBe('A running or done step can’t be removed.');
    expect(why(stepActions(plan([], { state: 'draft' }), item('1', { state: 'done', storedState: 'done' })), 'reopen')).toBe('Start the project first.');
  });

  it('D139: a step whose agent failed can be restarted (also when its account needed you); the project counts them', () => {
    const stopped = item('1', { state: 'stopped', storedState: 'running', runSessionId: 's1', stoppedBy: 'account', reason: "Stopped (account needs you): the account Work needs you — accept Anthropic's updated terms" });
    expect(why(stepActions(running, stopped), 'restart')).toBeUndefined();
    expect(stepLook(stopped, [stopped])).toMatchObject({ kind: 'stopped', label: 'Stopped (account needs you)', detail: "the account Work needs you — accept Anthropic's updated terms" });
    expect(restartableSteps(plan([stopped, item('2')], { state: 'running' })).map((entry) => entry.id)).toEqual(['1']);
    expect(restartableSteps(plan([stopped], { state: 'done' }))).toEqual([]);
  });

  it('a failed step can be tried again; a step ready for approval opens its change request', () => {
    expect(why(stepActions(running, item('1', { state: 'blocked', storedState: 'failed' })), 'retry')).toBeUndefined();
    expect(why(stepActions(running, item('1', { state: 'ready-to-merge', storedState: 'running' })), 'change')).toBeUndefined();
    expect(why(stepActions(running, item('1', { prUrl: 'https://example.invalid/pr/1' })), 'change')).toBeUndefined();
    expect(why(stepActions(plan([], { state: 'running', mergeMode: 'none', targetBranch: null }), item('1', { state: 'ready-to-merge' })), 'change')).toBe('This project has no combine step.');
  });

  it('a finished project, or a paired computer offline, disables every action with the reason', () => {
    const offline = plan([], { state: 'running', machine: { id: 'm', name: 'Studio-PC', state: 'offline' } });
    expect(remoteBlock(offline)).toBe('Studio-PC is offline; it can change once it reconnects.');
    expect(stepActions(offline, item('1')).every((action) => action.disabledReason === remoteBlock(offline))).toBe(true);
    expect(stepActions(plan([], { state: 'done' }), item('1')).every((action) => action.disabledReason === 'The project is done.')).toBe(true);
    expect(remoteBlock(plan([], { machine: { id: 'm', name: 'Studio-PC', state: 'online' } }))).toBeNull();
  });

  it('D129: the edit checks the title and the estimate', () => {
    expect(checkStepEdit('', '30')).toEqual({ field: 'title', message: 'Give the step a title.' });
    expect(checkStepEdit('API', 'x')).toEqual({ field: 'estimate', message: 'Minutes, a whole number from 1.' });
    expect(checkStepEdit('API', '0')?.field).toBe('estimate');
    expect(checkStepEdit('API', '')).toBeNull();
    expect(checkStepEdit('API', '45')).toBeNull();
  });
});

describe('the board', () => {
  it('Needs you · Working · Ready for approval · Done; waiting steps sit with the working ones', () => {
    expect(BOARD_COLUMNS).toEqual(['needs', 'working', 'ready', 'done']);
    expect(boardColumn(item('1', { state: 'stopped' }))).toBe('needs');
    expect(boardColumn(item('1', { state: 'blocked' }))).toBe('needs');
    expect(boardColumn(item('1', { state: 'needs-you' }))).toBe('needs');
    expect(boardColumn(item('1', { state: 'waiting' }))).toBe('working');
    expect(boardColumn(item('1', { state: 'running' }))).toBe('working');
    expect(boardColumn(item('1', { state: 'to-confirm' }))).toBe('ready');
    expect(boardColumn(item('1', { state: 'done' }))).toBe('done');
    const columns = boardColumns([item('2', { state: 'running' }), item('1', { state: 'running' }), item('3', { state: 'done' })]);
    expect(columns.working.map((entry) => entry.id)).toEqual(['1', '2']);
    expect(columns.done.map((entry) => entry.id)).toEqual(['3']);
  });
});

describe('What agents know (lane X)', () => {
  it('links to Notes scoped to the folder of the project’s own agent; a paired computer’s by its remote id; else every note', () => {
    const plan = { sourceSessionId: 's1', machine: null };
    const sessions = [{ id: 's1', folderPath: '/x/acme checkout', cwd: '/x/acme checkout/wt' }, { id: 's2', folderPath: null, cwd: '/x/other' }];
    expect(projectNotesHref(plan, sessions)).toBe('/notes?scope=%2Fx%2Facme%20checkout');
    expect(projectNotesHref({ sourceSessionId: 's2', machine: null }, sessions)).toBe('/notes?scope=%2Fx%2Fother');
    expect(projectNotesHref({ sourceSessionId: 's9', machine: { id: 'm2', name: 'Studio-PC', state: 'online' } }, [{ id: 'r~m2~s9', folderPath: '/y/acme', cwd: null }])).toBe('/notes?scope=%2Fy%2Facme');
    expect(projectNotesHref({ sourceSessionId: 'gone', machine: null }, sessions)).toBe('/notes');
    expect(projectNotesHref(plan, [{ id: 's1', folderPath: null, cwd: null }])).toBe('/notes');
  });
});

describe('the list', () => {
  it('counts done, running, ready for approval, needs you and stopped', () => {
    const p = plan([item('1', { state: 'done' }), item('2', { state: 'running' }), item('3', { state: 'ready-to-merge' }), item('4', { state: 'stopped' }), item('5', { state: 'blocked' }), item('6', { state: 'needs-you' })]);
    expect(projectCounts(p)).toEqual({ done: 1, total: 6, running: 1, approval: 1, needsYou: 3, stopped: 2 });
  });

  it('the project’s status, time left and Jira tag', () => {
    expect(projectStatus(plan([], { state: 'draft' }))).toEqual({ status: 'idle', label: 'Not started' });
    expect(projectStatus(plan([item('1', { state: 'running' })], { state: 'running' })).status).toBe('working');
    expect(projectStatus(plan([item('1')], { state: 'running' })).status).toBe('queued');
    expect(projectStatus(plan([], { state: 'paused' })).label).toBe('On hold');
    expect(timeLeft(plan([], { estimatedMinutesLeft: 180, state: 'running' }))).toBe('about 3h left');
    expect(timeLeft(plan([], { estimatedMinutesLeft: null }))).toBeNull();
    expect(timeLeft(plan([], { state: 'done' }))).toBeNull();
    expect(jiraTag(plan([], { external: { system: 'jira', key: 'PROJ-10' } }))).toBe('PROJ-10');
    expect(jiraTag(plan([]))).toBeNull();
  });

  it('orders projects that need you first, then running, drafts and paused, finished last', () => {
    const needs = plan([item('1', { state: 'stopped' })], { id: 'a', state: 'running', createdAt: iso(1) });
    const running = plan([item('1', { state: 'running' })], { id: 'b', state: 'running', createdAt: iso(2) });
    const draft = plan([], { id: 'c', state: 'draft', createdAt: iso(3) });
    const done = plan([], { id: 'd', state: 'done', createdAt: iso(4) });
    expect(sortProjects([done, draft, running, needs]).map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('the view is remembered and checked', () => {
    expect(readProjectView('graph')).toBe('graph');
    expect(readProjectView('nope')).toBe('steps');
    expect(readProjectView(null)).toBe('steps');
    // A phone offers Steps and Graph; Steps unless Graph was chosen there.
    expect(readPhoneProjectView('graph')).toBe('graph');
    expect(readPhoneProjectView('board')).toBe('steps');
    expect(readPhoneProjectView(null)).toBe('steps');
  });
});

describe('the Projects Timeline', () => {
  it('one bar per started project, a done one ends at its finish, an open one at its projected end', () => {
    const now = T0 + 5 * 3_600_000;
    const done = plan([item('1', { state: 'done' })], { id: 'a', state: 'done', startedAt: iso(0), finishedAt: iso(2) });
    const open = plan([item('1', { state: 'running', storedState: 'running', startedAt: iso(3) })], { id: 'b', state: 'running', startedAt: iso(3) });
    const draft = plan([], { id: 'c', state: 'draft' });
    const view = projectsTimeline([done, open, draft], now);
    expect(view.bars.map((bar) => bar.planId)).toEqual(['a', 'b']);
    expect(view.bars[0]).toMatchObject({ from: T0, to: T0 + 2 * 3_600_000, projected: false, status: 'done' });
    expect(view.bars[1]?.projected).toBe(true);
    expect(view.bars[1]?.to).toBeGreaterThanOrEqual(now);
    expect(view.start).toBe(T0);
    expect(axisPercent(T0, view.start, view.end)).toBe(0);
    expect(axisPercent(view.end + 1, view.start, view.end)).toBe(100);
    expect(projectsTimeline([], now).bars).toEqual([]);
  });
});

describe('the glossary', () => {
  it('ordinals for the crews’ order', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 103].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '103rd']);
  });
});
