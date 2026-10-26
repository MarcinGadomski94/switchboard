import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.0 · the agent's loops and schedules in the v2 agent view, as classic
 * shows them in the session: a Switchboard loop made by the agent's `loop_create`
 * (real MCP call) and a CLI-managed `CronCreate` schedule. The dock's status row
 * shows "Next: … HH:MM · 2 routines" without opening the side panel; its popover
 * lists both (the CLI one's actions disabled with the reason); Pause / Resume and
 * Run now work; the chat shows the creation rows and the firing's chip; the side
 * panel's Routines group lists the same; the peek and a phone show the indicator.
 */
let world: QuestionWorld;
let sessionId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-agent-routines', { env: { ...V2_SERVER_ENV, FAKE_CLAUDE_MCP_RUN: '1' } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function settled(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => page.evaluate(async (sid) => ((await (await fetch(`/api/sessions/${encodeURIComponent(sid)}`)).json()) as SessionDetail).status, id), { timeout: 20_000 })
    .toMatch(/^(done|idle)$/);
}

async function post(page: Page, id: string, text: string): Promise<void> {
  const status = await page.evaluate(
    async ({ sid, body }) => (await fetch(`/api/sessions/${encodeURIComponent(sid)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: body }) })).status,
    { sid: id, body: text },
  );
  expect(status).toBe(202);
}

const LOOP_CREATE = `Set up the check. [fake:tool mcp__switchboard__loop_create ${JSON.stringify({ prompt: 'Check the Acme queue and report.', every_minutes: 45, label: 'Nightly check' })}]`;
const CRON_CREATE = `Watch the build. [fake:tool CronCreate ${JSON.stringify({ cron: '*/30 * * * *', prompt: 'check the Acme build', recurring: true })}]`;

test('setup: a Switchboard loop (loop_create) and a CLI schedule (CronCreate)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'acme-routines', LOOP_CREATE);
  sessionId = id;
  await settled(page, id);
  await post(page, id, CRON_CREATE);
  await settled(page, id);
  await expect
    .poll(async () => page.evaluate(async (sid) => {
      const s = (await (await fetch(`/api/sessions/${encodeURIComponent(sid)}`)).json()) as SessionDetail;
      return `${(s.ownedLoops ?? []).length}/${s.loops.filter((l) => l.kind === 'CronCreate').length}`;
    }, id), { timeout: 15_000 })
    .toBe('1/1');
});

test('desktop: the indicator, its popover, Pause / Resume, Run now, the chat rows, the side panel', async ({ page }) => {
  test.setTimeout(60_000);
  await openWithHub(page, `${world.baseUrl}/agents/${sessionId}`);
  const indicator = page.getByTestId('v2-agent-status').getByTestId('v2-agent-routines');
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveText(/^Next: (Nightly check|CLI schedule) (\d\d:\d\d|tomorrow \d\d:\d\d) · 2 routines$/);

  // The chat keeps its room (the earlier chat-space constraints).
  const header = await page.getByTestId('v2-agent-header').boundingBox();
  const chat = await page.getByTestId('v2-agent-chat').boundingBox();
  expect(header?.height ?? 99).toBeLessThanOrEqual(56);
  expect(chat?.height ?? 0).toBeGreaterThanOrEqual(900 * 0.55);
  const status = await page.getByTestId('v2-agent-status').boundingBox();
  expect(status?.height ?? 99).toBeLessThanOrEqual(40);

  // The popover lists both.
  await indicator.click();
  const pop = page.getByTestId('v2-agent-routines-pop');
  await expect(pop).toBeVisible();
  const items = pop.getByTestId('v2-agent-routine');
  await expect(items).toHaveCount(2);
  const mine = items.and(page.locator('[data-source="loop"]'));
  const theirs = items.and(page.locator('[data-source="cli"]'));
  await expect(mine.getByTestId('v2-agent-routine-name')).toHaveText('Nightly check');
  await expect(mine.getByTestId('v2-agent-routine-when')).toHaveText(/^Every 45 minutes · next (\d\d:\d\d|tomorrow \d\d:\d\d)$/);
  await expect(mine.getByTestId('v2-agent-routine-state')).toHaveText('On schedule');
  await expect(theirs.getByTestId('v2-agent-routine-name')).toHaveText('CLI schedule');
  await expect(theirs.getByTestId('v2-agent-routine-when')).toHaveText(/^Every 30 minutes · next /);
  for (const id of ['v2-agent-routine-pause', 'v2-agent-routine-run', 'v2-agent-routine-edit', 'v2-agent-routine-cancel']) {
    await expect(theirs.getByTestId(id)).toBeDisabled();
    await expect(theirs.getByTestId(id)).toHaveAttribute('title', 'Managed by the AI engine: Switchboard can only watch it.');
    await expect(mine.getByTestId(id)).toBeEnabled();
  }
  await page.screenshot({ path: 'test-results/v2-agent-routines-pop.png' });

  // Pause, then Resume.
  await mine.getByTestId('v2-agent-routine-pause').click();
  await expect(mine).toHaveAttribute('data-state', 'paused');
  await expect(mine.getByTestId('v2-agent-routine-state')).toHaveText('Paused');
  await expect(mine.getByTestId('v2-agent-routine-pause')).toHaveText('Resume');
  await mine.getByTestId('v2-agent-routine-pause').click();
  await expect(mine).toHaveAttribute('data-state', 'active');

  // Run now: the firing reaches the chat with its chip; the last result follows.
  await mine.getByTestId('v2-agent-routine-run').click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Sent it to' })).toHaveCount(1);
  await expect(mine.getByTestId('v2-agent-routine-last')).toContainText('(run 1)', { timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  const fired = page.getByTestId('v2-agent-you').filter({ hasText: 'Check the Acme queue and report.' });
  await expect(fired.locator('.v2-ag-loopchip')).toContainText('Nightly check · run 1', { timeout: 15_000 });

  // The creation rows, as classic lists those steps.
  const rows = page.getByTestId('v2-agent-routine-row');
  await expect(rows.filter({ hasText: 'Set up a routine: Check the Acme queue and report.' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Scheduled in the CLI: check the Acme build' })).toHaveCount(1);

  // The side panel's Routines group: the same set.
  const side = page.getByTestId('v2-agent-side');
  await expect(side).toBeVisible();
  const group = side.getByTestId('v2-agent-side-routines');
  await expect(group.getByTestId('v2-agent-routine')).toHaveCount(2);
  await expect(group.locator('[data-source="cli"]').getByTestId('v2-agent-routine-run')).toBeDisabled();
  await page.screenshot({ path: 'test-results/v2-agent-routines-desktop.png' });

  // With the side panel hidden, the indicator stays.
  await side.getByTestId('v2-agent-side-hide').click();
  await expect(side).toHaveCount(0);
  await expect(indicator).toBeVisible();
});

test('the peek shows the indicator', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  await page.evaluate((id) => (window as unknown as { __sbV2Peek: (id: string) => void }).__sbV2Peek(id), sessionId);
  const peek = page.getByTestId('v2-agent-peek');
  await expect(peek).toBeVisible();
  const indicator = peek.getByTestId('v2-agent-routines');
  await expect(indicator).toHaveText(/^(\d\d:\d\d|tomorrow \d\d:\d\d) · 2$/);
  await indicator.click();
  await expect(page.getByTestId('v2-agent-routines-pop').getByTestId('v2-agent-routine')).toHaveCount(2);
});

test('phone 390 × 844: the indicator in the status row, the popover fits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/agents/${sessionId}`);
  const indicator = page.getByTestId('v2-agent-status').getByTestId('v2-agent-routines');
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveText(/^(\d\d:\d\d|tomorrow \d\d:\d\d) · 2$/);
  const box = await indicator.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  const header = await page.getByTestId('v2-agent-header').boundingBox();
  expect(header?.height ?? 99).toBeLessThanOrEqual(60);
  await indicator.click();
  const pop = page.getByTestId('v2-agent-routines-pop');
  await expect(pop.getByTestId('v2-agent-routine')).toHaveCount(2);
  const popBox = await pop.boundingBox();
  expect(popBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((popBox?.x ?? 0) + (popBox?.width ?? 999)).toBeLessThanOrEqual(390);
  const pause = await pop.locator('[data-source="loop"]').getByTestId('v2-agent-routine-pause').boundingBox();
  expect(pause?.height ?? 0).toBeGreaterThanOrEqual(44);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/v2-agent-routines-phone.png' });
});
