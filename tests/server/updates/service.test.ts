import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallKind, RestartMode, UpdateStatus } from '../../../src/core/updates.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { runCommand } from '../../../src/server/exec.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { SystemItemService, UPDATE_AVAILABLE } from '../../../src/server/inbox/system-items.ts';
import { GitHubReleases } from '../../../src/server/updates/github.ts';
import { readLedger, updatePaths, writeLedger } from '../../../src/server/updates/install.ts';
import { UpdateService } from '../../../src/server/updates/service.ts';
import type { TarInput } from '../../../src/server/updates/tar.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { fakeNpmCommand } from '../../../tools/fake-npm/command.ts';
import { type FakeGitHub, apiRelease, packageEntries, releaseAssets, startFakeGitHub } from '../../helpers/fake-github.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D55 updater service (`docs/updates.md`) against a fake GitHub on loopback,
 * the real extraction, tools/fake-npm, a real store and system items; the login
 * service pointer and the restart are recorded stubs.
 */

let tmp: string;
let store: Store;
let github: FakeGitHub;
let bus: HubBus;
let published: HubMessage[];
let service: UpdateService | null;

beforeEach(async () => {
  tmp = await makeTempDir('updates');
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
  readonly items: SystemItemService;
  readonly pointed: string[];
  readonly restarts: number[];
  readonly appDir: string;
  readonly dataDir: string;
}

async function make(options: { kind?: InstallKind; restart?: RestartMode; current?: string; npmFail?: string; registered?: boolean; pointFails?: boolean } = {}): Promise<Made> {
  const appDir = path.join(tmp, 'install', 'switchboard-1.0.0');
  const dataDir = path.join(tmp, 'data');
  await mkdir(appDir, { recursive: true });
  const items = new SystemItemService({ store, bus });
  const pointed: string[] = [];
  const restarts: number[] = [];
  const env = { ...process.env, ...(options.npmFail ? { FAKE_NPM_FAIL: options.npmFail } : {}) };
  const made = new UpdateService({
    appDir,
    current: options.current ?? '1.0.0',
    kind: options.kind ?? 'release',
    repo: github.repo,
    paths: updatePaths(dataDir),
    source: new GitHubReleases({ repo: github.repo, testOrigin: github.origin, ghCommand: fakeGhCommand(), userAgent: 'test', cwd: tmp }),
    npmCi: (dir) => runCommand(fakeNpmCommand(), ['ci', '--omit=dev'], { cwd: dir, env }),
    restartMode: async () => options.restart ?? 'service',
    restart: async () => {
      restarts.push(Date.now());
    },
    service: {
      registered: async () => options.registered ?? options.restart !== 'manual',
      pointTo: async (dir) => {
        if (options.pointFails) throw new Error('schtasks /Create failed');
        pointed.push(dir);
      },
    },
    settings: store.settings,
    bus,
    items,
    liveSessions: () => 2,
  });
  await made.init();
  service = made;
  return { service: made, items, pointed, restarts, appDir, dataDir };
}

async function publish(version: string, options: { checksum?: string; withoutChecksum?: boolean; entries?: TarInput[] } = {}): Promise<void> {
  const dir = path.join(tmp, `assets-${version}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir);
  const assets = await releaseAssets(dir, version, { ...(options.checksum ? { checksum: options.checksum } : {}), ...(options.entries ? { entries: options.entries } : {}) });
  github.state.status = 200;
  github.state.release = apiRelease(version);
  github.state.assets = options.withoutChecksum ? assets.slice(0, 1) : assets;
}

async function settle(made: Made): Promise<UpdateStatus> {
  await made.service.job;
  return made.service.status();
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function openUpdateItems(): Promise<Array<{ title: string; version: unknown }>> {
  return (await store.systemItems.list(['open'])).filter((item) => item.kind === UPDATE_AVAILABLE).map((item) => ({ title: item.title, version: (item.payload as { version?: unknown }).version }));
}

describe('checking', () => {
  it('finds a newer release: available, the Inbox item once, updateChanged', async () => {
    await publish('1.1.0');
    const made = await make();
    const status = await made.service.check();
    expect(status).toMatchObject({ current: '1.0.0', available: true, latest: { version: '1.1.0', tag: 'v1.1.0' }, lastCheck: { ok: true, via: 'api', error: null }, restart: 'service', liveSessions: 2, checking: false });
    expect(await openUpdateItems()).toEqual([{ title: 'Switchboard 1.1.0 is available', version: '1.1.0' }]);
    await made.service.check();
    expect(await openUpdateItems()).toHaveLength(1);
    const events = published.filter((m) => m.name === 'updateChanged');
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect((events.at(-1)?.payload as UpdateStatus).available).toBe(true);
    expect(published.some((m) => m.name === 'inboxChanged')).toBe(true);
  });

  it('an older or the same release is not an update', async () => {
    for (const version of ['1.0.0', '0.9.0']) {
      await publish(version);
      const made = await make();
      expect((await made.service.check()).available).toBe(false);
      await made.service.close();
    }
    expect(await openUpdateItems()).toEqual([]);
  });

  it('a newer release supersedes the item of the older one; a dismissed item never comes back', async () => {
    await publish('1.1.0');
    const made = await make();
    await made.service.check();
    await publish('1.2.0');
    await made.service.check();
    expect(await openUpdateItems()).toEqual([{ title: 'Switchboard 1.2.0 is available', version: '1.2.0' }]);
    const [item] = (await store.systemItems.list(['open'])).filter((i) => i.kind === UPDATE_AVAILABLE);
    await made.items.act(item?.id ?? '', 'dismiss');
    await made.service.check();
    expect(await openUpdateItems()).toEqual([]);
  });

  it('closes the items of versions it already runs at start', async () => {
    await publish('1.1.0');
    const first = await make();
    await first.service.check();
    await first.service.close();
    await make({ current: '1.1.0' });
    expect(await openUpdateItems()).toEqual([]);
    expect((await store.systemItems.list()).find((i) => i.kind === UPDATE_AVAILABLE)?.closedAction).toBe('updated');
  });

  it('keeps the last good release and reports a failed check', async () => {
    await publish('1.1.0');
    const made = await make();
    await made.service.check();
    github.state.status = 500;
    const status = await made.service.check();
    expect(status.lastCheck).toMatchObject({ ok: false, via: null, error: "Can't reach releases: GitHub answered HTTP 500." });
    expect(status.latest?.version).toBe('1.1.0');
  });

  it('remembers the dismissed banner and the last check across restarts', async () => {
    await publish('1.1.0');
    const made = await make();
    await made.service.check();
    expect((await made.service.dismiss('1.1.0')).dismissed).toBe('1.1.0');
    await made.service.close();
    const again = await make();
    expect(again.service.status()).toMatchObject({ dismissed: '1.1.0', latest: { version: '1.1.0' }, available: true });
  });
});

describe('installing', () => {
  it('downloads, verifies, unpacks, installs and switches, then restarts through the service', async () => {
    await publish('1.1.0');
    const made = await make();
    await made.service.check();
    const started = made.service.install('1.1.0');
    expect(started.progress.phase).toBe('downloading');
    expect(() => made.service.install('1.1.0')).toThrow(/already running/);
    const status = await settle(made);
    const target = path.join(made.dataDir, 'versions', '1.1.0');
    expect(status.progress).toMatchObject({ phase: 'restarting', version: '1.1.0', dir: target, error: null });
    expect(JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')).version).toBe('1.1.0');
    expect(JSON.parse(await readFile(path.join(target, 'node_modules', '.fake-npm-ci'), 'utf8'))).toEqual(['ci', '--omit=dev']);
    expect(made.pointed).toEqual([target]);
    expect(made.restarts).toHaveLength(1);
    expect(await readLedger(updatePaths(made.dataDir))).toEqual({ current: { version: '1.1.0', dir: target }, previous: { version: '1.0.0', dir: made.appDir } });
    // Nothing left behind in staging or downloads; the running install untouched.
    expect(await readdir(path.join(made.dataDir, 'updates', 'staging'))).toEqual([]);
    expect(await readdir(path.join(made.dataDir, 'updates', 'downloads'))).toEqual([]);
    expect(await readdir(made.appDir)).toEqual([]);
    const phases = published.filter((m) => m.name === 'updateChanged').map((m) => (m.payload as UpdateStatus).progress.phase);
    expect(phases.filter((p, i) => p !== phases[i - 1] && p !== 'idle')).toEqual(['downloading', 'verifying', 'extracting', 'installing', 'switching', 'restarting']);
  });

  it('without the login service: installs, points Start at login at it, and asks for a manual restart', async () => {
    await publish('1.1.0');
    const made = await make({ restart: 'manual', registered: true });
    await made.service.check();
    made.service.install('1.1.0');
    const status = await settle(made);
    expect(status.progress).toMatchObject({ phase: 'restart-manually', dir: path.join(made.dataDir, 'versions', '1.1.0'), message: 'Start at login now starts 1.1.0.' });
    expect(made.pointed).toHaveLength(1);
    expect(made.restarts).toEqual([]);
  });

  it('without the service and without Start at login: nothing is registered', async () => {
    await publish('1.1.0');
    const made = await make({ restart: 'manual', registered: false });
    await made.service.check();
    made.service.install('1.1.0');
    expect((await settle(made)).progress).toMatchObject({ phase: 'restart-manually', message: '' });
    expect(made.pointed).toEqual([]);
  });

  const failures: Array<[string, () => Promise<void>, NonNullable<Parameters<typeof make>[0]>, RegExp]> = [
    ['a checksum mismatch', () => publish('1.1.0', { checksum: `${'0'.repeat(64)}  switchboard-1.1.0.tar.gz\n` }), {}, /checksum mismatch/],
    ['a missing checksum asset', () => publish('1.1.0', { withoutChecksum: true }), {}, /has no switchboard-1.1.0.tar.gz.sha256; refusing/],
    ['a malformed checksum file', () => publish('1.1.0', { checksum: 'nope\n' }), {}, /is not "<sha256>  switchboard-1.1.0.tar.gz"/],
    ['a package with another version', () => publish('1.1.0', { entries: packageEntries('1.1.0', { 'package.json': '{"version":"1.0.5"}', 'package-lock.json': '{}' }) }), {}, /says it is 1.0.5/],
    ['a package without the built UI', () => publish('1.1.0', { entries: packageEntries('1.1.0', { 'package.json': '{"version":"1.1.0"}', 'package-lock.json': '{}', 'src/server/main.ts': '' }) }), {}, /no built UI/],
    ['a path traversal in the tarball', () => publish('1.1.0', { entries: [...packageEntries('1.1.0'), { path: 'switchboard-1.1.0/../../evil', type: 'file', data: Buffer.from('x') }] }), {}, /leaves its folder/],
    ['npm ci failing', () => publish('1.1.0'), { npmFail: 'npm error network ETIMEDOUT' }, /npm ci --omit=dev failed: npm error network ETIMEDOUT/],
    ['the login service refusing the new folder', () => publish('1.1.0'), { pointFails: true }, /could not point the login service at 1.1.0: schtasks \/Create failed/],
  ];
  for (const [what, setup, options, message] of failures) {
    it(`refuses ${what} and leaves the running install as it was`, async () => {
      await setup();
      const made = await make(options);
      await made.service.check();
      made.service.install('1.1.0');
      const status = await settle(made);
      expect(status.progress.phase).toBe('failed');
      expect(status.progress.error).toMatch(message);
      expect(made.restarts).toEqual([]);
      expect(await readLedger(updatePaths(made.dataDir))).toEqual({ current: null, previous: null });
      expect(await readdir(made.appDir)).toEqual([]);
      expect(await readdir(path.join(made.dataDir, 'updates', 'staging')).catch(() => [])).toEqual([]);
      if (!options.pointFails) {
        expect(made.pointed).toEqual([]);
        expect(await exists(path.join(made.dataDir, 'versions', '1.1.0'))).toBe(false);
      }
      expect(await exists(path.join(tmp, 'evil'))).toBe(false);
      // A failed update can be tried again.
      expect(status.available).toBe(true);
    });
  }

  it('refuses git checkouts, stale versions and installs without a newer release', async () => {
    await publish('1.1.0');
    const git = await make({ kind: 'git' });
    await git.service.check();
    expect(() => git.service.install('1.1.0')).toThrow(expect.objectContaining({ code: 'git-checkout' }));
    await git.service.close();
    const release = await make();
    expect(() => release.service.install('1.1.0')).toThrow(expect.objectContaining({ code: 'no-update' }));
    await release.service.check();
    expect(() => release.service.install('1.0.9')).toThrow(expect.objectContaining({ code: 'stale-version' }));
  });

  it('prunes leftovers and versions no longer needed at start (never the running one or the previous one)', async () => {
    const dataDir = path.join(tmp, 'data');
    const paths = updatePaths(dataDir);
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '0.9.0']) await mkdir(path.join(paths.versions, v, 'src'), { recursive: true });
    await mkdir(path.join(paths.staging, 'x'), { recursive: true });
    await mkdir(path.join(paths.downloads, 'y'), { recursive: true });
    await writeLedger(paths, { current: { version: '1.2.0', dir: path.join(paths.versions, '1.2.0') }, previous: { version: '1.1.0', dir: path.join(paths.versions, '1.1.0') } });
    const { pruneInstalls, readLedger: read } = await import('../../../src/server/updates/install.ts');
    const removed = await pruneInstalls(paths, path.join(paths.versions, '1.2.0'), await read(paths));
    expect(removed.map((d) => path.basename(d)).sort()).toEqual(['0.9.0', '1.0.0', 'downloads', 'staging']);
    expect((await readdir(paths.versions)).sort()).toEqual(['1.1.0', '1.2.0']);
    // Running from an original folder (a manual rollback): versions are left alone.
    await mkdir(path.join(paths.versions, '0.8.0'));
    expect(await pruneInstalls(paths, path.join(tmp, 'original'), await read(paths))).toEqual([]);
  });
});
