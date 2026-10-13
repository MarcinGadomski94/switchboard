import { isClock } from './hlc.ts';
import type { TeamSynced } from './team.ts';

/**
 * D100-T2 · Team access requests (`docs/team.md` → *Access requests*, contract →
 * *Team access (D100-T2)*): a member's agent asks for the access it needs to fetch
 * data (an MCP server, or an API key), the developer sets it up in the member's
 * Access tab, and Switchboard gives it to **that member's session only**.
 *
 * This module holds the wire types and the pure rules shared by the server, the
 * `request_access` tool and the UI: the record (synced like the other Team records,
 * **never with a secret value**: only names, hosts, field definitions, the keychain
 * reference and where it is set up), the agent's request and its checks, the
 * derived status, the masking pass and the charter lines.
 */

/** What is asked for. */
export const ACCESS_KINDS = ['mcp', 'api-key'] as const;

/** An access kind. */
export type AccessKind = (typeof ACCESS_KINDS)[number];

/** Where an MCP server comes from: the built-in catalog, a custom server the developer describes, or one shared from the MCP page. */
export const ACCESS_MCP_SOURCES = ['catalog', 'custom', 'shared'] as const;

/** An MCP source. */
export type AccessMcpSource = (typeof ACCESS_MCP_SOURCES)[number];

/** An access record's state (the developer's decision and the setup). */
export const ACCESS_STATES = ['requested', 'approved', 'active', 'denied', 'deferred', 'revoked', 'expired'] as const;

/** An access state. */
export type AccessState = (typeof ACCESS_STATES)[number];

/** The keychain service name every Team secret is stored under (the account names the member, the access and the field). */
export const ACCESS_KEYCHAIN_SERVICE = 'Switchboard Team';

/** The argv marker of the access MCP launcher (`src/hook/sb-access-mcp.ts --switchboard-access <port> <sessionId> <accessId>`). */
export const ACCESS_MCP_MARKER = '--switchboard-access';

/** Requests per member per hour (prompt-injection safety: a looping or hijacked agent cannot flood Needs you). */
export const ACCESS_RATE_LIMIT = 5;

/** The rate limit's window. */
export const ACCESS_RATE_WINDOW_MS = 60 * 60_000;

/** At most this many fields per request. */
export const ACCESS_FIELDS_MAX = 10;

/** The audit trail keeps the newest this many entries per access. */
export const ACCESS_AUDIT_MAX = 50;

/** Secret values shorter than this are not masked (they would mask ordinary words); setup refuses them for secret fields. */
export const MASK_MIN_LENGTH = 6;

/**
 * Environment names an access may never set: they change how the CLI, Node, Python,
 * the shell, git, TLS or a proxy behave (an injected `NODE_OPTIONS` or `HTTPS_PROXY`
 * would run code or route traffic elsewhere), or belong to Switchboard and the CLIs.
 */
export const RESERVED_ENV = /^(?:PATH|HOME|USER|LOGNAME|SHELL|TERM|TMPDIR|TEMP|TMP|PWD|LANG|LC_[A-Z_]+|NODE_[A-Z_]*|NPM_[A-Z_]*|LD_[A-Z_]+|DYLD_[A-Z_]+|PYTHON[A-Z_]*|PERL[A-Z0-9_]*|RUBY[A-Z_]*|BASH_ENV|ENV|PROMPT_COMMAND|IFS|SSH_[A-Z_]+|GIT_[A-Z_]+|GNUPGHOME|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|FTP_PROXY|SSL_CERT_[A-Z_]+|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|ANTHROPIC_[A-Z0-9_]*|CLAUDE[A-Z0-9_]*|OPENAI_[A-Z0-9_]*|CODEX_[A-Z0-9_]*|OPENCODE_[A-Z0-9_]*|SWITCHBOARD_[A-Z0-9_]*|FAKE_CLAUDE_[A-Z0-9_]*|XDG_[A-Z_]+|APPDATA|LOCALAPPDATA|USERPROFILE|SYSTEMROOT|COMSPEC|PATHEXT)$/;

