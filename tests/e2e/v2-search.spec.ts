import { type Page, expect, test } from '@playwright/test';
import type { MachinesView } from '../../src/core/peers.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, enableListener, machineOn, pair, startPeerNode, waitFor } from '../helpers/peers.ts';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';
import { stubToolProbes } from './probes.ts';
import { expectNoOverflow } from './responsive-world.ts';
import { V2_SERVER_ENV, useV2 } from './v2-world.ts';

/**
 * D131 · lane R · v2 Search (`/search?q=`) on the real D97 search (fake-claude):
 * a message is found, highlighted and grouped under Messages, with the "Searched
 * … · any time" note; the type chip and the date filter live in the address; a
 * message hit opens `/agents/:id/events/:eventId`; on a phone nothing overflows;
 * a paired computer whose connection dropped is "not searched (offline |
 * reconnecting)".
 */
test.describe.configure({ mode: 'serial' });

let world: QuestionWorld;
let sessionId = '';

test.beforeAll(async ({ browser }) => {
  test.setTimeout(90_000);
  world = await startQuestionWorld('v2-search', { env: { ...V2_SERVER_ENV } });
  const page = await browser.newPage();
  await page.goto(world.baseUrl);
  sessionId = (await world.startSession(page, 'ledger-agent', 'Where does the zanzibar ledger reconcile?')).id;
  await expect
    .poll(async () => page.evaluate(async (sid) => ((await (await fetch(`/api/sessions/${sid}`)).json()) as { status: string }).status, sessionId), { timeout: 20_000 })
    .toBe('done');
  await page.close();
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function searchFor(page: Page, text: string): Promise<void> {
  await page.getByTestId('v2-search-input').fill(text);
  await expect(page.getByTestId('v2-page-search')).not.toHaveAttribute('aria-busy', 'true');
}

test('a message is found and opens the exact message in its agent', async ({ page }) => {
  await page.goto(`${world.baseUrl}/search`);
  await expect(page.getByTestId('v2-page-search')).toBeVisible();
  await expect(page.getByTestId('v2-search-input')).toBeFocused();
  await expect(page.getByTestId('v2-search-hint')).toBeVisible();
  await expect(page.getByTestId('v2-search-type')).toHaveText(['Everything', 'Messages', 'Results', 'Tasks', 'Archived agents']);
  await searchFor(page, 'zanzibar ledger');
  await expect(page).toHaveURL(/\/search\?q=zanzibar\+ledger$/);
  const messages = page.locator('[data-testid="v2-search-group"][data-type="messages"]');
  await expect(messages).toBeVisible();
  await expect(messages.getByRole('heading', { name: 'Messages' })).toBeVisible();
  const hit = messages.locator('[data-testid="v2-search-hit"][data-kind="message"]').first();
  await expect(hit).toContainText('Exact message');
  await expect(hit.getByTestId('v2-search-mark')).toHaveText(['zanzibar', 'ledger']);
  await expect(page.getByTestId('v2-search-note')).toHaveAttribute('data-kind', 'ok');
  await expect(page.getByTestId('v2-search-note')).toContainText(/^Searched .+ · any time$/);
  const eventId = ((await hit.getAttribute('data-result-id')) ?? '').replace(/^e:/, '');
  expect(eventId).toMatch(/^\d+$/);
  await hit.click();
  await expect(page).toHaveURL(`${world.baseUrl}/agents/${encodeURIComponent(sessionId)}/events/${eventId}`);
});

test('an agent-title hit peeks at the agent (lane X); Open full view opens it', async ({ page }) => {
  await page.goto(`${world.baseUrl}/search?q=ledger-agent`);
  const hit = page.locator('[data-testid="v2-search-hit"][data-kind="session"]').first();
  await expect(hit).toBeVisible();
  await hit.click();
  const peek = page.getByTestId('v2-agent-peek');
  await expect(peek).toBeVisible();
  await expect(page).toHaveURL(/\/search\?q=ledger-agent$/);
  await peek.getByTestId('v2-agent-peek-full').click();
  await expect(page).toHaveURL(`${world.baseUrl}/agents/${encodeURIComponent(sessionId)}`);
});

test('the type chip and the date filter live in the address; nothing found is said', async ({ page }) => {
  await page.goto(`${world.baseUrl}/search?q=zanzibar`);
  await expect(page.getByTestId('v2-search-input')).toHaveValue('zanzibar');
  await expect(page.locator('[data-testid="v2-search-group"][data-type="messages"]')).toBeVisible();
  await page.locator('[data-testid="v2-search-type"][data-type="tasks"]').click();
  await expect(page).toHaveURL(/type=tasks/);
  await expect(page.locator('[data-testid="v2-search-type"][data-type="tasks"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('v2-search-empty')).toContainText('Nothing found');
  await page.locator('[data-testid="v2-search-type"][data-type="messages"]').click();
  await expect(page.locator('[data-testid="v2-search-group"][data-type="messages"] [data-testid="v2-search-hit"]').first()).toBeVisible();
  await page.getByTestId('v2-search-date').selectOption('today');
  await expect(page).toHaveURL(/date=today/);
  await expect(page.getByTestId('v2-search-note')).toContainText('· today');
  await expect(page.locator('[data-testid="v2-search-group"][data-type="messages"] [data-testid="v2-search-hit"]').first()).toBeVisible();
  // A paired computer that is not there: nothing of this computer's matches.
  await page.goto(`${world.baseUrl}/search?q=zanzibar&computer=nowhere`);
  await expect(page.getByTestId('v2-search-empty')).toBeVisible();
});

test('phone: the search fits 390 px and a hit still opens its message', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/search?q=zanzibar`);
  const hit = page.locator('[data-testid="v2-search-group"][data-type="messages"] [data-testid="v2-search-hit"]').first();
  await expect(hit).toBeVisible();
  await expectNoOverflow(page, 390, 'v2 search at 390');
  const box = await page.getByTestId('v2-search-date').boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/agents/${sessionId}/events/\\d+$`));
});

test.describe('a paired computer', () => {
  let tmp: string;
  let nodes: PeerNode[] = [];

  test.afterEach(async () => {
    await Promise.all(nodes.map((node) => node.server.stop()));
    nodes = [];
    if (tmp) await removeTempDir(tmp);
  });

  test('that dropped off is "not searched (offline)" — or reconnecting while it retries', async ({ page }) => {
    test.setTimeout(90_000);
    tmp = await makeTempDir('e2e-v2-search-peer');
    const env = { SWITCHBOARD_PEER_TEST_HOOKS: '1', SWITCHBOARD_PEER_GRACE_MS: '3000' };
    const a = await startPeerNode(tmp, 'a', { env });
    nodes.push(a);
    const b = await startPeerNode(tmp, 'b', { env });
    nodes.push(b);
    await pair(a, b, await enableListener(a));
    const aId = await a.machineId();
    await waitFor('A online on B', async () => (await machineOn(b, aId))?.state === 'online');
    const aName = ((await a.call('GET', '/api/machines')).body as MachinesView).self.name;
    await useV2(page);
    await stubToolProbes(page);
    await page.goto(`${b.baseUrl}/search?q=anything`);
    await expect(page.getByTestId('v2-search-note')).toHaveAttribute('data-kind', 'ok');
    await expect(page.getByTestId('v2-search-note')).toContainText(aName);
    // A's listener goes away: B's search leaves it out and says why.
    expect((await a.call('POST', '/api/test/peers/outage', { ms: 120_000 })).status).toBe(204);
    await waitFor('A not online on B', async () => (await machineOn(b, aId))?.state !== 'online', 20_000);
    await page.reload();
    const note = page.getByTestId('v2-search-note');
    await expect(note).toHaveAttribute('data-kind', 'missing', { timeout: 15_000 });
    await expect(note.locator('b')).toHaveText(new RegExp(`^${aName} not searched \\((offline|reconnecting)\\)$`));
    await expect(note).toContainText('its agents and results show up again when it’s back.');
    // The computer filter lists it with its state.
    await expect(page.getByTestId('v2-search-computer').locator(`option[value="${aId}"]`)).toHaveText(new RegExp(`^${aName} · (offline|reconnecting)$`));
  });
});
