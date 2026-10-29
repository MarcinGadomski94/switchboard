import { readdir, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TeamAccessEntryView, TeamAccessView } from '../../../src/core/team-access.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';
import { removeWorld, settle, startRepoSession } from '../../helpers/takeover.ts';

/**
 * D146 · an access set up from another paired machine, with two real Switchboard processes
 * (fake-claude, each its own in-memory keychain, the peer link on loopback): a member runs on
 * B and asks for an API key; the developer types it on A. The value goes once over the peer
 * link into **B's** keychain and B's member session gets it (only its mask is recorded); A's
 * keychain, both data folders (team.db, the logs, every synced row) and every answer never
 * hold it. Test connection and Revoke from A run on B; the audit says "on B from A". A paired
 * machine cannot set up a member that does not run on it, and an offline B means 502, with
 * nothing stored on A.
 */

const KEY = 'acme-peer-key-6b2e94d1c7';

let tmp: string;
let nodes: { a: PeerNode; b: PeerNode; aId: string; bId: string } | null = null;
let api: http.Server | null = null;
const hits: string[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('team-access-peers');
});

afterEach(async () => {
  if (api) await new Promise((resolve) => api?.close(resolve));
  api = null;
  if (nodes) await Promise.all([nodes.a.server.stop(), nodes.b.server.stop()]);
  nodes = null;
  await removeWorld(tmp);
});

