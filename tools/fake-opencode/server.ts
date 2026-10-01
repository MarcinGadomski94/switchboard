import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { type FakeStore, type StoredMessage, limitFile, loadAuth, loadStore, saveAuth, saveStore } from './store.ts';

type Json = Record<string, unknown>;

const env = process.env;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/** The fake's providers and models (`GET /config/providers`; VERIFIED shape, `packages/sdk/openapi.json` at v1.18.34). */
export const FAKE_OPENCODE_PROVIDERS: Json[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    source: 'env',
    env: ['ANTHROPIC_API_KEY'],
    options: {},
    models: {
      'claude-sonnet-5': { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', limit: { context: 200_000, output: 64_000 }, variants: { high: {}, max: {} }, capabilities: { reasoning: true, attachment: true } },
    },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    source: 'api',
    env: ['OPENAI_API_KEY'],
    options: {},
    models: {
      'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5', limit: { context: 400_000, output: 128_000 }, variants: { low: {}, medium: {}, high: {} }, capabilities: { reasoning: true, attachment: true } },
    },
  },
];

interface Turn {
  readonly sessionID: string;
  readonly abort: Promise<void>;
  readonly fireAbort: () => void;
  aborted: boolean;
  done: boolean;
}

interface Waiter {
  readonly resolve: (answer: Json | null) => void;
}

/**
 * `opencode serve` (VERIFIED `packages/opencode/src/cli/cmd/serve.ts`, `server/server.ts`
 * at v1.18.34): an HTTP API + an SSE event stream on `--hostname` / `--port`,
 * HTTP Basic auth when `OPENCODE_SERVER_PASSWORD` is set. The fake keeps sessions
 * in `$XDG_DATA_HOME/opencode/fake-store.json`. Behaviour per message: `docs/fake-opencode.md`.
 */
