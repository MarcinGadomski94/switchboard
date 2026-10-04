import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  type AccountProfile,
  type AccountSettings,
  ACCOUNT_SETTINGS_KEY,
  type ExhaustedMark,
  type LimitWindow,
  type ProfileSignIn,
  type ProfileSnapshot,
  type ProfileUsage,
  cleanProfileName,
  defaultProfileId,
  pickProfileForNewSession,
  readAccountSettings,
} from '../../core/accounts.ts';
import { CLI_PROVIDERS, type CliProviderId } from '../../core/cli-providers.ts';
import type { ProfileRecord } from '../db/repos/profiles.ts';
import type { Store } from '../db/store.ts';
import { type RunResult, runCommand, succeeded } from '../exec.ts';
import { childEnv } from '../supervisor/argv.ts';
import type { CliRegistry } from '../cli/registry.ts';
import type { ProviderUsage } from '../cli/bridge-common.ts';
import { claudeSignIn, codexSignIn, opencodeSignIn } from '../cli/status.ts';
import { defaultDir, shareSettings } from './share.ts';

/** A refusal with an API status. */
export class AccountError extends Error {
  override name = 'AccountError';
  readonly status: number;
  readonly code: string;
  readonly field: string | null;
  constructor(status: number, code: string, message: string, field: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** Options of {@link AccountService}. */
export interface AccountServiceOptions {
  readonly store: Store;
  /** Profiles' folders live under `<dataDir>/profiles/<cli>/<id>` (mode 0700). */
  readonly dataDir: string;
  readonly registry: CliRegistry;
  /** The base environment of the children (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  /** Time limit of one status check (ms, default 20 s). */
  readonly timeoutMs?: number;
}

const TTL_MS = 60_000;

interface Checked {
  readonly at: number;
  readonly signIn: ProfileSignIn;
  readonly account: string | null;
}

/** The environment variable that points each CLI at a profile's folder. */
export const PROFILE_ENV: Readonly<Record<CliProviderId, string>> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', opencode: 'XDG_DATA_HOME' };

function quote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * D63 (`docs/accounts.md`): the account profiles of each CLI: their folders, the
 * environment a process of a profile gets, their sign-in status (the CLI's own
 * status command, never a credential file), their usage and which are spent, and
 * the rules (`accounts.settings`). The switching itself is the supervisor's
 * (`switchAccount`) driven by `AutoSwitcher`.
 */
export class AccountService {
  readonly #options: AccountServiceOptions;
  readonly #checks = new Map<string, Checked>();
  readonly #providerUsage = new Map<string, ProviderUsage>();

  constructor(options: AccountServiceOptions) {
    this.#options = options;
  }

  get #store(): Store {
    return this.#options.store;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  get #baseEnv(): NodeJS.ProcessEnv {
    return this.#options.env ?? process.env;
  }

  // ── settings ────────────────────────────────────────────────────────────────

  async settings(): Promise<AccountSettings> {
    return readAccountSettings(await this.#store.settings.get(ACCOUNT_SETTINGS_KEY));
  }

  /** Merges a (partial) settings object over the stored one; each field is read defensively. */
  async setSettings(patch: unknown): Promise<AccountSettings> {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new AccountError(422, 'invalid', 'the body must be a settings object');
    const current = await this.settings();
    const p = patch as Record<string, Record<string, unknown> | unknown>;
    const merged = {
      ...current,
      ...p,
      perCli: { ...current.perCli, ...((p['perCli'] as object) ?? {}) },
      thresholds: { ...current.thresholds, ...((p['thresholds'] as object) ?? {}) },
      newSessions: { ...current.newSessions, ...((p['newSessions'] as object) ?? {}) },
      exhausted: { ...current.exhausted, ...((p['exhausted'] as object) ?? {}) },
    };
    const next = readAccountSettings(merged);
    if (next.exhausted.action === 'switch-cli' && next.exhausted.cli === null) throw new AccountError(422, 'invalid', 'pick the CLI to switch to', 'exhausted.cli');
    await this.#store.settings.set(ACCOUNT_SETTINGS_KEY, next);
    return next;
  }

  // ── profiles ────────────────────────────────────────────────────────────────

  /** `<dataDir>/profiles/<cli>`. */
  profilesDir(cli: CliProviderId): string {
    return path.join(this.#options.dataDir, 'profiles', cli);
  }

  async #record(id: string): Promise<ProfileRecord> {
    const record = await this.#store.profiles.get(id);
    if (!record) throw new AccountError(404, 'not-found', `no profile ${id}`);
    return record;
  }

  /** The record of a profile id (a session's), `null` when it is gone. */
  async find(id: string): Promise<ProfileRecord | null> {
    return this.#store.profiles.get(id);
  }

  /** Adds a profile last in its CLI's order: its folder is created (0700) and, with `shareSettings`, filled from the Default's. */
  async create(input: { readonly cli: CliProviderId; readonly name: unknown; readonly shareSettings?: boolean }): Promise<ProfileRecord> {
    const name = cleanProfileName(input.name);
    if (name === null) throw new AccountError(422, 'invalid', 'the name must be 1-40 characters', 'name');
    if (!CLI_PROVIDERS.includes(input.cli)) throw new AccountError(422, 'invalid', 'unknown CLI', 'cli');
    const existing = await this.#store.profiles.list(input.cli);
    if (existing.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new AccountError(409, 'conflict', `${name} already exists for this CLI`, 'name');
    const id = (await import('node:crypto')).randomUUID();
    const dir = path.join(this.profilesDir(input.cli), id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const share = input.shareSettings !== false;
    const record = await this.#store.profiles.create({ id, cli: input.cli, name, dir, shareSettings: share });
    if (share) await this.syncShared(record.id).catch(() => undefined);
    return record;
  }

  /** Links the Default's settings into the profile again (after the Default changed). */
  async syncShared(id: string): Promise<{ readonly shared: readonly string[]; readonly mcp: string }> {
    const record = await this.#record(id);
    if (record.dir === null) return { shared: [], mcp: 'none' };
    const result = await shareSettings(record.cli, defaultDir(record.cli, this.#baseEnv), record.dir);
    return { shared: result.shared, mcp: result.mcp };
  }

  async update(id: string, patch: { readonly name?: unknown; readonly enabled?: unknown; readonly shareSettings?: unknown }): Promise<ProfileRecord> {
    const record = await this.#record(id);
    const next: { name?: string; enabled?: boolean; shareSettings?: boolean } = {};
    if (patch.name !== undefined) {
      const name = cleanProfileName(patch.name);
      if (name === null) throw new AccountError(422, 'invalid', 'the name must be 1-40 characters', 'name');
      if ((await this.#store.profiles.list(record.cli)).some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) throw new AccountError(409, 'conflict', `${name} already exists for this CLI`, 'name');
      next.name = name;
    }
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new AccountError(422, 'invalid', 'enabled must be true or false', 'enabled');
      next.enabled = patch.enabled;
    }
    if (patch.shareSettings !== undefined) {
      if (typeof patch.shareSettings !== 'boolean') throw new AccountError(422, 'invalid', 'shareSettings must be true or false', 'shareSettings');
      if (record.builtin) throw new AccountError(422, 'invalid', 'the Default profile is what the others share', 'shareSettings');
      next.shareSettings = patch.shareSettings;
    }
    const updated = (await this.#store.profiles.update(id, next)) ?? record;
    if (next.shareSettings === true) await this.syncShared(id).catch(() => undefined);
    return updated;
  }

  /** The new priority order of a CLI's profiles (every id must be that CLI's). */
  async reorder(cli: CliProviderId, ids: unknown): Promise<void> {
    const have = await this.#store.profiles.list(cli);
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !have.some((p) => p.id === id)) || new Set(ids).size !== ids.length) {
      throw new AccountError(422, 'invalid', 'order must list profile ids of this CLI, each once', 'order');
    }
    await this.#store.profiles.reorder(cli, ids as string[]);
  }

  /**
   * Deletes a profile (never the built-in Default, never one a live process runs
   * on). Its sessions go back to the Default. The folder is removed only with
   * `removeFiles` and only when it is inside this Switchboard's `profiles/` folder:
   * the developer's own folders are never deleted. Its login is not signed out here.
   */
  async remove(id: string, options: { readonly removeFiles?: boolean; readonly live: (profileId: string) => boolean }): Promise<void> {
    const record = await this.#record(id);
    if (record.builtin) throw new AccountError(409, 'builtin', 'the built-in Default profile cannot be deleted');
    if (options.live(id)) throw new AccountError(409, 'in-use', 'a session is running on this profile: switch it to another account first');
    this.#store.db.prepare("UPDATE sessions SET profile_id = NULL WHERE profile_id = ?").run(id);
    await this.#store.profiles.delete(id);
    this.#checks.delete(id);
    if (options.removeFiles === true && record.dir !== null && this.#inside(record.dir)) await rm(record.dir, { recursive: true, force: true });
  }

  #inside(dir: string): boolean {
    const root = path.resolve(this.#options.dataDir, 'profiles');
    const relative = path.relative(root, path.resolve(dir));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  // ── environment and folders ────────────────────────────────────────────────

  /** The environment a process of `profileId` (null = the Default) gets on top of the base: the CLI's folder variable. */
  async envFor(profileId: string | null, cli: CliProviderId): Promise<NodeJS.ProcessEnv> {
    const record = profileId ? await this.#store.profiles.get(profileId) : null;
    if (!record || record.cli !== cli || record.dir === null) return {};
    return { [PROFILE_ENV[cli]]: record.dir };
  }

  /** The folder where a profile's CLI keeps its files (Default: the base environment's / home default); `null` for OpenCode's Default. */
  async dirOf(profileId: string | null, cli: CliProviderId): Promise<string | null> {
    const record = profileId ? await this.#store.profiles.get(profileId) : null;
    if (record && record.cli === cli && record.dir !== null) return record.dir;
    return defaultDir(cli, this.#baseEnv);
  }

  /** Every Claude Code config folder Switchboard may find a transcript in: the base one, then each profile's. */
  async claudeConfigDirs(): Promise<string[]> {
    const dirs = [defaultDir('claude', this.#baseEnv) as string];
    for (const profile of await this.#store.profiles.list('claude')) if (profile.dir !== null) dirs.push(profile.dir);
    return dirs;
  }

  // ── status ──────────────────────────────────────────────────────────────────

  /** The CLI's own status for the profile (cached 60 s; `refresh` runs it again). Never reads a credential file. */
  async check(id: string, options: { readonly refresh?: boolean } = {}): Promise<{ readonly signIn: ProfileSignIn; readonly account: string | null }> {
    const cached = this.#checks.get(id);
    if (!options.refresh && cached && this.#now() - cached.at < TTL_MS) return { signIn: cached.signIn, account: cached.account };
    const record = await this.#record(id);
    const command = await this.#options.registry.command(record.cli);
    const env = { ...childEnv(this.#baseEnv), ...(await this.envFor(id, record.cli)) };
    const run = (args: readonly string[]): Promise<RunResult> =>
      runCommand(command, args, { cwd: this.#options.dataDir, env, timeoutMs: this.#options.timeoutMs ?? 20_000, maxOutputBytes: 1024 * 1024 });
    let signIn: ProfileSignIn = 'unknown';
    let account: string | null = null;
    if (record.cli === 'claude') {
      const result = await run(['auth', 'status', '--json']);
      const parsed = claudeStatus(result);
      signIn = parsed.signIn;
      account = parsed.account;
    } else if (record.cli === 'codex') {
      const result = codexSignIn(await run(['login', 'status']), env);
      signIn = result.signedIn === true ? 'signed-in' : result.signedIn === false ? 'signed-out' : 'unknown';
      account = result.account;
    } else {
      const raw = await run(['auth', 'list']);
      const result = opencodeSignIn(raw);
      // A profile's own data folder holds only its credentials: none = signed out (the Default may use environment keys).
      signIn = result.signedIn === true ? 'signed-in' : record.builtin || !succeeded(raw) ? 'unknown' : 'signed-out';
      account = result.account;
    }
    const checked = { at: this.#now(), signIn, account };
    this.#checks.set(id, checked);
    return { signIn, account };
  }

  /** Forget a profile's cached status (after a sign-in or sign-out). */
  forget(id: string): void {
    this.#checks.delete(id);
  }

  // ── usage and spent marks ───────────────────────────────────────────────────

  /** A Codex profile's own rate-limit windows, as its sessions' bridges report them. */
  recordProviderUsage(profileId: string, usage: ProviderUsage): void {
    this.#providerUsage.set(profileId, usage);
  }

  async usageOf(record: ProfileRecord): Promise<ProfileUsage | null> {
    if (record.cli === 'claude') {
      const reading = await this.#store.usage.latest(undefined, record.id);
      return reading
        ? { fiveHourPct: reading.fiveHourPct, fiveHourResetsAt: reading.fiveHourResetsAt, sevenDayPct: reading.sevenDayPct, sevenDayResetsAt: reading.sevenDayResetsAt, receivedAt: reading.receivedAt }
        : null;
    }
    const usage = this.#providerUsage.get(record.id);
    if (!usage) return null;
    const five = usage.windows.find((w) => w.minutes !== null && w.minutes <= 600) ?? null;
    const week = usage.windows.find((w) => w.minutes !== null && w.minutes > 600) ?? null;
    return { fiveHourPct: five?.pct ?? null, fiveHourResetsAt: five?.resetsAt ?? null, sevenDayPct: week?.pct ?? null, sevenDayResetsAt: week?.resetsAt ?? null, receivedAt: null };
  }

  /** Remembers that a profile is spent until its reset. */
  async markExhausted(mark: ExhaustedMark): Promise<void> {
    await this.#store.profiles.update(mark.profileId, { exhaustedUntil: mark.until, exhaustedWindow: mark.window, exhaustedText: mark.text });
  }

  async clearExhausted(profileId: string): Promise<void> {
    await this.#store.profiles.update(profileId, { exhaustedUntil: null, exhaustedWindow: null, exhaustedText: null });
  }

  /**
   * The profiles of a CLI as the switch decision sees them. Without `check` only the
   * cached sign-in statuses are used (no command runs: the footer's reads); with it every
   * enabled profile's status is read first (cached 60 s), so a profile that is signed out
   * is never picked as a target.
   */
  async snapshots(cli: CliProviderId, options: { readonly check?: boolean } = {}): Promise<ProfileSnapshot[]> {
    const out: ProfileSnapshot[] = [];
    const records = await this.#store.profiles.list(cli);
    if (options.check === true) await Promise.all(records.filter((r) => r.enabled).map((r) => this.check(r.id).catch(() => null)));
    for (const record of records) {
      const checked = this.#checks.get(record.id);
      out.push({
        id: record.id,
        name: record.name,
        enabled: record.enabled,
        position: record.position,
        signedIn: checked ? (checked.signIn === 'signed-in' ? true : checked.signIn === 'signed-out' ? false : null) : null,
        exhaustedUntil: record.exhaustedUntil,
        usage: await this.usageOf(record),
      });
    }
    return out;
  }

  /** The profile a new session of `cli` starts on (`null` = the Default / none has allowance). */
  async pick(cli: CliProviderId, options: { readonly check?: boolean } = {}): Promise<string | null> {
    const records = await this.#store.profiles.list(cli);
    // One account (the Default only): nothing to choose between, and no status command to run.
    if (records.filter((r) => r.enabled).length < 2) return pickProfileForNewSession(await this.settings(), cli, await this.snapshots(cli), this.#now());
    return pickProfileForNewSession(await this.settings(), cli, await this.snapshots(cli, options.check === false ? {} : { check: true }), this.#now());
  }

  // ── the API's view ──────────────────────────────────────────────────────────

  /** Every profile with its status (`refresh` runs each CLI's status command again). */
  async list(options: { readonly refresh?: boolean; readonly check?: boolean } = {}): Promise<AccountProfile[]> {
    const records = await this.#store.profiles.list();
    const counts = new Map<string, number>();
    for (const row of this.#store.db.prepare("SELECT COALESCE(profile_id, 'default-' || provider) AS p, COUNT(*) AS n FROM sessions WHERE closed_at IS NULL GROUP BY p").all()) {
      counts.set(String(row['p']), Number(row['n']));
    }
    const checks = options.check === false ? null : await Promise.all(records.map((record) => this.check(record.id, options.refresh === true ? { refresh: true } : {}).catch(() => ({ signIn: 'unknown' as const, account: null }))));
    const now = this.#now();
    const out: AccountProfile[] = [];
    for (const [index, record] of records.entries()) {
      const checked = checks?.[index] ?? this.#checks.get(record.id) ?? { signIn: 'unknown' as const, account: null };
      const spent = record.exhaustedUntil !== null && Date.parse(record.exhaustedUntil) > now;
      out.push({
        id: record.id,
        cli: record.cli,
        name: record.name,
        dir: record.dir,
        builtin: record.builtin,
        enabled: record.enabled,
        position: record.position,
        shareSettings: record.shareSettings,
        signIn: checked.signIn,
        account: checked.account,
        usage: await this.usageOf(record),
        exhausted: spent ? { until: record.exhaustedUntil as string, window: (record.exhaustedWindow as LimitWindow | null) ?? 'unknown', text: record.exhaustedText } : null,
        signInCommand: signInCommand(record),
        sessions: counts.get(record.id) ?? 0,
      });
    }
    return out;
  }
}

/** `claude auth status --json`: `{loggedIn, email?, subscriptionType?}`; the exit code when the JSON cannot be read. */
export function claudeStatus(result: RunResult): { readonly signIn: ProfileSignIn; readonly account: string | null } {
  try {
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof json['loggedIn'] === 'boolean') {
      const parts = [json['email'], json['subscriptionType']].filter((x): x is string => typeof x === 'string' && x !== '');
      return { signIn: json['loggedIn'] ? 'signed-in' : 'signed-out', account: parts.length > 0 ? parts.join(' · ') : null };
    }
  } catch {
    // Not JSON: the exit code decides, as it always did.
  }
  const fallback = claudeSignIn(result);
  return { signIn: result.error ? 'unknown' : fallback.signedIn ? 'signed-in' : 'signed-out', account: null };
}

/** The terminal command that signs a profile in by hand. */
export function signInCommand(record: Pick<ProfileRecord, 'cli' | 'dir'>): string {
  const env = record.dir === null ? '' : `${PROFILE_ENV[record.cli]}=${quote(record.dir)} `;
  const command = record.cli === 'claude' ? 'claude auth login --claudeai' : record.cli === 'codex' ? 'codex login' : 'opencode auth login';
  return `${env}${command}`;
}

export { defaultProfileId };
