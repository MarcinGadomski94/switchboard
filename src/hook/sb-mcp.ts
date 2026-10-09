/**
 * D68 (`docs/todos.md` → *The agent's tools*): the built-in `switchboard` MCP
 * server, a stdio helper the session's CLI starts:
 * `node sb-mcp.ts --switchboard-mcp <port> <sessionId>`, with the session's agent
 * token in `SWITCHBOARD_TODO_TOKEN` (never on the argv). Node ≥ 24 runs it
 * directly (type stripping); it imports the official MCP TypeScript SDK and zod
 * from the app's own `node_modules` (runtime dependencies, so a release install's
 * `npm ci --omit=dev` brings them).
 *
 * It is built on the SDK's high-level API: one `McpServer` over a
 * `StdioServerTransport`, each of the ten tools registered with `registerTool`
 * next to its own handler: `todo_list`, `todo_get` (D69), `todo_add`,
 * `todo_update` (D70: with priority and estimate), `todo_start` (D75), `todo_done`, `todo_remove`,
 * each one call to the local Switchboard's `/agent/v1/todos` (127.0.0.1 only), and
 * D89's `artifact_save`, `artifact_list`, `artifact_get` (`/agent/v1/artifacts`), and
 * D94's `loop_create`, `loop_list`, `loop_update`, `loop_pause`, `loop_resume`,
 * `loop_cancel` (`/agent/v1/loops`: loops Switchboard fires itself).
 * Names, descriptions, annotations and the instructions come from
 * `src/core/todos.ts` ({@link TODO_TOOLS}) and `src/core/artifacts.ts`
 * ({@link ARTIFACT_TOOLS}); the zod input schemas here carry the
 * same types and take their descriptions from there. The token authorizes that one
 * session's list and artifacts and nothing else; the helper never reads any other
 * file or variable (an `artifact_save` `path` is read by Switchboard, which checks
 * it is inside the session's working folders). A failing call answers a tool error the agent can read (Switchboard
 * not running, an unknown id, a missing field), never a crash.
 */
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Artifact, ArtifactDetail, ArtifactSaveResult, OwnedLoop, SessionTodo, SessionTodoList } from '../core/api.ts';
import { LOOP_EVERY_MAX, LOOP_MAX_RUNS_MAX, LOOP_TOOLS, loopDetailText, loopListText } from '../core/owned-loops.ts';
import { ARTIFACT_KINDS, ARTIFACT_TOOLS, ARTIFACT_VERSIONS_MAX, artifactLine, artifactListText, artifactSizeLabel } from '../core/artifacts.ts';
import {
  AGENT_MCP_INSTRUCTIONS,
  AGENT_MCP_MARKER,
  AGENT_MCP_SERVER,
  AGENT_SESSION_HEADER,
  AGENT_TOKEN_ENV,
  TODO_ESTIMATE_MAX,
  TODO_PRIORITIES,
  TODO_TOOLS,
  type TodoToolDefinition,
  isTodoPriority,
  todoDetailText,
  todoLine,
  todoListText,
} from '../core/todos.ts';

/** An answer of the local API: status and parsed body. */
export interface ApiAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** How the helper reaches Switchboard (tests pass a stand-in). */
export type AgentApi = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => Promise<ApiAnswer>;

/** The local API over loopback HTTP, as session `sessionId` with its agent token. */
export function loopbackApi(port: number, sessionId: string, token: string, timeoutMs = 15_000): AgentApi {
  return (method, route, body) =>
    new Promise((resolve, reject) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: route,
          method,
          headers: {
            host: `127.0.0.1:${port}`,
            authorization: `Bearer ${token}`,
            [AGENT_SESSION_HEADER]: sessionId,
            ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }),
          },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = null;
            try {
              parsed = raw ? (JSON.parse(raw) as unknown) : null;
            } catch {
              parsed = raw;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Switchboard did not answer in time')));
      req.end(text);
    });
}

/** The arguments of a tool call as its handler gets them (the schema's fields, plus any extra key such as D68's `text`). */
export type ToolInput = Readonly<Record<string, unknown>>;

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