/** A field the developer fills (it becomes an environment variable of that name). */
export interface AccessField {
  /** The variable's name (`ACME_ANALYTICS_KEY`): upper case, digits and `_`. */
  readonly name: string;
  /** What the developer sees ("API key"). */
  readonly label: string;
  /** A secret: typed into a password field, kept in the OS keychain, masked in output. */
  readonly secret: boolean;
  /** Where to find it / what it is. */
  readonly help: string;
  /** A page that explains how to get it (https). */
  readonly helpUrl: string | null;
  /** A regular expression the value must match (optional). */
  readonly pattern: string | null;
}

/** An MCP server an access starts (no secret values: `{FIELD}` placeholders are filled from the keychain when it starts). */
export interface AccessMcpServer {
  readonly transport: 'stdio' | 'http';
  /** stdio: the program. */
  readonly command: string | null;
  /** stdio: its arguments (`{FIELD}` placeholders allowed). */
  readonly args: readonly string[];
  /** http: the server's URL. */
  readonly url: string | null;
  /** http: request headers (`{FIELD}` placeholders, e.g. `Authorization: Bearer {ACME_TOKEN}`). */
  readonly headers: Readonly<Record<string, string>>;
}

/** An MCP server shared from the MCP page (D61): read from the developer's own Claude Code configuration when it starts. */
export interface AccessSharedServer {
  readonly name: string;
  readonly scope: 'local' | 'project' | 'user';
}

/** An API key's optional connection test: one HEAD (then GET) to this URL, only on the declared host. */
export interface AccessKeyTest {
  readonly url: string;
  /** One header carrying the key (`{FIELD}` placeholders), e.g. `{ name: 'Authorization', value: 'Bearer {ACME_ANALYTICS_KEY}' }`. */
  readonly header: { readonly name: string; readonly value: string } | null;
}

/** Where a field's value is in the OS keychain (a reference: never the value). */
export interface AccessSecretRef {
  readonly field: string;
  readonly service: string;
  readonly account: string;
}

/** An audit trail entry. */
export interface AccessAuditEntry {
  readonly at: string;
  readonly what: 'asked' | 'approved' | 'denied' | 'deferred' | 'set-up' | 'replaced' | 'used' | 'tested' | 'revoked' | 'expired' | 'removed-here';
  /** The machine it happened on (`null` = not machine-bound). */
  readonly machineId: string | null;
  readonly text: string;
}

