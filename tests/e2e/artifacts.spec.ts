import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D89 on the real path (D13, fake-claude; `docs/artifacts.md` → *Artifacts
 * page*): the global Artifacts page lists the artifacts saved on purpose in every
 * session, newest first (kind · title · session · versions · saved by · age).
 * The kind filters and the session filter ask the service; search matches the
 * title and the session; a row opens the session's Artifacts tab on that
 * artifact; a save shows up live, and the sidebar's count follows.
 */
test.describe.configure({ mode: 'serial' });

let world: QuestionWorld;
const ids: Record<string, string> = {};

test.beforeAll(async () => {
  world = await startQuestionWorld('artifacts-page');
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

/** What the agent's `artifact_save` does (the session's agent token). */
async function agentSaves(sessionId: string, fields: Record<string, unknown>): Promise<string> {
  const secret = (await readFile(path.join(world.dataDir, 'sb_token'), 'utf8')).trim();
  const token = createHmac('sha256', secret).update(`switchboard-agent-todos:${sessionId}`).digest('base64url');
  const url = new URL(world.baseUrl);
  const body = JSON.stringify(fields);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(url.port),
        path: '/agent/v1/artifacts',
        method: 'POST',
        headers: { host: url.host, authorization: `Bearer ${token}`, 'x-switchboard-session': sessionId, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => (res.statusCode === 201 ? resolve((JSON.parse(Buffer.concat(chunks).toString()) as { artifact: { id: string } }).artifact.id) : reject(new Error(`${res.statusCode}`))));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function settled(page: Page): Promise<void> {
  await expect(page.getByTestId('view-artifacts')).toHaveAttribute('aria-busy', 'false');
}

test('a fresh install: the columns, the kind filters and the empty note', async ({ page }) => {
  await page.goto(`${world.baseUrl}/artifacts`);
  const view = page.getByTestId('view-artifacts');
  await expect(view.locator('.sb-art-title')).toHaveText('Artifacts');
  await expect(page.getByTestId('artifacts-count')).toHaveText('0 of 0');
  await expect(page.getByTestId('artifacts-filter')).toHaveText(['All', 'Docs', 'Code', 'HTML', 'Diagrams', 'Images', 'Tables']);
  await expect(view.locator('.sb-art-cols > span')).toHaveText(['Kind', 'Title', 'Session', 'Versions', 'Saved by', 'Age']);
  await expect(page.getByTestId('artifacts-empty')).toContainText('No artifacts yet.');
  await expect(page.getByTestId('nav-artifacts')).toHaveAttribute('aria-current', 'page');
});

test('every session\'s artifacts; kind, session and text filters; a row opens its session\'s tab on it; live', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/artifacts`);
  const pay = await world.startSession(page, 'pay-flow', 'Hi.');
  const qa = await world.startSession(page, 'qa-pay', 'Hi.');
  ids['plan'] = await agentSaves(pay.id, { title: 'Pay plan', kind: 'markdown', content: '# Pay plan\n' });
  ids['diagram'] = await agentSaves(pay.id, { title: 'Pay flow', kind: 'mermaid', content: 'graph TD; A-->B' });
  ids['matrix'] = await agentSaves(qa.id, { title: 'Coverage', kind: 'csv', content: 'a,b\n1,2\n' });
  await expect(page.getByTestId('artifacts-count')).toHaveText('3 of 3');
  await expect(page.locator('.sb-art-name')).toHaveText(['Coverage', 'Pay flow', 'Pay plan']);
  await expect(page.locator('.sb-art-type')).toHaveText(['TABLE', 'DIAGRAM', 'DOC']);
  await expect(page.locator('.sb-art-location')).toHaveText(['qa-pay', 'pay-flow', 'pay-flow']);
  await expect(page.locator('.sb-art-meta')).toHaveText(['agent', 'agent', 'agent']);
  await expect(page.getByTestId('nav-artifacts')).toContainText('3');

  const kinds: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/artifacts' && url.searchParams.has('kind')) kinds.push(url.searchParams.get('kind') ?? '');
  });
  await page.getByTestId('artifacts-filter').filter({ hasText: /^Diagrams$/ }).click();
  await settled(page);
  await expect(page.getByTestId('artifacts-count')).toHaveText('1 of 3');
  await expect(page.locator('.sb-art-name')).toHaveText(['Pay flow']);
  expect(kinds).toContain('mermaid,svg');
  await page.getByTestId('artifacts-filter').filter({ hasText: /^All$/ }).click();
  await page.getByTestId('artifacts-session').selectOption({ label: 'qa-pay' });
  await settled(page);
  await expect(page.locator('.sb-art-name')).toHaveText(['Coverage']);
  await page.getByTestId('artifacts-session').selectOption('');
  await page.getByTestId('artifacts-search').fill('PAY-FLOW');
  await settled(page);
  await expect(page.locator('.sb-art-name')).toHaveText(['Pay flow', 'Pay plan']);
  await page.getByTestId('artifacts-search').fill('');
  await settled(page);

  // Live: a new version moves the row to the top.
  await agentSaves(pay.id, { id: ids['plan'], title: 'Pay plan', kind: 'markdown', content: '# Pay plan v2\n' });
  await expect(page.locator('.sb-art-name').first()).toHaveText('Pay plan');
  await expect(page.locator('.sb-art-session').first()).toHaveText('v2');

  await page.locator('.sb-art-row').filter({ hasText: 'Coverage' }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${qa.id}/artifacts/${ids['matrix']}$`));
  await expect(page.getByTestId('artifact-viewer')).toHaveAttribute('data-artifact-id', ids['matrix']!);
  await expect(page.getByTestId('artifact-table')).toBeVisible();
});

