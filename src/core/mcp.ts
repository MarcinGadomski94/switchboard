/**
 * D61: the MCP servers page's wire types and the pure rules behind it: which
 * scopes and transports exist, what a server's status is, how secrets are
 * masked before anything reaches the browser, how the CLI's `claude mcp get` /
 * `claude mcp list` text and the `mcp_status` control response are read, and how
 * an Add / Edit form becomes the JSON `claude mcp add-json` takes (`docs/mcp.md`).
 * No I/O here; the service is `src/server/mcp/`.
 */

/** The scopes Switchboard can add to, edit and remove from (the CLI's `--scope`). */
export const MCP_EDITABLE_SCOPES = ['local', 'project', 'user'] as const;
/** One of {@link MCP_EDITABLE_SCOPES}. */
export type McpEditableScope = (typeof MCP_EDITABLE_SCOPES)[number];

/** The transports `claude mcp add-json` accepts (stdio, SSE, HTTP, WebSocket). */
export const MCP_TRANSPORTS = ['stdio', 'http', 'sse', 'ws'] as const;
/** One of {@link MCP_TRANSPORTS}. */
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/**
 * What the page shows for a server:
 * `connected` · `failed` (with an error) · `needs-auth` · `pending` (still connecting
 * when the check ended) · `pending-approval` (a project server not approved yet) ·
 * `rejected` (a project server the developer rejected) · `disabled` (for this
 * folder) · `unchecked` (no check result yet).
 */
export type McpStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'pending-approval' | 'rejected' | 'disabled' | 'unchecked';

/** The text shown in place of a secret. */
export const MASK = '••••';

/** One server as the page lists it (never carries a secret value). */
export interface McpServerView {
  readonly name: string;
  /** `user` · `project` · `local`, or a read-only source's scope (`plugin`, `claudeai`, `managed`, `enterprise`, `dynamic`, …). */
  readonly scope: string;
  /** Switchboard can edit / remove it (a `user`, `project` or `local` server read from its config file). */
  readonly editable: boolean;
  readonly transport: string;
  /** stdio: the command; `null` for URL transports. */
  readonly command: string | null;
  /** stdio: the arguments, secrets masked. */
  readonly args: readonly string[];
  /** URL transports: the URL, credentials and secret-looking query values masked. */
  readonly url: string | null;
  /** The names of the env variables (values never leave the service). */
  readonly envNames: readonly string[];
  /** The names of the headers (values never leave the service). */
  readonly headerNames: readonly string[];
  readonly status: McpStatus;
  /** The CLI's error / issue text for a `failed` server (secrets scrubbed). */
  readonly error: string | null;
  /** How many tools the server offered at the last check, `null` when unknown. */
  readonly tools: number | null;
  /** When the status was checked (ISO), `null` when it comes from the config only. */
  readonly checkedAt: string | null;
  /** The CLI can run an OAuth sign-in for it (HTTP / SSE, or a claude.ai connector). */
  readonly canAuthenticate: boolean;
  /** A project server: its approval state in this folder (`null` for the other scopes). */
  readonly approval: 'approved' | 'pending' | 'rejected' | null;
}

/** `GET /api/mcp?folder=`: one folder's servers. */
export interface McpView {
  /** The folder the list is for. */
  readonly folder: { readonly id: string | null; readonly path: string; readonly label: string | null };
  readonly servers: readonly McpServerView[];
  /** When "Check all" last ran for this folder (ISO), `null` never. */
  readonly checkedAt: string | null;
  /** When an Add / Edit / Remove / Enable / Disable last changed this folder's servers (ISO), `null` never: live sessions pick it up on their next start. */
  readonly changedAt: string | null;
}

/** An env variable or a header on the Edit form: its name, and whether it has a (hidden) value. */
export interface McpSecretEntry {
  readonly name: string;
  readonly set: boolean;
}

/** `GET /api/mcp/servers/{name}?folder=&scope=`: what the Edit form starts from (no secret values). */
export interface McpServerDefinition {
  readonly name: string;
  readonly scope: McpEditableScope;
  readonly transport: McpTransport;
  readonly command: string | null;
  /** Masked like the list; a masked item posted back unchanged keeps its value. */
  readonly args: readonly string[];
  /** Masked like the list; posted back unchanged it keeps its value. */
  readonly url: string | null;
  readonly env: readonly McpSecretEntry[];
  readonly headers: readonly McpSecretEntry[];
}

