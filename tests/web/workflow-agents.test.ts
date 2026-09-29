import { describe, expect, it } from 'vitest';
import type { Agent, AgentWorkflow, SessionActivity, WorkflowRun } from '../../src/core/api.ts';
import { backgroundText } from '../../src/web/activity/activity.ts';
import { overviewRows } from '../../src/web/views/session/agent-overview.ts';
import { hasSubagentChat } from '../../src/web/views/session/chat.ts';
import { isFinishedSubagent, panelAgents } from '../../src/web/views/session/right-panel.ts';
import {
  WORKFLOW_CARD_CAP,
  agentActivity,
  cappedCards,
  moreCardsLine,
  overviewEntries,
  workflowActivity,
  workflowBackgroundProgress,
  workflowProgressText,
  workflowRunStatusText,
} from '../../src/web/views/session/workflow-agents.ts';

/**
 * D51 in the right panel and the chat (`src/web/views/session/workflow-agents.ts`,
 * `docs/session-panel.md` → *Workflow agents*): a workflow agent's live action, the
 * overview's grouping under its run (with D37's fold), the cards' cap, which
 * workflow agents open a chat, and D43's background line with the run's progress.
 */

const RUN = 'wf_aaaa1111-bbb';

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: RUN,
    taskId: 'wk1',
    name: 'proj-audit',
    summary: 'Audit every repo',
    status: 'run',
    phase: 'Review',
    phases: ['Audit', 'Review'],
    agentCount: 4,
    doneCount: 2,
    failedCount: 0,
    startedAt: '2026-09-29T10:00:00.000Z',
    endedAt: null,
    ...overrides,
  };
}

function workflow(overrides: Partial<AgentWorkflow> = {}): AgentWorkflow {
  return { runId: RUN, index: 1, agentId: 'a1', phase: 'Audit', model: 'claude-opus-5-5', startedAt: '2026-09-29T10:00:01.000Z', endedAt: null, action: null, cwd: null, version: 10, ...overrides };
}

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return { id, kind: 'workflow', name: id, description: 'Audit', solutionPath: null, branch: null, status: 'run', statusText: null, toolUseId: null, workflow: workflow(), ...overrides };
}

const MAIN: Agent = { id: 'main', kind: 'main', name: 'orchestrator', description: null, solutionPath: null, branch: null, status: 'run', statusText: null, toolUseId: null, workflow: null };
const SUB: Agent = { ...MAIN, id: 'sub', kind: 'subagent', name: 'general-purpose', toolUseId: 'toolu_1' };

describe('a workflow agent\'s live action', () => {
  it('its last tool timed since that call, else thinking since it started; nothing unless it runs', () => {
    const tool = agent('x', { workflow: workflow({ action: { tool: 'Read', summary: 'a.md', since: '2026-09-29T10:00:05.000Z' } }) });
    expect(workflowActivity(tool)).toEqual({ state: 'tool', since: '2026-09-29T10:00:05.000Z', startedAt: '2026-09-29T10:00:01.000Z', tool: 'Read', summary: 'a.md' });
    expect(workflowActivity(agent('y'))).toEqual({ state: 'thinking', since: '2026-09-29T10:00:01.000Z', startedAt: '2026-09-29T10:00:01.000Z', tool: null, summary: null });
    expect(workflowActivity(agent('z', { status: 'done' }))).toBeNull();
    expect(workflowActivity(agent('q', { status: 'idle', statusText: 'queued', workflow: workflow({ agentId: null, startedAt: null }) }))).toBeNull();
    expect(workflowActivity(SUB)).toBeNull();
    // The session's own entry wins (a subagent's, the main agent's).
    const activity = { agents: { x: { state: 'writing', since: 's', startedAt: 's', tool: null, summary: null } } } as unknown as SessionActivity;
    expect(agentActivity(activity, tool)?.state).toBe('writing');
    expect(agentActivity(null, tool)?.state).toBe('tool');
  });
});

