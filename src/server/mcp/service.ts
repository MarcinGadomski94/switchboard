import { randomUUID } from 'node:crypto';
import {
  type CliStatus,
  MCP_EDITABLE_SCOPES,
  type McpActionResult,
  type McpAuthState,
  type McpEditableScope,
  McpKeepError,
  type McpRawConfig,
  type McpServerDefinition,
  type McpServerInput,
  type McpServerView,
  type McpStatus,
  type McpView,
  authInstructions,
  buildDefinition,
  commandText,
  definitionOf,
  describeConfig,
  parseGetOutput,
  parseListOutput,
  parseStatusResponse,
  scrubSecrets,
  secretValues,
  type StatusRow,
} from '../../core/mcp.ts';
import { failureText, runCommand, succeeded } from '../exec.ts';
import type { FolderRef } from '../folders/ref.ts';
import { childEnv } from '../supervisor/argv.ts';
import { type ConfiguredServer, readConfiguredServers, readServerConfig } from './config.ts';
import { MCP_HELPER_ARGS, McpHelper } from './helper.ts';

/** A folder the page works in: its ref and label. */
export type McpFolder = Pick<FolderRef, 'id' | 'path' | 'root'> & { readonly label: string | null };

/** Why an MCP action was refused (the route's status code comes with it). */
export class McpError extends Error {
  override name = 'McpError';
  readonly code: 'not-found' | 'invalid' | 'read-only' | 'cli-failed';
  readonly status: number;
  readonly field: string | null;
  readonly commands: readonly string[];
  constructor(code: McpError['code'], message: string, options: { readonly field?: string; readonly commands?: readonly string[] } = {}) {
    super(message);
    this.code = code;
    this.status = code === 'not-found' ? 404 : code === 'cli-failed' ? 409 : 422;
    this.field = options.field ?? null;
    this.commands = options.commands ?? [];
  }
}

/** Options for {@link McpService}. */
export interface McpServiceOptions {
  /** CLI argv prefix (`SWITCHBOARD_CLAUDE_BIN`). */
  readonly claudeCommand: readonly string[];
  /** Dev-only flags appended to the helper (`SWITCHBOARD_CLAUDE_EXTRA_ARGS`); never to `claude mcp …`. */
  readonly extraArgs?: readonly string[];
  /** Base environment (default `process.env`), scrubbed like the supervisor's children; also where the config files are looked up. */
  readonly env?: NodeJS.ProcessEnv;
  /** Limit of one `claude mcp …` command (default 45 s). */
  readonly commandTimeoutMs?: number;
  /** How long "Check all" waits for servers that are still connecting (default 30 s). */
  readonly settleTimeoutMs?: number;
  /** How long a sign-in waits for the browser (default 5 min). */
  readonly authTimeoutMs?: number;
  /** Poll interval while waiting (default 1 s). */
  readonly pollMs?: number;
}

/** A cached check result for one server. */
interface CachedRow {
  readonly name: string;
  readonly status: McpStatus;
  readonly error: string | null;
  readonly tools: number | null;
  readonly checkedAt: string;
  /** The scope / source `mcp_status` reported (`null` from `mcp get` / `list`). */
  readonly scope: string | null;
  /** The display parts of a read-only server's config (secrets already masked). */
  readonly described: ReturnType<typeof describeConfig> | null;
}

interface FolderCache {
  checkedAt: string | null;
  changedAt: string | null;
  readonly rows: Map<string, CachedRow>;
}

interface AuthFlow {
  state: McpAuthState;
  readonly folder: McpFolder;
  helper: McpHelper | null;
  finishedAt: number | null;
}

const EDITABLE = new Set<string>(MCP_EDITABLE_SCOPES);
const SCOPE_ORDER = ['local', 'project', 'user'];
/** Finished sign-ins are forgotten after this long. */
const AUTH_KEEP_MS = 10 * 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());