/** An env variable or a header on a posted form: a new `value`, or `keep: true` (the stored value stays, never sent). */
export interface McpSecretInput {
  readonly name: string;
  readonly value?: string;
  readonly keep?: boolean;
}

/** `POST /api/mcp/servers` / `PUT /api/mcp/servers/{name}`: the Add / Edit form. */
export interface McpServerInput {
  readonly name: string;
  readonly scope: McpEditableScope;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly env?: readonly McpSecretInput[];
  readonly headers?: readonly McpSecretInput[];
}

/** What an action answers: the refreshed list, the CLI command it ran (secrets masked) and its output. */
export interface McpActionResult {
  readonly view: McpView;
  /** The commands the action ran, as a developer would type them, secrets masked (`docs/mcp.md` → *Commands*). */
  readonly commands: readonly string[];
  /** A short outcome line (the CLI's own words where it printed some). */
  readonly message: string | null;
}

/** An OAuth sign-in in progress (`POST /api/mcp/servers/{name}/auth`, `GET /api/mcp/auth/{id}`). */
export interface McpAuthState {
  readonly id: string;
  readonly server: string;
  /** `waiting`: open `authUrl` and finish in the browser · `done` · `failed` · `cancelled`. */
  readonly state: 'waiting' | 'done' | 'failed' | 'cancelled';
  /** The URL to open (the CLI's `authUrl`), `null` when none is needed or it failed. */
  readonly authUrl: string | null;
  /** The CLI listens for the browser's redirect on this machine's localhost (`true`); else the redirect URL must be pasted back. */
  readonly callbackExpected: boolean;
  readonly error: string | null;
  /** Shown when the sign-in cannot run headlessly: what to do in a terminal. */
  readonly instructions: string | null;
}

/** A field error of a posted form (422). */
export interface McpFieldError {
  readonly field: string;
  readonly message: string;
}

/** A server's stored definition (a `mcpServers` entry in a config file). Unknown keys (oauth, timeout, …) are kept. */
export type McpRawConfig = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------- masking

/** Names (of a query parameter, a flag, an env variable) whose values count as secrets. */
const SECRET_NAME = /(token|secret|passw(or)?d|pwd|api[-_]?key|apikey|access[-_]?key|auth|credential|session|signature|bearer|private|cookie|^key$|^sig$|^code$)/i;

/** `true` when `name` looks like it names a secret (`API_KEY`, `access_token`, `--password`). */
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name.replace(/^-+/, ''));
}

/** A URL with its user info and secret-looking query values (and a `#access_token=` fragment) masked. */
export function maskUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL: mask `name=value` pairs that look like secrets.
    return url.replace(/([A-Za-z0-9_.-]+)=([^&#\s]+)/g, (whole, name: string) => (isSecretName(name) ? `${name}=${MASK}` : whole));
  }
  let out = url;
  if (parsed.password) out = out.replace(`:${parsed.password}@`, `:${MASK}@`);
  else if (parsed.username) out = out.replace(`${parsed.username}@`, `${MASK}@`);
  const pairs = (text: string): string =>
    text.replace(/([^?&#=]+)=([^&#]*)/g, (whole, name: string, value: string) => {
      let decoded = name;
      try {
        decoded = decodeURIComponent(name);
      } catch {
        // keep the raw name
      }
      return isSecretName(decoded) && value !== '' ? `${name}=${MASK}` : whole;
    });
  const hash = out.indexOf('#');
  const query = out.indexOf('?');
  const head = query === -1 ? (hash === -1 ? out : out.slice(0, hash)) : out.slice(0, query);
  const rest = out.slice(head.length);
  return head + pairs(rest);
}

/**
 * Arguments with their secrets masked: `--token=x` / `--api-key x` (a secret-looking
 * flag's value), `NAME=x` for a secret-looking NAME, `Bearer x`, and URLs (as
 * {@link maskUrl}).
 */
export function maskArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const previous = i > 0 ? (args[i - 1] ?? '') : '';
    if (/^-{1,2}[^=\s]+$/.test(previous) && isSecretName(previous) && !arg.startsWith('-')) {
      out.push(MASK);
      continue;
    }
    const eq = /^(-{0,2}[A-Za-z0-9_.-]+)=(.+)$/s.exec(arg);
    if (eq && isSecretName(eq[1] as string)) {
      out.push(`${eq[1] as string}=${MASK}`);
      continue;
    }
    if (/^bearer\s+\S+/i.test(arg)) {
      out.push(`${arg.split(/\s+/)[0] as string} ${MASK}`);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
      out.push(maskUrl(arg));
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * Puts the stored values back where the form posted a masked item unchanged: for
 * each index, a posted value equal to the masked original (and different from the
 * original) becomes the original. Anything else is taken as typed.
 */
export function restoreMaskedArgs(posted: readonly string[], original: readonly string[]): string[] {
  const masked = maskArgs(original);
  return posted.map((value, i) => (i < original.length && value === masked[i] && masked[i] !== original[i] ? (original[i] as string) : value));
}

/** The stored URL when the form posted its masked form unchanged, else the posted URL. */
export function restoreMaskedUrl(posted: string, original: string | null): string {
  if (original !== null && posted === maskUrl(original)) return original;
  return posted;
}

/** The secret values of a stored definition (env and header values, masked args and URL parts), for {@link scrubSecrets}. */
export function secretValues(config: McpRawConfig): string[] {
  const values: string[] = [];
  for (const key of ['env', 'headers']) {
    const record = config[key];
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      for (const value of Object.values(record)) if (typeof value === 'string') values.push(value);
    }
  }
  const args = Array.isArray(config['args']) ? (config['args'] as unknown[]).filter((a): a is string => typeof a === 'string') : [];
  const masked = maskArgs(args);
  args.forEach((arg, i) => {
    if (masked[i] !== arg) {
      const eq = arg.indexOf('=');
      values.push(eq > 0 && masked[i]?.endsWith(MASK) ? arg.slice(eq + 1) : arg);
    }
  });
  const url = typeof config['url'] === 'string' ? config['url'] : null;
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.password) values.push(parsed.password);
      for (const [name, value] of parsed.searchParams) if (isSecretName(name) && value) values.push(value);
    } catch {
      // nothing more to collect
    }
  }
  return values.filter((v) => v.length >= 4);
}

