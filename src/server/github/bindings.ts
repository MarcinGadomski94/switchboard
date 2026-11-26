import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  GITHUB_LOGIN_TIMEOUT_MS,
  type GitHubBindingView,
  type GitHubIdentity,
  type GitHubLoginState,
  boundEnv,
  commitAuthor,
  parseDeviceLogin,
  readCommitEmail,
  readGitHubIdentity,
  withoutGhTokens,
} from '../../core/github-binding.ts';
import type { ProfileScope } from '../../core/user-profiles.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import type { HubBus } from '../hub/bus.ts';
import { failureText, runCommand, succeeded } from '../exec.ts';
import type { UserProfileService } from '../user-profiles/service.ts';

/** D190: the error of a GitHub binding route (`status`, `code`, a plain message). */
export class GitHubBindingError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** D190: the settings key of this computer's sign-in records: `{ <profile id>: { clock, signedIn } }` (never a token). */
export const GITHUB_SIGN_INS_SETTING = 'github.signIns';

/**
 * D190 · one profile's sign-in as it travels to a paired computer (`POST /peer/v1/github`): the
 * profile's peer-link id, a clock (the later one wins), and the token (`null` = signed out: every
 * computer logs out). The token crosses only this route of the authenticated peer link, only to a
 * computer the profile may use; it is never stored by Switchboard (gh keeps it) nor logged.
 */
export interface GitHubSignInWire {
  readonly profile: string;
  readonly clock: string;
  readonly token: string | null;
}

/** A sign-in record of this computer (what {@link GITHUB_SIGN_INS_SETTING} holds per profile). */
interface SignInRecord {
  readonly clock: string;
  readonly signedIn: boolean;
}

/** A token as gh hands it out (`gho_…`, `ghp_…`, `github_pat_…`): letters, digits, `_`, 10–255 characters. */
const TOKEN = /^[A-Za-z0-9_]{10,255}$/;
const LINK_ID = /^[A-Za-z0-9-]{1,64}$/;

/** D190: reads a peer's sign-in records (malformed ones left out; at most 200). */
export function readGitHubSignIns(value: unknown): GitHubSignInWire[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v['v'] !== 1 || !Array.isArray(v['signIns'])) return null;
  const out: GitHubSignInWire[] = [];
  for (const raw of v['signIns'].slice(0, 200)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const profile = r['profile'];
    const clock = r['clock'];
    const token = r['token'];
    if (typeof profile !== 'string' || !LINK_ID.test(profile) || typeof clock !== 'string' || clock.length === 0 || clock.length > 80) continue;
    if (token !== null && (typeof token !== 'string' || !TOKEN.test(token))) continue;
    out.push({ profile, clock, token: token as string | null });
  }
  return out;
}

/** Hides `secret` in a text that may be shown (an error, a log line). */
function redact(text: string, secret: string | null): string {
  return secret ? text.split(secret).join('[token]') : text;
}

