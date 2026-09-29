import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import { freeTestPorts, makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, enableListener, machineOn, startPeerNode, waitFor } from '../helpers/peers.ts';

/**
 * D48 "Switchboard peers" oracle (`docs/peers.md`): two real Switchboard
 * processes on loopback test ports act as peers (the peer listener may bind
 * 127.0.0.1 only under SWITCHBOARD_PEER_TEST_LOOPBACK=1; `tailscale ip -4` is the
 * fake CLI; the sessions run fake-claude). Each machine's UI is its own browser
 * context: the `sb_token` cookies of two ports on one host would overwrite each
 * other in one context.
 */

let tmp: string;
let nodes: PeerNode[] = [];
let contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-peers');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function node(label: string, env: Record<string, string> = {}): Promise<PeerNode> {
  const started = await startPeerNode(tmp, label, { env });
  nodes.push(started);
  return started;
}

async function pageOf(browser: Browser, target: PeerNode, path: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${target.baseUrl}${path}`);
  return page;
}

test('P1: pair two machines from Settings → Machines; both see each other online', async ({ browser }) => {
  const a = await node('a');
  const b = await node('b');
  // The listener's port: a free test port (13002 is the real default), then switched on from the UI.
  const port = (await freeTestPorts()).at(-1) as number;
  expect((await a.call('PUT', '/api/machines/listener', { port })).status).toBe(200);

  const pageA = await pageOf(browser, a, '/settings/machines');
  await expect(pageA.getByTestId('settings-title')).toHaveText('Machines');
  await expect(pageA.getByTestId('machines-listener')).toHaveText('off');
  await expect(pageA.getByTestId('machines-empty')).toBeVisible();
  await pageA.getByTestId('machines-listener').click();
  await expect(pageA.getByTestId('machines-listener')).toHaveText('on');
  await expect(pageA.getByTestId('machines-listener-desc')).toContainText(`127.0.0.1:${port}`);
  await pageA.getByTestId('machines-allow').click();
  const code = (await pageA.getByTestId('machines-code').textContent()) as string;
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  await expect(pageA.getByTestId('machines-code-left')).toHaveText(/^(9|10):\d\d$/);

  const pageB = await pageOf(browser, b, '/settings/machines');
  await pageB.getByTestId('machines-add-address').fill(`127.0.0.1:${port}`);
  await pageB.getByTestId('machines-add-code').fill(code.toLowerCase());
  await pageB.getByTestId('machines-add').click();
  const onB = pageB.getByTestId('machine');
  await expect(onB).toHaveCount(1);
  await expect(onB.getByTestId('machine-state')).toHaveText('online', { timeout: 15_000 });

  // A lists B, without an address until B's own listener is on.
  await expect(pageA.getByTestId('machine')).toHaveCount(1, { timeout: 10_000 });
  await expect(pageA.getByTestId('machine-state')).toHaveText('no address');
  await enableListener(b);
  await expect(pageA.getByTestId('machine-state')).toHaveText('online', { timeout: 15_000 });

  // Rename on B (a local tag); a used code is refused.
  await onB.getByTestId('machine-rename').click();
  await onB.getByTestId('machine-rename-input').fill('pc-office');
  await onB.getByTestId('machine-rename-save').click();
  await expect(onB.getByTestId('machine-name')).toHaveText('pc-office');
  await pageB.getByTestId('machines-add-address').fill(`127.0.0.1:${port}`);
  await pageB.getByTestId('machines-add-code').fill(code);
  await pageB.getByTestId('machines-add').click();
  await expect(pageB.getByTestId('machines-error')).toContainText(/code/);

  // Remove on B: both forget the pairing.
  await onB.getByTestId('machine-remove').click();
  await expect(pageB.getByTestId('machines-empty')).toBeVisible();
  const bId = await b.machineId();
  await waitFor('A forgot B', async () => (await machineOn(a, bId)) === null);
  await expect(pageA.getByTestId('machines-empty')).toBeVisible({ timeout: 10_000 });
});

