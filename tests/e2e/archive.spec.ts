import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { Store } from '../../src/server/db/store.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { seedFolder } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { openTempStore } from '../helpers/store.ts';
import { stubToolProbes } from './probes.ts';
import { useV2 } from './v2-world.ts';

/**
 * D137 · the archive on the real code path: the real server over a temp data folder
 * whose database holds archived (closed) sessions, past the upgrade grace. At start
 * the sweep deletes the one past its period; the Archived list (v2 desktop and phone)
 * and classic History show each row's countdown or its Kept reason, Restore works,
 * and the Settings period changes the countdown. Screenshots go to
 * `SWITCHBOARD_SHOTS_DIR` when set.
 */
const DAY = 86_400_000;
const SHOTS = process.env['SWITCHBOARD_SHOTS_DIR'] ?? '';
let tmp: string;
let server: ServerProcess;
const ids: Record<string, string> = {};

async function archived(store: Store, workspace: string, name: string, daysAgo: number): Promise<string> {
  const session = await store.sessions.create({ name, title: name.replace(/-/g, ' '), claudeSessionId: randomUUID(), solutions: [], worktrees: false, root: workspace, rootKind: 'workspace', cwd: workspace });
  await store.sessions.update(session.id, { closedAt: new Date(Date.now() - daysAgo * DAY).toISOString() });
  return session.id;
}

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const response = await fetch(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return (response.status === 204 ? null : await response.json()) as T;
    },
    { method, url, body },
  );
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-archive');
  const dataDir = path.join(tmp, 'data');
  const workspace = path.join(tmp, 'Acme workspace');
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const store = await openTempStore(dataDir);
  await seedFolder(store, workspace);
  // Past the upgrade grace: periods count from each session's own archiving.
  await store.settings.set('sessions.archiveSince', new Date(Date.now() - 400 * DAY).toISOString());
  ids['recent'] = await archived(store, workspace, 'checkout-recent', 2);
  ids['pinned'] = await archived(store, workspace, 'pinned-pricing', 30);
  ids['gone'] = await archived(store, workspace, 'old-onboarding', 30);
  ids['restore'] = await archived(store, workspace, 'restore-me', 1);
  await store.sidebar.update((layout) => ({ ...layout, pinned: [ids['pinned'] as string] }));
  await store.close();
  server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir, SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config') });
});

test.afterAll(async () => {
  await server?.stop();
  if (tmp) await removeTempDir(tmp);
});

test('the sweep at start deleted the archived session past its period, quietly, and kept the pinned one', async ({ page }) => {
  await page.goto(`${server.baseUrl}/history`);
  await expect.poll(async () => (await api<Array<{ id: string }>>(page, 'GET', '/api/sessions?closed=include')).map((s) => s.id).includes(ids['gone'] as string), { timeout: 15_000 }).toBe(false);
  const settings = await api<Record<string, { lastDeleted: { sessions: number } | null }>>(page, 'GET', '/api/settings');
  expect(settings['sessions.archiveSweep']?.lastDeleted?.sessions).toBe(1);
  const list = await api<Array<{ id: string; deletesAt?: string | null; keptReason?: string | null }>>(page, 'GET', '/api/sessions?closed=include');
  expect(list.find((s) => s.id === ids['pinned'])).toMatchObject({ deletesAt: null, keptReason: 'pinned' });
  expect(list.find((s) => s.id === ids['recent'])?.deletesAt).toBeTruthy();
});