/** One access of a member, as stored in `team.db` (`access` table) and synced (last writer wins). No secret value, ever. */
export interface TeamAccessRecord extends TeamSynced {
  readonly id: string;
  readonly teamId: string;
  readonly memberId: string;
  /** The Needs-you request it raised (`requests` table, kind `access`). */
  readonly requestId: string | null;
  readonly kind: AccessKind;
  /** `mcp` only. */
  readonly source: AccessMcpSource | null;
  /** `source: catalog`: the catalog entry. */
  readonly catalogId: string | null;
  /** The service ("Google Analytics"). */
  readonly service: string;
  /** The host it talks to ("analyticsdata.googleapis.com"), as the agent declared it. */
  readonly host: string;
  readonly why: string;
  /** The smallest scope ("read-only, reports"). */
  readonly scope: string;
  readonly fields: readonly AccessField[];
  /** `mcp` (catalog / custom): the server; a custom one is confirmed by the developer at setup. */
  readonly mcp: AccessMcpServer | null;
  /** `mcp` (shared): the MCP page's server. */
  readonly shared: AccessSharedServer | null;
  /** `api-key`: the optional connection test. */
  readonly test: AccessKeyTest | null;
  /** A warning shown on the card (the declared host differs from the catalog entry's), else `null`. */
  readonly warning: string | null;
  readonly state: AccessState;
  /** The machines (D48 ids) whose keychain holds the values. */
  readonly setUpOn: readonly string[];
  /** When it was last set up or replaced (part of the charter line, so a replaced value restarts the member). */
  readonly setUpAt: string | null;
  /** The keychain references (one per field). */
  readonly secretRefs: readonly AccessSecretRef[];
  /** Optional expiry (ISO); past it the access is no longer given to the member. */
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  /** The machine it was last used on. */
  readonly lastUsedOn: string | null;
  readonly audit: readonly AccessAuditEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The derived status the Access tab shows. */
export type AccessStatus = 'requested' | 'ready' | 'needs-setup' | 'denied' | 'not-now' | 'revoked' | 'expired';

/** One access as the API answers it (the record without sync fields, plus what this machine derives). */
export interface TeamAccessEntryView extends Omit<TeamAccessRecord, 'clock' | 'deleted'> {
  readonly status: AccessStatus;
  /** "Ready on Mac", "Set up on Mac only", "Needs setup on PC". */
  readonly statusText: string;
  /** The values are in this machine's keychain. */
  readonly here: boolean;
  /** The machines it is set up on, by name. */
  readonly setUpOnNames: readonly string[];
  /** The member's machine has it (and it is active, not expired): the member gets it. */
  readonly ready: boolean;
  /** Offer "Set up" (or "Set up here too") on this machine. */
  readonly canSetUp: boolean;
  /** The environment variables the member gets (`api-key`), or the MCP server's name (`mcp`). */
  readonly delivers: string;
}

/** `GET /api/team/members/{id}/access`. */
export interface TeamAccessView {
  readonly member: { readonly id: string; readonly name: string; readonly machineId: string; readonly machineName: string; readonly local: boolean };
  readonly self: { readonly id: string; readonly name: string };
  /** The request comes from a paired phone (D73): the tab is read-only, secrets are set up on a computer. */
  readonly device: boolean;
  /** The keychain this machine uses (`macOS Keychain`, …) and whether it can be used. */
  readonly keychain: { readonly name: string; readonly available: boolean; readonly problem: string | null };
  readonly entries: readonly TeamAccessEntryView[];
}

/** `POST /api/team/access/{id}/test` → the outcome. */
export interface AccessTestResult {
  readonly ok: boolean;
  /** One line: "Connected: 12 tools", "HTTP 401", "No test URL declared". */
  readonly detail: string;
  /** MCP: the tool names listed. */
  readonly tools: readonly string[];
}

/** The agent's request (`request_access`), checked. */
export interface AccessRequestInput {
  readonly kind: AccessKind;
  readonly source: AccessMcpSource | null;
  readonly catalogId: string | null;
  readonly service: string;
  readonly host: string;
  readonly why: string;
  readonly scope: string;
  readonly fields: readonly AccessField[];
  readonly mcp: AccessMcpServer | null;
  readonly shared: AccessSharedServer | null;
  readonly test: AccessKeyTest | null;
}

/** A field problem (422 `invalid`). */
export interface AccessFieldError {
  readonly field: string;
  readonly message: string;
}

// ── checks ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text === '' || text.length > max ? null : text;
}

/** An environment variable name an access may set (upper case, 2–64 characters, not {@link RESERVED_ENV}). */
export function isAccessEnvName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) && !RESERVED_ENV.test(value);
}

/**
 * A host as declared: lower case, without scheme, path or credentials (`host` or
 * `host:port`); a URL is reduced to its host. `null` when it is not one.
 */
export function normalizeHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === '' || text.length > 253) return null;
  let host = text;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
    try {
      const url = new URL(text);
      if (url.username || url.password) return null;
      host = url.host;
    } catch {
      return null;
    }
  }
  return /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::\d{1,5})?$/.test(host) ? host : null;
}

/** The host name without the port. */
export function hostName(host: string): string {
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? host);
}

/** `true` for a loopback host (http is allowed there only: tests and local servers). */
export function isLoopbackHost(host: string): boolean {
  const name = hostName(host);
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/**
 * A URL on exactly the declared host (`https`, or `http` on loopback); `null` for
 * anything else. The connection test never talks to another host.
 */
export function urlOnHost(value: unknown, host: string): string | null {
  if (typeof value !== 'string' || value.length > 2_000) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.host))) return null;
  return url.host.toLowerCase() === host ? url.toString() : null;
}

