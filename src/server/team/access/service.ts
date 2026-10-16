import { randomUUID } from 'node:crypto';
import { type TeamActivityKind, type TeamMemberRecord, type TeamRequest, type TeamRequestAction, type TeamRequestRecord } from '../../../core/team.ts';
import {
  ACCESS_RATE_LIMIT,
  ACCESS_RATE_WINDOW_MS,
  type AccessMcpServer,
  type AccessSharedServer,
  type AccessTestResult,
  type MaskedSecret,
  type TeamAccessEntryView,
  type TeamAccessRecord,
  type TeamAccessView,
  accessCharterLines,
  accessDelivers,
  accessExpired,
  accessReady,
  accessRequestDetail,
  accessRequestTitle,
  accessServerName,
  accessStatus,
  checkSetupValues,
  fillTemplate,
  hostWarning,
  maskSecrets,
  readAccessMcpServer,
  readAccessRequest,
  secretRefFor,
  withAudit,
} from '../../../core/team-access.ts';
import { catalogEntry } from '../../../core/team-access-catalog.ts';
import { type McpRawConfig, describeConfig } from '../../../core/mcp.ts';
import type { Store } from '../../db/store.ts';
import { readConfiguredServers } from '../../mcp/config.ts';
import { childEnv } from '../../supervisor/argv.ts';
import type { SessionSupervisor } from '../../supervisor/supervisor.ts';
import type { TeamDb } from '../db.ts';
import { TeamError } from '../service.ts';
import type { SecretStore } from './secret-store.ts';
import { testHttpServer, testKey, testStdioServer } from './test-connection.ts';

/**
 * D100-T2 · access requests (`docs/team.md` → *Access requests*; contract → *Team
 * access (D100-T2)*). A part of {@link TeamService} (it gets the service's database,
 * clock and writer through {@link AccessHost}):
 *
 * 1. a member's agent asks (`request_access` → {@link TeamAccess.request}): a record
 *    in `team.db` (`access`) and a Needs-you request (kind `access`, the `external`
 *    seam), never auto-approved, rate limited per member;
 * 2. the developer sets it up in the member's Access tab ({@link TeamAccess.setUp}):
 *    the values go to **this machine's OS keychain** ({@link SecretStore}); the record
 *    keeps the keychain references and where it is set up;
 * 3. the member's session (only that one) gets it at spawn: API keys as environment
 *    variables ({@link TeamAccess.envFor}), MCP servers in its MCP config
 *    ({@link TeamAccess.serversFor}, started through `sb-access-mcp.ts`); every value
 *    is masked in what Switchboard records of that session ({@link TeamAccess.maskerFor});
 * 4. revoke, replace, expiry, test connection, and the audit trail.
 *
 * Records sync with paired machines; values never do: another machine shows "set up
 * on <machine> only" and can set it up there too.
 */

/** What {@link TeamAccess} needs from the Team service. */
export interface AccessHost {
  readonly store: Store;
  readonly supervisor: SessionSupervisor;
  readonly secrets: SecretStore;
  /** `team.db` (throws 404 / 503 while Team is off / unavailable). */
  db(): TeamDb;
  /** Team is on and `team.db` open. */
  available(): boolean;
  selfId(): string;
  stamp(): string;
  now(): number;
  serial<T>(work: () => Promise<T>): Promise<T>;
  changed(what: readonly string[]): void;
  activity(kind: TeamActivityKind, memberId: string | null, text: string): void;
  /** The members (not deleted). */
  members(): TeamMemberRecord[];
  memberOfSession(sessionId: string): TeamMemberRecord | null;
  requestGate(input: { readonly memberId: string; readonly kind: 'access'; readonly gate: null; readonly title: string; readonly detail: string; readonly action: TeamRequestAction }): Promise<TeamRequest>;
  machineNames(): Promise<Map<string, { readonly name: string; readonly online: boolean }>>;
  /** D64 / D91: the member's process picks the changed charter (with its access lines) up. */
  reload(sessionId: string): Promise<'restarted' | 'pending' | 'not-running' | 'current' | 'failed'>;
  error(error: unknown): void;
}

/** One MCP server of a member's access, for its spawn (no value in it). */
export type AccessServerSpec =
  | { readonly kind: 'helper'; readonly name: string; readonly accessId: string }
  | { readonly kind: 'http'; readonly name: string; readonly url: string; readonly headers: Readonly<Record<string, string>> };

/** What a member's spawn gets: its environment additions and the values to mask. */
export interface AccessEnv {
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: readonly MaskedSecret[];
}

/** The external-action ref of an access request (`{ type: 'external', ref: 'access:<id>' }`). */
export function accessRef(accessId: string): string {
  return `access:${accessId}`;
}