test.describe('v2', () => {
  test.beforeEach(async ({ page }) => {
    await useV2(page);
    await stubToolProbes(page);
  });

  test('Archived shows the policy line, each countdown and Kept reason; Restore brings an agent back; the setting changes the countdown', async ({ page }) => {
    await page.goto(`${server.baseUrl}/agents?show=closed`);
    await expect(page.getByTestId('v2-page-agents-closed')).toBeVisible();
    await expect(page.getByTestId('v2-page-agents-closed').locator('h1')).toHaveText('Archived');
    await expect(page.getByTestId('v2-archive-policy')).toHaveText('Archived agents are deleted after 14 days. Change in Settings.');
    const row = (name: string) => page.getByTestId('v2-closed-row').filter({ hasText: name });
    await expect(row('checkout recent').getByTestId('v2-closed-countdown')).toHaveText(' · Deletes in 12 days');
    await expect(row('pinned pricing').getByTestId('v2-closed-countdown')).toHaveText(' · Kept: pinned');
    await expect(row('old onboarding')).toHaveCount(0);
    await shot(page, 'archive-v2-list');

    await row('restore me').getByTestId('v2-closed-reopen').click();
    await expect(page.getByTestId('v2-toast').filter({ hasText: 'Restored “restore me”.' })).toBeVisible();
    await expect(row('restore me')).toHaveCount(0);

    // Change in Settings → Advanced › Sessions: 30 days.
    await page.getByTestId('v2-archive-settings').click();
    await expect(page).toHaveURL(/\/settings\/advanced\/sessions$/);
    const select = page.getByTestId('archive-days');
    await expect(select).toHaveValue('14');
    await expect(page.locator('[data-row="archive"]')).toContainText('Delete archived agents after');
    await expect(page.getByTestId('archive-last')).toContainText('Last: deleted 1 archived agent, today');
    await shot(page, 'archive-v2-setting');
    await select.selectOption('30');
    await expect.poll(async () => (await api<Record<string, number>>(page, 'GET', '/api/settings'))['sessions.archiveDays']).toBe(30);
    await page.goto(`${server.baseUrl}/agents?show=closed`);
    await expect(page.getByTestId('v2-archive-policy')).toHaveText('Archived agents are deleted after 30 days. Change in Settings.');
    await expect(row('checkout recent').getByTestId('v2-closed-countdown')).toHaveText(' · Deletes in 28 days');
    await api(page, 'PUT', '/api/settings', { 'sessions.archiveDays': 14 });
    // Archive again from the agent ⋯ menu wording: the restored agent goes back to Archived.
    await api(page, 'POST', `/api/sessions/${encodeURIComponent(ids['restore'] as string)}/close`, { confirm: true });
  });

  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('Archived on a phone: the same countdowns and Kept reason, nothing wider than the screen', async ({ page }) => {
      await page.goto(`${server.baseUrl}/agents?show=closed`);
      await expect(page.getByTestId('v2-archive-policy')).toBeVisible();
      const row = (name: string) => page.getByTestId('v2-closed-row').filter({ hasText: name });
      await expect(row('checkout recent').getByTestId('v2-closed-countdown')).toHaveText(' · Deletes in 12 days');
      await expect(row('pinned pricing').getByTestId('v2-closed-countdown')).toHaveText(' · Kept: pinned');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await shot(page, 'archive-v2-phone');
    });
  });
});

test('classic: History shows Archived, the countdown, the Kept reason and Restore; Settings has the period', async ({ page }) => {
  await stubToolProbes(page);
  await page.goto(`${server.baseUrl}/history`);
  await expect(page.getByTestId('history-archive-note')).toHaveText('Archived sessions are deleted after 14 days. Change in Settings.');
  const row = (id: string) => page.locator(`[data-testid="history-row"][data-session-id="${id}"]`);
  await expect(row(ids['recent'] as string).getByTestId('history-closed-tag')).toHaveText('Archived');
  await expect(row(ids['recent'] as string).getByTestId('history-archive-countdown')).toHaveText('Deletes in 12 days');
  await expect(row(ids['pinned'] as string).getByTestId('history-archive-countdown')).toHaveText('Kept: pinned');
  await shot(page, 'archive-classic-history');
  await row(ids['restore'] as string).getByTestId('history-reopen').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${ids['restore']}`));
  const restored = await api<{ closedAt: string | null }>(page, 'GET', `/api/sessions/${encodeURIComponent(ids['restore'] as string)}`);
  expect(restored.closedAt).toBeNull();

  await expect(page.getByTestId('history-archive-settings')).toHaveCount(0);
  await page.goto(`${server.baseUrl}/settings/sessions`);
  await expect(page.locator('[data-row="archive"]')).toContainText('Delete archived sessions after');
  await expect(page.getByTestId('archive-last')).toContainText('Last: deleted 1 archived session, today');
  await page.getByTestId('archive-days').selectOption('0');
  await expect.poll(async () => (await api<Record<string, number>>(page, 'GET', '/api/settings'))['sessions.archiveDays']).toBe(0);
  await page.goto(`${server.baseUrl}/history`);
  await expect(page.getByTestId('history-archive-note')).toHaveText('Archived sessions are kept until you delete them. Change in Settings.');
  await expect(row(ids['recent'] as string).getByTestId('history-archive-countdown')).toHaveCount(0);
  await shot(page, 'archive-classic-never');
});
