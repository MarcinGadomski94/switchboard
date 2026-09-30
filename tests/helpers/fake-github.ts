import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { checksumLine, checksumName, packagePrefix, tarballName } from '../../src/core/release.ts';
import { type TarInput, writeTarGz } from '../../src/server/updates/tar.ts';

/**
 * A fake GitHub for the D55 updater's tests (AGENTS.md: never the real one): a
 * loopback HTTP server answering `GET /repos/<repo>/releases/latest` like the
 * REST API and serving the release assets, whose download URLs redirect once
 * (like github.com → the asset CDN) to `/cdn/<name>` on the same origin. The
 * server is pointed at through `SWITCHBOARD_UPDATE_API` / `testOrigin`.
 */

/** One asset served. */
export interface FakeAsset {
  readonly name: string;
  readonly data: Buffer;
}

/** What the fake answers; tests change it between calls. */
export interface FakeGitHubState {
  /** `releases/latest`'s HTTP status (200 = {@link release}). */
  status: number;
  /** The release object (REST API shape), without `assets` (built from {@link assets}). */
  release: Record<string, unknown> | null;
  assets: FakeAsset[];
  /** Where an asset's CDN hop redirects to instead (e.g. a foreign origin). */
  redirectTo: string | null;
}

/** A running fake GitHub. */
export interface FakeGitHub {
  readonly origin: string;
  readonly repo: string;
  readonly state: FakeGitHubState;
  /** Request paths so far. */
  readonly requests: string[];
  close(): Promise<void>;
}

/** Starts the fake on a free loopback port (or `port`). */
export async function startFakeGitHub(options: { readonly repo?: string; readonly port?: number } = {}): Promise<FakeGitHub> {
  const repo = options.repo ?? 'acme/switchboard';
  const state: FakeGitHubState = { status: 404, release: null, assets: [], redirectTo: null };
  const requests: string[] = [];
  let origin = '';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname);
    if (url.pathname === `/repos/${repo}/releases/latest`) {
      if (state.status !== 200 || !state.release) {
        response.writeHead(state.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      const tag = String(state.release['tag_name']);
      const body = {
        ...state.release,
        assets: state.assets.map((asset) => ({ name: asset.name, size: asset.data.length, browser_download_url: `${origin}/${repo}/releases/download/${tag}/${asset.name}` })),
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
      return;
    }
    const download = /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/(.+)$/.exec(url.pathname);
    if (download) {
      const name = decodeURIComponent(download[1] as string);
      response.writeHead(302, { location: state.redirectTo ? `${state.redirectTo}/cdn/${name}` : `/cdn/${encodeURIComponent(name)}` });
      response.end();
      return;
    }
    const cdn = /^\/cdn\/(.+)$/.exec(url.pathname);
    const asset = cdn ? state.assets.find((candidate) => candidate.name === decodeURIComponent(cdn[1] as string)) : undefined;
    if (asset) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(asset.data.length) });
      response.end(asset.data);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    repo,
    state,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The files of a minimal installable package of `version` (package.json, lock, main.ts, the UI). */
export function packageFiles(version: string): Record<string, string> {
  return {
    'package.json': `${JSON.stringify({ name: 'switchboard', version, private: true, type: 'module', scripts: { start: 'node src/server/main.ts' } }, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify({ name: 'switchboard', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'switchboard', version } } }, null, 2)}\n`,
    'src/server/main.ts': `console.log('switchboard ${version}');\n`,
    'dist/web/index.html': `<!doctype html><title>Switchboard ${version}</title>\n`,
    'README.md': `# Switchboard ${version}\n`,
  };
}

/** Tar entries of `files` under `switchboard-<version>/` (folders first, like git archive). */
export function packageEntries(version: string, files: Record<string, string> = packageFiles(version)): TarInput[] {
  const prefix = packagePrefix(version);
  const folders = new Set<string>();
  for (const file of Object.keys(files)) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  return [
    { path: prefix, type: 'dir' },
    ...[...folders].sort().map((folder): TarInput => ({ path: `${prefix}${folder}/`, type: 'dir' })),
    ...Object.entries(files).map(([file, text]): TarInput => ({ path: `${prefix}${file}`, type: 'file', data: Buffer.from(text) })),
  ];
}

/** Writes a release tarball of `entries` into `dir` and returns both assets (the checksum right unless `checksum` is given). */
export async function releaseAssets(dir: string, version: string, options: { readonly entries?: TarInput[]; readonly checksum?: string } = {}): Promise<FakeAsset[]> {
  const file = path.join(dir, tarballName(version));
  await writeTarGz(options.entries ?? packageEntries(version), file);
  const data = await readFile(file);
  const hex = createHash('sha256').update(data).digest('hex');
  const sum = Buffer.from(options.checksum ?? checksumLine(hex, tarballName(version)));
  await writeFile(path.join(dir, checksumName(version)), sum);
  return [
    { name: tarballName(version), data },
    { name: checksumName(version), data: sum },
  ];
}

/** A REST API release object of `version`. */
export function apiRelease(version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: `v${version}`,
    name: `Switchboard ${version}`,
    body: `## What's new\n\n- Updates from **GitHub releases**.\n`,
    draft: false,
    prerelease: false,
    published_at: '2026-09-30T06:28:02Z',
    html_url: `https://github.com/acme/switchboard/releases/tag/v${version}`,
    ...extra,
  };
}