/** The access id of an external-action ref, else `null`. */
export function accessIdOfRef(ref: string): string | null {
  return ref.startsWith('access:') ? ref.slice('access:'.length) : null;
}

function strip(record: TeamAccessRecord): Omit<TeamAccessRecord, 'clock' | 'deleted'> {
  const { clock: _clock, deleted: _deleted, ...rest } = record;
  return rest;
}

/** `${VAR}` references for an http server's headers (Claude Code expands them from the CLI's environment). */
function headerReferences(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(headers)) out[name] = template.replace(/\{([A-Z][A-Z0-9_]{1,63})\}/g, (_, field: string) => `\${${field}}`);
  return out;
}

/** The access part of the Team service. */
export class TeamAccess {
  readonly #h: AccessHost;
  /** Values to mask per session (this process's memory only; a union over the session's spawns, so a value seen once stays masked). */
  readonly #masks = new Map<string, MaskedSecret[]>();

  constructor(host: AccessHost) {
    this.#h = host;
  }

  get secretStore(): SecretStore {
    return this.#h.secrets;
  }

  /** @throws {TeamError} 404 `team-off` / 503 `team-unavailable`. */
  assertOn(): void {
    this.#h.db();
  }

  #records(): TeamAccessRecord[] {
    return this.#h.db().access();
  }

  #record(id: string): TeamAccessRecord {
    const record = this.#records().find((r) => r.id === id && !r.deleted);
    if (!record) throw new TeamError(404, 'not-found', `no access ${id}`);
    return record;
  }

  #member(id: string): TeamMemberRecord {
    const member = this.#h.members().find((m) => m.id === id);
    if (!member) throw new TeamError(404, 'not-found', `no member ${id}`);
    return member;
  }

  #iso(): string {
    return new Date(this.#h.now()).toISOString();
  }

  /** Writes a record (in the caller's serial section) and mirrors the member's `access` summary (the T1 seam: names and machines). */
  #put(record: TeamAccessRecord): void {
    const db = this.#h.db();
    db.putAccess(record);
    const member = db.members().find((m) => m.id === record.memberId && !m.deleted);
    if (!member) return;
    const summary = db
      .access()
      .filter((r) => r.memberId === member.id && !r.deleted && (r.state === 'active' || r.state === 'approved' || r.state === 'expired'))
      .map((r) => ({ id: r.id, name: r.service, setUpOn: [...r.setUpOn] }));
    if (JSON.stringify(summary) === JSON.stringify(member.access)) return;
    db.putMember({ ...member, access: summary, clock: this.#h.stamp(), updatedAt: this.#iso() });
  }

  #update(id: string, patch: (current: TeamAccessRecord) => TeamAccessRecord): Promise<TeamAccessRecord> {
    return this.#h.serial(async () => {
      const next = { ...patch(this.#record(id)), clock: this.#h.stamp(), updatedAt: this.#iso() };
      this.#put(next);
      return next;
    });
  }

  // ── views ─────────────────────────────────────────────────────────────

  async #names(): Promise<(machineId: string) => string> {
    const machines = await this.#h.machineNames();
    return (machineId) => machines.get(machineId)?.name ?? machineId;
  }

  #entry(record: TeamAccessRecord, member: TeamMemberRecord, names: (machineId: string) => string): TeamAccessEntryView {
    const self = this.#h.selfId();
    const now = this.#h.now();
    const { status, statusText } = accessStatus(record, { memberMachineId: member.machineId, selfId: self, names, now });
    const here = record.setUpOn.includes(self);
    const open = record.state === 'requested' || record.state === 'approved' || record.state === 'deferred' || record.state === 'active' || record.state === 'expired';
    return {
      ...strip(record),
      status,
      statusText,
      here,
      setUpOnNames: record.setUpOn.map(names),
      ready: accessReady(record, member.machineId, now),
      canSetUp: open,
      delivers: accessDelivers(record),
    };
  }

  /** An access request's card data (Needs you). */
  async entryForRequest(request: TeamRequestRecord): Promise<TeamAccessEntryView | null> {
    if (request.kind !== 'access' || request.action?.type !== 'external') return null;
    const id = accessIdOfRef(request.action.ref);
    const record = id ? this.#records().find((r) => r.id === id && !r.deleted) : undefined;
    const member = record ? this.#h.members().find((m) => m.id === record.memberId) : undefined;
    if (!record || !member) return null;
    return this.#entry(record, member, await this.#names());
  }

  /** `GET /api/team/members/{id}/access`. */
  async view(memberId: string, options: { readonly device: boolean }): Promise<TeamAccessView> {
    this.#h.db();
    const member = this.#member(memberId);
    const names = await this.#names();
    const keychain = await this.#h.secrets.available().catch((error: unknown) => ({ ok: false, problem: error instanceof Error ? error.message : String(error) }));
    const entries = this.#records()
      .filter((r) => r.memberId === memberId && !r.deleted)
      .map((r) => this.#entry(r, member, names))
      .reverse();
    return {
      member: { id: member.id, name: member.name, machineId: member.machineId, machineName: names(member.machineId), local: member.machineId === this.#h.selfId() },
      self: { id: this.#h.selfId(), name: names(this.#h.selfId()) },
      device: options.device,
      keychain: { name: this.#h.secrets.name, available: keychain.ok, problem: keychain.problem },
      entries,
    };
  }

  /** `GET /api/team/members/{id}/access/shareable`: the MCP page's servers (D61) the member's folder sees (names, scopes, transport; values masked). */
  async shareable(memberId: string): Promise<Array<{ readonly name: string; readonly scope: AccessSharedServer['scope']; readonly transport: string; readonly command: string | null; readonly url: string | null }>> {
    this.#h.db();
    const member = this.#member(memberId);
    if (member.machineId !== this.#h.selfId()) return [];
    const cwd = (await this.#h.store.sessions.get(member.sessionId))?.cwd ?? null;
    if (!cwd) return [];
    const servers = await readConfiguredServers(process.env, cwd).catch(() => []);
    return servers.map((server) => {
      const described = describeConfig(server.config);
      return { name: server.name, scope: server.scope, transport: described.transport, command: described.command, url: described.url };
    });
  }

  // ── the agent asks ────────────────────────────────────────────────────

  /**
   * `request_access` (`POST /agent/v1/team/access`): records the request and raises a
   * Needs-you item. The same open request (member, kind, service, host) is reused;
   * more than {@link ACCESS_RATE_LIMIT} new requests per member per hour are refused.
   */
  async request(sessionId: string, body: unknown): Promise<{ readonly access: TeamAccessEntryView; readonly reused: boolean }> {
    const member = this.#h.memberOfSession(sessionId);
    if (!member) throw new TeamError(404, 'not-a-member', "this session is not a team member (or Team is off): the Team tools work only in a member's session");
    const parsed = readAccessRequest(body, (id) => catalogEntry(id));
    if (!parsed.ok) throw new TeamError(422, 'invalid', parsed.errors.map((e) => `${e.field}: ${e.message}`).join('; '), { errors: parsed.errors });
    const input = parsed.input;
    const entry = input.catalogId ? catalogEntry(input.catalogId) : null;
    const warning = hostWarning(input.host, entry?.host ?? null);
    const outcome = await this.#h.serial(async () => {
      const mine = this.#records().filter((r) => r.memberId === member.id && !r.deleted);
      const same = mine.find(
        (r) =>
          r.kind === input.kind &&
          r.service.toLowerCase() === input.service.toLowerCase() &&
          r.host === input.host &&
          (r.state === 'requested' || r.state === 'approved' || r.state === 'deferred' || r.state === 'active'),
      );
      if (same) return { record: same, reused: true };
      const since = this.#h.now() - ACCESS_RATE_WINDOW_MS;
      if (mine.filter((r) => Date.parse(r.createdAt) > since).length >= ACCESS_RATE_LIMIT) {
        throw new TeamError(429, 'rate-limited', `At most ${ACCESS_RATE_LIMIT} access requests per hour: wait for the developer to answer the open ones before you ask again.`);
      }
      const now = this.#iso();
      const record: TeamAccessRecord = {
        id: randomUUID(),
        teamId: member.teamId,
        clock: this.#h.stamp(),
        deleted: false,
        memberId: member.id,
        requestId: null,
        kind: input.kind,
        source: input.source,
        catalogId: input.catalogId,
        service: input.service,
        host: input.host,
        why: input.why,
        scope: input.scope,
        fields: input.fields,
        mcp: input.mcp,
        shared: input.shared,
        test: input.test,
        warning,
        state: 'requested',
        setUpOn: [],
        setUpAt: null,
        secretRefs: [],
        expiresAt: null,
        lastUsedAt: null,
        lastUsedOn: null,
        audit: [{ at: now, what: 'asked', machineId: this.#h.selfId(), text: `${member.name} asked for ${input.service} on ${input.host} (${input.scope})` }],
        createdAt: now,
        updatedAt: now,
      };
      this.#put(record);
      this.#h.activity('access', member.id, `asked for ${input.service} (${input.host})`);
      return { record, reused: false };
    });
    if (!outcome.reused) {
      const request = await this.#h.requestGate({ memberId: member.id, kind: 'access', gate: null, title: accessRequestTitle(member.name, input), detail: accessRequestDetail(input, warning), action: { type: 'external', ref: accessRef(outcome.record.id) } });
      await this.#update(outcome.record.id, (current) => ({ ...current, requestId: request.id }));
    }
    this.#h.changed(['access', 'requests', 'activity']);
    const record = this.#record(outcome.record.id);
    return { access: this.#entry(record, member, await this.#names()), reused: outcome.reused };
  }

  /** What `request_access` tells the agent. */
  static agentAnswer(outcome: { readonly access: TeamAccessEntryView; readonly reused: boolean }): string {
    const a = outcome.access;
    if (a.status === 'ready') return `${a.service} is already set up for you (${a.delivers}). Use it; never print its values.`;
    if (outcome.reused) return `You already asked for ${a.service} (${a.host}); it is waiting for the developer (${a.statusText}). Do not ask again; carry on with what you can do without it.`;
    return `Asked the developer for ${a.service} on ${a.host} (${a.scope}). It is in their Needs you list. Do not ask for the value in chat and do not wait idle: carry on with what you can do without it; you will be told when it is set up.`;
  }

  // ── the developer decides (Needs you) ─────────────────────────────────

  /**
   * A Needs-you decision on an access request (on the member's machine): Deny → denied,
   * Not now (dismiss) → deferred, Approve without values → approved (waiting for setup).
   * The agent is told about Deny and Not now.
   */
  async decided(request: TeamRequestRecord, decision: 'approve' | 'decline' | 'dismiss'): Promise<string | null> {
    if (request.kind !== 'access' || request.action?.type !== 'external') return null;
    const id = accessIdOfRef(request.action.ref);
    const record = id ? this.#records().find((r) => r.id === id && !r.deleted) : undefined;
    if (!record) return null;
    const member = this.#h.members().find((m) => m.id === record.memberId);
    const at = this.#iso();
    const self = this.#h.selfId();
    if (decision === 'approve') {
      if (record.state === 'requested' || record.state === 'deferred') {
        await this.#update(record.id, (current) => ({ ...current, state: 'approved', audit: withAudit(current.audit, { at, what: 'approved', machineId: self, text: 'Approved: waiting for setup' }) }));
        this.#h.changed(['access']);
      }
      return `Approved: set up ${record.service} in ${member?.name ?? 'the member'}'s Access tab to give it the access.`;
    }
    const denied = decision === 'decline';
    if (record.state === 'requested' || record.state === 'approved' || (denied && record.state === 'deferred')) {
      await this.#update(record.id, (current) => ({
        ...current,
        state: denied ? 'denied' : 'deferred',
        audit: withAudit(current.audit, { at, what: denied ? 'denied' : 'deferred', machineId: self, text: denied ? 'Denied' : 'Not now' }),
      }));
      this.#h.changed(['access']);
    }
    if (member && member.machineId === self) {
      const text = denied
        ? `The developer denied your request for ${record.service} (${record.host}). Do not ask for it again unless the situation changes; carry on without it.`
        : `The developer will not set up ${record.service} now. Carry on without it; do not ask again for now.`;
      await this.#h.supervisor.sendMessage(member.sessionId, text, 'service').catch((error: unknown) => this.#h.error(error));
    }
    return null;
  }

  // ── setup, replace, revoke, expiry ────────────────────────────────────

  /**
   * `POST /api/team/access/{id}/setup` `{ values, server?, shared?, expiresAt? }`: the
   * values go to **this machine's** keychain (also for a member that runs on another
   * machine: "Set up here too"). A custom server's command, or the shared server, is
   * confirmed here by the developer. Settles the open request (approved) and, when the
   * member runs here, restarts its idle process once (D91) and tells its agent.
   */
  async setUp(id: string, body: Record<string, unknown>): Promise<TeamAccessEntryView> {
    this.#h.db();
    const before = this.#record(id);
    const member = this.#member(before.memberId);
    if (before.state === 'denied' || before.state === 'revoked') throw new TeamError(409, 'closed', `this access is ${before.state}: the member has to ask again`);
    let mcp: AccessMcpServer | null = before.mcp;
    let shared: AccessSharedServer | null = before.shared;
    const names = before.fields.map((f) => f.name);
    if (before.kind === 'mcp' && before.source === 'custom' || before.kind === 'mcp' && before.source === 'catalog' && catalogEntry(before.catalogId)?.custom) {
      if (body['server'] !== undefined) {
        mcp = readAccessMcpServer(body['server'], names);
        if (!mcp) throw new TeamError(422, 'invalid', 'server must be { transport: "stdio", command, args } or { transport: "http", url (https), headers }', { errors: [{ field: 'server', message: 'confirm the server (command or URL)' }] });
      } else if (!mcp) throw new TeamError(422, 'invalid', 'confirm the server: fill its command (or URL)', { errors: [{ field: 'server', message: 'the command (or URL) is required' }] });
    }
    if (before.kind === 'mcp' && before.source === 'shared') {
      const raw = body['shared'];
      const name = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['name'] : undefined;
      const scope = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['scope'] : undefined;
      if (typeof name === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(name) && (scope === 'local' || scope === 'project' || scope === 'user')) shared = { name, scope };
      else if (!shared) throw new TeamError(422, 'invalid', 'pick the MCP server to share', { errors: [{ field: 'shared', message: 'pick a server from the MCP page' }] });
      // Only a stdio server can be shared (started through the access launcher); an http one keeps its own name and sign-in on the MCP page.
      const listed = (await this.shareable(member.id)).find((s) => s.name === shared?.name && s.scope === shared.scope);
      if (member.machineId === this.#h.selfId() && !listed) throw new TeamError(422, 'invalid', `the MCP page has no ${shared.scope} server "${shared.name}" for ${member.name}'s folder`, { errors: [{ field: 'shared', message: 'not found on the MCP page' }] });
      if (listed && listed.transport !== 'stdio') {
        throw new TeamError(422, 'invalid', `${shared.name} is an ${listed.transport} server: it keeps its own name and sign-in, so add it on the MCP page at user scope (or in ${member.name}'s folder) instead of sharing it`, { errors: [{ field: 'shared', message: 'only stdio servers can be shared' }] });
      }
    }
    const checked = checkSetupValues(before.fields, body['values']);
    if (!checked.ok) throw new TeamError(422, 'invalid', checked.errors.map((e) => e.message).join('; '), { errors: checked.errors });
    let expiresAt = before.expiresAt;
    if (body['expiresAt'] !== undefined) expiresAt = this.#expiry(body['expiresAt']);
    if (before.fields.length > 0) {
      const keychain = await this.#h.secrets.available();
      if (!keychain.ok) throw new TeamError(503, 'keychain-unavailable', keychain.problem ?? `${this.#h.secrets.name} cannot be used here`);
    }
    // The values: this machine's keychain only (a failure removes what was written).
    const refs = before.fields.map((field) => secretRefFor(member.id, before.id, field.name));
    const written: typeof refs = [];
    try {
      for (const ref of refs) {
        await this.#h.secrets.set(ref, checked.values[ref.field] as string);
        written.push(ref);
      }
    } catch (error) {
      for (const ref of written) await this.#h.secrets.delete(ref).catch(() => undefined);
      throw new TeamError(503, 'keychain-unavailable', error instanceof Error ? error.message : String(error));
    }
    const self = this.#h.selfId();
    const names2 = await this.#names();
    const replaced = before.setUpOn.includes(self);
    const at = this.#iso();
    const after = await this.#update(id, (current) => ({
      ...current,
      mcp,
      shared,
      expiresAt,
      state: 'active',
      setUpOn: [...new Set([...current.setUpOn, self])],
      setUpAt: at,
      secretRefs: refs,
      audit: withAudit(current.audit, { at, what: replaced ? 'replaced' : 'set-up', machineId: self, text: `${replaced ? 'Replaced' : 'Set up'} on ${names2(self)}` }),
    }));
    // The open request is settled by the setup.
    await this.#h.serial(async () => {
      const db = this.#h.db();
      for (const request of db.requests()) {
        if (request.id === after.requestId && request.state === 'open') db.putRequest({ ...request, state: 'approved', note: `Set up on ${names2(self)}`, clock: this.#h.stamp(), updatedAt: at });
      }
      this.#h.activity('access', member.id, `${after.service} ${replaced ? 'replaced' : 'set up'} on ${names2(self)}`);
    });
    this.#h.changed(['access', 'requests', 'activity', 'members']);
    if (member.machineId === self) await this.#reloadAndTell(member, `Access set up: ${after.service} is now available to you (${accessDelivers(after)}). Never print or ask for its values.`);
    return this.#entry(after, member, names2);
  }

  #expiry(value: unknown): string | null {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new TeamError(422, 'invalid', 'expiresAt must be a date (ISO) or null', { errors: [{ field: 'expiresAt', message: 'a date or empty' }] });
    if (Date.parse(value) <= this.#h.now()) throw new TeamError(422, 'invalid', 'expiresAt must be in the future', { errors: [{ field: 'expiresAt', message: 'must be in the future' }] });
    return new Date(Date.parse(value)).toISOString();
  }

  /** `PUT /api/team/access/{id}` `{ expiresAt }`: the optional expiry (no value changes). */
  async setExpiry(id: string, body: Record<string, unknown>): Promise<TeamAccessEntryView> {
    const expiresAt = this.#expiry(body['expiresAt']);
    const record = await this.#update(id, (current) => ({ ...current, expiresAt, state: current.state === 'expired' && (expiresAt === null || Date.parse(expiresAt) > this.#h.now()) ? 'active' : current.state }));
    this.#h.changed(['access']);
    const member = this.#member(record.memberId);
    if (member.machineId === this.#h.selfId()) await this.#reloadAndTell(member, null);
    return this.#entry(record, member, await this.#names());
  }

  /**
   * `POST /api/team/access/{id}/revoke`: this machine's values are removed from its
   * keychain, the access is revoked everywhere (the other machines remove theirs when
   * the record reaches them), and the member's process restarts without it.
   */
  async revoke(id: string): Promise<TeamAccessEntryView> {
    this.#h.db();
    const before = this.#record(id);
    const member = this.#member(before.memberId);
    await this.#removeLocalValues(before);
    const self = this.#h.selfId();
    const names = await this.#names();
    const at = this.#iso();
    const after = await this.#update(id, (current) => ({
      ...current,
      state: 'revoked',
      setUpOn: [],
      audit: withAudit(current.audit, { at, what: 'revoked', machineId: self, text: `Revoked on ${names(self)}` }),
    }));
    await this.#h.serial(async () => {
      const db = this.#h.db();
      for (const request of db.requests()) {
        if (request.id === after.requestId && request.state === 'open') db.putRequest({ ...request, state: 'dismissed', note: 'Revoked', clock: this.#h.stamp(), updatedAt: at });
      }
      this.#h.activity('access', member.id, `${after.service} revoked`);
    });
    this.#h.changed(['access', 'requests', 'activity', 'members']);
    if (member.machineId === self) await this.#reloadAndTell(member, `Access revoked: ${after.service} is no longer available to you. Do not try to use it.`);
    return this.#entry(after, member, names);
  }

  async #removeLocalValues(record: TeamAccessRecord): Promise<void> {
    const refs = record.secretRefs.length > 0 ? record.secretRefs : record.fields.map((field) => secretRefFor(record.memberId, record.id, field.name));
    for (const ref of refs) await this.#h.secrets.delete(ref).catch((error: unknown) => this.#h.error(error));
  }

  /** D91: the member's process restarts once (idle now, busy after its turn) with its new access; the agent is told when it restarted or was not running. */
  async #reloadAndTell(member: TeamMemberRecord, text: string | null): Promise<void> {
    const outcome = await this.#h.reload(member.sessionId);
    if (text && (outcome === 'restarted' || outcome === 'current') && this.#h.supervisor.isLive(member.sessionId)) {
      await this.#h.supervisor.sendMessage(member.sessionId, text, 'service').catch((error: unknown) => this.#h.error(error));
    }
  }

  /** The Team tick: an access past its expiry is no longer given (the member restarts without it). */
  async tick(): Promise<void> {
    if (!this.#h.available()) return;
    const now = this.#h.now();
    const self = this.#h.selfId();
    for (const record of this.#records()) {
      if (record.deleted || record.state !== 'active' || !accessExpired(record, now)) continue;
      const member = this.#h.members().find((m) => m.id === record.memberId);
      if (!member || member.machineId !== self) continue;
      const at = this.#iso();
      await this.#update(record.id, (current) => ({ ...current, state: 'expired', audit: withAudit(current.audit, { at, what: 'expired', machineId: self, text: 'Expired' }) }));
      this.#h.changed(['access']);
      await this.#reloadAndTell(member, `Access expired: ${record.service} is no longer available to you.`);
    }
  }

  /**
   * Records from a paired machine were merged: a revoked access's values are removed
   * from this machine's keychain too, and a member that runs here picks its changed
   * access up (its charter lines change, so D91 restarts it).
   */
  async received(records: readonly TeamAccessRecord[]): Promise<readonly string[]> {
    const touched = new Set<string>();
    for (const record of records) {
      if (record.state === 'revoked' || record.deleted) await this.#removeLocalValues(record);
      touched.add(record.memberId);
    }
    const self = this.#h.selfId();
    return this.#h
      .members()
      .filter((m) => touched.has(m.id) && m.machineId === self)
      .map((m) => m.sessionId);
  }

  /** A member was removed (returned or deleted) on this machine: its values here are removed and its accesses end with it. */
  async memberRemoved(memberId: string): Promise<void> {
    for (const record of this.#records()) {
      if (record.memberId !== memberId || record.deleted) continue;
      await this.#removeLocalValues(record);
      await this.#h.serial(async () => {
        this.#h.db().putAccess({ ...record, deleted: true, state: 'revoked', setUpOn: [], clock: this.#h.stamp(), updatedAt: this.#iso() });
      });
    }
  }

  // ── test connection ───────────────────────────────────────────────────

  async #values(record: TeamAccessRecord): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const field of record.fields) {
      const value = await this.#h.secrets.get(secretRefFor(record.memberId, record.id, field.name));
      if (value === null) throw new TeamError(409, 'not-set-up', `${field.label} is not in ${this.#h.secrets.name} here: set it up on this machine first`);
      out[field.name] = value;
    }
    return out;
  }

  #secretsOf(record: TeamAccessRecord, values: Readonly<Record<string, string>>): MaskedSecret[] {
    return record.fields.filter((f) => f.secret).map((f) => ({ name: f.name, value: values[f.name] ?? '' }));
  }

  /** `POST /api/team/access/{id}/test`: on this machine, with this machine's values. */
  async test(id: string): Promise<AccessTestResult> {
    const record = this.#record(id);
    const self = this.#h.selfId();
    if (!record.setUpOn.includes(self)) throw new TeamError(409, 'not-set-up', 'it is not set up on this machine: set it up here first');
    const values = await this.#values(record);
    const secrets = this.#secretsOf(record, values);
    let result: AccessTestResult;
    if (record.kind === 'api-key') {
      result = await testKey({ host: record.host, test: record.test, values, secrets });
    } else {
      const launch = await this.#launchSpec(record, values);
      result =
        launch.kind === 'stdio'
          ? await testStdioServer({ command: launch.command, args: launch.args, env: { ...childEnv(process.env), ...launch.env }, ...(launch.cwd ? { cwd: launch.cwd } : {}), secrets })
          : await testHttpServer({ url: launch.url, headers: launch.headers, secrets });
    }
    const at = this.#iso();
    await this.#update(id, (current) => ({ ...current, audit: withAudit(current.audit, { at, what: 'tested', machineId: self, text: `Test connection: ${result.ok ? 'OK' : 'failed'} · ${result.detail}`.slice(0, 500) }) }));
    this.#h.changed(['access']);
    return result;
  }

  /** How an MCP access runs, with its values filled (in memory only). */
  async #launchSpec(record: TeamAccessRecord, values: Readonly<Record<string, string>>): Promise<{ readonly kind: 'stdio'; readonly command: string; readonly args: string[]; readonly env: Record<string, string>; readonly cwd: string | null } | { readonly kind: 'http'; readonly url: string; readonly headers: Record<string, string> }> {
    const member = this.#member(record.memberId);
    const cwd = member.machineId === this.#h.selfId() ? ((await this.#h.store.sessions.get(member.sessionId))?.cwd ?? null) : null;
    if (record.source === 'shared') {
      const shared = record.shared;
      if (!shared || !cwd) throw new TeamError(409, 'not-available', 'the shared MCP server cannot be found from the member\'s folder');
      const config = (await readConfiguredServers(process.env, cwd)).find((s) => s.name === shared.name && s.scope === shared.scope)?.config;
      if (!config) throw new TeamError(409, 'not-available', `the MCP page has no ${shared.scope} server "${shared.name}" for the member's folder any more`);
      return sharedLaunch(config, cwd);
    }
    const server = record.mcp;
    if (!server) throw new TeamError(409, 'not-set-up', 'the server is not confirmed yet: set it up first');
    if (server.transport === 'http') {
      const headers: Record<string, string> = {};
      for (const [name, template] of Object.entries(server.headers)) headers[name] = fillTemplate(template, values);
      return { kind: 'http', url: server.url as string, headers };
    }
    return { kind: 'stdio', command: server.command as string, args: server.args.map((arg) => fillTemplate(arg, values)), env: { ...values }, cwd };
  }

  // ── delivery to the member's session ──────────────────────────────────

  /** The member's ready accesses here (none for a non-member, with Team off, or on another machine). */
  #readyFor(sessionId: string): { readonly member: TeamMemberRecord; readonly records: TeamAccessRecord[] } | null {
    if (!this.#h.available()) return null;
    const member = this.#h.memberOfSession(sessionId);
    if (!member) return null;
    const now = this.#h.now();
    return { member, records: this.#records().filter((r) => r.memberId === member.id && accessReady(r, member.machineId, now)) };
  }

  /** Spawn: the MCP servers of the member's ready MCP accesses (no value in them). */
  serversFor(sessionId: string): AccessServerSpec[] {
    const ready = this.#readyFor(sessionId);
    if (!ready) return [];
    const out: AccessServerSpec[] = [];
    for (const record of ready.records) {
      if (record.kind !== 'mcp') continue;
      const name = accessServerName(record);
      if (record.mcp?.transport === 'http' && record.source !== 'shared') out.push({ kind: 'http', name, url: record.mcp.url as string, headers: headerReferences(record.mcp.headers) });
      else out.push({ kind: 'helper', name, accessId: record.id });
    }
    return out;
  }

  /**
   * Spawn: the environment additions (API keys, and the values an http MCP server's
   * headers reference) and every value to mask for this session. Reads this machine's
   * keychain; an unreadable value is left out (reported), never a reason not to start.
   */
  async envFor(sessionId: string): Promise<AccessEnv> {
    const ready = this.#readyFor(sessionId);
    if (!ready || ready.records.length === 0) return { env: {}, secrets: this.#masks.get(sessionId) ?? [] };
    const env: Record<string, string> = {};
    const secrets: MaskedSecret[] = [];
    const used: string[] = [];
    for (const record of ready.records) {
      let values: Record<string, string>;
      try {
        values = await this.#values(record);
      } catch (error) {
        this.#h.error(error);
        continue;
      }
      secrets.push(...this.#secretsOf(record, values));
      if (record.kind === 'api-key' || (record.mcp?.transport === 'http' && record.source !== 'shared')) {
        Object.assign(env, values);
        if (record.kind === 'api-key') used.push(record.id);
      }
    }
    this.#remember(sessionId, secrets);
    for (const id of used) await this.#used(id, 'at the session start').catch((error: unknown) => this.#h.error(error));
    return { env, secrets: this.#masks.get(sessionId) ?? [] };
  }

  #remember(sessionId: string, secrets: readonly MaskedSecret[]): void {
    const known = this.#masks.get(sessionId) ?? [];
    const merged = [...known];
    for (const secret of secrets) if (!merged.some((s) => s.value === secret.value)) merged.push(secret);
    this.#masks.set(sessionId, merged);
  }

  /** The masking pass of a session's recorded output (`•••• (NAME)` for every value it was given). Identity for other sessions. */
  maskerFor(sessionId: string): (text: string) => string {
    return (text) => {
      const secrets = this.#masks.get(sessionId);
      return secrets && secrets.length > 0 ? maskSecrets(text, secrets) : text;
    };
  }

  /** Masks `text` with the values known for `sessionId`. */
  mask(sessionId: string, text: string): string {
    return this.maskerFor(sessionId)(text);
  }

  async #used(id: string, how: string): Promise<void> {
    const self = this.#h.selfId();
    const at = this.#iso();
    await this.#update(id, (current) => ({ ...current, lastUsedAt: at, lastUsedOn: self, audit: withAudit(current.audit, { at, what: 'used', machineId: self, text: `Given to the member ${how}` }) }));
    this.#h.changed(['access']);
  }

  /**
   * `GET /agent/v1/team/access/{id}/launch` (the access launcher of the member's own
   * session): the command, arguments and environment with the values, read from this
   * machine's keychain now. Refused for any other session, an access that is not ready
   * here, and an http server (configured directly).
   */
  async launchFor(sessionId: string, accessId: string): Promise<{ readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> }> {
    const ready = this.#readyFor(sessionId);
    const record = ready?.records.find((r) => r.id === accessId && r.kind === 'mcp');
    if (!ready || !record) throw new TeamError(404, 'not-available', 'this access is not set up for this session on this machine (or it was revoked or expired)');
    const values = await this.#values(record);
    this.#remember(sessionId, this.#secretsOf(record, values));
    const launch = await this.#launchSpec(record, values);
    if (launch.kind !== 'stdio') throw new TeamError(409, 'not-stdio', 'an http MCP server is configured directly');
    await this.#used(record.id, 'when its MCP server started').catch((error: unknown) => this.#h.error(error));
    return { command: launch.command, args: launch.args, env: launch.env };
  }

  /** The charter lines of a member (its ready accesses by name, and the ones that need setup on its machine). */
  charterLines(member: TeamMemberRecord): string | null {
    if (!this.#h.available()) return null;
    const now = this.#h.now();
    const mine = this.#records().filter((r) => r.memberId === member.id && !r.deleted);
    const ready = mine.filter((r) => accessReady(r, member.machineId, now));
    const missing = mine.filter((r) => r.state === 'active' && !accessExpired(r, now) && !r.setUpOn.includes(member.machineId));
    if (ready.length === 0 && missing.length === 0) return 'If you are blocked without data access you need (an MCP server or an API key), use request_access; never ask for credentials in chat.';
    return accessCharterLines(ready, missing);
  }
}

/** A shared MCP page server's launch (its own config: command / args / env, or url / headers). */
function sharedLaunch(config: McpRawConfig, cwd: string): { readonly kind: 'stdio'; readonly command: string; readonly args: string[]; readonly env: Record<string, string>; readonly cwd: string } | { readonly kind: 'http'; readonly url: string; readonly headers: Record<string, string> } {
  const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const record = (value: unknown): Record<string, string> =>
    value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
  const url = str(config['url']);
  if (url) return { kind: 'http', url, headers: record(config['headers']) };
  const command = str(config['command']);
  if (!command) throw new TeamError(409, 'not-available', 'the shared server has no command or URL');
  const args = Array.isArray(config['args']) ? config['args'].filter((a): a is string => typeof a === 'string') : [];
  return { kind: 'stdio', command, args, env: record(config['env']), cwd };
}