/** Options of {@link GitHubBindings}. */
export interface GitHubBindingsOptions {
  readonly store: Store;
  readonly profiles: UserProfileService;
  /** Switchboard's data folder (`<dataDir>/github/<profile id>/` holds each profile's gh config). */
  readonly dataDir: string;
  /** `SWITCHBOARD_GH_BIN` as an argv prefix. */
  readonly gh: readonly string[];
  /** Base environment of gh (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** The hub: a profile change cleans up deleted profiles' sign-ins and offers the sign-ins again. */
  readonly bus?: HubBus;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/**
 * D190 (`docs/profiles.md` → *A profile's GitHub account*): a profile bound to a GitHub account.
 * Settings connects it with gh's device-code login, in the profile's own gh folder; its agents, their
 * terminals and Switchboard's own `gh` calls for them then run as that account (`GH_CONFIG_DIR`),
 * commit as it and push through gh's credential helper ({@link boundEnv}). The developer's ruling
 * (2026-11-26): the sign-in syncs to the paired computers the profile may use — connect once, works
 * everywhere ({@link wire} / {@link merge}, the peer route `POST /peer/v1/github`).
 */
export class GitHubBindings {
  readonly #o: GitHubBindingsOptions;
  readonly #now: () => number;
  /** The gh argv, a relative path made absolute (gh runs from the data folder, git's credential helper from the agent's). */
  readonly #ghArgv: readonly string[];
  /** A sign-in in progress (or just ended) per profile. */
  readonly #logins = new Map<string, LoginEntry>();
  /** gh's answer to "signed in?" per profile, for a minute (agents spawn often). */
  readonly #signedIn = new Map<string, { readonly value: boolean; readonly at: number }>();
  /** One change at a time per profile (connect's end, disconnect, a peer's record, a clean-up). */
  readonly #locks = new Map<string, Promise<unknown>>();
  #records: Record<string, SignInRecord> | null = null;
  #sequence = 0;
  readonly #listeners = new Set<() => void>();
  #unsynced: () => readonly string[] = () => [];
  #offBus: (() => void) | null = null;
  #resync: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(options: GitHubBindingsOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#ghArgv = options.gh.map((word) => (/[\\/]/.test(word) && !path.isAbsolute(word) ? path.resolve(word) : word));
    // A profile change (here or from a paired computer): clean up what a deleted / merged-away profile
    // left, and offer the sign-ins again (a profile, or its access, that was not there before may be now).
    this.#offBus =
      options.bus?.subscribe((message) => {
        if (message.name !== 'userProfilesChanged' || this.#closed) return;
        if (this.#resync) clearTimeout(this.#resync);
        this.#resync = setTimeout(() => {
          this.#resync = null;
          void this.#afterProfilesChanged().catch((error: unknown) => this.#o.onError?.(error));
        }, 300);
        this.#resync.unref();
      }) ?? null;
  }

  /** The gh config folder of profile `id` on this computer. */
  dirOf(id: string): string {
    return path.join(this.#o.dataDir, 'github', id.replace(/[^A-Za-z0-9-]/g, '_'));
  }

  /** gh's environment for profile `id`: its folder decides (gh's token / host variables removed). */
  #ghEnv(id: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return withoutGhTokens({ ...(this.#o.env ?? process.env), GH_CONFIG_DIR: this.dirOf(id), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', ...extra });
  }

  #gh(id: string, args: readonly string[], options: { readonly input?: string; readonly timeoutMs?: number } = {}) {
    return runCommand(this.#ghArgv, args, {
      cwd: this.#o.dataDir,
      env: this.#ghEnv(id),
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
  }

  /** Runs `task` after every earlier change of profile `id` (never two at once for one profile). */
  #serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(id) ?? Promise.resolve();
    const run = before.then(task, task);
    const tail = run.catch(() => undefined);
    this.#locks.set(id, tail);
    void tail.then(() => {
      if (this.#locks.get(id) === tail) this.#locks.delete(id);
    });
    return run;
  }

  /** Makes the profile's folder (0700; an existing one is tightened on Unix, Windows inherits the data folder's ACL). */
  async #makeDir(id: string): Promise<string> {
    const dir = this.dirOf(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(dir, 0o700);
    return dir;
  }

  /** D190: the paired computers that do not take a shared sign-in (set by the app from the peer service). */
  useUnsynced(list: () => readonly string[]): void {
    this.#unsynced = list;
  }

