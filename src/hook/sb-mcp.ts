/**
 * D68 (`docs/todos.md` → *The agent's tools*): the built-in `switchboard` MCP
 * server, a stdio helper the session's CLI starts:
 * `node sb-mcp.ts --switchboard-mcp <port> <sessionId>`, with the session's agent
 * token in `SWITCHBOARD_TODO_TOKEN` (never on the argv). No npm dependencies; Node
 * ≥ 24 runs it directly.
 *
 * It speaks MCP over stdio (newline-delimited JSON-RPC 2.0: `initialize`,
 * `tools/list`, `tools/call`, `ping`) and serves six tools, `todo_list`,
 * `todo_get` (D69), `todo_add`, `todo_update` (D70: with priority and estimate), `todo_done`, `todo_remove`, each one call to the
 * local Switchboard's `/agent/v1/todos` (127.0.0.1 only). The token authorizes
 * that one session's list and nothing else; the helper never reads any other
 * file or variable. A failing call answers a tool error the agent can read
 * (Switchboard not running, an unknown id), never a crash.
 */
import http from 'node:http';
import type { SessionTodo, SessionTodoList } from '../core/api.ts';
import {
  AGENT_MCP_INSTRUCTIONS,
  AGENT_MCP_MARKER,
  AGENT_MCP_SERVER,
  AGENT_SESSION_HEADER,
  AGENT_TOKEN_ENV,
  TODO_ESTIMATE_MAX,
  TODO_PRIORITIES,
  TODO_TOOLS,
  isTodoPriority,
  todoDetailText,
  todoLine,
  todoListText,
} from '../core/todos.ts';

/** The MCP protocol versions this helper speaks; it answers the client's when it is one of them, else the newest. */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];

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

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly isError?: boolean;
}

function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The refusal's message (`{ message }` of the API), else the status. */
function failure(answer: ApiAnswer): ToolResult {
  const message = record(answer.body)['message'];
  if (answer.status === 401) return textResult('Switchboard refused the todo tools for this session (the session token does not match).', true);
  return textResult(typeof message === 'string' ? message : `Switchboard answered HTTP ${answer.status}.`, true);
}

function listOf(body: unknown): SessionTodoList | null {
  const value = record(body);
  if (Array.isArray(value['todos'])) return value as unknown as SessionTodoList;
  const list = record(value['list']);
  return Array.isArray(list['todos']) ? (list as unknown as SessionTodoList) : null;
}

/** D69: the description and plan a call gives (strings only; `''` removes one on update). */
function notes(input: Record<string, unknown>): { description?: string; plan?: string } {
  return {
    ...(typeof input['description'] === 'string' ? { description: input['description'] } : {}),
    ...(typeof input['plan'] === 'string' ? { plan: input['plan'] } : {}),
  };
}

