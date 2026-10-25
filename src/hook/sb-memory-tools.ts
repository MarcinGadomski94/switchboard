/**
 * D107 · the memory tools of the built-in `switchboard` MCP server (`src/hook/sb-mcp.ts`, D68's
 * helper and agent token): `memory_propose` (a proposal the developer reviews) and `memory_list`
 * (the folder's approved entries). The helper asks
 * `GET /agent/v1/memory` (`FeatureTools`, `sb-feature-tools.ts`) and registers them only when it
 * answers 200 (`memory.db` open, a session with a folder; D132: always on since 2.0); 404
 * `no-folder`, 503, a 1.x Switchboard with memory off (404 `memory-off`) or no answer register nothing. The routes check again on every call.
 * Names, descriptions and annotations come from `src/core/memory.ts` ({@link MEMORY_TOOLS}).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MEMORY_TAGS_MAX, MEMORY_TOOLS, type MemoryEntry, memoryListText } from '../core/memory.ts';
import type { TodoToolDefinition } from '../core/todos.ts';
import type { AgentApi, ApiAnswer, ToolInput } from './sb-mcp.ts';

function textResult(text: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function failure(answer: ApiAnswer): CallToolResult {
  const message = record(answer.body)['message'];
  if (answer.status === 401) return textResult('Switchboard refused the switchboard tools for this session (the session token does not match).', true);
  return textResult(typeof message === 'string' ? message : `Switchboard answered HTTP ${answer.status}.`, true);
}

async function request(api: AgentApi, method: 'GET' | 'POST', route: string, body: unknown, done: (body: unknown) => CallToolResult): Promise<CallToolResult> {
  let answer: ApiAnswer;
  try {
    answer = await api(method, route, body);
  } catch (error) {
    return textResult(`Switchboard could not be reached: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  if (answer.status < 200 || answer.status >= 300) return failure(answer);
  return done(answer.body);
}

/** D107 · `memory_propose`: a proposal for this session's folder (used only once the developer approves it). */
export async function memoryPropose(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  if (typeof input['title'] !== 'string' || input['title'].trim() === '') return textResult('Give the entry a short title.', true);
  if (typeof input['text'] !== 'string' || input['text'].trim() === '') return textResult('Give the entry its text: the fact itself, plain and brief.', true);
  const body: Record<string, unknown> = { title: input['title'], text: input['text'] };
  if (input['tags'] !== undefined) body['tags'] = input['tags'];
  // D107 follow-up 2026-10-15: who it is for (the server picks the default when none is given).
  if (input['scope'] !== undefined) body['scope'] = input['scope'];
  if (input['repo'] !== undefined) body['repo'] = input['repo'];
  return request(api, 'POST', '/agent/v1/memory', body, (answer) => {
    const entry = record(answer);
    const scope = typeof entry['scopeKind'] === 'string' ? ` with scope ${String(entry['scopeKind'])}${typeof entry['scopeLabel'] === 'string' ? ` (${entry['scopeLabel']})` : ''}` : '';
    return typeof entry['id'] === 'string'
      ? textResult(`Proposed "${String(entry['title'])}" [${entry['id']}]${scope}. The developer reviews it in Switchboard and may change its scope; it is used only once approved (as written or edited). Do not propose it again.`)
      : textResult('Switchboard did not answer with the entry.', true);
  });
}

/** D107 · `memory_list`: the approved entries this session sees (its member's, its repositories', its folder's), each with its scope. */
export function memoryList(api: AgentApi): Promise<CallToolResult> {
  return request(api, 'GET', '/agent/v1/memory', undefined, (answer) => {
    const value = record(answer);
    const entries = Array.isArray(value['entries']) ? (value['entries'] as MemoryEntry[]) : [];
    return textResult(memoryListText(entries, typeof value['label'] === 'string' ? value['label'] : 'this folder'));
  });
}

function tool(name: string): TodoToolDefinition {
  const found = MEMORY_TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool ${name} in MEMORY_TOOLS`);
  return found;
}

function about(name: string, field: string): string {
  const description = record(record(tool(name).inputSchema['properties'])[field])['description'];
  if (typeof description !== 'string') throw new Error(`no description for ${name}.${field} in MEMORY_TOOLS`);
  return description;
}

/** Registers `memory_propose` and `memory_list` on `server`, calling `api`. */
export function registerMemoryTools(server: McpServer, api: AgentApi): void {
  const propose = tool('memory_propose');
  server.registerTool(
    'memory_propose',
    {
      title: propose.annotations.title,
      description: propose.description,
      inputSchema: z
        .looseObject({
          title: z.string().describe(about('memory_propose', 'title')).optional(),
          text: z.string().describe(about('memory_propose', 'text')).optional(),
          tags: z.array(z.string()).max(MEMORY_TAGS_MAX).describe(about('memory_propose', 'tags')).optional(),
          scope: z.enum(['member', 'repo', 'workspace']).describe(about('memory_propose', 'scope')).optional(),
          repo: z.string().describe(about('memory_propose', 'repo')).optional(),
        })
        .meta({ required: ['title', 'text'], additionalProperties: false }),
      annotations: { title: propose.annotations.title, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => memoryPropose(api, input),
  );
  const list = tool('memory_list');
  server.registerTool('memory_list', { title: list.annotations.title, description: list.description, inputSchema: z.looseObject({}).meta({ additionalProperties: false }), annotations: { title: list.annotations.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, () => memoryList(api));
}

/**
 * The helper's hook (`sb-mcp.ts`): registers the memory tools when Project memory is on for this
 * session (`GET /agent/v1/memory` answers 200); anything else registers nothing. Answers whether it
 * registered them.
 */
export async function registerMemoryToolsIfOn(server: McpServer, api: AgentApi, probe: AgentApi = api): Promise<boolean> {
  try {
    const answer = await probe('GET', '/agent/v1/memory');
    if (answer.status !== 200) return false;
  } catch {
    return false;
  }
  registerMemoryTools(server, api);
  return true;
}
