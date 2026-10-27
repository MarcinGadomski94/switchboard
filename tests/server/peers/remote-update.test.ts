import { readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MachineStateEvent } from '../../../src/core/peers.ts';
import { parseSemVer } from '../../../src/core/semver.ts';
import type { UpdateStatus } from '../../../src/core/updates.ts';
import { fakeNpmBinEnv } from '../../../tools/fake-npm/command.ts';
import { fakeServiceCtlEnv } from '../../../tools/fake-servicectl/command.ts';
import { deviceCookieOf, rawCall } from '../../helpers/devices.ts';
import { type FakeGitHub, apiRelease, releaseAssets, startFakeGitHub } from '../../helpers/fake-github.ts';
import { REPO_ROOT, freeTestPorts, makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, startPeerNode, waitFor } from '../../helpers/peers.ts';
import { type HubStream, openHub } from '../../helpers/sse.ts';

/**
 * D140 with real Switchboard processes (`docs/updates.md` → *Remote updates*):
 * B is a release install running "as its login service" (the test switch, a temp
 * service home and tools/fake-servicectl: nothing real is registered or started),
 * checking a fake GitHub; `npm ci` is tools/fake-npm. A (updater off) sees B's
 * version and the newer release as `Machine.update`, asks B to check and to
 * update through the machines proxy, follows the progress live (`machineState`),
 * shows B as restarting while it is away, and sees it again once it is back. B
 * records A as the one who asked. Rollback / dismiss stay refused remotely. A
 * paired phone updates the computer it is paired with.
 */

const RUNNING = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const OFFERED = ((): string => {
  const running = parseSemVer(RUNNING);
  if (!running) throw new Error(`package.json version "${RUNNING}" is not semver`);
  return `${running.major}.${running.minor + 1}.0`;
})();

let tmp: string;
let nodes: PeerNode[] = [];
let streams: HubStream[] = [];
let github: FakeGitHub | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('peers-remote-update');
  const [port] = await freeTestPorts();
  github = await startFakeGitHub(port !== undefined ? { port } : {});
  const assets = path.join(tmp, 'assets');
  await mkdir(assets);
  github.state.status = 200;
  github.state.release = apiRelease(OFFERED);
  github.state.assets = await releaseAssets(assets, OFFERED);
});
afterEach(async () => {
  for (const stream of streams) stream.close();
  streams = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await github?.close();
  github = null;
  await removeTempDir(tmp);
});

/** The env of a release install that runs as its (fake) login service and checks the fake GitHub. */
function updaterEnv(label: string): Record<string, string> {
  if (!github) throw new Error('no fake GitHub');
  return {
    SWITCHBOARD_UPDATES: 'on',
    SWITCHBOARD_UPDATE_API: github.origin,
    SWITCHBOARD_UPDATE_REPO: github.repo,
    SWITCHBOARD_UPDATE_TEST_INSTALL: 'release',
    SWITCHBOARD_UPDATE_TEST_UNDER_SERVICE: '1',
    SWITCHBOARD_NPM_BIN: fakeNpmBinEnv(),
    SWITCHBOARD_SERVICE_HOME: path.join(tmp, label, 'home'),
    SWITCHBOARD_SERVICE_CTL: fakeServiceCtlEnv(),
    FAKE_SERVICECTL_LOG: path.join(tmp, label, 'servicectl.log'),
    // A test run from inside a launchd job inherits its label: never let that make a node "the login service".
    XPC_SERVICE_NAME: '',
  };
}

