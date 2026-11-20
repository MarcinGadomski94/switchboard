import { randomUUID } from 'node:crypto';
import { HybridClock } from '../../core/hlc.ts';
import {
  CLAUDE_AI_CONNECTORS_URL,
  type ClaudeAiConnectorSeen,
  MCP_CONNECTORS_SEEN_SETTING,
  MCP_SIGN_IN_MUTED_SETTING,
  MCP_SIGN_IN_MUTES_SETTING,
  type McpMuteRecord,
  type McpSignInSettings,
  type McpSignInWire,
  type McpSyncComputer,
  mergeMuteRecords,
  migratedMuteRecords,
  mutedNames,
  readConnectorsSeen,
  readMuteRecords,
  readMutedServers,
  signInItemDetail,
  signInItemTitle,
} from '../../core/mcp-sign-in.ts';
import type { McpAuthState } from '../../core/mcp.ts';
import type { Store } from '../db/store.ts';
import type { McpFolder, McpService } from './service.ts';
import type { McpSignInNeeds } from './sign-in-needs.ts';

/** Why a sign-in from an agent was refused (the route's status comes with it). */
export class McpSignInError extends Error {
  override name = 'McpSignInError';
  readonly code: 'not-found' | 'not-needed' | 'claude-ai' | 'no-folder';
  readonly status: number;
  constructor(code: McpSignInError['code'], message: string) {
    super(message);
    this.code = code;
    this.status = code === 'not-found' || code === 'not-needed' ? 404 : 409;
  }
}

/** What {@link McpSignInService.reconnect} did. */
export interface McpReconnectResult {
  readonly server: string;
  /** Sessions whose CLI reconnected the server. */
  readonly reconnected: readonly string[];
  /** Sessions whose CLI could not be told (no running process, or it answered an error). */
  readonly failed: readonly string[];
}

/** The Needs-you items this service raises and closes (the `SystemItemService`'s D163 methods). */
export interface McpSignInItems {
  mcpSignInNotice(input: { readonly server: string; readonly dedupe: string; readonly sessionId: string | null; readonly title: string; readonly detail: string; readonly claudeAi: boolean }): Promise<unknown>;
  closeMcpSignInNotices(server: string | null, outcome: string, keep?: ReadonlySet<string>): Promise<number>;
}

/** Options of {@link McpSignInService}. */
export interface McpSignInServiceOptions {
  readonly store: Store;
  readonly needs: McpSignInNeeds;
  readonly mcp: Pick<McpService, 'startAuth' | 'onSignedIn'>;
  /** Tells a session's running CLI to reconnect a server (`SessionSupervisor.mcpReconnect`). */
  readonly reconnect: (sessionId: string, name: string) => Promise<boolean>;
  /** Publishes the session's `sessionUpdated` (its `mcpSignIn` changed). */
  readonly announce: (sessionId: string) => Promise<void>;
  readonly items: McpSignInItems | null;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/**
 * D163 (`docs/mcp.md` → *Sign-in where it happens*): what the developer sees and does
 * when running agents need a sign-in to an MCP server:
 *
 * - one Needs-you item per server and episode (raised when the first agent reports it,
 *   brought up to date as agents join or leave, closed when none needs it any more);
 * - **Sign in** from an agent: the D61 sign-in (`McpService.startAuth`) in the agent's
 *   folder; a claude.ai connector is signed in on claude.ai instead (refused here);
 * - after **every** finished sign-in of a server (from an agent's notice or from the
 *   Connections page), the running agents that need it are told to reconnect it
 *   (`mcp_reconnect`), so they use it without a restart.
 */
export class McpSignInService {
  readonly #o: McpSignInServiceOptions;
  readonly #onError: (error: unknown) => void;
  /** The open episode of each server some agent needs: its item's dedupe key. */
  readonly #episodes = new Map<string, string>();
  #queue: Promise<void> = Promise.resolve();
  #off: (() => void)[] = [];
  /** D184: every server's mute record (muted, or an unmute kept as a tombstone), synced with the paired computers. */
  #records: McpMuteRecord[] = [];
  readonly #clock: HybridClock;
  /** D184: who hears of a change to share (the paired computers): the records written, and the connectors. */
  readonly #shareListeners = new Set<() => void>();
  /** D184: the paired computers as Settings lists them (set by the app once the peers exist). */
  #peers: (() => { readonly self: string; readonly computers: readonly McpSyncComputer[] }) | null = null;

