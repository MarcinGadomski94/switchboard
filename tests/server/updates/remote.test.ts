import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type MachineUpdate, type RestartMode, type InstallKind, type UpdateStatus, machineUpdateOf, readMachineUpdate, remoteUpdateAbility, triggerText } from '../../../src/core/updates.ts';
import { refusalStatus, updateTriggerOf } from '../../../src/server/api/updates.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { DEVICE_ALLOWED, isLocalOnly, matchesRule } from '../../../src/server/devices/local-only.ts';
import { runCommand } from '../../../src/server/exec.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { SystemItemService, UPDATE_REMOTE } from '../../../src/server/inbox/system-items.ts';
import { PEER_API_ALLOW, peerApiAllowed } from '../../../src/server/peers/service.ts';
import { GitHubReleases } from '../../../src/server/updates/github.ts';
import { updatePaths } from '../../../src/server/updates/install.ts';
import { UPDATE_STATE_SETTING, UpdateService } from '../../../src/server/updates/service.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { fakeNpmCommand } from '../../../tools/fake-npm/command.ts';
import { type FakeGitHub, apiRelease, releaseAssets, startFakeGitHub } from '../../helpers/fake-github.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D140 "Update Switchboard remotely" (`docs/updates.md` → *Remote updates*):
 * exactly which update routes a paired phone and a paired computer may call,
 * the refusals of a remote install (git checkout, by-hand restart, the rate
 * limit) and their HTTP statuses, who asked (device / peer / local), the record
 * (update log, `lastRemote`, the Inbox item after the restart or the failure),
 * and the compact state paired computers receive. The updater runs against the
 * fake GitHub, the real extraction and tools/fake-npm; the restart is a recorded
 * stub (nothing restarts, nothing is registered).
 */

const PHONE = { kind: 'device', id: 'd1', name: 'Pixel 9' } as const;
const MAC = { kind: 'peer', id: 'm1abcdefghij', name: 'Marcins-Mac' } as const;

describe('D140 allow-lists', () => {
  it('a paired phone may call exactly GET /api/updates and POST check / install / dismiss', () => {
    const updateRules = DEVICE_ALLOWED.filter(([, pattern]) => pattern.source.includes('updates'));
    for (const [method, url] of [['GET', '/api/updates'], ['POST', '/api/updates/check'], ['POST', '/api/updates/install'], ['POST', '/api/updates/dismiss']] as const) {
      expect(matchesRule(updateRules, method, url), `${method} ${url}`).toBe(true);
      expect(isLocalOnly(method, url), `${method} ${url}`).toBe(false);
    }
    for (const [method, url] of [
      ['POST', '/api/updates/rollback'],
      ['PUT', '/api/updates/settings'],
      ['DELETE', '/api/updates/install'],
      ['GET', '/api/updates/install'],
      ['POST', '/api/updates'],
      ['POST', '/api/updates/install/x'],
      ['POST', '/api/updates/check/../rollback'],
      ['PUT', '/api/service'],
    ] as const) {
      expect(isLocalOnly(method, url), `${method} ${url}`).toBe(true);
    }
    // Through the machines proxy: judged as the peer's own route.
    expect(isLocalOnly('POST', '/api/machines/m1abcdefghij/api/updates/install')).toBe(false);
    expect(isLocalOnly('POST', '/api/machines/m1abcdefghij/api/updates/rollback')).toBe(true);
  });

  it('a paired computer may call exactly GET /api/updates and POST check / install (dismiss stays there)', () => {
    const updateRules = PEER_API_ALLOW.filter(([, pattern]) => pattern.source.includes('updates'));
    expect(updateRules).toHaveLength(2);
    expect(peerApiAllowed('GET', '/api/updates')).toBe(true);
    expect(peerApiAllowed('POST', '/api/updates/check')).toBe(true);
    expect(peerApiAllowed('POST', '/api/updates/install')).toBe(true);
    for (const [method, url] of [
      ['POST', '/api/updates/dismiss'],
      ['POST', '/api/updates/rollback'],
      ['PUT', '/api/updates/settings'],
      ['PUT', '/api/service'],
      ['GET', '/api/updates/install'],
      ['POST', '/api/updates'],
    ] as const) {
      expect(peerApiAllowed(method, url), `${method} ${url}`).toBe(false);
    }
  });
});

