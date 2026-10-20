import { type Browser, type BrowserContext, type Page, type Route, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { type MachinesView, remoteId } from '../../src/core/peers.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, waitFor } from '../helpers/peers.ts';

/**
 * D113 (`docs/artifacts.md`, `docs/inbox.md` → *Loading and syncing*; `docs/peers.md`
 * → *List sync (D113)*) with two real Switchboard processes (A and B, paired on
 * loopback). The Artifacts page and the Inbox show placeholders on their first
 * load (the API answer held by the test); on B, while A holds its artifacts and
 * Inbox (the test hook), both pages say "Syncing with A…" with a spinner and the
 * local rows already shown; once A answers the note goes and A's new artifact
 * merges in; an unreachable A gets a static offline note. The session Artifacts
 * tab of A's session on B says it is loading from A, and that A cannot be
 * reached when the forwarded read fails.
 */

const HOOKS = { SWITCHBOARD_PEER_TEST_HOOKS: '1', SWITCHBOARD_PEER_GRACE_MS: '2000' };

let tmp: string;
let nodes: PeerNode[] = [];
let contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-list-sync');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function pageOn(browser: Browser, width = 1440, height = 900): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height } });
  contexts.push(context);
  return context.newPage();
}

/** Holds `GET <path>` (the page's first read) until the returned function is called. */
async function holdRead(page: Page, pattern: string): Promise<() => void> {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(pattern, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await gate;
    return route.continue();
  });
  return release;
}

