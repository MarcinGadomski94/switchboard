import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { deviceCookieOf, rawCall } from '../../helpers/devices.ts';
import { type FakePushService, type ReceivedPush, startFakePush } from '../../helpers/fake-push.ts';
import { freeTestPorts, makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D73 ruling 2026-10-08 (*Include peers in pushes*): a paired machine's (D48)
 * question batches, permission requests and its sessions' finished turns / errors
 * notify THIS machine's devices, through the existing peer event stream, once
 * each, with the deep link to the remote session (`/sessions/r~<machine>~<id>`).
 * Two real Switchboard processes on loopback test ports; A has device access on
 * and a paired device subscribed at the fake push service; sessions run on B.
 */

let tmp: string | null = null;
let nodes: PeerNode[] = [];
let push: FakePushService | null = null;

afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await push?.close();
  push = null;
  if (tmp) await removeTempDir(tmp);
  tmp = null;
});

/** Holds a port until released (so the peers' listeners do not take the device listener's port). */
async function reserve(port: number): Promise<() => Promise<void>> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

function payloadOf(push: ReceivedPush): { kind: string; title: string; url: string; tag: string } {
  return push.payload as { kind: string; title: string; url: string; tag: string };
}

describe('D73 pushes for a paired machine', () => {
  it("notifies this machine's devices of the peer's questions and finished turns, once each, linking the remote session", async () => {
    tmp = await makeTempDir('devices-peers');
    const free = await freeTestPorts();
    push = await startFakePush(free.at(-1) as number);
    const devicePort = free.at(-2) as number;
    const release = await reserve(devicePort);
    const origin = `http://localhost:${devicePort}`;
    const env = { SWITCHBOARD_DEVICE_TEST_ORIGIN: origin, SWITCHBOARD_PUSH_TEST_ENDPOINTS: push.origin };
    let a: PeerNode;
    let b: PeerNode;
    let bId: string;
    try {
      ({ a, b, bId } = await pairedNodes(tmp, env));
    } finally {
      await release();
    }
    nodes.push(a, b);

    // A: device access on, a phone paired and subscribed.
    const access = await a.call('PUT', '/api/devices/access', { enabled: true, port: devicePort });
    expect(access.body.https).toBe('ok');
    const code = await a.call('POST', '/api/devices/pairing');
    const paired = await rawCall(devicePort, 'POST', '/device/v1/pair', { host: `localhost:${devicePort}` }, { code: code.body.code, name: 'Phone' });
    const cookie = deviceCookieOf(paired) as string;
    expect(cookie).toBeTruthy();
    const sub = push.subscribe();
    const saved = await rawCall(devicePort, 'PUT', '/api/device/push', { host: `localhost:${devicePort}`, cookie }, { subscription: { endpoint: sub.endpoint, keys: sub.keys } });
    expect(saved.status).toBe(200);

    // A session on B finishes its turn → A's phone hears of it, with B's remote id.
    const hello = await b.call('POST', '/api/sessions', { name: 'hello-on-b', task: 'Hello.', folder: b.folderId, worktrees: false, ultracode: false });
    expect(hello.status).toBe(201);
    const remoteHello = `r~${bId}~${hello.body.id}`;
    const finished = await waitFor('the turn-finished push', async () => push?.received.find((p) => payloadOf(p).kind === 'turnFinished' && payloadOf(p).url === `/sessions/${remoteHello}`), 20_000);
    expect(payloadOf(finished).title).toContain('hello-on-b');
    expect(payloadOf(finished).title).toContain('·');

    // A question on B → one push on A's phone (high urgency), linking the remote session.
    const ask = await b.call('POST', '/api/sessions', { name: 'ask-on-b', task: '[fake:ask-2q] Ask me.', folder: b.folderId, worktrees: false, ultracode: false });
    expect(ask.status).toBe(201);
    const remoteAsk = `r~${bId}~${ask.body.id}`;
    const question = await waitFor('the question push', async () => push?.received.find((p) => payloadOf(p).kind === 'questions' && payloadOf(p).url === `/sessions/${remoteAsk}`), 20_000);
    expect(question.urgency).toBe('high');
    expect(payloadOf(question).tag).toMatch(/^inbox-r~/);
    // Once: more inboxChanged traffic afterwards announces nothing again.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(push.received.filter((p) => payloadOf(p).kind === 'questions' && payloadOf(p).url === `/sessions/${remoteAsk}`)).toHaveLength(1);
    expect(push.received.filter((p) => payloadOf(p).kind === 'turnFinished' && payloadOf(p).url === `/sessions/${remoteHello}`)).toHaveLength(1);
    expect(push.refused).toEqual([]);
  }, 90_000);
});