/** An https help URL (shown as a link with its host), else `null`. */
function helpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A field definition (`null` when malformed). */
export function readAccessField(value: unknown): AccessField | null {
  if (!isRecord(value)) return null;
  const name = value['name'];
  if (!isAccessEnvName(name)) return null;
  const label = oneLine(value['label'] ?? name, 80);
  if (!label) return null;
  const help = typeof value['help'] === 'string' ? value['help'].trim().slice(0, 500) : '';
  const rawPattern = value['pattern'];
  let pattern: string | null = null;
  if (typeof rawPattern === 'string' && rawPattern.trim() !== '') {
    if (rawPattern.length > 200) return null;
    try {
      new RegExp(rawPattern);
    } catch {
      return null;
    }
    pattern = rawPattern;
  }
  return { name, label, secret: value['secret'] !== false, help, helpUrl: helpUrl(value['helpUrl']), pattern };
}

/** `{FIELD}` placeholders of a template. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([A-Z][A-Z0-9_]{1,63})\}/g)].map((match) => match[1] as string);
}

/** Fills `{FIELD}` placeholders from `values` (unknown ones stay). */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Z][A-Z0-9_]{1,63})\}/g, (whole, name: string) => values[name] ?? whole);
}

/** An MCP server description (`null` when malformed). Placeholders must name declared fields. */
export function readAccessMcpServer(value: unknown, fieldNames: readonly string[]): AccessMcpServer | null {
  if (!isRecord(value)) return null;
  const transport = value['transport'] === 'http' ? 'http' : value['transport'] === undefined || value['transport'] === 'stdio' ? 'stdio' : null;
  if (!transport) return null;
  const known = (template: string): boolean => placeholders(template).every((name) => fieldNames.includes(name));
  if (transport === 'stdio') {
    const command = typeof value['command'] === 'string' ? value['command'].trim() : '';
    if (command === '' || command.length > 500 || /[\r\n\0]/.test(command)) return null;
    const args = value['args'] ?? [];
    if (!Array.isArray(args) || args.length > 40 || !args.every((a) => typeof a === 'string' && a.length <= 2_000 && !/[\r\n\0]/.test(a) && known(a))) return null;
    return { transport, command, args: args as string[], url: null, headers: {} };
  }
  const url = typeof value['url'] === 'string' ? value['url'].trim() : '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.host))) return null;
  const headers = isRecord(value['headers']) ? value['headers'] : {};
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || typeof template !== 'string' || template.length > 1_000 || /[\r\n]/.test(template) || !known(template)) return null;
    out[name] = template;
  }
  return { transport, command: null, args: [], url: parsed.toString(), headers: out };
}

/**
 * The agent's `request_access` body, checked (`errors` lists every problem). The
 * catalog fills an entry's fields and server: the agent cannot change what a catalog
 * entry runs. A custom server's command is only a suggestion the developer confirms.
 */
