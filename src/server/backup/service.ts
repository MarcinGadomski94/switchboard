import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  BACKUP_AUTO_SETTING,
  BACKUP_INTERVAL_MS,
  BACKUP_STATE_SETTING,
  type BackupAutoSettings,
  type BackupInspection,
  type BackupLastRun,
  type BackupPreview,
  type BackupStatus,
  type PathMap,
  backupFileName,
  backupsToPrune,
  isBackupFileName,
  readBackupAuto,
  restoreRefusal,
} from '../../core/backup.ts';
import type { SettingRepository } from '../db/repos/settings.ts';
import type { SecretRef, SecretStore } from '../team/access/secret-store.ts';
import { createBackup, readBackupPreview } from './archive.ts';
import { BackupCryptoError, type BackupKey, DEFAULT_KDF, type KdfParams, newKey, passphraseKey } from './crypto.ts';
import { RESTORE_PENDING_DIR, RestoreError, agentsHere, automaticMaps, missingFolders, prepareRestore, readRestoreReport } from './restore.ts';

/**
 * D168 · Settings → Backup (`docs/backup.md`): Back up now, the automatic daily backups, and a
 * restore prepared here and applied at the next start (`applyPendingRestore` in `main.ts`), with
 * Switchboard restarted through the login service when it runs under it (D140's restart).
 */

/** The automatic backups' key in the keychain (derived from the passphrase once; never the passphrase). */
export const BACKUP_KEY_REF: SecretRef = { service: 'Switchboard Backup', account: 'automatic' };

export type { BackupInspection, BackupLastRun, BackupStatus } from '../../core/backup.ts';

