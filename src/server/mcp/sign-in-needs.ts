import { type ClaudeAiConnectorSeen, type InitMcpServer, type McpSignInNeed, isClaudeAiConnector, sameNeeds, signInNeeds } from '../../core/mcp-sign-in.ts';

/**
 * D163 (`docs/mcp.md` → *Sign-in where it happens*): the MCP servers each live
 * session's CLI reported as needing a sign-in at its latest `system/init`. Derived,
 * in memory: a session's list is replaced at every turn start and dropped when its
 * process ends (nothing is stored). Listeners hear every change.
 *
 * D183: servers the developer muted ("Don't ask again") are kept in the reports but left
 * out of everything this answers (the session's `mcpSignIn`, the Needs-you items, the
 * reconnects); and every claude.ai connector a CLI reports is remembered with its status
 * (Settings › MCP lists them).
 */
export class McpSignInNeeds {
  readonly #bySession = new Map<string, McpSignInNeed[]>();
  readonly #listeners = new Set<() => void>();
  readonly #connectorListeners = new Set<(connectors: readonly ClaudeAiConnectorSeen[]) => void>();
  #muted: ReadonlySet<string> = new Set();
  readonly #connectors = new Map<string, ClaudeAiConnectorSeen>();
  readonly #now: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** A turn's `init` of session `sessionId`; answers whether its list changed. */
  report(sessionId: string, servers: readonly InitMcpServer[]): boolean {
    this.#noteConnectors(servers);
    const next = signInNeeds(servers);
    const before = this.#bySession.get(sessionId) ?? [];
    if (sameNeeds(before, next)) return false;
    if (next.length === 0) this.#bySession.delete(sessionId);
    else this.#bySession.set(sessionId, next);
    this.#changed();
    return true;
  }

  /** The session's process ended: its list goes; answers whether it had one. */
  forget(sessionId: string): boolean {
    if (!this.#bySession.delete(sessionId)) return false;
    this.#changed();
    return true;
  }

  /** A sign-in of `name` succeeded and the session was told to reconnect: it no longer needs it (its next `init` says again if it does). */
  resolve(sessionId: string, name: string): boolean {
    const before = this.#bySession.get(sessionId);
    if (!before?.some((need) => need.name === name)) return false;
    const next = before.filter((need) => need.name !== name);
    if (next.length === 0) this.#bySession.delete(sessionId);
    else this.#bySession.set(sessionId, next);
    this.#changed();
    return true;
  }

  /** D183: the servers not asked for; answers the sessions whose list (as answered) changed. */
  setMuted(names: Iterable<string>): string[] {
    const next = new Set(names);
    const before = this.#muted;
    if (next.size === before.size && [...next].every((name) => before.has(name))) return [];
    const flipped = new Set([...next].filter((name) => !before.has(name)).concat([...before].filter((name) => !next.has(name))));
    this.#muted = next;
    const affected = [...this.#bySession].filter(([, needs]) => needs.some((need) => flipped.has(need.name))).map(([sessionId]) => sessionId);
    this.#changed();
    return affected;
  }

  /** D183: the muted servers. */
  muted(): ReadonlySet<string> {
    return this.#muted;
  }

  /** What session `sessionId` needs now (empty when nothing; muted servers left out). */
  of(sessionId: string): readonly McpSignInNeed[] {
    const needs = this.#bySession.get(sessionId) ?? [];
    return this.#muted.size === 0 ? needs : needs.filter((need) => !this.#muted.has(need.name));
  }

  /** Every server some session needs, with those sessions (in the order they reported); muted servers left out. */
  byServer(): Map<string, { readonly claudeAi: boolean; readonly sessionIds: string[] }> {
    const out = new Map<string, { claudeAi: boolean; sessionIds: string[] }>();
    for (const [sessionId, needs] of this.#bySession) {
      for (const need of needs) {
        if (this.#muted.has(need.name)) continue;
        const entry = out.get(need.name) ?? { claudeAi: need.claudeAi, sessionIds: [] };
        entry.sessionIds.push(sessionId);
        out.set(need.name, entry);
      }
    }
    return out;
  }

  /** The sessions that need `name` (none while it is muted). */
  sessionsNeeding(name: string): string[] {
    if (this.#muted.has(name)) return [];
    return [...this.#bySession].filter(([, needs]) => needs.some((need) => need.name === name)).map(([sessionId]) => sessionId);
  }

  /** D183: seeds the claude.ai connectors remembered before (a restart). */
  seedConnectors(connectors: readonly ClaudeAiConnectorSeen[]): void {
    for (const connector of connectors) if (!this.#connectors.has(connector.name)) this.#connectors.set(connector.name, connector);
  }

  /** D183: the claude.ai connectors reported so far, by name. */
  connectors(): ClaudeAiConnectorSeen[] {
    return [...this.#connectors.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Calls `listener` after every change; answers the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** D183: calls `listener` when a claude.ai connector is first seen or its status changes; answers the unsubscribe. */
  onConnectorsChange(listener: (connectors: readonly ClaudeAiConnectorSeen[]) => void): () => void {
    this.#connectorListeners.add(listener);
    return () => this.#connectorListeners.delete(listener);
  }

  #noteConnectors(servers: readonly InitMcpServer[]): void {
    let changed = false;
    const at = new Date(this.#now()).toISOString();
    for (const server of servers) {
      if (!isClaudeAiConnector(server)) continue;
      const before = this.#connectors.get(server.name);
      if (before?.status === server.status) continue;
      this.#connectors.set(server.name, { name: server.name, status: server.status, at });
      changed = true;
    }
    if (!changed) return;
    const list = this.connectors();
    for (const listener of this.#connectorListeners) listener(list);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}