describe('the overview in D51\'s grouping', () => {
  it('the other agents first, then each run\'s row and its agents indented; done ones folded (D37), a done run with none left gone', () => {
    const agents = [MAIN, SUB, agent('a1', { status: 'done' }), agent('a2'), agent('q3', { status: 'idle', statusText: 'queued', workflow: workflow({ agentId: null, index: 3, phase: 'Review' }) })];
    const shown = agents.filter((a) => !isFinishedSubagent(a));
    const entries = overviewEntries(shown, [run()]);
    expect(entries.map((e) => (e.kind === 'workflow' ? `run:${e.run.name}:${e.statusText}` : `${e.depth}:${e.agent.id}`))).toEqual([
      '0:main',
      '0:sub',
      'run:proj-audit:● 2/4 done · phase Review',
      '1:a2',
      '1:q3',
    ]);
    const finished = overviewEntries([MAIN], [run({ status: 'done', doneCount: 4 })]);
    expect(finished.map((e) => e.kind)).toEqual(['agent']);
    // A run that stopped keeps its row (its agents were cut off, not finished).
    expect(overviewEntries([MAIN], [run({ status: 'idle' })]).map((e) => (e.kind === 'workflow' ? e.statusText : e.agent.id))).toEqual(['main', 'stopped · 2/4 done']);
    // A workflow agent's row: its phase as the description, `—` without a solution, `queued` as its status text.
    const rows = overviewRows(agents.slice(3), { status: 'run', task: '' });
    expect(rows.map((r) => [r.name, r.description, r.solution, r.statusText])).toEqual([
      ['a2', 'Audit', '—', '● running'],
      ['q3', 'Audit', '—', 'queued'],
    ]);
  });

  it('the run\'s status words and the progress line', () => {
    expect(workflowRunStatusText(run())).toBe('● 2/4 done · phase Review');
    expect(workflowRunStatusText(run({ phase: null }))).toBe('● 2/4 done');
    expect(workflowRunStatusText(run({ status: 'done', doneCount: 4 }))).toBe('✓ 4/4 done');
    expect(workflowRunStatusText(run({ status: 'fail', doneCount: 1 }))).toBe('✕ failed · 1/4 done');
    expect(workflowProgressText(run({ doneCount: 3, agentCount: 7 }))).toBe('3/7 agents done · phase Review');
    expect(workflowBackgroundProgress({ doneCount: 0, agentCount: 0, phase: null })).toBeNull();
    expect(workflowBackgroundProgress(null)).toBeNull();
  });
});

describe('the agent cards', () => {
  it(`at most ${WORKFLOW_CARD_CAP} per run (running first), the rest one "+N more" line; all while expanded`, () => {
    const many = Array.from({ length: 9 }, (_, i) => agent(`w${i + 1}`, { status: i < 2 ? 'idle' : 'run' }));
    const shown = [MAIN, ...many];
    const capped = cappedCards(shown, [run({ name: 'fan-out' })], false);
    expect(capped.cards).toHaveLength(1 + WORKFLOW_CARD_CAP);
    expect(capped.cards.slice(1).every((a) => a.status === 'run')).toBe(true);
    expect(capped.more).toEqual([{ runId: RUN, name: 'fan-out', count: 3 }]);
    expect(moreCardsLine(capped.more[0] ?? { runId: '', name: '', count: 0 })).toBe('+3 more in fan-out');
    expect(cappedCards(shown, [run()], true)).toEqual({ cards: shown, more: [] });
    expect(cappedCards([MAIN, agent('x')], [run()], false)).toEqual({ cards: [MAIN, agent('x')], more: [] });
    // D37: finished workflow agents fold under "✓ N finished" like subagents; the summary counts them all.
    expect(panelAgents([MAIN, agent('d', { status: 'done' }), agent('r')], false)).toEqual({ shown: [MAIN, agent('r')], finished: 1 });
  });
});

describe('chats and the background line', () => {
  it('a workflow agent opens a chat once it has a transcript (its agent id); a queued one does not', () => {
    expect(hasSubagentChat(agent('x'))).toBe(true);
    expect(hasSubagentChat(agent('q', { workflow: workflow({ agentId: null }) }))).toBe(false);
    expect(hasSubagentChat(SUB)).toBe(true);
    expect(hasSubagentChat(MAIN)).toBe(false);
  });

  it('D43\'s "Running a workflow" line gains the run\'s progress once its agents are known', () => {
    const task = { kind: 'workflow' as const, summary: 'Audit every repo', github: false };
    expect(backgroundText(task)).toBe('Running a workflow: Audit every repo');
    expect(backgroundText({ ...task, workflow: { runId: RUN, doneCount: 0, agentCount: 0, phase: null } })).toBe('Running a workflow: Audit every repo');
    expect(backgroundText({ ...task, workflow: { runId: RUN, doneCount: 3, agentCount: 7, phase: 'Review' } })).toBe('Running a workflow: Audit every repo · 3/7 agents done · phase Review');
  });
});
