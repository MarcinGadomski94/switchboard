/**
 * 2026-10-16 (`docs/fake-claude.md` → *Running the switchboard MCP server*): opt-in, the fake
 * runs the `switchboard` stdio server of its `--mcp-config` as the real CLI does, over the
 * official MCP SDK's client: it connects at start, lists the tools and (like Claude Code
 * 2.1.296) lists them again on `notifications/tools/list_changed`. With
 * `FAKE_CLAUDE_MCP_LIST_CHANGED=0` it ignores that notification, like a CLI that never
 * re-lists. The tools it holds are logged with each user message (`FAKE_CLAUDE_LOG`,
 * `{"kind":"mcp-tools",tools}`), so a test sees which tools the agent had when an ask arrived.
 *
 * Only `FAKE_CLAUDE_MCP_RUN=1` turns it on; other servers in the config are ignored.
 */
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

/** The server the fake runs (Switchboard's built-in one). */
const SERVER = 'switchboard';

interface StdioConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The `switchboard` stdio server of the `--mcp-config` values (a file or inline JSON each), `null` without one. */
async function switchboardConfig(configs: readonly string[]): Promise<StdioConfig | null> {
  for (const value of configs) {
    let text = value;
    if (!value.trimStart().startsWith('{')) {
      try {
        text = await readFile(value, 'utf8');
      } catch {
        continue;
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const server = record(record(record(parsed)['mcpServers'])[SERVER]);
    if (typeof server['command'] !== 'string') continue;
    const args = Array.isArray(server['args']) ? server['args'].filter((arg): arg is string => typeof arg === 'string') : [];
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(record(server['env']))) if (typeof val === 'string') env[key] = val;
    return { command: server['command'], args, env };
  }
  return null;
}

/** The fake's running `switchboard` server: its current tool list. */
export class FakeMcpClient {
  #tools: string[] = [];
  readonly #client: Client;

  private constructor(client: Client) {
    this.#client = client;
  }

  /** Starts the server when `FAKE_CLAUDE_MCP_RUN=1` and the config has one; `null` otherwise (or when it fails to start). */
  static async start(configs: readonly string[], env: NodeJS.ProcessEnv): Promise<FakeMcpClient | null> {
    if (env['FAKE_CLAUDE_MCP_RUN'] !== '1') return null;
    const config = await switchboardConfig(configs);
    if (!config) return null;
    const client = new Client({ name: 'fake-claude', version: '0.0.0' }, { capabilities: {} });
    const self = new FakeMcpClient(client);
    if (env['FAKE_CLAUDE_MCP_LIST_CHANGED'] !== '0') {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        await self.#list().catch(() => undefined);
      });
    }
    try {
      await client.connect(new StdioClientTransport({ command: config.command, args: [...config.args], env: { ...config.env, PATH: env['PATH'] ?? '' }, stderr: 'ignore' }));
      await self.#list();
    } catch {
      return null;
    }
    return self;
  }

  async #list(): Promise<void> {
    const answer = await this.#client.listTools();
    this.#tools = answer.tools.map((tool) => tool.name);
  }

  /** D124: calls tool `name` of the server; its text content and whether it is an error (a failed call is an error text). */
  async call(name: string, args: Readonly<Record<string, unknown>>): Promise<{ readonly text: string; readonly isError: boolean }> {
    try {
      const answer = await this.#client.callTool({ name, arguments: { ...args } });
      const content = Array.isArray(answer.content) ? (answer.content as Array<{ type?: string; text?: string }>) : [];
      return { text: content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n'), isError: answer.isError === true };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  /** The tool names as last listed. */
  tools(): string[] {
    return [...this.#tools];
  }

  /** Ends the server. */
  async close(): Promise<void> {
    await this.#client.close().catch(() => undefined);
  }
}