function listOf(body: unknown): SessionTodoList | null {
  const value = record(body);
  if (Array.isArray(value['todos'])) return value as unknown as SessionTodoList;
  const list = record(value['list']);
  return Array.isArray(list['todos']) ? (list as unknown as SessionTodoList) : null;
}

/** The list an answer carries, as `todo_list` prints it (`''` when none). */
function summaryOf(body: unknown): string {
  const list = listOf(body);
  return list ? todoListText(list) : '';
}

/** D78: the estimate calibration line an answer carries (`calibration`), `''` when none. */
function calibrationOf(body: unknown): string {
  const line = record(body)['calibration'];
  return typeof line === 'string' && line !== '' ? `\n\n${line}` : '';
}

/** D76: a run session's linked item (`linked` of `GET /agent/v1/todos`), as `todo_list` adds it. */
function linkedOf(body: unknown): string {
  const linked = record(body)['linked'];
  if (!isTodo(linked)) return '';
  return `\n\nThe item you run (in the list of the session that started you):\n${todoLine(linked)}\nMark it done with todo_done [${linked.id}] when it is finished.`;
}

/** The item a mutating answer carries (`{ todo }`). */
function todoOf(body: unknown): SessionTodo | undefined {
  return record(body)['todo'] as SessionTodo | undefined;
}

/** D69: the description and plan a call gives (strings only; `''` removes one on update). */
function notes(input: ToolInput): { description?: string; plan?: string } {
  return {
    ...(typeof input['description'] === 'string' ? { description: input['description'] } : {}),
    ...(typeof input['plan'] === 'string' ? { plan: input['plan'] } : {}),
  };
}

/** D70: the priority and estimate a call gives (`estimate_minutes`, the tool's name, becomes the API's `estimateMinutes`). */
function sizing(input: ToolInput): { priority?: unknown; estimateMinutes?: unknown } {
  const estimate = input['estimate_minutes'] ?? input['estimateMinutes'];
  return {
    ...(input['priority'] !== undefined ? { priority: input['priority'] } : {}),
    ...(estimate !== undefined ? { estimateMinutes: estimate } : {}),
  };
}

/**
 * D70: why a `todo_add` call cannot be sent (its tool schema requires a plan, a
 * priority and an estimate), `null` when it can. The server itself still accepts an
 * older shape (ruling D70); the helper is what the agent's tool reaches.
 */
function missingForAdd(input: ToolInput): string | null {
  const missing: string[] = [];
  if (typeof input['plan'] !== 'string' || input['plan'].trim() === '') missing.push('a plan (a handover plan for an agent, or "No plan: <one-line reason>")');
  if (!isTodoPriority(input['priority'])) missing.push(`a priority (${TODO_PRIORITIES.join(', ')})`);
  const estimate = input['estimate_minutes'] ?? input['estimateMinutes'];
  if (typeof estimate !== 'number' || !Number.isInteger(estimate) || estimate < 1 || estimate > TODO_ESTIMATE_MAX) missing.push(`estimate_minutes (whole minutes an AI agent would take, 1–${TODO_ESTIMATE_MAX})`);
  return missing.length ? `Give ${missing.join(', ')}.` : null;
}

function isTodo(body: unknown): body is SessionTodo {
  const value = record(body);
  return typeof value['id'] === 'string' && typeof (value['title'] ?? value['text']) === 'string';
}

/** The item id a call gives (`[abc]`, as `todo_list` prints it, is fine), `''` when none. */
function idOf(input: ToolInput): string {
  return typeof input['id'] === 'string' ? input['id'].trim().replace(/^\[|\]$/g, '') : '';
}

const NEED_ID = 'Give the item id (todo_list shows it in brackets).';

function itemRoute(id: string): string {
  return `/agent/v1/todos/${encodeURIComponent(id)}`;
}

/** One request to the API: a thrown error (Switchboard down) and a non-2xx answer become tool errors; a 2xx answer's body goes to `done`. */
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

/** `todo_list`: the compact list (D69). */
export function todoList(api: AgentApi): Promise<CallToolResult> {
  return request(api, 'GET', '/agent/v1/todos', undefined, (body) => textResult(`${summaryOf(body) || 'The todo list is empty.'}${linkedOf(body)}${calibrationOf(body)}`));
}

