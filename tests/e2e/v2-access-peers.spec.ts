import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type BrowserContext, expect, test } from '@playwright/test';
import type { TeamAccessView } from '../../src/core/team-access.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, waitFor } from '../helpers/peers.ts';
import { startRepoSession } from '../helpers/takeover.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D146 in v2, two real Switchboard processes paired on loopback (fake-claude, each its own
 * in-memory keychain): a teammate runs on B and asks for an API key; on A, Needs you's card says
 * "For Sales on <B>", Add key opens the Access tab that says the key is sent to B, and Save key
 * puts it in B's keychain: B's teammate session gets it (only its mask is recorded), A keeps
 * nothing, and the page never shows it again.
 */
const KEY = 'acme-v2-peer-key-41c9e07b';

let tmp: string;
let nodes: PeerNode[] = [];
let contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-v2-access-peers');
});

test.afterAll(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function asAgent(node: PeerNode, sessionId: string, url: string, body: unknown): Promise<{ status: number; body: any }> {
  const config = JSON.parse(await readFile(path.join(node.dataDir, 'agent-mcp', `${sessionId}.json`), 'utf8')) as { mcpServers: { switchboard: { env: Record<string, string> } } };
  const response = await fetch(`${node.baseUrl}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.mcpServers.switchboard.env['SWITCHBOARD_TODO_TOKEN']}`, 'x-switchboard-session': sessionId },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('a key typed on A for a teammate on B goes to B (v2: Needs you → Add key → Save key)', async ({ browser }) => {
  test.setTimeout(150_000);
  const paired = await pairedNodes(tmp, { ...V2_SERVER_ENV });
  const { a, b } = paired;
  nodes.push(a, b);
  const bName = (await machineOn(a, paired.bId))?.name as string;

  const session = await startRepoSession(b, b.folderId as string, 'sales-run', { task: 'Reply with just OK.' });
  const memberId = (await b.call('POST', '/api/team/members', { sessionId: session.id, name: 'Sales' })).body.id as string;
  const asked = await asAgent(b, session.id, '/agent/v1/team/access', { kind: 'api-key', service: 'Acme CRM', host: 'crm.acme.example', why: 'Read the open deals.', scope: 'read-only', fields: [{ name: 'ACME_CRM_KEY', label: 'CRM key', secret: true, help: '' }] });
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  const accessId = asked.body.access.id as string;
  await waitFor('A sees the request', async () => ((await a.call('GET', '/api/team/needs-you?teamId=all')).body as Array<{ kind: string }>).some((item) => item.kind === 'access'), 30_000);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  await stubToolProbes(page);
  await page.goto(`${a.baseUrl}/needs-you`);
  const card = page.getByTestId('v2-answer-card').and(page.locator('[data-kind="access"]'));
  await expect(card.getByTestId('v2-answer-access-for')).toHaveText(new RegExp(`For Sales on ${bName} · the key is sent there`));
  await card.locator('[data-action="add-key"]').click();

  const entry = page.locator(`[data-testid="v2-access-entry"][data-access-id="${accessId}"]`);
  await expect(page.getByTestId('v2-access-target')).toContainText(`For Sales on ${bName}`);
  await expect(entry.getByTestId('v2-access-form-where')).toContainText(`Sent once to ${bName}`);
  await entry.locator('[data-testid="v2-access-field"][data-field="ACME_CRM_KEY"]').fill(KEY);
  await entry.getByTestId('v2-access-save').click();
  // The save's answer comes after B restarted its teammate.
  await expect(entry.getByTestId('v2-access-form')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('v2-toast').filter({ hasText: `Acme CRM set up on ${bName}.` })).toHaveCount(1);
  await expect(entry).toHaveAttribute('data-status', 'ready');
  expect(await page.content()).not.toContain(KEY);

  // In B's keychain, for B's teammate (its session gets the variable; only the mask is recorded); A has none.
  const onB = ((await b.call('GET', `/api/team/members/${memberId}/access`)).body as TeamAccessView).entries[0];
  expect([onB?.here, onB?.status]).toEqual([true, 'ready']);
  const onA = ((await a.call('GET', `/api/team/members/${memberId}/access`)).body as TeamAccessView).entries[0];
  expect(onA?.here).toBe(false);
  await waitFor('B’s teammate idle', async () => ['done', 'idle'].includes(((await b.call('GET', `/api/sessions/${session.id}`)).body as { status: string }).status), 20_000);
  expect((await b.call('POST', `/api/sessions/${session.id}/messages`, { text: '[fake:echo-env ACME_CRM_KEY]' })).status).toBeLessThan(300);
  await waitFor('the masked key on B', async () => JSON.stringify((await b.call('GET', `/api/sessions/${session.id}/events`)).body).includes('•••• (ACME_CRM_KEY)'), 20_000);
  expect(JSON.stringify((await b.call('GET', `/api/sessions/${session.id}/events`)).body)).not.toContain(KEY);
});
