import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import { freeTestPorts, makeTempDir, removeTempDir } from '../helpers/net.ts';
import type { MachinesView } from '../../src/core/peers.ts';
import { remoteId } from '../../src/core/peers.ts';
import { type PeerNode, enableListener, machineOn, pairedNodes, startPeerNode, waitFor } from '../helpers/peers.ts';

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


async function paired(): Promise<{ a: PeerNode; b: PeerNode; aId: string; aName: string }> {
  const world = await pairedNodes(tmp);
  nodes.push(world.a, world.b);
  const aName = ((await world.a.call('GET', '/api/machines')).body as MachinesView).self.name;
  return { a: world.a, b: world.b, aId: world.aId, aName };
}

test('P2: a peer\'s session in the sidebar with its tag; the full view drives it: question card, permission in the Inbox, message, pause; unreachable when the peer stops', async ({ browser }) => {
  const { a, b, aId, aName } = await paired();
  const page = await pageOf(browser, b, '/');
  await expect(page.getByTestId('view-inbox')).toBeVisible();
  const started = await a.call('POST', '/api/sessions', { name: 'on-a', task: '[fake:ask-2q] Ask me two questions.', folder: a.folderId, worktrees: false, ultracode: false });
  expect(started.status).toBe(201);
  const id = remoteId(aId, started.body.id as string);

  const row = page.locator('.sb-session', { hasText: 'on-a' });
  await expect(row.getByTestId('machine-tag')).toHaveText(aName, { timeout: 15_000 });
  await expect(row.getByTestId('machine-tag')).toHaveAttribute('data-state', 'online');
  // The question batch is in B's Inbox with the machine tag, and raised a toast here.
  await expect(page.getByTestId('toast')).toBeVisible({ timeout: 10_000 });
  const questions = page.getByTestId('inbox-item').filter({ hasText: 'on-a' });
  await expect(questions.getByTestId('machine-tag')).toHaveText(aName);

  // The full session view, from the sidebar.
  await row.click();
  await expect(page).toHaveURL(`${b.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('session-machine')).toHaveText(aName);
  await expect(page.getByTestId('session-handoff')).toHaveCount(0);
  const view = page.getByTestId('view-session');
  const card = view.getByTestId('question-card');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Green' }).click();
  await card.getByRole('button', { name: 'Small' }).click();
  const answered = page.waitForResponse((r) => /\/api\/questions\/batch\/[^/]+\/answers$/.test(r.url()));
  await card.getByTestId('question-send').click();
  expect((await answered).status()).toBe(204);
  await expect(view.getByTestId('question-card')).toHaveCount(0);
  await expect(view.getByTestId('chat-answer')).toHaveCount(2);
  expect(((await a.call('GET', '/api/inbox')).body as unknown[]).length).toBe(0);

  // A message from B; its permission request is answered in B's Inbox.
  const input = page.getByTestId('chat-input');
  await input.fill('[fake:perm-allow] Run the command.');
  const posted = page.waitForResponse((r) => r.url().endsWith(`/api/sessions/${id}/messages`) && r.request().method() === 'POST');
  await input.press('Enter');
  expect((await posted).status()).toBe(202);
  await page.getByTestId('nav-inbox').click();
  const permission = page.getByTestId('inbox-item').filter({ hasText: 'on-a' });
  await expect(permission).toHaveAttribute('data-kind', 'permission', { timeout: 15_000 });
  await permission.click();
  await expect(page.getByTestId('inbox-machine')).toHaveText(aName);
  await expect(page.getByTestId('permission-request')).toBeVisible();
  const allowed = page.waitForResponse((r) => r.url().includes('/actions/allow-once'));
  await page.getByTestId('inbox-action').filter({ hasText: 'Allow once' }).click();
  expect((await allowed).status()).toBe(204);
  await waitFor('A\'s permission decided', async () => ((await a.call('GET', '/api/inbox')).body as unknown[]).length === 0);

  // Pause from B's header; the session on A is paused.
  await row.click();
  const pause = page.getByTestId('session-pause');
  await expect(pause).toHaveAttribute('data-action', 'pause', { timeout: 15_000 });
  await pause.click();
  await expect(pause).toHaveAttribute('data-action', 'resume', { timeout: 15_000 });
  expect((await a.call('GET', `/api/sessions/${started.body.id as string}`)).body.status).toBe('paused');

  // A stops: its session stays listed, tagged unreachable.
  await a.server.stop();
  await expect(row.getByTestId('machine-tag')).toHaveText(`${aName} · unreachable`, { timeout: 15_000 });
});

test('P3: the New-session form starts a session on a peer: its folders and models, then the remote session opens', async ({ browser }) => {
  const { a, b, aId, aName } = await paired();
  const page = await pageOf(browser, b, '/');
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  const machine = modal.getByTestId('ns-machine');
  await expect(machine).toBeVisible();
  await expect(machine.locator('option')).toHaveText([/^This machine/, aName]);
  // This machine first: its own repo folder.
  await expect(modal.getByTestId('ns-folder').locator('option:checked')).toHaveText(/repo-b/);
  await machine.selectOption(aId);
  await expect(modal.getByTestId('ns-machine-note')).toBeVisible();
  await expect(modal.getByTestId('ns-folder').locator('option:checked')).toHaveText(/repo-a/);
  await expect(modal.getByTestId('ns-folder-browse')).toHaveCount(0);
  await expect(modal.getByTestId('ns-remote')).toHaveCount(0);
  await expect(modal.getByTestId('ns-resume')).toHaveCount(0);
  await modal.getByTestId('ns-name').fill('Started from B');
  await modal.getByTestId('ns-task').fill('Say OK.');
  // In place (no worktree), so no ticket branch is needed.
  const worktree = modal.getByTestId('ns-switch-worktrees');
  await expect(worktree).toHaveAttribute('aria-checked', 'true');
  await worktree.click();
  await expect(worktree).toHaveAttribute('aria-checked', 'false');
  const created = page.waitForResponse((r) => r.url().endsWith(`/api/machines/${aId}/api/sessions`) && r.request().method() === 'POST');
  await modal.getByTestId('ns-start').click();
  expect((await created).status()).toBe(201);
  await expect(page).toHaveURL(new RegExp(`/sessions/r~${aId}~`));
  await expect(page.getByTestId('session-machine')).toHaveText(aName);
  await expect(page.getByTestId('session-name')).toHaveText('Started from B');
  const onA = (await a.call('GET', '/api/sessions')).body as Array<{ title: string; folder: string }>;
  expect(onA).toMatchObject([{ title: 'Started from B', folder: a.folderId }]);
  expect(((await b.call('GET', '/api/sessions')).body as Array<{ machine: unknown }>).every((session) => session.machine !== null)).toBe(true);
});