/** `todo_get`: one item in full (D69). */
export async function todoGet(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = idOf(input);
  if (id === '') return textResult(NEED_ID, true);
  return request(api, 'GET', itemRoute(id), undefined, (body) => (isTodo(body) ? textResult(todoDetailText(body)) : textResult('Switchboard did not answer with the item.', true)));
}

/** `todo_add`: a new item. D70: refuses, sending nothing, without a plan, a priority and an estimate. D69: `text` (the D68 field) still names the title. */
export async function todoAdd(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const title = input['title'] ?? input['text'];
  if (typeof title !== 'string') return textResult('Give the item a title (one short line); add a description, a handover plan, a priority and an estimate too.', true);
  const missing = missingForAdd(input);
  if (missing) return textResult(missing, true);
  return request(api, 'POST', '/agent/v1/todos', { title, ...notes(input), ...sizing(input) }, (body) => {
    const todo = todoOf(body);
    const summary = summaryOf(body);
    return textResult(`${todo ? `Added ${todoLine(todo)}\n\n${summary}` : summary}${calibrationOf(body)}`);
  });
}

/** `todo_update`: changes only the fields given (D69 / D70). */
export async function todoUpdate(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = idOf(input);
  if (id === '') return textResult(NEED_ID, true);
  const title = input['title'] ?? input['text'];
  const patch = { ...(typeof title === 'string' ? { title } : {}), ...notes(input), ...sizing(input) };
  if (Object.keys(patch).length === 0) return textResult('Give a new title, description, plan, priority and / or estimate_minutes.', true);
  return request(api, 'PUT', itemRoute(id), patch, (body) => {
    const todo = todoOf(body);
    const summary = summaryOf(body);
    return textResult(`${todo ? `Updated ${todoLine(todo)}\n\n${summary}` : summary}${calibrationOf(body)}`);
  });
}

/** D75 · `todo_start`: marks an item in progress (the agent started it). */
export async function todoStart(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = idOf(input);
  if (id === '') return textResult(NEED_ID, true);
  return request(api, 'PUT', itemRoute(id), { state: 'in_progress' }, (body) => {
    const todo = todoOf(body);
    const summary = summaryOf(body);
    return textResult(todo ? `Started: ${todoLine(todo)}\nMark it done with todo_done when it is finished.\n\n${summary}` : summary);
  });
}

/** `todo_done`: marks an item done (`done: false` reopens it: open, not started). */
export async function todoDone(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = idOf(input);
  if (id === '') return textResult(NEED_ID, true);
  return request(api, 'PUT', itemRoute(id), { state: input['done'] === false ? 'open' : 'done' }, (body) => {
    const todo = todoOf(body);
    const summary = summaryOf(body);
    // D76: an item run in its own session goes to the developer's review instead of done.
    const word = todo?.state === 'done' ? 'Done' : todo?.state === 'review' ? "Done (in review: the developer reviews the run's work)" : 'Reopened';
    return textResult(todo ? `${word}: ${todoLine(todo)}\n\n${summary}` : summary);
  });
}

/** `todo_remove`: removes an item. */
export async function todoRemove(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = idOf(input);
  if (id === '') return textResult(NEED_ID, true);
  return request(api, 'DELETE', itemRoute(id), undefined, (body) => textResult(`Removed.\n\n${summaryOf(body)}`));
}

// ── D89: artifacts ──────────────────────────────────────────────────────

const NEED_ARTIFACT_ID = 'Give the artifact id (artifact_list shows it in brackets).';

/** The artifact id a call gives (`[abc]` is fine), `''` when none. */
function artifactIdOf(input: ToolInput): string {
  return typeof input['id'] === 'string' ? input['id'].trim().replace(/^\[|\]$/g, '') : '';
}