/** `text` with every value of `secrets` replaced by {@link MASK} (errors and outputs shown verbatim otherwise). */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 4) out = out.split(secret).join(MASK);
  }
  // A header or env line the CLI printed (`Authorization: Bearer …`, `API_KEY=…`) whose value we did not know.
  out = out.replace(/(authorization:\s*)(bearer\s+)?\S+/gi, (_w, head: string, bearer: string | undefined) => `${head}${bearer ?? ''}${MASK}`);
  return out;
}

// ---------------------------------------------------------------- views of a config

/** The transport of a stored definition (`type`, or `stdio` when it has a `command`). */
export function transportOf(config: McpRawConfig): string {
  const type = config['type'];
  if (typeof type === 'string' && type !== '') return type === 'streamable-http' ? 'http' : type;
  return typeof config['command'] === 'string' ? 'stdio' : 'unknown';
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) if (typeof v === 'string') out[key] = v;
  return out;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The display parts of a stored definition, secrets masked (what {@link McpServerView} carries about the config). */
export function describeConfig(config: McpRawConfig): Pick<McpServerView, 'transport' | 'command' | 'args' | 'url' | 'envNames' | 'headerNames' | 'canAuthenticate'> {
  const transport = transportOf(config);
  const url = typeof config['url'] === 'string' ? maskUrl(config['url']) : null;
  return {
    transport,
    command: typeof config['command'] === 'string' ? config['command'] : null,
    args: maskArgs(stringArray(config['args'])),
    url,
    envNames: Object.keys(stringRecord(config['env'])),
    headerNames: Object.keys(stringRecord(config['headers'])),
    canAuthenticate: transport === 'http' || transport === 'sse' || transport === 'claudeai-proxy',
  };
}

/** The Edit form's starting point for a stored definition (no secret values). */
export function definitionOf(name: string, scope: McpEditableScope, config: McpRawConfig): McpServerDefinition {
  const transport = transportOf(config);
  const env = stringRecord(config['env']);
  const headers = stringRecord(config['headers']);
  return {
    name,
    scope,
    transport: (MCP_TRANSPORTS as readonly string[]).includes(transport) ? (transport as McpTransport) : 'stdio',
    command: typeof config['command'] === 'string' ? config['command'] : null,
    args: maskArgs(stringArray(config['args'])),
    url: typeof config['url'] === 'string' ? maskUrl(config['url']) : null,
    env: Object.entries(env).map(([n, v]) => ({ name: n, set: v !== '' })),
    headers: Object.entries(headers).map(([n, v]) => ({ name: n, set: v !== '' })),
  };
}