describe('D140 refusals and triggers', () => {
  it('maps the refusal codes to HTTP statuses', () => {
    expect(refusalStatus('rate-limited')).toBe(429);
    expect(refusalStatus('invalid')).toBe(422);
    for (const code of ['busy', 'checking', 'git-checkout', 'manual-restart', 'no-update', 'stale-version'] as const) expect(refusalStatus(code), code).toBe(409);
  });

  it('who asks: a device, a peer (by its stored name), else this computer', async () => {
    const machines = new Map([['m1abcdefghij', { name: 'Marcins-Mac' }]]);
    const store = { machines: { get: async (id: string) => machines.get(id) ?? null } } as unknown as Store;
    const request = (fields: { device?: unknown; headers?: Record<string, string> }) => ({ device: fields.device ?? null, headers: fields.headers ?? {} }) as unknown as FastifyRequest;
    expect(await updateTriggerOf(request({ device: { id: 'd1', name: 'Pixel 9' } }), store)).toEqual(PHONE);
    expect(await updateTriggerOf(request({ headers: { 'x-switchboard-peer': 'm1abcdefghij' } }), store)).toEqual(MAC);
    expect(await updateTriggerOf(request({ headers: { 'x-switchboard-peer': 'zzzzzzzzzzzz' } }), store)).toEqual({ kind: 'peer', id: 'zzzzzzzzzzzz', name: 'zzzzzzzzzzzz' });
    expect(await updateTriggerOf(request({}), store)).toEqual({ kind: 'local' });
    // A device's own header never makes it a peer.
    expect((await updateTriggerOf(request({ device: { id: 'd1', name: 'Pixel 9' }, headers: { 'x-switchboard-peer': 'm1abcdefghij' } }), store)).kind).toBe('device');
  });

  it('the words: who asked, and what a remote update can do here', () => {
    expect(triggerText(PHONE)).toBe('from your phone (Pixel 9)');
    expect(triggerText(MAC)).toBe('from Marcins-Mac');
    expect(remoteUpdateAbility('release', 'service')).toEqual({ allowed: true, reason: null, message: null });
    expect(remoteUpdateAbility('git', 'service')).toMatchObject({ allowed: false, reason: 'git-checkout' });
    expect(remoteUpdateAbility('release', 'manual')).toMatchObject({ allowed: false, reason: 'manual-restart' });
    expect(remoteUpdateAbility('release', 'manual').message).toContain("Can't update itself here");
    expect(remoteUpdateAbility('release', 'manual').message).toContain('restart it by hand');
  });

  it('the compact state round-trips and rejects garbage', () => {
    const status: UpdateStatus = {
      current: '2.4.2',
      install: { kind: 'release', dir: '/secret/folder' },
      restart: 'service',
      repo: 'a/b',
      checking: false,
      lastCheck: { at: '2026-10-27T10:00:00.000Z', ok: true, via: 'api', error: null },
      latest: { version: '2.4.3', tag: 'v2.4.3', name: 'Switchboard 2.4.3', notes: 'long notes', publishedAt: null, url: 'https://github.com/a/b/releases/tag/v2.4.3' },
      available: true,
      dismissed: null,
      progress: { phase: 'installing', version: '2.4.3', message: '', error: null, dir: '/secret/staging', at: '2026-10-27T10:01:00.000Z' },
      previous: null,
      liveSessions: 3,
    };
    const short: MachineUpdate = machineUpdateOf(status);
    expect(JSON.stringify(short)).not.toContain('/secret');
    expect(JSON.stringify(short)).not.toContain('long notes');
    expect(short).toMatchObject({ current: '2.4.2', available: true, latest: { version: '2.4.3' }, progress: { phase: 'installing' }, liveSessions: 3, remote: { allowed: true } });
    expect(readMachineUpdate(JSON.parse(JSON.stringify(short)))).toEqual(short);
    expect(readMachineUpdate(null)).toBeNull();
    expect(readMachineUpdate({ ...short, kind: 'zip' })).toBeNull();
    expect(readMachineUpdate({ ...short, progress: { phase: 'exploding' } })).toBeNull();
  });
});

// ── the updater ───────────────────────────────────────────────────────────

let tmp: string;
let store: Store;
let github: FakeGitHub;
let bus: HubBus;
let published: HubMessage[];
let service: UpdateService | null;

beforeEach(async () => {
  tmp = await makeTempDir('updates-remote');
  store = await openTempStore(tmp);
  github = await startFakeGitHub();
  bus = new HubBus();
  published = [];
  bus.subscribe((message) => published.push(message));
  service = null;
});

afterEach(async () => {
  await service?.close();
  await github.close();
  await store.close();
  await removeTempDir(tmp);
});

