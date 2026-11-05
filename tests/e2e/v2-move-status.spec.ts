import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import { makeTempDir } from '../helpers/net.ts';
import type { PeerNode } from '../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, takeoverWorld } from '../helpers/takeover.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV, useV2 } from './v2-world.ts';

/**
 * D154 · a move's status after its dialog closed, on two real Switchboards (fake claude,
 * temp repos, a local bare remote; the target holds the restore step through a test hook so
 * the move stays running): Move, Hide, reload → the agent's badge and Home's Moves card show
 * it at its step; a click reopens the move dialog with the steps; it ends done there and on
 * Home. A move that fails raises a Needs-you item with Try again (the Move dialog opens for
 * the same computer); once a later move succeeds the item goes and Home shows it done. The
 * phone's Home (390 × 844) has the Moves card.
 */

let tmp: string;
let world: TakeoverWorld | null = null;
let contexts: BrowserContext[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-v2-move-status');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  if (world) {
    await world.b.call('DELETE', '/api/test/peers/hold-takeover').catch(() => undefined);
    await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  }
  world = null;
  await removeWorld(tmp);
});

async function v2Page(browser: Browser, node: PeerNode, route: string, viewport = { width: 1440, height: 1000 }): Promise<Page> {
  const context = await browser.newContext({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  contexts.push(context);
  const page = await context.newPage();
  await stubToolProbes(page);
  await useV2(page);
  await page.goto(`${node.baseUrl}${route}`);
  return page;
}

async function openMove(page: Page) {
  await page.getByTestId('v2-agent-menu').click();
  await page.getByTestId('v2-agent-menu-list').getByRole('menuitem', { name: 'Move to computer…' }).click();
  const dialog = page.getByTestId('v2-move-dialog');
  await expect(dialog.getByTestId('v2-move-start')).toBeEnabled({ timeout: 60_000 });
  return dialog;
}

test('Move, Hide, reload: the badge and Home show it at its step; a click reopens the dialog with the progress; it ends done', async ({ browser }) => {
  test.setTimeout(240_000);
  const w = (world = await takeoverWorld(tmp, { env: { ...V2_SERVER_ENV, SWITCHBOARD_PEER_TEST_HOOKS: '1' } }));
  const session = await startRepoSession(w.a, w.folders.a.alpha as string, 'status-run');
  const page = await v2Page(browser, w.a, `/agents/${session.id}`);
  const dialog = await openMove(page);
  // The mac holds the restore: the move waits at that step.
  expect((await w.b.call('POST', '/api/test/peers/hold-takeover', { route: 'target/apply' })).status).toBe(204);
  await dialog.getByTestId('v2-move-start').click();
  await expect(dialog.locator('[data-testid="v2-move-step"][data-step="apply"]')).toHaveAttribute('data-status', 'running', { timeout: 90_000 });
  await dialog.getByTestId('v2-move-hide').click();
  await expect(dialog).toHaveCount(0);

  // After a reload (the page knew nothing of the run): the agent's badge.
  await page.reload();
  const badge = page.getByTestId('v2-agent-header').getByTestId('v2-move-badge');
  await expect(badge).toHaveText('Moving to mac-laptop… (restoring the code)', { timeout: 30_000 });
  await expect(badge).toHaveAttribute('data-step', 'apply');

  // Home: the Moves card lists it running; a click opens the move dialog on that run, with its steps.
  await page.goto(`${w.a.baseUrl}/`);
  const row = page.getByTestId('v2-home-moves').getByTestId('v2-home-move');
  await expect(row).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
  await expect(row.getByTestId('v2-home-move-line')).toHaveText('Moving to mac-laptop… (restoring the code)');
  await expect(row).toContainText('status-run');
  await row.locator('.v2-home-move-open').click();
  const status = page.getByTestId('v2-move-status');
  await expect(status.getByTestId('v2-move-status-body')).toHaveAttribute('data-state', 'running');
  await expect(status.locator('[data-testid="v2-move-step"][data-step="capture"]')).toHaveAttribute('data-status', 'done');
  await expect(status.locator('[data-testid="v2-move-step"][data-step="apply"]')).toHaveAttribute('data-status', 'running');
  await expect(status.getByTestId('v2-move-status-close')).toHaveText('Hide');

  // The mac goes on: the dialog follows it to the end, live.
  expect((await w.b.call('DELETE', '/api/test/peers/hold-takeover')).status).toBe(204);
  await expect(status.getByTestId('v2-move-status-body')).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
  await expect(status.getByTestId('v2-move-headline')).toContainText('Done');
  await expect(status.getByTestId('v2-move-status-open')).toBeVisible();
  await status.getByTestId('v2-move-status-close').click();
  await expect(row).toHaveAttribute('data-state', 'done');
  await expect(row.getByTestId('v2-home-move-line')).toHaveText('status-run now runs on mac-laptop.');
  // A finished move can be dismissed from Home.
  await row.getByTestId('v2-home-move-dismiss').click();
  await expect(page.getByTestId('v2-home-moves')).toHaveCount(0);
});

test('a failed move waits in Needs you with Try again; a later success closes it and Home shows it done; the phone’s Home has the card', async ({ browser }) => {
  test.setTimeout(300_000);
  const w = (world = await takeoverWorld(tmp, { env: { ...V2_SERVER_ENV } }));
  // The mac's branch of the same name has a commit this computer lacks: the restore there fails.
  await w.git(w.paths.a.alpha, 'checkout', '-q', '-b', 'feature/clash');
  await writeFile(path.join(w.paths.a.alpha, 'a-side.txt'), 'from a\n');
  await w.git(w.paths.a.alpha, 'add', '-A');
  await w.git(w.paths.a.alpha, 'commit', '-q', '-m', 'a commit');
  await w.git(w.paths.b.alpha, 'checkout', '-q', '-b', 'feature/clash');
  await writeFile(path.join(w.paths.b.alpha, 'b-side.txt'), 'from b\n');
  await w.git(w.paths.b.alpha, 'add', '-A');
  await w.git(w.paths.b.alpha, 'commit', '-q', '-m', 'b commit');
  await w.git(w.paths.b.alpha, 'checkout', '-q', 'main');
  const session = await startRepoSession(w.a, w.folders.a.alpha as string, 'clash-run');

  const page = await v2Page(browser, w.a, `/agents/${session.id}`);
  let dialog = await openMove(page);
  await dialog.getByTestId('v2-move-start').click();
  await expect(dialog.getByTestId('v2-move-body')).toHaveAttribute('data-state', 'failed', { timeout: 120_000 });
  await dialog.getByTestId('v2-move-close').click();

  // Needs you: why, at which step, what was undone; Try again and Dismiss.
  await page.goto(`${w.a.baseUrl}/needs-you`);
  const card = page.getByTestId('v2-answer-card').filter({ hasText: 'Couldn’t move clash-run to mac-laptop' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveAttribute('data-kind', 'stopped');
  await expect(card).toContainText('Restoring the working tree here failed');
  await expect(card).toContainText('clash-run still runs on pc-office.');
  await expect(card.locator('[data-action="dismiss"]')).toBeVisible();

  // The clash is gone on the mac; Try again opens the Move dialog for the same computer, and the move succeeds.
  await w.git(w.paths.b.alpha, 'branch', '-q', '-D', 'feature/clash');
  await card.locator('[data-action="move-try-again"]').click();
  dialog = page.getByTestId('v2-move-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('v2-move-sub')).toContainText('pc-office → mac-laptop');
  await expect(dialog.getByTestId('v2-move-start')).toBeEnabled({ timeout: 60_000 });
  await dialog.getByTestId('v2-move-start').click();
  await expect(dialog.getByTestId('v2-move-body')).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
  await dialog.getByTestId('v2-move-close').click();
  // The item closed by itself.
  await expect(card).toHaveCount(0, { timeout: 30_000 });

  // Home: the success and the failure, finished.
  await page.goto(`${w.a.baseUrl}/`);
  const rows = page.getByTestId('v2-home-moves').getByTestId('v2-home-move');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await expect(rows.nth(0)).toHaveAttribute('data-state', 'done');
  await expect(rows.nth(0).getByTestId('v2-home-move-line')).toHaveText('clash-run now runs on mac-laptop.');
  await expect(rows.nth(1)).toHaveAttribute('data-state', 'failed');
  // A finished failure reopens its dialog (Try again there too).
  await rows.nth(1).locator('.v2-home-move-open').click();
  await expect(page.getByTestId('v2-move-status').getByTestId('v2-move-status-retry')).toBeVisible();
  await page.getByTestId('v2-move-status').getByTestId('v2-move-status-close').click();

  // The phone's Home (390 × 844): the same card, and a click opens the move.
  const phone = await v2Page(browser, w.a, '/', { width: 390, height: 844 });
  const phoneCard = phone.getByTestId('v2-home-moves');
  await expect(phoneCard).toHaveAttribute('data-phone', '');
  await expect(phoneCard.getByTestId('v2-home-move')).toHaveCount(2, { timeout: 30_000 });
  const box = await phoneCard.boundingBox();
  expect(box && box.width <= 390).toBe(true);
  await phoneCard.getByTestId('v2-home-move').first().locator('.v2-home-move-open').click();
  await expect(phone.getByTestId('v2-move-status').getByTestId('v2-move-status-body')).toHaveAttribute('data-state', 'done');
});
