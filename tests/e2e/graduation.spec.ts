import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * D132 (E2E, the real server process, classic UI): Team, Plans and Project memory graduated in
 * 2.0. Settings has no Experimental section (its old link opens Settings → Jira, the connection
 * that lived there); the three pages are reachable from the sidebar without enabling anything;
 * their databases exist after the start; with no member nothing shows above SESSIONS.
 */
let tmp: string;
let server: ServerProcess;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-graduation');
  await mkdir(path.join(tmp, 'data'), { recursive: true });
  server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), SWITCHBOARD_TUTORIAL: 'off' });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  await removeTempDir(tmp);
});

async function call(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ method: m, url: u, body: b }) => {
      const response = await fetch(u, { method: m, ...(b === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    { method, url, body },
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

test('Settings has no Experimental switches; /settings/experimental opens Settings → Jira', async ({ page }) => {
  await page.goto(`${server.baseUrl}/settings`);
  const nav = page.locator('.sb-set-nav');
  await expect(nav).toContainText('Jira');
  await expect(nav).not.toContainText('Experimental');
  await page.goto(`${server.baseUrl}/settings/experimental`);
  await expect(page.getByTestId('settings-jira')).toBeVisible();
  await expect(page.locator('[data-row^="experimental-"]')).toHaveCount(0);
  // The old switches are no settings any more.
  const settings = (await call(page, 'GET', '/api/settings')).body as Record<string, unknown>;
  expect(Object.keys(settings).filter((key) => key.startsWith('experimental.'))).toEqual([]);
  expect((await call(page, 'PUT', '/api/settings', { 'experimental.plans': true })).status).toBe(422);
});

test('Team, Plans and Memory are reachable without enabling anything; nothing shows above SESSIONS without a member', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  for (const file of ['plans.db', 'team.db', 'memory.db']) expect(await exists(path.join(tmp, 'data', file)), file).toBe(true);
  for (const url of ['/api/team/state', '/api/plans/state', '/api/memory/state']) expect((await call(page, 'GET', url)).body, url).toMatchObject({ enabled: true, available: true });
  await expect(page.getByTestId('sidebar-team')).toHaveCount(0);

  await page.getByTestId('nav-plans').click();
  await expect(page).toHaveURL(/\/plans$/);
  await expect(page.getByTestId('plans-page')).toBeVisible();
  await expect(page.getByTestId('plans-empty')).toBeVisible();
  await expect(page.getByTestId('plans-unavailable')).toHaveCount(0);

  await page.getByTestId('nav-team').click();
  await expect(page).toHaveURL(/\/team\/team$/);
  await expect(page.getByTestId('team-empty')).toContainText('No team members yet');
  await expect(page.getByTestId('team-unavailable')).toHaveCount(0);

  await page.getByTestId('nav-memory').click();
  await expect(page).toHaveURL(/\/memory$/);
  await expect(page.getByTestId('memory-page')).toBeVisible();
  await expect(page.getByTestId('memory-unavailable')).toHaveCount(0);
  await expect(page.getByText('Settings → Experimental')).toHaveCount(0);
});