/** D70: the priority and estimate a call gives (`estimate_minutes`, the tool's name, becomes the API's `estimateMinutes`). */
function sizing(input: Record<string, unknown>): { priority?: unknown; estimateMinutes?: unknown } {
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
function missingForAdd(input: Record<string, unknown>): string | null {
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

/** Runs one tool call against the API. */
export async function callTool(api: AgentApi, name: string, args: unknown): Promise<ToolResult> {
  const input = record(args);
  const id = typeof input['id'] === 'string' ? input['id'].trim().replace(/^\[|\]$/g, '') : '';
  const needId = (): ToolResult | null => (id === '' ? textResult('Give the item id (todo_list shows it in brackets).', true) : null);
  let answer: ApiAnswer;
  try {
    switch (name) {
      case 'todo_list':
        answer = await api('GET', '/agent/v1/todos');
        break;
      case 'todo_get':
        if (needId()) return needId() as ToolResult;
        answer = await api('GET', `/agent/v1/todos/${encodeURIComponent(id)}`);
        break;
      case 'todo_add': {
        // D69: `text` (the D68 field) still names the title.
        const title = input['title'] ?? input['text'];
        if (typeof title !== 'string') return textResult('Give the item a title (one short line); add a description, a handover plan, a priority and an estimate too.', true);
        const missing = missingForAdd(input);
        if (missing) return textResult(missing, true);
        answer = await api('POST', '/agent/v1/todos', { title, ...notes(input), ...sizing(input) });
        break;
      }
      case 'todo_update': {
        if (needId()) return needId() as ToolResult;
        const title = input['title'] ?? input['text'];
        const patch = { ...(typeof title === 'string' ? { title } : {}), ...notes(input), ...sizing(input) };
        if (Object.keys(patch).length === 0) return textResult('Give a new title, description, plan, priority and / or estimate_minutes.', true);
        answer = await api('PUT', `/agent/v1/todos/${encodeURIComponent(id)}`, patch);
        break;
      }
      case 'todo_done':
        if (needId()) return needId() as ToolResult;
        answer = await api('PUT', `/agent/v1/todos/${encodeURIComponent(id)}`, { state: input['done'] === false ? 'open' : 'done' });
        break;
      case 'todo_remove':
        if (needId()) return needId() as ToolResult;
        answer = await api('DELETE', `/agent/v1/todos/${encodeURIComponent(id)}`);
        break;
      default:
        return textResult(`Unknown tool ${name}.`, true);
    }
  } catch (error) {
    return textResult(`Switchboard could not be reached: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  if (answer.status < 200 || answer.status >= 300) return failure(answer);
  const list = listOf(answer.body);
  const todo = record(answer.body)['todo'] as SessionTodo | undefined;
  const summary = list ? todoListText(list) : '';
  switch (name) {
    case 'todo_get':
      return textResult(isTodo(answer.body) ? todoDetailText(answer.body) : 'Switchboard did not answer with the item.', !isTodo(answer.body));
    case 'todo_add':
      return textResult(todo ? `Added ${todoLine(todo)}\n\n${summary}` : summary);
    case 'todo_update':
      return textResult(todo ? `Updated ${todoLine(todo)}\n\n${summary}` : summary);
    case 'todo_done':
      return textResult(todo ? `${todo.state === 'done' ? 'Done' : 'Reopened'}: ${todoLine(todo)}\n\n${summary}` : summary);
    case 'todo_remove':
      return textResult(`Removed.\n\n${summary}`);
    default:
      return textResult(summary || 'The todo list is empty.');
  }
}

/** A JSON-RPC message from the client. */
interface RpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

/** The answer to one client message (`null` for a notification or a response). */
export async function handleMessage(message: unknown, api: AgentApi, version = '0.0.0'): Promise<Record<string, unknown> | null> {
  const msg = record(message) as RpcMessage;
  const id = msg.id;
  const isRequest = typeof msg.method === 'string' && (typeof id === 'string' || typeof id === 'number');
  if (!isRequest) return null;
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const error = (code: number, text: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  const params = record(msg.params);
  switch (msg.method) {
    case 'initialize': {
      const asked = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
      return reply({
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: AGENT_MCP_SERVER, version },
        instructions: AGENT_MCP_INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TODO_TOOLS });
    case 'tools/call':
      if (typeof params['name'] !== 'string') return error(-32602, 'tools/call needs a tool name');
      return reply(await callTool(api, params['name'], params['arguments']));
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      return error(-32601, `method not found: ${String(msg.method)}`);
  }
}

/** Serves MCP on stdin / stdout until stdin ends. */
export async function serve(api: AgentApi, input: NodeJS.ReadableStream, output: NodeJS.WritableStream, version = '0.0.0'): Promise<void> {
  let buffer = '';
  let pending = Promise.resolve();
  const write = (value: unknown): void => {
    output.write(`${JSON.stringify(value)}\n`);
  };
  const onLine = (line: string): void => {
    if (line.trim() === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    // Answers go out in the order the requests came.
    pending = pending.then(async () => {
      const answer = await handleMessage(message, api, version).catch((error: unknown) => ({ jsonrpc: '2.0', id: record(message)['id'] ?? null, error: { code: -32603, message: String(error) } }));
      if (answer) write(answer);
    });
  };
  input.setEncoding?.('utf8');
  for await (const chunk of input) {
    buffer += String(chunk);
    let at = buffer.indexOf('\n');
    while (at >= 0) {
      onLine(buffer.slice(0, at).replace(/\r$/, ''));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf('\n');
    }
  }
  if (buffer.trim() !== '') onLine(buffer);
  await pending;
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
  await serve(loopbackApi(port, sessionId, token), process.stdin, process.stdout);
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
