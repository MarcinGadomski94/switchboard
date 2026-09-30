import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { checksumName, packagePrefix, parseChecksum, tarballName } from '../../core/release.ts';
import { compareSemVer, isNewerRelease, parseSemVer } from '../../core/semver.ts';
import type { InstallKind, ReleaseInfo, RestartMode, UpdateCheck, UpdateErrorCode, UpdateProgress, UpdateStatus } from '../../core/updates.ts';
import { updateRunning } from '../../core/updates.ts';
import type { SettingRepository } from '../db/repos/settings.ts';
import type { HubBus } from '../hub/bus.ts';
import { type RunResult, failureText, succeeded } from '../exec.ts';
import { extractRelease } from './extract.ts';
import { type FoundRelease, type ReleaseSource, ReleaseSourceError } from './github.ts';
import { type InstallLedger, type UpdatePaths, isInside, packageVersion, pruneInstalls, readLedger, versionDir, writeLedger } from './install.ts';

/**
 * The updater (D55, `docs/updates.md`): checks GitHub releases on start and
 * hourly (and on "Check for updates"), raises the Inbox item and the banner
 * (through `updateChanged`) for a newer release, and — for a release install
 * only — downloads, verifies, unpacks, installs (`npm ci --omit=dev`) and
 * switches to it, then restarts through the login service. Git checkouts are
 * only told. One update at a time; any failure before the switch leaves the
 * running install exactly as it was.
 */

/** Hourly checks. */
export const CHECK_INTERVAL_MS = 60 * 60_000;

/** The tarball's size limit (1.0.0: 3.3 MB). */
export const TARBALL_LIMIT = 200 * 1024 * 1024;

/** The checksum file's size limit (one line). */
export const CHECKSUM_LIMIT = 4096;

/** The settings key the updater keeps its state in (not a known setting: `GET /api/settings` does not show it). */
export const UPDATE_STATE_SETTING = 'updates.state';