/** D89 · `artifact_save`: a new artifact, or with `id` a new version of one. */
export async function artifactSave(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  if (typeof input['title'] !== 'string' || input['title'].trim() === '') return textResult('Give the artifact a title (one short line).', true);
  if (typeof input['kind'] !== 'string' || !(ARTIFACT_KINDS as readonly string[]).includes(input['kind'])) return textResult(`Give a kind: ${ARTIFACT_KINDS.join(', ')}.`, true);
  const hasContent = typeof input['content'] === 'string';
  const hasPath = typeof input['path'] === 'string' && input['path'].trim() !== '';
  if (!hasContent && !hasPath) return textResult('Give content (the text) or path (a file in the session\'s working folders to copy in).', true);
  const id = artifactIdOf(input);
  const body = {
    title: input['title'],
    kind: input['kind'],
    ...(hasContent ? { content: input['content'] } : {}),
    ...(hasPath ? { path: input['path'] } : {}),
    ...(typeof input['language'] === 'string' ? { language: input['language'] } : {}),
    ...(id !== '' ? { id } : {}),
  };
  return request(api, 'POST', '/agent/v1/artifacts', body, (answer) => {
    const saved = record(answer) as unknown as Partial<ArtifactSaveResult>;
    if (!saved.artifact) return textResult('Switchboard did not answer with the artifact.', true);
    const what = saved.created ? 'Saved a new artifact' : `Saved version ${saved.version} of`;
    return textResult(`${what}: ${artifactLine(saved.artifact)}\nid: ${saved.artifact.id} · version: ${saved.version}\nTo revise it, call artifact_save again with id ${saved.artifact.id}.`);
  });
}

/** D89 · `artifact_list`: this session's artifacts, compact. */
export function artifactList(api: AgentApi): Promise<CallToolResult> {
  return request(api, 'GET', '/agent/v1/artifacts', undefined, (answer) => textResult(artifactListText(Array.isArray(answer) ? (answer as Artifact[]) : [])));
}

/** D89 · `artifact_get`: one artifact's latest (or named) version, with its text. */
export async function artifactGet(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = artifactIdOf(input);
  if (id === '') return textResult(NEED_ARTIFACT_ID, true);
  const version = input['version'];
  const query = typeof version === 'number' && Number.isInteger(version) ? `?version=${version}` : '';
  return request(api, 'GET', `/agent/v1/artifacts/${encodeURIComponent(id)}${query}`, undefined, (answer) => {
    const detail = record(answer) as unknown as Partial<ArtifactDetail>;
    if (!detail.version || typeof detail.id !== 'string') return textResult('Switchboard did not answer with the artifact.', true);
    const head = `${artifactLine(detail as ArtifactDetail)}\nShowing version ${detail.version.n} of ${detail.versions} (${artifactSizeLabel(detail.version.size)}).`;
    return textResult(detail.version.content === null ? `${head}\nAn image: no text (the developer sees it in the Artifacts tab).` : `${head}\n\n${detail.version.content}`);
  });
}

// ── D94: Switchboard-owned loops ────────────────────────────────────────

const NEED_LOOP_ID = 'Give the loop id (loop_list shows it in brackets).';

/** The loop id a call gives (`[abc]` is fine), `''` when none. */
function loopIdOf(input: ToolInput): string {
  return typeof input['id'] === 'string' ? input['id'].trim().replace(/^\[|\]$/g, '') : '';
}

