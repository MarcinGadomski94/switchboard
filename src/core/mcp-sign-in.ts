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

/** The agent view's notice line for one server. */
export function signInNoticeText(need: McpSignInNeed): string {
  return need.claudeAi ? `${need.name} needs you to sign in again on claude.ai` : `${need.name} needs you to sign in again`;
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