  /** Calls `listener` when a sign-in here changed, or the profiles did (the peer service shares them). */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  async #loadRecords(): Promise<Record<string, SignInRecord>> {
    if (this.#records) return this.#records;
    const stored = await this.#o.store.settings.get(GITHUB_SIGN_INS_SETTING);
    const out: Record<string, SignInRecord> = {};
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [id, value] of Object.entries(stored as Record<string, unknown>)) {
        const v = value as { clock?: unknown; signedIn?: unknown } | null;
        if (v && typeof v.clock === 'string') out[id] = { clock: v.clock, signedIn: v.signedIn === true };
      }
    }
    this.#records = out;
    return out;
  }

  async #saveRecord(id: string, record: SignInRecord): Promise<void> {
    const records = { ...(await this.#loadRecords()), [id]: record };
    this.#records = records;
    await this.#o.store.settings.set(GITHUB_SIGN_INS_SETTING, records);
  }

  async #clockOf(id: string): Promise<string | null> {
    return (await this.#loadRecords())[id]?.clock ?? null;
  }

  /** A clock later than every one seen (ms, then a sequence, then this computer). */
  #clock(after: string | null): string {
    const self = this.#o.profiles.selfMachineId() ?? 'local';
    let next = `${String(this.#now()).padStart(15, '0')}.${String((this.#sequence += 1)).padStart(6, '0')}.${self}`;
    if (after && next <= after) next = `${after.split('.')[0]}.${String(Number(after.split('.')[1] ?? 0) + 1).padStart(6, '0')}.${self}`;
    return next;
  }

  /** Whether gh is signed in for profile `id` on this computer (gh asked at most once a minute). */
  async signedInHere(id: string): Promise<boolean> {
    const cached = this.#signedIn.get(id);
    if (cached && this.#now() - cached.at < 60_000) return cached.value;
    const exists = await stat(this.dirOf(id)).then(() => true, () => false);
    const value = exists && succeeded(await this.#gh(id, ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000 }));
    this.#signedIn.set(id, { value, at: this.#now() });
    return value;
  }

  /** `GET /api/user-profiles/{id}/github`. */
  async view(id: string): Promise<GitHubBindingView> {
    const record = await this.#o.profiles.get(id);
    if (!record) throw new GitHubBindingError(404, 'not-found', `no profile ${id}`);
    const identity = record.github;
    return { identity, author: identity ? commitAuthor(identity) : null, signedInHere: identity ? await this.signedInHere(id) : false, login: this.#logins.get(id)?.state ?? null, ...(identity ? { unsynced: this.#unsynced() } : {}) };
  }

  /**
   * `POST /api/user-profiles/{id}/github/connect { password?, email? }`: starts gh's device-code login
   * in the profile's folder; the code and the page come back in {@link view} (`login`).
   */
  async connect(id: string, body: unknown, actor: ProfileScope): Promise<GitHubBindingView> {
    const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    await this.#authorize(id, actor, input['password']);
    const current = this.#logins.get(id);
    if (current && (current.state.state === 'starting' || current.state.state === 'waiting')) return this.view(id);
    const email = input['email'] === undefined || input['email'] === null || input['email'] === '' ? null : readCommitEmail(input['email']);
    if (input['email'] && !email) throw new GitHubBindingError(422, 'invalid', 'That email doesn’t look right.');
    const [cmd, ...prefix] = this.#ghArgv;
    if (!cmd) throw new GitHubBindingError(500, 'no-gh', 'The GitHub CLI (gh) is not set up on this computer.');
    await this.#serial(id, () => this.#makeDir(id));
    const entry: LoginEntry = { state: { state: 'starting', code: null, url: null, error: null }, child: null, timer: null, output: '' };
    this.#logins.set(id, entry);
    // `--insecure-storage`: the token stays in this profile's own folder (0700), never in the system keyring, where
    // gh keys it by account: the same account as this computer's own gh would overwrite (and a sign-out remove) that one.
    const child = spawn(cmd, [...prefix, 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key', '--insecure-storage'], {
      cwd: this.#o.dataDir,
      // `BROWSER`: gh prints the page instead of opening it (Settings shows it with the code).
      env: this.#ghEnv(id, { BROWSER: 'true', GH_BROWSER: 'true' }),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    entry.child = child;
    child.stdin?.on('error', () => undefined);
    // gh may wait for Enter before it opens the page: give it one.
    child.stdin?.end('\n');
    const read = (chunk: Buffer): void => {
      entry.output = `${entry.output}${chunk.toString('utf8')}`.slice(-8_000);
      const parsed = parseDeviceLogin(entry.output);
      if (parsed.code && entry.state.state === 'starting') entry.state = { state: 'waiting', code: parsed.code, url: parsed.url ?? 'https://github.com/login/device', error: null };
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    entry.timer = setTimeout(() => {
      entry.state = { ...entry.state, state: 'failed', error: 'The code expired before it was entered. Try again.' };
      child.kill();
    }, GITHUB_LOGIN_TIMEOUT_MS);
    entry.timer.unref();
    child.once('error', (error) => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.state = { ...entry.state, state: 'failed', error: `gh could not start: ${error.message}` };
    });
    child.once('close', (code) => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.child = null;
      if (entry.state.state === 'cancelled' || entry.state.state === 'failed') return;
      if (code !== 0) {
        const last = entry.output.trim().split('\n').filter(Boolean).slice(-1)[0] ?? `gh ended with code ${String(code)}`;
        entry.state = { ...entry.state, state: 'failed', error: last.slice(0, 300) };
        return;
      }
      void this.#serial(id, () => this.#finishLogin(id, entry, email)).then(
        (finished) => {
          if (finished) entry.state = { ...entry.state, state: 'done', error: null };
        },
        (error: unknown) => {
          entry.state = { ...entry.state, state: 'failed', error: error instanceof Error ? error.message : String(error) };
        },
      );
    });
    return this.view(id);
  }

  /**
   * After a successful sign-in (one change of the profile at a time): who it is (`gh api user`), the
   * binding on the profile (synced), and the sign-in shared. A sign-in cancelled meanwhile (Disconnect,
   * Cancel) is dropped: its folder removed. Answers whether it took.
   */
  async #finishLogin(id: string, entry: LoginEntry, email: string | null): Promise<boolean> {
    if (this.#logins.get(id) !== entry || entry.state.state === 'cancelled') {
      await this.#signOutHere(id);
      return false;
    }
    const identity = await this.#identity(id, email);
    this.#signedIn.set(id, { value: true, at: this.#now() });
    await this.#o.profiles.setGitHub(id, identity);
    await this.#saveRecord(id, { clock: this.#clock(await this.#clockOf(id)), signedIn: true });
    this.#changed();
    return true;
  }

  async #identity(id: string, email: string | null): Promise<GitHubIdentity> {
    const result = await this.#gh(id, ['api', 'user']);
    if (!succeeded(result)) throw new GitHubBindingError(502, 'gh-failed', `Signed in, but gh could not read the account: ${failureText(result)}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = null;
    }
    const identity = readGitHubIdentity({ ...(parsed as object), email });
    if (!identity) throw new GitHubBindingError(502, 'gh-failed', 'Signed in, but gh answered an account Switchboard can’t read.');
    return identity;
  }

  /** Stops profile `id`'s sign-in in progress, if any. */
  #cancelLogin(id: string): void {
    const entry = this.#logins.get(id);
    if (entry && (entry.state.state === 'starting' || entry.state.state === 'waiting')) {
      entry.state = { ...entry.state, state: 'cancelled' };
      if (entry.timer) clearTimeout(entry.timer);
      entry.child?.kill();
    }
  }

  /** `POST /api/user-profiles/{id}/github/cancel`: stops a sign-in in progress. */
  async cancel(id: string, actor: ProfileScope, password: unknown): Promise<GitHubBindingView> {
    await this.#authorize(id, actor, password);
    this.#cancelLogin(id);
    return this.view(id);
  }

  /** `PUT /api/user-profiles/{id}/github/email { email | null, password? }`: the commit email (null = the noreply). */
  async setEmail(id: string, body: unknown, actor: ProfileScope): Promise<GitHubBindingView> {
    const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const record = await this.#authorize(id, actor, input['password']);
    if (!record.github) throw new GitHubBindingError(409, 'not-bound', 'Connect a GitHub account first.');
    const email = input['email'] === null || input['email'] === '' ? null : readCommitEmail(input['email']);
    if (input['email'] && !email) throw new GitHubBindingError(422, 'invalid', 'That email doesn’t look right.');
    await this.#o.profiles.setGitHub(id, { ...record.github, email });
    return this.view(id);
  }

  /**
   * `POST /api/user-profiles/{id}/github/disconnect { password? }`: stops a sign-in in progress, signs
   * the profile out here (its folder removed), unbinds it (synced) and tells every paired computer to
   * sign out too (a tombstone record with a later clock). After any change of the profile in progress.
   */
  async disconnect(id: string, actor: ProfileScope, password: unknown): Promise<GitHubBindingView> {
    await this.#authorize(id, actor, password);
    this.#cancelLogin(id);
    await this.#serial(id, async () => {
      await this.#signOutHere(id);
      await this.#o.profiles.setGitHub(id, null);
      await this.#saveRecord(id, { clock: this.#clock(await this.#clockOf(id)), signedIn: false });
    });
    this.#changed();
    return this.view(id);
  }

  /**
   * Signs gh out for the profile here: removes its folder (the token lives only there, `--insecure-storage`).
   * Not `gh auth logout`: gh also deletes the account's system-keyring entry, which is this computer's own gh
   * sign-in when it is the same account.
   */
  async #signOutHere(id: string): Promise<void> {
    await rm(this.dirOf(id), { recursive: true, force: true });
    this.#signedIn.set(id, { value: false, at: this.#now() });
  }

  async #authorize(id: string, actor: ProfileScope, password: unknown) {
    try {
      return await this.#o.profiles.authorizeGitHub(id, actor, password);
    } catch (error) {
      const e = error as { status?: number; code?: string; message?: string };
      throw new GitHubBindingError(e.status ?? 500, e.code ?? 'error', e.message ?? String(error));
    }
  }

  /**
   * After the profiles changed: a profile deleted or merged away leaves no sign-in (its folder removed,
   * a tombstone kept so no computer offers it again), and the sign-ins are offered again to the paired
   * computers (a profile, or its computer access, that was not there at the last exchange may be now).
   */
  async #afterProfilesChanged(): Promise<void> {
    for (const [id, record] of Object.entries(await this.#loadRecords())) {
      if (await this.#o.profiles.get(id)) continue;
      await this.#serial(id, async () => {
        const now = (await this.#loadRecords())[id];
        if (!now || (await this.#o.profiles.get(id))) return;
        await this.#signOutHere(id);
        if (now.signedIn || record.signedIn) await this.#saveRecord(id, { clock: this.#clock(now.clock), signedIn: false });
      });
    }
    this.#changed();
  }

  // ── the environment of a bound profile's agents and of Switchboard's gh calls for them ──

  /** The environment of profile `id`'s agents here: {@link boundEnv} when it is bound and signed in here, else none. */
  async envForProfile(id: string): Promise<Record<string, string>> {
    const record = await this.#o.profiles.get(id);
    if (!record?.github) return {};
    if (!(await this.signedInHere(id))) return {};
    return boundEnv(record.github, this.dirOf(id), this.#ghArgv);
  }

  /** The environment of session `session`'s agent (its profile's binding). */
  envForSession(session: Pick<SessionRecord, 'id' | 'userProfileId'>): Promise<Record<string, string>> {
    // The record's own profile first: a new agent is not in the profiles' index until its first update.
    return this.envForProfile(session.userProfileId ?? this.#o.profiles.profileOfSession(session.id));
  }

  /**
   * The `gh` environment of a call Switchboard makes for agent `sessionId` (PR status, CI, merge,
   * plan PRs, Import issues): its profile's folder when bound and signed in here, else none (the
   * computer's own gh). Only that agent's profile: never another one's working in the same folder.
   */
  async ghEnvForSession(sessionId: string): Promise<Record<string, string>> {
    const record = await this.#o.store.sessions.get(sessionId).catch(() => null);
    const env = await this.envForProfile(record?.userProfileId ?? this.#o.profiles.profileOfSession(sessionId));
    return env['GH_CONFIG_DIR'] ? { GH_CONFIG_DIR: env['GH_CONFIG_DIR'] } : {};
  }

  // ── D190 · the sign-in shared with the paired computers the profile may use ──

  /**
   * What this computer sends to paired computer `machineId`: every profile it has a sign-in record
   * for that may use that computer (D173), its clock, and — when signed in here — the token gh holds
   * in the profile's folder (read now, in memory only; gh's token variables never apply).
   */
  async wire(machineId: string): Promise<{ readonly v: 1; readonly signIns: GitHubSignInWire[] }> {
    const out: GitHubSignInWire[] = [];
    for (const [id, record] of Object.entries(await this.#loadRecords())) {
      if (!(await this.#o.profiles.get(id))) continue;
      if (!this.#o.profiles.allowedOn(id, machineId)) continue;
      let token: string | null = null;
      if (record.signedIn) {
        if (!(await stat(this.dirOf(id)).then(() => true, () => false))) continue;
        const result = await this.#gh(id, ['auth', 'token', '--hostname', 'github.com'], { timeoutMs: 15_000 });
        const value = result.stdout.trim();
        if (!succeeded(result) || !TOKEN.test(value)) continue;
        token = value;
      }
      out.push({ profile: this.#o.profiles.linkIdOf(id), clock: record.clock, token });
    }
    return { v: 1, signIns: out };
  }

  /**
   * Merges a paired computer's sign-in records, one change of a profile at a time: a later clock wins;
   * a token is imported into the profile's folder (`gh auth login --with-token`, the token on stdin)
   * and checked (`gh api user`: the profile's bound account, by its numeric id); none signs gh out here.
   * A record that is no longer the latest once gh is done (a Disconnect meanwhile) is dropped.
   * Answers how many changed here (to relay them).
   */
  async merge(fromMachine: string, signIns: readonly GitHubSignInWire[]): Promise<number> {
    let changed = 0;
    for (const signIn of signIns) {
      const id = this.#o.profiles.fromRemote(fromMachine, signIn.profile);
      const took = await this.#serial(id, () => this.#mergeOne(id, fromMachine, signIn));
      if (took) changed += 1;
    }
    return changed;
  }

  async #mergeOne(id: string, fromMachine: string, signIn: GitHubSignInWire): Promise<boolean> {
    const record = await this.#o.profiles.get(id);
    if (!record) return false;
    // Only a profile that may use this computer takes a sign-in here.
    if (!this.#o.profiles.allowedHere(id)) return false;
    const mine = await this.#clockOf(id);
    if (mine !== null && mine >= signIn.clock) return false;
    try {
      if (signIn.token === null) {
        await this.#signOutHere(id);
        await this.#saveRecord(id, { clock: signIn.clock, signedIn: false });
        return true;
      }
      // Only into a profile bound to an account here (the binding travels with the profile first).
      if (!record.github) return false;
      await this.#makeDir(id);
      const login = await this.#gh(id, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--insecure-storage', '--with-token'], { input: `${signIn.token}\n`, timeoutMs: 30_000 });
      if (!succeeded(login)) throw new Error(`gh could not take the sign-in: ${redact(failureText(login), signIn.token)}`);
      const user = await this.#gh(id, ['api', 'user']);
      let who: GitHubIdentity | null = null;
      try {
        who = succeeded(user) ? readGitHubIdentity({ ...(JSON.parse(user.stdout) as object), email: null }) : null;
      } catch {
        who = null;
      }
      const bound = (await this.#o.profiles.get(id))?.github ?? null;
      if (!who || !bound || bound.id !== who.id) {
        await this.#signOutHere(id);
        throw new Error('the shared sign-in is not the profile’s GitHub account');
      }
      // Still the latest record? (Nothing else changes this profile meanwhile; checked anyway.)
      const now = await this.#clockOf(id);
      if (now !== null && now >= signIn.clock) {
        await this.#signOutHere(id);
        return false;
      }
      this.#signedIn.set(id, { value: true, at: this.#now() });
      await this.#saveRecord(id, { clock: signIn.clock, signedIn: true });
      return true;
    } catch (error) {
      this.#o.onError?.(new Error(`GitHub sign-in of ${record.name} from ${fromMachine}: ${redact(error instanceof Error ? error.message : String(error), signIn.token)}`));
      return false;
    }
  }

  /** Stops sign-ins in progress and the profile watch (the app closes). */
  close(): void {
    this.#closed = true;
    this.#offBus?.();
    if (this.#resync) clearTimeout(this.#resync);
    for (const entry of this.#logins.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.child?.kill();
    }
  }
}

/** A sign-in started from Settings. */
interface LoginEntry {
  state: GitHubLoginState;
  child: ChildProcess | null;
  timer: NodeJS.Timeout | null;
  output: string;
}