/** Options of {@link BackupService}. */
export interface BackupServiceOptions {
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly version: string;
  readonly settings: SettingRepository;
  readonly secrets: SecretStore | null;
  /** Restarts Switchboard through the login service (D140's one start); only called when {@link restartsItself}. */
  readonly restart?: () => Promise<void>;
  /** Whether this Switchboard runs under the login service (else the developer restarts it). */
  readonly restartsItself?: () => Promise<boolean>;
  /** Tests: a cheaper key derivation. */
  readonly kdf?: KdfParams;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

/** A refusal of the backup routes. */
export class BackupError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;
  constructor(status: number, code: string, message: string, detail: unknown = null) {
    super(message);
    this.name = 'BackupError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** A passphrase as the routes take it: 8–1024 characters. */
export function readPassphrase(value: unknown): string | null {
  return typeof value === 'string' && value.length >= 8 && value.length <= 1024 ? value : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** See the module comment. */
export class BackupService {
  readonly #o: BackupServiceOptions;
  #running: 'backup' | 'restore' | null = null;
  #job: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: BackupServiceOptions) {
    this.#o = options;
  }

  get defaultFolder(): string {
    return path.join(this.#o.home, 'SwitchboardBackups');
  }

  async #auto(): Promise<BackupAutoSettings> {
    return readBackupAuto(await this.#o.settings.get(BACKUP_AUTO_SETTING));
  }

  async #folder(): Promise<string> {
    return (await this.#auto()).folder ?? this.defaultFolder;
  }

  async #last(): Promise<BackupLastRun | null> {
    const stored = (await this.#o.settings.get(BACKUP_STATE_SETTING)) as BackupLastRun | undefined;
    return stored && typeof stored === 'object' && typeof stored.at === 'string' ? stored : null;
  }

  async #storedKey(): Promise<BackupKey | null> {
    if (!this.#o.secrets) return null;
    const raw = await this.#o.secrets.get(BACKUP_KEY_REF).catch(() => null);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { key: string; salt: string; params: KdfParams };
      return { key: Buffer.from(parsed.key, 'base64'), salt: Buffer.from(parsed.salt, 'base64'), params: parsed.params };
    } catch {
      return null;
    }
  }

  /** `GET /api/backup`. */
  async status(): Promise<BackupStatus> {
    const auto = await this.#auto();
    const folder = auto.folder ?? this.defaultFolder;
    const files: Array<{ name: string; size: number; at: string }> = [];
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (!isBackupFileName(name)) continue;
      const info = await stat(path.join(folder, name)).catch(() => null);
      if (info?.isFile()) files.push({ name, size: info.size, at: info.mtime.toISOString() });
    }
    files.sort((a, b) => b.name.localeCompare(a.name));
    return {
      auto: { ...auto, hasKey: (await this.#storedKey()) !== null },
      folder,
      defaultFolder: this.defaultFolder,
      running: this.#running,
      last: await this.#last(),
      files,
      lastRestore: await readRestoreReport(this.#o.dataDir),
      restartsItself: (await this.#o.restartsItself?.().catch(() => false)) ?? false,
    };
  }

  /** The path of a backup file in the backup folder (`null` when the name is not one). */
  async fileOf(name: string): Promise<string | null> {
    if (!isBackupFileName(name)) return null;
    const file = path.join(await this.#folder(), name);
    return (await stat(file).then((info) => info.isFile()).catch(() => false)) ? file : null;
  }

  async #run(trigger: 'manual' | 'automatic', key: BackupKey, folder: string): Promise<BackupLastRun> {
    const at = this.#o.now?.() ?? new Date();
    const file = path.join(folder, backupFileName(at, trigger === 'automatic' ? 'auto' : ''));
    let last: BackupLastRun;
    try {
      const result = await createBackup({ dataDir: this.#o.dataDir, env: this.#o.env, home: this.#o.home, version: this.#o.version, secrets: this.#o.secrets, ...(this.#o.now ? { now: this.#o.now } : {}) }, file, key);
      last = { at: at.toISOString(), ok: true, trigger, file: result.file, size: result.size, error: null };
      if (trigger === 'automatic') {
        const auto = await this.#auto();
        for (const name of backupsToPrune(await readdir(folder).catch(() => [] as string[]), auto.keep)) await rm(path.join(folder, name), { force: true }).catch(() => undefined);
      }
    } catch (error) {
      last = { at: at.toISOString(), ok: false, trigger, file: null, size: null, error: errorText(error) };
    }
    await this.#o.settings.set(BACKUP_STATE_SETTING, last);
    return last;
  }

  #exclusive<T>(kind: 'backup' | 'restore', work: () => Promise<T>): Promise<T> {
    if (this.#running) return Promise.reject(new BackupError(409, 'busy', this.#running === 'backup' ? 'A backup is being made right now.' : 'A restore is being prepared right now.'));
    this.#running = kind;
    const job = work().finally(() => {
      this.#running = null;
    });
    this.#job = job.catch(() => undefined);
    return job;
  }

  /** Waits for the running job (tests). */
  async idle(): Promise<void> {
    await this.#job;
  }

  /** `POST /api/backup { passphrase }`: starts a backup into the backup folder; resolves when it is done. */
  backupNow(body: unknown): Promise<BackupLastRun> {
    const input = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const passphrase = readPassphrase(input['passphrase']);
    if (!passphrase) return Promise.reject(new BackupError(422, 'invalid', 'Give a passphrase of at least 8 characters: the backup is encrypted with it, and it is needed to restore.'));
    return this.#exclusive('backup', async () => {
      const key = await newKey(passphrase, this.#o.kdf ?? DEFAULT_KDF);
      try {
        return await this.#run('manual', key, await this.#folder());
      } finally {
        key.key.fill(0);
      }
    });
  }

  /** `PUT /api/backup/auto { enabled?, folder?, keep?, passphrase? }`. */
  async setAuto(body: unknown): Promise<BackupStatus> {
    const input = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const before = await this.#auto();
    const folder = input['folder'] === undefined ? before.folder : input['folder'] === null || input['folder'] === '' ? null : typeof input['folder'] === 'string' && path.isAbsolute(input['folder']) ? input['folder'] : undefined;
    if (folder === undefined) throw new BackupError(422, 'invalid', 'The backup folder must be a full path.');
    const keep = input['keep'] === undefined ? before.keep : typeof input['keep'] === 'number' && Number.isInteger(input['keep']) && input['keep'] >= 1 && input['keep'] <= 100 ? input['keep'] : undefined;
    if (keep === undefined) throw new BackupError(422, 'invalid', 'Keep between 1 and 100 backups.');
    if (input['passphrase'] !== undefined) {
      const passphrase = readPassphrase(input['passphrase']);
      if (!passphrase) throw new BackupError(422, 'invalid', 'Give a passphrase of at least 8 characters.');
      if (!this.#o.secrets) throw new BackupError(503, 'keychain-unavailable', 'This computer has no keychain Switchboard can keep the key in.');
      const key = await newKey(passphrase, this.#o.kdf ?? DEFAULT_KDF);
      try {
        await this.#o.secrets.set(BACKUP_KEY_REF, JSON.stringify({ key: key.key.toString('base64'), salt: key.salt.toString('base64'), params: key.params }));
      } finally {
        key.key.fill(0);
      }
    }
    const enabled = input['enabled'] === undefined ? before.enabled : input['enabled'] === true;
    if (enabled && (await this.#storedKey()) === null) throw new BackupError(422, 'needs-passphrase', 'Set the passphrase the automatic backups are encrypted with first.');
    await this.#o.settings.set(BACKUP_AUTO_SETTING, { enabled, folder, keep });
    return this.status();
  }

  /** Runs the automatic backup when it is due (a day after the last one). */
  async tick(): Promise<BackupLastRun | null> {
    const auto = await this.#auto();
    if (!auto.enabled || this.#running) return null;
    const last = await this.#last();
    const now = (this.#o.now?.() ?? new Date()).getTime();
    const lastAuto = last && last.trigger === 'automatic' ? Date.parse(last.at) : 0;
    if (now - lastAuto < BACKUP_INTERVAL_MS) return null;
    const key = await this.#storedKey();
    if (!key) return null;
    return this.#exclusive('backup', () => this.#run('automatic', key, auto.folder ?? this.defaultFolder)).catch((error: unknown) => {
      this.#o.onError?.(error);
      return null;
    });
  }

  /** Starts the automatic backups' check (every 30 minutes; the first a minute after start). */
  start(): void {
    if (this.#timer) return;
    const run = (): void => {
      void this.tick().catch((error: unknown) => this.#o.onError?.(error));
    };
    const first = setTimeout(run, 60_000);
    first.unref();
    this.#timer = setInterval(run, 30 * 60_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #keyOf(body: Record<string, unknown>): (header: Parameters<ReturnType<typeof passphraseKey>>[0]) => Promise<Buffer> {
    const passphrase = typeof body['passphrase'] === 'string' ? body['passphrase'] : '';
    if (passphrase === '') throw new BackupError(422, 'invalid', 'Give the passphrase this backup was made with.');
    return passphraseKey(passphrase);
  }

  async #fileFrom(body: Record<string, unknown>): Promise<string> {
    const value = typeof body['file'] === 'string' ? body['file'].trim() : '';
    if (value === '') throw new BackupError(422, 'invalid', 'Choose a backup file.');
    const file = path.isAbsolute(value) ? value : await this.fileOf(value);
    if (!file || !(await stat(file).then((info) => info.isFile()).catch(() => false))) throw new BackupError(404, 'not-found', 'There is no such backup file.');
    return file;
  }

  /** `POST /api/backup/inspect { file, passphrase }`: what the backup holds and what this computer lacks (nothing is written). */
  async inspect(body: unknown): Promise<BackupInspection> {
    const input = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const file = await this.#fileFrom(input);
    let preview: BackupPreview;
    try {
      preview = await readBackupPreview(file, this.#keyOf(input));
    } catch (error) {
      throw this.#readError(error);
    }
    const target = { dataDir: this.#o.dataDir, env: this.#o.env, home: this.#o.home, version: this.#o.version, secrets: this.#o.secrets };
    const maps = [...readMaps(input['map']), ...automaticMaps(preview, target)];
    const { conversations, ...rest } = preview;
    return { preview: { ...rest, conversations: conversations.length }, refusal: restoreRefusal(preview, this.#o.version), agentsHere: agentsHere(this.#o.dataDir), missingFolders: await missingFolders(preview, maps) };
  }

  #readError(error: unknown): BackupError {
    if (error instanceof BackupError) return error;
    if (error instanceof BackupCryptoError) return new BackupError(error.code === 'wrong-passphrase' ? 401 : 422, error.code, error.message);
    if (error instanceof RestoreError) return new BackupError(error.code === 'failed' ? 500 : 409, error.code, error.message, error.detail);
    return new BackupError(422, 'damaged', `The backup could not be read: ${errorText(error)}`);
  }

  /**
   * `POST /api/backup/restore { file, passphrase, map, identity, replace, allowMissing }`: prepares the
   * restore next to the data folder, then restarts Switchboard (under the login service) to apply it;
   * `manual`: the developer restarts it.
   */
  restore(body: unknown): Promise<{ readonly restart: 'restarting' | 'manual' }> {
    const input = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const identity = input['identity'] === 'keep' ? 'keep' : input['identity'] === 'new' ? 'new' : null;
    if (!identity) return Promise.reject(new BackupError(422, 'invalid', 'Choose whether this computer takes over the old one\'s identity or starts as a new computer.'));
    return this.#exclusive('restore', async () => {
      const file = await this.#fileFrom(input);
      const staging = path.join(this.#o.dataDir, RESTORE_PENDING_DIR);
      try {
        await prepareRestore(
          file,
          this.#keyOf(input),
          { dataDir: this.#o.dataDir, env: this.#o.env, home: this.#o.home, version: this.#o.version, secrets: this.#o.secrets },
          { maps: readMaps(input['map']), identity, replace: input['replace'] === true, allowMissing: input['allowMissing'] === true },
          staging,
        );
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw this.#readError(error);
      }
      // Answer first, then restart (the login service's one start, D140); by hand otherwise.
      const itself = (await this.#o.restartsItself?.().catch(() => false)) ?? false;
      if (itself && this.#o.restart) {
        const restart = this.#o.restart;
        setTimeout(() => {
          void restart().catch((error: unknown) => this.#o.onError?.(error));
        }, 500).unref();
        return { restart: 'restarting' as const };
      }
      return { restart: 'manual' as const };
    });
  }

  /** `DELETE /api/backup/restore`: drops a prepared restore that was not applied yet. */
  async cancelRestore(): Promise<void> {
    await rm(path.join(this.#o.dataDir, RESTORE_PENDING_DIR), { recursive: true, force: true });
  }
}

/** `map` as the routes take it: `{ "<old path>": "<new path>" }` or `[{ from, to }]`. */
export function readMaps(value: unknown): PathMap[] {
  if (Array.isArray(value)) return value.filter((entry): entry is PathMap => typeof entry === 'object' && entry !== null && typeof (entry as PathMap).from === 'string' && typeof (entry as PathMap).to === 'string' && (entry as PathMap).to.trim() !== '').map((entry) => ({ from: entry.from, to: entry.to.trim() }));
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '').map(([from, to]) => ({ from, to: to.trim() }));
  return [];
}
