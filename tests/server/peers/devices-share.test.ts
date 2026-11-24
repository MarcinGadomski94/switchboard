import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { type Answer, deviceCookieOf, rawCall } from '../../helpers/devices.ts';
import { freeTestPorts, makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D189 with two real Switchboard processes (`docs/devices.md` → *One pairing for all your
 * computers*): a phone paired on A is known on B after the exchange (without any credential), it
 * switches to B through a one-time handover (valid once, only at B, only for a paired computer),
 * a revoke on B stops it on A too, and a computer older than 2.5.14 is told apart.
 */

let tmp: string | null = null;
let nodes: PeerNode[] = [];

afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  if (tmp) await removeTempDir(tmp);
  tmp = null;
});

/** Holds a port until released (so the peers' own listeners do not take a device listener's port). */
async function reserve(port: number): Promise<() => Promise<void>> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

interface Side {
  readonly node: PeerNode;
  readonly id: string;
  readonly port: number;
  readonly origin: string;
}

async function startWorld(root: string): Promise<{ a: Side; b: Side }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const free = await freeTestPorts();
    if (free.length < 6) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    const [portA, portB] = free as [number, number];
    const releases: Array<() => Promise<void>> = [];
    try {
      releases.push(await reserve(portA), await reserve(portB));
    } catch {
      await Promise.all(releases.map((release) => release()));
      continue;
    }
    const originA = `http://localhost:${portA}`;
    const originB = `http://localhost:${portB}`;
    try {
      const started = await pairedNodes(`${root}/try-${attempt}`, { SWITCHBOARD_PEER_TEST_HOOKS: '1' }, { a: { SWITCHBOARD_DEVICE_TEST_ORIGIN: originA }, b: { SWITCHBOARD_DEVICE_TEST_ORIGIN: originB } });
      nodes.push(started.a, started.b);
      await Promise.all(releases.map((release) => release()));
      return { a: { node: started.a, id: started.aId, port: portA, origin: originA }, b: { node: started.b, id: started.bId, port: portB, origin: originB } };
    } catch {
      await Promise.all(releases.map((release) => release()));
      await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1_000));
    }
  }
  throw new Error('the two-computer world could not start on the test ports');
}

function device(side: Side, method: string, route: string, cookie?: string, body?: unknown): Promise<Answer> {
  return rawCall(side.port, method, route, { host: `localhost:${side.port}`, origin: side.origin, ...(cookie ? { cookie } : {}) }, body);
}

/** A device's stored credential hash, read from the computer's database (never printed). */
function storedHash(node: PeerNode, id: string): string | null {
  const db = new DatabaseSync(path.join(node.dataDir, 'switchboard.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT credential_hash AS hash FROM devices WHERE id = ?').get(id) as { hash: string } | undefined;
    return row?.hash ?? null;
  } finally {
    db.close();
  }
}

