/**
 * D61: the fake's MCP surface (`docs/fake-claude.md` → *MCP*), modelled on CLI
 * 2.1.285 (help text and code read; `claude mcp list/get` were never run against
 * a real config):
 *
 * - `claude mcp get <name>` / `mcp list` / `mcp add-json <name> <json> [-s scope]` /
 *   `mcp remove <name> [-s scope]`, over the same files as the real CLI:
 *   `$CLAUDE_CONFIG_DIR/.claude.json` (else `$HOME/.claude.json`) → `mcpServers`
 *   (user) and `projects[<cwd>].mcpServers` (local), `<cwd>/.mcp.json` (project);
 * - the control requests `mcp_status`, `mcp_reconnect`, `mcp_toggle`
 *   (`projects[<cwd>].disabledMcpServers`), `mcp_authenticate` (a local
 *   "authorization server" on 127.0.0.1 whose `/authorize` page redirects to its
 *   `/callback`, which completes the sign-in), `mcp_oauth_callback_url` and
 *   `mcp_clear_auth`.
 *
 * What a server's health is comes from a state file, `FAKE_CLAUDE_MCP_STATE`
 * (default `<config dir>/fake-mcp-state.json`):
 * `{ "authenticated": [names], "status": { name: { "status", "error"?, "tools"? } }, "plugins": [{ "name", "status", "url"? }], "failAdd": bool }`.
 * Defaults: stdio and ws connect (3 / 1 tools), HTTP / SSE need authentication
 * until signed in (then 2 tools); a project server needs approval unless
 * `enableAllProjectMcpServers` / `enabledMcpjsonServers` says otherwise.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

type Json = Record<string, unknown>;
type Scope = 'local' | 'project' | 'user';

interface ServerEntry {
  readonly name: string;
  readonly scope: Scope;
  readonly config: Json;
}

interface Health {
  readonly status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  readonly error?: string;
  readonly errorCode?: string;
  readonly tools: number;
}

function home(env: NodeJS.ProcessEnv): string {
  return env['HOME']?.trim() || env['USERPROFILE']?.trim() || '/';
}

function configDir(env: NodeJS.ProcessEnv): string {
  const dir = env['CLAUDE_CONFIG_DIR']?.trim();
  return dir ? path.resolve(dir) : path.join(home(env), '.claude');
}

/** The global config file (`.claude.json`) the fake reads and writes. */
export function globalFile(env: NodeJS.ProcessEnv): string {
  const dir = env['CLAUDE_CONFIG_DIR']?.trim();
  return path.join(dir ? path.resolve(dir) : home(env), '.claude.json');
}

function stateFile(env: NodeJS.ProcessEnv): string {
  return env['FAKE_CLAUDE_MCP_STATE']?.trim() || path.join(configDir(env), 'fake-mcp-state.json');
}

async function readJson(file: string): Promise<Json> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

