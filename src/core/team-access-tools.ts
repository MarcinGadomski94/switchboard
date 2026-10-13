import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ACCESS_FIELDS_MAX, ACCESS_RATE_LIMIT } from './team-access.ts';
import { catalogText } from './team-access-catalog.ts';
import type { TeamAgentApi } from './team-tools.ts';

/**
 * D100-T2 · `request_access`, a Team tool of the built-in `switchboard` MCP server:
 * registered with the other Team tools, so **only in a member's session and only
 * while Team is on** (`registerTeamToolsIfMember`). It calls
 * `POST /agent/v1/team/access`; the developer answers in Needs you and sets the
 * access up in the member's Access tab. The tool never carries a value.
 */

/** The tool's description: when to ask, how little, and never credentials in chat. */
export const REQUEST_ACCESS_DESCRIPTION = [
  'Ask the developer for access to a data source you need for your charter: an MCP server, or an API key given to you as an environment variable.',
  'Use it ONLY when you are actually blocked without it (you have checked the access you already have, listed in your instructions), and ask for the MINIMUM: one service, the one host you will talk to, the smallest read-only scope that is enough, and only the fields you need.',
  'NEVER ask for passwords, tokens or keys in chat, never ask the developer to paste a value into a message or a file, and never print, log or write down a value you are given: the developer types values into Switchboard, which keeps them in the OS keychain and gives them only to you.',
  'Declare: kind ("mcp" or "api-key"); service (its name); host (the exact host name it talks to, e.g. api.example.com); why (what you will fetch and for what); scope (e.g. "read-only, reports"); and fields: the values the developer must fill, each { name: UPPER_CASE environment variable, label, secret: true/false, help (where to find it), helpUrl (optional https page), pattern (optional regex) }.',
  `For an MCP server set source: "catalog" with catalogId (known servers: ${catalogText()}), "custom" with an optional server suggestion { transport: "stdio", command, args } or { transport: "http", url, headers } (the developer confirms the command; write values only as {FIELD} placeholders), or "shared" with sharedServer (a server the developer already has on the MCP page).`,
  'For an API key you may add testUrl (an https URL on that same host the developer can test the key against) and testHeader { name, value with {FIELD} placeholders }.',
  `The developer approves, denies or postpones; nothing is ever approved automatically. Asking again for the same thing reuses the open request; at most ${ACCESS_RATE_LIMIT} new requests per hour. After asking, carry on with what you can do without it: you are told when it is set up (your process restarts once to receive it).`,
].join(' ');

function text(value: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text: value }], isError: true } : { content: [{ type: 'text', text: value }] };
}

/** `request_access`. */
export async function requestAccess(api: TeamAgentApi, input: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
  let answer: { readonly status: number; readonly body: unknown };
  try {
    answer = await api('POST', '/agent/v1/team/access', input);
  } catch (error) {
    return text(`Switchboard could not be reached: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  const body = answer.body as { text?: unknown; message?: unknown } | null;
  if (answer.status === 201) return text(typeof body?.text === 'string' ? body.text : 'Asked the developer.');
  return text(typeof body?.message === 'string' ? body.message : `Switchboard answered HTTP ${answer.status}.`, true);
}

const field = z
  .looseObject({
    name: z.string().describe('The environment variable the value is given as: UPPER_CASE, e.g. ACME_ANALYTICS_KEY (not PATH, NODE_OPTIONS or another reserved name).').optional(),
    label: z.string().describe('What the developer sees, e.g. "API key".').optional(),
    secret: z.boolean().describe('true for a secret (a password field, masked everywhere); false for a plain value such as an account id.').optional(),
    help: z.string().describe('Where to find it and what it is.').optional(),
    helpUrl: z.string().describe('Optional https page that explains how to get it.').optional(),
    pattern: z.string().describe('Optional regular expression the value must match.').optional(),
  })
  .meta({ required: ['name', 'label', 'secret', 'help'] });

/** Registers `request_access` on `server` (with the other Team tools: a member's session only). */
export function registerAccessTool(server: McpServer, api: TeamAgentApi): void {
  server.registerTool(
    'request_access',
    {
      title: 'Ask the developer for data access',
      description: REQUEST_ACCESS_DESCRIPTION,
      inputSchema: z
        .looseObject({
          kind: z.enum(['mcp', 'api-key']).describe('"mcp": an MCP server; "api-key": a key given to you as environment variables.').optional(),
          service: z.string().max(80).describe('The service, e.g. "Acme Analytics".').optional(),
          host: z.string().max(253).describe('The exact host it talks to, e.g. api.acme.example.').optional(),
          why: z.string().max(1_000).describe('What you will fetch and for what (the developer reads it).').optional(),
          scope: z.string().max(200).describe('The smallest scope that is enough, e.g. "read-only, reports".').optional(),
          fields: z.array(field).max(ACCESS_FIELDS_MAX).describe('The values the developer fills (never the values themselves).').optional(),
          source: z.enum(['catalog', 'custom', 'shared']).describe('mcp only: where the server comes from.').optional(),
          catalogId: z.string().describe('mcp, source "catalog": the catalog entry id.').optional(),
          server: z.looseObject({}).describe('mcp, source "custom": a suggestion { transport, command, args } or { transport, url, headers }; values only as {FIELD} placeholders.').optional(),
          sharedServer: z.string().describe('mcp, source "shared": the MCP page server name.').optional(),
          testUrl: z.string().describe('api-key: an https URL on the same host to test the key against (optional).').optional(),
          testHeader: z.looseObject({ name: z.string().optional(), value: z.string().optional() }).describe('api-key: the header that carries the key in the test, value with {FIELD} placeholders.').optional(),
        })
        .meta({ required: ['kind', 'service', 'host', 'why', 'scope'] }),
      annotations: { title: 'Ask the developer for data access', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => requestAccess(api, input),
  );
}