export async function serve(args: readonly string[], options: { readonly log: (entry: Json) => Promise<void> }): Promise<number | null> {
  let port = 0;
  let hostname = '127.0.0.1';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const [flag, inline] = arg.includes('=') ? arg.split('=', 2) : [arg, undefined];
    const value = inline ?? args[index + 1];
    if (flag === '--port') {
      port = Number(value);
      if (inline === undefined) index += 1;
    } else if (flag === '--hostname') {
      hostname = String(value);
      if (inline === undefined) index += 1;
    } else if (flag === '--print-logs' || flag?.startsWith('--log-level')) {
      if (flag === '--log-level' && inline === undefined) index += 1;
    }
  }
  const store: FakeStore = await loadStore(env);
  const password = env['OPENCODE_SERVER_PASSWORD'] ?? '';
  const username = env['OPENCODE_SERVER_USERNAME'] ?? 'opencode';
  const clients = new Set<ServerResponse>();
  const waiters = new Map<string, Waiter>();
  const turns = new Map<string, Turn>();
  const heartbeatMs = Number(env['FAKE_OPENCODE_HEARTBEAT_MS'] ?? 10_000);
  let configContent: Json = {};
  try {
    configContent = env['OPENCODE_CONFIG_CONTENT'] ? (JSON.parse(env['OPENCODE_CONFIG_CONTENT']) as Json) : {};
  } catch {
    configContent = {};
  }
  const permissionConfig = isRecord(configContent['permission']) ? configContent['permission'] : {};

  const emit = (type: string, properties: Json): void => {
    const frame = `data: ${JSON.stringify({ id: id('evt'), type, properties })}\n\n`;
    for (const client of clients) client.write(frame);
  };
  const persist = (): Promise<void> => saveStore(env, store);
  const sessionOf = (sessionID: string): Json | undefined => store.sessions.find((session) => session['id'] === sessionID);
  const messagesOf = (sessionID: string): StoredMessage[] => (store.messages[sessionID] ??= []);

  const authorized = (request: IncomingMessage): boolean => {
    if (password === '') return true;
    const header = request.headers.authorization ?? '';
    const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
    const given = Buffer.from(header);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const body = async (request: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '') return {};
    return JSON.parse(text) as unknown;
  };

  const json = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };

  const newSession = (directory: string, input: Json): Json => {
    const now = Date.now();
    const session: Json = {
      id: id('ses'),
      slug: 'fake-session',
      projectID: 'proj_fake',
      directory,
      title: typeof input['title'] === 'string' ? input['title'] : 'New session',
      version: '1.18.34',
      time: { created: now, updated: now },
      ...(typeof input['parentID'] === 'string' ? { parentID: input['parentID'] } : {}),
    };
    store.sessions.push(session);
    emit('session.created', { sessionID: session['id'], info: session });
    return session;
  };

  const ask = (requestID: string, sessionID: string, turn: Turn): Promise<Json | null> =>
    Promise.race([
      new Promise<Json | null>((resolve) => waiters.set(requestID, { resolve })),
      turn.abort.then(() => {
        waiters.delete(requestID);
        return null;
      }),
    ]).then((answer) => {
      void sessionID;
      return answer;
    });

  const sleep = (ms: number, turn: Turn): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), ms);
      }),
      turn.abort.then(() => false),
    ]).finally(() => clearTimeout(timer));
  };

  /** Plays one prompt (`[fake:…]` tokens in `docs/fake-opencode.md`). */
  const play = async (session: Json, input: Json, turn: Turn): Promise<void> => {
    const sessionID = String(session['id']);
    const directory = String(session['directory']);
    const parts = Array.isArray(input['parts']) ? input['parts'].filter(isRecord) : [];
    const text = parts.filter((part) => part['type'] === 'text').map((part) => String(part['text'] ?? '')).join('\n');
    const files = parts.filter((part) => part['type'] === 'file');
    const model = isRecord(input['model']) ? input['model'] : { providerID: 'anthropic', modelID: 'claude-sonnet-5' };
    const now = Date.now();
    emit('session.status', { sessionID, status: { type: 'busy' } });
    const userInfo: Json = { id: id('msg'), sessionID, role: 'user', time: { created: now }, agent: 'build', model };
    const userParts: Json[] = parts.map((part) => ({ ...part, id: id('prt'), sessionID, messageID: userInfo['id'] }));
    messagesOf(sessionID).push({ info: userInfo, parts: userParts });
    emit('message.updated', { sessionID, info: userInfo });
    for (const part of userParts) emit('message.part.updated', { sessionID, part, time: now });
    const assistant: Json = {
      id: id('msg'),
      sessionID,
      role: 'assistant',
      parentID: userInfo['id'],
      modelID: model['modelID'],
      providerID: model['providerID'],
      mode: 'build',
      agent: 'build',
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now },
      ...(typeof input['variant'] === 'string' ? { variant: input['variant'] } : {}),
    };
    const assistantParts: Json[] = [];
    const stored: StoredMessage = { info: assistant, parts: assistantParts };
    messagesOf(sessionID).push(stored);
    emit('message.updated', { sessionID, info: assistant });
    const part = (fields: Json): Json => {
      const made = { id: id('prt'), sessionID, messageID: assistant['id'], ...fields };
      assistantParts.push(made);
      emit('message.part.updated', { sessionID, part: made, time: Date.now() });
      return made;
    };
    const update = (made: Json, fields: Json): void => {
      Object.assign(made, fields);
      emit('message.part.updated', { sessionID, part: made, time: Date.now() });
    };
    const end = async (error: Json | null): Promise<void> => {
      if (turn.done) return;
      turn.done = true;
      if (error) {
        emit('session.error', { sessionID, error });
        assistant['error'] = error;
      }
      (assistant['time'] as Json)['completed'] = Date.now();
      emit('message.updated', { sessionID, info: assistant });
      emit('session.status', { sessionID, status: { type: 'idle' } });
      emit('session.idle', { sessionID });
      turns.delete(sessionID);
      await persist();
    };
    const aborted = (): Promise<void> => end({ name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } });

    // D63: a data folder at its limit (`fake-limit`, or `FAKE_OPENCODE_LIMIT=1`): the provider's 429, no content.
    const limitMarker = limitFile(env);
    if (env['FAKE_OPENCODE_LIMIT'] === '1' || (limitMarker !== null && existsSync(limitMarker))) {
      return end({ name: 'APIError', data: { message: 'Rate limit exceeded: 429 Too Many Requests (usage limit reached)', statusCode: 429, isRetryable: false } });
    }

    part({ type: 'step-start' });
    part({ type: 'reasoning', text: 'fake-opencode is thinking', time: { start: Date.now(), end: Date.now() } });
    let reply = files.length > 0 ? `[fake-opencode: ${files.length} file part${files.length === 1 ? '' : 's'}: ${files.map((file) => String(file['mime'])).join(', ')}]` : 'OK';
    const say = /\[fake:say ("(?:[^"\\]|\\.)*")\]/.exec(text);
    if (say) reply = JSON.parse(say[1] as string) as string;
    let tokens = 18_000;
    const usage = /\[fake:usage (\d+)\]/.exec(text);
    if (usage) tokens = Number(usage[1]);

    const holdToken = /\[fake:hold (\d+(?:\.\d+)?)\]/.exec(text);
    if (holdToken && !(await sleep(Number(holdToken[1]) * 1000, turn))) return aborted();

    const toolRun = async (tool: string, toolInput: Json, output: string, permission: { readonly name: string; readonly pattern: string } | null): Promise<'ok' | 'rejected' | 'aborted'> => {
      const callID = id('call');
      const made = part({ type: 'tool', callID, tool, state: { status: 'pending', input: {}, raw: '' } });
      update(made, { state: { status: 'running', input: toolInput, title: tool, time: { start: Date.now() } } });
      const needs = permission && (permissionConfig[permission.name] === 'ask' || (permission.name === 'bash' && permissionConfig['bash'] === undefined && env['FAKE_OPENCODE_ASK_ALL'] === '1'));
      if (permission && needs) {
        const requestID = id('per');
        emit('permission.asked', { id: requestID, sessionID, permission: permission.name, patterns: [permission.pattern], metadata: { ...toolInput }, always: [`${permission.pattern}*`], tool: { messageID: assistant['id'], callID } });
        const answer = await ask(requestID, sessionID, turn);
        if (answer === null) return 'aborted';
        const decision = String(answer['reply'] ?? answer['response'] ?? '');
        await options.log({ kind: 'permission-reply', requestID, reply: decision, message: answer['message'] ?? null });
        emit('permission.replied', { sessionID, requestID, reply: decision });
        if (decision === 'reject') {
          update(made, { state: { status: 'error', input: toolInput, error: `The user rejected permission to use this specific tool call.${answer['message'] ? ` ${String(answer['message'])}` : ''}`, time: { start: Date.now(), end: Date.now() } } });
          return 'rejected';
        }
      }
      update(made, { state: { status: 'completed', input: toolInput, output, title: tool, metadata: {}, time: { start: Date.now(), end: Date.now() } } });
      return 'ok';
    };

    const cmd = /\[fake:cmd ([^\]]+)\]/.exec(text);
    if (cmd && (await toolRun('bash', { command: cmd[1], description: 'fake command' }, `fake-opencode: ran ${cmd[1]}\n`, { name: 'bash', pattern: cmd[1] as string })) === 'aborted') return aborted();

    const approve = /\[fake:approve-cmd ([^\]]+)\]/.exec(text);
    if (approve) {
      const outcome = await toolRun('bash', { command: approve[1], description: 'fake command' }, `fake-opencode: ran ${approve[1]}\n`, { name: 'bash', pattern: approve[1] as string });
      if (outcome === 'aborted') return aborted();
      reply = outcome === 'ok' ? 'ran it' : 'the command was rejected';
    }

    const write = /\[fake:write ([^\]\s]+)\]/.exec(text);
    if (write) {
      const target = path.resolve(directory, write[1] as string);
      if (!target.startsWith(path.resolve(directory) + path.sep)) return end({ name: 'UnknownError', data: { message: `${String(write[1])} leaves the project` } });
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'written by fake-opencode\n');
      if ((await toolRun('write', { filePath: target, content: 'written by fake-opencode\n' }, 'Wrote file successfully.', { name: 'edit', pattern: target })) === 'aborted') return aborted();
    }

    if (text.includes('[fake:ask]')) {
      const requestID = id('que');
      const callID = id('call');
      emit('question.asked', {
        id: requestID,
        sessionID,
        questions: [{ question: 'Which color should the button be?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }], multiple: false }],
        tool: { messageID: assistant['id'], callID },
      });
      const answer = await ask(requestID, sessionID, turn);
      if (answer === null) return aborted();
      await options.log({ kind: 'question-reply', requestID, answers: answer['answers'] ?? null, rejected: answer['rejected'] === true });
      const answers = Array.isArray(answer['answers']) ? (answer['answers'] as unknown[]) : [];
      reply = answer['rejected'] === true ? 'no answer' : `You chose ${(answers[0] as string[] | undefined)?.join(', ') ?? '(none)'}`;
    }

    const subagent = /\[fake:subagent ([^\]]+)\]/.exec(text);
    if (subagent) {
      const callID = id('call');
      const toolInput = { description: 'fake subagent', prompt: subagent[1], subagent_type: 'general' };
      const made = part({ type: 'tool', callID, tool: 'task', state: { status: 'pending', input: {}, raw: '' } });
      const child = newSession(directory, { parentID: sessionID, title: 'fake subagent' });
      const childID = String(child['id']);
      update(made, { state: { status: 'running', input: toolInput, title: 'fake subagent', metadata: { sessionId: childID }, time: { start: Date.now() } } });
      const childMessage: Json = { id: id('msg'), sessionID: childID, role: 'assistant', modelID: 'claude-sonnet-5', providerID: 'anthropic', time: { created: Date.now() }, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 };
      emit('message.updated', { sessionID: childID, info: childMessage });
      const childText = { id: id('prt'), sessionID: childID, messageID: childMessage['id'], type: 'text', text: 'fake-opencode: the subagent looked around', time: { start: Date.now(), end: Date.now() } };
      emit('message.part.updated', { sessionID: childID, part: childText, time: Date.now() });
      (childMessage['time'] as Json)['completed'] = Date.now();
      emit('message.updated', { sessionID: childID, info: childMessage });
      update(made, { state: { status: 'completed', input: toolInput, output: 'fake-opencode: the subagent is done', title: 'fake subagent', metadata: { sessionId: childID }, time: { start: Date.now(), end: Date.now() } } });
    }

    const fail = /\[fake:fail ([^\]]+)\]/.exec(text);
    if (fail) return end({ name: 'APIError', data: { message: fail[1], isRetryable: false } });

    if (text.includes('[fake:handover]')) reply = 'Handover: goal = the fake task; decisions = none; files changed = none; open tasks = none; next step = continue; uncommitted = nothing.';

    if (turn.aborted) return aborted();
    const textPart = part({ type: 'text', text: '', time: { start: Date.now() } });
    const half = Math.ceil(reply.length / 2);
    for (const delta of [reply.slice(0, half), reply.slice(half)]) {
      if (delta) emit('message.part.delta', { sessionID, messageID: assistant['id'], partID: textPart['id'], field: 'text', delta });
    }
    update(textPart, { text: reply, time: { start: Date.now(), end: Date.now() } });
    const used = { input: Math.round(tokens * 0.25), output: 10, reasoning: 0, cache: { read: tokens - Math.round(tokens * 0.25), write: 0 } };
    part({ type: 'step-finish', reason: 'stop', cost: 0.0012, tokens: used });
    assistant['tokens'] = used;
    assistant['cost'] = 0.0012;
    assistant['finish'] = 'stop';
    await end(null);
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://fake');
    const method = request.method ?? 'GET';
    await options.log({ kind: 'http', method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: request.headers.authorization ? 'basic' : null });
    if (method === 'POST' && url.pathname === '/__fake/cut-events') {
      // Tests only (no auth: the test does not know the bridge's random password): cut every open event stream.
      for (const client of clients) client.destroy();
      clients.clear();
      return json(response, 200, true);
    }
    if (!authorized(request)) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="opencode"' });
      response.end('Unauthorized');
      return;
    }
    const directory = url.searchParams.get('directory') ?? decodeURIComponent(String(request.headers['x-opencode-directory'] ?? '')) ?? process.cwd();
    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    if (method === 'GET' && url.pathname === '/global/health') return json(response, 200, { healthy: true, version: '1.18.34' });
    if (method === 'GET' && url.pathname === '/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(response);
      response.write(`data: ${JSON.stringify({ id: id('evt'), type: 'server.connected', properties: {} })}\n\n`);
      const beat = setInterval(() => response.write(`data: ${JSON.stringify({ id: id('evt'), type: 'server.heartbeat', properties: {} })}\n\n`), heartbeatMs);
      request.on('close', () => {
        clearInterval(beat);
        clients.delete(response);
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/config/providers') {
      const providers = env['FAKE_OPENCODE_PROVIDERS'] === 'none' ? [] : FAKE_OPENCODE_PROVIDERS;
      return json(response, 200, { providers, default: providers.length > 0 ? { anthropic: 'claude-sonnet-5' } : {} });
    }
    // D63: provider sign-in (VERIFIED routes and shapes, `packages/sdk/openapi.json` at v1.18.34).
    if (method === 'GET' && url.pathname === '/provider/auth') {
      return json(response, 200, { anthropic: [{ type: 'oauth', label: 'Claude Pro/Max' }, { type: 'api', label: 'API key' }], openai: [{ type: 'api', label: 'API key' }] });
    }
    if (method === 'GET' && url.pathname === '/provider') {
      const connected = (await loadAuth(env)) ?? [];
      return json(response, 200, { all: FAKE_OPENCODE_PROVIDERS, default: { anthropic: 'claude-sonnet-5' }, connected });
    }
    if (method === 'POST' && segments[0] === 'provider' && segments[1] && segments[2] === 'oauth' && segments[3] === 'authorize') {
      const input = await body(request);
      await options.log({ kind: 'oauth-authorize', provider: segments[1], body: input });
      const code = env['FAKE_OPENCODE_OAUTH_METHOD'] === 'code';
      return json(response, 200, { url: env['FAKE_OPENCODE_LOGIN_URL'] ?? `https://login.fake-opencode.example.test/authorize?provider=${segments[1]}&state=${id('st')}`, method: code ? 'code' : 'auto', instructions: code ? 'Paste the authorization code here' : 'Complete the sign-in in your browser' });
    }
    if (method === 'POST' && segments[0] === 'provider' && segments[1] && segments[2] === 'oauth' && segments[3] === 'callback') {
      const input = await body(request);
      await options.log({ kind: 'oauth-callback', provider: segments[1], hasCode: isRecord(input) && typeof input['code'] === 'string' });
      if (env['FAKE_OPENCODE_LOGIN_MODE'] === 'never') await new Promise(() => undefined);
      if (!(isRecord(input) && typeof input['code'] === 'string')) await new Promise((resolve) => setTimeout(resolve, Number(env['FAKE_OPENCODE_LOGIN_MS'] ?? 300)));
      await saveAuth(env, [...new Set([...((await loadAuth(env)) ?? []), segments[1]])]);
      return json(response, 200, true);
    }
    if (segments[0] === 'auth' && segments[1] && method === 'PUT') {
      const input = await body(request);
      // The key is never logged or kept: only that the provider is signed in.
      await options.log({ kind: 'auth-set', provider: segments[1], type: isRecord(input) ? input['type'] : null });
      await saveAuth(env, [...new Set([...((await loadAuth(env)) ?? []), segments[1]])]);
      return json(response, 200, true);
    }
    if (segments[0] === 'auth' && segments[1] && method === 'DELETE') {
      await saveAuth(env, ((await loadAuth(env)) ?? []).filter((provider) => provider !== segments[1]));
      return json(response, 200, true);
    }
    if (method === 'GET' && url.pathname === '/mcp') return json(response, 200, Object.fromEntries(Object.keys(store.mcp).map((name) => [name, { status: 'connected' }])));
    if (method === 'POST' && url.pathname === '/session') {
      const input = await body(request);
      const session = newSession(directory || process.cwd(), isRecord(input) ? input : {});
      await persist();
      return json(response, 200, session);
    }
    if (method === 'GET' && url.pathname === '/session') return json(response, 200, store.sessions);
    if (method === 'GET' && url.pathname === '/session/status') {
      return json(response, 200, Object.fromEntries(store.sessions.map((session) => [String(session['id']), { type: turns.has(String(session['id'])) ? 'busy' : 'idle' }])));
    }
    if (segments[0] === 'session' && segments[1]) {
      const session = sessionOf(segments[1]);
      if (!session) return json(response, 404, { name: 'NotFoundError', data: { message: `Session not found: ${segments[1]}` } });
      const sessionID = String(session['id']);
      if (method === 'GET' && segments.length === 2) return json(response, 200, session);
      if (method === 'GET' && segments[2] === 'message') return json(response, 200, messagesOf(sessionID));
      if (method === 'POST' && segments[2] === 'prompt_async') {
        const input = await body(request);
        if (!isRecord(input) || !Array.isArray(input['parts'])) return json(response, 400, { name: 'BadRequest', data: { message: 'parts is required' } });
        await options.log({ kind: 'prompt', sessionID, body: input });
        if (turns.has(sessionID)) return json(response, 409, { name: 'BusyError', data: { message: `Session ${sessionID} is busy` } });
        let fireAbort: () => void = () => undefined;
        const abort = new Promise<void>((resolve) => {
          fireAbort = resolve;
        });
        const turn: Turn = { sessionID, abort, fireAbort, aborted: false, done: false };
        turns.set(sessionID, turn);
        response.writeHead(204);
        response.end();
        void play(session, input, turn);
        return;
      }
      if (method === 'POST' && segments[2] === 'abort') {
        const turn = turns.get(sessionID);
        if (turn) {
          turn.aborted = true;
          turn.fireAbort();
        }
        return json(response, 200, true);
      }
    }
    if (method === 'POST' && (segments[0] === 'permission' || segments[0] === 'question') && segments[1] && (segments[2] === 'reply' || segments[2] === 'reject')) {
      const waiter = waiters.get(segments[1]);
      if (!waiter) return json(response, 404, { name: 'NotFoundError', data: { message: `no pending request ${segments[1]}` } });
      waiters.delete(segments[1]);
      const input = await body(request);
      waiter.resolve(segments[2] === 'reject' ? { rejected: true } : isRecord(input) ? input : {});
      return json(response, 200, true);
    }
    return json(response, 404, { name: 'NotFoundError', data: { message: `${method} ${url.pathname}` } });
  };

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (!response.headersSent) json(response, 500, { name: 'UnknownError', data: { message: String(error) } });
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => resolve());
  });
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  if (password === '') process.stdout.write('Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\n');
  process.stdout.write(`opencode server listening on http://${hostname}:${bound}\n`);
  const stop = (code: number): void => {
    for (const client of clients) client.end();
    server.close();
    void saveStore(env, store).then(() => process.exit(code));
  };
  process.on('SIGTERM', () => stop(143));
  process.on('SIGINT', () => stop(130));
  void readFile;
  void randomUUID;
  return null;
}
