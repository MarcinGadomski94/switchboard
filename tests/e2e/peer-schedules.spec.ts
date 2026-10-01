import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import type { Schedule } from '../../src/core/api.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../helpers/peers.ts';
import { terminalLoopLines, writeTranscript } from '../helpers/transcripts.ts';

/**
 * D52 "A peer's schedules and loops" oracle: two real Switchboard processes
 * (fake-claude; `docs/peers.md` → *A peer's schedules and loops*). On B's
 * Schedules & loops page: "+ New scheduled run" with the Machine row set to A
 * saves the schedule on A (its folders), the row carries A's tag, Run now runs it
 * there, Edit reopens it on A and "Delete schedule" deletes it there; a terminal
 * `/loop` running on A (not hooked) shows as a tagged card with "Hook into…",
 * which hooks it and opens its session; with A gone the row stays, tagged
 * unreachable, and its actions are disabled with the reason.
 */

const CS = '5c1e0b52-bbbb-4ccc-8ddd-0123456789ab';

let tmp: string;
let nodes: PeerNode[] = [];
let contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-peer-schedules');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function pageOf(browser: Browser, target: PeerNode, route: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${target.baseUrl}${route}`);
  return page;
}

test('B manages a schedule that lives on A and hooks into A\'s terminal /loop from Schedules & loops', async ({ browser }) => {
  test.setTimeout(120_000);
  const { a, b, aId } = await pairedNodes(tmp);
  nodes.push(a, b);
  const aName = (await a.call('GET', '/api/machines')).body.self.name as string;
  // A hand-started terminal session on A that runs /loop 5m (CronCreate) and fired once.
  const cwd = a.repo as string;
  await mkdir(path.join(a.configDir, 'sessions'), { recursive: true });
  await writeFile(
    path.join(a.configDir, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: CS, cwd, kind: 'interactive', entrypoint: 'cli', startedAt: Date.now() - 60_000, name: 'pc-loop', status: 'idle' }),
  );
  await writeTranscript(a.configDir, cwd, CS, terminalLoopLines({ sessionId: CS, cwd, start: new Date(Date.now() - 400_000) }));
  // B has A's terminal loop cached before the page loads (the page also polls).
  await waitFor('B has A\'s terminal loop', async () => ((await b.call('GET', '/api/terminal-loops')).body as unknown[]).length > 0);

  const page = await pageOf(browser, b, '/schedules');
  await expect(page.getByTestId('schedule-empty')).toBeVisible();

  // + New scheduled run → Machine: A → A's folder, then Save: the schedule is saved on A.
  await page.getByTestId('schedule-new').click();
  const modal = page.getByTestId('modal-new-session');
  const machine = modal.getByTestId('ns-machine');
  await expect(machine.locator('option')).toHaveText([/^This machine/, aName]);
  await machine.selectOption(aId);
  await expect(modal.getByTestId('ns-machine-note')).toContainText('the schedule is saved there');
  await expect(modal.getByTestId('ns-folder').locator('option:checked')).toHaveText(/repo-a/);
  await modal.getByTestId('ns-name').fill('nightly-a');
  await modal.getByTestId('ns-task').fill('Say OK.');
  await modal.getByTestId('ns-switch-worktrees').click();
  await modal.getByTestId('ns-cron').fill('0 2 * * *');
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/schedules') && r.request().method() === 'POST');
  await modal.getByTestId('ns-save-schedule').click();
  expect((await saved).status()).toBe(201);
  await expect(modal).toHaveCount(0);
  expect(((await a.call('GET', '/api/schedules')).body as Schedule[]).map((s) => s.name)).toEqual(['nightly-a']);

  const row = page.locator('[data-testid="schedule-row"][data-schedule="nightly-a"]');
  await expect(row).toHaveAttribute('data-machine', aId);
  await expect(row.getByTestId('schedule-machine')).toHaveText(aName);
  await expect(row.getByTestId('schedule-cron')).toHaveText('02:00 daily');

  // Run now: it runs on A; the result comes back.
  await row.getByTestId('schedule-run').click();
  await expect(row.getByTestId('schedule-last')).toHaveText(/^OK/, { timeout: 30_000 });
  // Pause / Resume on A.
  await row.getByTestId('schedule-pause').click();
  await expect(row.getByTestId('schedule-next')).toHaveText('paused');
  expect(((await a.call('GET', '/api/schedules')).body as Schedule[])[0]?.paused).toBe(true);
  await row.getByTestId('schedule-pause').click();
  await expect(row.getByTestId('schedule-pause')).toHaveText('Pause');

  // Edit reopens it on A (the Machine row locked); Save keeps it there.
  await row.getByTestId('schedule-edit').click();
  await expect(modal.getByTestId('ns-title')).toHaveText('Edit scheduled run');
  await expect(modal.getByTestId('ns-machine')).toHaveValue(aId);
  await expect(modal.getByTestId('ns-machine')).toBeDisabled();
  await expect(modal.getByTestId('ns-folder').locator('option:checked')).toHaveText(/repo-a/);
  await modal.getByTestId('ns-cron').fill('30 3 * * *');
  await modal.getByTestId('ns-save-schedule').click();
  await expect(modal).toHaveCount(0);
  await expect(row.getByTestId('schedule-cron')).toHaveText('03:30 daily');
  expect(((await a.call('GET', '/api/schedules')).body as Schedule[])[0]?.cron).toBe('30 3 * * *');

  // A's terminal /loop: a tagged card; "Hook into…" instead of "Open session", and why.
  const card = page.locator('[data-testid="loop-card"][data-terminal="true"]');
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(card).toHaveAttribute('data-machine', aId);
  await expect(card.getByTestId('loop-machine')).toHaveText(aName);
  await expect(card.getByTestId('loop-name')).toHaveText('pc-loop');
  await expect(card.getByTestId('loop-kind')).toHaveText('/loop 5m');
  await expect(card.getByTestId('loop-open')).toHaveCount(0);
  await expect(card.getByTestId('loop-why')).toContainText('Hook into it to open it');
  await card.getByTestId('loop-hook').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/r~${aId}~`));
  await expect(page.getByTestId('session-machine')).toHaveText(aName);

  // Delete from Edit (two steps): gone on A and on B.
  await page.goto(`${b.baseUrl}/schedules`);
  await row.getByTestId('schedule-edit').click();
  await modal.getByTestId('ns-delete-schedule').click();
  await expect(modal.getByTestId('ns-delete-schedule')).toHaveText('Delete it?');
  await modal.getByTestId('ns-delete-schedule').click();
  await expect(modal).toHaveCount(0);
  await expect(row).toHaveCount(0);
  expect((await a.call('GET', '/api/schedules')).body).toEqual([]);
});

test('with A gone, A\'s schedule stays listed (unreachable) and its actions are disabled with the reason', async ({ browser }) => {
  test.setTimeout(90_000);
  const { a, b, aId } = await pairedNodes(tmp);
  nodes.push(a, b);
  const created = await b.call('POST', '/api/schedules', { machine: aId, cron: '0 2 * * *', template: { name: 'kept', task: 'Say OK.', folder: a.folderId, worktrees: false, ultracode: false } });
  expect(created.status).toBe(201);
  await a.server.stop();
  nodes = nodes.filter((node) => node !== a);

  const page = await pageOf(browser, b, '/schedules');
  const row = page.locator('[data-testid="schedule-row"][data-schedule="kept"]');
  await expect(row.getByTestId('schedule-machine')).toContainText('unreachable', { timeout: 30_000 });
  const reason = /is unreachable$/;
  for (const id of ['schedule-run', 'schedule-pause', 'schedule-edit']) {
    await expect(row.getByTestId(id)).toBeDisabled();
    await expect(row.getByTestId(id)).toHaveAttribute('title', reason);
  }
});
