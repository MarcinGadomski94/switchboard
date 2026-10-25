/**
 * D99 · the plan tools of the built-in `switchboard` MCP server (`src/hook/sb-mcp.ts`, D68's
 * helper and agent token): `plan_create`, `plan_add_item`, `plan_add_dependency`,
 * `plan_status`, `plan_start`, `plan_set_solutions` (D115: the agent picks its items'
 * repositories, applied at once), D129's `plan_update_item`, `plan_remove_item`,
 * `plan_remove_dependency` and `plan_set_mode` (items already in the plan, the merge mode), and the Jira lane's `plan_propose_dependencies` (proposals the
 * developer accepts on the plan; `src/core/plans-jira.ts`) and (D118) the read-only
 * `plan_jira_context` (`src/core/plans-jira-context.ts`). The helper asks `GET /agent/v1/plans`
 * (`FeatureTools`, `sb-feature-tools.ts`) and registers them only when it answers 200
 * (`plans.db` open; D132: Plans is always on since 2.0); 503, a 1.x Switchboard with Plans off
 * (404 `plans-off`) or no answer register nothing. The routes check again on every call. Names, descriptions and
 * annotations come from `src/core/plans.ts` ({@link PLAN_TOOLS}).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { PLAN_CONCURRENCY_MAX, PLAN_ITEMS_MAX, PLAN_MERGE_MODES, PLAN_TOOLS, type Plan, planStatusText } from '../core/plans.ts';
import { EDGE_PROPOSALS_MAX, PLAN_PROPOSE_TOOL } from '../core/plans-jira.ts';
import { JIRA_CONTEXT_PARTS, PLAN_JIRA_CONTEXT_TOOL } from '../core/plans-jira-context.ts';
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

async function request(api: AgentApi, method: 'GET' | 'POST' | 'PUT' | 'DELETE', route: string, body: unknown, done: (body: unknown) => CallToolResult): Promise<CallToolResult> {
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
  return request(api, 'POST', '/agent/v1/plans', body, (answer) => {
    if (!isPlan(answer)) return textResult('Switchboard did not answer with the plan.', true);
    if (answer.targetBranch === null) {
      return textResult(`Created plan [${answer.id}] "${answer.title}" (a draft) without a target branch: no merge step, an item is done when its todo is done; up to ${answer.maxConcurrency} at once. Add items with plan_add_item, order them with plan_add_dependency, then call plan_start (its merge mode is none).`);
    }
    // D115 follow-ups: a workspace plan without repos: this agent picks each item's repositories (the tool's answer is the ask).
    if (answer.reposPerItem === true) {
      return textResult(
        [
          `Created plan [${answer.id}] "${answer.title}" (a draft): ${answer.targetBranch} → ${answer.baseBranch}, up to ${answer.maxConcurrency} at once. Add items with plan_add_item, order them with plan_add_dependency, then ask the developer for the merge mode and call plan_start.`,
          pickReposHint(answer.id, solutionChoicesOf(answer)),
        ].join('\n\n'),
      );
    }
    return textResult(`Created plan [${answer.id}] "${answer.title}" (a draft): ${answer.targetBranch} → ${answer.baseBranch}, repos ${answer.repos.join(', ')}, up to ${answer.maxConcurrency} at once. Add items with plan_add_item, order them with plan_add_dependency, then ask the developer for the merge mode and call plan_start.`);
  });
}

/** D115 follow-ups: the workspace's solutions the server named (`solutionChoices`), `null` when it named none. */
function solutionChoicesOf(answer: unknown): string[] | null {
  const value = record(answer)['solutionChoices'];
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : null;
}

/**
 * D115 follow-ups: the ask to the plan's own agent, as the tool's answer (no separate message): it
 * picks each item's repositories itself; an item without any waits, and the developer hears about
 * it in the Inbox when none are picked in time.
 */
