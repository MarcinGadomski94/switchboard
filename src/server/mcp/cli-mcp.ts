import type { CliMcpServer, CliMcpServerInput, CliMcpView } from '../../core/api.ts';
import { CLI_LABELS, type CliProviderId } from '../../core/cli-providers.ts';
import { maskArgs, maskUrl } from '../../core/mcp.ts';
import type { CliRegistry } from '../cli/registry.ts';
import type { CliStatusService } from '../cli/status.ts';
import { type RunResult, failureText, runCommand, succeeded } from '../exec.ts';
import { childEnv } from '../supervisor/argv.ts';

/**
 * D62 P7 (`docs/providers.md` → *MCP*): the MCP servers of Codex CLI and OpenCode,
 * through their own CLIs only (argv arrays, time-limited; their config files are
 * never written by Switchboard):
 * - Codex: `codex mcp list --json` (VERIFIED `codex-rs/cli/src/mcp_cmd.rs`),
 *   `codex mcp add <name> [--env K=V …] -- <command> <args…>` / `--url <url>`,
 *   `codex mcp remove <name>` (the `add` syntax is ASSUMED D62-codex-mcp-add, probe 10);
 * - OpenCode: `opencode mcp list` (its text: `<icon> <name> <status>` + the target
 *   on the next line); its `mcp add` is interactive, so Add / Remove are not
 *   offered (edit `opencode.json`, the page says so).
 */

/** Codex's names for the MCP list's JSON (`[{name, enabled, transport: {type, command, args, env, url}}]`). */
export function parseCodexMcpList(stdout: string): CliMcpServer[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: CliMcpServer[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row['name'] === 'string' ? row['name'] : null;
    const transport = typeof row['transport'] === 'object' && row['transport'] !== null ? (row['transport'] as Record<string, unknown>) : {};
    if (!name) continue;
    const http = transport['type'] === 'streamable_http' || typeof transport['url'] === 'string';
    const args = Array.isArray(transport['args']) ? transport['args'].filter((arg): arg is string => typeof arg === 'string') : [];
    const command = typeof transport['command'] === 'string' ? transport['command'] : '';
    const env = typeof transport['env'] === 'object' && transport['env'] !== null ? Object.keys(transport['env'] as object) : [];
    out.push({
      name,
      transport: http ? 'http' : 'stdio',
      target: http ? maskUrl(String(transport['url'] ?? '')) : maskArgs([command, ...args]).join(' '),
      envNames: env.sort(),
      enabled: row['enabled'] !== false,
      status: typeof row['auth_status'] === 'string' && row['auth_status'] !== 'unsupported' ? `auth: ${row['auth_status']}` : null,
    });
  }
  return out;
}

/** OpenCode's `mcp list` text (`✓ name connected` + `    <target>`; `No MCP servers configured`). */
export function parseOpencodeMcpList(stdout: string): CliMcpServer[] {
  // eslint-disable-next-line no-control-regex
  const lines = stdout.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').split(/\r?\n/);
  const out: CliMcpServer[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const head = /^\s*[✓○⚠✗•]\s+(\S+)\s*(.*)$/.exec(lines[index] ?? '');
    if (!head) continue;
    const target = (lines[index + 1] ?? '').trim();
    const status = (head[2] ?? '').trim() || null;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
    out.push({ name: head[1] as string, transport: url ? 'http' : 'stdio', target: url ? maskUrl(target) : maskArgs(target.split(/\s+/).filter(Boolean)).join(' '), envNames: [], enabled: status !== 'disabled', status });
    if (target !== '' && !/^\s*[✓○⚠✗•]\s/.test(lines[index + 1] ?? '')) index += 1;
  }
  return out;
}