function loopRoute(id: string, action = ''): string {
  return `/agent/v1/loops/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;
}

function isLoop(body: unknown): body is OwnedLoop {
  const value = record(body);
  return typeof value['id'] === 'string' && typeof value['prompt'] === 'string';
}

/** The loop fields a call gives, as the API takes them (snake_case stays: the server reads both). */
function loopFields(input: ToolInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['prompt', 'cron', 'every_minutes', 'at', 'expires_at', 'max_runs', 'label']) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

/** D94 · `loop_create`: a new loop in this session. */
export async function loopCreate(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  if (typeof input['prompt'] !== 'string' || input['prompt'].trim() === '') return textResult('Give the prompt: the message Switchboard sends into this session at each firing.', true);
  const schedules = ['cron', 'every_minutes', 'at'].filter((key) => input[key] !== undefined && input[key] !== null && input[key] !== '');
  if (schedules.length !== 1) return textResult('Give exactly one of cron (a cron expression), every_minutes (an interval in minutes) or at (one ISO 8601 time).', true);
  return request(api, 'POST', '/agent/v1/loops', loopFields(input), (body) =>
    isLoop(body) ? textResult(`${loopDetailText(body, 'Created')}\nSwitchboard sends the prompt into this session at each firing; manage it with loop_list, loop_update, loop_pause, loop_resume and loop_cancel.`) : textResult('Switchboard did not answer with the loop.', true),
  );
}

/** D94 · `loop_list`: this session's loops. */
export function loopList(api: AgentApi): Promise<CallToolResult> {
  return request(api, 'GET', '/agent/v1/loops', undefined, (body) => textResult(loopListText(Array.isArray(body) ? (body as OwnedLoop[]) : [])));
}

/** D94 · `loop_update`: changes only the fields given. */
export async function loopUpdate(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = loopIdOf(input);
  if (id === '') return textResult(NEED_LOOP_ID, true);
  const fields = loopFields(input);
  if (Object.keys(fields).length === 0) return textResult('Give what to change: prompt, a schedule (cron, every_minutes or at), expires_at, max_runs or label.', true);
  return request(api, 'PUT', loopRoute(id), fields, (body) => (isLoop(body) ? textResult(loopDetailText(body, 'Updated')) : textResult('Switchboard did not answer with the loop.', true)));
}

/** D94 · `loop_pause` / `loop_resume`. */
export async function loopAction(api: AgentApi, input: ToolInput, action: 'pause' | 'resume'): Promise<CallToolResult> {
  const id = loopIdOf(input);
  if (id === '') return textResult(NEED_LOOP_ID, true);
  return request(api, 'POST', loopRoute(id, action), {}, (body) =>
    isLoop(body) ? textResult(loopDetailText(body, action === 'pause' ? 'Paused' : 'Resumed')) : textResult('Switchboard did not answer with the loop.', true),
  );
}

/** D94 · `loop_cancel`: the loop is removed. */
export async function loopCancel(api: AgentApi, input: ToolInput): Promise<CallToolResult> {
  const id = loopIdOf(input);
  if (id === '') return textResult(NEED_LOOP_ID, true);
  return request(api, 'DELETE', loopRoute(id), undefined, () => textResult(`Cancelled loop ${id}: it will not fire again.`));
}

/** Tool `name`'s definition in {@link TODO_TOOLS}, (D89) {@link ARTIFACT_TOOLS} or (D94) {@link LOOP_TOOLS}. */
function tool(name: string): TodoToolDefinition {
  const found = [...TODO_TOOLS, ...ARTIFACT_TOOLS, ...LOOP_TOOLS].find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool ${name} in TODO_TOOLS / ARTIFACT_TOOLS`);
  return found;
}

/** The description of field `field` of tool `name` in {@link TODO_TOOLS} (the one place the text lives). */
function about(name: string, field: string): string {
  const description = record(record(tool(name).inputSchema['properties'])[field])['description'];
  if (typeof description !== 'string') throw new Error(`no description for ${name}.${field} in TODO_TOOLS`);
  return description;
}

/**
 * Tool `name`'s input schema: the fields' zod types, each optional so a missing
 * one reaches the handler, which says what is missing in its own words (D70);
 * extra keys kept (D68's `text`, an `estimateMinutes`); the JSON Schema's
 * `required` and `additionalProperties: false` declared as {@link TODO_TOOLS} has
 * them, so `tools/list` advertises the same contract.
 */
function inputSchema<Shape extends z.ZodRawShape>(name: string, shape: Shape) {
  const required = tool(name).inputSchema['required'];
  return z.looseObject(shape).meta({ ...(Array.isArray(required) ? { required: [...(required as string[])] } : {}), additionalProperties: false });
}

/** The fields' zod types, described from {@link TODO_TOOLS}. */
const field = {
  id: (name: string) => z.string().describe(about(name, 'id')).optional(),
  title: (name: string) => z.string().describe(about(name, 'title')).optional(),
  description: (name: string) => z.string().describe(about(name, 'description')).optional(),
  plan: (name: string) => z.string().describe(about(name, 'plan')).optional(),
  priority: (name: string) => z.enum(TODO_PRIORITIES as [string, ...string[]]).describe(about(name, 'priority')).optional(),
  estimate: (name: string) => z.int().min(1).max(TODO_ESTIMATE_MAX).describe(about(name, 'estimate_minutes')).optional(),
  done: (name: string) => z.boolean().describe(about(name, 'done')).optional(),
  // D89: the artifact tools' fields.
  text: (name: string, key: string) => z.string().describe(about(name, key)).optional(),
  kind: (name: string) => z.enum(ARTIFACT_KINDS as unknown as [string, ...string[]]).describe(about(name, 'kind')).optional(),
  version: (name: string) => z.int().min(1).max(ARTIFACT_VERSIONS_MAX).describe(about(name, 'version')).optional(),
  // D94: the loop tools' fields.
  every: (name: string) => z.int().min(1).max(LOOP_EVERY_MAX).describe(about(name, 'every_minutes')).optional(),
  expires: (name: string) => z.string().nullable().describe(about(name, 'expires_at')).optional(),
  maxRuns: (name: string) => z.int().min(1).max(LOOP_MAX_RUNS_MAX).nullable().describe(about(name, 'max_runs')).optional(),
};

