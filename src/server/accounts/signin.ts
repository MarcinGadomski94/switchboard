import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import type { CliProviderId } from '../../core/cli-providers.ts';
import type { CliRegistry } from '../cli/registry.ts';
import { freePort } from '../cli/opencode/bridge.ts';
import { registerServer, serverSpawnOptions, signalServer, unregisterServer } from '../cli/reaper.ts';
import { runCommand } from '../exec.ts';
import { childEnv } from '../supervisor/argv.ts';
import { AccountError, type AccountService, signInCommand } from './service.ts';

/** Where a sign-in is. */
export type SignInPhase = 'starting' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'timeout';

/** One sign-in (`POST /api/accounts/profiles/{id}/signin`, `GET /api/accounts/signin/{id}`). */
export interface SignInState {
  readonly id: string;
  readonly profileId: string;
  readonly cli: CliProviderId;
  readonly state: SignInPhase;
  /** The page to sign in on (open it in a new tab), once the CLI printed it. */
  readonly url: string | null;
  /** A device code to type on that page (Codex `--device-auth`). */
  readonly code: string | null;
  /** What the CLI said to do (OpenCode's instructions), when it said. */
  readonly instructions: string | null;
  readonly error: string | null;
  /** The terminal command that does the same by hand ("Copy terminal command"). */
  readonly command: string;
  /** The final redirect URL (or a code) can be pasted back (a browser on another machine). */
  readonly canPasteBack: boolean;
  readonly startedAt: string;
  readonly expiresAt: string;
}

/** What the sign-in form can set. */
export interface SignInOptions {
  /** Claude Code: `--email`. */
  readonly email?: string;
  /** Codex: `--device-auth`. */
  readonly deviceCode?: boolean;
  /** OpenCode: the provider id (`anthropic`, `openai`, …). */
  readonly provider?: string;
  /** OpenCode: an API key for a provider that uses keys (sent to the profile's local server only, never kept or logged). */
  readonly apiKey?: string;
}

export interface SignInManagerOptions {
  readonly accounts: AccountService;
  readonly registry: CliRegistry;
  readonly dataDir: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Time to finish a sign-in (default 5 min). */
  readonly timeoutMs?: number;
  /** Status poll gap (default 2 s). */
  readonly pollMs?: number;
  /** Called with a profile id whenever its sign-in status may have changed. */
  readonly onChanged?: (profileId: string) => void;
}

interface Flow {
  state: SignInState;
  child: ChildProcess | null;
  /** OpenCode: the profile's own server and what to answer it. */
  oc: { readonly base: string; readonly auth: string; readonly provider: string; readonly method: number; readonly kind: 'auto' | 'code' } | null;
  finishedAt: number | null;
  wasSignedIn: boolean;
  output: string;
  stop: () => void;
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

/** The first page in the CLI's output that is not its own local callback server (`http://localhost:1455.`), without trailing punctuation. */
function firstPageUrl(text: string): string | null {
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:!?]+$/, '');
    if (!isLoopbackUrl(url)) return url;
  }
  return null;
}
const DEVICE_CODE_RE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/;
const KEEP_MS = 10 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** `true` for a loopback http(s) URL: the only kind a paste-back is fetched from. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * D63 (`docs/accounts.md` → *Signing in*): signs a profile in or out by running its
 * CLI's own login / logout with the profile's folder in the environment
 * (`claude auth login --claudeai [--email]`, `codex login [--device-auth]`, OpenCode
 * through an `opencode serve` on the profile's data folder and its provider OAuth
 * routes). The page to sign in on is read from the CLI's output (D61's pattern: the
 * UI opens a tab and points it there), completion is the CLI's status command
 * (or its exit), and the time limit is 5 minutes. Tokens are the CLI's own: this
 * never reads, stores or logs one, and an API key goes straight to the profile's
 * local OpenCode server.
 */
export class SignInManager {
  readonly #options: SignInManagerOptions;
  readonly #flows = new Map<string, Flow>();
  #closed = false;