// ---------------------------------------------------------------- validation and the add-json definition

/** The CLI's server-name rule (`claude mcp add` / `add-json`, CLI 2.1.285). */
export const SERVER_NAME = /^[a-zA-Z0-9_-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 7230 token: the header-name rule the CLI checks. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A posted form, parsed: the input or the field errors (422). */
export type ParsedServerInput = { readonly ok: true; readonly input: McpServerInput } | { readonly ok: false; readonly errors: readonly McpFieldError[] };

function secretEntries(field: 'env' | 'headers', raw: unknown, errors: McpFieldError[]): McpSecretInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push({ field, message: `${field} must be a list` });
    return [];
  }
  const out: McpSecretInput[] = [];
  const seen = new Set<string>();
  raw.forEach((entry: unknown, i) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const name = typeof item['name'] === 'string' ? item['name'].trim() : '';
    const label = field === 'env' ? 'Environment variable' : 'Header';
    if (name === '') {
      errors.push({ field: `${field}.${i}`, message: `${label} name is required` });
      return;
    }
    const rule = field === 'env' ? ENV_NAME : HEADER_NAME;
    if (!rule.test(name)) {
      errors.push({ field: `${field}.${i}`, message: field === 'env' ? `Invalid environment variable name: "${name}"` : `Invalid header: "${name}". Header name cannot be empty or contain spaces or colons.` });
      return;
    }
    if (seen.has(name.toLowerCase())) {
      errors.push({ field: `${field}.${i}`, message: `${label} "${name}" is listed twice` });
      return;
    }
    seen.add(name.toLowerCase());
    if (item['keep'] === true) {
      out.push({ name, keep: true });
      return;
    }
    const value = typeof item['value'] === 'string' ? item['value'] : '';
    if (/[\r\n]/.test(value)) {
      errors.push({ field: `${field}.${i}`, message: `${label} "${name}" must be one line` });
      return;
    }
    out.push({ name, value });
  });
  return out;
}

/**
 * Checks a posted Add / Edit form against the CLI's own rules (`docs/mcp.md` →
 * *Validation*): the name (letters, digits, `-`, `_`), the scope (local, user,
 * project), the transport (stdio, sse, http, ws), a command for stdio, an
 * http(s) URL for http / sse and a ws(s) URL for ws, env names, header names.
 */
export function parseServerInput(body: unknown): ParsedServerInput {
  const raw = (body ?? {}) as Record<string, unknown>;
  const errors: McpFieldError[] = [];
  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (name === '') errors.push({ field: 'name', message: 'Server name is required.' });
  else if (!SERVER_NAME.test(name)) errors.push({ field: 'name', message: `Invalid name ${name}. Names can only contain letters, numbers, hyphens, and underscores.` });
  const scope = raw['scope'];
  if (typeof scope !== 'string' || !(MCP_EDITABLE_SCOPES as readonly string[]).includes(scope)) {
    errors.push({ field: 'scope', message: `Invalid scope: ${String(scope)}. Must be one of: local, user, project` });
  }
  const transport = raw['transport'];
  if (typeof transport !== 'string' || !(MCP_TRANSPORTS as readonly string[]).includes(transport)) {
    errors.push({ field: 'transport', message: `Invalid transport type: ${String(transport)}. Must be one of: stdio, sse, http, ws` });
  }
  let command: string | undefined;
  let args: string[] | undefined;
  let url: string | undefined;
  if (transport === 'stdio') {
    command = typeof raw['command'] === 'string' ? raw['command'].trim() : '';
    if (command === '') errors.push({ field: 'command', message: 'Command is required for a stdio server.' });
    const rawArgs = raw['args'];
    if (rawArgs !== undefined && (!Array.isArray(rawArgs) || !rawArgs.every((a) => typeof a === 'string'))) errors.push({ field: 'args', message: 'args must be a list of strings' });
    else args = ((rawArgs as string[] | undefined) ?? []).filter((a) => a !== '');
  } else if (transport === 'http' || transport === 'sse' || transport === 'ws') {
    url = typeof raw['url'] === 'string' ? raw['url'].trim() : '';
    if (url === '') errors.push({ field: 'url', message: `URL is required for ${transport} transport.` });
    else if (!url.includes(MASK)) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(url);
      } catch {
        errors.push({ field: 'url', message: `Invalid URL: ${url}` });
      }
      const schemes = transport === 'ws' ? ['ws:', 'wss:'] : ['http:', 'https:'];
      if (parsed && !schemes.includes(parsed.protocol)) errors.push({ field: 'url', message: `A ${transport} server needs a ${schemes.map((s) => s.replace(':', '')).join(' or ')} URL.` });
    }
  }
  const env = transport === 'stdio' ? secretEntries('env', raw['env'], errors) : [];
  const headers = transport === 'stdio' ? [] : secretEntries('headers', raw['headers'], errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      name,
      scope: scope as McpEditableScope,
      transport: transport as McpTransport,
      ...(command !== undefined ? { command } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(env.length > 0 ? { env } : {}),
      ...(headers.length > 0 ? { headers } : {}),
    },
  };
}