interface Made {
  readonly service: UpdateService;
  readonly restarts: number[];
  readonly dataDir: string;
}

async function make(options: { kind?: InstallKind; restart?: RestartMode; current?: string; checksum?: string; now?: () => Date } = {}): Promise<Made> {
  const appDir = path.join(tmp, 'install', 'switchboard-1.0.0');
  const dataDir = path.join(tmp, 'data');
  await mkdir(appDir, { recursive: true });
  const restarts: number[] = [];
  const made = new UpdateService({
    appDir,
    current: options.current ?? '1.0.0',
    kind: options.kind ?? 'release',
    repo: github.repo,
    paths: updatePaths(dataDir),
    source: new GitHubReleases({ repo: github.repo, testOrigin: github.origin, ghCommand: fakeGhCommand(), userAgent: 'test', cwd: tmp }),
    npmCi: (dir) => runCommand(fakeNpmCommand(), ['ci', '--omit=dev'], { cwd: dir, env: process.env }),
    restartMode: async () => options.restart ?? 'service',
    restart: async () => {
      restarts.push(Date.now());
    },
    service: { registered: async () => true, pointTo: async () => undefined },
    settings: store.settings,
    bus,
    items: new SystemItemService({ store, bus }),
    liveSessions: () => 2,
    onError: () => undefined,
    ...(options.now ? { now: options.now } : {}),
  });
  await made.init();
  service = made;
  return { service: made, restarts, dataDir };
}