export function readAccessRequest(body: unknown, catalog: (id: string) => { readonly fields: readonly AccessField[]; readonly server: AccessMcpServer | null } | null): { readonly ok: true; readonly input: AccessRequestInput } | { readonly ok: false; readonly errors: readonly AccessFieldError[] } {
  const errors: AccessFieldError[] = [];
  const b = isRecord(body) ? body : {};
  const kind = b['kind'];
  if (kind !== 'mcp' && kind !== 'api-key') errors.push({ field: 'kind', message: 'kind must be "mcp" or "api-key"' });
  const service = oneLine(b['service'], 80);
  if (!service) errors.push({ field: 'service', message: 'service (the service name) is required, one line, at most 80 characters' });
  const host = normalizeHost(b['host']);
  if (!host) errors.push({ field: 'host', message: 'host must be the host name (or URL) the access talks to, e.g. api.example.com' });
  const why = typeof b['why'] === 'string' ? b['why'].trim() : '';
  if (why === '' || why.length > 1_000) errors.push({ field: 'why', message: 'why is required (at most 1,000 characters): what you will fetch and for what' });
  const scope = oneLine(b['scope'], 200);
  if (!scope) errors.push({ field: 'scope', message: 'scope is required: the smallest scope that is enough, e.g. "read-only, reports"' });
  let source: AccessMcpSource | null = null;
  let catalogId: string | null = null;
  let fields: AccessField[] = [];
  let mcp: AccessMcpServer | null = null;
  let shared: AccessSharedServer | null = null;
  let test: AccessKeyTest | null = null;
  const rawFields = b['fields'] ?? [];
  if (!Array.isArray(rawFields) || rawFields.length > ACCESS_FIELDS_MAX) {
    errors.push({ field: 'fields', message: `fields must be a list of at most ${ACCESS_FIELDS_MAX}` });
  } else {
    for (const [index, raw] of rawFields.entries()) {
      const field = readAccessField(raw);
      if (!field) errors.push({ field: `fields[${index}]`, message: 'each field needs a name (UPPER_CASE, not a reserved variable such as PATH or NODE_OPTIONS), a label, secret (true/false), help, an optional https helpUrl and an optional pattern' });
      else if (fields.some((f) => f.name === field.name)) errors.push({ field: `fields[${index}]`, message: `the field ${field.name} is listed twice` });
      else fields.push(field);
    }
  }
  if (kind === 'mcp') {
    const rawSource = b['source'] ?? 'custom';
    if (rawSource !== 'catalog' && rawSource !== 'custom' && rawSource !== 'shared') errors.push({ field: 'source', message: 'source must be "catalog", "custom" or "shared"' });
    else source = rawSource;
    if (source === 'catalog') {
      const entry = typeof b['catalogId'] === 'string' ? catalog(b['catalogId']) : null;
      if (!entry) errors.push({ field: 'catalogId', message: 'catalogId must name an entry of the catalog (see the tool description), or use source "custom"' });
      else {
        catalogId = b['catalogId'] as string;
        // A known server runs exactly the catalog's command with the catalog's fields; a custom entry's command is the developer's, its fields the agent's.
        if (entry.server) fields = [...entry.fields];
        mcp = entry.server;
      }
    } else if (source === 'custom') {
      // A suggestion only: the developer confirms (or fills) the command at setup.
      mcp = b['server'] === undefined || b['server'] === null ? null : readAccessMcpServer(b['server'], fields.map((f) => f.name));
      if (b['server'] !== undefined && b['server'] !== null && !mcp) errors.push({ field: 'server', message: 'server must be { transport: "stdio", command, args } or { transport: "http", url (https), headers }; placeholders {FIELD} must name declared fields' });
    } else if (source === 'shared') {
      const name = b['sharedServer'];
      if (name !== undefined && name !== null) {
        if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(name)) errors.push({ field: 'sharedServer', message: 'sharedServer must be the MCP server name as the MCP page lists it' });
        else shared = { name, scope: 'user' };
      }
    }
  }
  if (kind === 'api-key') {
    if (fields.length === 0) errors.push({ field: 'fields', message: 'an api-key request needs at least one field (the key\'s environment variable)' });
    const rawTest = b['testUrl'];
    if (rawTest !== undefined && rawTest !== null && rawTest !== '' && host) {
      const url = urlOnHost(rawTest, host);
      if (!url) errors.push({ field: 'testUrl', message: `testUrl must be an https URL on ${host} itself` });
      else {
        const rawHeader = b['testHeader'];
        let header: AccessKeyTest['header'] = null;
        if (isRecord(rawHeader)) {
          const name = rawHeader['name'];
          const value = rawHeader['value'];
          if (typeof name !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(name) || typeof value !== 'string' || value.length > 1_000 || /[\r\n]/.test(value) || !placeholders(value).every((p) => fields.some((f) => f.name === p))) {
            errors.push({ field: 'testHeader', message: 'testHeader must be { name, value } with {FIELD} placeholders naming declared fields' });
          } else header = { name, value };
        }
        test = { url, header };
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: { kind: kind as AccessKind, source, catalogId, service: service as string, host: host as string, why, scope: scope as string, fields, mcp, shared, test },
  };
}

/** The warning of a catalog request whose host is not the catalog entry's (prompt-injection safety). */
export function hostWarning(declared: string, known: string | null): string | null {
  if (known === null || hostName(declared) === hostName(known)) return null;
  return `The agent declared ${declared}, but this catalog entry talks to ${known}. Check the request before you set it up.`;
}

// ── keychain names ───────────────────────────────────────────────────────

/** The keychain reference of one field: service {@link ACCESS_KEYCHAIN_SERVICE}, account `<member>/<access>/<FIELD>`. */
export function secretRefFor(memberId: string, accessId: string, field: string): AccessSecretRef {
  return { field, service: ACCESS_KEYCHAIN_SERVICE, account: `${memberId}/${accessId}/${field}` };
}

/** The checked values of a setup (`errors` when a field is missing, too short or does not match its pattern). */
export function checkSetupValues(fields: readonly AccessField[], body: unknown): { readonly ok: true; readonly values: Readonly<Record<string, string>> } | { readonly ok: false; readonly errors: readonly AccessFieldError[] } {
  const values = isRecord(body) ? body : {};
  const errors: AccessFieldError[] = [];
  const out: Record<string, string> = {};
  for (const field of fields) {
    const raw = values[field.name];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') {
      errors.push({ field: field.name, message: `${field.label} is required` });
      continue;
    }
    if (value.length > 8_000 || /[\r\n\0]/.test(value)) {
      errors.push({ field: field.name, message: `${field.label} must be one line (at most 8,000 characters)` });
      continue;
    }
    if (field.secret && value.length < MASK_MIN_LENGTH) {
      errors.push({ field: field.name, message: `${field.label} is too short to be a secret (at least ${MASK_MIN_LENGTH} characters)` });
      continue;
    }
    if (field.pattern) {
      let matches = false;
      try {
        matches = new RegExp(`^(?:${field.pattern})$`).test(value);
      } catch {
        matches = false;
      }
      if (!matches) {
        errors.push({ field: field.name, message: `${field.label} does not have the expected format` });
        continue;
      }
    }
    out[field.name] = value;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values: out };
}

