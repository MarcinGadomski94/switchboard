import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { FAKE_WORKFLOW_NAME, FAKE_WORKFLOW_SUMMARY } from '../../tools/fake-claude/scenarios.ts';
import { fakeAgentBrief, fakeAgentLabel, fakeAgentText } from '../../tools/fake-claude/workflow.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D51 on the real path (`node src/server/main.ts`, fake-claude, no demo seed): a
 * background Workflow of 2 phases × 2 agents (`[fake:workflow 24 2x2]`: phase 1
 * runs from 0 to ~10 s, phase 2 from ~11 to ~21 s, the run file at ~23 s, the end at
 * 24 s). Live over `/hub`: the overview's workflow row with its agents indented,
 * their cards with their action, D43's line with the counts; one agent's chat opens
 * from its row and updates while it runs; finished agents fold ("✓ N finished");
 * a reload and a Switchboard restart keep them.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('workflow-agents');
});

test.afterAll(async () => {
  await world?.stop();
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return (await response.json()) as SessionDetail;
  }, id);
}

test('a workflow\'s agents: grouped rows live, a chat that updates, finished ones fold, kept across a reload and a restart', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'workflow-agents-e2e', 'Audit the fixtures with a workflow. [fake:workflow 24 2x2]');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const panel = page.getByTestId('session-right-panel');

  // The overview: the run's row (name, summary, progress), its first phase's agents indented under it.
  const runRow = panel.getByTestId('overview-workflow');
  await expect(runRow).toHaveCount(1, { timeout: 15_000 });
  await expect(runRow.getByTestId('overview-workflow-name')).toHaveText(FAKE_WORKFLOW_NAME);
  await expect(runRow.getByTestId('overview-workflow-summary')).toHaveText(FAKE_WORKFLOW_SUMMARY);
  await expect(runRow.getByTestId('overview-workflow-status')).toContainText('phase Audit');
  await expect(runRow).toHaveAttribute('data-status', 'run');
  const runId = await runRow.getAttribute('data-run-id');
  expect(runId).toMatch(/^wf_/);
  const rows = panel.locator(`[data-testid="overview-row"][data-run-id="${runId}"]`);
  await expect(rows.getByTestId('overview-agent')).toHaveText([fakeAgentLabel(0, 1), fakeAgentLabel(0, 2)]);
  await expect(rows.first()).toHaveClass(/sb-overview-row--nested/);
  await expect(rows.first().getByTestId('overview-description')).toHaveText('Audit');
  await expect(rows.first().getByTestId('overview-solution')).toHaveText('—');
  // The rows come right after the run's row (the main agent's row first).
  const order = await panel.locator('[data-testid="overview-table"] tbody tr').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-testid')));
  expect(order).toEqual(['overview-row', 'overview-workflow', 'overview-row', 'overview-row']);

  // D43's line with the counts; the running agents' cards and rows show their action once they called a tool.
  await expect(page.getByTestId('chat-activity-text')).toHaveText(new RegExp(`^Running a workflow: ${FAKE_WORKFLOW_SUMMARY} · \\d/\\d agents done · phase Audit$`));
  const first = await detail(page, id).then((d) => d.agents.find((agent) => agent.name === fakeAgentLabel(0, 1)));
  expect(first?.kind).toBe('workflow');
  const firstId = first?.id ?? '';
  const card = panel.locator(`[data-testid="agent-card"][data-agent-id="${firstId}"]`);
  await expect(card.getByTestId('agent-name')).toHaveText(fakeAgentLabel(0, 1));
  await expect(card.getByTestId('agent-activity')).toContainText('Read', { timeout: 15_000 });
  await expect(rows.first().getByTestId('overview-activity')).toContainText('● Read');

  // Its chat opens from its row: the brief from the workflow, then its text arrives while it runs, then its result.
  await rows.first().getByTestId('overview-open').click();
  await expect(page).toHaveURL(`${world.baseUrl}/sessions/${id}/agents/${encodeURIComponent(firstId)}`);
  await expect(page.getByTestId('subagent-title')).toHaveText(`${fakeAgentLabel(0, 1)}: Audit`);
  await expect(page.getByTestId('subagent-brief-label')).toHaveText('Brief from the workflow');
  await expect(page.getByTestId('subagent-brief')).toContainText(fakeAgentBrief(0, 1).split('\n')[0] ?? '');
  await expect(page.getByTestId('subagent-note')).toContainText('Workflow agents take no messages');
  await expect(page.getByTestId('subagent-chat')).toContainText(fakeAgentText(fakeAgentLabel(0, 1)), { timeout: 15_000 });
  await expect(page.getByTestId('subagent-result')).toContainText('"ok": true', { timeout: 15_000 });
  await expect(page.getByTestId('subagent-bar')).toHaveAttribute('data-status', 'done');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(`${world.baseUrl}/sessions/${id}`);

  // Phase 1 done: its agents fold ("✓ 2 finished"), phase 2's run; the run's row moves on.
  await expect(panel.getByTestId('agents-finished')).toHaveText('✓ 2 finished', { timeout: 15_000 });
  await expect(rows.getByTestId('overview-agent')).toHaveText([fakeAgentLabel(1, 1), fakeAgentLabel(1, 2)], { timeout: 15_000 });
  await expect(runRow.getByTestId('overview-workflow-status')).toContainText('2/4 done · phase Review');

  // The run ends: its row goes, every agent folded; the CLI's own turn follows.
  await expect(runRow).toHaveCount(0, { timeout: 30_000 });
  await expect(panel.getByTestId('agents-finished')).toHaveText('✓ 4 finished');
  await expect(page.getByTestId('session-chat')).toContainText('FINISHED', { timeout: 30_000 });
  expect((await detail(page, id)).workflows).toMatchObject([{ runId, status: 'done', agentCount: 4, doneCount: 4 }]);
  await expect(panel.getByTestId('agents-summary')).toContainText('5 agents');

  // A reload keeps them; expanded, the finished cards open their chats.
  await page.reload();
  await expect(panel.getByTestId('agents-finished')).toHaveText('✓ 4 finished');
  await panel.getByTestId('agents-finished').click();
  await expect(panel.locator('[data-testid="agent-card"][data-status="done"]').getByTestId('agent-name')).toContainText([fakeAgentLabel(0, 1), fakeAgentLabel(0, 2), fakeAgentLabel(1, 1), fakeAgentLabel(1, 2)]);

  // A Switchboard restart: the same, read back from the CLI's files.
  await world.restart();
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(panel.getByTestId('agents-finished')).toHaveText('✓ 4 finished');
  expect((await detail(page, id)).workflows).toMatchObject([{ runId, status: 'done', agentCount: 4, doneCount: 4 }]);
  await page.goto(`${world.baseUrl}/sessions/${id}/agents/${encodeURIComponent(firstId)}`);
  await expect(page.getByTestId('subagent-chat')).toContainText(fakeAgentText(fakeAgentLabel(0, 1)));
  await expect(page.getByTestId('subagent-result')).toContainText('"ok": true');
});
