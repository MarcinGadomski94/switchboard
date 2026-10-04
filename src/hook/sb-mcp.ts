/**
 * D68 (`docs/todos.md` → *The agent's tools*): the built-in `switchboard` MCP
 * server, a stdio helper the session's CLI starts:
 * `node sb-mcp.ts --switchboard-mcp <port> <sessionId>`, with the session's agent
 * token in `SWITCHBOARD_TODO_TOKEN` (never on the argv). No npm dependencies; Node
 * ≥ 24 runs it directly.
 *
 * It speaks MCP over stdio (newline-delimited JSON-RPC 2.0: `initialize`,
 * `tools/list`, `tools/call`, `ping`) and serves five tools, `todo_list`,
 * `todo_add`, `todo_update`, `todo_done`, `todo_remove`, each one call to the
 * local Switchboard's `/agent/v1/todos` (127.0.0.1 only). The token authorizes
 * that one session's list and nothing else; the helper never reads any other
 * file or variable. A failing call answers a tool error the agent can read
 * (Switchboard not running, an unknown id), never a crash.
 */
import http from 'node:http';
import type { SessionTodo, SessionTodoList } from '../core/api.ts';
import { AGENT_MCP_MARKER, AGENT_MCP_SERVER, AGENT_SESSION_HEADER, AGENT_TOKEN_ENV, TODO_TOOLS, todoLine, todoListText } from '../core/todos.ts';

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
      case 'todo_add':
        if (typeof input['text'] !== 'string') return textResult('Give the item text.', true);
        answer = await api('POST', '/agent/v1/todos', { text: input['text'] });
        break;
      case 'todo_update':
        if (needId()) return needId() as ToolResult;
        if (typeof input['text'] !== 'string') return textResult('Give the new text.', true);
        answer = await api('PUT', `/agent/v1/todos/${encodeURIComponent(id)}`, { text: input['text'] });
        break;
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
        instructions: "This session's todo list in Switchboard. When the user asks to add something to the todo list, use todo_add; mark items done with todo_done when finished; use todo_list when asked what is left.",
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