// ── status ───────────────────────────────────────────────────────────────

/** `true` once `expiresAt` has passed. */
export function accessExpired(record: Pick<TeamAccessRecord, 'expiresAt'>, now: number): boolean {
  return record.expiresAt !== null && Date.parse(record.expiresAt) <= now;
}

/** The member gets it: active, not expired, and set up on the member's machine. */
export function accessReady(record: Pick<TeamAccessRecord, 'state' | 'expiresAt' | 'setUpOn' | 'deleted'>, memberMachineId: string, now: number): boolean {
  return !record.deleted && record.state === 'active' && !accessExpired(record, now) && record.setUpOn.includes(memberMachineId);
}

/** The derived status and its line. */
export function accessStatus(record: TeamAccessRecord, input: { readonly memberMachineId: string; readonly selfId: string; readonly names: (machineId: string) => string; readonly now: number }): { readonly status: AccessStatus; readonly statusText: string } {
  const where = (ids: readonly string[]): string => ids.map(input.names).join(', ');
  switch (record.state) {
    case 'requested':
      return { status: 'requested', statusText: 'Asked: waiting for you' };
    case 'denied':
      return { status: 'denied', statusText: 'Denied' };
    case 'deferred':
      return { status: 'not-now', statusText: 'Not now: set it up when you are ready' };
    case 'revoked':
      return { status: 'revoked', statusText: 'Revoked' };
    default:
      break;
  }
  if (record.state === 'expired' || accessExpired(record, input.now)) return { status: 'expired', statusText: 'Expired: replace it to give it back' };
  if (record.setUpOn.includes(input.memberMachineId)) {
    // Another machine sees where the values are: "Set up on Mac only" (and offers "Set up here too").
    if (!record.setUpOn.includes(input.selfId)) return { status: 'ready', statusText: `Set up on ${where(record.setUpOn)} only` };
    const others = record.setUpOn.filter((id) => id !== input.memberMachineId);
    return { status: 'ready', statusText: `Ready on ${input.names(input.memberMachineId)}${others.length > 0 ? ` (also set up on ${where(others)})` : ''}` };
  }
  if (record.setUpOn.length > 0) return { status: 'needs-setup', statusText: `Set up on ${where(record.setUpOn)} only: needs setup on ${input.names(input.memberMachineId)}` };
  return { status: 'needs-setup', statusText: `Needs setup on ${input.names(input.memberMachineId)}` };
}

/** What the member gets: the variables (`api-key`), or the MCP server's name. */
export function accessDelivers(record: Pick<TeamAccessRecord, 'kind' | 'fields' | 'service' | 'id'>): string {
  return record.kind === 'api-key' ? record.fields.map((f) => f.name).join(', ') : `MCP server ${accessServerName(record)}`;
}

