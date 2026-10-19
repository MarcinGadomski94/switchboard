/**
 * D99 · the plan tools of the built-in `switchboard` MCP server (`src/hook/sb-mcp.ts`, D68's
 * helper and agent token): `plan_create`, `plan_add_item`, `plan_add_dependency`,
 * `plan_status`, `plan_start`, and the Jira lane's `plan_propose_dependencies` (proposals the
 * developer accepts on the plan; `src/core/plans-jira.ts`). Plans is experimental: the helper asks `GET /agent/v1/plans`
 * once at start (`registerPlanToolsIfOn`) and registers them only when it answers 200
 * (Plans on and `plans.db` open); 404 `plans-off`, 503, an older Switchboard or no answer
 * register nothing. The routes check again on every call. Names, descriptions and
 * annotations come from `src/core/plans.ts` ({@link PLAN_TOOLS}).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { PLAN_CONCURRENCY_MAX, PLAN_MERGE_MODES, PLAN_TOOLS, type Plan, planStatusText } from '../core/plans.ts';
import { EDGE_PROPOSALS_MAX, PLAN_PROPOSE_TOOL } from '../core/plans-jira.ts';
import { TODO_ESTIMATE_MAX, TODO_PRIORITIES, type TodoToolDefinition } from '../core/todos.ts';
import type { AgentApi, ApiAnswer, ToolInput } from './sb-mcp.ts';

function textResult(text: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The refusal's message (`{ message }` of the API), else the status. */
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

const NEED_PLAN_ID = 'Give plan_id: the plan id as plan_create or plan_status shows it in brackets.';

function isPlan(body: unknown): body is Plan {
  const value = record(body);
  return typeof value['id'] === 'string' && Array.isArray(value['items']);
}

function planRoute(id: string, tail = ''): string {
  return `/agent/v1/plans/${encodeURIComponent(id.trim().replace(/^\[|\]$/g, ''))}${tail}`;
}

function planIdOf(input: ToolInput): string {
  return typeof input['plan_id'] === 'string' ? input['plan_id'].trim() : '';
}

/** D99 · `plan_create`: a draft plan over this session's todos. */
export async function planCreate(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  if (typeof input['title'] !== 'string' || input['title'].trim() === '') return textResult('Give the plan a title.', true);
  // D99 follow-up 2026-10-15: the target is optional (left out, or "none": a plan without a merge step) and may be any branch.
  const target = typeof input['target_branch'] === 'string' && input['target_branch'].trim() !== '' ? input['target_branch'].trim() : null;
  const answers: Record<string, unknown> = {};
  if (input['work_type'] !== undefined) answers['workType'] = input['work_type'];
  if (input['mode'] !== undefined) answers['mode'] = input['mode'];
  if (input['phase'] !== undefined) answers['phase'] = input['phase'];
  if (input['notes'] !== undefined) answers['notes'] = input['notes'];
  const body: Record<string, unknown> = { title: input['title'], targetBranch: target };
  if (input['base_branch'] !== undefined) body['baseBranch'] = input['base_branch'];
  if (input['repos'] !== undefined) body['repos'] = input['repos'];
  if (input['max_concurrency'] !== undefined) body['maxConcurrency'] = input['max_concurrency'];
  if (input['usage_threshold'] !== undefined) body['usageThreshold'] = input['usage_threshold'];
  if (Object.keys(answers).length > 0) body['answers'] = answers;
  return request(api, 'POST', '/agent/v1/plans', body, (answer) =>
    isPlan(answer)
      ? textResult(
          answer.targetBranch === null
            ? `Created plan [${answer.id}] "${answer.title}" (a draft) without a target branch: no merge step, an item is done when its todo is done; up to ${answer.maxConcurrency} at once. Add items with plan_add_item, order them with plan_add_dependency, then call plan_start (its merge mode is none).`
            : `Created plan [${answer.id}] "${answer.title}" (a draft): ${answer.targetBranch} → ${answer.baseBranch}, repos ${answer.repos.join(', ')}, up to ${answer.maxConcurrency} at once. Add items with plan_add_item, order them with plan_add_dependency, then ask the developer for the merge mode and call plan_start.`,
        )
      : textResult('Switchboard did not answer with the plan.', true),
  );
}

