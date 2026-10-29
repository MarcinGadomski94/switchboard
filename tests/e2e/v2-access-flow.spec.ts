import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D100-T2 in v2, the whole path from Needs you (real code path: fake-claude, the in-memory
 * keychain of test servers, a loopback "API" for Test connection): an agent asks for two API
 * keys; the older card's **Add key** opens the Access tab at *that* access (not the first one
 * waiting); typing the key and Save key make it Ready, the form stays closed, the value never
 * comes back; the member's session is restarted with the variable (only its mask is recorded);
 * Test connection sends the key to the declared test URL. **Not now** on the other card defers
 * it (status Not now), it does not deny it.
 */
let world: TeamWorld;
let api: http.Server;
const hits: string[] = [];
const KEY = 'acme-crm-e2e-key-7f3a91';

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-v2-access-flow', { plain: true, env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory' } });
  api = http.createServer((request, response) => {
    hits.push(`${request.method} ${String(request.headers['x-api-key'] ?? '')}`);
    response.writeHead(200);
    response.end();
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', () => resolve()));
});

test.afterAll(async () => {
  await world?.stop();
  await new Promise((resolve) => api?.close(resolve));
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function asAgent(sessionId: string, url: string, body: unknown): Promise<{ status: number; body: any }> {
  const config = JSON.parse(await readFile(path.join(world.dataDir, 'agent-mcp', `${sessionId}.json`), 'utf8')) as { mcpServers: { switchboard: { env: Record<string, string> } } };
  const response = await fetch(`${world.baseUrl}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.mcpServers.switchboard.env['SWITCHBOARD_TODO_TOKEN']}`, 'x-switchboard-session': sessionId },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('Needs you → Add key → that access’s form → Ready → the session has it → Test connection; Not now defers', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/needs-you`);
  const session = await world.startSession(page, 'crm-run', 'Reply with just OK.');
  await world.settle(page, session.id);
  const member = await world.adopt(page, session.id, 'Developer', {});
  const host = `127.0.0.1:${(api.address() as { port: number }).port}`;
  const crm = await asAgent(session.id, '/agent/v1/team/access', {
    kind: 'api-key',
    service: 'Acme CRM',
    host,
    why: 'Read the open deals.',
    scope: 'read-only',
    fields: [{ name: 'ACME_CRM_KEY', label: 'CRM key', secret: true, help: '' }],
    testUrl: `http://${host}/ping`,
    testHeader: { name: 'x-api-key', value: '{ACME_CRM_KEY}' },
  });
  expect(crm.status, JSON.stringify(crm.body)).toBe(201);
  const analytics = await asAgent(session.id, '/agent/v1/team/access', { kind: 'api-key', service: 'Acme Analytics', host: 'api.acme.example', why: 'Fetch the weekly report.', scope: 'read-only', fields: [{ name: 'ACME_ANALYTICS_KEY', label: 'API key', secret: true, help: '' }] });
  expect(analytics.status, JSON.stringify(analytics.body)).toBe(201);
  const crmId = crm.body.access.id as string;
  const analyticsId = analytics.body.access.id as string;

  await page.goto(`${world.baseUrl}/needs-you`);
  const cards = page.getByTestId('v2-answer-card').and(page.locator('[data-kind="access"]'));
  await expect(cards).toHaveCount(2);
  const crmCard = cards.filter({ hasText: 'Acme CRM' });
  await expect(crmCard.locator('button[data-action]')).toHaveText([/Add key/, /Deny/, /Not now/]);
  // D146: whose access and which computer (this one).
  await expect(crmCard.getByTestId('v2-answer-access-for')).toContainText('For Developer on');
  await expect(crmCard.getByTestId('v2-answer-access-for')).toContainText('(this computer)');
  await crmCard.locator('[data-action="add-key"]').click();

  // The Access tab at the CRM access (the newer Analytics one waits too, but its form stays shut).
  await expect(page).toHaveURL(new RegExp(`/crews/team\\?member=${member.id}&tab=access&access=${crmId}$`));
  const entry = page.locator(`[data-testid="v2-access-entry"][data-access-id="${crmId}"]`);
  await expect(entry.getByTestId('v2-access-form')).toBeVisible();
  await expect(page.locator(`[data-testid="v2-access-entry"][data-access-id="${analyticsId}"]`).getByTestId('v2-access-form')).toHaveCount(0);
  await expect(page.getByTestId('v2-access-elsewhere')).toHaveCount(0);
  const field = entry.locator('[data-testid="v2-access-field"][data-field="ACME_CRM_KEY"]');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill(KEY);
  await entry.getByTestId('v2-access-save').click();
  // The save's own answer (after the member's restart) closes the form; it then stays closed (a reload racing the save does not open it again).
  await expect(entry.getByTestId('v2-access-form')).toHaveCount(0, { timeout: 20_000 });
  await expect(entry).toHaveAttribute('data-status', 'ready');
  await page.waitForTimeout(1_500);
  await expect(entry.getByTestId('v2-access-form')).toHaveCount(0);
  expect(await page.content()).not.toContain(KEY);
  expect(JSON.stringify((await world.call(page, 'GET', `/api/team/members/${member.id}/access`)).body)).not.toContain(KEY);

  // The member's session (restarted with the access) has the variable; only its mask is recorded.
  await world.settle(page, session.id);
  expect((await world.call(page, 'POST', `/api/sessions/${session.id}/messages`, { text: '[fake:echo-env ACME_CRM_KEY]' })).status).toBeLessThan(300);
  await expect.poll(async () => JSON.stringify((await world.call(page, 'GET', `/api/sessions/${session.id}/events`)).body), { timeout: 20_000 }).toContain('•••• (ACME_CRM_KEY)');
  expect(JSON.stringify((await world.call(page, 'GET', `/api/sessions/${session.id}/events`)).body)).not.toContain(KEY);

  // Test connection: one HEAD to the declared test URL, with the key.
  await entry.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: `HTTP 200 from ${host}` })).toHaveCount(1);
  expect(hits).toEqual([`HEAD ${KEY}`]);

  // Not now on the Analytics card: deferred, not denied.
  await page.goto(`${world.baseUrl}/needs-you`);
  await cards.filter({ hasText: 'Acme Analytics' }).locator('[data-action="not-now"]').click();
  await expect.poll(async () => ((await world.call(page, 'GET', `/api/team/members/${member.id}/access`)).body.entries as Array<{ id: string; status: string }>).find((e) => e.id === analyticsId)?.status, { timeout: 20_000 }).toBe('not-now');
});