/** A same-origin call of the page (its cookie, its Origin). */
async function call(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ([m, u, b]) => {
      const response = await fetch(u as string, { method: m as string, ...(b === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }) });
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
    },
    [method, url, body] as const,
  );
}

function item(page: Page, title: string) {
  return page.getByTestId('artifact-item').filter({ has: page.locator('.sb-art-name', { hasText: new RegExp(`^${title}$`) }) });
}

test('D89 follow-up · a row\'s ⋯ → Delete… asks first (keyboard too), never opens the row; a row without a session is deleted too', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/artifacts`);
  await settled(page);
  // An artifact whose session is gone: a chat's, then the chat is deleted.
  const chat = (await call(page, 'POST', '/api/chats', { message: 'Old notes' })).body as { id: string };
  await expect.poll(async () => ((await call(page, 'GET', `/api/sessions/${chat.id}`)).body as { status: string }).status, { timeout: 20_000 }).toBe('done');
  ids['old'] = await agentSaves(chat.id, { title: 'Old notes', kind: 'markdown', content: '# Old\n' });
  await expect(item(page, 'Old notes')).toHaveCount(1);
  expect((await call(page, 'DELETE', `/api/chats/${chat.id}`, { confirm: true })).status).toBe(204);
  await expect(item(page, 'Old notes').getByTestId('artifact-row')).toHaveAttribute('data-no-session', '');
  const url = page.url();

  // The ⋯ opens its menu, not the row; Esc closes it and gives the focus back.
  const flow = item(page, 'Pay flow');
  const more = flow.getByTestId('artifact-row-menu');
  await expect(more).toHaveAttribute('aria-label', 'Actions for Pay flow');
  await more.click();
  await expect(page.getByTestId('artifact-row-menu-list')).toBeVisible();
  expect(page.url()).toBe(url);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('artifact-row-menu-list')).toHaveCount(0);
  await expect(more).toBeFocused();

  // Keyboard: Enter opens the menu on Delete…, Enter asks; Cancel has the focus.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('artifact-row-delete')).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.getByTestId('artifact-delete-confirm');
  await expect(confirm).toHaveText(/Delete “Pay flow” and all its versions\? This cannot be undone\./);
  await expect(page.getByTestId('artifact-delete-cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveCount(0);
  await expect(flow).toHaveCount(1);
  expect(page.url()).toBe(url);

  await more.click();
  await page.getByTestId('artifact-row-delete').click();
  await page.getByTestId('artifact-delete-yes').click();
  await expect(confirm).toHaveCount(0);
  await expect(flow).toHaveCount(0);

  // The row without a session: DELETE /api/artifacts/{id}.
  const orphan = page.waitForRequest((request) => request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/artifacts/${ids['old']}`);
  await item(page, 'Old notes').getByTestId('artifact-row-menu').click();
  await page.getByTestId('artifact-row-delete').click();
  await expect(confirm).toContainText('Delete “Old notes” and all its versions?');
  await page.getByTestId('artifact-delete-yes').click();
  await orphan;
  await expect(item(page, 'Old notes')).toHaveCount(0);
  await expect(page.locator('.sb-art-name')).toHaveText(['Pay plan', 'Coverage']);
  expect(page.url()).toBe(url);
});