/** Thrown by {@link buildDefinition} when a `keep` names a value the stored definition does not have. */
export class McpKeepError extends Error {
  override name = 'McpKeepError';
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/**
 * The JSON `claude mcp add-json` gets for a form: `{type:"stdio",command,args,env}`
 * or `{type,url,headers}`. With `original` (an edit) masked args / URL posted back
 * unchanged and `keep: true` entries take the stored values, and the keys the form
 * does not show (`oauth`, `timeout`, …) are carried over for the same transport.
 * @throws {McpKeepError} a kept value the stored definition does not have.
 */
export function buildDefinition(input: McpServerInput, original: McpRawConfig | null): Record<string, unknown> {
  const originalEnv = stringRecord(original?.['env']);
  const originalHeaders = stringRecord(original?.['headers']);
  const resolve = (field: 'env' | 'headers', entries: readonly McpSecretInput[] | undefined, stored: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const entry of entries ?? []) {
      if (entry.keep) {
        const kept = stored[entry.name];
        if (kept === undefined) throw new McpKeepError(field, `${entry.name} has no stored value to keep; type a value`);
        out[entry.name] = kept;
      } else {
        out[entry.name] = entry.value ?? '';
      }
    }
    return out;
  };
  const extras: Record<string, unknown> = {};
  if (original && transportOf(original) === input.transport) {
    for (const [key, value] of Object.entries(original)) {
      if (!['type', 'command', 'args', 'env', 'url', 'headers'].includes(key)) extras[key] = value;
    }
  }
  if (input.transport === 'stdio') {
    const args = original ? restoreMaskedArgs(input.args ?? [], stringArray(original['args'])) : [...(input.args ?? [])];
    if (args.some((a) => a.includes(MASK))) throw new McpKeepError('args', 'An argument still holds the ••• placeholder of a different value; type it again');
    const env = resolve('env', input.env, originalEnv);
    return { type: 'stdio', command: input.command ?? '', args, ...(Object.keys(env).length > 0 ? { env } : {}), ...extras };
  }
  const url = restoreMaskedUrl(input.url ?? '', typeof original?.['url'] === 'string' ? original['url'] : null);
  if (url.includes(MASK)) throw new McpKeepError('url', 'The URL still holds the ••• placeholder; type the full URL');
  const headers = resolve('headers', input.headers, originalHeaders);
  return { type: input.transport, url, ...(Object.keys(headers).length > 0 ? { headers } : {}), ...extras };
}

// ---------------------------------------------------------------- reading the CLI

/** A status read from the CLI (`mcp get` / `mcp list` text, or an `mcp_status` row). */
export interface CliStatus {
  readonly status: McpStatus;
  readonly error: string | null;
}

/**
 * Maps the status text `claude mcp get` / `list` print (CLI 2.1.285:
 * `✓ Connected`, `! Connected · tools fetch failed`, `! Needs authentication`,
 * `✗ Failed to connect`, `✗ Connection error`, `- Not configured`,
 * `⏸ Pending approval (run \`claude\` to approve)`, `✗ Rejected (see disabledMcpjsonServers in settings)`,
 * `⊘ Disabled for this project (re-enable via /mcp)`) and its issue line.
 */
export function statusFromText(text: string, issue: string | null = null): CliStatus {
  const t = text.trim();
  if (/needs authentication/i.test(t)) return { status: 'needs-auth', error: issue };
  if (/pending approval/i.test(t)) return { status: 'pending-approval', error: null };
  if (/rejected/i.test(t)) return { status: 'rejected', error: null };
  if (/disabled/i.test(t)) return { status: 'disabled', error: null };
  if (/connected/i.test(t) && /tools fetch failed/i.test(t)) return { status: 'failed', error: issue ?? 'Connected, but the tools fetch failed' };
  if (/connected/i.test(t)) return { status: 'connected', error: null };
  if (/not configured/i.test(t)) return { status: 'failed', error: issue ?? 'Not configured' };
  return { status: 'failed', error: issue ?? t.replace(/^[^A-Za-z]+/, '') };
}