/** The name the member's CLI knows an access's MCP server by (`access-<service>`, unique by the access id). */
export function accessServerName(record: Pick<TeamAccessRecord, 'service' | 'id'>): string {
  const slug = record.service.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'server';
  return `access-${slug}-${record.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6)}`;
}

/** The Needs-you title: "Marketing monitoring asks for Google Analytics (read-only, reports)". */
export function accessRequestTitle(memberName: string, input: Pick<AccessRequestInput, 'service' | 'scope'>): string {
  return `${memberName} asks for ${input.service} (${input.scope})`.slice(0, 500);
}

/** The Needs-you detail: why, then the exact service and host (and the warning). */
export function accessRequestDetail(input: Pick<AccessRequestInput, 'kind' | 'service' | 'host' | 'why' | 'scope' | 'fields'>, warning: string | null): string {
  const what = input.kind === 'api-key' ? `API key (${input.fields.map((f) => f.name).join(', ')})` : 'MCP server';
  return [`Why: ${input.why}`, `Service: ${input.service} · Host: ${input.host} · ${what} · Scope: ${input.scope}`, warning ? `Warning: ${warning}` : ''].filter(Boolean).join('\n').slice(0, 4_000);
}

/** The lines a member's agent gets with its charter: the accesses it has (by name, never a value) and the ones that need setup on its machine. */
export function accessCharterLines(ready: readonly Pick<TeamAccessRecord, 'kind' | 'fields' | 'service' | 'id' | 'setUpAt'>[], missing: readonly Pick<TeamAccessRecord, 'service'>[]): string | null {
  const parts: string[] = [];
  if (ready.length > 0) {
    const stamp = ready.map((r) => r.setUpAt ?? '').sort().at(-1) ?? '';
    parts.push(
      `Access the developer set up for you (as of ${stamp}): ${ready.map((r) => `${r.service} (${accessDelivers(r)})`).join('; ')}. Use them only for the purpose you asked for; never print, log, write down or send their values, and never ask for credentials in chat.`,
    );
  }
  if (missing.length > 0) parts.push(`Access that needs setting up on this machine before you use it: ${missing.map((r) => r.service).join(', ')}.`);
  parts.push('If you are blocked without an access you need, use request_access.');
  return parts.join(' ');
}

// ── masking ──────────────────────────────────────────────────────────────

/** One value to mask and the name it is shown as. */
export interface MaskedSecret {
  readonly name: string;
  readonly value: string;
}

/** What a masked value reads as: `•••• (ACME_ANALYTICS_KEY)`. */
export function maskLabel(name: string): string {
  return `•••• (${name})`;
}

/**
 * Replaces every configured secret value in `text` (as written, and as it appears
 * inside a JSON string) with {@link maskLabel}. Longer values first; values shorter
 * than {@link MASK_MIN_LENGTH} are skipped. The replacement has no quote or
 * backslash, so a JSON line stays valid JSON.
 */
export function maskSecrets(text: string, secrets: readonly MaskedSecret[]): string {
  if (secrets.length === 0 || text === '') return text;
  let out = text;
  const sorted = [...secrets].filter((s) => s.value.length >= MASK_MIN_LENGTH).sort((a, b) => b.value.length - a.value.length);
  for (const secret of sorted) {
    const forms = new Set([secret.value, JSON.stringify(secret.value).slice(1, -1), JSON.stringify(JSON.stringify(secret.value).slice(1, -1)).slice(1, -1)]);
    for (const form of forms) if (form !== '' && out.includes(form)) out = out.split(form).join(maskLabel(secret.name));
  }
  return out;
}

// ── sync reader ──────────────────────────────────────────────────────────

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function strings(value: unknown, max = 50): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length <= 200).slice(0, max) : [];
}

const AUDIT_WHATS: ReadonlySet<string> = new Set(['asked', 'approved', 'denied', 'deferred', 'set-up', 'replaced', 'used', 'tested', 'revoked', 'expired', 'removed-here']);