function pickReposHint(planId: string, solutions: readonly string[] | null): string {
  const list = solutions === null ? '' : ` The workspace's solutions you can pick from: ${solutions.length > 0 ? solutions.join(', ') : '(none found: say so to the developer)'}.`;
  return `This plan's repositories are picked per item, by you: give plan_add_item the solutions each item works in, or call plan_set_solutions with plan_id ${planId} once the items are in. An item without any waits and never starts; if none are picked in time, the developer is told in the Inbox.${list}`;
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
    const added = `Added [${itemId}]${item?.key ? ` ${item.key}` : ''} ${item?.title ?? ''} to plan [${plan.id}].`;
    // D115 follow-ups: added without repositories in a plan whose agent picks them: the answer is the ask.
    const waits = plan.reposPerItem === true && item !== undefined && item.solutions.length === 0;
    return textResult([added, ...(waits ? [pickReposHint(plan.id, solutionChoicesOf(answer))] : []), planStatusText(plan)].join('\n\n'));
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
 * straight into a protected target. D130: `sidebar_folder`, the runs' sidebar subfolder the developer named.
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
  // D130: the developer's sidebar subfolder for the runs ('' = none; left out = as before D130).
  const folder = input['sidebar_folder'];
  if (folder !== undefined && folder !== null) {
    if (typeof folder !== 'string') return textResult("sidebar_folder is the name of the runs' sidebar subfolder the developer gave (or an empty string for none).", true);
    body['sidebarFolder'] = folder;
  }
  return request(api, 'POST', planRoute(id, '/start'), body, (answer) => (isPlan(answer) ? textResult(`Started.\n\n${planStatusText(answer)}`) : textResult('Switchboard did not answer with the plan.', true)));
}

/** An item ref (id, `[id]` or key) as a path segment. */
function itemSegment(ref: string): string {
  return encodeURIComponent(ref.trim().replace(/^\[|\]$/g, ''));
}

function textOf(input: ToolInput, key: string): string {
  return typeof input[key] === 'string' ? input[key].trim() : '';
}

/** D129 · `plan_update_item`: an item already in the plan (hold; its todo's title, description, estimate before it starts). */
export async function planUpdateItem(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = planIdOf(input);
  if (id === '') return textResult(NEED_PLAN_ID, true);
  const item = textOf(input, 'item');
  if (item === '') return textResult('Give item: the id or key of the item, as plan_status shows it.', true);
  const body: Record<string, unknown> = {};
  for (const [from, to] of [['hold', 'hold'], ['title', 'title'], ['description', 'description'], ['estimate_minutes', 'estimateMinutes']] as const) if (input[from] !== undefined) body[to] = input[from];
  if (Object.keys(body).length === 0) return textResult('Give what changes: hold, title, description and / or estimate_minutes.', true);
  return request(api, 'PUT', planRoute(id, `/items/${itemSegment(item)}`), body, (answer) => {
    if (!isPlan(answer)) return textResult('Switchboard did not answer with the plan.', true);
    const ref = item.replace(/^\[|\]$/g, '');
    const changed = answer.items.find((candidate) => candidate.id === ref || (candidate.key !== null && candidate.key === ref.toUpperCase()));
    const label = changed ? `[${changed.id}]${changed.key ? ` ${changed.key}` : ''} ${changed.title}` : item;
    return textResult(`Updated ${label} (${Object.keys(body).join(', ')}).\n\n${planStatusText(answer)}`);
  });
}

/** D129 · `plan_remove_item`: an item that has not started (its todo stays). */
export async function planRemoveItem(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = planIdOf(input);
  if (id === '') return textResult(NEED_PLAN_ID, true);
  const item = textOf(input, 'item');
  if (item === '') return textResult('Give item: the id or key of the item, as plan_status shows it.', true);
  return request(api, 'DELETE', planRoute(id, `/items/${itemSegment(item)}`), undefined, (answer) =>
    isPlan(answer) ? textResult(`Removed ${item} from plan [${answer.id}]; its todo stays in this session's list.\n\n${planStatusText(answer)}`) : textResult('Switchboard did not answer with the plan.', true),
  );
}

/** D129 · `plan_remove_dependency`: `to` no longer waits for `from`. */
export async function planRemoveDependency(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = planIdOf(input);
  if (id === '') return textResult(NEED_PLAN_ID, true);
  const from = textOf(input, 'from');
  const to = textOf(input, 'to');
  if (from === '' || to === '') return textResult('Give from (the item that goes first) and to (the one that waits for it), as ids or keys.', true);
  return request(api, 'DELETE', planRoute(id, `/edges/${itemSegment(from)}/${itemSegment(to)}`), undefined, (answer) =>
    isPlan(answer) ? textResult(`${to} no longer waits for ${from}.\n\n${planStatusText(answer)}`) : textResult('Switchboard did not answer with the plan.', true),
  );
}

