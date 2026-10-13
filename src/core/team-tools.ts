import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { HANDOFF_TEXT_MAX, REPORT_MAX } from './team.ts';

/**
 * D100 · the Team tools of the built-in `switchboard` MCP server (`src/hook/sb-mcp.ts`,
 * D68's helper and agent token): only a **member's** session gets them, and only
 * while Team is on. The helper asks `GET /agent/v1/team` once at start (404 = not a
 * member or Team off: no tools); the routes check again on every call. No free-form
 * agent-to-agent chat: work goes between members as written hand-offs, which land in
 * the receiver's todo list. Artifacts stay `artifact_save`.
 */

/** The local API as the helper calls it (status + parsed body). */
export type TeamAgentApi = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => Promise<{ readonly status: number; readonly body: unknown }>;

/** One tool's name, description and annotations (the input schemas are the zod shapes below). */
export interface TeamToolDefinition {
  readonly name: 'team_handoff' | 'team_members' | 'team_report';
  readonly title: string;
  readonly description: string;
  readonly readOnly: boolean;
}

/** The three tools. */
export const TEAM_TOOLS: readonly TeamToolDefinition[] = [
  {
    name: 'team_handoff',
    title: 'Hand work to another team member',
    description:
      'Give another member of your team a written work item (a hand-off). Name the receiver by its role name (team_members lists them), write a brief (what to do and why, with the context the receiver needs: it has not seen this conversation) and the expected result (what "done" looks like). It lands as a todo in the receiver\'s list and, if the receiver works on hand-offs, the receiver is told. Use it only for work inside the receiver\'s charter; it is not a chat: do not use it to ask questions or to reply.',
    readOnly: false,
  },
  {
    name: 'team_members',
    title: 'List the team',
    description: "List your team's members: role name, status (working, needs-you, idle, paused, offline), the machine it runs on and its charter (owns, produces, never does), plus your own open hand-offs. Read it before handing off, to pick the right receiver.",
    readOnly: true,
  },
  {
    name: 'team_report',
    title: 'Post a status line to the team',
    description:
      'Post one short status line to the team activity the developer reads (for example "Sweep done: 2 new errors, handed to Developer"). One line, at most 500 characters. Use it at milestones and at the end of a loop run, not for every step. Deliverables (reports, plans, tables) go to artifact_save, not here.',
    readOnly: false,
  },
];

function text(value: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text: value }], isError: true } : { content: [{ type: 'text', text: value }] };
}

function failure(answer: { readonly status: number; readonly body: unknown }): CallToolResult {
  const body = answer.body as { message?: unknown } | null;
  return text(typeof body?.message === 'string' ? body.message : `Switchboard answered HTTP ${answer.status}.`, true);
}

async function call(api: TeamAgentApi, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ readonly status: number; readonly body: unknown } | CallToolResult> {
  try {
    return await api(method, path, body);
  } catch (error) {
    return text(`Switchboard could not be reached: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

function isResult(value: unknown): value is CallToolResult {
  return typeof value === 'object' && value !== null && 'content' in value;
}

/** `team_handoff`. */
export async function teamHandoff(api: TeamAgentApi, input: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
  if (typeof input['to'] !== 'string' || input['to'].trim() === '') return text('team_handoff needs "to": the receiver\'s role name (see team_members).', true);
  if (typeof input['brief'] !== 'string' || input['brief'].trim() === '') return text('team_handoff needs a "brief": what to do and why.', true);
  const answer = await call(api, 'POST', '/agent/v1/team/handoffs', { to: input['to'], brief: input['brief'], expected: input['expected'] ?? '', links: input['links'] ?? [] });
  if (isResult(answer)) return answer;
  if (answer.status !== 201) return failure(answer);
  const handoff = answer.body as { id?: string };
  return text(`Handed off to ${String(input['to'])} (hand-off ${handoff.id ?? '?'}). It lands in their todo list.`);
}

/** `team_members`. */
export async function teamMembers(api: TeamAgentApi): Promise<CallToolResult> {
  const answer = await call(api, 'GET', '/agent/v1/team/members');
  if (isResult(answer)) return answer;
  if (answer.status !== 200) return failure(answer);
  return text(String((answer.body as { text?: unknown } | null)?.text ?? ''));
}

/** `team_report`. */
export async function teamReport(api: TeamAgentApi, input: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
  if (typeof input['text'] !== 'string' || input['text'].trim() === '') return text('team_report needs "text": one short status line.', true);
  const answer = await call(api, 'POST', '/agent/v1/team/reports', { text: input['text'] });
  if (isResult(answer)) return answer;
  if (answer.status !== 201) return failure(answer);
  return text('Posted to the team activity.');
}

function definition(name: TeamToolDefinition['name']): TeamToolDefinition {
  return TEAM_TOOLS.find((tool) => tool.name === name) as TeamToolDefinition;
}

function annotations(tool: TeamToolDefinition) {
  return { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: false };
}

/** Registers the three tools on `server` (the helper does it only for a member's session). */
export function registerTeamTools(server: McpServer, api: TeamAgentApi): void {
  const handoff = definition('team_handoff');
  server.registerTool(
    handoff.name,
    {
      title: handoff.title,
      description: handoff.description,
      inputSchema: z
        .looseObject({
          to: z.string().describe("The receiver's role name, as team_members lists it.").optional(),
          brief: z.string().max(HANDOFF_TEXT_MAX).describe('What to do and why, with the context the receiver needs (it has not seen this conversation).').optional(),
          expected: z.string().max(HANDOFF_TEXT_MAX).describe('The expected result: what "done" looks like.').optional(),
          links: z.array(z.string()).max(20).describe('Optional links or paths that help (tickets as PROJ-123, files, URLs).').optional(),
        })
        .meta({ required: ['to', 'brief', 'expected'], additionalProperties: false }),
      annotations: annotations(handoff),
    },
    (input) => teamHandoff(api, input),
  );
  const members = definition('team_members');
  server.registerTool(members.name, { title: members.title, description: members.description, inputSchema: z.looseObject({}).meta({ additionalProperties: false }), annotations: annotations(members) }, () => teamMembers(api));
  const report = definition('team_report');
  server.registerTool(
    report.name,
    {
      title: report.title,
      description: report.description,
      inputSchema: z
        .looseObject({ text: z.string().max(REPORT_MAX).describe('One short status line (at most 500 characters).').optional() })
        .meta({ required: ['text'], additionalProperties: false }),
      annotations: annotations(report),
    },
    (input) => teamReport(api, input),
  );
}

/**
 * The helper's hook: registers the Team tools when this session is a team member and
 * Team is on (`GET /agent/v1/team` answers 200); anything else (404, an older
 * Switchboard, no answer within `probe`'s timeout) registers nothing; the tools then call `api`.
 */
export async function registerTeamToolsIfMember(server: McpServer, api: TeamAgentApi, probe: TeamAgentApi = api): Promise<boolean> {
  try {
    const answer = await probe('GET', '/agent/v1/team');
    if (answer.status !== 200) return false;
  } catch {
    return false;
  }
  registerTeamTools(server, api);
  return true;
}
