import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_MCP_MARKER, AGENT_MCP_SERVER, AGENT_TOKEN_ENV } from '../../core/todos.ts';

/**
 * D68 (`docs/todos.md` → *The agent's tools*): how a session's CLI starts the
 * built-in `switchboard` MCP server, the stdio helper `src/hook/sb-mcp.ts`. The
 * helper gets the port and the session id on its argv and the session's agent
 * token in its environment ({@link AGENT_TOKEN_ENV}); it calls this Switchboard's
 * `/agent/v1/todos`. Each CLI gets it through its own mechanism, added to (never
 * replacing) the developer's own MCP configuration, and no file of the
 * developer's is written:
 *
 * - Claude Code: `--mcp-config <file>` (a 0600 file in Switchboard's data folder,
 *   so the token is not on the argv) and `--allowedTools mcp__switchboard` (its
 *   tools run without a permission prompt).
 * - Codex CLI: `-c mcp_servers.switchboard.*` overrides before `app-server`, the
 *   token passed through `env_vars` from the app-server's own environment
 *   (UNVERIFIED: no Codex CLI to run, `docs/spike-providers.md`).
 * - OpenCode: an `mcp.switchboard` entry (`type: local`) merged into
 *   `OPENCODE_CONFIG_CONTENT` (UNVERIFIED likewise).
 */
export interface AgentMcpLaunch {
  /** The server's name ({@link AGENT_MCP_SERVER}). */
  readonly name: string;
  /** The Node binary that runs the helper (this Switchboard's own). */
  readonly command: string;
  /** `[<helper script>, --switchboard-mcp, <port>, <session id>]`. */
  readonly args: readonly string[];
  /** `{ SWITCHBOARD_TODO_TOKEN: <the session's agent token> }`. */
  readonly env: Readonly<Record<string, string>>;
  /** Claude Code: the `--mcp-config` file written for this spawn; `null` = pass the JSON inline (tests). */
  readonly claudeConfigFile: string | null;
}

/** The helper script (next to the hook script). */
export const AGENT_MCP_SCRIPT = path.resolve(import.meta.dirname, '..', '..', 'hook', 'sb-mcp.ts');

/** The launch of session `sessionId`'s helper (no file yet). */
export function agentMcpLaunch(input: { readonly nodePath: string; readonly scriptPath?: string; readonly port: number; readonly sessionId: string; readonly token: string }): AgentMcpLaunch {
  return {
    name: AGENT_MCP_SERVER,
    command: input.nodePath,
    args: [input.scriptPath ?? AGENT_MCP_SCRIPT, AGENT_MCP_MARKER, String(input.port), input.sessionId],
    env: { [AGENT_TOKEN_ENV]: input.token },
    claudeConfigFile: null,
  };
}

/** Claude Code's `--mcp-config` document (`mcpServers`, a stdio server). */
export function claudeMcpConfig(launch: AgentMcpLaunch): { readonly mcpServers: Record<string, unknown> } {
  return { mcpServers: { [launch.name]: { type: 'stdio', command: launch.command, args: [...launch.args], env: { ...launch.env } } } };
}

/** Claude Code's extra argv: the config (file, else inline JSON) and the allow rule for the server's tools. */
export function claudeMcpArgs(launch: AgentMcpLaunch): string[] {
  return ['--mcp-config', launch.claudeConfigFile ?? JSON.stringify(claudeMcpConfig(launch)), '--allowedTools', `mcp__${launch.name}`];
}

/** A TOML basic string (JSON's escapes are valid TOML ones). */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Codex CLI's extra argv (before the subcommand): the server as `-c` config overrides; the token comes from the environment (`env_vars`). */
export function codexMcpArgs(launch: AgentMcpLaunch): string[] {
  const key = `mcp_servers.${launch.name}`;
  return [
    '-c',
    `${key}.command=${tomlString(launch.command)}`,
    '-c',
    `${key}.args=[${launch.args.map(tomlString).join(', ')}]`,
    '-c',
    `${key}.env_vars=[${Object.keys(launch.env).map(tomlString).join(', ')}]`,
  ];
}

/** OpenCode's `mcp` entry (merged into `OPENCODE_CONFIG_CONTENT`). */
export function opencodeMcpEntry(launch: AgentMcpLaunch): Record<string, unknown> {
  return { type: 'local', command: [launch.command, ...launch.args], environment: { ...launch.env }, enabled: true };
}

/**
 * Writes Claude Code's config for the spawn to `<dataDir>/agent-mcp/<session id>.json`
 * (folder 0700, file 0600; rewritten at every spawn) and answers the launch with it.
 */
export async function withClaudeConfigFile(dataDir: string, sessionId: string, launch: AgentMcpLaunch): Promise<AgentMcpLaunch> {
  const dir = path.join(dataDir, 'agent-mcp');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  await writeFile(file, `${JSON.stringify(claudeMcpConfig(launch), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
  return { ...launch, claudeConfigFile: file };
}