/** D94: the schedule and limit fields of `loop_create` / `loop_update`. */
function loopShape(name: string) {
  return {
    prompt: field.text(name, 'prompt'),
    cron: field.text(name, 'cron'),
    every_minutes: field.every(name),
    at: field.text(name, 'at'),
    expires_at: field.expires(name),
    max_runs: field.maxRuns(name),
    label: field.text(name, 'label'),
  };
}

/** Runs the calls one at a time, in the order they came (a list after an add sees the add, as before the SDK). */
function inOrder(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
}

/**
 * The `switchboard` MCP server ({@link AGENT_MCP_SERVER}, with
 * {@link AGENT_MCP_INSTRUCTIONS}) and its sixteen tools (D75: `todo_start`; D89: the three artifact tools; D94: the six loop tools), calling `api`. Connect it to a
 * transport (a `StdioServerTransport` in the helper process).
 */
export function createTodoServer(api: AgentApi, version = '0.0.0'): McpServer {
  const server = new McpServer({ name: AGENT_MCP_SERVER, version }, { instructions: AGENT_MCP_INSTRUCTIONS });
  const serial = inOrder();

  const list = tool('todo_list');
  server.registerTool(
    'todo_list',
    { title: list.annotations.title, description: list.description, inputSchema: inputSchema('todo_list', {}), annotations: list.annotations },
    () => serial(() => todoList(api)),
  );

  const get = tool('todo_get');
  server.registerTool(
    'todo_get',
    { title: get.annotations.title, description: get.description, inputSchema: inputSchema('todo_get', { id: field.id('todo_get') }), annotations: get.annotations },
    (input) => serial(() => todoGet(api, input)),
  );

  const add = tool('todo_add');
  server.registerTool(
    'todo_add',
    {
      title: add.annotations.title,
      description: add.description,
      inputSchema: inputSchema('todo_add', {
        title: field.title('todo_add'),
        description: field.description('todo_add'),
        plan: field.plan('todo_add'),
        priority: field.priority('todo_add'),
        estimate_minutes: field.estimate('todo_add'),
      }),
      annotations: add.annotations,
    },
    (input) => serial(() => todoAdd(api, input)),
  );

  const update = tool('todo_update');
  server.registerTool(
    'todo_update',
    {
      title: update.annotations.title,
      description: update.description,
      inputSchema: inputSchema('todo_update', {
        id: field.id('todo_update'),
        title: field.title('todo_update'),
        description: field.description('todo_update'),
        plan: field.plan('todo_update'),
        priority: field.priority('todo_update'),
        estimate_minutes: field.estimate('todo_update'),
      }),
      annotations: update.annotations,
    },
    (input) => serial(() => todoUpdate(api, input)),
  );

  const start = tool('todo_start');
  server.registerTool(
    'todo_start',
    { title: start.annotations.title, description: start.description, inputSchema: inputSchema('todo_start', { id: field.id('todo_start') }), annotations: start.annotations },
    (input) => serial(() => todoStart(api, input)),
  );

  const done = tool('todo_done');
  server.registerTool(
    'todo_done',
    {
      title: done.annotations.title,
      description: done.description,
      inputSchema: inputSchema('todo_done', { id: field.id('todo_done'), done: field.done('todo_done') }),
      annotations: done.annotations,
    },
    (input) => serial(() => todoDone(api, input)),
  );

  const remove = tool('todo_remove');
  server.registerTool(
    'todo_remove',
    { title: remove.annotations.title, description: remove.description, inputSchema: inputSchema('todo_remove', { id: field.id('todo_remove') }), annotations: remove.annotations },
    (input) => serial(() => todoRemove(api, input)),
  );

  // D89: the artifact tools.
  const save = tool('artifact_save');
  server.registerTool(
    'artifact_save',
    {
      title: save.annotations.title,
      description: save.description,
      inputSchema: inputSchema('artifact_save', {
        title: field.text('artifact_save', 'title'),
        kind: field.kind('artifact_save'),
        content: field.text('artifact_save', 'content'),
        path: field.text('artifact_save', 'path'),
        language: field.text('artifact_save', 'language'),
        id: field.text('artifact_save', 'id'),
      }),
      annotations: save.annotations,
    },
    (input) => serial(() => artifactSave(api, input)),
  );

  const artifacts = tool('artifact_list');
  server.registerTool(
    'artifact_list',
    { title: artifacts.annotations.title, description: artifacts.description, inputSchema: inputSchema('artifact_list', {}), annotations: artifacts.annotations },
    () => serial(() => artifactList(api)),
  );

  const read = tool('artifact_get');
  server.registerTool(
    'artifact_get',
    {
      title: read.annotations.title,
      description: read.description,
      inputSchema: inputSchema('artifact_get', { id: field.text('artifact_get', 'id'), version: field.version('artifact_get') }),
      annotations: read.annotations,
    },
    (input) => serial(() => artifactGet(api, input)),
  );

  // D94: the loop tools.
  const loopCreateTool = tool('loop_create');
  server.registerTool(
    'loop_create',
    { title: loopCreateTool.annotations.title, description: loopCreateTool.description, inputSchema: inputSchema('loop_create', loopShape('loop_create')), annotations: loopCreateTool.annotations },
    (input) => serial(() => loopCreate(api, input)),
  );
  const loopListTool = tool('loop_list');
  server.registerTool(
    'loop_list',
    { title: loopListTool.annotations.title, description: loopListTool.description, inputSchema: inputSchema('loop_list', {}), annotations: loopListTool.annotations },
    () => serial(() => loopList(api)),
  );
  const loopUpdateTool = tool('loop_update');
  server.registerTool(
    'loop_update',
    {
      title: loopUpdateTool.annotations.title,
      description: loopUpdateTool.description,
      inputSchema: inputSchema('loop_update', { id: field.text('loop_update', 'id'), ...loopShape('loop_update') }),
      annotations: loopUpdateTool.annotations,
    },
    (input) => serial(() => loopUpdate(api, input)),
  );
  for (const action of ['pause', 'resume'] as const) {
    const definition = tool(`loop_${action}`);
    server.registerTool(
      `loop_${action}`,
      { title: definition.annotations.title, description: definition.description, inputSchema: inputSchema(`loop_${action}`, { id: field.text(`loop_${action}`, 'id') }), annotations: definition.annotations },
      (input) => serial(() => loopAction(api, input, action)),
    );
  }
  const loopCancelTool = tool('loop_cancel');
  server.registerTool(
    'loop_cancel',
    { title: loopCancelTool.annotations.title, description: loopCancelTool.description, inputSchema: inputSchema('loop_cancel', { id: field.text('loop_cancel', 'id') }), annotations: loopCancelTool.annotations },
    (input) => serial(() => loopCancel(api, input)),
  );

  return server;
}

async function main(argv: readonly string[]): Promise<number> {
  const at = argv.indexOf(AGENT_MCP_MARKER);
  const port = Number(argv[at + 1]);
  const sessionId = argv[at + 2] ?? '';
  const token = process.env[AGENT_TOKEN_ENV] ?? '';
  if (!Number.isInteger(port) || port <= 0 || port > 65_535 || sessionId === '') {
    process.stderr.write(`usage: node sb-mcp.ts ${AGENT_MCP_MARKER} <port> <sessionId> (with ${AGENT_TOKEN_ENV} set)\n`);
    return 2;
  }
  // Serves until stdin ends; the process exits once the last answer is written.
  await createTodoServer(loopbackApi(port, sessionId, token)).connect(new StdioServerTransport());
  return 0;
}

if (process.argv.includes(AGENT_MCP_MARKER)) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`switchboard mcp: ${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
