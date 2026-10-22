import { type Page, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D127 (`docs/processes.md`), real path: `node src/server/main.ts` with fake-claude as the CLI.
 * A session's turn leaves a process running (`[fake:leave-process]`: a `node -e` sleeper behind a
 * shell that exits, carrying the session's marker). The session panel's **Processes** lists it
 * with Keep / Stop; the sidebar footer sums it ("procs …") and opens Settings → Processes, which
 * lists every session's; Stop stops it. The same at phone width (the panel is a bottom sheet).
 * Every process involved is the fake's own and ends by itself after two minutes at the latest.
 */

let world: QuestionWorld;
const started = new Set<number>();

test.beforeAll(async () => {
  world = await startQuestionWorld('processes');
});

test.afterEach(() => {
  for (const pid of started) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  started.clear();
});

test.afterAll(async () => {
  await world?.stop();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function session(page: Page, id: string): Promise<Session> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as Session, id);
}

/** A session whose turn left a process running; its id and the process's pid (once listed). */
async function withLeftover(page: Page, name: string): Promise<{ readonly id: string; readonly pid: number }> {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, name, 'Start the dev server. [fake:leave-process 120]');
  await expect.poll(async () => (await session(page, id)).status, { timeout: 20_000 }).toBe('done');
  let pid = 0;
  await expect
    .poll(
      async () => {
        const view = await page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/processes?fresh=1`)).json()) as { processes: Array<{ pid: number }> }, id);
        pid = view.processes[0]?.pid ?? 0;
        return pid;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  started.add(pid);
  return { id, pid };
}

test('the session panel lists the leftover; Keep toggles; Stop stops it; the footer line opens Settings → Processes', async ({ page }) => {
  const { id, pid } = await withLeftover(page, 'procs-panel-e2e');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const section = page.getByTestId('session-processes');
  await expect(section).toBeVisible({ timeout: 20_000 });
  const row = section.locator(`[data-testid="process-row"][data-pid="${pid}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('node -e');
  await expect(row.getByTestId('process-kind')).toHaveText('other');
  await expect(row.getByTestId('process-ram')).toHaveText(/\d+ (?:KB|MB|GB)/);

  const keep = row.getByTestId('process-keep');
  await keep.click();
  await expect(keep).toHaveAttribute('aria-pressed', 'true');
  await expect(row).toHaveAttribute('data-keep', 'true');
  await keep.click();
  await expect(keep).toHaveAttribute('aria-pressed', 'false');

  // The footer sums what sessions left running and opens the global view.
  const footer = page.getByTestId('processes-footer');
  await expect(footer).toBeVisible({ timeout: 40_000 });
  await expect(footer).toHaveText(/^procs \d+ (?:KB|MB|GB)$/);
  await expect(footer).toHaveAttribute('href', '/settings/processes');

  await row.getByTestId('process-stop').click();
  await expect(section).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  // The stop is on the timeline.
  await expect(page.getByText(/^Stopped 1 process \(\d+ (?:KB|MB)\) \(Stop in Processes\)$/).first()).toBeAttached({ timeout: 10_000 });
});

test('Settings → Processes lists every session’s processes with the total; Stop there', async ({ page }) => {
  const { id, pid } = await withLeftover(page, 'procs-global-e2e');
  await page.goto(`${world.baseUrl}/settings/processes`);
  const overview = page.getByTestId('processes-overview');
  await expect(overview).toBeVisible();
  await expect(page.getByTestId('processes-total')).toHaveText(/^1 process · \d+ (?:KB|MB)$/);
  const group = overview.locator(`[data-testid="processes-group"][data-session-id="${id}"]`);
  await expect(group).toContainText('procs-global-e2e');
  await expect(page.getByTestId('setting-processes.idleStopMinutes')).toHaveValue('10');
  await group.locator(`[data-pid="${pid}"]`).getByTestId('process-stop').click();
  await expect(page.getByTestId('processes-total')).toHaveText('No session has processes running.', { timeout: 15_000 });
  expect(alive(pid)).toBe(false);
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the bottom sheet lists the leftover and Stop works; Settings → Processes fits', async ({ page }) => {
    const { id, pid } = await withLeftover(page, 'procs-phone-e2e');
    await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
    await page.getByTestId('panel-open').click();
    const panel = page.getByTestId('session-right-panel');
    await expect(panel).not.toHaveAttribute('inert');
    const row = panel.locator(`[data-testid="process-row"][data-pid="${pid}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    const box = await row.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await row.getByTestId('process-stop').click();
    await expect(panel.getByTestId('session-processes')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);

    await page.goto(`${world.baseUrl}/settings/processes`);
    await expect(page.getByTestId('processes-overview')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
