import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_FILE } from '../../../src/server/db/database.ts';
import { makeTempDir, rawRequest, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, enableListener, machineOn, pair, startPeerNode, waitFor } from '../../helpers/peers.ts';

/**
 * D48 P1 with two real Switchboard processes on loopback test ports (the peer
 * listener may bind 127.0.0.1 only under SWITCHBOARD_PEER_TEST_LOOPBACK=1).
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-pair');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function twoNodes(): Promise<[PeerNode, PeerNode]> {
  const a = await startPeerNode(tmp, 'a');
  nodes.push(a);
  const b = await startPeerNode(tmp, 'b');
  nodes.push(b);
  return [a, b];
}

describe('D48 pairing (two processes)', () => {
  it('the listener is off by default; one pairing works in both directions once both listen', async () => {
    const [a, b] = await twoNodes();
    const view = (await a.call('GET', '/api/machines')).body;
    expect(view.listener).toMatchObject({ enabled: false, listening: null, port: 13002 });
    expect(view.machines).toEqual([]);
    expect(view.self.id).toMatch(/^[a-z2-7]{12}$/);

    const aAddress = await enableListener(a);
    const added = await pair(a, b, aAddress);
    const aId = await a.machineId();
    const bId = await b.machineId();
    expect(added).toMatchObject({ id: aId, address: aAddress });
    // B connects to A.
    await waitFor('B sees A online', async () => (await machineOn(b, aId))?.state === 'online');
    // A knows B, but B does not listen yet: no address.
    expect(await machineOn(a, bId)).toMatchObject({ id: bId, address: null, state: 'no-address' });

    // B switches its listener on: its next hello tells A where it is, and A connects back.
    const bAddress = await enableListener(b);
    await waitFor('A sees B online', async () => {
      const machine = await machineOn(a, bId);
      return machine?.state === 'online' && machine.address === bAddress;
    });

    // Tokens: the checking side stores only a hash (43 chars, sha256 base64url), never the token it checks.
    const db = new DatabaseSync(path.join(a.dataDir, DB_FILE), { readOnly: true });
    let outbound: string;
    try {
      const row = db.prepare('SELECT outbound_token, inbound_token_hash FROM machines').get() as { outbound_token: string; inbound_token_hash: string };
      expect(row.inbound_token_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(row.outbound_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(row.outbound_token).not.toBe(row.inbound_token_hash);
      outbound = row.outbound_token;
    } finally {
      db.close();
    }
    // Neither token reaches the UI.
    const shown = JSON.stringify((await a.call('GET', '/api/machines')).body);
    expect(shown).not.toContain(outbound);
  });

  it('codes are single use and refused when wrong; a removed machine is forgotten on both sides', async () => {
    const [a, b] = await twoNodes();
    const aAddress = await enableListener(a);
    const code = (await a.call('POST', '/api/machines/pairing-code')).body.code as string;
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const wrong = await b.call('POST', '/api/machines', { address: aAddress, code: code === 'AAAA-AAAA' ? 'BBBB-BBBB' : 'AAAA-AAAA' });
    expect(wrong).toMatchObject({ status: 409, body: { error: 'pairing-refused' } });
    expect((await b.call('POST', '/api/machines', { address: aAddress, code })).status).toBe(201);
    const again = await b.call('POST', '/api/machines', { address: aAddress, code });
    expect(again).toMatchObject({ status: 409, body: { error: 'pairing-refused' } });
    expect((await b.call('POST', '/api/machines', { address: 'pc.example', code })).status).toBe(422);

    const aId = await a.machineId();
    const bId = await b.machineId();
    await waitFor('B sees A online', async () => (await machineOn(b, aId))?.state === 'online');
    expect(await machineOn(a, bId)).not.toBeNull();
    expect((await b.call('DELETE', `/api/machines/${aId}`)).status).toBe(204);
    expect(await machineOn(b, aId)).toBeNull();
    await waitFor('A forgot B', async () => (await machineOn(a, bId)) === null);
  });

  it('the peer listener serves only the token-guarded peer API', async () => {
    const [a, b] = await twoNodes();
    const aAddress = await enableListener(a);
    await pair(a, b, aAddress);
    const port = Number(aAddress.split(':')[1]);
    const host = aAddress;
    // No token: 401 everywhere, the UI page and /api included.
    for (const route of ['/', '/api/sessions', '/hub', '/peer/v1/events', '/peer/v1/api/sessions']) {
      expect((await rawRequest({ port, path: route, headers: { host } })).status, route).toBe(401);
    }
    // A foreign Host (DNS rebinding) or any Origin: 403 before anything else.
    expect((await rawRequest({ port, path: '/peer/v1/api/sessions', headers: { host: `evil.example:${port}` } })).status).toBe(403);
    expect((await rawRequest({ port, path: '/peer/v1/api/sessions', headers: { host, origin: `http://${host}` } })).status).toBe(403);
    // The UI cookie is no credential here.
    const token = (await readFile(path.join(a.dataDir, 'sb_token'), 'utf8')).trim();
    expect((await rawRequest({ port, path: '/peer/v1/api/sessions', headers: { host, cookie: `sb_token=${token}` } })).status).toBe(401);
    // The UI port serves no peer API (only its page, as for any client-side path).
    const onUi = await a.call('GET', '/peer/v1/api/sessions');
    expect(typeof onUi.body).toBe('string');
    expect(String(onUi.body)).toMatch(/<html|<!doctype/i);
  });

  it('refuses to switch the listener on without a usable address, and reports why', async () => {
    const a = await startPeerNode(tmp, 'a', { env: { FAKE_TAILSCALE_IP: 'none' } });
    nodes.push(a);
    const answer = await a.call('PUT', '/api/machines/listener', { enabled: true });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ enabled: true, listening: null });
    expect(answer.body.error).toMatch(/Tailscale/);
    const lan = await a.call('PUT', '/api/machines/listener', { address: '192.168.1.20' });
    expect(lan.body).toMatchObject({ enabled: true, listening: null });
    expect(lan.body.error).toMatch(/only a Tailscale address/);
    expect((await a.call('PUT', '/api/machines/listener', { port: 70000 })).status).toBe(422);
    expect((await a.call('PUT', '/api/machines/listener', { enabled: false, address: null })).body).toMatchObject({ enabled: false, error: null, listening: null });
  });
});