async function writeJson(file: string, value: Json): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function rec(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Every configured server for `cwd`, local first (the CLI's precedence), then project, then user. */
async function servers(env: NodeJS.ProcessEnv, cwd: string): Promise<ServerEntry[]> {
  const global = await readJson(globalFile(env));
  const project = rec(rec(global['projects'])[cwd]);
  const mcpJson = await readJson(path.join(cwd, '.mcp.json'));
  const out: ServerEntry[] = [];
  for (const [name, config] of Object.entries(rec(project['mcpServers']))) out.push({ name, scope: 'local', config: rec(config) });
  for (const [name, config] of Object.entries(rec(mcpJson['mcpServers']))) out.push({ name, scope: 'project', config: rec(config) });
  for (const [name, config] of Object.entries(rec(global['mcpServers']))) out.push({ name, scope: 'user', config: rec(config) });
  return out;
}

function effective(list: readonly ServerEntry[]): ServerEntry[] {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}

async function approval(env: NodeJS.ProcessEnv, cwd: string, name: string): Promise<'approved' | 'pending' | 'rejected'> {
  const global = await readJson(globalFile(env));
  const project = rec(rec(global['projects'])[cwd]);
  const sources = [project, await readJson(path.join(configDir(env), 'settings.json')), await readJson(path.join(cwd, '.claude', 'settings.json')), await readJson(path.join(cwd, '.claude', 'settings.local.json'))];
  if (sources.some((s) => names(s['disabledMcpjsonServers']).includes(name))) return 'rejected';
  if (sources.some((s) => s['enableAllProjectMcpServers'] === true || names(s['enabledMcpjsonServers']).includes(name))) return 'approved';
  return 'pending';
}

async function disabled(env: NodeJS.ProcessEnv, cwd: string): Promise<Set<string>> {
  const global = await readJson(globalFile(env));
  return new Set(names(rec(rec(global['projects'])[cwd])['disabledMcpServers']));
}

function transport(config: Json): string {
  const type = config['type'];
  return typeof type === 'string' ? type : 'stdio';
}

async function health(env: NodeJS.ProcessEnv, cwd: string, entry: ServerEntry): Promise<Health> {
  if ((await disabled(env, cwd)).has(entry.name)) return { status: 'disabled', tools: 0 };
  if (entry.scope === 'project') {
    const state = await approval(env, cwd, entry.name);
    if (state !== 'approved') return { status: 'failed', error: state === 'rejected' ? 'Rejected' : 'Pending approval', errorCode: 'APPROVAL_REQUIRED', tools: 0 };
  }
  const state = await readJson(stateFile(env));
  const override = rec(rec(state['status'])[entry.name]);
  if (typeof override['status'] === 'string') {
    return {
      status: override['status'] as Health['status'],
      ...(typeof override['error'] === 'string' ? { error: override['error'] } : {}),
      tools: typeof override['tools'] === 'number' ? override['tools'] : 0,
    };
  }
  const kind = transport(entry.config);
  if (kind === 'http' || kind === 'sse') {
    return names(state['authenticated']).includes(entry.name) ? { status: 'connected', tools: 2 } : { status: 'needs-auth', tools: 0 };
  }
  return { status: 'connected', tools: kind === 'ws' ? 1 : 3 };
}

const SCOPE_LABEL: Record<Scope, string> = {
  local: 'Local config (private to you in this project)',
  project: 'Project config (shared via .mcp.json)',
  user: 'User config (available in all your projects)',
};

async function statusText(env: NodeJS.ProcessEnv, cwd: string, entry: ServerEntry): Promise<{ status: string; issue?: string }> {
  if ((await disabled(env, cwd)).has(entry.name)) return { status: '⊘ Disabled for this project (re-enable via /mcp)' };
  if (entry.scope === 'project') {
    const state = await approval(env, cwd, entry.name);
    if (state === 'pending') return { status: '⏸ Pending approval (run `claude` to approve)' };
    if (state === 'rejected') return { status: '✗ Rejected (see disabledMcpjsonServers in settings)' };
  }
  const h = await health(env, cwd, entry);
  if (h.status === 'connected') return { status: '✓ Connected' };
  if (h.status === 'needs-auth') return { status: '! Needs authentication' };
  return { status: '✗ Failed to connect', ...(h.error ? { issue: h.error } : {}) };
}

async function out(text: string): Promise<void> {
  await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
}

async function err(text: string): Promise<void> {
  await new Promise<void>((resolve) => process.stderr.write(text, () => resolve()));
}

function scopeFlag(rest: readonly string[]): { scope: string | null; positional: string[] } {
  const positional: string[] = [];
  let scope: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === '-s' || arg === '--scope') {
      scope = rest[i + 1] ?? '';
      i++;
    } else if (arg.startsWith('--scope=')) scope = arg.slice('--scope='.length);
    else positional.push(arg);
  }
  return { scope, positional };
}