  constructor(options: SignInManagerOptions) {
    this.#options = options;
  }

  /** A sign-in's state. @throws {AccountError} 404. */
  get(id: string): SignInState {
    const flow = this.#flows.get(id);
    if (!flow) throw new AccountError(404, 'not-found', `no sign-in ${id}`);
    return flow.state;
  }

  async #env(profileId: string, cli: CliProviderId): Promise<NodeJS.ProcessEnv> {
    return { ...childEnv(this.#options.env ?? process.env), ...(await this.#options.accounts.envFor(profileId, cli)), BROWSER: 'true' };
  }

  /** Starts a sign-in. The built-in Default is the developer's own login: it is managed in a terminal, never here. */
  async start(profileId: string, options: SignInOptions = {}): Promise<SignInState> {
    const record = await this.#options.accounts.find(profileId);
    if (!record) throw new AccountError(404, 'not-found', `no profile ${profileId}`);
    if (record.builtin) throw new AccountError(409, 'builtin', 'the Default profile is your own login: sign in to it in a terminal');
    for (const flow of this.#flows.values()) {
      if (flow.state.profileId === profileId && (flow.state.state === 'starting' || flow.state.state === 'waiting')) await this.cancel(flow.state.id);
    }
    const now = Date.now();
    const timeoutMs = this.#options.timeoutMs ?? 5 * 60_000;
    const before = await this.#options.accounts.check(profileId, { refresh: true }).catch(() => null);
    const flow: Flow = {
      state: {
        id: randomUUID(),
        profileId,
        cli: record.cli,
        state: 'starting',
        url: null,
        code: null,
        instructions: null,
        error: null,
        command: signInCommand(record),
        canPasteBack: false,
        startedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + timeoutMs).toISOString(),
      },
      child: null,
      oc: null,
      finishedAt: null,
      wasSignedIn: before?.signIn === 'signed-in',
      output: '',
      stop: () => undefined,
    };
    this.#sweep();
    this.#flows.set(flow.state.id, flow);
    if (record.cli === 'opencode') await this.#startOpencode(flow, options);
    else await this.#startCli(flow, options);
    if (flow.state.state === 'starting' || flow.state.state === 'waiting') void this.#watch(flow, now + timeoutMs);
    return flow.state;
  }

