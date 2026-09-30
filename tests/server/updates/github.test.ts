import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubReleases, ReleaseSourceError, parseApiRelease, parseGhRelease } from '../../../src/server/updates/github.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { type FakeGitHub, apiRelease, releaseAssets, startFakeGitHub } from '../../helpers/fake-github.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/**
 * D55: GitHub releases (`docs/updates.md` → *Checking*, *Downloading*) against
 * a fake GitHub on loopback and tools/fake-gh: the REST API first, `gh` after
 * a 401 / 403 / 404 / 429, downloads only from the release's asset URLs.
 */

let tmp: string;
let github: FakeGitHub;

beforeEach(async () => {
  tmp = await makeTempDir('github');
  github = await startFakeGitHub();
});
afterEach(async () => {
  await github.close();
  await removeTempDir(tmp);
});

function source(env: NodeJS.ProcessEnv = {}): GitHubReleases {
  return new GitHubReleases({ repo: github.repo, testOrigin: github.origin, ghCommand: fakeGhCommand(), userAgent: 'switchboard/test', cwd: tmp, env: { ...process.env, ...env } });
}

describe('latest()', () => {
  it('reads the newest release from the REST API', async () => {
    github.state.status = 200;
    github.state.release = apiRelease('1.1.0');
    github.state.assets = await releaseAssets(tmp, '1.1.0');
    const found = await source().latest();
    expect(found?.via).toBe('api');
    expect(found?.info).toEqual({
      version: '1.1.0',
      tag: 'v1.1.0',
      name: 'Switchboard 1.1.0',
      notes: "## What's new\n\n- Updates from **GitHub releases**.\n",
      publishedAt: '2026-09-30T06:28:02Z',
      url: 'https://github.com/acme/switchboard/releases/tag/v1.1.0',
    });
    expect(found?.assets.map((a) => a.name)).toEqual(['switchboard-1.1.0.tar.gz', 'switchboard-1.1.0.tar.gz.sha256']);
    expect(github.requests).toEqual(['/repos/acme/switchboard/releases/latest']);
  });

  it('ignores drafts and pre-releases', () => {
    expect(parseApiRelease(apiRelease('1.1.0', { draft: true }))).toBeNull();
    expect(parseApiRelease(apiRelease('1.1.0', { prerelease: true }))).toBeNull();
    expect(parseApiRelease(apiRelease('2.0.0-rc.1'))).toBeNull();
    expect(parseGhRelease(JSON.stringify({ tagName: 'v1.1.0', isDraft: true }))).toBeNull();
    expect(parseGhRelease(JSON.stringify({ tagName: 'v1.1.0', isPrerelease: true }))).toBeNull();
    expect(() => parseApiRelease(apiRelease('1.1.0', { tag_name: 'nightly' }))).toThrow(/not a version/);
  });

  it('falls back to gh when the API answers 404 (a private repository)', async () => {
    github.state.status = 404;
    const file = path.join(tmp, 'release.json');
    await writeFile(file, JSON.stringify({ tagName: 'v1.2.0', name: 'Switchboard 1.2.0', body: 'notes', publishedAt: null, isDraft: false, isPrerelease: false, url: 'https://github.com/x', assets: [{ name: 'switchboard-1.2.0.tar.gz', size: 10, url: 'https://github.com/a' }] }));
    const log = path.join(tmp, 'gh.log');
    const found = await source({ FAKE_GH_RELEASE: file, FAKE_GH_LOG: log }).latest();
    expect(found?.via).toBe('gh');
    expect(found?.info.version).toBe('1.2.0');
    expect(found?.assets).toEqual([{ name: 'switchboard-1.2.0.tar.gz', size: 10, url: 'https://github.com/a' }]);
    const argv = JSON.parse((await readFile(log, 'utf8')).trim()).argv;
    expect(argv).toEqual(['release', 'view', '--repo', 'acme/switchboard', '--json', 'tagName,name,body,assets,publishedAt,isDraft,isPrerelease,url']);
  });

  for (const status of [401, 403, 429]) {
    it(`falls back to gh on ${status} and says why both failed`, async () => {
      github.state.status = status;
      await expect(source({ FAKE_GH_RELEASE_FAIL: 'HTTP 401: Bad credentials' }).latest()).rejects.toThrow(`Can't reach releases: GitHub answered HTTP ${status}, and gh failed: HTTP 401: Bad credentials.`);
    });
  }

  it('reports a missing gh', async () => {
    github.state.status = 404;
    const src = new GitHubReleases({ repo: github.repo, testOrigin: github.origin, ghCommand: [path.join(tmp, 'no-such-gh')], userAgent: 'x', cwd: tmp });
    await expect(src.latest()).rejects.toThrow(/GitHub answered 404 \(a private repository, or no release yet\), and gh is not installed/);
  });

  it('answers null when gh finds no release', async () => {
    github.state.status = 404;
    expect(await source({ FAKE_GH_RELEASE: path.join(tmp, 'missing.json') }).latest()).toBeNull();
  });

  it('does not fall back on other errors', async () => {
    github.state.status = 500;
    await expect(source().latest()).rejects.toThrow("Can't reach releases: GitHub answered HTTP 500.");
  });

  it('reports an unreachable GitHub', async () => {
    await github.close();
    await expect(source().latest()).rejects.toBeInstanceOf(ReleaseSourceError);
    github = await startFakeGitHub();
  });
});