/** A refusal the route sends as it is. */
export class CliMcpError extends Error {
  override name = 'CliMcpError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The Codex `mcp add` argv for a server (`--env K=V` for each variable; `--` before a command). */
export function codexAddArgs(input: CliMcpServerInput): string[] {
  const env = Object.entries(input.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  if (input.url) return ['mcp', 'add', input.name, ...env, '--url', input.url];
  return ['mcp', 'add', input.name, ...env, '--', input.command ?? '', ...(input.args ?? [])];
}

/** Validates `POST /api/mcp/cli/{provider}/servers`. */
export function parseCliMcpInput(body: unknown): CliMcpServerInput {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new CliMcpError(422, 'invalid', 'name: letters, digits, `_`, `.`, `-` (not starting with `-`), at most 64 characters');
  const url = typeof record['url'] === 'string' && record['url'].trim() !== '' ? record['url'].trim() : null;
  const command = typeof record['command'] === 'string' && record['command'].trim() !== '' ? record['command'].trim() : null;
  if ((url === null) === (command === null)) throw new CliMcpError(422, 'invalid', 'give either a command (stdio) or a URL (http)');
  if (url !== null && !/^https?:\/\//.test(url)) throw new CliMcpError(422, 'invalid', 'url: an http(s) URL');
  const args = Array.isArray(record['args']) ? record['args'].filter((arg): arg is string => typeof arg === 'string') : [];
  const env: Record<string, string> = {};
  if (typeof record['env'] === 'object' && record['env'] !== null) {
    for (const [key, value] of Object.entries(record['env'] as object)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') throw new CliMcpError(422, 'invalid', `env: ${key} is not a variable name with a text value`);
      env[key] = value;
    }
  }
  return { name, ...(url ? { url } : { command: command as string, args }), env };
}

/** Options of {@link CliMcpService}. */
export interface CliMcpOptions {
  readonly registry: CliRegistry;
  readonly clis: Pick<CliStatusService, 'info'>;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/** D62 P7: the MCP page's Codex CLI and OpenCode sections. */
export class CliMcpService {
  readonly #options: CliMcpOptions;

  constructor(options: CliMcpOptions) {
    this.#options = options;
  }

  async #run(provider: CliProviderId, args: readonly string[], cwd: string): Promise<{ readonly result: RunResult; readonly command: string }> {
    const command = await this.#options.registry.command(provider);
    const result = await runCommand(command, args, { cwd, env: childEnv(this.#options.env ?? process.env), timeoutMs: this.#options.timeoutMs ?? 30_000, maxOutputBytes: 4 * 1024 * 1024 });
    return { result, command: [...command, ...maskArgs(args)].join(' ') };
  }

  async view(provider: Exclude<CliProviderId, 'claude'>, cwd: string): Promise<CliMcpView> {
    const info = await this.#options.clis.info(provider);
    const base = { provider, canEdit: provider === 'codex', editReason: provider === 'codex' ? null : "OpenCode's `mcp add` is interactive: edit the `mcp` block of its opencode.json (or run `opencode mcp add` in a terminal)" };
    if (!info.installed) return { ...base, available: false, reason: info.reason ?? `${CLI_LABELS[provider]} is not installed`, servers: [], command: '' };
    const args = provider === 'codex' ? ['mcp', 'list', '--json'] : ['mcp', 'list'];
    const { result, command } = await this.#run(provider, args, cwd);
    if (!succeeded(result)) return { ...base, available: false, reason: `${command} failed: ${failureText(result)}`, servers: [], command };
    const servers = provider === 'codex' ? parseCodexMcpList(result.stdout) : parseOpencodeMcpList(result.stdout);
    if (servers === null) return { ...base, available: false, reason: `${command} printed no list Switchboard can read`, servers: [], command };
    return { ...base, available: true, reason: null, servers, command };
  }

  async add(provider: Exclude<CliProviderId, 'claude'>, input: CliMcpServerInput, cwd: string): Promise<CliMcpView> {
    if (provider !== 'codex') throw new CliMcpError(409, 'not-available', "Not available in OpenCode: its `mcp add` is interactive; edit the `mcp` block of opencode.json");
    const { result, command } = await this.#run(provider, codexAddArgs(input), cwd);
    if (!succeeded(result)) throw new CliMcpError(409, 'cli-failed', `${command}: ${failureText(result)}`);
    return this.view(provider, cwd);
  }

  async remove(provider: Exclude<CliProviderId, 'claude'>, name: string, cwd: string): Promise<CliMcpView> {
    if (provider !== 'codex') throw new CliMcpError(409, 'not-available', "Not available in OpenCode: edit the `mcp` block of opencode.json");
    const { result, command } = await this.#run(provider, ['mcp', 'remove', name], cwd);
    if (!succeeded(result)) throw new CliMcpError(409, 'cli-failed', `${command}: ${failureText(result)}`);
    return this.view(provider, cwd);
  }
}