  #set(flow: Flow, patch: Partial<SignInState>): void {
    flow.state = { ...flow.state, ...patch };
  }

  async #startCli(flow: Flow, options: SignInOptions): Promise<void> {
    const cli = flow.state.cli;
    const command = await this.#options.registry.command(cli);
    const args =
      cli === 'claude'
        ? ['auth', 'login', '--claudeai', ...(options.email ? ['--email', options.email] : [])]
        : ['login', ...(options.deviceCode ? ['--device-auth'] : [])];
    const [cmd, ...prefix] = command as [string, ...string[]];
    const env = await this.#env(flow.state.profileId, cli);
    const child = spawn(cmd, [...prefix, ...args], { cwd: this.#options.dataDir, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    flow.child = child;
    child.stdin?.on('error', () => undefined);
    const onData = (chunk: string): void => {
      flow.output = (flow.output + plain(chunk)).slice(-16_384);
      if (flow.state.url === null) {
        const url = firstPageUrl(flow.output);
        if (url) this.#set(flow, { url, state: 'waiting', canPasteBack: true });
      }
      if (options.deviceCode && flow.state.code === null) {
        const code = DEVICE_CODE_RE.exec(flow.output);
        if (code?.[1]) this.#set(flow, { code: code[1] });
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', onData);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', onData);
    const exited = new Promise<void>((resolve) => {
      child.once('error', (error: Error) => {
        this.#finish(flow, { state: 'failed', error: `could not start ${cmd}: ${error.message}` });
        resolve();
      });
      child.once('close', (code: number | null) => {
        void this.#exited(flow, code).finally(resolve);
      });
    });
    flow.stop = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    };
    void exited;
    // The page may take a moment to be printed: the first answer waits briefly for it (the UI polls after that).
    const until = Date.now() + 3_000;
    while (flow.state.url === null && flow.finishedAt === null && Date.now() < until) await sleep(25);
  }

  async #exited(flow: Flow, code: number | null): Promise<void> {
    if (flow.finishedAt !== null) return;
    if (code === 0) {
      const status = await this.#options.accounts.check(flow.state.profileId, { refresh: true }).catch(() => null);
      if (status?.signIn === 'signed-out') this.#finish(flow, { state: 'failed', error: 'The sign-in finished but the account is still signed out.' });
      else this.#finish(flow, { state: 'done' });
      return;
    }
    const last = flow.output.trim().split('\n').pop()?.trim() ?? '';
    this.#finish(flow, { state: 'failed', error: last ? `The sign-in ended (${last})` : `The sign-in ended with ${code === null ? 'a signal' : `code ${code}`}.` });
  }

  #finish(flow: Flow, patch: Partial<SignInState>): void {
    if (flow.finishedAt !== null) return;
    flow.finishedAt = Date.now();
    this.#set(flow, { ...patch, canPasteBack: false });
    flow.stop();
    this.#options.accounts.forget(flow.state.profileId);
    this.#options.onChanged?.(flow.state.profileId);
  }

  async #watch(flow: Flow, deadline: number): Promise<void> {
    for (;;) {
      await sleep(this.#options.pollMs ?? 2_000);
      if (flow.finishedAt !== null || this.#closed) return;
      if (Date.now() >= deadline) {
        const command = flow.state.command;
        return this.#finish(flow, { state: 'timeout', error: `The sign-in was not finished in time. Run this in a terminal instead: ${command}` });
      }
      // The CLI's own status is the oracle (not for a re-sign-in: an account already signed in would end it at once).
      if (!flow.wasSignedIn) {
        const status = await this.#options.accounts.check(flow.state.profileId, { refresh: true }).catch(() => null);
        if (flow.finishedAt !== null) return;
        if (status?.signIn === 'signed-in') return this.#finish(flow, { state: 'done' });
      }
    }
  }

  /** Pastes back what the browser ended on (a loopback redirect URL) or a code / device code the CLI asks for. */
  async paste(id: string, value: unknown): Promise<SignInState> {
    const flow = this.#flows.get(id);
    if (!flow) throw new AccountError(404, 'not-found', `no sign-in ${id}`);
    if (flow.state.state !== 'waiting') throw new AccountError(409, 'not-waiting', 'this sign-in is no longer waiting');
    if (typeof value !== 'string' || value.trim() === '' || value.length > 4096) throw new AccountError(422, 'invalid', 'paste the address the browser ended on (or the code)', 'value');
    const text = value.trim();
    if (flow.oc) {
      const code = isLoopbackUrl(text) ? (new URL(text).searchParams.get('code') ?? text) : text;
      await this.#ocCallback(flow, code);
    } else if (isLoopbackUrl(text)) {
      // The browser ran elsewhere: its redirect is delivered to the CLI's local callback server from here.
      await fetch(text, { redirect: 'manual', signal: AbortSignal.timeout(15_000) }).catch((error: unknown) => {
        throw new AccountError(422, 'invalid', `could not deliver it to the CLI: ${error instanceof Error ? error.message : String(error)}`, 'value');
      });
    } else if (/^https?:\/\//i.test(text)) {
      throw new AccountError(422, 'invalid', 'paste the address from the browser\'s address bar (it starts with http://localhost) or the code', 'value');
    } else {
      flow.child?.stdin?.write(`${text}\n`);
    }
    return flow.state;
  }

  /** Cancels a sign-in and stops its helper. */
  async cancel(id: string): Promise<SignInState> {
    const flow = this.#flows.get(id);
    if (!flow) throw new AccountError(404, 'not-found', `no sign-in ${id}`);
    this.#finish(flow, { state: 'cancelled' });
    return flow.state;
  }

  #sweep(): void {
    const now = Date.now();
    for (const [id, flow] of this.#flows) if (flow.finishedAt !== null && now - flow.finishedAt > KEEP_MS) this.#flows.delete(id);
  }

  /** Cancels every sign-in (the app is closing). */
  async close(): Promise<void> {
    this.#closed = true;
    for (const flow of this.#flows.values()) this.#finish(flow, { state: 'cancelled' });
  }

  // ── sign out ────────────────────────────────────────────────────────────────

  /** Runs the CLI's logout for the profile (`claude auth logout`, `codex logout`; OpenCode: removes the profile's provider credentials). */
  async signOut(profileId: string): Promise<{ readonly ok: boolean; readonly message: string }> {
    const record = await this.#options.accounts.find(profileId);
    if (!record) throw new AccountError(404, 'not-found', `no profile ${profileId}`);
    if (record.builtin) throw new AccountError(409, 'builtin', 'the Default profile is your own login: sign out of it in a terminal');
    const live = [...this.#flows.values()].find((f) => f.state.profileId === profileId && (f.state.state === 'waiting' || f.state.state === 'starting'));
    if (live) await this.cancel(live.state.id);
    let ok: boolean;
    let message: string;
    if (record.cli === 'opencode') {
      ({ ok, message } = await this.#ocSignOut(profileId));
    } else {
      const command = await this.#options.registry.command(record.cli);
      const result = await runCommand(command, record.cli === 'claude' ? ['auth', 'logout'] : ['logout'], {
        cwd: this.#options.dataDir,
        env: await this.#env(profileId, record.cli),
        timeoutMs: 30_000,
        maxOutputBytes: 256 * 1024,
      });
      ok = result.error === null && result.code === 0;
      message = ok ? 'Signed out.' : (plain(result.stderr || result.stdout).trim().split('\n').pop() ?? 'The CLI could not sign out.');
    }
    this.#options.accounts.forget(profileId);
    this.#options.onChanged?.(profileId);
    return { ok, message };
  }

  // ── OpenCode ────────────────────────────────────────────────────────────────

  /**
   * `opencode serve` on the profile's data folder for the time of a sign-in or
   * out (VERIFIED `packages/sdk/openapi.json` v1.18.34: `GET /provider/auth`,
   * `POST /provider/{id}/oauth/authorize`, `POST /provider/{id}/oauth/callback`,
   * `PUT|DELETE /auth/{id}`, `GET /provider`).
   */
  async #server(profileId: string): Promise<{ readonly base: string; readonly auth: string; readonly stop: () => void }> {
    const command = await this.#options.registry.command('opencode');
    const [cmd, ...prefix] = command as [string, ...string[]];
    const port = await freePort();
    const password = randomBytes(24).toString('hex');
    const env = { ...(await this.#env(profileId, 'opencode')), OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' };
    const child = spawn(cmd, [...prefix, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: this.#options.dataDir, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...serverSpawnOptions });
    const pid = child.pid;
    if (pid !== undefined) registerServer(pid);
    child.once('close', () => {
      if (pid !== undefined) unregisterServer(pid);
    });
    let output = '';
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AccountError(502, 'start-failed', 'opencode serve did not report its address in time')), 30_000);
      child.once('error', (error: Error) => reject(new AccountError(502, 'start-failed', `could not start opencode: ${error.message}`)));
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        output += chunk;
        const found = /opencode server listening on (https?:\/\/\S+)/.exec(output);
        if (found?.[1]) {
          clearTimeout(timer);
          resolve(found[1]);
        }
      });
      child.stderr?.resume();
    }).catch((error: unknown) => {
      signalServer(child, 'SIGTERM');
      throw error;
    });
    const stop = (): void => {
      signalServer(child, 'SIGTERM');
      setTimeout(() => signalServer(child, 'SIGKILL'), 2_000).unref();
    };
    return { base, auth: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, stop };
  }

  async #oc<T>(flow: { readonly oc: NonNullable<Flow['oc']> }, method: string, route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${flow.oc.base}${route}`, {
      method,
      headers: { authorization: flow.oc.auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.#options.timeoutMs ?? 5 * 60_000),
    });
    if (!response.ok) throw new Error(`OpenCode answered ${response.status} to ${method} ${route.split('?')[0]}`);
    return (await response.json()) as T;
  }

  async #startOpencode(flow: Flow, options: SignInOptions): Promise<void> {
    const provider = (options.provider ?? '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(provider)) {
      this.#finish(flow, { state: 'failed', error: 'Name the provider to sign in to (for example anthropic or openai).' });
      return;
    }
    try {
      const server = await this.#server(flow.state.profileId);
      flow.stop = server.stop;
      const base = { base: server.base, auth: server.auth };
      if (options.apiKey !== undefined && options.apiKey !== '') {
        // The key goes to the profile's own local server (it writes its own auth file); Switchboard keeps nothing.
        await this.#oc({ oc: { ...base, provider, method: 0, kind: 'auto' } }, 'PUT', `/auth/${encodeURIComponent(provider)}`, { type: 'api', key: options.apiKey });
        this.#finish(flow, { state: 'done' });
        return;
      }
      const methods = await this.#oc<Record<string, Array<{ type: string; label?: string }>>>({ oc: { ...base, provider, method: 0, kind: 'auto' } }, 'GET', '/provider/auth');
      const list = methods[provider] ?? [];
      const method = list.findIndex((m) => m.type === 'oauth');
      if (method < 0) {
        this.#finish(flow, { state: 'failed', error: `${provider} has no browser sign-in: use an API key.` });
        return;
      }
      const probe = { oc: { ...base, provider, method, kind: 'auto' as const } };
      const authorization = await this.#oc<{ url: string; method: 'auto' | 'code'; instructions: string }>(probe, 'POST', `/provider/${encodeURIComponent(provider)}/oauth/authorize`, { method });
      flow.oc = { ...base, provider, method, kind: authorization.method };
      this.#set(flow, { url: authorization.url, instructions: authorization.instructions || null, state: 'waiting', canPasteBack: authorization.method === 'code' });
      // `auto`: the callback call waits until the browser redirect arrived and answers when the tokens are stored.
      if (authorization.method === 'auto') void this.#ocCallback(flow, undefined);
    } catch (error) {
      this.#finish(flow, { state: 'failed', error: error instanceof AccountError ? error.message : error instanceof Error ? error.message : String(error) });
    }
  }

  async #ocCallback(flow: Flow, code: string | undefined): Promise<void> {
    if (!flow.oc) return;
    try {
      const done = await this.#oc<boolean>({ oc: flow.oc }, 'POST', `/provider/${encodeURIComponent(flow.oc.provider)}/oauth/callback`, { method: flow.oc.method, ...(code !== undefined ? { code } : {}) });
      if (flow.finishedAt === null) this.#finish(flow, done ? { state: 'done' } : { state: 'failed', error: 'OpenCode did not accept the sign-in.' });
    } catch (error) {
      if (flow.finishedAt === null) this.#finish(flow, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }

  async #ocSignOut(profileId: string): Promise<{ ok: boolean; message: string }> {
    let server: { readonly base: string; readonly auth: string; readonly stop: () => void } | null = null;
    try {
      server = await this.#server(profileId);
      const handle = { oc: { base: server.base, auth: server.auth, provider: '', method: 0, kind: 'auto' as const } };
      const providers = await this.#oc<{ connected: string[] }>(handle, 'GET', '/provider');
      for (const id of providers.connected) await this.#oc(handle, 'DELETE', `/auth/${encodeURIComponent(id)}`);
      return { ok: true, message: providers.connected.length > 0 ? `Signed out of ${providers.connected.join(', ')}.` : 'Nothing was signed in.' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    } finally {
      server?.stop();
    }
  }
}