  constructor(options: McpSignInServiceOptions) {
    this.#o = options;
    this.#onError = options.onError ?? ((error) => console.error('switchboard mcp sign-in:', error));
    this.#clock = new HybridClock(randomUUID().slice(0, 8), options.now ?? Date.now);
  }

  /** Starts following the agents' needs and the finished sign-ins. D183: loads the muted servers and the connectors seen first. */
  async start(): Promise<void> {
    if (this.#off.length > 0) return;
    this.#off.push(this.#o.needs.onChange(() => this.#schedule()));
    this.#off.push(this.#o.mcp.onSignedIn((name) => void this.reconnect(name).catch(this.#onError)));
    // D183: the connectors seen are saved as they change (one write at a time, in the queue). D184: and shared.
    this.#off.push(this.#o.needs.onConnectorsChange((connectors) => {
      this.#queue = this.#queue.then(() => this.#o.store.settings.set(MCP_CONNECTORS_SEEN_SETTING, connectors)).catch(this.#onError);
      this.#share();
    }));
    try {
      this.#o.needs.seedConnectors(readConnectorsSeen(await this.#o.store.settings.get(MCP_CONNECTORS_SEEN_SETTING)));
      // D184: the synced records; a D183 list (no clocks) becomes records older than any synced change.
      const stored = await this.#o.store.settings.get(MCP_SIGN_IN_MUTES_SETTING);
      this.#records = Array.isArray(stored) ? readMuteRecords(stored) : migratedMuteRecords(readMutedServers(await this.#o.store.settings.get(MCP_SIGN_IN_MUTED_SETTING)));
      for (const record of this.#records) this.#clock.observe(record.clock);
      this.#o.needs.setMuted(mutedNames(this.#records));
    } catch (error) {
      this.#onError(error);
    }
  }

  /** D184: tells the app's peers how to list the paired computers (`PeerService.mcpComputers`). */
  usePeers(peers: (() => { readonly self: string; readonly computers: readonly McpSyncComputer[] }) | null): void {
    this.#peers = peers;
  }