async function paired(): Promise<{ a: PeerNode; b: PeerNode; aId: string; aName: string; sessionId: string }> {
  const { a, b, aId } = await pairedNodes(tmp, HOOKS);
  nodes.push(a, b);
  const aName = ((await a.call('GET', '/api/machines')).body as MachinesView).self.name;
  const created = await a.call('POST', '/api/sessions', { name: 'sync-on-a', task: 'Hi.', folder: a.folderId, worktrees: false, ultracode: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const sessionId = (created.body as Session).id;
  expect((await a.call('POST', `/api/sessions/${sessionId}/artifacts`, { title: 'Acme notes', kind: 'markdown', content: '# Acme\n' })).status).toBe(201);
  await waitFor('A\'s artifact on B', async () => ((await b.call('GET', '/api/artifacts')).body as { title: string }[]).some((item) => item.title === 'Acme notes'));
  await waitFor('A synced on B', async () => {
    const sync = (await machineOn(b, aId))?.listSync;
    return sync && !sync.artifacts.syncing && !sync.inbox.syncing && sync.artifacts.syncedAt && sync.inbox.syncedAt;
  });
  return { a, b, aId, aName, sessionId };
}

test('first load: the Artifacts page and the Inbox show placeholders, then the rows (no flash on a re-query)', async ({ browser }) => {
  test.setTimeout(90_000);
  const { b } = await paired();
  const page = await pageOn(browser);
  const releaseArtifacts = await holdRead(page, '**/api/artifacts');
  await page.goto(`${b.baseUrl}/artifacts`);
  const view = page.getByTestId('view-artifacts');
  await expect(page.getByTestId('artifacts-skeleton-row')).toHaveCount(6);
  await expect(page.getByTestId('artifacts-count')).toHaveText('Loading…');
  await expect(view).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('artifacts-skeleton').getByRole('status')).toHaveText('Loading artifacts…');
  releaseArtifacts();
  await expect(page.getByTestId('artifact-row')).toHaveCount(1);
  await expect(page.getByTestId('artifacts-skeleton')).toHaveCount(0);
  await expect(page.getByTestId('artifacts-count')).toHaveText('1 of 1');
  await expect(view).toHaveAttribute('aria-busy', 'false');

  // A re-query (a search) keeps the rows and turns the count's spinner on until it answers.
  let releaseSearch = (): void => undefined;
  const searchGate = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  await page.route('**/api/artifacts?*', async (route) => {
    await searchGate;
    return route.continue();
  });
  await page.getByTestId('artifacts-search').fill('nothing-matches');
  await expect(page.getByTestId('artifacts-requery')).toBeVisible();
  await expect(page.getByTestId('artifact-row')).toHaveCount(1);
  await expect(page.getByTestId('artifacts-skeleton')).toHaveCount(0);
  releaseSearch();
  await expect(page.getByTestId('artifacts-empty')).toHaveText('No artifacts match.');
  await expect(page.getByTestId('artifacts-requery')).toHaveCount(0);

  const inbox = await pageOn(browser, 360, 740);
  const releaseInbox = await holdRead(inbox, '**/api/inbox');
  await inbox.goto(`${b.baseUrl}/inbox`);
  await expect(inbox.getByTestId('inbox-skeleton-card')).toHaveCount(4);
  await expect(inbox.getByTestId('inbox-count')).toHaveText('Loading…');
  await expect(inbox.getByTestId('inbox-list')).toHaveAttribute('aria-busy', 'true');
  releaseInbox();
  await expect(inbox.getByTestId('inbox-count')).toHaveText('0 waiting on you');
  await expect(inbox.getByTestId('inbox-skeleton')).toHaveCount(0);
  await expect(inbox.getByTestId('inbox-list')).toHaveAttribute('aria-busy', 'false');
});

test('syncing: "Syncing with A…" on both pages while A holds its lists, local rows shown; then A\'s new artifact merges in and the note goes', async ({ browser }) => {
  test.setTimeout(90_000);
  const { a, b, aId, aName, sessionId } = await paired();
  const page = await pageOn(browser);
  await page.goto(`${b.baseUrl}/artifacts`);
  await expect(page.getByTestId('artifact-row')).toHaveCount(1);
  const inbox = await pageOn(browser, 360, 740);
  await inbox.goto(`${b.baseUrl}/inbox`);
  await expect(inbox.getByTestId('inbox-count')).toHaveText('0 waiting on you');

  // A holds its lists; B's stream to A drops and B fetches both again (held).
  expect((await a.call('POST', '/api/test/peers/hold-lists')).status).toBe(204);
  expect((await a.call('POST', '/api/test/peers/drop')).status).toBe(200);
  const note = page.getByTestId('artifacts-sync-note');
  await expect(note).toHaveText(`Syncing with ${aName}…`);
  await expect(note).toHaveAttribute('data-kind', 'syncing');
  await expect(note).toHaveAttribute('data-machine-id', aId);
  await expect(page.getByTestId('artifacts-sync-spinner')).toBeVisible();
  await expect(page.getByTestId('artifacts-sync-live')).toHaveText(`Syncing with ${aName}…`);
  // Non-blocking: the rows already there stay, and the page works.
  await expect(page.getByTestId('artifact-row')).toHaveCount(1);
  await expect(inbox.getByTestId('inbox-sync-note')).toHaveText(`Syncing with ${aName}…`);
  await expect(inbox.getByTestId('inbox-count')).toHaveText('0 waiting on you');
  await expect(inbox.getByTestId('inbox-sync-note')).toBeInViewport();

  // Saved on A while the fetch waits; it shows once A answers, and the notes go.
  expect((await a.call('POST', `/api/sessions/${sessionId}/artifacts`, { title: 'Held notes', kind: 'markdown', content: '# Held\n' })).status).toBe(201);
  await expect(page.getByTestId('artifact-row').filter({ hasText: 'Held notes' })).toHaveCount(0);
  expect((await a.call('DELETE', '/api/test/peers/hold-lists')).status).toBe(204);
  await expect(page.getByTestId('artifact-row').filter({ hasText: 'Held notes' })).toHaveCount(1);
  await expect(page.getByTestId('artifacts-sync')).toHaveCount(0);
  await expect(page.getByTestId('artifacts-sync-live')).toHaveText(`Synced with ${aName}.`);
  await expect(inbox.getByTestId('inbox-sync')).toHaveCount(0);
  await expect(inbox.getByTestId('inbox-sync-live')).toHaveText(`Synced with ${aName}.`);
});

test('offline: an unreachable A gets a static note on both pages (no spinner); its session\'s Artifacts tab says it is loading from A, then that A cannot be reached', async ({ browser }) => {
  test.setTimeout(90_000);
  const { a, b, aName, sessionId, aId } = await paired();
  const page = await pageOn(browser);
  await page.goto(`${b.baseUrl}/artifacts`);
  await expect(page.getByTestId('artifact-row')).toHaveCount(1);
  const inbox = await pageOn(browser, 640, 360);
  await inbox.goto(`${b.baseUrl}/inbox`);
  await expect(inbox.getByTestId('inbox-count')).toHaveText('0 waiting on you');

  expect((await a.call('POST', '/api/test/peers/outage', { ms: 60_000 })).status).toBe(204);
  const note = page.getByTestId('artifacts-sync-note');
  await expect(note).toHaveAttribute('data-kind', 'offline', { timeout: 20_000 });
  await expect(note).toHaveText(`${aName} is offline — its artifacts may be out of date`);
  await expect(page.getByTestId('artifacts-sync-spinner')).toHaveCount(0);
  // Its last known rows stay listed.
  await expect(page.getByTestId('artifact-row')).toHaveCount(1);
  const inboxNote = inbox.getByTestId('inbox-sync-note');
  await expect(inboxNote).toHaveAttribute('data-kind', 'offline');
  await expect(inboxNote).toHaveText(`${aName} is offline — its items are not shown until it is back`);
  await expect(inbox.getByTestId('inbox-sync-spinner')).toHaveCount(0);

  // The session tab of A's session: loading from A while the forwarded read is in flight, then why it failed.
  const id = remoteId(aId, sessionId);
  const tab = await pageOn(browser, 768, 1024);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await tab.route(`**/api/sessions/${encodeURIComponent(id)}/artifacts`, async (route) => {
    await gate;
    return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'peer-unreachable', message: `${aName} is unreachable` }) });
  });
  await tab.goto(`${b.baseUrl}/sessions/${encodeURIComponent(id)}/artifacts`);
  await expect(tab.getByTestId('artifacts-loading')).toHaveText(`Loading artifacts from ${aName}…`);
  await expect(tab.getByTestId('artifacts-skeleton-row')).toHaveCount(3);
  await expect(tab.getByTestId('artifacts-list')).toHaveAttribute('aria-busy', 'true');
  release();
  const error = tab.getByTestId('artifacts-error');
  await expect(error).toHaveAttribute('data-kind', 'offline');
  await expect(error).toContainText(`${aName} cannot be reached — its artifacts cannot be shown now.`);
  await expect(tab.getByTestId('artifacts-retry')).toBeVisible();
  await expect(tab.getByTestId('artifacts-skeleton-row')).toHaveCount(0);
});
