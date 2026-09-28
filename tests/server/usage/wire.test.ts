import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SystemInfo } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Providers, SystemProvider } from '../../../src/server/providers.ts';
import { generateToken } from '../../../src/server/token.ts';
import { UsageMeter } from '../../../src/server/usage/meter.ts';
import { UsagePoller } from '../../../src/server/usage/poller.ts';
import { withUsage } from '../../../src/server/usage/wire.ts';
import { fakeClaudeCommand } from '../../../tools/fake-claude/command.ts';
import { type HubStream, listenOnFreeTestPort, openHub, requestJson } from '../../helpers/sse.ts';
import { type SupervisorWorld, makeSupervisorWorld, spawnedArgv } from '../../helpers/supervisor.ts';

/**
 * M9.2 oracle, the wiring (src/server/usage/wire.ts, app.ts): `usagePct` reaches
 * the `system` hub event through `providers.system`, the meter reads only once a
 * `/hub` client is connected, and in this non-demo world the reading comes from
 * the real poller running fake-claude. The base system provider is a stand-in
 * for M5.3's SystemProbe (lane w2-newsession, not merged on main yet).
 */

const PROBE_TIME = Date.parse('2026-09-27T21:20:00.000Z');

const BASE_INFO: SystemInfo = {
  cli: '/usr/local/bin/claude',
  cliVersion: '2.1.283',
  signedIn: true,
  ghSignedIn: true,
  cpu: 12,
  ramUsed: 8 * 1024 ** 3,
  ramTotal: 32 * 1024 ** 3,
  processes: 0,
};

describe('withUsage', () => {
  it('leaves the providers alone without a system provider (nothing to report through)', () => {
    const providers: Providers = {};
    expect(withUsage(providers, { systemFields: async () => ({ usagePct: 50 }) })).toBe(providers);
  });

  it('replaces whatever the base said about usage with the meter’s fields (never mixed, never invented)', async () => {
    const base: SystemProvider = { system: async () => ({ ...BASE_INFO, usagePct: 62, usageResetsAt: '2026-09-28T13:48:00.000Z' }) };
    const unknown = withUsage({ system: base }, { systemFields: async () => ({}) });
    const info = await unknown.system?.system();
    expect(info).toEqual(BASE_INFO);
    expect(info && 'usagePct' in info).toBe(false);

    const known = withUsage({ system: base }, { systemFields: async () => ({ usagePct: 18, usageResetsAt: '2026-10-01T13:00:00.290Z' }) });
    expect(await known.system?.system()).toEqual({ ...BASE_INFO, usagePct: 18, usageResetsAt: '2026-10-01T13:00:00.290Z' });
  });
});

describe('usage on /hub `system` (real poller with fake-claude, non-demo)', () => {
  let w: SupervisorWorld;
  let app: FastifyInstance;
  let port = 0;
  let cookie = '';
  let meter: UsageMeter;
  const streams: HubStream[] = [];

  beforeAll(async () => {
    w = await makeSupervisorWorld();
    const dataDir = path.join(w.root, 'app-data');
    await mkdir(dataDir, { recursive: true });
    meter = new UsageMeter({
      store: w.store,
      sessions: w.supervisor,
      poller: new UsagePoller({ claudeCommand: fakeClaudeCommand(), cwd: dataDir, env: w.env }),
      now: () => new Date(PROBE_TIME),
      onError: (error) => {
        throw error;
      },
    });
    const token = generateToken();
    cookie = `sb_token=${token}`;
    const providers = withUsage({ system: { system: async () => BASE_INFO } }, meter);
    const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: dataDir }, platform: 'linux', home: w.root, cwd: w.root });
    ({ app, port } = await listenOnFreeTestPort((candidate) =>
      buildApp({
        config: { ...base, port: candidate, workspaceRoot: w.workspace },
        token,
        store: w.store,
        webRoot: w.root,
        supervisor: w.supervisor,
        providers,
        usage: meter,
        hub: { systemIntervalMs: 100 },
      }),
    ));
  });

  afterAll(async () => {
    for (const stream of streams) stream.close();
    await meter?.stop();
    await app?.close();
    await w?.cleanup();
  });

  it('no /hub client: the meter reads nothing; a client connects: the poller runs and `system` carries usagePct', async () => {
    expect(await meter.tick()).toBeNull();
    expect(await spawnedArgv(w.logFile)).toEqual([]);

    const stream = await openHub({ port, cookie });
    streams.push(stream);
    expect(stream.status).toBe(200);
    // Before any reading the event has no usagePct (unknown, omitted).
    const first = await stream.waitFor((p) => p.messages.find((m) => m.event === 'system'), 'a system event');
    expect(JSON.parse(first.data)).toEqual(BASE_INFO);

    expect(await meter.tick()).toBe('poller');
    const [spawned] = await spawnedArgv(w.logFile);
    expect(spawned?.cwd).toBe(path.join(w.root, 'app-data'));

    const withUsagePct = await stream.waitFor(
      (p) => p.messages.filter((m) => m.event === 'system').map((m) => JSON.parse(m.data) as SystemInfo).find((info) => info.usagePct !== undefined),
      'a system event with usagePct',
    );
    expect(withUsagePct).toEqual({ ...BASE_INFO, usagePct: 18, usageResetsAt: '2026-10-01T13:00:00.290Z' });
  });

  // GET /api/system (M5.3's route) serves providers.system, which M9.2 wraps with usage.
  it('GET /api/system carries usagePct', async () => {
    const response = await requestJson(port, 'GET', '/api/system', cookie);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ usagePct: 18, usageResetsAt: '2026-10-01T13:00:00.290Z' });
  });
});