  /** D183 · `GET /api/mcp/sign-in`: the muted servers and the claude.ai connectors seen. D184: and every paired computer's. */
  settings(): McpSignInSettings {
    const base = { muted: [...this.#o.needs.muted()].sort((a, b) => a.localeCompare(b)), connectors: this.#o.needs.connectors() };
    const peers = this.#peers?.() ?? null;
    return peers ? { ...base, self: peers.self, computers: peers.computers } : base;
  }

  /** D184: the muted server names (the merged peer Inbox leaves their items out). */
  mutedNames(): ReadonlySet<string> {
    return this.#o.needs.muted();
  }

  /** D184: what this computer sends in the exchange: every record and its own connectors. */
  wire(): McpSignInWire {
    return { v: 1, mutes: this.#records, connectors: this.#o.needs.connectors() };
  }

  /** D184: calls `listener` when this computer has something new to share (a mute here or taken from a peer, a connector's status); answers the unsubscribe. */
  onShare(listener: () => void): () => void {
    this.#shareListeners.add(listener);
    return () => this.#shareListeners.delete(listener);
  }

  /**
   * D184: a paired computer's records: the later record wins per server; what changed is saved and
   * applied (items close or come back, notices change). Answers the records taken (none: nothing to pass on).
   */
  async merge(incoming: readonly McpMuteRecord[]): Promise<McpMuteRecord[]> {
    for (const record of incoming) this.#clock.observe(record.clock);
    const { records, written } = mergeMuteRecords(this.#records, incoming);
    if (written.length === 0) return [];
    await this.#apply(records);
    return written;
  }

  /**
   * D183 · "Don't ask again" (`muted: true`) or ask again (`false`) for server `name`: saved,
   * applied at once (its Needs-you item closes, the agents' notices go), and the agents whose
   * notice changed are announced. D184: a record with a new clock, shared with the paired computers.
   */
  async setMuted(name: string, muted: boolean): Promise<McpSignInSettings> {
    const clean = name.trim();
    if (clean === '' || clean.length > 200) throw new McpSignInError('not-found', 'No such server');
    const { records } = mergeMuteRecords(this.#records, [{ name: clean, muted, clock: this.#clock.next() }]);
    await this.#apply(records);
    this.#share();
    await this.idle();
    return this.settings();
  }

  /** D184: keeps `records` (and the D183 list, for a computer going back to an older version), applies the muted names. */
  async #apply(records: McpMuteRecord[]): Promise<void> {
    this.#records = records;
    await this.#o.store.settings.set(MCP_SIGN_IN_MUTES_SETTING, records);
    await this.#o.store.settings.set(MCP_SIGN_IN_MUTED_SETTING, mutedNames(records));
    for (const sessionId of this.#o.needs.setMuted(mutedNames(records))) await this.#o.announce(sessionId).catch(this.#onError);
  }

  #share(): void {
    for (const listener of this.#shareListeners) {
      try {
        listener();
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  /** D184: the connectors this computer's agents reported (the exchange sends them). */
  connectors(): ClaudeAiConnectorSeen[] {
    return this.#o.needs.connectors();
  }

  /** Stops following; waits for the work in flight. */
  async stop(): Promise<void> {
    for (const off of this.#off.splice(0)) off();
    await this.#queue;
  }

  /** Waits for the item updates in flight (tests). */
  async idle(): Promise<void> {
    await this.#queue;
  }

  #schedule(): void {
    this.#queue = this.#queue.then(() => this.#reconcile()).catch(this.#onError);
  }

  async #reconcile(): Promise<void> {
    const items = this.#o.items;
    const servers = this.#o.needs.byServer();
    for (const name of [...this.#episodes.keys()]) if (!servers.has(name)) this.#episodes.delete(name);
    const keep = new Set<string>();
    for (const [name, entry] of servers) {
      let dedupe = this.#episodes.get(name);
      if (!dedupe) {
        dedupe = `mcp-sign-in:${name}:${(this.#o.now ?? Date.now)()}`;
        this.#episodes.set(name, dedupe);
      }
      keep.add(dedupe);
      if (!items) continue;
      const agents: string[] = [];
      for (const sessionId of entry.sessionIds) {
        const record = await this.#o.store.sessions.get(sessionId);
        agents.push(record ? (record.title ?? record.name) : sessionId);
      }
      await items.mcpSignInNotice({ server: name, dedupe, sessionId: entry.sessionIds[0] ?? null, title: signInItemTitle(name), detail: signInItemDetail(name, agents, entry.claudeAi), claudeAi: entry.claudeAi });
    }
    if (items) await items.closeMcpSignInNotices(null, 'resolved', keep);
  }

  /**
   * **Sign in** from agent `sessionId`'s notice: the D61 sign-in of `name` in the agent's
   * folder. Answers the sign-in's state (`waiting` with the URL the browser opens).
   */
  async signIn(sessionId: string, name: string): Promise<McpAuthState> {
    const record = await this.#o.store.sessions.get(sessionId);
    if (!record) throw new McpSignInError('not-found', `No session ${sessionId}`);
    const need = this.#o.needs.of(sessionId).find((entry) => entry.name === name);
    if (!need) throw new McpSignInError('not-needed', `${name} does not need a sign-in in this agent (any more)`);
    if (need.claudeAi) throw new McpSignInError('claude-ai', `${name} is a claude.ai connector: sign in on ${CLAUDE_AI_CONNECTORS_URL}, then Reconnect`);
    const where = record.cwd ?? record.root;
    if (!where) throw new McpSignInError('no-folder', `${record.title ?? record.name} has no working folder to sign in from`);
    const folder: McpFolder = { id: record.folderId, path: where, root: where, label: null };
    return this.#o.mcp.startAuth(folder, name, false);
  }

  /**
   * Tells every running agent that needs `name` to reconnect it (after a sign-in, or the
   * developer's Reconnect once a claude.ai connector is signed in). A session whose CLI
   * reconnected no longer lists it (its next turn's `init` says again if it still needs it).
   */
  async reconnect(name: string): Promise<McpReconnectResult> {
    const reconnected: string[] = [];
    const failed: string[] = [];
    for (const sessionId of this.#o.needs.sessionsNeeding(name)) {
      let ok = false;
      try {
        ok = await this.#o.reconnect(sessionId, name);
      } catch (error) {
        this.#onError(error);
      }
      if (!ok) {
        failed.push(sessionId);
        continue;
      }
      reconnected.push(sessionId);
      if (this.#o.needs.resolve(sessionId, name)) await this.#o.announce(sessionId).catch(this.#onError);
    }
    return { server: name, reconnected, failed };
  }
}