/** The session's own agent calls B's agent API (its token from the MCP config B wrote for its spawn). */
async function asAgent(node: PeerNode, sessionId: string, url: string, body: unknown): Promise<{ status: number; body: any }> {
  const config = JSON.parse(await readFile(path.join(node.dataDir, 'agent-mcp', `${sessionId}.json`), 'utf8')) as { mcpServers: { switchboard: { env: Record<string, string> } } };
  const response = await fetch(`${node.baseUrl}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.mcpServers.switchboard.env['SWITCHBOARD_TODO_TOKEN']}`, 'x-switchboard-session': sessionId },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** Every file under `dir` that contains `text` (the data folders: databases, logs, configs). */
async function filesContaining(dir: string, text: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const name of await readdir(current).catch(() => [])) {
      const full = path.join(current, name);
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) await walk(full);
      else if (info.size < 50_000_000 && (await readFile(full)).includes(text)) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

async function accessOn(node: PeerNode, memberId: string, accessId: string): Promise<TeamAccessEntryView> {
  const view = (await node.call('GET', `/api/team/members/${memberId}/access`)).body as TeamAccessView;
  return view.entries.find((entry) => entry.id === accessId) as TeamAccessEntryView;
}

describe('D146 · an access set up from another paired machine', () => {
  it('the key typed on A reaches only B (its keychain, its member); test and revoke from A run on B; a member elsewhere is refused; offline is 502', async () => {
    const w = (nodes = await pairedNodes(tmp));
    api = http.createServer((request, response) => {
      hits.push(`${request.method} ${String(request.headers['x-api-key'] ?? '')}`);
      response.writeHead(200);
      response.end();
    });
    await new Promise<void>((resolve) => api?.listen(0, '127.0.0.1', () => resolve()));
    const host = `127.0.0.1:${(api.address() as { port: number }).port}`;

    // A member that runs on B (adopted on B), and its request.
    const session = await startRepoSession(w.b, w.b.folderId as string, 'crm-run', { task: 'Reply with just OK.' });
    const adopted = await w.b.call('POST', '/api/team/members', { sessionId: session.id, name: 'Sales' });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    const memberId = adopted.body.id as string;
    const asked = await asAgent(w.b, session.id, '/agent/v1/team/access', {
      kind: 'api-key',
      service: 'Acme CRM',
      host,
      why: 'Read the open deals.',
      scope: 'read-only',
      fields: [{ name: 'ACME_CRM_KEY', label: 'CRM key', secret: true, help: '' }],
      testUrl: `http://${host}/ping`,
      testHeader: { name: 'x-api-key', value: '{ACME_CRM_KEY}' },
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const accessId = asked.body.access.id as string;
    // A sees the request and whose machine it is for.
    const seen = await waitFor('A sees the access', async () => accessOn(w.a, memberId, accessId).catch(() => null));
    expect(seen.member).toMatchObject({ name: 'Sales', machineId: w.bId, local: false });

    // A sets it up: it goes to B.
    const setUp = await w.a.call('POST', `/api/team/access/${accessId}/setup`, { values: { ACME_CRM_KEY: KEY } });
    expect(setUp.status, JSON.stringify(setUp.body)).toBe(200);
    expect(JSON.stringify(setUp.body)).not.toContain(KEY);
    const onB = await accessOn(w.b, memberId, accessId);
    expect([onB.status, onB.here, onB.setUpOn]).toEqual(['ready', true, [w.bId]]);
    const [aName, bName] = await Promise.all([w.a, w.b].map(async (node) => ((await node.call('GET', '/api/machines')).body as { self: { name: string } }).self.name));
    expect(onB.audit.map((entry) => entry.text)).toContain(`Set up on ${bName} from ${aName}`);
    await waitFor('A shows it ready on B', async () => {
      const entry = await accessOn(w.a, memberId, accessId);
      return entry.status === 'ready' && entry.setUpOn.join() === w.bId && !entry.here;
    });

    // B's member session gets it (masked in what is recorded).
    await settle(w.b, session.id);
    expect((await w.b.call('POST', `/api/sessions/${session.id}/messages`, { text: '[fake:echo-env ACME_CRM_KEY]' })).status).toBeLessThan(300);
    await waitFor('the masked key in B’s events', async () => JSON.stringify((await w.b.call('GET', `/api/sessions/${session.id}/events`)).body).includes('•••• (ACME_CRM_KEY)'), 20_000);

    // A's keychain never had it: a test on A's own values finds nothing.
    const onA = await w.a.call('POST', `/api/team/access/${accessId}/test`, { here: true });
    expect([onA.status, onA.body.error]).toEqual([409, 'not-set-up']);

    // Test connection from A runs on B, with B's value; the answer is masked.
    const tested = await w.a.call('POST', `/api/team/access/${accessId}/test`, {});
    expect(tested.status, JSON.stringify(tested.body)).toBe(200);
    expect(tested.body.ok).toBe(true);
    expect(JSON.stringify(tested.body)).not.toContain(KEY);
    expect(hits).toEqual([`HEAD ${KEY}`]);
    expect((await accessOn(w.b, memberId, accessId)).audit.map((entry) => entry.text)).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^Test connection on ${bName} from ${aName}: OK`))]));

    // A paired machine cannot act on a member that does not run on the machine it asks: A's own member, asked from B's side.
    const own = await startRepoSession(w.a, w.a.folderId as string, 'own-run', { task: 'Reply with just OK.' });
    const ownMember = (await w.a.call('POST', '/api/team/members', { sessionId: own.id, name: 'Local' })).body.id as string;
    const ownAsked = await asAgent(w.a, own.id, '/agent/v1/team/access', { kind: 'api-key', service: 'Acme Wiki', host: 'wiki.acme.example', why: 'Read pages.', scope: 'read-only', fields: [{ name: 'ACME_WIKI_KEY', label: 'Wiki key', secret: true, help: '' }] });
    const ownId = ownAsked.body.access.id as string;
    await waitFor('B sees A’s access', async () => accessOn(w.b, ownMember, ownId).catch(() => null));
    // Sent to B through A's machine proxy (B's peer API): B refuses it, since that member runs on A.
    const refused = await w.a.call('POST', `/api/machines/${w.bId}/api/team/access/${ownId}/setup`, { values: { ACME_WIKI_KEY: `${KEY}-wiki` } });
    expect([refused.status, refused.body.error]).toEqual([403, 'not-here']);

    // Revoke from A runs on B: B's value goes, its member restarts without it.
    const revoked = await w.a.call('POST', `/api/team/access/${accessId}/revoke`, {});
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    const afterRevoke = await accessOn(w.b, memberId, accessId);
    expect([afterRevoke.status, afterRevoke.setUpOn]).toEqual(['revoked', []]);
    expect(afterRevoke.audit.map((entry) => entry.text)).toContain(`Revoked on ${bName} from ${aName}`);
    const testAfter = await w.b.call('POST', `/api/team/access/${accessId}/test`, {});
    expect(testAfter.status).toBe(409);

    // Nothing holds the value: neither data folder (databases, logs, synced rows), nor A's team view.
    expect(await filesContaining(w.a.dataDir, KEY)).toEqual([]);
    expect(await filesContaining(w.b.dataDir, KEY)).toEqual([]);
    expect(JSON.stringify((await w.a.call('GET', '/api/team')).body)).not.toContain(KEY);
    expect(JSON.stringify((await w.a.call('GET', '/api/team/needs-you?teamId=all')).body)).not.toContain(KEY);

    // B away: a setup from A is refused (502), nothing is stored on A.
    const second = await asAgent(w.b, session.id, '/agent/v1/team/access', { kind: 'api-key', service: 'Acme Billing', host: 'billing.acme.example', why: 'Read invoices.', scope: 'read-only', fields: [{ name: 'ACME_BILLING_KEY', label: 'Billing key', secret: true, help: '' }] });
    const secondId = second.body.access.id as string;
    await waitFor('A sees the second access', async () => accessOn(w.a, memberId, secondId).catch(() => null));
    await w.b.server.stop();
    await waitFor('B offline on A', async () => ((await w.a.call('GET', '/api/machines')).body.machines as Array<{ id: string; state: string }>).find((m) => m.id === w.bId)?.state !== 'online', 30_000);
    const offline = await w.a.call('POST', `/api/team/access/${secondId}/setup`, { values: { ACME_BILLING_KEY: `${KEY}-billing` } });
    expect([offline.status, offline.body.error]).toEqual([502, 'peer-unreachable']);
    const onAAfter = await accessOn(w.a, memberId, secondId);
    expect([onAAfter.here, onAAfter.setUpOn]).toEqual([false, []]);
    expect((await w.a.call('POST', `/api/team/access/${secondId}/test`, { here: true })).status).toBe(409);
  }, 180_000);
});