test('D89 follow-up · bulk Delete: select all shown, filters keep only shown rows, a partial failure keeps the failed rows selected', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/artifacts`);
  await settled(page);
  const pay = (((await call(page, 'GET', '/api/artifacts')).body as Array<{ title: string; sessionId: string }>).find((row) => row.title === 'Pay plan'))!.sessionId;
  ids['bulkA'] = await agentSaves(pay, { title: 'Bulk A', kind: 'markdown', content: 'a' });
  ids['bulkB'] = await agentSaves(pay, { title: 'Bulk B', kind: 'markdown', content: 'b' });
  await expect(item(page, 'Bulk B')).toHaveCount(1);
  await expect(page.getByTestId('artifacts-bulk')).toHaveCount(0);

  // Select all = every shown row.
  await page.getByTestId('artifacts-search').fill('Bulk');
  await settled(page);
  await expect(page.locator('.sb-art-name')).toHaveText(['Bulk B', 'Bulk A']);
  await page.getByTestId('artifacts-select-all').check();
  await expect(page.getByTestId('artifacts-selected')).toHaveText('2 selected');
  await expect(page.getByTestId('artifacts-delete-selected')).toHaveText('Delete 2');
  // A narrower filter keeps only what is still shown; widening it does not bring the others back.
  await page.getByTestId('artifacts-search').fill('Bulk A');
  await settled(page);
  await expect(page.getByTestId('artifacts-selected')).toHaveText('1 selected');
  await page.getByTestId('artifacts-search').fill('');
  await settled(page);
  await expect(page.getByTestId('artifacts-selected')).toHaveText('1 selected');
  await expect(item(page, 'Bulk A').getByTestId('artifact-select')).toBeChecked();
  await expect(item(page, 'Bulk B').getByTestId('artifact-select')).not.toBeChecked();
  await expect(page.getByTestId('artifacts-select-all')).toHaveJSProperty('indeterminate', true);
  await item(page, 'Bulk B').getByTestId('artifact-select').check();
  await page.getByTestId('artifacts-clear-selection').click();
  await expect(page.getByTestId('artifacts-bulk')).toHaveCount(0);
  await item(page, 'Bulk A').getByTestId('artifact-select').check();
  await item(page, 'Bulk B').getByTestId('artifact-select').check();

  // Delete 2: one question, each artifact through its own route.
  const deletes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE') deletes.push(new URL(request.url()).pathname);
  });
  await page.getByTestId('artifacts-delete-selected').click();
  await expect(page.getByTestId('artifact-delete-confirm')).toHaveText(/Delete 2 artifacts and all their versions\? This cannot be undone\./);
  await page.getByTestId('artifact-delete-yes').click();
  await expect(item(page, 'Bulk A')).toHaveCount(0);
  await expect(item(page, 'Bulk B')).toHaveCount(0);
  await expect(page.getByTestId('artifacts-bulk')).toHaveCount(0);
  expect(deletes.sort()).toEqual([`/api/sessions/${pay}/artifacts/${ids['bulkA']}`, `/api/sessions/${pay}/artifacts/${ids['bulkB']}`].sort());

  // A partial failure: the failed row stays selected, with how many failed and why.
  ids['failA'] = await agentSaves(pay, { title: 'Fail A', kind: 'markdown', content: 'a' });
  ids['failB'] = await agentSaves(pay, { title: 'Fail B', kind: 'markdown', content: 'b' });
  await expect(item(page, 'Fail B')).toHaveCount(1);
  await page.route(`**/api/sessions/*/artifacts/${ids['failB']}`, (route) =>
    route.request().method() === 'DELETE' ? route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'peer-unreachable', message: 'Acme-PC is unreachable' }) }) : route.continue(),
  );
  await item(page, 'Fail A').getByTestId('artifact-select').check();
  await item(page, 'Fail B').getByTestId('artifact-select').check();
  await page.getByTestId('artifacts-delete-selected').click();
  await page.getByTestId('artifact-delete-yes').click();
  await expect(item(page, 'Fail A')).toHaveCount(0);
  await expect(page.getByTestId('artifacts-bulk-error')).toHaveText('1 of 2 could not be deleted: Acme-PC is unreachable');
  await expect(page.getByTestId('artifacts-selected')).toHaveText('1 selected');
  await expect(item(page, 'Fail B').getByTestId('artifact-select')).toBeChecked();
  await page.unroute(`**/api/sessions/*/artifacts/${ids['failB']}`);

  // A selected row deleted elsewhere drops out of the selection on the reload.
  expect((await call(page, 'DELETE', `/api/sessions/${pay}/artifacts/${ids['failB']}`)).status).toBe(204);
  await expect(item(page, 'Fail B')).toHaveCount(0);
  await expect(page.getByTestId('artifacts-bulk')).toHaveCount(0);
});

test('D89 follow-up · D48: a paired machine\'s row whose machine is unreachable cannot be selected or deleted and says why; a reachable one\'s without a session is deleted there', async ({ page }) => {
  const remote = (id: string, title: string, state: 'online' | 'offline') => ({
    id,
    sessionId: null,
    title,
    kind: 'markdown',
    language: null,
    createdBy: 'agent',
    versions: 1,
    size: 1,
    createdAt: '2026-10-19T10:00:00.000Z',
    updatedAt: '2026-10-19T10:00:00.000Z',
    sessionName: null,
    sessionTitle: null,
    folder: null,
    folderPath: null,
    machine: { id: 'abcdefghijkl', name: 'Acme-PC', state },
  });
  let rows: unknown[] = [remote('0a0a0a0a0a', 'Far notes', 'offline'), remote('0b0b0b0b0b', 'Near notes', 'online')];
  await page.route('**/api/artifacts*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    return route.fulfill({ response, json: [...rows, ...((await response.json()) as unknown[])] });
  });
  let forwarded = '';
  await page.route('**/api/machines/*/api/artifacts/*', (route) => {
    forwarded = `${route.request().method()} ${new URL(route.request().url()).pathname}`;
    rows = rows.slice(0, 1);
    return route.fulfill({ status: 204 });
  });
  await openWithHub(page, `${world.baseUrl}/artifacts`);
  await settled(page);
  const far = item(page, 'Far notes');
  await expect(far).toHaveAttribute('data-blocked', 'true');
  await expect(far.getByTestId('artifact-select')).toBeDisabled();
  await expect(far.locator('.sb-art-check')).toHaveAttribute('title', 'Acme-PC is unreachable');
  await far.getByTestId('artifact-row-menu').click();
  await expect(page.getByTestId('artifact-row-delete')).toBeDisabled();
  await expect(page.getByTestId('artifact-row-blocked')).toHaveText('Acme-PC is unreachable');
  await page.keyboard.press('Escape');
  // Select all leaves it out.
  await page.getByTestId('artifacts-select-all').check();
  await expect(far.getByTestId('artifact-select')).not.toBeChecked();
  await expect(item(page, 'Near notes').getByTestId('artifact-select')).toBeChecked();
  await page.getByTestId('artifacts-clear-selection').click();

  await item(page, 'Near notes').getByTestId('artifact-row-menu').click();
  await page.getByTestId('artifact-row-delete').click();
  await page.getByTestId('artifact-delete-yes').click();
  await expect(item(page, 'Near notes')).toHaveCount(0);
  expect(forwarded).toBe('DELETE /api/machines/abcdefghijkl/api/artifacts/0b0b0b0b0b');
});

test('D89 follow-up · a phone: Select all in words, the ⋯ menu and the confirmation fit the window', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openWithHub(page, `${world.baseUrl}/artifacts`);
  await settled(page);
  await expect(page.locator('.sb-art-check-label')).toBeVisible();
  await expect(page.locator('.sb-art-check-label')).toHaveText('Select all');
  const more = page.getByTestId('artifact-row-menu').first();
  await more.click();
  const menu = page.getByTestId('artifact-row-menu-list');
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(box.y + box.height).toBeLessThanOrEqual(740);
  await page.getByTestId('artifact-row-delete').click();
  const dialog = (await page.getByTestId('artifact-delete-confirm').boundingBox())!;
  expect(dialog.x).toBeGreaterThanOrEqual(0);
  expect(dialog.x + dialog.width).toBeLessThanOrEqual(360);
  await page.getByTestId('artifact-delete-cancel').click();
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scroll).toBeLessThanOrEqual(360);
});
