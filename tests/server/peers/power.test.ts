import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SystemInfo } from '../../../src/core/api.ts';
import type { MachineStateEvent } from '../../../src/core/peers.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, waitFor } from '../../helpers/peers.ts';
import { type HubStream, openHub } from '../../helpers/sse.ts';

/**
 * D125 with two real Switchboard processes (`docs/power.md` → *Paired
 * machines*): each reports its own power (a test reading from
 * `SWITCHBOARD_POWER_TEST_FILE`, sampled every 300 ms); the other shows it as
 * `Machine.power` (`GET /api/machines`, live as `/hub` `machineState`). A is a
 * laptop, B a desktop with an estimated total. A's change (it starts charging)
 * arrives on B.
 */

const AT = '2026-10-21T10:00:00.000Z';

let tmp: string;
let nodes: PeerNode[] = [];
let streams: HubStream[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-power');
});
afterEach(async () => {
  for (const stream of streams) stream.close();
  streams = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

describe('D125 · a paired machine\'s power', () => {
  it('each machine sees the other\'s power (battery / estimated), and a change arrives live', async () => {
    const aFile = path.join(tmp, 'power-a.json');
    const bFile = path.join(tmp, 'power-b.json');
    await writeFile(aFile, JSON.stringify({ kind: 'battery', percent: 64, charging: false, pluggedIn: false, minutesLeft: 130, watts: 9.5, at: AT }));
    await writeFile(bFile, JSON.stringify({ kind: 'estimated', watts: 210, parts: { gpu: 120, gpuCount: 1, cpu: 50, cpuPct: 35, base: 40 }, at: AT }));
    const { a, b, aId, bId } = await pairedNodes(
      tmp,
      { SWITCHBOARD_POWER_SAMPLE_MS: '300' },
      { a: { SWITCHBOARD_POWER_TEST_FILE: aFile }, b: { SWITCHBOARD_POWER_TEST_FILE: bFile } },
    );
    nodes.push(a, b);

    // Its own footer: /api/system.
    await waitFor('A\'s own power', async () => ((await a.call('GET', '/api/system')).body as SystemInfo).power?.kind === 'battery');

    const aOnB = await waitFor('A\'s power on B', async () => {
      const machine = await machineOn(b, aId);
      return machine?.power?.kind === 'battery' ? machine : null;
    });
    expect(aOnB.power).toMatchObject({ kind: 'battery', percent: 64, charging: false, minutesLeft: 130, watts: 9.5 });
    expect(Date.parse(aOnB.power!.at)).toBeGreaterThan(Date.parse(AT));
    const bOnA = await waitFor('B\'s power on A', async () => {
      const machine = await machineOn(a, bId);
      return machine?.power?.kind === 'estimated' ? machine : null;
    });
    expect(bOnA.power).toMatchObject({ kind: 'estimated', watts: 210, parts: { gpu: 120, cpu: 50, base: 40 } });

    // A starts charging: B hears it as machineState with the new power.
    const token = (await readFile(path.join(b.dataDir, 'sb_token'), 'utf8')).trim();
    const hub = await openHub({ port: b.server.port, cookie: `sb_token=${token}`, headers: { host: `127.0.0.1:${b.server.port}` } });
    streams.push(hub);
    await writeFile(aFile, JSON.stringify({ kind: 'battery', percent: 81, charging: true, pluggedIn: true, minutesToFull: 35, at: AT }));
    await waitFor('A charging on B (machineState)', async () =>
      hub.payloads<MachineStateEvent>('machineState').some((machine) => machine.id === aId && machine.power?.charging === true && machine.power.percent === 81),
    );
    expect((await machineOn(b, aId))?.power).toMatchObject({ kind: 'battery', percent: 81, charging: true, minutesToFull: 35 });
  }, 60_000);
});
