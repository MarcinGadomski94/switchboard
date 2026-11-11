import { type InitMcpServer, type McpSignInNeed, sameNeeds, signInNeeds } from '../../core/mcp-sign-in.ts';

/**
 * D163 (`docs/mcp.md` → *Sign-in where it happens*): the MCP servers each live
 * session's CLI reported as needing a sign-in at its latest `system/init`. Derived,
 * in memory: a session's list is replaced at every turn start and dropped when its
 * process ends (nothing is stored). Listeners hear every change.
 */
export class McpSignInNeeds {
  readonly #bySession = new Map<string, McpSignInNeed[]>();
  readonly #listeners = new Set<() => void>();

  /** A turn's `init` of session `sessionId`; answers whether its list changed. */
  report(sessionId: string, servers: readonly InitMcpServer[]): boolean {
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

  /** What session `sessionId` needs now (empty when nothing). */
  of(sessionId: string): readonly McpSignInNeed[] {
    return this.#bySession.get(sessionId) ?? [];
  }

  /** Every server some session needs, with those sessions (in the order they reported). */
  byServer(): Map<string, { readonly claudeAi: boolean; readonly sessionIds: string[] }> {
    const out = new Map<string, { claudeAi: boolean; sessionIds: string[] }>();
    for (const [sessionId, needs] of this.#bySession) {
      for (const need of needs) {
        const entry = out.get(need.name) ?? { claudeAi: need.claudeAi, sessionIds: [] };
        entry.sessionIds.push(sessionId);
        out.set(need.name, entry);
      }
    }
    return out;
  }

  /** The sessions that need `name`. */
  sessionsNeeding(name: string): string[] {
    return [...this.#bySession].filter(([, needs]) => needs.some((need) => need.name === name)).map(([sessionId]) => sessionId);
  }

  /** Calls `listener` after every change; answers the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}
