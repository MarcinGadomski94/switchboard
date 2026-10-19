import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CHARTER_FIELD_MAX, CHARTER_NOTES_MAX, HANDOFF_TEXT_MAX, REPORT_MAX } from './team.ts';
import { registerAccessTool } from './team-access-tools.ts';

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
  readonly name: 'team_handoff' | 'team_members' | 'team_report' | 'team_propose_charter';
  readonly title: string;
  readonly description: string;
  /** The four MCP behaviour hints, each explicit (directories require all four). */
  readonly annotations: { readonly readOnlyHint: boolean; readonly destructiveHint: boolean; readonly idempotentHint: boolean; readonly openWorldHint: boolean };
}

/** The tools (D105 added `team_propose_charter`). */
export const TEAM_TOOLS: readonly TeamToolDefinition[] = [
  {
    name: 'team_handoff',
    title: 'Hand work to another team member',
    description:
      'Give another member of your team a written work item (a hand-off). Name the receiver by its role name (team_members lists them); a member of another team as "Role (Team)" or with team. Write a brief (what to do and why, with the context the receiver needs: it has not seen this conversation) and the expected result (what "done" looks like). It lands as a todo in the receiver\'s list and, if the receiver works on hand-offs, the receiver is told. Use it only for work inside the receiver\'s charter; it is not a chat: do not use it to ask questions or to reply.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'team_members',
    title: 'List the team',
    description: "List your team's members: role name, status (working, needs-you, idle, paused, offline), the machine it runs on and its charter (owns, produces, never does), plus your own open hand-offs and the other teams. Pass team to list another team. Read it before handing off, to pick the right receiver.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'team_report',
    title: 'Post a status line to the team',
    description:
      'Post one short status line to the team activity the developer reads (for example "Sweep done: 2 new errors, handed to Developer"). One line, at most 500 characters. Use it at milestones and at the end of a loop run, not for every step. Deliverables (reports, plans, tables) go to artifact_save, not here.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'team_propose_charter',
    title: 'Propose a charter for yourself',
    description:
      "Propose a new, specific charter for your own role. It is a PROPOSAL: the developer reviews it and accepts, edits or dismisses it; nothing changes until it is accepted. Call it once, when Switchboard (or the developer) asks you to, after summarising your own work in this session. Be specific: name the concrete feature or product area you own, the repositories you work in, what you actually deliver and where, the recurring process you run (rounds, cadence) and who gives you input or feedback (the developer, other people, other members). Base every field on this session's history and never invent a responsibility the history does not show. owns, produces and neverDoes are required; howItWorks is a short paragraph on how you work today; notes are for the developer only.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
  const team = typeof input['team'] === 'string' && input['team'].trim() !== '' ? { team: input['team'] } : {};
  const answer = await call(api, 'POST', '/agent/v1/team/handoffs', { to: input['to'], brief: input['brief'], expected: input['expected'] ?? '', links: input['links'] ?? [], ...team });
  if (isResult(answer)) return answer;
  if (answer.status !== 201) return failure(answer);
  const handoff = answer.body as { id?: string };
  return text(`Handed off to ${String(input['to'])} (hand-off ${handoff.id ?? '?'}). It lands in their todo list.`);
}

/** `team_members`. */
export async function teamMembers(api: TeamAgentApi, input: Readonly<Record<string, unknown>> = {}): Promise<CallToolResult> {
  const team = typeof input['team'] === 'string' && input['team'].trim() !== '' ? `?team=${encodeURIComponent(input['team'])}` : '';
  const answer = await call(api, 'GET', `/agent/v1/team/members${team}`);
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

/** `team_propose_charter` (D105). */
export async function teamProposeCharter(api: TeamAgentApi, input: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
  for (const field of ['owns', 'produces', 'neverDoes'] as const) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') return text(`team_propose_charter needs "${field}": specific to your work in this session.`, true);
  }
  const optional = (key: 'howItWorks' | 'notes') => (typeof input[key] === 'string' && input[key].trim() !== '' ? { [key]: input[key] } : {});
  const answer = await call(api, 'POST', '/agent/v1/team/charter', { owns: input['owns'], produces: input['produces'], neverDoes: input['neverDoes'], ...optional('howItWorks'), ...optional('notes') });
  if (isResult(answer)) return answer;
  if (answer.status !== 201) return failure(answer);
  return text('Proposed. The developer reviews it in Team → Needs you; your charter changes only if it is accepted, and then you get the new one with your next message.');
}

function definition(name: TeamToolDefinition['name']): TeamToolDefinition {
  return TEAM_TOOLS.find((tool) => tool.name === name) as TeamToolDefinition;
}

/** Registers the Team tools on `server` (the helper does it only for a member's session). */
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
          team: z.string().max(100).describe("Optional: the receiver's team (name), when it is not your own team. \"Role (Team)\" in to works too.").optional(),
        })
        .meta({ required: ['to', 'brief', 'expected'], additionalProperties: false }),
      annotations: { title: handoff.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) => teamHandoff(api, input),
  );
  const members = definition('team_members');
  server.registerTool(
    members.name,
    {
      title: members.title,
      description: members.description,
      inputSchema: z.looseObject({ team: z.string().max(100).describe('Optional: another team to list (its name); your own team by default.').optional() }).meta({ additionalProperties: false }),
      annotations: { title: members.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => teamMembers(api, input),
  );
  const report = definition('team_report');
  server.registerTool(
    report.name,
    {
      title: report.title,
      description: report.description,
      inputSchema: z
        .looseObject({ text: z.string().max(REPORT_MAX).describe('One short status line (at most 500 characters).').optional() })
        .meta({ required: ['text'], additionalProperties: false }),
      annotations: { title: report.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) => teamReport(api, input),
  );
  const propose = definition('team_propose_charter');
  server.registerTool(
    propose.name,
    {
      title: propose.title,
      description: propose.description,
      inputSchema: z
        .looseObject({
          owns: z.string().max(CHARTER_FIELD_MAX).describe('What you own: the concrete feature or product area and the repositories you work in.').optional(),
          produces: z.string().max(CHARTER_FIELD_MAX).describe('What you deliver and where (commits and branches, pull requests, reports, notes, hand-offs).').optional(),
          neverDoes: z.string().max(CHARTER_FIELD_MAX).describe('What you must never do, including working outside your repositories.').optional(),
          howItWorks: z.string().max(CHARTER_FIELD_MAX).describe('A short paragraph on how you work today: rounds and cadence, your inputs, who gives you feedback.').optional(),
          notes: z.string().max(CHARTER_NOTES_MAX).describe('Optional notes for the developer reviewing the proposal (not part of the charter).').optional(),
        })
        .meta({ required: ['owns', 'produces', 'neverDoes'], additionalProperties: false }),
      annotations: { title: propose.title, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => teamProposeCharter(api, input),
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
  // D100-T2: request_access, likewise only in a member's session.
  registerAccessTool(server, api);
  return true;
}
