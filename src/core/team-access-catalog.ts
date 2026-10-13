import type { AccessField, AccessMcpServer } from './team-access.ts';

/**
 * D100-T2 · the small built-in catalog of MCP servers a member's agent can ask for by
 * id (`request_access { kind: "mcp", source: "catalog", catalogId }`). **Data only**:
 * the name, what it runs (or `null` for an entry whose command the developer fills),
 * the fields it needs and the host it talks to. A catalog request runs exactly the
 * catalog's command, never one the agent wrote; a request whose host differs from the
 * entry's shows a warning on its card.
 *
 * Only servers that can be described accurately are listed with a command; the rest
 * are `custom` entries (name and host only) that the developer completes. Secrets go
 * through the environment (`{FIELD}` placeholders are filled when the server starts),
 * never on the command line.
 */
export interface AccessCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  /** The host the server talks to (the request's host is compared with it). */
  readonly host: string;
  /** What it runs; `null` = a custom entry: the developer fills the command at setup. */
  readonly server: AccessMcpServer | null;
  /** The values it needs (environment variables of the server). Custom entries take the agent's fields. */
  readonly fields: readonly AccessField[];
  /** `true` when the command is not known here (the developer fills it). */
  readonly custom: boolean;
  /** A line for the developer (where the server comes from, what to check). */
  readonly note: string;
}

/** The catalog (small on purpose). */
export const ACCESS_CATALOG: readonly AccessCatalogEntry[] = [
  {
    id: 'github',
    name: 'GitHub',
    summary: "GitHub's official MCP server (repositories, issues, pull requests), run from its Docker image.",
    host: 'api.github.com',
    server: { transport: 'stdio', command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'], url: null, headers: {} },
    fields: [
      {
        name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'Personal access token',
        secret: true,
        help: 'A fine-grained token limited to the repositories and the read-only permissions the member needs.',
        helpUrl: 'https://github.com/settings/personal-access-tokens',
        pattern: null,
      },
    ],
    custom: false,
    note: 'Needs Docker on this machine. The token reaches the container through the environment (-e), not the command line.',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    summary: 'Web search through the Brave Search API (the MCP reference server).',
    host: 'api.search.brave.com',
    server: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], url: null, headers: {} },
    fields: [{ name: 'BRAVE_API_KEY', label: 'Brave Search API key', secret: true, help: 'An API key of the Brave Search API.', helpUrl: 'https://brave.com/search/api/', pattern: null }],
    custom: false,
    note: 'Runs with npx (Node). The reference server may be archived upstream: check the package before you set it up.',
  },
  {
    id: 'slack',
    name: 'Slack',
    summary: 'Reads Slack channels and messages (the MCP reference server).',
    host: 'slack.com',
    server: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], url: null, headers: {} },
    fields: [
      { name: 'SLACK_BOT_TOKEN', label: 'Bot token', secret: true, help: 'A bot token (xoxb-…) of a Slack app with read scopes only.', helpUrl: 'https://api.slack.com/apps', pattern: 'xoxb-.+' },
      { name: 'SLACK_TEAM_ID', label: 'Workspace (team) id', secret: false, help: 'The workspace id (starts with T).', helpUrl: null, pattern: 'T[A-Z0-9]+' },
    ],
    custom: false,
    note: 'Runs with npx (Node). The reference server may be archived upstream: check the package before you set it up.',
  },
  {
    id: 'google-analytics',
    name: 'Google Analytics',
    summary: 'Google Analytics reports (the Analytics Data API). The command is yours to fill: use the server you trust.',
    host: 'analyticsdata.googleapis.com',
    server: null,
    fields: [],
    custom: true,
    note: 'Custom: fill the command of the Google Analytics MCP server you use; the fields are the ones the agent declared.',
  },
];

/** The catalog entry `id`, else `null`. */
export function catalogEntry(id: string | null | undefined): AccessCatalogEntry | null {
  return ACCESS_CATALOG.find((entry) => entry.id === id) ?? null;
}

/** The catalog as one text block (the `request_access` tool description lists it). */
export function catalogText(): string {
  return ACCESS_CATALOG.map((entry) => `${entry.id} (${entry.name}, host ${entry.host}${entry.custom ? ', command filled by the developer' : `, fields ${entry.fields.map((f) => f.name).join(', ')}`})`).join('; ');
}
