import { open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseSemVer } from '../../core/semver.ts';
import type { ReleaseInfo } from '../../core/updates.ts';
import { type RunResult, failureText, runCommand, succeeded } from '../exec.ts';

/**
 * Where releases come from (D55, `docs/updates.md` → *Checking*): the public
 * GitHub REST API, unauthenticated; when it answers 401 / 403 / 404 / 429 (a
 * private repository, a rate limit) the GitHub CLI (`gh`, with its own sign-in)
 * is asked instead. Switchboard never sends a credential of its own. Downloads
 * come only from the release's asset URLs on github.com, over HTTPS, following
 * redirects only to GitHub's asset hosts, with a size limit.
 */

/** The public API. */
export const GITHUB_API = 'https://api.github.com';

/** Hosts a release asset download may be redirected to (GitHub's asset CDN). */
export const ASSET_HOSTS: ReadonlySet<string> = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']);

/** API statuses after which `gh` is tried (private repository, auth, rate limit). */
const FALLBACK_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 429]);

const MAX_REDIRECTS = 5;
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const GH_VIEW_TIMEOUT_MS = 30_000;
const GH_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** One downloadable file of a release. */
export interface ReleaseAsset {
  readonly name: string;
  readonly size: number | null;
  /** The browser download URL (`null` when gh did not give one). */
  readonly url: string | null;
}

/** The newest release and how it was found. */
export interface FoundRelease {
  readonly info: ReleaseInfo;
  readonly assets: readonly ReleaseAsset[];
  readonly via: 'api' | 'gh';
}

/** A failure to reach or read the releases; `message` is shown as it is. */
export class ReleaseSourceError extends Error {
  override name = 'ReleaseSourceError';
}

/** What the updater needs from a release source (tests stub it). */
export interface ReleaseSource {
  /** The newest published release (no drafts, no pre-releases), or `null` when the repository has none. */
  latest(): Promise<FoundRelease | null>;
  /**
   * Downloads the asset `name` of `release` into `dir` (as `<dir>/<name>`), at
   * most `limit` bytes.
   * @returns the file.
   */
  download(release: FoundRelease, name: string, dir: string, limit: number): Promise<string>;
}

/** Options for {@link GitHubReleases}. */
export interface GitHubReleasesOptions {
  /** `owner/name`. */
  readonly repo: string;
  /**
   * Tests only (`SWITCHBOARD_UPDATE_API`): the fake GitHub's origin (loopback
   * HTTP allowed). Then the API and every download must be on that origin.
   */
  readonly testOrigin?: string | null;
  /** The GitHub CLI as an argv prefix (`SWITCHBOARD_GH_BIN`). */
  readonly ghCommand: readonly string[];
  /** Sent as `User-Agent` (GitHub requires one). */
  readonly userAgent: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly run?: (command: readonly string[], args: readonly string[], timeoutMs: number) => Promise<RunResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The release info of a tag; refuses a tag that is not a version. */
export function releaseInfo(fields: { tag: string; name: string | null; notes: string | null; publishedAt: string | null; url: string | null }): ReleaseInfo {
  const version = parseSemVer(fields.tag);
  if (!version || !/^v?\d/.test(fields.tag)) throw new ReleaseSourceError(`The latest release's tag "${fields.tag}" is not a version (vMAJOR.MINOR.PATCH).`);
  return {
    version: version.text,
    tag: fields.tag,
    name: fields.name?.trim() || fields.tag,
    notes: fields.notes ?? '',
    publishedAt: fields.publishedAt,
    url: fields.url,
  };
}

/** Reads the REST API's release object; `null` for a draft or a pre-release. */
export function parseApiRelease(body: unknown): FoundRelease | null {
  if (!isRecord(body)) throw new ReleaseSourceError('GitHub answered something that is not a release.');
  if (body['draft'] === true || body['prerelease'] === true) return null;
  const tag = str(body['tag_name']);
  if (!tag) throw new ReleaseSourceError('GitHub answered a release without a tag.');
  const info = releaseInfo({ tag, name: str(body['name']), notes: str(body['body']), publishedAt: str(body['published_at']), url: str(body['html_url']) });
  if (parseSemVer(tag)?.prerelease.length) return null;
  const assets = Array.isArray(body['assets']) ? body['assets'].filter(isRecord) : [];
  return {
    info,
    via: 'api',
    assets: assets.flatMap((asset) => {
      const name = str(asset['name']);
      return name ? [{ name, size: typeof asset['size'] === 'number' ? asset['size'] : null, url: str(asset['browser_download_url']) }] : [];
    }),
  };
}

/** Reads `gh release view --json …`; `null` for a draft or a pre-release. */
export function parseGhRelease(stdout: string): FoundRelease | null {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new ReleaseSourceError('gh answered something that is not JSON.');
  }
  if (!isRecord(body)) throw new ReleaseSourceError('gh answered something that is not a release.');
  if (body['isDraft'] === true || body['isPrerelease'] === true) return null;
  const tag = str(body['tagName']);
  if (!tag) throw new ReleaseSourceError('gh answered a release without a tag.');
  const info = releaseInfo({ tag, name: str(body['name']), notes: str(body['body']), publishedAt: str(body['publishedAt']), url: str(body['url']) });
  if (parseSemVer(tag)?.prerelease.length) return null;
  const assets = Array.isArray(body['assets']) ? body['assets'].filter(isRecord) : [];
  return {
    info,
    via: 'gh',
    assets: assets.flatMap((asset) => {
      const name = str(asset['name']);
      return name ? [{ name, size: typeof asset['size'] === 'number' ? asset['size'] : null, url: str(asset['url']) }] : [];
    }),
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const detail = cause instanceof Error ? cause.message : null;
    if (error.name === 'TimeoutError') return 'the request timed out';
    return detail && detail !== error.message ? `${error.message} (${detail})` : error.message;
  }
  return String(error);
}

