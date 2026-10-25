import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * D100-T2 (E2E, real code path: fake-claude, the in-memory keychain of test servers):
 * a member's agent asks for an API key (`request_access`'s route with the session's
 * own agent token); the Access tab's dev mount shows it in Needs you with the exact
 * service and host; Set up… opens a form with exactly the declared field; the saved
 * value never comes back; the member's session then prints the key in a tool result
 * and only `•••• (ACME_ANALYTICS_KEY)` is recorded, while a plain session has no such
 * variable; Deny closes another request; Revoke ends the access.
 */
let tmp: string;
let server: ServerProcess;

const KEY = 'acme-live-e2e-5c1d9f7a3b';

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-team-access');
  const workspace = path.join(tmp, 'work space');
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  await seedFolderInDataDir(path.join(tmp, 'data'), workspace);
  server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    SWITCHBOARD_TUTORIAL: 'off',
    SWITCHBOARD_TEST_SECRET_STORE: 'memory',
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  await removeTempDir(tmp);
});

async function call(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ method: m, url: u, body: b }) => {
      const response = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    { method, url, body },
  );
}

async function start(page: Page, name: string): Promise<string> {
  const answer = await call(page, 'POST', '/api/sessions', { name, task: 'Reply with just OK.', workType: 'feature', mode: 'single', solutions: [], phase: 'ui-first', coordination: 'none', qa: null, worktrees: false, ultracode: false });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.id as string;
}

async function settled(page: Page, id: string): Promise<void> {
  await expect.poll(async () => (await call(page, 'GET', `/api/sessions/${id}`)).body.status, { timeout: 20_000 }).toBe('done');
}

/** The agent's side: the session's own agent token, from the MCP config Switchboard wrote for its spawn. */
async function asAgent(sessionId: string, url: string, body: unknown): Promise<{ status: number; body: any }> {
  const config = JSON.parse(await readFile(path.join(tmp, 'data', 'agent-mcp', `${sessionId}.json`), 'utf8')) as { mcpServers: { switchboard: { env: Record<string, string> } } };
  const response = await fetch(`${server.baseUrl}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.mcpServers.switchboard.env['SWITCHBOARD_TODO_TOKEN']}`, 'x-switchboard-session': sessionId },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const REQUEST = {
  kind: 'api-key',
  service: 'Acme Analytics',
  host: 'api.acme.example',
  why: 'Fetch the weekly traffic report for the summary.',
  scope: 'read-only, reports',
  fields: [{ name: 'ACME_ANALYTICS_KEY', label: 'API key', secret: true, help: 'Settings → API keys: a read-only key.' }],
};

test('request → Needs you → set up → only that member gets it, masked → deny → revoke', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const marketing = await start(page, 'marketing-run');
  const plain = await start(page, 'plain-run');
  await settled(page, marketing);
  await settled(page, plain);
  const adopted = await call(page, 'POST', '/api/team/members', { sessionId: marketing, name: 'Marketing monitoring' });
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
  const memberId = adopted.body.id as string;

  const asked = await asAgent(marketing, '/agent/v1/team/access', REQUEST);
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  const accessId = asked.body.access.id as string;
  // A plain session cannot ask.
  expect((await asAgent(plain, '/agent/v1/team/access', REQUEST)).status).toBe(404);

  await page.goto(`${server.baseUrl}/team-access-dev.html?member=${memberId}`);
  const card = page.getByTestId(`access-request-${accessId}`);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('access-request-host')).toHaveText('api.acme.example');
  const entry = page.getByTestId(`access-entry-${accessId}`);
  await expect(entry).toHaveAttribute('data-status', 'requested');

  // Set up…: exactly the declared field, as a password field.
  await card.getByTestId('access-request-setup').click();
  const form = entry.getByTestId('access-form');
  await expect(form).toBeVisible();
  await expect(form.locator('[data-testid^="access-field-"]')).toHaveCount(1);
  const input = form.getByTestId('access-input-ACME_ANALYTICS_KEY');
  await expect(input).toHaveAttribute('type', 'password');
  await input.fill(KEY);
  await form.getByTestId('access-save').click();
  await expect(entry).toHaveAttribute('data-status', 'ready');
  await expect(entry.getByTestId('access-status')).toContainText('Ready on');
  await expect(page.getByTestId(`access-request-${accessId}`)).toHaveCount(0);
  expect(await page.content()).not.toContain(KEY);
  await page.screenshot({ path: test.info().outputPath('access-tab-ready.png'), fullPage: true });
  expect(JSON.stringify((await call(page, 'GET', `/api/team/members/${memberId}/access`)).body)).not.toContain(KEY);

  // The member (restarted once with the access) prints the key: only the mask is recorded. A plain session has no such variable.
  await settled(page, marketing);
  for (const id of [marketing, plain]) expect((await call(page, 'POST', `/api/sessions/${id}/messages`, { text: '[fake:echo-env ACME_ANALYTICS_KEY]' })).status).toBeLessThan(300);
  await expect.poll(async () => JSON.stringify((await call(page, 'GET', `/api/sessions/${marketing}/events`)).body), { timeout: 20_000 }).toContain('•••• (ACME_ANALYTICS_KEY)');
  await settled(page, plain);
  const memberEvents = JSON.stringify((await call(page, 'GET', `/api/sessions/${marketing}/events`)).body);
  const plainEvents = JSON.stringify((await call(page, 'GET', `/api/sessions/${plain}/events`)).body);
  expect(memberEvents).not.toContain(KEY);
  expect(plainEvents).not.toContain(KEY);
  expect(plainEvents).not.toContain('•••• (ACME_ANALYTICS_KEY)');

  // Deny another request from its Needs-you card.
  const second = await asAgent(marketing, '/agent/v1/team/access', { ...REQUEST, service: 'Acme CRM', host: 'crm.acme.example', fields: [{ name: 'ACME_CRM_KEY', label: 'CRM key', secret: true, help: '' }] });
  expect(second.status).toBe(201);
  const denied = page.getByTestId(`access-request-${second.body.access.id}`);
  await expect(denied).toBeVisible();
  await denied.getByTestId('access-request-deny').click();
  await expect(denied).toHaveCount(0);
  await expect(page.getByTestId(`access-entry-${second.body.access.id}`)).toHaveAttribute('data-status', 'denied');

  // Revoke.
  page.once('dialog', (dialog) => void dialog.accept());
  await entry.getByTestId('access-revoke').click();
  await expect(entry).toHaveAttribute('data-status', 'revoked');
  await entry.getByTestId('access-audit-toggle').click();
  await expect(entry.getByTestId('access-audit').locator('li')).toHaveText([/Revoked on/, /Given to the member/, /Set up on/, /asked for Acme Analytics on api\.acme\.example/]);
});