describe('D140 · updating a paired computer', () => {
  it('A sees B\'s version and update, asks B to check and update, follows the progress, and B records who asked', async () => {
    const { a, b, aId, bId } = await pairedNodes(tmp, {}, { b: updaterEnv('b') });
    nodes.push(a, b);
    const aName = (await a.call('GET', '/api/machines')).body.self.name as string;

    // B's own status reaches A as Machine.update (B checks at start).
    const bOnA = await waitFor('B\'s update state on A', async () => {
      const machine = await machineOn(a, bId);
      return machine?.update?.available ? machine : null;
    });
    expect(bOnA.update).toMatchObject({ current: RUNNING, kind: 'release', restart: 'service', remote: { allowed: true }, latest: { version: OFFERED }, progress: { phase: 'idle' } });
    expect(JSON.stringify(bOnA.update)).not.toContain(b.dataDir);
    // A's updater is off: B does not show an update state for A.
    expect((await machineOn(b, aId))?.update).toBeUndefined();

    // The full status through the proxy; Check for updates on B.
    const full = await a.call('GET', `/api/machines/${bId}/api/updates`);
    expect(full.status).toBe(200);
    expect((full.body as UpdateStatus).current).toBe(RUNNING);
    const checked = await a.call('POST', `/api/machines/${bId}/api/updates/check`);
    expect(checked.status).toBe(200);
    expect((checked.body as UpdateStatus).latest?.version).toBe(OFFERED);

    // Rollback-like routes, dismiss and B's service switch stay B's own.
    expect((await a.call('POST', `/api/machines/${bId}/api/updates/dismiss`, { version: OFFERED })).status).toBe(403);
    expect((await a.call('POST', `/api/machines/${bId}/api/updates/rollback`, {})).status).toBe(403);
    expect((await a.call('PUT', `/api/machines/${bId}/api/service`, { startAtLogin: false })).status).toBe(403);

    // A asks B to update; the progress arrives on A's /hub as machineState.
    const token = (await readFile(path.join(a.dataDir, 'sb_token'), 'utf8')).trim();
    const hub = await openHub({ port: a.server.port, cookie: `sb_token=${token}`, headers: { host: `127.0.0.1:${a.server.port}` } });
    streams.push(hub);
    const install = await a.call('POST', `/api/machines/${bId}/api/updates/install`, { version: OFFERED });
    expect(install.status).toBe(202);
    expect((install.body as UpdateStatus).lastRemote).toMatchObject({ version: OFFERED, from: RUNNING, by: { kind: 'peer', id: aId, name: aName }, outcome: 'started' });

    // B installs, switches and asks its (fake) login service to restart: it exits 0.
    expect(await b.server.closed).toBe(0);
    const phases = hub.payloads<MachineStateEvent>('machineState').filter((m) => m.id === bId && m.update).map((m) => m.update?.progress.phase);
    expect(phases).toEqual(expect.arrayContaining(['downloading', 'restarting']));
    // While B is away after the restart request, A keeps showing "restarting".
    const away = await waitFor('B away on A', async () => {
      const machine = await machineOn(a, bId);
      return machine && machine.state !== 'online' ? machine : null;
    });
    expect(away.update?.progress.phase).toBe('restarting');
    // B's update log names A.
    const log = await readFile(path.join(b.dataDir, 'logs', 'update.log'), 'utf8');
    expect(log).toContain(`update to ${OFFERED} asked for from ${aName} (running ${RUNNING})`);
    expect(await readFile(path.join(b.dataDir, 'versions', OFFERED, 'package.json'), 'utf8')).toContain(OFFERED);

    // B comes back (the test runs this checkout again, not the fake package): A sees it online with its update state again.
    // It is still on the old version, so B says the update did not get there.
    const again = await startPeerNode(tmp, 'b', { env: updaterEnv('b') });
    nodes.push(again);
    const back = await waitFor('B back on A', async () => {
      const machine = await machineOn(a, bId);
      return machine?.state === 'online' && machine.update?.progress.phase === 'idle' ? machine : null;
    }, 30_000);
    expect(back.update?.current).toBe(RUNNING);
    expect(back.update?.lastRemote).toMatchObject({ outcome: 'failed', by: { kind: 'peer', name: aName } });
    const items = (await again.call('GET', '/api/inbox')).body as { items?: Array<{ title: string }> } | Array<{ title: string }>;
    const titles = (Array.isArray(items) ? items : (items.items ?? [])).map((item) => item.title);
    expect(titles).toContain(`Update to ${OFFERED} from ${aName} failed`);
  }, 90_000);

  it('a computer that cannot restart itself answers clearly and its card says so', async () => {
    const { a, b, bId } = await pairedNodes(tmp, {}, { b: { ...updaterEnv('b'), SWITCHBOARD_UPDATE_TEST_UNDER_SERVICE: '0' } });
    nodes.push(a, b);
    const machine = await waitFor('B\'s update state on A', async () => {
      const found = await machineOn(a, bId);
      return found?.update?.available ? found : null;
    });
    expect(machine.update?.remote).toMatchObject({ allowed: false, reason: 'manual-restart' });
    const refused = await a.call('POST', `/api/machines/${bId}/api/updates/install`, { version: OFFERED });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'manual-restart', message: expect.stringContaining("Can't update itself here") });
  }, 60_000);
});

describe('D140 · updating this computer from a paired phone', () => {
  it('the phone checks and updates; rollback-like routes stay refused; the phone is recorded', async () => {
    const free = await freeTestPorts();
    const devicePort = free.at(-1) as number;
    const node = await startPeerNode(tmp, 'solo', { env: { ...updaterEnv('solo'), SWITCHBOARD_DEVICE_TEST_ORIGIN: `http://localhost:${devicePort}` } });
    nodes.push(node);
    const access = await node.call('PUT', '/api/devices/access', { enabled: true, port: devicePort });
    expect(access.status).toBe(200);
    const code = await node.call('POST', '/api/devices/pairing');
    const origin = `http://localhost:${devicePort}`;
    const paired = await rawCall(devicePort, 'POST', '/device/v1/pair', { host: `localhost:${devicePort}`, origin, 'user-agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' }, { code: code.body.code, name: 'Pixel 9' });
    const cookie = deviceCookieOf(paired);
    expect(paired.status).toBe(201);
    if (!cookie) throw new Error('no device cookie');
    const phone = (method: string, route: string, body?: unknown) => rawCall(devicePort, method, route, { host: `localhost:${devicePort}`, origin, cookie }, body);

    await waitFor('a newer release found', async () => ((await phone('GET', '/api/updates')).body as UpdateStatus).available);
    expect((await phone('POST', '/api/updates/check')).status).toBe(200);
    expect((await phone('POST', '/api/updates/rollback', {})).status).toBe(403);
    expect((await phone('PUT', '/api/service', { startAtLogin: false })).status).toBe(403);
    const install = await phone('POST', '/api/updates/install', { version: OFFERED });
    expect(install.status).toBe(202);
    expect((install.body as UpdateStatus).lastRemote).toMatchObject({ by: { kind: 'device', name: 'Pixel 9' }, outcome: 'started' });
    expect(await node.server.closed).toBe(0);
    expect(await readFile(path.join(node.dataDir, 'logs', 'update.log'), 'utf8')).toContain(`update to ${OFFERED} asked for from your phone (Pixel 9)`);
  }, 60_000);
});