/**
 * The real source: the REST API first, `gh` after a 401 / 403 / 404 / 429.
 * Downloads follow the way the release was found.
 */
export class GitHubReleases implements ReleaseSource {
  readonly #options: GitHubReleasesOptions;
  readonly #api: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubReleasesOptions) {
    this.#options = options;
    this.#api = options.testOrigin ?? GITHUB_API;
    this.#fetch = options.fetch ?? fetch;
  }

  async latest(): Promise<FoundRelease | null> {
    const url = `${this.#api}/repos/${this.#options.repo}/releases/latest`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': this.#options.userAgent },
        redirect: 'error',
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ReleaseSourceError(`Can't reach releases: ${describe(error)}.`);
    }
    if (response.status === 200) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ReleaseSourceError("Can't reach releases: GitHub answered something that is not JSON.");
      }
      return parseApiRelease(body);
    }
    await response.body?.cancel().catch(() => undefined);
    if (!FALLBACK_STATUSES.has(response.status)) throw new ReleaseSourceError(`Can't reach releases: GitHub answered HTTP ${response.status}.`);
    return this.#ghLatest(response.status);
  }

  async #ghLatest(status: number): Promise<FoundRelease | null> {
    const why = status === 404 ? 'GitHub answered 404 (a private repository, or no release yet)' : `GitHub answered HTTP ${status}`;
    const result = await this.#run(['release', 'view', '--repo', this.#options.repo, '--json', 'tagName,name,body,assets,publishedAt,isDraft,isPrerelease,url'], GH_VIEW_TIMEOUT_MS);
    if (succeeded(result)) return parseGhRelease(result.stdout);
    const text = failureText(result);
    if (/release not found/i.test(text)) return null;
    const ghMissing = result.error !== null && /ENOENT/.test(result.error.message);
    throw new ReleaseSourceError(`Can't reach releases: ${why}, and ${ghMissing ? 'gh is not installed' : `gh failed: ${text}`}.`);
  }

  #run(args: readonly string[], timeoutMs: number): Promise<RunResult> {
    if (this.#options.run) return this.#options.run(this.#options.ghCommand, args, timeoutMs);
    return runCommand(this.#options.ghCommand, args, { cwd: this.#options.cwd, env: this.#options.env ?? process.env, timeoutMs, maxOutputBytes: 8 * 1024 * 1024 });
  }

  async download(release: FoundRelease, name: string, dir: string, limit: number): Promise<string> {
    const asset = release.assets.find((candidate) => candidate.name === name);
    if (!asset) throw new ReleaseSourceError(`The release ${release.info.tag} has no ${name}.`);
    if (asset.size !== null && asset.size > limit) throw new ReleaseSourceError(`${name} is ${asset.size} bytes, more than the ${limit}-byte limit.`);
    const file = path.join(dir, name);
    if (release.via === 'gh') {
      const result = await this.#run(['release', 'download', release.info.tag, '--repo', this.#options.repo, '--pattern', name, '--dir', dir, '--clobber'], GH_DOWNLOAD_TIMEOUT_MS);
      if (!succeeded(result)) throw new ReleaseSourceError(`gh could not download ${name}: ${failureText(result)}`);
      const size = await stat(file).then((info) => info.size, () => null);
      if (size === null) throw new ReleaseSourceError(`gh did not write ${name}.`);
      if (size > limit) {
        await rm(file, { force: true });
        throw new ReleaseSourceError(`${name} is more than the ${limit}-byte limit.`);
      }
      return file;
    }
    if (!asset.url) throw new ReleaseSourceError(`${name} has no download URL.`);
    this.#checkAssetUrl(asset.url, release.info.tag, name);
    await this.#fetchTo(asset.url, file, limit);
    return file;
  }

  /** The asset URL must be this repository's release download URL (or the test origin's). */
  #checkAssetUrl(raw: string, tag: string, name: string): void {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ReleaseSourceError(`The download URL of ${name} is not a URL.`);
    }
    if (this.#options.testOrigin) {
      if (url.origin !== this.#options.testOrigin) throw new ReleaseSourceError(`Refused to download ${name} from ${url.origin}.`);
      return;
    }
    const expected = `/${this.#options.repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== '' || url.pathname !== expected || url.username || url.password) {
      throw new ReleaseSourceError(`Refused to download ${name} from ${url.href}: not a release asset of ${this.#options.repo}.`);
    }
  }

  #hostAllowed(url: URL): boolean {
    if (this.#options.testOrigin) return url.origin === this.#options.testOrigin;
    return url.protocol === 'https:' && url.port === '' && !url.username && !url.password && ASSET_HOSTS.has(url.hostname);
  }

  async #fetchTo(start: string, file: string, limit: number): Promise<void> {
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    let url = new URL(start);
    for (let hop = 0; ; hop++) {
      if (!this.#hostAllowed(url)) throw new ReleaseSourceError(`Refused a download redirect to ${url.origin}.`);
      let response: Response;
      try {
        response = await this.#fetch(url, { headers: { 'user-agent': this.#options.userAgent, accept: 'application/octet-stream' }, redirect: 'manual', signal });
      } catch (error) {
        throw new ReleaseSourceError(`Download failed: ${describe(error)}.`);
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location) throw new ReleaseSourceError(`Download failed: a redirect (HTTP ${response.status}) without a location.`);
        if (hop >= MAX_REDIRECTS) throw new ReleaseSourceError('Download failed: too many redirects.');
        url = new URL(location, url);
        continue;
      }
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new ReleaseSourceError(`Download failed: HTTP ${response.status}.`);
      }
      const declared = Number(response.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > limit) {
        await response.body.cancel().catch(() => undefined);
        throw new ReleaseSourceError(`Download refused: ${declared} bytes, more than the ${limit}-byte limit.`);
      }
      const handle = await open(file, 'w');
      let size = 0;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          if (size > limit) throw new ReleaseSourceError(`Download refused: more than the ${limit}-byte limit.`);
          await handle.write(chunk);
        }
      } catch (error) {
        await handle.close();
        await rm(file, { force: true });
        if (error instanceof ReleaseSourceError) throw error;
        throw new ReleaseSourceError(`Download failed: ${describe(error)}.`);
      }
      await handle.close();
      return;
    }
  }
}
