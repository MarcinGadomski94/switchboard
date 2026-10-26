import path from 'node:path';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import type { Session, SessionDetail } from '../../src/core/api.ts';
import { remoteId } from '../../src/core/peers.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, waitFor } from '../helpers/peers.ts';
import { stubToolProbes } from './probes.ts';
import { useV2 } from './v2-world.ts';

/**
 * D137 follow-up 2026-10-26 with two paired Switchboard processes: B's Archived list (v2
 * desktop and 390 × 844) and classic History show A's archived agents with A's computer tag
 * and A's own countdown (A's period is 7 days, B's 14) or Kept reason; Restore on such a row
 * reopens it on A through the peer proxy. Screenshots go to `SWITCHBOARD_SHOTS_DIR` when set.
 */
const SHOTS = process.env['SWITCHBOARD_SHOTS_DIR'] ?? '';
let tmp: string;
let nodes: PeerNode[] = [];
let contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-archive-peers');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function pageOf(browser: Browser, target: PeerNode, at: string, options: { v2: boolean; phone?: boolean }): Promise<Page> {
  const context = await browser.newContext(options.phone ? { viewport: { width: 390, height: 844 }, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  if (options.v2) await useV2(page);
  await stubToolProbes(page);
  await page.goto(`${target.baseUrl}${at}`);
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/** Starts a session on `node`, waits for its first turn, then archives it (Close). */
async function archivedOn(node: PeerNode, name: string, title: string): Promise<string> {
  const created = await node.call('POST', '/api/sessions', { name, title, task: 'Say OK.', folder: node.folderId, worktrees: false, ultracode: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = (created.body as Session).id;
  await waitFor(`${name}'s turn done`, async () => ['idle', 'done'].includes(((await node.call('GET', `/api/sessions/${id}`)).body as SessionDetail).status));
  return id;
}

async function archive(node: PeerNode, id: string): Promise<void> {
  expect((await node.call('POST', `/api/sessions/${id}/close`, { confirm: true })).status).toBe(200);
}

test('a paired computer\'s archived agents: v2 Archived (desktop and phone) and classic History show its tag and its countdown; Restore reopens it there', async ({ browser }) => {
  test.setTimeout(180_000);
  const { a, b, aId } = await pairedNodes(tmp);
  nodes.push(a, b);
  const aName = (await machineOn(b, aId))?.name as string;
  expect((await a.call('PUT', '/api/settings', { 'sessions.archiveDays': 7 })).status).toBe(200);
  const checkout = await archivedOn(a, 'checkout-flow', 'Checkout flow');
  const pinned = await archivedOn(a, 'pricing-page', 'Pricing page');
  const docs = await archivedOn(a, 'docs-cleanup', 'Docs cleanup');
  expect((await a.call('POST', '/api/sidebar/place', { sessionId: pinned, place: 'pinned' })).status).toBe(200);
  for (const id of [checkout, pinned, docs]) await archive(a, id);
  // B has them (with A's Kept reason) before the pages open.
  await waitFor('A\'s archived agents on B', async () => {
    const rows = ((await b.call('GET', '/api/sessions?closed=only')).body as Session[]).filter((session) => session.machine?.id === aId);
    return rows.length === 3 && rows.find((session) => session.id === remoteId(aId, pinned))?.keptReason === 'pinned';
  }, 30_000);

  // v2 Archived on B (desktop).
  const page = await pageOf(browser, b, '/agents?show=closed', { v2: true });
  await expect(page.getByTestId('v2-archive-policy')).toHaveText('Archived agents are deleted after 14 days. Change in Settings.');
  const row = (id: string) => page.locator(`[data-testid="v2-closed-row"][data-session="${remoteId(aId, id)}"]`);
  await expect(row(checkout).getByTestId('v2-closed-countdown')).toHaveText(' · Deletes in 7 days');
  await expect(row(pinned).getByTestId('v2-closed-countdown')).toHaveText(' · Kept: pinned');
  await expect(row(checkout).getByTestId('v2-computer-tag')).toContainText(aName.split(/[\s.-]/)[0] as string);
  await shot(page, 'archive-peers-v2');
  await row(checkout).getByTestId('v2-closed-reopen').click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Restored “Checkout flow”.' })).toBeVisible();
  await expect(row(checkout)).toHaveCount(0);
  await expect.poll(async () => ((await a.call('GET', `/api/sessions/${checkout}`)).body as SessionDetail).closedAt ?? null).toBeNull();
  // A reload reads the merged list again: still restored there.
  await page.reload();
  await expect(row(pinned)).toBeVisible();
  await expect(row(checkout)).toHaveCount(0);

  // v2 Archived on a phone (B): the same rows, nothing wider than the screen.
  const phone = await pageOf(browser, b, '/agents?show=closed', { v2: true, phone: true });
  const phoneRow = (id: string) => phone.locator(`[data-testid="v2-closed-row"][data-session="${remoteId(aId, id)}"]`);
  await expect(phoneRow(docs).getByTestId('v2-closed-countdown')).toHaveText(' · Deletes in 7 days');
  await expect(phoneRow(pinned).getByTestId('v2-closed-countdown')).toHaveText(' · Kept: pinned');
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await shot(phone, 'archive-peers-v2-phone');

  // Classic History on B: A's rows with its tag and countdown; Restore opens the session (on A, through the proxy).
  const classic = await pageOf(browser, b, '/history', { v2: false });
  const hist = (id: string) => classic.locator(`[data-testid="history-row"][data-session-id="${remoteId(aId, id)}"]`);
  await expect(hist(docs).getByTestId('history-closed-tag')).toHaveText('Archived');
  await expect(hist(docs).getByTestId('history-archive-countdown')).toHaveText('Deletes in 7 days');
  await expect(hist(pinned).getByTestId('history-archive-countdown')).toHaveText('Kept: pinned');
  await expect(hist(docs).getByTestId('machine-tag')).toHaveText(aName);
  await shot(classic, 'archive-peers-classic');
  await hist(docs).getByTestId('history-reopen').click();
  await expect(classic).toHaveURL(new RegExp(`/sessions/.*${docs}`));
  await expect.poll(async () => ((await a.call('GET', `/api/sessions/${docs}`)).body as SessionDetail).closedAt ?? null).toBeNull();
});