/** A refused request (`code` → HTTP 409 / 422 in the route). */
export class UpdateError extends Error {
  override name = 'UpdateError';
  readonly code: UpdateErrorCode;
  constructor(code: UpdateErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** What the updater does to the Inbox (the system items service). */
export interface UpdateItems {
  updateAvailable(update: { readonly version: string; readonly tag: string; readonly current: string; readonly kind: InstallKind }): Promise<unknown>;
  updatesResolved(current: string, isAtOrBelow: (version: string, current: string) => boolean): Promise<number>;
}

/** Switches the login service's definition to another install folder (`LoginService.pointTo`). */
export interface ServicePointer {
  /** `true` when a definition is registered ("Start at login" on). */
  registered(): Promise<boolean>;
  pointTo(appDir: string): Promise<unknown>;
}

/** Options for {@link UpdateService}. */
export interface UpdateServiceOptions {
  /** This install's folder (the service's working folder). */
  readonly appDir: string;
  /** This process's version (`package.json`). */
  readonly current: string;
  readonly kind: InstallKind;
  readonly repo: string;
  readonly paths: UpdatePaths;
  readonly source: ReleaseSource;
  /** Runs `npm ci --omit=dev` in a folder. */
  readonly npmCi: (dir: string) => Promise<RunResult>;
  /** How an update restarts (detected once at start). */
  readonly restartMode: () => Promise<RestartMode>;
  /** Asks the login service for the restart into the new definition (and lets this process end). */
  readonly restart: () => Promise<void>;
  /** The login service's definition; `null` = unsupported OS / none. */
  readonly service: ServicePointer | null;
  readonly settings: SettingRepository;
  readonly bus?: HubBus;
  readonly items?: UpdateItems;
  /** Sessions with a live process now. */
  readonly liveSessions?: () => number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  /** After a restart request on Linux: how long to wait for the SIGTERM before reporting a failure. */
  readonly restartTimeoutMs?: number;
}

interface StoredState {
  readonly lastCheck: UpdateCheck | null;
  readonly latest: ReleaseInfo | null;
  readonly dismissed: string | null;
}

const IDLE: UpdateProgress = { phase: 'idle', version: null, message: '', error: null, dir: null, at: null };

function isAtOrBelow(version: string, current: string): boolean {
  const a = parseSemVer(version);
  const b = parseSemVer(current);
  return a !== null && b !== null && compareSemVer(a, b) <= 0;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function readSmall(file: string, limit: number): Promise<string> {
  const info = await stat(file);
  if (info.size > limit) throw new UpdateError('invalid', `${path.basename(file)} is larger than ${limit} bytes`);
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(file)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** The D55 updater. */
export class UpdateService {
  readonly #options: UpdateServiceOptions;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  #state: StoredState = { lastCheck: null, latest: null, dismissed: null };
  #release: FoundRelease | null = null;
  #checking: Promise<UpdateStatus> | null = null;
  #progress: UpdateProgress = IDLE;
  #job: Promise<void> | null = null;
  #timer: NodeJS.Timeout | undefined;
  #restartTimer: NodeJS.Timeout | undefined;
  #restartMode: RestartMode = 'manual';
  #ledger: InstallLedger = { current: null, previous: null };
  #closed = false;

  constructor(options: UpdateServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? ((error) => console.error('switchboard updates:', error));
  }

  /** Loads the stored state and the ledger, detects the restart mode, closes resolved items. Call once before anything else. */
  async init(): Promise<void> {
    const stored = await this.#options.settings.get(UPDATE_STATE_SETTING);
    if (typeof stored === 'object' && stored !== null) {
      const record = stored as Partial<StoredState>;
      this.#state = { lastCheck: record.lastCheck ?? null, latest: record.latest ?? null, dismissed: record.dismissed ?? null };
    }
    this.#ledger = await readLedger(this.#options.paths);
    this.#restartMode = await this.#options.restartMode().catch(() => 'manual' as const);
    await this.#options.items?.updatesResolved(this.#options.current, isAtOrBelow).catch(this.#onError);
  }

  /**
   * Checks now and then every hour; removes an interrupted update's leftovers
   * and the versions no longer needed (`pruneInstalls`) first.
   */
  start(intervalMs: number = CHECK_INTERVAL_MS): void {
    void pruneInstalls(this.#options.paths, this.#options.appDir, this.#ledger)
      .catch(this.#onError)
      .then(() => this.check())
      .catch(() => undefined);
    this.#timer = setInterval(() => {
      if (!updateRunning(this.#progress)) void this.check().catch(() => undefined);
    }, intervalMs);
    this.#timer.unref();
  }

  /** Stops the hourly check and waits for a running job step. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    await this.#checking?.catch(() => undefined);
  }

  /** The state as `GET /api/updates` answers it. */
  status(): UpdateStatus {
    const latest = this.#state.latest;
    const previous = this.#ledger.previous && isInside(this.#options.appDir, this.#options.paths.versions) ? this.#ledger.previous : null;
    return {
      current: this.#options.current,
      install: { kind: this.#options.kind, dir: this.#options.appDir },
      restart: this.#restartMode,
      repo: this.#options.repo,
      checking: this.#checking !== null,
      lastCheck: this.#state.lastCheck,
      latest,
      available: latest !== null && isNewerRelease(latest.version, this.#options.current),
      dismissed: this.#state.dismissed,
      progress: this.#progress,
      previous,
      liveSessions: this.#options.liveSessions?.() ?? 0,
    };
  }

  #publish(): void {
    this.#options.bus?.publish('updateChanged', this.status());
  }

  async #save(): Promise<void> {
    await this.#options.settings.set(UPDATE_STATE_SETTING, this.#state);
  }

  /** Checks GitHub for the newest release; concurrent calls share one check. Never rejects: a failure is in `lastCheck`. */
  check(): Promise<UpdateStatus> {
    if (this.#checking) return this.#checking;
    let run: Promise<UpdateStatus> | null = null;
    run = (async (): Promise<UpdateStatus> => {
      await Promise.resolve();
      const at = this.#now().toISOString();
      try {
        const found = await this.#options.source.latest();
        this.#release = found;
        this.#state = { ...this.#state, lastCheck: { at, ok: true, via: found?.via ?? 'api', error: null }, latest: found?.info ?? null };
      } catch (error) {
        const message = error instanceof ReleaseSourceError ? error.message : `Can't reach releases: ${(error as Error).message}`;
        this.#state = { ...this.#state, lastCheck: { at, ok: false, via: null, error: message } };
      }
      await this.#save().catch(this.#onError);
      const latest = this.#state.latest;
      if (latest && this.#state.lastCheck?.ok && isNewerRelease(latest.version, this.#options.current)) {
        await this.#options.items
          ?.updateAvailable({ version: latest.version, tag: latest.tag, current: this.#options.current, kind: this.#options.kind })
          .catch(this.#onError);
      }
      if (this.#checking === run) this.#checking = null;
      const status = this.status();
      this.#publish();
      return status;
    })();
    this.#checking = run;
    void run.catch(() => undefined).finally(() => {
      if (this.#checking === run) this.#checking = null;
    });
    this.#publish();
    return run;
  }

  /** Hides the banner for `version` (it shows again for a newer one). */
  async dismiss(version: string): Promise<UpdateStatus> {
    if (!parseSemVer(version)) throw new UpdateError('invalid', 'version must be a version');
    this.#state = { ...this.#state, dismissed: version };
    await this.#save();
    this.#publish();
    return this.status();
  }

  /**
   * Starts the update to `version` (the latest found) in the background; the
   * progress goes out as `updateChanged`.
   * @throws {UpdateError} `git-checkout`, `busy`, `checking`, `no-update`, `stale-version`, `invalid`.
   */
  install(version: string): UpdateStatus {
    if (this.#options.kind === 'git') throw new UpdateError('git-checkout', 'This is a git checkout: update it with git (the commands are in Settings → Updates).');
    if (this.#job || updateRunning(this.#progress)) throw new UpdateError('busy', 'An update is already running.');
    if (this.#checking) throw new UpdateError('checking', 'A check for updates is running; try again in a moment.');
    const latest = this.#state.latest;
    const release = this.#release;
    if (!latest || !release || !isNewerRelease(latest.version, this.#options.current)) throw new UpdateError('no-update', 'There is no newer release to install. Check for updates first.');
    if (latest.version !== version) throw new UpdateError('stale-version', `The newest release is ${latest.version}, not ${version}.`);
    this.#setProgress('downloading', version);
    this.#job = this.#run(release).finally(() => {
      this.#job = null;
    });
    return this.status();
  }

  #setProgress(phase: UpdateProgress['phase'], version: string, extra: Partial<UpdateProgress> = {}): void {
    this.#progress = { phase, version, message: '', error: null, dir: null, at: this.#now().toISOString(), ...extra };
    this.#publish();
  }

  async #run(release: FoundRelease): Promise<void> {
    const { paths } = this.#options;
    const version = release.info.version;
    const id = `${version}-${randomBytes(4).toString('hex')}`;
    const downloads = path.join(paths.downloads, id);
    const staging = path.join(paths.staging, id);
    let switched = false;
    try {
      // 1. Download the tarball and its checksum (both must exist).
      await mkdir(downloads, { recursive: true });
      const tarball = tarballName(version);
      const checksum = checksumName(version);
      if (!release.assets.some((asset) => asset.name === checksum)) throw new UpdateError('invalid', `the release has no ${checksum}; refusing to install an unverified package`);
      const sumFile = await this.#options.source.download(release, checksum, downloads, CHECKSUM_LIMIT);
      const tarFile = await this.#options.source.download(release, tarball, downloads, TARBALL_LIMIT);
      // 2. Verify before anything is unpacked.
      this.#setProgress('verifying', version);
      const expected = parseChecksum(await readSmall(sumFile, CHECKSUM_LIMIT), tarball);
      if (!expected) throw new UpdateError('invalid', `${checksum} is not "<sha256>  ${tarball}"`);
      const actual = await sha256File(tarFile);
      if (actual !== expected) throw new UpdateError('invalid', `checksum mismatch: ${tarball} is ${actual}, ${checksum} says ${expected}; refused`);
      // 3. Unpack into a fresh staging folder (only switchboard-<v>/ entries).
      this.#setProgress('extracting', version);
      const { root } = await extractRelease(tarFile, staging, packagePrefix(version));
      const staged = await packageVersion(root);
      if (staged !== version) throw new UpdateError('invalid', `the package says it is ${staged ?? 'no version'}, not ${version}`);
      if (!(await exists(path.join(root, 'dist', 'web', 'index.html')))) throw new UpdateError('invalid', 'the package has no built UI (dist/web)');
      if (!(await exists(path.join(root, 'src', 'server', 'main.ts')))) throw new UpdateError('invalid', 'the package has no src/server/main.ts');
      await rm(downloads, { recursive: true, force: true });
      // 4. npm ci --omit=dev in the staged folder.
      this.#setProgress('installing', version);
      const result = await this.#options.npmCi(root);
      if (!succeeded(result)) throw new UpdateError('invalid', `npm ci --omit=dev failed: ${failureText(result)}`);
      // 5. Switch: the staged folder becomes versions/<v>; the service definition points at it.
      this.#setProgress('switching', version);
      const target = versionDir(paths, version);
      if (path.resolve(target) === path.resolve(this.#options.appDir)) throw new UpdateError('invalid', `${target} is the running install`);
      await mkdir(paths.versions, { recursive: true });
      await rm(target, { recursive: true, force: true });
      await rename(root, target);
      await rm(staging, { recursive: true, force: true });
      const registered = (await this.#options.service?.registered()) ?? false;
      if (this.#restartMode === 'service' || registered) {
        try {
          await this.#options.service?.pointTo(target);
        } catch (error) {
          throw new UpdateError('invalid', `could not point the login service at ${version}: ${(error as Error).message}`);
        }
      }
      switched = true;
      const previous = { version: this.#options.current, dir: this.#options.appDir };
      this.#ledger = { current: { version, dir: target }, previous };
      await writeLedger(paths, this.#ledger);
      // 6. Restart.
      if (this.#restartMode === 'service') {
        this.#setProgress('restarting', version, { dir: target });
        this.#armRestartWatchdog(version, target);
        await this.#options.restart();
      } else {
        this.#setProgress('restart-manually', version, {
          dir: target,
          message: registered ? `Start at login now starts ${version}.` : '',
        });
      }
    } catch (error) {
      if (this.#restartTimer) clearTimeout(this.#restartTimer);
      const message = error instanceof Error ? error.message : String(error);
      await rm(downloads, { recursive: true, force: true }).catch(() => undefined);
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      this.#setProgress('failed', version, {
        error: switched ? `${message} (${version} is installed at ${versionDir(paths, version)}; restart Switchboard yourself)` : message,
        ...(switched ? { dir: versionDir(paths, version) } : {}),
      });
      if (!switched) this.#onError(error);
    }
  }

  /** On Linux the manager stops this process; if nothing happens in time, say so. */
  #armRestartWatchdog(version: string, dir: string): void {
    const ms = this.#options.restartTimeoutMs ?? 60_000;
    this.#restartTimer = setTimeout(() => {
      if (this.#closed || this.#progress.phase !== 'restarting') return;
      this.#setProgress('failed', version, { dir, error: `the login service did not restart Switchboard within ${Math.round(ms / 1000)} s; ${version} is installed at ${dir}: restart Switchboard yourself` });
    }, ms);
    this.#restartTimer.unref();
  }

  /** The running job (tests wait for it). */
  get job(): Promise<void> | null {
    return this.#job;
  }
}