/** An access record from `team.db` or a paired machine (`null` when malformed; a field that could carry a value is never read). */
export function readAccessRecord(value: unknown): TeamAccessRecord | null {
  if (!isRecord(value)) return null;
  const id = str(value['id'], 100);
  const teamId = str(value['teamId'], 100);
  const memberId = str(value['memberId'], 100);
  const clock = value['clock'];
  const kind = value['kind'];
  const state = value['state'];
  if (!id || !teamId || !memberId || !isClock(clock) || (kind !== 'mcp' && kind !== 'api-key') || !(ACCESS_STATES as readonly unknown[]).includes(state)) return null;
  const service = str(value['service'], 200);
  const host = str(value['host'], 260);
  if (!service || !host) return null;
  const fields = Array.isArray(value['fields']) ? value['fields'].map(readAccessField).filter((f): f is AccessField => f !== null) : [];
  const names = fields.map((f) => f.name);
  const source = value['source'];
  const rawShared = isRecord(value['shared']) ? value['shared'] : null;
  const sharedScope: AccessSharedServer['scope'] = rawShared?.['scope'] === 'local' ? 'local' : rawShared?.['scope'] === 'project' ? 'project' : 'user';
  const shared: AccessSharedServer | null = rawShared && typeof rawShared['name'] === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(rawShared['name']) ? { name: rawShared['name'], scope: sharedScope } : null;
  const test = isRecord(value['test']) ? (() => {
    const url = urlOnHost(value['test']['url'], host);
    if (!url) return null;
    const header = isRecord(value['test']['header']) && typeof value['test']['header']['name'] === 'string' && typeof value['test']['header']['value'] === 'string'
      ? { name: value['test']['header']['name'].slice(0, 64), value: value['test']['header']['value'].slice(0, 1_000) }
      : null;
    return { url, header };
  })() : null;
  const audit = Array.isArray(value['audit'])
    ? value['audit']
        .filter(isRecord)
        .filter((a) => AUDIT_WHATS.has(String(a['what'])))
        .map((a) => ({ at: str(a['at'], 40) ?? '', what: a['what'] as AccessAuditEntry['what'], machineId: str(a['machineId'], 100), text: str(a['text'], 500) ?? '' }))
        .slice(-ACCESS_AUDIT_MAX)
    : [];
  return {
    id,
    teamId,
    memberId,
    clock,
    deleted: value['deleted'] === true,
    requestId: str(value['requestId'], 100),
    kind,
    source: kind === 'mcp' && (ACCESS_MCP_SOURCES as readonly unknown[]).includes(source) ? (source as AccessMcpSource) : null,
    catalogId: str(value['catalogId'], 100),
    service,
    host,
    why: str(value['why'], 1_000) ?? '',
    scope: str(value['scope'], 200) ?? '',
    fields,
    mcp: value['mcp'] === null || value['mcp'] === undefined ? null : readAccessMcpServer(value['mcp'], names),
    shared,
    test,
    warning: str(value['warning'], 500),
    state: state as AccessState,
    setUpOn: strings(value['setUpOn']),
    setUpAt: str(value['setUpAt'], 40),
    secretRefs: Array.isArray(value['secretRefs'])
      ? value['secretRefs'].filter(isRecord).map((r) => ({ field: str(r['field'], 64) ?? '', service: str(r['service'], 100) ?? '', account: str(r['account'], 300) ?? '' })).filter((r) => r.field !== '' && r.service !== '' && r.account !== '')
      : [],
    expiresAt: str(value['expiresAt'], 40),
    lastUsedAt: str(value['lastUsedAt'], 40),
    lastUsedOn: str(value['lastUsedOn'], 100),
    audit,
    createdAt: str(value['createdAt'], 40) ?? '',
    updatedAt: str(value['updatedAt'], 40) ?? '',
  };
}

/** Appends an audit entry (the newest {@link ACCESS_AUDIT_MAX} kept); a `used` entry within the hour of the last `used` on the same machine replaces it. */
export function withAudit(audit: readonly AccessAuditEntry[], entry: AccessAuditEntry): AccessAuditEntry[] {
  const last = audit.at(-1);
  if (entry.what === 'used' && last?.what === 'used' && last.machineId === entry.machineId && Date.parse(entry.at) - Date.parse(last.at) < 60 * 60_000) return [...audit.slice(0, -1), { ...last, text: entry.text }];
  return [...audit, entry].slice(-ACCESS_AUDIT_MAX);
}