/** D99 · `plan_add_item`: an existing todo or a new one. */
export async function planAddItem(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = planIdOf(input);
  if (id === '') return textResult(NEED_PLAN_ID, true);
  const body: Record<string, unknown> = {};
  if (typeof input['todo_id'] === 'string' && input['todo_id'].trim() !== '') body['todoId'] = input['todo_id'].trim().replace(/^\[|\]$/g, '');
  else if (typeof input['title'] === 'string' && input['title'].trim() !== '') {
    const todo: Record<string, unknown> = { title: input['title'] };
    if (input['description'] !== undefined) todo['description'] = input['description'];
    if (input['plan'] !== undefined) todo['plan'] = input['plan'];
    if (input['priority'] !== undefined) todo['priority'] = input['priority'];
    if (input['estimate_minutes'] !== undefined) todo['estimateMinutes'] = input['estimate_minutes'];
    body['todo'] = todo;
  } else return textResult('Give todo_id (an existing todo of this session) or title (and description, plan, priority, estimate_minutes) for a new one.', true);
  for (const [from, to] of [['key', 'key'], ['hold', 'hold'], ['solutions', 'solutions'], ['after', 'after']] as const) if (input[from] !== undefined) body[to] = input[from];
  return request(api, 'POST', planRoute(id, '/items'), body, (answer) => {
    const value = record(answer);
    const plan = value['plan'];
    const itemId = value['itemId'];
    if (!isPlan(plan) || typeof itemId !== 'string') return textResult('Switchboard did not answer with the plan.', true);
    const item = plan.items.find((candidate) => candidate.id === itemId);
    return textResult(`Added [${itemId}]${item?.key ? ` ${item.key}` : ''} ${item?.title ?? ''} to plan [${plan.id}].\n\n${planStatusText(plan)}`);
  });
}

/** D99 · `plan_add_dependency`: `item` runs after `after`. */
export async function planAddDependency(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = planIdOf(input);
  if (id === '') return textResult(NEED_PLAN_ID, true);
  if (typeof input['item'] !== 'string' || typeof input['after'] !== 'string' || input['item'].trim() === '' || input['after'].trim() === '') return textResult('Give item (the one that waits) and after (the one it runs after), as ids or keys.', true);
  return request(api, 'POST', planRoute(id, '/edges'), { from: input['after'], to: input['item'] }, (answer) => (isPlan(answer) ? textResult(planStatusText(answer)) : textResult('Switchboard did not answer with the plan.', true)));
}

/** D99 · `plan_status`: one plan, or this session's plans. */
export async function planStatus(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = planIdOf(input);
  if (id === '') {
    return request(api, 'GET', '/agent/v1/plans', undefined, (answer) => {
      const plans = Array.isArray(answer) ? answer.filter(isPlan) : [];
      return textResult(plans.length === 0 ? 'This session has no plans. Create one with plan_create.' : plans.map(planStatusText).join('\n\n'));
    });
  }
  return request(api, 'GET', planRoute(id), undefined, (answer) => (isPlan(answer) ? textResult(planStatusText(answer)) : textResult('Switchboard did not answer with the plan.', true)));
}

/**
 * D99 · `plan_start`: the developer's merge mode (required with a target branch: the server
 * answers 422 `merge-mode-required`; a plan without a target is `none`); D99 follow-up
 * 2026-10-15: `allow_protected_target` is the developer's acknowledgement that agents merge
 * straight into a protected target.
 */
export async function planStart(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = planIdOf(input);
  if (id === '') return textResult(NEED_PLAN_ID, true);
  const mode = input['merge_mode'];
  if (mode !== undefined && (typeof mode !== 'string' || !(PLAN_MERGE_MODES as readonly string[]).includes(mode))) {
    return textResult(`merge_mode is the developer's choice: ask them which one (${PLAN_MERGE_MODES.join(', ')}; agents-with-holds is recommended), then call plan_start again. Never choose it yourself.`, true);
  }
  const body: Record<string, unknown> = {};
  if (mode !== undefined) body['mergeMode'] = mode;
  if (input['allow_protected_target'] !== undefined) body['allowProtectedTarget'] = input['allow_protected_target'] === true;
  return request(api, 'POST', planRoute(id, '/start'), body, (answer) => (isPlan(answer) ? textResult(`Started.\n\n${planStatusText(answer)}`) : textResult('Switchboard did not answer with the plan.', true)));
}

