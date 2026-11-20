/**
 * D163 (`docs/mcp.md` → *Sign-in where it happens (D163)*): an MCP server a running
 * agent's CLI reports as needing a sign-in, from the `mcp_servers` of its
 * `system/init` (repeated at the start of every turn, `docs/spike-m0.md`). Pure rules:
 * reading the init's list, what a session needs, the Needs-you item's words and key.
 */

/** One `mcp_servers[]` entry of a `system/init` (`{name, status, source}`; VERIFIED in recorded CLI output). */
export interface InitMcpServer {
  readonly name: string;
  /** `connected`, `failed`, `needs-auth`, `pending`, … as the CLI reports it. */
  readonly status: string;
  /** Where it comes from: `user`, `project`, `local`, `plugin`, `claudeai` (a claude.ai connector), …; `null` when absent. */
  readonly source: string | null;
}

/** Additive (D163): a server a live agent needs the developer to sign in to (`Session.mcpSignIn`). */
export interface McpSignInNeed {
  readonly name: string;
  /**
   * A claude.ai connector (`source: "claudeai"`, VERIFIED: `{"name":"claude.ai Google Drive","status":"needs-auth","source":"claudeai"}`):
   * signed in on claude.ai, not through a local OAuth flow.
   */
  readonly claudeAi: boolean;
}

/** Where claude.ai connectors are signed in (they are not signed in on this computer). */
export const CLAUDE_AI_CONNECTORS_URL = 'https://claude.ai/settings/connectors';

/** The CLI's status of a server that needs a sign-in. */
export const NEEDS_AUTH_STATUS = 'needs-auth';

/** Reads a `system/init`'s `mcp_servers` (anything malformed is skipped). */
export function parseInitMcpServers(raw: unknown): InitMcpServer[] {
  if (!Array.isArray(raw)) return [];
  const out: InitMcpServer[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row['name'] === 'string' ? row['name'].trim() : '';
    const status = typeof row['status'] === 'string' ? row['status'] : '';
    if (name === '' || status === '') continue;
    out.push({ name, status, source: typeof row['source'] === 'string' ? row['source'] : null });
  }
  return out;
}

/** Whether a server is a claude.ai connector (its source, else the CLI's `claude.ai ` name prefix). */
export function isClaudeAiConnector(server: Pick<InitMcpServer, 'name' | 'source'>): boolean {
  return server.source === 'claudeai' || server.name.startsWith('claude.ai ');
}

/** The servers of one init that need a sign-in, by name, once each. */
export function signInNeeds(servers: readonly InitMcpServer[]): McpSignInNeed[] {
  const seen = new Map<string, McpSignInNeed>();
  for (const server of servers) if (server.status === NEEDS_AUTH_STATUS && !seen.has(server.name)) seen.set(server.name, { name: server.name, claudeAi: isClaudeAiConnector(server) });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether two need lists are the same (names and kinds, in order). */
export function sameNeeds(a: readonly McpSignInNeed[], b: readonly McpSignInNeed[]): boolean {
  return a.length === b.length && a.every((need, i) => need.name === b[i]?.name && need.claudeAi === b[i]?.claudeAi);
}

/** The agent view's notice line for one server. D183: a claude.ai connector says where it is managed (not in this computer's MCP settings). */
export function signInNoticeText(need: McpSignInNeed): string {
  return need.claudeAi ? `${need.name} needs you to sign in again. It's a claude.ai connector, managed on claude.ai (Settings → Connectors), not in Switchboard's MCP list` : `${need.name} needs you to sign in again`;
}

// ── D183 · "Don't ask again" and the claude.ai connectors seen (docs/mcp.md → Don't ask again (D183)) ──

/** The setting holding the servers whose sign-in Switchboard does not ask for (per install, not synced). */
export const MCP_SIGN_IN_MUTED_SETTING = 'mcp.signInMuted';

/** The setting holding the claude.ai connectors this computer's agents reported (for Settings › MCP). */
export const MCP_CONNECTORS_SEEN_SETTING = 'mcp.claudeAiConnectors';

/** Most servers kept in either list. */
export const MCP_SIGN_IN_LIST_MAX = 200;

/** A claude.ai connector an agent on this computer reported, with its last status. */
export interface ClaudeAiConnectorSeen {
  readonly name: string;
  /** The CLI's last status (`connected`, `needs-auth`, …). */
  readonly status: string;
  /** When it was last reported (ISO). */
  readonly at: string;
}

/** `GET /api/mcp/sign-in` (D183): the muted servers and the claude.ai connectors seen. */
export interface McpSignInSettings {
  /** Servers Switchboard does not ask to sign in to (sorted). */
  readonly muted: readonly string[];
  /** The claude.ai connectors agents on this computer reported (by name). */
  readonly connectors: readonly ClaudeAiConnectorSeen[];
}

/** Reads the muted list as stored (anything malformed is dropped; unique, sorted, capped). */
export function readMutedServers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '' && entry.length <= 200).map((entry) => entry.trim());
  return [...new Set(names)].sort((a, b) => a.localeCompare(b)).slice(0, MCP_SIGN_IN_LIST_MAX);
}

/** Reads the stored connectors seen (anything malformed is dropped), by name. */
export function readConnectorsSeen(value: unknown): ClaudeAiConnectorSeen[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<string, ClaudeAiConnectorSeen>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row['name'] !== 'string' || row['name'].trim() === '' || typeof row['status'] !== 'string' || typeof row['at'] !== 'string') continue;
    out.set(row['name'], { name: row['name'], status: row['status'], at: row['at'] });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MCP_SIGN_IN_LIST_MAX);
}

/** The muted list with `name` muted or not (`muted`), as stored. */
export function withMuted(current: readonly string[], name: string, muted: boolean): string[] {
  const set = new Set(current);
  if (muted) set.add(name);
  else set.delete(name);
  return readMutedServers([...set]);
}

/** The Needs-you item's title. */
export function signInItemTitle(name: string): string {
  return `Sign in to ${name}`;
}

/** The Needs-you item's detail: the agents that wait for it, and how to sign in. */
export function signInItemDetail(name: string, agents: readonly string[], claudeAi: boolean): string {
  const who = agents.length === 0 ? 'An agent' : agents.length === 1 ? `“${agents[0]}”` : `${agents.length} agents (${agents.map((a) => `“${a}”`).join(', ')})`;
  const how = claudeAi ? `Open the agent and use Open claude.ai connectors, then Reconnect.` : `Open the agent and use Sign in: the sign-in opens in your browser, and the agents reconnect by themselves when it is done.`;
  return `${who} can’t use ${name} until you sign in again. ${how}`;
}
