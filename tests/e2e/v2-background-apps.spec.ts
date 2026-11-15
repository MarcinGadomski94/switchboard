import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D143 / D164 · an agent that left a dev server running is not working
 * (`docs/processes.md` → *Background apps of an agent (D143)*), on the real path
 * (fake-claude): its turn starts a background `npm run dev` that never ends in the
 * test and ends. The session reads done, not run; the Agents list row and the agent
 * header say "Done · 1 background app"; the row is not in the working state. (D164: a
 * background command that is no dev server or watcher, a build, keeps it working.)
 */
let world: QuestionWorld;
let sessionId = '';

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  world = await startQuestionWorld('e2e-v2-background-apps', { env: { ...V2_SERVER_ENV } });
  const page = await browser.newPage();
  await stubToolProbes(page);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-bg-apps', 'Start the dev server. [fake:background 3600 npm run dev]');
  sessionId = id;
  await expect.poll(async () => (await detail(page, id)).activity?.state, { timeout: 30_000 }).toBe('background');
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

test('the turn is over with a dev server left running: done, "Done · 1 background app" on the row and the header, never working', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const read = await detail(page, sessionId);
  expect(read.status).toBe('done');
  expect(read.activity?.background).toMatchObject([{ kind: 'bash', waiting: false, summary: 'npm run dev' }]);

  await openWithHub(page, `${world.baseUrl}/agents`);
  const row = page.locator(`[data-testid="v2-agent-row"][data-session="${sessionId}"]`).first();
  await expect(row).toContainText('· 1 background app');
  await expect(row).not.toHaveAttribute('data-status', 'working');

  await openWithHub(page, `${world.baseUrl}/agents/${sessionId}`);
  const badge = page.getByTestId('v2-agent-header').getByTestId('v2-status');
  await expect(badge).toHaveText('Done · 1 background app');
  await expect(badge).toHaveAttribute('data-status', 'done');
});