/** D99-Jira-q1 · `plan_propose_dependencies`: proposals for the developer, nothing changes. */
export async function planProposeDependencies(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = planIdOf(input);
  if (id === '') return textResult(NEED_PLAN_ID, true);
  const proposals = Array.isArray(input['proposals']) ? input['proposals'] : [];
  if (proposals.length === 0) return textResult('Give proposals: [{ from, to, reason }] (from = the item that goes first, to = the one that waits).', true);
  return request(api, 'POST', planRoute(id, '/proposals'), { proposals }, (answer) => {
    const value = record(answer);
    const added = Array.isArray(value['added']) ? (value['added'] as Array<Record<string, unknown>>) : [];
    const skipped = Array.isArray(value['skipped']) ? (value['skipped'] as Array<Record<string, unknown>>) : [];
    const lines = [
      added.length > 0 ? `Proposed to the developer (nothing changes until they accept on the plan):\n${added.map((entry) => `- ${String(entry['text'])}: ${String(entry['reason'])}`).join('\n')}` : 'Nothing new was proposed.',
      ...(skipped.length > 0 ? [`Skipped:\n${skipped.map((entry) => `- ${String(entry['to'])} after ${String(entry['from'])}: ${String(entry['why'])}`).join('\n')}`] : []),
    ];
    return textResult(lines.join('\n\n'));
  });
}