/** `claude mcp get <name>` stdout: the `Status:` and `Issue:` lines (nothing else is read: the rest can hold secrets). */
export function parseGetOutput(text: string): CliStatus | null {
  let status: string | null = null;
  let issue: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+(Status|Issue):\s(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'Status' && status === null) status = m[2] as string;
    else if (m[1] === 'Issue' && issue === null) issue = (m[2] as string).trim();
  }
  return status === null ? null : statusFromText(status, issue);
}

/** One `claude mcp list` row: `<name>: <command or URL> - <status>[ — <issue>]`. */
export interface ListedServer extends CliStatus {
  readonly name: string;
}

const STATUS_MARK = /\s-\s((?:✓|✔|✗|✘|×|!|-|⏸|⊘)\s.*)$/;

/** Parses `claude mcp list` stdout (CLI 2.1.285: one line per server, after "Checking MCP server health…"). */
export function parseListOutput(text: string): ListedServer[] {
  const out: ListedServer[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const colon = line.indexOf(': ');
    if (colon <= 0) continue;
    const mark = STATUS_MARK.exec(line);
    if (!mark) continue;
    const name = line.slice(0, colon).trim();
    if (name === '' || /\s/.test(name)) continue;
    const statusPart = mark[1] as string;
    const dash = statusPart.indexOf(' — ');
    const statusText = dash === -1 ? statusPart : statusPart.slice(0, dash);
    const issue = dash === -1 ? null : statusPart.slice(dash + 3).trim();
    out.push({ name, ...statusFromText(statusText, issue) });
  }
  return out;
}

/** One `mcp_status` row (the control response's `mcpServers[]`, CLI 2.1.285 `McpServerStatus`). */
export interface StatusRow extends CliStatus {
  readonly name: string;
  readonly scope: string | null;
  readonly source: string | null;
  readonly tools: number | null;
  /** The row's `config` (may hold secrets: never sent on as is). */
  readonly config: McpRawConfig | null;
}

/** Reads the `mcp_status` response (`{mcpServers:[{name,status,error?,error_code?,config?,scope?,source?,tools?}]}`). */
export function parseStatusResponse(response: unknown): StatusRow[] {
  const list = (response as { mcpServers?: unknown } | null)?.mcpServers;
  if (!Array.isArray(list)) return [];
  const out: StatusRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const name = typeof row['name'] === 'string' ? row['name'] : '';
    if (name === '') continue;
    const raw = typeof row['status'] === 'string' ? row['status'] : '';
    const error = typeof row['error'] === 'string' ? row['error'] : null;
    let status: McpStatus;
    if (row['error_code'] === 'APPROVAL_REQUIRED') status = 'pending-approval';
    else if (raw === 'connected' || raw === 'failed' || raw === 'needs-auth' || raw === 'pending' || raw === 'disabled') status = raw;
    else status = 'failed';
    const config = row['config'] && typeof row['config'] === 'object' && !Array.isArray(row['config']) ? (row['config'] as McpRawConfig) : null;
    out.push({
      name,
      status,
      error: status === 'failed' ? (error ?? 'Failed to connect') : null,
      scope: typeof row['scope'] === 'string' ? row['scope'] : null,
      source: typeof row['source'] === 'string' ? row['source'] : null,
      tools: Array.isArray(row['tools']) ? row['tools'].length : null,
      config,
    });
  }
  return out;
}

// ---------------------------------------------------------------- commands as text

/** Quotes one argv item for display (`'…'` when it has spaces or shell characters). */
function quote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** An argv as a developer would type it (`claude mcp remove acme -s user`), `secrets` masked. */
export function commandText(argv: readonly string[], secrets: readonly string[] = []): string {
  return scrubSecrets(['claude', ...argv].map(quote).join(' '), secrets);
}

/** The terminal instructions shown when an OAuth sign-in cannot run from the page. */
export function authInstructions(folderPath: string, server: string): string {
  return `Run \`claude\` in a terminal in ${folderPath} and use /mcp → ${server} → Authenticate (or run \`claude mcp login ${server}\` there).`;
}