describe('D189 one phone pairing for all paired computers', () => {
  it('shares the phone without its credential, hands it over once, and a revoke anywhere stops it everywhere', async () => {
    tmp = await makeTempDir('peers-devices');
    const { a, b } = await startWorld(tmp);

    for (const side of [a, b]) expect((await side.node.call('PUT', '/api/devices/access', { enabled: true, port: side.port })).body.https).toBe('ok');
    const code = await a.node.call('POST', '/api/devices/pairing');
    const paired = await device(a, 'POST', '/device/v1/pair', undefined, { code: code.body.code, name: 'Phone' });
    expect(paired.status).toBe(201);
    const cookieA = deviceCookieOf(paired) as string;
    const phoneId = paired.body.device.id as string;

    // B learns of the phone: paired on A, not signed in on B yet, and without A's credential.
    type View = { devices: Array<{ id: string; pairedOn?: { id: string; name: string } | null; setUpHere?: boolean }> };
    const onB = await waitFor('the phone on B', async () => ((await b.node.call('GET', '/api/devices')).body as View).devices.find((d) => d.id === phoneId) ?? null, 20_000);
    expect(onB.pairedOn?.id).toBe(a.id);
    expect(onB.setUpHere).toBe(false);
    const hashA = storedHash(a.node, phoneId);
    expect(hashA).toBeTruthy();
    expect(storedHash(b.node, phoneId)).toMatch(/^unset:/);
    expect(storedHash(b.node, phoneId)).not.toBe(hashA);
    // A's cookie is A's alone.
    expect((await device(b, 'GET', '/api/device', cookieA)).status).not.toBe(200);

    // The phone sees B (once B's origin came over the exchange) and switches there.
    const computers = await waitFor('B reachable from the phone', async () => {
      const list = (await device(a, 'GET', '/api/device/computers', cookieA)).body as Array<{ id: string; origin: string | null; current: boolean }>;
      return list.find((c) => c.id === b.id && c.origin === b.origin) ? list : null;
    }, 20_000);
    expect(computers[0]?.current).toBe(true);
    expect((await device(a, 'POST', '/api/device/handover', cookieA, { machineId: 'zzzzzzzzzzzz' })).body.error).toBe('no-computer');
    const handover = await device(a, 'POST', '/api/device/handover', cookieA, { machineId: b.id });
    expect(handover.status).toBe(200);
    const url = new URL(handover.body.url as string);
    expect(url.origin).toBe(b.origin);
    expect(url.pathname).toBe('/handover');
    expect(url.search).toBe('');
    const token = new URLSearchParams(url.hash.slice(1)).get('t') as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The token is bound to B: A does not take it.
    expect((await device(a, 'POST', '/device/v1/handover', undefined, { token })).status).toBe(400);
    const redeemed = await device(b, 'POST', '/device/v1/handover', undefined, { token });
    expect(redeemed.status).toBe(200);
    const cookieB = deviceCookieOf(redeemed) as string;
    expect(cookieB).toMatch(new RegExp(`^__Host-sb_device=${phoneId}\\.`));
    expect(cookieB).not.toBe(cookieA);
    expect((await device(b, 'GET', '/api/device', cookieB)).status).toBe(200);
    // Once only.
    expect((await device(b, 'POST', '/device/v1/handover', undefined, { token })).status).toBe(400);
    // B made its own credential; A's is unchanged and still not B's.
    expect(storedHash(b.node, phoneId)).not.toMatch(/^unset:/);
    expect(storedHash(b.node, phoneId)).not.toBe(hashA);
    expect(storedHash(a.node, phoneId)).toBe(hashA);

    // Revoked on B → refused on A too, and it never comes back.
    expect((await b.node.call('DELETE', `/api/devices/${phoneId}`)).status).toBe(204);
    expect((await device(b, 'GET', '/api/device', cookieB)).status).not.toBe(200);
    await waitFor('A refuses the revoked phone', async () => ((await device(a, 'GET', '/api/device', cookieA)).status !== 200 ? true : null), 20_000);
    expect(((await a.node.call('GET', '/api/devices')).body as View).devices.find((d) => d.id === phoneId)).toBeUndefined();
  }, 120_000);

  it('a computer older than 2.5.14 is noted as not synced and a switch to it is refused', async () => {
    tmp = await makeTempDir('peers-devices-old');
    const { a, b } = await startWorld(tmp);
    expect((await a.node.call('PUT', '/api/devices/access', { enabled: true, port: a.port })).body.https).toBe('ok');
    const code = await a.node.call('POST', '/api/devices/pairing');
    const cookieA = deviceCookieOf(await device(a, 'POST', '/device/v1/pair', undefined, { code: code.body.code, name: 'Phone' })) as string;
    expect((await b.node.call('POST', '/api/test/peers/devices-old')).status).toBeLessThan(300);
    // A change on A runs the exchange: B answers like an older computer.
    const self = (await device(a, 'GET', '/api/device', cookieA)).body as { device: { id: string } };
    expect((await a.node.call('PUT', `/api/devices/${self.device.id}`, { name: 'Phone 2' })).status).toBe(200);
    await waitFor('B noted as not synced', async () => {
      const list = (await device(a, 'GET', '/api/device/computers', cookieA)).body as Array<{ id: string; synced: boolean }>;
      return list.find((c) => c.id === b.id && !c.synced) ?? null;
    }, 20_000);
    const refused = await device(a, 'POST', '/api/device/handover', cookieA, { machineId: b.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('old-computer');
  }, 120_000);
});