async function publish(version: string, options: { checksum?: string } = {}): Promise<void> {
  const dir = path.join(tmp, `assets-${version}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir);
  github.state.status = 200;
  github.state.release = apiRelease(version);
  github.state.assets = await releaseAssets(dir, version, options.checksum ? { checksum: options.checksum } : {});
}

async function remoteItems(): Promise<Array<{ title: string; status: string }>> {
  return (await store.systemItems.list(['open'])).filter((item) => item.kind === UPDATE_REMOTE).map((item) => ({ title: item.title, status: item.status }));
}

async function log(dataDir: string): Promise<string> {
  return readFile(path.join(dataDir, 'logs', 'update.log'), 'utf8').catch(() => '');
}

describe('D140 the updater', () => {
  it('a remote install of a git checkout or a by-hand install is refused clearly; this computer may still update a by-hand install', async () => {
    await publish('1.1.0');
    const git = await make({ kind: 'git' });
    await git.service.check();
    expect(git.service.status().remote).toMatchObject({ allowed: false, reason: 'git-checkout' });
    expect(() => git.service.install('1.1.0', PHONE)).toThrow(expect.objectContaining({ code: 'git-checkout', message: expect.stringContaining("Can't update itself here") }));
    await git.service.close();

    const manual = await make({ restart: 'manual' });
    await manual.service.check();
    expect(manual.service.status().remote).toMatchObject({ allowed: false, reason: 'manual-restart' });
    expect(() => manual.service.install('1.1.0', MAC)).toThrow(expect.objectContaining({ code: 'manual-restart', message: expect.stringContaining('restart it by hand') }));
    expect(() => manual.service.install('1.1.0', PHONE)).toThrow(expect.objectContaining({ code: 'manual-restart' }));
    // Nothing was recorded for the refusals.
    expect(manual.service.status().lastRemote).toBeNull();
    // The local UI still updates it (D55's by-hand restart).
    expect(manual.service.install('1.1.0').progress.phase).toBe('downloading');
    await manual.service.job;
    expect(manual.service.status().progress.phase).toBe('restart-manually');
  });

  it('records who asked (log, lastRemote), restarts, and allows one remote install per 10 minutes', async () => {
    await publish('1.1.0');
    let now = new Date('2026-10-27T10:00:00.000Z');
    const made = await make({ now: () => now });
    await made.service.check();
    const started = made.service.install('1.1.0', MAC);
    expect(started.progress.phase).toBe('downloading');
    expect(started.lastRemote).toMatchObject({ version: '1.1.0', from: '1.0.0', by: MAC, outcome: 'started', at: now.toISOString() });
    await made.service.job;
    expect(made.service.status().progress.phase).toBe('restarting');
    expect(made.restarts).toHaveLength(1);
    expect(await log(made.dataDir)).toContain('update to 1.1.0 asked for from Marcins-Mac (running 1.0.0)');
    // Every change went out as machineUpdate too (the peer stream forwards it).
    const shorts = published.filter((m) => m.name === 'machineUpdate').map((m) => m.payload as MachineUpdate);
    expect(shorts.map((s) => s.progress.phase)).toEqual(expect.arrayContaining(['downloading', 'verifying', 'installing', 'restarting']));

    // The restart did not happen (a stub): a second remote ask within 10 minutes is refused before anything else...
    now = new Date('2026-10-27T10:09:00.000Z');
    expect(made.service.remoteWaitMs()).toBe(60_000);
    // (the progress is still "restarting": busy wins; the limit itself is checked on an idle updater below)
    expect(() => made.service.install('1.1.0', PHONE)).toThrow(expect.objectContaining({ code: 'busy' }));
    now = new Date('2026-10-27T10:10:00.000Z');
    expect(made.service.remoteWaitMs()).toBe(0);
  });

  it('the rate limit: a second remote install within 10 minutes is 429-refused, the local UI is not limited', async () => {
    // A release whose checksum is wrong: the install fails at once and the updater is idle again.
    await publish('1.1.0', { checksum: `${'0'.repeat(64)}  switchboard-1.1.0.tar.gz\n` });
    let now = new Date('2026-10-27T10:00:00.000Z');
    const made = await make({ now: () => now });
    await made.service.check();
    made.service.install('1.1.0', PHONE);
    await made.service.job;
    expect(made.service.status().progress.phase).toBe('failed');
    now = new Date('2026-10-27T10:04:00.000Z');
    expect(() => made.service.install('1.1.0', MAC)).toThrow(expect.objectContaining({ code: 'rate-limited', message: expect.stringContaining('try again in 6 min') }));
    expect(() => made.service.install('1.1.0', PHONE)).toThrow(expect.objectContaining({ code: 'rate-limited' }));
    // This computer's own UI is never limited.
    expect(made.service.install('1.1.0').progress.phase).toBe('downloading');
    await made.service.job;
    now = new Date('2026-10-27T10:10:01.000Z');
    expect(made.service.install('1.1.0', MAC).lastRemote).toMatchObject({ by: MAC, outcome: 'started' });
    await made.service.job;
  });

  it('a failed remote install is recorded and told in the Inbox ("… from your phone failed")', async () => {
    await publish('1.1.0', { checksum: `${'0'.repeat(64)}  switchboard-1.1.0.tar.gz\n` });
    const made = await make();
    await made.service.check();
    made.service.install('1.1.0', PHONE);
    await made.service.job;
    const status = made.service.status();
    expect(status.lastRemote).toMatchObject({ outcome: 'failed', error: expect.stringContaining('checksum mismatch') });
    expect(await remoteItems()).toEqual([{ title: 'Update to 1.1.0 from your phone (Pixel 9) failed', status: 'need' }]);
    expect(await log(made.dataDir)).toMatch(/update to 1\.1\.0 from your phone \(Pixel 9\) failed: checksum mismatch/);
  });

  it('after the restart into the new version: "Updated to 1.1.0 from Marcins-Mac" in the Inbox, once', async () => {
    await store.settings.set(UPDATE_STATE_SETTING, {
      lastCheck: null,
      latest: null,
      dismissed: null,
      lastRemote: { version: '1.1.0', from: '1.0.0', by: MAC, at: '2026-10-27T10:00:00.000Z', outcome: 'started', error: null },
    });
    const made = await make({ current: '1.1.0' });
    expect(made.service.status().lastRemote).toMatchObject({ outcome: 'updated', version: '1.1.0' });
    expect(await remoteItems()).toEqual([{ title: 'Updated to 1.1.0 from Marcins-Mac', status: 'idle' }]);
    expect(await log(made.dataDir)).toContain('updated to 1.1.0 from Marcins-Mac');
    await made.service.close();
    // A second start does not raise it again.
    await make({ current: '1.1.0' });
    expect(await remoteItems()).toHaveLength(1);
  });

  it('a start still on the version it was asked from: the remote update did not get there', async () => {
    await store.settings.set(UPDATE_STATE_SETTING, {
      lastCheck: null,
      latest: null,
      dismissed: null,
      lastRemote: { version: '1.1.0', from: '1.0.0', by: PHONE, at: '2026-10-27T10:00:00.000Z', outcome: 'started', error: null },
    });
    const made = await make({ current: '1.0.0' });
    expect(made.service.status().lastRemote).toMatchObject({ outcome: 'failed', error: 'Switchboard started again on 1.0.0' });
    expect(await remoteItems()).toEqual([{ title: 'Update to 1.1.0 from your phone (Pixel 9) failed', status: 'need' }]);
  });
});
