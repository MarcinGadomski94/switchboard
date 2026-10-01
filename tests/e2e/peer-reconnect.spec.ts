import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import type { MachinesView } from '../../src/core/peers.ts';
import { remoteId } from '../../src/core/peers.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, enableListener, machineOn, pair, startPeerNode, waitFor } from '../helpers/peers.ts';

/**
 * Fix · peer reconnects (`docs/peers.md` → *Connection states*): two real
 * Switchboard processes; A's test hook stops its peer listener (connection
 * refused, no real network). B's session view shows "Reconnecting to A…" with a
 * spinner (nothing blocked) during the grace period, then "A is unreachable ·
 * retrying in N s" with the last error and **Reconnect now** (composer blocked);
 * Reconnect now while A is down says why; once A is back it lifts every block at
 * once. Settings → Machines follows live (the `/hub` event `machineState`).
 */

let tmp: string;
let nodes: PeerNode[] = [];
let contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-peer-reconnect');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function pageOf(browser: Browser, target: PeerNode, path: string): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${target.baseUrl}${path}`);
  return { page, context };
}

test('a dropped peer: reconnecting (non-blocking) → unreachable with the countdown and Reconnect now → back at once', async ({ browser }) => {
  test.setTimeout(120_000);
  // Only A listens: B reaches A, A never reaches B, so A coming back does not wake B's connection with its hello
  // (D48-hello-wakes) and the Reconnect now below is what brings it back.
  const env = { SWITCHBOARD_PEER_TEST_HOOKS: '1', SWITCHBOARD_PEER_GRACE_MS: '4000' };
  const a = await startPeerNode(tmp, 'a', { repo: true, env });
  nodes.push(a);
  const b = await startPeerNode(tmp, 'b', { repo: true, env });
  nodes.push(b);
  await pair(a, b, await enableListener(a));
  const aId = await a.machineId();
  await waitFor('A online on B', async () => (await machineOn(b, aId))?.state === 'online');
  const aName = ((await a.call('GET', '/api/machines')).body as MachinesView).self.name;
  const started = await a.call('POST', '/api/sessions', { name: 'on-a', task: 'Say OK.', folder: a.folderId, worktrees: false, ultracode: false });
  expect(started.status).toBe(201);
  await waitFor('the turn done on A', async () => ['idle', 'done'].includes((await a.call('GET', `/api/sessions/${started.body.id as string}`)).body.status));
  const id = remoteId(aId, started.body.id as string);

  const { page, context } = await pageOf(browser, b, `/sessions/${encodeURIComponent(id)}`);
  const view = page.getByTestId('view-session');
  await expect(view.getByTestId('chat-text').first()).toBeVisible({ timeout: 15_000 });
  const row = page.locator('.sb-session', { hasText: 'on-a' });
  await expect(row.getByTestId('machine-tag')).toHaveText(aName);
  await expect(page.getByTestId('session-offline-note')).toHaveCount(0);
  // Settings → Machines in a second tab: it follows without a reload.
  const settings = await context.newPage();
  await settings.goto(`${b.baseUrl}/settings/machines`);
  const machineRow = settings.locator(`[data-testid="machine"][data-machine-id="${aId}"]`);
  await expect(machineRow.getByTestId('machine-state')).toHaveText('online', { timeout: 15_000 });

  // A's listener goes away (connection refused).
  expect((await a.call('POST', '/api/test/peers/outage', { ms: 120_000 })).status).toBe(204);

  // Within the grace period: reconnecting, a spinner, nothing blocked.
  const note = page.getByTestId('session-offline-note');
  await expect(note).toHaveAttribute('data-state', 'reconnecting');
  await expect(page.getByTestId('session-offline-note-text')).toHaveText(new RegExp(`^Reconnecting to ${aName}…`));
  await expect(page.getByTestId('session-offline-note-spinner')).toBeVisible();
  await expect(page.getByTestId('chat-reconnecting')).toBeVisible();
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await expect(page.getByTestId('chat-blocked')).toHaveCount(0);
  await expect(row.getByTestId('machine-tag')).toHaveText(`${aName} · reconnecting…`);

  // After it: unreachable with the countdown, the last error and Reconnect now; the composer blocked.
  await expect(note).toHaveAttribute('data-state', 'offline', { timeout: 10_000 });
  await expect(page.getByTestId('session-offline-note-text')).toHaveText(new RegExp(`^${aName} is unreachable · (retrying in \\d+ s|trying now…)$`));
  await expect(page.getByTestId('session-offline-note-detail')).toContainText('connection refused');
  await expect(page.getByTestId('chat-blocked-text')).toHaveText(new RegExp(`^${aName} is unreachable`));
  await expect(page.getByTestId('chat-input')).toBeDisabled();
  await expect(row.getByTestId('machine-tag')).toHaveText(`${aName} · unreachable`);
  await expect(machineRow.getByTestId('machine-state')).toHaveText('unreachable');
  await expect(machineRow.getByTestId('machine-status-text')).toHaveText(new RegExp(`^${aName} is unreachable`));
  await expect(machineRow.getByTestId('machine-reconnect')).toBeVisible();

  // Reconnect now while A is still down: the reason.
  const reconnect = page.getByTestId('session-offline-note-reconnect');
  await reconnect.click();
  await expect(page.getByTestId('session-offline-note-reconnect-failure')).toHaveText(/^Not reached: connection refused/);
  await expect(reconnect).toBeEnabled();

  // A is back: Reconnect now lifts every block at once.
  expect((await a.call('DELETE', '/api/test/peers/outage')).status).toBe(204);
  await reconnect.click();
  await expect(note).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await expect(page.getByTestId('chat-blocked')).toHaveCount(0);
  await expect(row.getByTestId('machine-tag')).toHaveText(aName);
  await expect(machineRow.getByTestId('machine-state')).toHaveText('online', { timeout: 3_000 });
  await expect(machineRow.getByTestId('machine-reconnect')).toHaveCount(0);
});