/** Tool `name`'s definition in {@link PLAN_TOOLS}. */
function tool(name: string): TodoToolDefinition {
  const found = PLAN_TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool ${name} in PLAN_TOOLS`);
  return found;
}

/** The description of field `field` of tool `name` (the one place the text lives). */
function about(name: string, field: string): string {
  const description = record(record(tool(name).inputSchema['properties'])[field])['description'];
  if (typeof description !== 'string') throw new Error(`no description for ${name}.${field} in PLAN_TOOLS`);
  return description;
}

/** Tool `name`'s input schema (as `sb-mcp.ts` builds the todo tools': each field optional, `required` declared). */
function inputSchema<Shape extends z.ZodRawShape>(name: string, shape: Shape) {
  const required = tool(name).inputSchema['required'];
  return z.looseObject(shape).meta({ ...(Array.isArray(required) ? { required: [...(required as string[])] } : {}), additionalProperties: false });
}

const field = {
  text: (name: string, key: string) => z.string().describe(about(name, key)).optional(),
};

/** Runs the calls one at a time, in the order they came. */
function inOrder(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
}

/** Registers the five plan tools on `server`, calling `api`. */
export function registerPlanTools(server: McpServer, api: AgentApi): void {
  const serial = inOrder();
  const strings = (name: string, key: string) => z.array(z.string()).describe(about(name, key)).optional();
  const planCreateTool = tool('plan_create');
  server.registerTool(
    'plan_create',
    {
      title: planCreateTool.annotations.title,
      description: planCreateTool.description,
      inputSchema: inputSchema('plan_create', {
        title: field.text('plan_create', 'title'),
        target_branch: field.text('plan_create', 'target_branch'),
        base_branch: field.text('plan_create', 'base_branch'),
        repos: strings('plan_create', 'repos'),
        max_concurrency: z.int().min(1).max(PLAN_CONCURRENCY_MAX).describe(about('plan_create', 'max_concurrency')).optional(),
        usage_threshold: z.int().min(1).max(100).describe(about('plan_create', 'usage_threshold')).optional(),
        work_type: z.enum(['feature', 'qa']).describe(about('plan_create', 'work_type')).optional(),
        mode: z.enum(['single', 'orchestrator']).describe(about('plan_create', 'mode')).optional(),
        phase: z.enum(['ui-first', 'integration']).describe(about('plan_create', 'phase')).optional(),
        notes: field.text('plan_create', 'notes'),
      }),
      annotations: { title: planCreateTool.annotations.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) => serial(() => planCreate(api, input)),
  );
  const planAddItemTool = tool('plan_add_item');
  server.registerTool(
    'plan_add_item',
    {
      title: planAddItemTool.annotations.title,
      description: planAddItemTool.description,
      inputSchema: inputSchema('plan_add_item', {
        plan_id: field.text('plan_add_item', 'plan_id'),
        todo_id: field.text('plan_add_item', 'todo_id'),
        title: field.text('plan_add_item', 'title'),
        description: field.text('plan_add_item', 'description'),
        plan: field.text('plan_add_item', 'plan'),
        priority: z.enum(TODO_PRIORITIES as [string, ...string[]]).describe(about('plan_add_item', 'priority')).optional(),
        estimate_minutes: z.int().min(1).max(TODO_ESTIMATE_MAX).describe(about('plan_add_item', 'estimate_minutes')).optional(),
        key: field.text('plan_add_item', 'key'),
        hold: z.boolean().describe(about('plan_add_item', 'hold')).optional(),
        solutions: strings('plan_add_item', 'solutions'),
        after: strings('plan_add_item', 'after'),
      }),
      annotations: { title: planAddItemTool.annotations.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) => serial(() => planAddItem(api, input)),
  );
  const planDependencyTool = tool('plan_add_dependency');
  server.registerTool(
    'plan_add_dependency',
    {
      title: planDependencyTool.annotations.title,
      description: planDependencyTool.description,
      inputSchema: inputSchema('plan_add_dependency', { plan_id: field.text('plan_add_dependency', 'plan_id'), item: field.text('plan_add_dependency', 'item'), after: field.text('plan_add_dependency', 'after') }),
      annotations: { title: planDependencyTool.annotations.title, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => serial(() => planAddDependency(api, input)),
  );
  const planStatusTool = tool('plan_status');
  server.registerTool(
    'plan_status',
    { title: planStatusTool.annotations.title, description: planStatusTool.description, inputSchema: inputSchema('plan_status', { plan_id: field.text('plan_status', 'plan_id') }), annotations: { title: planStatusTool.annotations.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    (input) => serial(() => planStatus(api, input)),
  );
  const planStartTool = tool('plan_start');
  server.registerTool(
    'plan_start',
    {
      title: planStartTool.annotations.title,
      description: planStartTool.description,
      inputSchema: inputSchema('plan_start', {
        plan_id: field.text('plan_start', 'plan_id'),
        merge_mode: z.enum(PLAN_MERGE_MODES).describe(about('plan_start', 'merge_mode')).optional(),
        allow_protected_target: z.boolean().describe(about('plan_start', 'allow_protected_target')).optional(),
      }),
      annotations: { title: planStartTool.annotations.title, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (input) => serial(() => planStart(api, input)),
  );
  // D99-Jira-q1: proposals only (src/core/plans-jira.ts).
  const proposeSchema = PLAN_PROPOSE_TOOL.inputSchema;
  const proposeAbout = (key: string): string => String(record(record(proposeSchema['properties'])[key])['description'] ?? '');
  const proposalAbout = (key: string): string => String(record(record(record(record(record(proposeSchema['properties'])['proposals'])['items'])['properties'])[key])['description'] ?? '');
  server.registerTool(
    PLAN_PROPOSE_TOOL.name,
    {
      title: PLAN_PROPOSE_TOOL.annotations.title,
      description: PLAN_PROPOSE_TOOL.description,
      inputSchema: z.looseObject({
        plan_id: z.string().describe(proposeAbout('plan_id')).optional(),
        proposals: z
          .array(z.object({ from: z.string().describe(proposalAbout('from')), to: z.string().describe(proposalAbout('to')), reason: z.string().describe(proposalAbout('reason')) }))
          .max(EDGE_PROPOSALS_MAX)
          .describe(proposeAbout('proposals'))
          .optional(),
      }).meta({ required: ['plan_id', 'proposals'], additionalProperties: false }),
      annotations: { title: PLAN_PROPOSE_TOOL.annotations.title, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => serial(() => planProposeDependencies(api, input)),
  );

}

/**
 * The helper's hook (`sb-mcp.ts`): registers the plan tools when Plans is on (`GET
 * /agent/v1/plans` answers 200); anything else (404 `plans-off`, 503, an older Switchboard, no
 * answer within `probe`'s timeout) registers nothing. Answers whether it registered them.
 */
export async function registerPlanToolsIfOn(server: McpServer, api: AgentApi, probe: AgentApi = api): Promise<boolean> {
  try {
    const answer = await probe('GET', '/agent/v1/plans');
    if (answer.status !== 200) return false;
  } catch {
    return false;
  }
  registerPlanTools(server, api);
  return true;
}