/**
 * D61: the MCP servers page's service (`docs/mcp.md`). Lists a folder's servers
 * from the CLI's config files (read-only), checks them with the CLI
 * (`claude mcp get <name>`; "Check all" = `mcp_status` from a short-lived helper,
 * `claude mcp list` when that fails), reconnects / enables / disables / signs in
 * through the helper's control requests, and adds / edits / removes with
 * `claude mcp add-json` / `claude mcp remove`. Every CLI run has the folder as its
 * cwd, an argv array and a time limit; no secret value is ever returned.
 */
export class McpService {
  readonly #options: McpServiceOptions;
  readonly #cache = new Map<string, FolderCache>();
  readonly #auth = new Map<string, AuthFlow>();
  readonly #helpers = new Set<McpHelper>();
  #closed = false;

  constructor(options: McpServiceOptions) {
    this.#options = options;
  }

  get #env(): NodeJS.ProcessEnv {
    return childEnv(this.#options.env ?? process.env);
  }

  #folderCache(folder: McpFolder): FolderCache {
    let cache = this.#cache.get(folder.root);
    if (!cache) {
      cache = { checkedAt: null, changedAt: null, rows: new Map() };
      this.#cache.set(folder.root, cache);
    }
    return cache;
  }

  async #configured(folder: McpFolder): Promise<ConfiguredServer[]> {
    return readConfiguredServers(this.#options.env ?? process.env, folder.root, folder.path);
  }

  /** The folder's servers: the config files' (editable) plus what the last check found beyond them (plugins, claude.ai connectors, …: read-only). */
  async view(folder: McpFolder): Promise<McpView> {
    const configured = await this.#configured(folder);
    const cache = this.#folderCache(folder);
    const servers: McpServerView[] = [];
    for (const server of configured) {
      const cached = cache.rows.get(server.name);
      let status: McpStatus = 'unchecked';
      let error: string | null = null;
      let tools: number | null = null;
      let checkedAt: string | null = null;
      if (server.disabled) status = 'disabled';
      else if (server.approval === 'pending') status = 'pending-approval';
      else if (server.approval === 'rejected') status = 'rejected';
      else if (cached && cached.status !== 'disabled' && cached.status !== 'pending-approval' && cached.status !== 'rejected') {
        ({ status, error, tools, checkedAt } = cached);
      }
      if (cached && status === 'disabled') checkedAt = null;
      servers.push({
        name: server.name,
        scope: server.scope,
        editable: true,
        ...describeConfig(server.config),
        status,
        error: error === null ? null : scrubSecrets(error, secretValues(server.config)),
        tools,
        checkedAt,
        approval: server.approval,
      });
    }
    const known = new Set(configured.map((s) => s.name));
    for (const row of cache.rows.values()) {
      if (known.has(row.name) || row.described === null || (row.scope !== null && EDITABLE.has(row.scope))) continue;
      servers.push({
        name: row.name,
        scope: row.scope ?? 'other',
        editable: false,
        ...row.described,
        status: row.status,
        error: row.error,
        tools: row.tools,
        checkedAt: row.checkedAt,
        approval: null,
      });
    }
    const rank = (scope: string): number => {
      const i = SCOPE_ORDER.indexOf(scope);
      return i === -1 ? SCOPE_ORDER.length : i;
    };
    servers.sort((a, b) => rank(a.scope) - rank(b.scope) || a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
    return {
      folder: { id: folder.id, path: folder.path, label: folder.label },
      servers,
      checkedAt: cache.checkedAt,
      changedAt: cache.changedAt,
    };
  }

  // ------------------------------------------------------------ CLI runs

  async #run(folder: McpFolder, argv: readonly string[], secrets: readonly string[]): Promise<{ ok: boolean; text: string; command: string }> {
    const result = await runCommand(this.#options.claudeCommand, argv, { cwd: folder.root, env: this.#env, timeoutMs: this.#options.commandTimeoutMs ?? 45_000, maxOutputBytes: 1024 * 1024 });
    const command = commandText(argv, secrets);
    if (succeeded(result)) {
      const text = scrubSecrets((result.stdout.trim() || result.stderr.trim()).split('\n').filter((l) => l.trim() !== '').join('\n'), secrets);
      return { ok: true, text, command };
    }
    return { ok: false, text: scrubSecrets(result.timedOut ? `timed out: ${failureText(result)}` : failureText(result), secrets), command };
  }

  async #helper(folder: McpFolder): Promise<McpHelper> {
    if (this.#closed) throw new McpError('cli-failed', 'Switchboard is shutting down');
    try {
      const helper = await McpHelper.start({
        claudeCommand: this.#options.claudeCommand,
        ...(this.#options.extraArgs ? { extraArgs: this.#options.extraArgs } : {}),
        cwd: folder.root,
        env: this.#env,
      });
      this.#helpers.add(helper);
      return helper;
    } catch (error) {
      throw new McpError('cli-failed', error instanceof Error ? error.message : String(error), { commands: [helperText('initialize')] });
    }
  }

  async #closeHelper(helper: McpHelper): Promise<void> {
    await helper.close();
    this.#helpers.delete(helper);
  }

  /** `mcp_status` rows into the cache (the whole folder when `all`). */
  #store(folder: McpFolder, rows: readonly StatusRow[], all: boolean): void {
    const cache = this.#folderCache(folder);
    const now = new Date().toISOString();
    if (all) {
      cache.rows.clear();
      cache.checkedAt = now;
    }
    for (const row of rows) {
      cache.rows.set(row.name, {
        name: row.name,
        status: row.status,
        error: row.error === null ? null : scrubSecrets(row.error, row.config ? secretValues(row.config) : []),
        tools: row.tools,
        checkedAt: now,
        scope: row.source && !EDITABLE.has(row.source) ? row.source : row.scope,
        described: row.config ? describeConfig(row.config) : null,
      });
    }
  }

  #storeText(folder: McpFolder, name: string, status: CliStatus): void {
    const cache = this.#folderCache(folder);
    const previous = cache.rows.get(name);
    cache.rows.set(name, {
      name,
      status: status.status,
      error: status.error,
      tools: status.status === 'connected' ? (previous?.tools ?? null) : null,
      checkedAt: new Date().toISOString(),
      scope: previous?.scope ?? null,
      described: previous?.described ?? null,
    });
  }

  /** `mcp_status` until nothing is `pending` any more (or the settle time is up). */
  async #settledStatus(helper: McpHelper): Promise<StatusRow[] | string> {
    const deadline = Date.now() + (this.#options.settleTimeoutMs ?? 30_000);
    for (;;) {
      const answer = await helper.request('mcp_status');
      if (!answer.ok) return answer.error;
      const rows = parseStatusResponse(answer.response);
      if (!rows.some((r) => r.status === 'pending') || Date.now() >= deadline) return rows;
      await sleep(this.#options.pollMs ?? 1_000);
    }
  }

  // ------------------------------------------------------------ actions

  /**
   * Check: one server with `claude mcp get <name>` (its `Status:` / `Issue:` lines),
   * or all of them with the helper's `mcp_status` (tools counted, plugin and claude.ai
   * servers included), falling back to `claude mcp list` when the helper fails.
   */
  async check(folder: McpFolder, name?: string): Promise<McpActionResult> {
    if (name !== undefined) {
      // Only a server the page knows (and never an option-looking argv item).
      const known = await this.#named(folder, name);
      if (name.startsWith('-')) throw new McpError('invalid', `Invalid name ${name}`, { field: 'name' });
      const secrets = 'config' in known ? secretValues(known.config) : [];
      const run = await this.#run(folder, ['mcp', 'get', name], secrets);
      const status = run.ok ? parseGetOutput(run.text) : null;
      if (status) this.#storeText(folder, name, status);
      else this.#storeText(folder, name, { status: 'failed', error: run.text || 'claude mcp get printed no status' });
      return { view: await this.view(folder), commands: [run.command], message: status ? null : run.text };
    }
    const commands = [helperText('mcp_status')];
    let helper: McpHelper | null = null;
    let failure: string;
    try {
      helper = await this.#helper(folder);
      const rows = await this.#settledStatus(helper);
      if (typeof rows !== 'string') {
        this.#store(folder, rows, true);
        return { view: await this.view(folder), commands, message: null };
      }
      failure = rows;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      if (helper) await this.#closeHelper(helper);
    }
    // The helper failed: `claude mcp list` (no tools, no scopes).
    const secrets = (await this.#configured(folder)).flatMap((s) => secretValues(s.config));
    const run = await this.#run(folder, ['mcp', 'list'], secrets);
    commands.push(run.command);
    if (!run.ok) throw new McpError('cli-failed', `${failure}; ${run.text}`, { commands });
    const cache = this.#folderCache(folder);
    for (const listed of parseListOutput(run.text)) this.#storeText(folder, listed.name, listed);
    cache.checkedAt = new Date().toISOString();
    return { view: await this.view(folder), commands, message: `mcp_status failed (${failure}); used claude mcp list` };
  }

  async #named(folder: McpFolder, name: string): Promise<ConfiguredServer | CachedRow> {
    const configured = (await this.#configured(folder)).find((s) => s.name === name);
    if (configured) return configured;
    const cached = this.#folderCache(folder).rows.get(name);
    if (cached) return cached;
    throw new McpError('not-found', `No MCP server named ${name} in ${folder.path}`);
  }

  /** Reconnect: the helper's `mcp_reconnect`, then `mcp_status` for the new state. */
  async reconnect(folder: McpFolder, name: string): Promise<McpActionResult> {
    const server = await this.#named(folder, name);
    const secrets = 'config' in server ? secretValues(server.config) : [];
    const commands = [helperText('mcp_reconnect', { serverName: name })];
    const helper = await this.#helper(folder);
    try {
      const answer = await helper.request('mcp_reconnect', { serverName: name }, 90_000);
      const status = await helper.request('mcp_status');
      if (status.ok) this.#store(folder, parseStatusResponse(status.response).filter((r) => r.name === name), false);
      return { view: await this.view(folder), commands, message: answer.ok ? `Reconnected ${name}` : scrubSecrets(answer.error, secrets) };
    } finally {
      await this.#closeHelper(helper);
    }
  }

  /** Enable / Disable for this folder: the helper's `mcp_toggle` (the CLI writes `disabledMcpServers`). */
  async toggle(folder: McpFolder, name: string, enabled: boolean): Promise<McpActionResult> {
    const server = await this.#named(folder, name);
    const secrets = 'config' in server ? secretValues(server.config) : [];
    const commands = [helperText('mcp_toggle', { serverName: name, enabled })];
    const helper = await this.#helper(folder);
    try {
      const answer = await helper.request('mcp_toggle', { serverName: name, enabled }, 90_000);
      this.#folderCache(folder).changedAt = new Date().toISOString();
      if (enabled) {
        const status = await helper.request('mcp_status');
        if (status.ok) this.#store(folder, parseStatusResponse(status.response).filter((r) => r.name === name), false);
      } else {
        this.#folderCache(folder).rows.delete(name);
      }
      if (!answer.ok && /not found/i.test(answer.error)) throw new McpError('not-found', scrubSecrets(answer.error, secrets), { commands });
      return { view: await this.view(folder), commands, message: answer.ok ? `${enabled ? 'Enabled' : 'Disabled'} ${name} for this folder` : scrubSecrets(answer.error, secrets) };
    } finally {
      await this.#closeHelper(helper);
    }
  }

  /** The Edit form's starting point (no secret values). */
  async definition(folder: McpFolder, name: string, scope: string): Promise<McpServerDefinition> {
    const editable = editableScope(scope);
    const config = await readServerConfig(this.#options.env ?? process.env, folder.root, folder.path, name, editable);
    if (!config) throw new McpError('not-found', `No ${scope} MCP server named ${name} in ${folder.path}`);
    return definitionOf(name, editable, config);
  }

  #definitionFor(input: McpServerInput, original: McpRawConfig | null): Record<string, unknown> {
    try {
      return buildDefinition(input, original);
    } catch (error) {
      if (error instanceof McpKeepError) throw new McpError('invalid', error.message, { field: error.field });
      throw error;
    }
  }

  async #addJson(folder: McpFolder, name: string, scope: McpEditableScope, definition: Record<string, unknown>) {
    return this.#run(folder, ['mcp', 'add-json', name, JSON.stringify(definition), '--scope', scope], secretValues(definition));
  }

  async #remove(folder: McpFolder, name: string, scope: McpEditableScope, secrets: readonly string[]) {
    return this.#run(folder, ['mcp', 'remove', name, '--scope', scope], secrets);
  }

  #changed(folder: McpFolder, ...names: string[]): void {
    const cache = this.#folderCache(folder);
    cache.changedAt = new Date().toISOString();
    for (const name of names) cache.rows.delete(name);
  }

  /** Add: `claude mcp add-json <name> <json> --scope <scope>` in the folder. */
  async add(folder: McpFolder, input: McpServerInput): Promise<McpActionResult> {
    const definition = this.#definitionFor(input, null);
    const run = await this.#addJson(folder, input.name, input.scope, definition);
    if (!run.ok) throw new McpError('cli-failed', run.text, { commands: [run.command] });
    this.#changed(folder, input.name);
    return { view: await this.view(folder), commands: [run.command], message: run.text || null };
  }

  /**
   * Edit = remove + add-json. Same name and scope: remove, then add the new
   * definition, and add the old one back if that fails. A new name or scope: add
   * the new one first, then remove the old one. Kept secrets never leave the service.
   */
  async edit(folder: McpFolder, name: string, scope: string, input: McpServerInput): Promise<McpActionResult> {
    const oldScope = editableScope(scope);
    const env = this.#options.env ?? process.env;
    const original = await readServerConfig(env, folder.root, folder.path, name, oldScope);
    if (!original) throw new McpError('not-found', `No ${scope} MCP server named ${name} in ${folder.path}`);
    const definition = this.#definitionFor(input, original);
    const secrets = [...secretValues(original), ...secretValues(definition)];
    const commands: string[] = [];
    if (input.name === name && input.scope === oldScope) {
      const removed = await this.#remove(folder, name, oldScope, secrets);
      commands.push(removed.command);
      if (!removed.ok) throw new McpError('cli-failed', removed.text, { commands });
      const added = await this.#addJson(folder, name, oldScope, definition);
      commands.push(added.command);
      if (!added.ok) {
        const restored = await this.#addJson(folder, name, oldScope, { ...original });
        commands.push(restored.command);
        this.#changed(folder, name);
        throw new McpError('cli-failed', restored.ok ? `${added.text} (the previous definition was restored)` : `${added.text}; restoring the previous definition failed too: ${restored.text}`, { commands });
      }
      this.#changed(folder, name);
      return { view: await this.view(folder), commands, message: added.text || null };
    }
    const added = await this.#addJson(folder, input.name, input.scope, definition);
    commands.push(added.command);
    if (!added.ok) throw new McpError('cli-failed', added.text, { commands });
    const removed = await this.#remove(folder, name, oldScope, secrets);
    commands.push(removed.command);
    this.#changed(folder, name, input.name);
    if (!removed.ok) throw new McpError('cli-failed', `Added ${input.name}, but removing the old ${name} failed: ${removed.text}`, { commands });
    return { view: await this.view(folder), commands, message: added.text || null };
  }

  /** Remove: `claude mcp remove <name> --scope <scope>` in the folder. */
  async remove(folder: McpFolder, name: string, scope: string): Promise<McpActionResult> {
    const editable = editableScope(scope);
    const original = await readServerConfig(this.#options.env ?? process.env, folder.root, folder.path, name, editable);
    if (!original) throw new McpError('not-found', `No ${scope} MCP server named ${name} in ${folder.path}`);
    const run = await this.#remove(folder, name, editable, secretValues(original));
    if (!run.ok) throw new McpError('cli-failed', run.text, { commands: [run.command] });
    this.#changed(folder, name);
    return { view: await this.view(folder), commands: [run.command], message: run.text || null };
  }

  // ------------------------------------------------------------ OAuth sign-in

  /**
   * Starts a sign-in: a helper in the folder, `mcp_clear_auth` first when `reset`
   * (Re-authenticate), then `mcp_authenticate`. The CLI answers the URL to open and
   * listens for the browser's redirect on this machine's localhost; the helper
   * stays up (polling `mcp_status`) until the server connects, the time is up or
   * the sign-in is cancelled, then it is closed.
   */
  async startAuth(folder: McpFolder, name: string, reset: boolean): Promise<McpAuthState> {
    const server = await this.#named(folder, name);
    const described = 'config' in server ? describeConfig(server.config) : server.described;
    const secrets = 'config' in server ? secretValues(server.config) : [];
    const id = randomUUID();
    const base: McpAuthState = { id, server: name, state: 'failed', authUrl: null, callbackExpected: false, error: null, instructions: null };
    if (described && !described.canAuthenticate) {
      return this.#remember({ ...base, error: `${name} is a ${described.transport} server: it has no OAuth sign-in (only HTTP and SSE servers do).` }, folder);
    }
    let helper: McpHelper;
    try {
      helper = await this.#helper(folder);
    } catch (error) {
      return this.#remember({ ...base, error: error instanceof Error ? error.message : String(error), instructions: authInstructions(folder.path, name) }, folder);
    }
    if (reset) {
      const cleared = await helper.request('mcp_clear_auth', { serverName: name }, 30_000);
      if (!cleared.ok) {
        await this.#closeHelper(helper);
        return this.#remember({ ...base, error: scrubSecrets(cleared.error, secrets), instructions: authInstructions(folder.path, name) }, folder);
      }
    }
    const answer = await helper.request('mcp_authenticate', { serverName: name }, 60_000);
    if (!answer.ok) {
      await this.#closeHelper(helper);
      return this.#remember({ ...base, error: scrubSecrets(answer.error, secrets), instructions: authInstructions(folder.path, name) }, folder);
    }
    const response = answer.response ?? {};
    const authUrl = typeof response['authUrl'] === 'string' ? response['authUrl'] : null;
    if (!authUrl || response['requiresUserAction'] === false) {
      const status = await helper.request('mcp_status');
      if (status.ok) this.#store(folder, parseStatusResponse(status.response).filter((r) => r.name === name), false);
      await this.#closeHelper(helper);
      return this.#remember({ ...base, state: 'done' }, folder);
    }
    const flow = this.#remember({ ...base, state: 'waiting', authUrl, callbackExpected: response['callbackExpected'] !== false }, folder, helper);
    void this.#watch(id, name);
    return flow;
  }

  #remember(state: McpAuthState, folder: McpFolder, helper: McpHelper | null = null): McpAuthState {
    this.#sweepAuth();
    this.#auth.set(state.id, { state, folder, helper, finishedAt: state.state === 'waiting' ? null : Date.now() });
    return state;
  }

  #sweepAuth(): void {
    const now = Date.now();
    for (const [id, flow] of this.#auth) if (flow.finishedAt !== null && now - flow.finishedAt > AUTH_KEEP_MS) this.#auth.delete(id);
  }

  async #finish(flow: AuthFlow, patch: Partial<McpAuthState>): Promise<void> {
    if (flow.state.state !== 'waiting') return;
    flow.state = { ...flow.state, ...patch };
    flow.finishedAt = Date.now();
    const helper = flow.helper;
    flow.helper = null;
    if (helper) await this.#closeHelper(helper);
  }

  async #watch(id: string, name: string): Promise<void> {
    const deadline = Date.now() + (this.#options.authTimeoutMs ?? 5 * 60_000);
    for (;;) {
      await sleep(this.#options.pollMs ?? 1_000);
      const flow = this.#auth.get(id);
      if (!flow || flow.state.state !== 'waiting' || !flow.helper) return;
      if (!flow.helper.running) return this.#finish(flow, { state: 'failed', error: 'claude exited before the sign-in finished', instructions: authInstructions(flow.folder.path, name) });
      const status = await flow.helper.request('mcp_status', {}, 15_000);
      if (flow.state.state !== 'waiting') return;
      if (status.ok) {
        const row = parseStatusResponse(status.response).find((r) => r.name === name);
        if (row?.status === 'connected') {
          this.#store(flow.folder, [row], false);
          return this.#finish(flow, { state: 'done' });
        }
      }
      if (Date.now() >= deadline) return this.#finish(flow, { state: 'failed', error: 'The sign-in was not finished in time', instructions: authInstructions(flow.folder.path, name) });
    }
  }

  /** A sign-in's state. */
  authState(id: string): McpAuthState {
    const flow = this.#auth.get(id);
    if (!flow) throw new McpError('not-found', `No sign-in ${id}`);
    return flow.state;
  }

  /** The redirect URL pasted back (the browser could not reach the CLI's localhost callback): `mcp_oauth_callback_url`. */
  async submitCallback(id: string, callbackUrl: unknown): Promise<McpAuthState> {
    const flow = this.#auth.get(id);
    if (!flow) throw new McpError('not-found', `No sign-in ${id}`);
    if (typeof callbackUrl !== 'string' || !/^https?:\/\//i.test(callbackUrl.trim())) throw new McpError('invalid', 'Paste the full redirect URL from the browser (it starts with http).', { field: 'callbackUrl' });
    if (flow.state.state !== 'waiting' || !flow.helper) throw new McpError('invalid', 'This sign-in is no longer waiting', { field: 'callbackUrl' });
    const answer = await flow.helper.request('mcp_oauth_callback_url', { serverName: flow.state.server, callbackUrl: callbackUrl.trim() }, 60_000);
    if (!answer.ok) throw new McpError('invalid', answer.error, { field: 'callbackUrl' });
    return flow.state;
  }

  /** Cancels a sign-in and stops its helper. */
  async cancelAuth(id: string): Promise<McpAuthState> {
    const flow = this.#auth.get(id);
    if (!flow) throw new McpError('not-found', `No sign-in ${id}`);
    await this.#finish(flow, { state: 'cancelled' });
    return flow.state;
  }

  /** Stops every helper (sign-ins in progress are cancelled). */
  async close(): Promise<void> {
    this.#closed = true;
    for (const flow of this.#auth.values()) await this.#finish(flow, { state: 'cancelled' });
    await Promise.all([...this.#helpers].map((h) => this.#closeHelper(h)));
  }
}

function editableScope(scope: string): McpEditableScope {
  if (!EDITABLE.has(scope)) throw new McpError('read-only', `A ${scope} server is not managed here (only local, project and user servers are).`, { field: 'scope' });
  return scope as McpEditableScope;
}

/** How a helper request reads in the command log (`docs/mcp.md` → *Commands*). */
function helperText(subtype: string, fields: Readonly<Record<string, unknown>> = {}): string {
  return `claude ${MCP_HELPER_ARGS.join(' ')} ← control_request ${JSON.stringify({ subtype, ...fields })}`;
}
