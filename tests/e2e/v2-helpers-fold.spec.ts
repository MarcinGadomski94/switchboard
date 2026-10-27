import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * 2026-10-27 · the helpers fold (`docs/v2.md` → *Helpers fold*), on the real
 * path (fake-claude): a session with 54 Workflow agents, two subagents and one
 * helper still working. While they ended under 10 minutes ago every helper
 * shows; once the browser's clock is 11 minutes later only the working one does,
 * the rest under "Show N helpers finished earlier" (expanded 50 at a time, then
 * "Show more"; collapsible again), the Timeline's lanes of the old ones under one
 * summary lane, the counts the active ones only. Desktop and 390 × 844.
 */
let world: QuestionWorld;
let sessionId = '';
const MINUTES_11 = 11 * 60_000;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  world = await startQuestionWorld('e2e-v2-helpers-fold', { env: { ...V2_SERVER_ENV } });
  const page = await browser.newPage();
  await stubToolProbes(page);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-fold', 'Fan out. [fake:workflow 1 9x6]');
  sessionId = id;
  await expect.poll(async () => (await detail(page, id)).workflows?.[0]?.status, { timeout: 60_000 }).toBe('done');
  await settled(page, id);
  for (const text of ['[fake:subagent-forward] Ask a subagent for the first line.', '[fake:subagent-forward] Ask another one.']) {
    await post(page, id, text);
    await settled(page, id);
  }
  // One helper keeps working in the background (an async agent for 5 minutes).
  await post(page, id, '[fake:bg-agent 300] Delegate the long audit.');
  // Its row ends at the launch (no task events); the live activity lists it as pending: it counts as active.
  await expect.poll(async () => (await detail(page, id)).activity?.background.filter((task) => task.kind === 'agent').length ?? 0, { timeout: 20_000 }).toBe(1);
  const agents = (await detail(page, id)).agents;
  expect(agents.filter((agent) => agent.kind === 'workflow')).toHaveLength(54);
  expect(agents.filter((agent) => agent.kind === 'subagent')).toHaveLength(3);
  await page.close();
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sid) => (await (await fetch(`/api/sessions/${encodeURIComponent(sid)}`)).json()) as SessionDetail, id);
}

async function settled(page: Page, id: string): Promise<void> {
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 30_000 }).toMatch(/^(done|idle)$/);
}

async function post(page: Page, id: string, text: string): Promise<void> {
  const status = await page.evaluate(
    async ({ sid, body }) => (await fetch(`/api/sessions/${encodeURIComponent(sid)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: body }) })).status,
    { sid: id, body: text },
  );
  expect(status).toBe(202);
}

test('desktop: recent helpers show, then fold live after 10 minutes; expand 50 at a time, Show more, collapse; the counts and the summary lane', async ({ page }) => {
  await page.clock.install({ time: Date.now() });
  await openWithHub(page, `${world.baseUrl}/agents/${sessionId}/helpers`);
  const tab = page.getByTestId('v2-agent-helpers-tab');
  // Every helper ended under 10 minutes ago: all 57 show, nothing folded.
  await expect(tab.getByTestId('v2-agent-helper-card')).toHaveCount(57);
  await expect(tab.getByTestId('v2-agent-helpers-earlier')).toHaveCount(0);
  // The working one first.
  await expect(tab.getByTestId('v2-agent-helper-card').first()).toContainText('fake-claude: delegated audit');
  // The tab's count: the active helpers only.
  await expect(page.getByTestId('v2-agent-tabs').getByRole('tab', { name: /Helpers/ })).toHaveText(/Helpers\s*1/);

  // 11 minutes later (the clock ticks at most once a minute): only the working one, the rest folded.
  await page.clock.fastForward(MINUTES_11);
  await expect(tab.getByTestId('v2-agent-helper-card')).toHaveCount(1);
  const toggle = tab.getByTestId('v2-agent-helpers-earlier');
  await expect(toggle).toHaveText('Show 56 helpers finished earlier');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(tab.getByTestId('v2-agent-helper-card')).toHaveCount(51);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const more = tab.getByTestId('v2-agent-helpers-more');
  await expect(more).toHaveText('Show 6 more (6 left)');
  await more.click();
  await expect(tab.getByTestId('v2-agent-helper-card')).toHaveCount(57);
  await expect(more).toHaveCount(0);
  await toggle.click();
  await expect(tab.getByTestId('v2-agent-helper-card')).toHaveCount(1);

  // The side panel's Helpers: the same fold, its summary counts the active ones.
  const group = page.getByTestId('v2-agent-side').getByTestId('v2-agent-group-helpers');
  await expect(group.locator('summary')).toContainText('1 active');
  await expect(group.getByTestId('v2-agent-side-helper')).toHaveCount(1);
  await expect(group.getByTestId('v2-agent-helpers-earlier')).toHaveText('Show 56 helpers finished earlier');
  await group.getByTestId('v2-agent-helpers-earlier').click();
  await expect(group.getByTestId('v2-agent-side-helper')).toHaveCount(51);
  await group.getByTestId('v2-agent-helpers-earlier').click();
  await expect(group.getByTestId('v2-agent-side-helper')).toHaveCount(1);

  // The Timeline: the two old subagents' lanes under one summary lane, expandable.
  await page.getByTestId('v2-agent-tabs').getByRole('tab', { name: /Timeline/ }).click();
  const summary = page.getByTestId('v2-agent-lane-earlier');
  await expect(summary).toContainText('2 earlier helpers');
  await expect(page.locator('[data-testid="v2-agent-lane"][data-earlier="true"]')).toHaveCount(0);
  await summary.getByTestId('v2-agent-lane-earlier-toggle').click();
  await expect(page.locator('[data-testid="v2-agent-lane"][data-earlier="true"]')).toHaveCount(2);
  await summary.getByTestId('v2-agent-lane-earlier-toggle').click();
  await expect(page.locator('[data-testid="v2-agent-lane"][data-earlier="true"]')).toHaveCount(0);
});

test('390 × 844: the Helpers tab and the Timeline fold the same way', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: Date.now() + MINUTES_11 });
  await openWithHub(page, `${world.baseUrl}/agents/${sessionId}/helpers`);
  const tab = page.getByTestId('v2-agent-helpers-tab');
  await expect(tab.getByTestId('v2-agent-helper-card')).toHaveCount(1);
  const toggle = tab.getByTestId('v2-agent-helpers-earlier');
  await expect(toggle).toHaveText('Show 56 helpers finished earlier');
  const box = await toggle.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await toggle.click();
  await expect(tab.getByTestId('v2-agent-helper-card')).toHaveCount(51);
  await toggle.click();
  await expect(tab.getByTestId('v2-agent-helper-card')).toHaveCount(1);
  await page.goto(`${world.baseUrl}/agents/${sessionId}/timeline`);
  const summary = page.getByTestId('v2-agent-lane-earlier');
  await expect(summary).toContainText('2 earlier helpers');
  const lane = await summary.getByTestId('v2-agent-lane-earlier-toggle').boundingBox();
  expect(lane?.height ?? 0).toBeGreaterThanOrEqual(44);
  await summary.getByTestId('v2-agent-lane-earlier-toggle').click();
  await expect(page.locator('[data-testid="v2-agent-lane"][data-earlier="true"]')).toHaveCount(2);
});