async function writeServer(env: NodeJS.ProcessEnv, cwd: string, scope: Scope, name: string, config: Json | null): Promise<string> {
  if (scope === 'project') {
    const file = path.join(cwd, '.mcp.json');
    const doc = await readJson(file);
    const map = { ...rec(doc['mcpServers']) };
    if (config === null) delete map[name];
    else map[name] = config;
    await writeJson(file, { ...doc, mcpServers: map });
    return file;
  }
  const file = globalFile(env);
  const doc = await readJson(file);
  if (scope === 'user') {
    const map = { ...rec(doc['mcpServers']) };
    if (config === null) delete map[name];
    else map[name] = config;
    await writeJson(file, { ...doc, mcpServers: map });
    return file;
  }
  const projects = { ...rec(doc['projects']) };
  const project = { ...rec(projects[cwd]) };
  const map = { ...rec(project['mcpServers']) };
  if (config === null) delete map[name];
  else map[name] = config;
  projects[cwd] = { ...project, mcpServers: map };
  await writeJson(file, { ...doc, projects });
  return `${file} [project: ${cwd}]`;
}

/** `claude mcp …`: returns the exit code. */
export async function runMcpCommand(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'list': {
      const list = effective(await servers(env, cwd));
      if (list.length === 0) {
        await out('No MCP servers configured. Use `claude mcp add` to add a server.\n');
        return 0;
      }
      let text = 'Checking MCP server health…\n\n';
      for (const entry of list) {
        const { status, issue } = await statusText(env, cwd, entry);
        const target = typeof entry.config['url'] === 'string' ? `${entry.config['url']} (${transport(entry.config).toUpperCase()})` : `${String(entry.config['command'] ?? '')} ${names(entry.config['args']).join(' ')}`;
        text += `${entry.name}: ${target} - ${status}${issue ? ` — ${issue}` : ''}\n`;
      }
      await out(text);
      return 0;
    }
    case 'get': {
      const name = rest[0] ?? '';
      const entry = effective(await servers(env, cwd)).find((s) => s.name === name);
      if (!entry) {
        await err(`No MCP server found with name: "${name}".\n`);
        return 1;
      }
      const { status, issue } = await statusText(env, cwd, entry);
      const lines = [`${name}:`, `  Scope: ${SCOPE_LABEL[entry.scope]}`, `  Status: ${status}`, ...(issue ? [`  Issue: ${issue}`] : [])];
      const kind = transport(entry.config);
      if (kind === 'stdio') {
        lines.push('  Type: stdio', `  Command: ${String(entry.config['command'] ?? '')}`, `  Args: ${names(entry.config['args']).join(' ')}`);
        const vars = rec(entry.config['env']);
        if (Object.keys(vars).length > 0) {
          lines.push('  Environment:');
          for (const [k, v] of Object.entries(vars)) lines.push(`    ${k}=${String(v)}`);
        }
      } else {
        lines.push(`  Type: ${kind}`, `  URL: ${String(entry.config['url'] ?? '')}`);
        const headers = rec(entry.config['headers']);
        if (Object.keys(headers).length > 0) {
          lines.push('  Headers:');
          for (const [k, v] of Object.entries(headers)) lines.push(`    ${k}: ${String(v)}`);
        }
      }
      lines.push('', `To remove this server, run: claude mcp remove "${name}" -s ${entry.scope}`);
      await out(`${lines.join('\n')}\n`);
      return 0;
    }
    case 'add-json': {
      const { scope: rawScope, positional } = scopeFlag(rest);
      const [name = '', json = ''] = positional;
      const scope = rawScope ?? 'local';
      if (!['local', 'user', 'project'].includes(scope)) {
        await err(`Invalid scope: ${scope}. Must be one of: local, user, project\n`);
        return 1;
      }
      if (/[^a-zA-Z0-9_-]/.test(name) || name === '') {
        await err(`Invalid name ${name}. Names can only contain letters, numbers, hyphens, and underscores.\n`);
        return 1;
      }
      let config: Json;
      try {
        const parsed: unknown = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        config = parsed as Json;
      } catch {
        await err('Invalid configuration: the JSON could not be parsed\n');
        return 1;
      }
      if ((await readJson(stateFile(env)))['failAdd'] === true) {
        await err('Invalid configuration: fake-claude was told to refuse add-json (failAdd)\n');
        return 1;
      }
      if ((await servers(env, cwd)).some((s) => s.name === name && s.scope === scope)) {
        await err(`MCP server ${name} already exists in ${scope === 'project' ? '.mcp.json' : `${scope} config`}\n`);
        return 1;
      }
      const file = await writeServer(env, cwd, scope as Scope, name, config);
      await out(`Added ${transport(config)} MCP server ${name} to ${scope} config\nFile modified: ${file}\n`);
      return 0;
    }
    case 'remove': {
      const { scope, positional } = scopeFlag(rest);
      const name = positional[0] ?? '';
      const found = (await servers(env, cwd)).filter((s) => s.name === name && (scope === null || s.scope === scope));
      if (found.length === 0) {
        await err(`No ${scope ? `${scope}-scoped ` : ''}MCP server found with name: ${name}\n`);
        return 1;
      }
      if (found.length > 1) {
        await err(`MCP server "${name}" exists in multiple scopes:\n${found.map((f) => `  - ${SCOPE_LABEL[f.scope]}`).join('\n')}\n`);
        return 1;
      }
      const entry = found[0] as ServerEntry;
      const file = await writeServer(env, cwd, entry.scope, name, null);
      await out(`Removed MCP server ${name} from ${entry.scope} config\nFile modified: ${file}\n`);
      return 0;
    }
    default:
      await err(`error: unknown command 'mcp ${sub ?? ''}' (fake-claude)\n`);
      return 1;
  }
}