/** D129 · `plan_set_mode`: the developer's new merge mode (and acknowledgement), as `PUT /api/plans/{id}/mode`. */
export async function planSetMode(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = planIdOf(input);
  if (id === '') return textResult(NEED_PLAN_ID, true);
  const mode = input['merge_mode'];
  if (typeof mode !== 'string' || !(PLAN_MERGE_MODES as readonly string[]).includes(mode)) {
    return textResult(`merge_mode is the developer's choice: ask them which one (${PLAN_MERGE_MODES.join(', ')}), then call plan_set_mode again. Never choose it yourself.`, true);
  }
  const body: Record<string, unknown> = { mergeMode: mode };
  if (input['allow_protected_target'] !== undefined) body['allowProtectedTarget'] = input['allow_protected_target'] === true;
  return request(api, 'PUT', planRoute(id, '/mode'), body, (answer) => (isPlan(answer) ? textResult(`The merge mode is ${answer.mergeMode ?? mode}.\n\n${planStatusText(answer)}`) : textResult('Switchboard did not answer with the plan.', true)));
}

/** D115 · `plan_set_solutions`: the agent picks its items' repositories; applied at once. */
export async function planSetSolutions(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = planIdOf(input);
  if (id === '') return textResult(NEED_PLAN_ID, true);
  const items = Array.isArray(input['items']) ? input['items'] : [];
  if (items.length === 0) return textResult('Give items: [{ item, solutions }] (the key or id of each item and the solutions it works in).', true);
  return request(api, 'POST', planRoute(id, '/solutions'), { items }, (answer) => {
    const value = record(answer);
    const plan = value['plan'];
    const set = Array.isArray(value['set']) ? (value['set'] as Array<Record<string, unknown>>) : [];
    if (!isPlan(plan)) return textResult('Switchboard did not answer with the plan.', true);
    const lines = set.map((entry) => `- ${String(entry['label'])}: ${Array.isArray(entry['solutions']) ? (entry['solutions'] as unknown[]).join(', ') : ''}`);
    const waiting = plan.items.filter((item) => item.storedState === 'pending' && item.solutions.length === 0 && plan.reposPerItem === true).length;
    return textResult(
      [`Set the repositories (applied):\n${lines.join('\n')}`, `The plan's repos: ${plan.repos.join(', ') || 'none yet'}.${waiting > 0 ? ` ${waiting} item(s) still have none and wait.` : ''}`, planStatusText(plan)].join('\n\n'),
    );
  });
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

/** D118 · `plan_jira_context`: the plan's Jira context, read from Jira now (read-only). */
export async function planJiraContext(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = planIdOf(input);
  const query = new URLSearchParams();
  if (typeof input['item'] === 'string' && input['item'].trim() !== '') query.set('item', input['item'].trim());
  if (typeof input['part'] === 'string' && input['part'] !== '') query.set('part', input['part']);
  const tail = query.size > 0 ? `?${query.toString()}` : '';
  const route = id === '' ? `/agent/v1/plans/jira/context${tail}` : planRoute(id, `/jira/context${tail}`);
  return request(api, 'GET', route, undefined, (answer) => {
    const text = record(answer)['text'];
    return typeof text === 'string' ? textResult(text) : textResult('Switchboard did not answer with the Jira context.', true);
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

/** Registers the plan tools on `server`, calling `api`. */
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
        sidebar_folder: z.string().max(60).describe(about('plan_start', 'sidebar_folder')).optional(),
      }),
      annotations: { title: planStartTool.annotations.title, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (input) => serial(() => planStart(api, input)),
  );
  // D115: the agent's pick of its items' repositories (applied at once).
  const setSolutionsTool = tool('plan_set_solutions');
  const entryAbout = (key: string): string => String(record(record(record(record(record(setSolutionsTool.inputSchema['properties'])['items'])['items'])['properties'])[key])['description'] ?? '');
  server.registerTool(
    'plan_set_solutions',
    {
      title: setSolutionsTool.annotations.title,
      description: setSolutionsTool.description,
      inputSchema: z.looseObject({
        plan_id: z.string().describe(about('plan_set_solutions', 'plan_id')).optional(),
        items: z
          .array(z.object({ item: z.string().describe(entryAbout('item')), solutions: z.array(z.string()).min(1).describe(entryAbout('solutions')) }))
          .min(1)
          .max(PLAN_ITEMS_MAX)
          .describe(about('plan_set_solutions', 'items'))
          .optional(),
      }).meta({ required: ['plan_id', 'items'], additionalProperties: false }),
      annotations: { title: setSolutionsTool.annotations.title, readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input) => serial(() => planSetSolutions(api, input)),
  );
  // D129: items already in the plan (the developer's service methods and refusals).
  const updateItemTool = tool('plan_update_item');
  server.registerTool(
    'plan_update_item',
    {
      title: updateItemTool.annotations.title,
      description: updateItemTool.description,
      inputSchema: inputSchema('plan_update_item', {
        plan_id: field.text('plan_update_item', 'plan_id'),
        item: field.text('plan_update_item', 'item'),
        hold: z.boolean().describe(about('plan_update_item', 'hold')).optional(),
        title: field.text('plan_update_item', 'title'),
        description: field.text('plan_update_item', 'description'),
        estimate_minutes: z.int().min(1).max(TODO_ESTIMATE_MAX).describe(about('plan_update_item', 'estimate_minutes')).optional(),
      }),
      annotations: { title: updateItemTool.annotations.title, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => serial(() => planUpdateItem(api, input)),
  );
  const removeItemTool = tool('plan_remove_item');
  server.registerTool(
    'plan_remove_item',
    {
      title: removeItemTool.annotations.title,
      description: removeItemTool.description,
      inputSchema: inputSchema('plan_remove_item', { plan_id: field.text('plan_remove_item', 'plan_id'), item: field.text('plan_remove_item', 'item') }),
      annotations: { title: removeItemTool.annotations.title, readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input) => serial(() => planRemoveItem(api, input)),
  );
  const removeDependencyTool = tool('plan_remove_dependency');
  server.registerTool(
    'plan_remove_dependency',
    {
      title: removeDependencyTool.annotations.title,
      description: removeDependencyTool.description,
      inputSchema: inputSchema('plan_remove_dependency', { plan_id: field.text('plan_remove_dependency', 'plan_id'), from: field.text('plan_remove_dependency', 'from'), to: field.text('plan_remove_dependency', 'to') }),
      annotations: { title: removeDependencyTool.annotations.title, readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input) => serial(() => planRemoveDependency(api, input)),
  );
  const setModeTool = tool('plan_set_mode');
  server.registerTool(
    'plan_set_mode',
    {
      title: setModeTool.annotations.title,
      description: setModeTool.description,
      inputSchema: inputSchema('plan_set_mode', {
        plan_id: field.text('plan_set_mode', 'plan_id'),
        merge_mode: z.enum(PLAN_MERGE_MODES).describe(about('plan_set_mode', 'merge_mode')).optional(),
        allow_protected_target: z.boolean().describe(about('plan_set_mode', 'allow_protected_target')).optional(),
      }),
      annotations: { title: setModeTool.annotations.title, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (input) => serial(() => planSetMode(api, input)),
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
  // D118: read-only (src/core/plans-jira-context.ts); the route answers only the plan's source and item run sessions.
  const contextAbout = (key: string): string => String(record(record(PLAN_JIRA_CONTEXT_TOOL.inputSchema['properties'])[key])['description'] ?? '');
  server.registerTool(
    PLAN_JIRA_CONTEXT_TOOL.name,
    {
      title: PLAN_JIRA_CONTEXT_TOOL.annotations.title,
      description: PLAN_JIRA_CONTEXT_TOOL.description,
      inputSchema: z.looseObject({
        plan_id: z.string().describe(contextAbout('plan_id')).optional(),
        item: z.string().describe(contextAbout('item')).optional(),
        part: z.enum(JIRA_CONTEXT_PARTS).describe(contextAbout('part')).optional(),
      }).meta({ additionalProperties: false }),
      annotations: { title: PLAN_JIRA_CONTEXT_TOOL.annotations.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (input) => planJiraContext(api, input),
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
