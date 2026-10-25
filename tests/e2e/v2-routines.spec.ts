import { type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · lane A · the v2 Routines page (`/routines`) on the real path
 * (fake-claude): a Switchboard loop (D94) of a real agent shows as a routine
 * panel in plain words ("Every 45 minutes · next run …"), with its agent linked;
 * Run now sends it (the history line follows live), Pause / Resume, Edit saves,
 * Cancel asks first. Plus the phone width (390 × 844).
 */
let world: QuestionWorld;
let sessionId = '';

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-routines', { env: { ...V2_SERVER_ENV } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function call<T>(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ m, u, b }) => {
      const response = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
    },
    { m: method, u: url, b: body },
  );
}

test('a Switchboard loop as a routine: plain words, Run now, Pause / Resume, Edit, Cancel', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/routines`);
  await expect(page.getByTestId('v2-page-routines')).toBeVisible();
  await expect(page.getByTestId('v2-routines-empty')).toBeVisible();

  const session = await world.startSession(page, 'queue-owner', 'Reply with just OK.');
  sessionId = session.id;
  await expect.poll(async () => (await call<{ status: string }>(page, 'GET', `/api/sessions/${session.id}`)).body.status, { timeout: 20_000 }).toMatch(/^(done|idle)$/);
  const created = await call<{ id: string }>(page, 'POST', `/api/sessions/${session.id}/loops`, { prompt: 'Check the queue and report.', everyMinutes: 45, label: 'Queue watch' });
  expect(created.status).toBe(201);

  // Live (sessionUpdated): the panel, in plain words, with its agent.
  const panel = page.locator(`[data-testid="v2-routines-panel"][data-key="loop:${session.id}:${created.body.id}"]`);
  await expect(panel).toHaveCount(1, { timeout: 15_000 });
  await expect(panel.getByTestId('v2-routines-name')).toHaveText('Queue watch');
  await expect(panel.getByTestId('v2-routines-summary')).toHaveText(/^Every 45 minutes · next run (\d\d:\d\d|tomorrow \d\d:\d\d) · no runs yet$/);
  await expect(panel.getByTestId('v2-status')).toHaveText('On schedule');
  await expect(panel.getByTestId('v2-routines-agent')).toHaveText('queue-owner');
  await expect(panel.getByTestId('v2-routines-history')).toHaveText('No runs yet.');
  await expect(page.getByTestId('v2-routines-count')).toHaveText('· 1 routine');

  // Run now: sent to the agent; the history shows it.
  await panel.getByTestId('v2-routines-run').click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Sent it to “queue-owner” now.' })).toHaveCount(1);
  await expect(panel.getByTestId('v2-routines-hline').first()).toContainText('sent to its agent (run 1)', { timeout: 15_000 });
  await expect(panel.getByTestId('v2-routines-summary')).toContainText('1 run so far');
  await page.screenshot({ path: 'test-results/v2-routines-desktop.png' });

  // Pause, then Resume.
  await panel.getByTestId('v2-routines-pause').click();
  await expect(panel.getByTestId('v2-status')).toHaveText('Paused');
  await expect(panel.getByTestId('v2-routines-summary')).toContainText('Every 45 minutes · paused');
  await expect(panel.getByTestId('v2-routines-pause')).toHaveText('Resume');
  expect((await call<Array<{ id: string; state: string }>>(page, 'GET', `/api/sessions/${session.id}/loops`)).body.find((l) => l.id === created.body.id)?.state).toBe('paused');
  await panel.getByTestId('v2-routines-pause').click();
  await expect(panel.getByTestId('v2-status')).toHaveText('On schedule');

  // Edit: every 2 hours.
  await panel.getByTestId('v2-routines-edit').click();
  const dialog = page.getByTestId('v2-routines-edit-dialog');
  await dialog.getByTestId('v2-routines-edit-every').fill('120');
  await dialog.getByTestId('v2-routines-edit-save').click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByTestId('v2-routines-summary')).toContainText('Every 2 hours');

  // Cancel asks first; Keep it keeps it.
  await panel.getByTestId('v2-routines-cancel').click();
  const confirm = page.getByTestId('v2-routines-cancel-dialog');
  await expect(confirm).toContainText('Cancel “Queue watch”?');
  await confirm.getByRole('button', { name: 'Keep it' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(panel).toHaveCount(1);

  // New routine opens the + New sheet (lane R's) as a routine.
  await page.getByTestId('v2-routines-new').click();
  await expect(page.getByTestId('v2-new-sheet')).toBeVisible();
});

test('phone width (390 × 844): the routine panel fits, touch-sized buttons; Pause works', async ({ page }) => {
  test.skip(sessionId === '', 'needs the first test’s agent');
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/routines`);
  const panel = page.getByTestId('v2-routines-panel').first();
  await expect(panel).toBeVisible();
  for (const id of ['v2-routines-pause', 'v2-routines-run', 'v2-routines-edit', 'v2-routines-cancel']) {
    const box = await panel.getByTestId(id).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await panel.getByTestId('v2-routines-pause').click();
  await expect(panel.getByTestId('v2-status')).toHaveText('Paused');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/v2-routines-phone-dark.png', fullPage: true });
  // Cancel for real: confirmed, it is removed (D94: Cancel removes a loop at once).
  await panel.getByTestId('v2-routines-cancel').click();
  await page.getByTestId('v2-routines-cancel-yes').click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Routine cancelled.' })).toHaveCount(1);
  await expect(page.getByTestId('v2-routines-empty')).toBeVisible();
  expect((await call<unknown[]>(page, 'GET', `/api/sessions/${sessionId}/loops`)).body).toEqual([]);
});
