import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, realpath, rm, stat } from 'node:fs/promises';
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
} from '../../core/github-binding.ts';
import type { ProfileScope } from '../../core/user-profiles.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
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

/** A path compared the platform's way (case-insensitive on Windows). */
function samePathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Whether `inner` is `outer` or inside it. */
function within(outer: string, inner: string): boolean {
  const a = samePathKey(outer);
  const b = samePathKey(inner);
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : `${a}${path.sep}`);
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
  /** A sign-in in progress (or just ended) per profile. */
  readonly #logins = new Map<string, { state: GitHubLoginState; child: ChildProcess | null; timer: NodeJS.Timeout | null; output: string }>();
  /** gh's answer to "signed in?" per profile, for a minute (agents spawn often). */
  readonly #signedIn = new Map<string, { readonly value: boolean; readonly at: number }>();
  #records: Record<string, SignInRecord> | null = null;
  #sequence = 0;
  readonly #listeners = new Set<() => void>();

  constructor(options: GitHubBindingsOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  /** The gh config folder of profile `id` on this computer. */
  dirOf(id: string): string {
    return path.join(this.#o.dataDir, 'github', id.replace(/[^A-Za-z0-9-]/g, '_'));
  }

  #gh(id: string, args: readonly string[], options: { readonly input?: string; readonly timeoutMs?: number } = {}) {
    return runCommand(this.#o.gh, args, {
      cwd: this.#o.dataDir,
      env: { ...(this.#o.env ?? process.env), GH_CONFIG_DIR: this.dirOf(id), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
  }

  #unsynced: () => readonly string[] = () => [];

  /** D190: the paired computers that do not take a shared sign-in (set by the app from the peer service). */
  useUnsynced(list: () => readonly string[]): void {
    this.#unsynced = list;
  }

  /** Calls `listener` when a sign-in here changed (the peer service shares it). */
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
    const dir = this.dirOf(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const [cmd, ...prefix] = this.#o.gh;
    if (!cmd) throw new GitHubBindingError(500, 'no-gh', 'The GitHub CLI (gh) is not set up on this computer.');
    const entry: { state: GitHubLoginState; child: ChildProcess | null; timer: NodeJS.Timeout | null; output: string } = { state: { state: 'starting', code: null, url: null, error: null }, child: null, timer: null, output: '' };
    this.#logins.set(id, entry);
    // `--insecure-storage`: the token stays in this profile's own folder (0700), never in the system keyring, where
    // gh keys it by account: the same account as this computer's own gh would overwrite (and a sign-out remove) that one.
    const child = spawn(cmd, [...prefix, 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key', '--insecure-storage'], {
      cwd: this.#o.dataDir,
      // `BROWSER`: gh prints the page instead of opening it (Settings shows it with the code).
      env: { ...(this.#o.env ?? process.env), GH_CONFIG_DIR: dir, GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', BROWSER: 'true', GH_BROWSER: 'true' },
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
      void this.#finishLogin(id, email).then(
        () => {
          entry.state = { ...entry.state, state: 'done', error: null };
        },
        (error: unknown) => {
          entry.state = { ...entry.state, state: 'failed', error: error instanceof Error ? error.message : String(error) };
        },
      );
    });
    return this.view(id);
  }

  /** After a successful sign-in: who it is (`gh api user`), the binding on the profile (synced), and the sign-in shared. */
  async #finishLogin(id: string, email: string | null): Promise<void> {
    const identity = await this.#identity(id, email);
    this.#signedIn.set(id, { value: true, at: this.#now() });
    await this.#o.profiles.setGitHub(id, identity);
    const before = (await this.#loadRecords())[id]?.clock ?? null;
    await this.#saveRecord(id, { clock: this.#clock(before), signedIn: true });
    this.#changed();
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

  /** `POST /api/user-profiles/{id}/github/cancel`: stops a sign-in in progress. */
  async cancel(id: string, actor: ProfileScope, password: unknown): Promise<GitHubBindingView> {
    await this.#authorize(id, actor, password);
    const entry = this.#logins.get(id);
    if (entry && (entry.state.state === 'starting' || entry.state.state === 'waiting')) {
      entry.state = { ...entry.state, state: 'cancelled' };
      if (entry.timer) clearTimeout(entry.timer);
      entry.child?.kill();
    }
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
   * `POST /api/user-profiles/{id}/github/disconnect { password? }`: signs gh out of the profile's folder
   * here, removes it, unbinds the profile (synced) and tells every paired computer to sign out too.
   */
  async disconnect(id: string, actor: ProfileScope, password: unknown): Promise<GitHubBindingView> {
    await this.#authorize(id, actor, password);
    await this.#signOutHere(id);
    await this.#o.profiles.setGitHub(id, null);
    const before = (await this.#loadRecords())[id]?.clock ?? null;
    await this.#saveRecord(id, { clock: this.#clock(before), signedIn: false });
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

  // ── the environment of a bound profile's agents and of Switchboard's gh calls for them ──

  /** The environment of profile `id`'s agents here: {@link boundEnv} when it is bound and signed in here, else none. */
  async envForProfile(id: string): Promise<Record<string, string>> {
    const record = await this.#o.profiles.get(id);
    if (!record?.github) return {};
    if (!(await this.signedInHere(id))) return {};
    return boundEnv(record.github, this.dirOf(id), this.#o.gh);
  }

  /** The environment of session `session`'s agent (its profile's binding). */
  envForSession(session: Pick<SessionRecord, 'id' | 'userProfileId'>): Promise<Record<string, string>> {
    return this.envForProfile(this.#o.profiles.profileOfSession(session.id));
  }

  /**
   * The `gh` environment for a call Switchboard makes in folder `cwd` (PR status, merge, plan PRs):
   * the profile of the open session working there (its folder, root or a worktree under it), when
   * exactly one bound profile works there; else none (the computer's own gh).
   */
  async ghEnvForPath(cwd: string): Promise<Record<string, string>> {
    let real = cwd;
    try {
      real = await realpath(cwd);
    } catch {
      // A folder that is gone: compared as given.
    }
    const sessions = await this.#o.store.sessions.list({ closed: false }).catch(() => [] as SessionRecord[]);
    const profiles = new Set<string>();
    for (const session of sessions) {
      const places = [session.cwd, session.root].filter((p): p is string => typeof p === 'string' && p !== '');
      if (places.some((place) => within(place, real) || within(real, place))) profiles.add(this.#o.profiles.profileOfSession(session.id));
    }
    const bound: string[] = [];
    for (const id of profiles) if ((await this.#o.profiles.get(id))?.github) bound.push(id);
    if (bound.length !== 1) return {};
    const env = await this.envForProfile(bound[0] as string);
    return env['GH_CONFIG_DIR'] ? { GH_CONFIG_DIR: env['GH_CONFIG_DIR'] } : {};
  }

  // ── D190 · the sign-in shared with the paired computers the profile may use ──

  /**
   * What this computer sends to paired computer `machineId`: every profile it has a sign-in record
   * for that may use that computer (D173), its clock, and — when signed in here — the token gh holds
   * (read now, in memory only).
   */
  async wire(machineId: string): Promise<{ readonly v: 1; readonly signIns: GitHubSignInWire[] }> {
    const out: GitHubSignInWire[] = [];
    for (const [id, record] of Object.entries(await this.#loadRecords())) {
      if (!(await this.#o.profiles.get(id))) continue;
      if (!this.#o.profiles.allowedOn(id, machineId)) continue;
      let token: string | null = null;
      if (record.signedIn) {
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
   * Merges a paired computer's sign-in records: a later clock wins; a token is imported into the
   * profile's folder (`gh auth login --with-token`, the token on stdin) and checked (`gh api user`);
   * none signs gh out here. Answers how many changed here (to relay them).
   */
  async merge(fromMachine: string, signIns: readonly GitHubSignInWire[]): Promise<number> {
    let changed = 0;
    for (const signIn of signIns) {
      const id = this.#o.profiles.fromRemote(fromMachine, signIn.profile);
      const record = await this.#o.profiles.get(id);
      if (!record) continue;
      // Only a profile that may use this computer takes a sign-in here.
      if (!this.#o.profiles.allowedHere(id)) continue;
      const mine = (await this.#loadRecords())[id];
      if (mine && mine.clock >= signIn.clock) continue;
      try {
        if (signIn.token === null) {
          await this.#signOutHere(id);
          await this.#saveRecord(id, { clock: signIn.clock, signedIn: false });
        } else {
          await mkdir(this.dirOf(id), { recursive: true, mode: 0o700 });
          const login = await this.#gh(id, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--insecure-storage', '--with-token'], { input: `${signIn.token}\n`, timeoutMs: 30_000 });
          if (!succeeded(login)) throw new Error(`gh could not take the sign-in: ${redact(failureText(login), signIn.token)}`);
          const user = await this.#gh(id, ['api', 'user']);
          const who = succeeded(user) ? readGitHubIdentity({ ...(JSON.parse(user.stdout) as object), email: null }) : null;
          if (!who || (record.github && record.github.login.toLowerCase() !== who.login.toLowerCase())) {
            await this.#signOutHere(id);
            throw new Error('the shared sign-in is not the profile’s GitHub account');
          }
          this.#signedIn.set(id, { value: true, at: this.#now() });
          await this.#saveRecord(id, { clock: signIn.clock, signedIn: true });
        }
        changed += 1;
      } catch (error) {
        this.#o.onError?.(new Error(`GitHub sign-in of ${record.name} from ${fromMachine}: ${redact(error instanceof Error ? error.message : String(error), signIn.token)}`));
      }
    }
    return changed;
  }

  /** Stops sign-ins in progress (the app closes). */
  close(): void {
    for (const entry of this.#logins.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.child?.kill();
    }
  }
}