// ---------------------------------------------------------------- control requests

/** A control request's answer: success with a body, or an error. */
export type McpReply = { readonly ok: true; readonly response: Json } | { readonly ok: false; readonly error: string };

/** The control-request side of the fake's MCP (one per process). */
export class FakeMcp {
  readonly #env: NodeJS.ProcessEnv;
  readonly #cwd: string;
  #server: Server | null = null;
  readonly #flows = new Map<string, string>(); // state → server name

  constructor(env: NodeJS.ProcessEnv, cwd: string) {
    this.#env = env;
    this.#cwd = cwd;
  }

  async #markAuthenticated(name: string, on: boolean): Promise<void> {
    const file = stateFile(this.#env);
    const state = await readJson(file);
    const list = new Set(names(state['authenticated']));
    if (on) list.add(name);
    else list.delete(name);
    await writeJson(file, { ...state, authenticated: [...list] });
  }

  async #entry(name: string): Promise<ServerEntry | undefined> {
    return effective(await servers(this.#env, this.#cwd)).find((s) => s.name === name);
  }

  /** Answers one MCP control request, or `null` when `subtype` is not one. */
  async handle(subtype: string, request: Json): Promise<McpReply | null> {
    const name = typeof request['serverName'] === 'string' ? request['serverName'] : '';
    switch (subtype) {
      case 'mcp_status':
        return { ok: true, response: { mcpServers: await this.#status() } };
      case 'mcp_reconnect': {
        const entry = await this.#entry(name);
        if (!entry) return { ok: false, error: `Server not found: ${name}` };
        const h = await health(this.#env, this.#cwd, entry);
        if (h.status === 'failed') return { ok: false, error: h.error ?? 'Connection failed' };
        if (h.status === 'needs-auth') return { ok: false, error: `MCP server ${name} requires authentication` };
        return { ok: true, response: {} };
      }
      case 'mcp_toggle': {
        const entry = await this.#entry(name);
        if (!entry) return { ok: false, error: `Server not found: ${name}` };
        const file = globalFile(this.#env);
        const doc = await readJson(file);
        const projects = { ...rec(doc['projects']) };
        const project = { ...rec(projects[this.#cwd]) };
        const list = new Set(names(project['disabledMcpServers']));
        if (request['enabled'] === true) list.delete(name);
        else list.add(name);
        projects[this.#cwd] = { ...project, disabledMcpServers: [...list] };
        await writeJson(file, { ...doc, projects });
        return { ok: true, response: {} };
      }
      case 'mcp_clear_auth': {
        const entry = await this.#entry(name);
        if (!entry) return { ok: false, error: `Server not found: ${name}` };
        await this.#markAuthenticated(name, false);
        return { ok: true, response: {} };
      }
      case 'mcp_authenticate': {
        const entry = await this.#entry(name);
        if (!entry) return { ok: false, error: `Server not found: ${name}` };
        const kind = transport(entry.config);
        if (kind !== 'http' && kind !== 'sse') return { ok: false, error: `Server type "${kind}" does not support OAuth authentication` };
        const port = await this.#listen();
        const state = randomBytes(8).toString('hex');
        this.#flows.set(state, name);
        return {
          ok: true,
          response: {
            authUrl: `http://127.0.0.1:${port}/authorize?server=${encodeURIComponent(name)}&state=${state}&redirect_uri=${encodeURIComponent(`http://localhost:${port}/callback`)}`,
            requiresUserAction: true,
            callbackExpected: true,
            redirectScheme: 'localhost',
            state,
            callbackPort: port,
          },
        };
      }
      case 'mcp_oauth_callback_url': {
        let url: URL;
        try {
          url = new URL(String(request['callbackUrl'] ?? ''));
        } catch {
          return { ok: false, error: 'Invalid callback URL: missing authorization code. Please paste the full redirect URL including the code parameter.' };
        }
        const code = url.searchParams.get('code');
        const flowName = this.#flows.get(url.searchParams.get('state') ?? '');
        if (!code) return { ok: false, error: 'Invalid callback URL: missing authorization code. Please paste the full redirect URL including the code parameter.' };
        if (flowName !== name) return { ok: false, error: 'Callback URL not accepted: it belongs to a different sign-in attempt (OAuth state mismatch) or carries no authorization code.' };
        await this.#markAuthenticated(name, true);
        return { ok: true, response: {} };
      }
      default:
        return null;
    }
  }

  async #status(): Promise<Json[]> {
    const rows: Json[] = [];
    for (const entry of effective(await servers(this.#env, this.#cwd))) {
      const h = await health(this.#env, this.#cwd, entry);
      rows.push({
        name: entry.name,
        status: h.status,
        ...(h.error ? { error: h.error } : {}),
        ...(h.errorCode ? { error_code: h.errorCode } : {}),
        config: entry.config,
        scope: entry.scope,
        source: entry.scope,
        ...(h.status === 'connected' ? { tools: Array.from({ length: h.tools }, (_, i) => ({ name: `tool_${i + 1}` })) } : {}),
      });
    }
    const state = await readJson(stateFile(this.#env));
    for (const plugin of Array.isArray(state['plugins']) ? state['plugins'] : []) {
      const p = rec(plugin);
      if (typeof p['name'] !== 'string') continue;
      rows.push({
        name: p['name'],
        status: typeof p['status'] === 'string' ? p['status'] : 'connected',
        config: { type: 'http', url: typeof p['url'] === 'string' ? p['url'] : 'https://mcp.example.com/plugin' },
        scope: 'dynamic',
        source: 'plugin',
        tools: [{ name: 'plugin_tool' }],
      });
    }
    return rows;
  }

  /** The fake authorization server: `/authorize` redirects to `/callback`, which completes the sign-in. */
  async #listen(): Promise<number> {
    if (!this.#server) {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const state = url.searchParams.get('state') ?? '';
        if (url.pathname === '/authorize') {
          res.writeHead(302, { location: `/callback?code=fake-code&state=${encodeURIComponent(state)}` });
          res.end();
          return;
        }
        if (url.pathname === '/callback') {
          const name = this.#flows.get(state);
          if (!name || !url.searchParams.get('code')) {
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end('Unknown sign-in');
            return;
          }
          void this.#markAuthenticated(name, true).then(() => {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<!doctype html><title>Signed in</title><p>Authentication successful. You can close this window.</p>');
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      server.unref();
      this.#server = server;
    }
    const address = this.#server.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  /** Stops the authorization server. */
  close(): void {
    this.#server?.close();
    this.#server = null;
  }
}
