import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * D99 (E2E, the real server process): Settings → Experimental shows **Plans** next to
 * Team, off by default; switching it on creates `plans.db` and the plan routes answer;
 * switching it off again answers 404 `plans-off`.
 */
let tmp: string;
let server: ServerProcess;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-plans-switch');
  await mkdir(path.join(tmp, 'data'), { recursive: true });
  server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), SWITCHBOARD_TUTORIAL: 'off' });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  await removeTempDir(tmp);
});

async function call(page: Page, method: string, url: string): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ method: m, url: u }) => {
      const response = await fetch(u, { method: m });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    { method, url },
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

test('Settings → Experimental → Plans: off by default; on creates plans.db and the routes answer; off again: 404', async ({ page }) => {
  await page.goto(`${server.baseUrl}/settings/experimental`);
  await expect(page.locator('[data-row="experimental-team"]')).toBeVisible();
  const row = page.locator('[data-row="experimental-plans"]');
  await expect(row).toContainText('Plans');
  await expect(row).toContainText('Off: no background work and no plan tools for agents; running plans are paused.');
  const toggle = row.getByTestId('setting-value');
  await expect(toggle).toHaveText('off');
  expect((await call(page, 'GET', '/api/plans')).body).toMatchObject({ error: 'plans-off' });
  expect(await exists(path.join(tmp, 'data', 'plans.db'))).toBe(false);

  await toggle.click();
  await expect(toggle).toHaveText('on');
  expect((await call(page, 'GET', '/api/plans/state')).body).toEqual({ enabled: true, available: true, problem: null });
  expect(await call(page, 'GET', '/api/plans')).toEqual({ status: 200, body: [] });
  expect(await exists(path.join(tmp, 'data', 'plans.db'))).toBe(true);

  await toggle.click();
  await expect(toggle).toHaveText('off');
  expect((await call(page, 'GET', '/api/plans')).status).toBe(404);
});