describe('download()', () => {
  it('follows the release URL and one redirect, within the size limit', async () => {
    github.state.status = 200;
    github.state.release = apiRelease('1.1.0');
    github.state.assets = await releaseAssets(tmp, '1.1.0');
    const src = source();
    const found = await src.latest();
    if (!found) throw new Error('no release');
    const dir = await makeTempDir('dl');
    try {
      const file = await src.download(found, 'switchboard-1.1.0.tar.gz', dir, 10_000_000);
      expect(await readFile(file)).toEqual(github.state.assets[0]?.data);
      expect(github.requests.slice(1)).toEqual(['/acme/switchboard/releases/download/v1.1.0/switchboard-1.1.0.tar.gz', '/cdn/switchboard-1.1.0.tar.gz']);
      await expect(src.download(found, 'switchboard-1.1.0.tar.gz', dir, 100)).rejects.toThrow(/limit/);
      await expect(src.download(found, 'other.zip', dir, 100)).rejects.toThrow('The release v1.1.0 has no other.zip.');
    } finally {
      await removeTempDir(dir);
    }
  });

  it('refuses a redirect to another origin', async () => {
    github.state.status = 200;
    github.state.release = apiRelease('1.1.0');
    github.state.assets = await releaseAssets(tmp, '1.1.0');
    github.state.redirectTo = 'http://127.0.0.1:1';
    const src = source();
    const found = await src.latest();
    if (!found) throw new Error('no release');
    await expect(src.download(found, 'switchboard-1.1.0.tar.gz', tmp, 10_000_000)).rejects.toThrow('Refused a download redirect to http://127.0.0.1:1.');
  });

  it('refuses asset URLs that are not this repository release downloads (real GitHub rules)', async () => {
    const real = new GitHubReleases({ repo: 'acme/switchboard', ghCommand: ['gh'], userAgent: 'x', cwd: tmp, fetch: () => Promise.reject(new Error('no network in tests')) });
    const release = (url: string) => ({ via: 'api' as const, info: { version: '1.1.0', tag: 'v1.1.0', name: 'x', notes: '', publishedAt: null, url: null }, assets: [{ name: 'switchboard-1.1.0.tar.gz', size: 1, url }] });
    for (const url of [
      'http://github.com/acme/switchboard/releases/download/v1.1.0/switchboard-1.1.0.tar.gz',
      'https://evil.example/acme/switchboard/releases/download/v1.1.0/switchboard-1.1.0.tar.gz',
      'https://github.com/other/switchboard/releases/download/v1.1.0/switchboard-1.1.0.tar.gz',
      'https://github.com/acme/switchboard/releases/download/v1.0.0/switchboard-1.1.0.tar.gz',
      'https://user:pw@github.com/acme/switchboard/releases/download/v1.1.0/switchboard-1.1.0.tar.gz',
    ]) {
      await expect(real.download(release(url), 'switchboard-1.1.0.tar.gz', tmp, 10), url).rejects.toThrow(/Refused to download/);
    }
    // The right URL passes the check and reaches fetch (which fails here: no network in tests).
    await expect(real.download(release('https://github.com/acme/switchboard/releases/download/v1.1.0/switchboard-1.1.0.tar.gz'), 'switchboard-1.1.0.tar.gz', tmp, 10)).rejects.toThrow(/no network in tests/);
  });

  it('downloads through gh when the release was found through gh', async () => {
    const assets = path.join(tmp, 'assets');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(assets);
    await releaseAssets(assets, '1.2.0');
    const log = path.join(tmp, 'gh.log');
    const src = source({ FAKE_GH_RELEASE_DIR: assets, FAKE_GH_LOG: log });
    const release = { via: 'gh' as const, info: { version: '1.2.0', tag: 'v1.2.0', name: 'x', notes: '', publishedAt: null, url: null }, assets: [{ name: 'switchboard-1.2.0.tar.gz', size: null, url: null }] };
    const dir = path.join(tmp, 'dl');
    await mkdir(dir);
    const file = await src.download(release, 'switchboard-1.2.0.tar.gz', dir, 10_000_000);
    expect(file).toBe(path.join(dir, 'switchboard-1.2.0.tar.gz'));
    expect(JSON.parse((await readFile(log, 'utf8')).trim()).argv).toEqual(['release', 'download', 'v1.2.0', '--repo', 'acme/switchboard', '--pattern', 'switchboard-1.2.0.tar.gz', '--dir', dir, '--clobber']);
    await expect(src.download(release, 'switchboard-1.2.0.tar.gz', dir, 10)).rejects.toThrow(/limit/);
  });
});
