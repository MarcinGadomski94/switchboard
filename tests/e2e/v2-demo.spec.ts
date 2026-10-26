import path from 'node:path';
import { expect, test } from '@playwright/test';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · lane X · the demo's v2 layer on the real code path (`SWITCHBOARD_DEMO=1` with v2 the
 * default theme, docs/demo.md → The v2 layer): the Agents folder tree, three projects, two
 * crews, the notes, tasks in every column and a week of Insights, at 1440 and on a phone.
 * (The classic visual oracle runs with the default theme `classic` and keeps the plain seed.)
 */

let tmp: string;
let server: ServerProcess;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-v2-demo');
  server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), SWITCHBOARD_DEMO: '1', ...V2_SERVER_ENV });
});

test.afterAll(async () => {
  await server?.stop();
  await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

test('every v2 page has Acme data: folders, projects, crews, notes, tasks, Insights', async ({ page }) => {
  await page.goto(`${server.baseUrl}/agents`);
  await expect(page.getByTestId('v2-tree-folder-name').filter({ hasText: 'Acme web' })).toBeVisible();
  await expect(page.getByTestId('v2-tree-folder-name').filter({ hasText: 'Releases' })).toHaveCount(1);

  await page.goto(`${server.baseUrl}/projects`);
  await expect(page.getByTestId('v2-project-card')).toHaveCount(3);
  await expect(page.getByTestId('v2-project-card').first()).toContainText('PROJ-123 Acme checkout');

  await page.goto(`${server.baseUrl}/crews`);
  await expect(page.getByTestId('v2-crews-list')).toContainText('Acme web');
  await expect(page.getByTestId('v2-crews-list')).toContainText('Acme mobile');

  await page.goto(`${server.baseUrl}/notes`);
  await expect(page.getByTestId('v2-notes-count')).toHaveText('· 3 notes');

  await page.goto(`${server.baseUrl}/tasks`);
  await expect(page.getByText('Coverage matrix for PROJ-123')).toBeVisible();
  await expect(page.getByText('CheckoutService contract')).toBeVisible();

  await page.goto(`${server.baseUrl}/insights`);
  await expect(page.getByText('Nothing in this range yet')).toHaveCount(0);
});

test('a phone shows the crews and the projects', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await stubToolProbes(page);
    await page.goto(`${server.baseUrl}/crews`);
    await expect(page.getByTestId('v2-crew-row')).toHaveCount(2);
    await page.goto(`${server.baseUrl}/projects`);
    await expect(page.getByTestId('v2-project-card')).toHaveCount(3);
  } finally {
    await context.close();
  }
});
