import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { LineSplitter } from '../../../core/stream-json.ts';
import type { AgentProcess, ProcessExit } from '../agent-process.ts';
import { type BridgeCommon, type JsonRecord, contentBlocks, controlError, controlSuccess, isRecord, mapAnswers, num, str } from '../bridge-common.ts';

/** How long `opencode serve` may take to print its listening line (ms). */
export const OPENCODE_START_TIMEOUT_MS = 30_000;

/**
 * D62: the permission rules a Switchboard OpenCode server starts with (merged
 * into `OPENCODE_CONFIG_CONTENT`): edits run, shell commands, web fetches and
 * paths outside the project ask (Claude Code's `acceptEdits`, D6's fallback).
 */
export const OPENCODE_PERMISSIONS = { edit: 'allow', bash: 'ask', webfetch: 'ask', external_directory: 'ask' } as const;

/** OpenCode's tool names → Claude Code's (the recorder's rules read those). */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  patch: 'Edit',
  multiedit: 'MultiEdit',
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  list: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  task: 'Agent',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
};

/** OpenCode's permission names → the tool the Inbox names. */
const PERMISSION_TOOLS: Readonly<Record<string, string>> = { bash: 'Bash', edit: 'Edit', webfetch: 'WebFetch', external_directory: 'Read', read: 'Read', task: 'Agent' };

/** A tool's input in Claude Code's field names (`filePath` → `file_path`, …). */
export function opencodeToolInput(tool: string, input: JsonRecord): JsonRecord {
  const out: JsonRecord = { ...input };
  if (typeof input['filePath'] === 'string') {
    out['file_path'] = input['filePath'];
    delete out['filePath'];
  }
  if (tool === 'task') {
    return { description: str(input['description']) ?? 'subagent', prompt: str(input['prompt']) ?? '', subagent_type: str(input['subagent_type']) ?? 'opencode' };
  }
  return out;
}

/** A free loopback port (bound and released; the server binds it right after). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** `OPENCODE_CONFIG_CONTENT` with Switchboard's permission rules over any the environment already has. */
export function configContent(existing: string | undefined): string {
  let base: JsonRecord = {};
  try {
    const parsed: unknown = existing ? JSON.parse(existing) : {};
    if (isRecord(parsed)) base = parsed;
  } catch {
    base = {};
  }
  const permission = isRecord(base['permission']) ? base['permission'] : {};
  return JSON.stringify({ ...base, permission: { ...permission, ...OPENCODE_PERMISSIONS } });
}

/**
 * D62 · OpenCode behind the stream-json seam (`docs/providers.md` → *Design*).
 *
 * Spawns `opencode serve --hostname 127.0.0.1 --port <free port>` in the
 * session's cwd with a random `OPENCODE_SERVER_PASSWORD` (HTTP Basic; VERIFIED
 * `packages/opencode/src/server/auth.ts` at v1.18.34), waits for its listening
 * line, subscribes to `GET /event` (SSE) and translates:
 * - stdin stream-json → HTTP: a user message → `POST /session/:id/prompt_async`
 *   (text + `file` parts with `data:` URLs); `interrupt` → `POST …/abort`;
 *   `initialize` → `GET /config/providers` (the reply's `models[]`, variants as
 *   effort levels); `set_model` / `apply_flag_settings` → the next prompt's
 *   `model` / `variant`; a `can_use_tool` reply → `POST /permission/:id/reply`
 *   / `POST /question/:id/reply` (or `/reject`);
 * - SSE events → stream-json stdout: `system/init` + the replay when a prompt
 *   starts, `assistant` text / thinking / `tool_use` from `message.part.updated`,
 *   `tool_result`s, `can_use_tool` for `permission.asked` / `question.asked`, a
 *   usage-only `assistant` line from a completed assistant message (D49),
 *   `result` on `session.status` idle (an abort as `aborted_streaming`, D50).
 * The server never exits on stdin EOF, so EOF ends it with SIGTERM once the
 * running prompt is over.
 */
export class OpenCodeBridge implements AgentProcess {
  readonly #options: BridgeCommon;
  readonly #password = randomBytes(24).toString('hex');
  #child: ChildProcess | null = null;
  readonly #exited: Promise<ProcessExit>;
  #resolveExit: (exit: ProcessExit) => void = () => undefined;
  #stderr = '';
  #ended = false;
  #inputClosed = false;
  #base: string | null = null;
  #sessionId: string | null = null;
  readonly #ready: Promise<boolean>;
  readonly #events = new AbortController();
  readonly #queue: JsonRecord[] = [];
  #turn: Turn | null = null;
  /** `provider/model`, `null` = OpenCode's default. */
  #model: string | null;
  #variant: string | null;
  #version = 'opencode';
  /** Context windows by `provider/model` (`limit.context`). */
  readonly #windows = new Map<string, number>();
  readonly #requests = new Map<string, OpenRequest>();
  /** Message ids of user messages (their parts are the prompt's echo, never shown again). */
  readonly #userMessages = new Set<string>();
  /** Parts already shown (a text part is shown once it has ended; a reasoning part once). */
  readonly #shownParts = new Set<string>();
  /** Tool calls: started (`tool_use` shown) and finished (`tool_result` shown). */
  readonly #tools = new Map<string, { finished: boolean }>();
  /** Assistant messages whose usage was shown. */
  readonly #usageShown = new Set<string>();
  /** A subagent's child session → its `task` call id (`parent_tool_use_id` of its lines). */
  readonly #children = new Map<string, string>();

  constructor(options: BridgeCommon) {
    this.#options = options;
    this.#model = options.model;
    this.#variant = options.effort;
    this.#exited = new Promise<ProcessExit>((resolve) => {
      this.#resolveExit = resolve;
    });
    if (!options.command[0]) throw new Error('empty CLI command');
    this.#ready = this.#start();
  }

  get pid(): number | null {
    return this.#child?.pid ?? null;
  }

  get running(): boolean {
    return !this.#ended;
  }

  get inputClosed(): boolean {
    return this.#inputClosed;
  }

  get exited(): Promise<ProcessExit> {
    return this.#exited;
  }

  stderrTail(): string {
    return this.#stderr;
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this.#ended || !this.#child) return false;
    return this.#child.kill(signal);
  }

  async waitForExit(ms: number): Promise<boolean> {
    if (this.#ended) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const ended = await Promise.race([this.#exited.then(() => true as const), timeout]);
    clearTimeout(timer);
    return ended;
  }

  endInput(): void {
    if (this.#inputClosed) return;
    this.#inputClosed = true;
    this.#queue.length = 0;
    this.#stopWhenIdle();
  }

  write(line: object): boolean {
    if (this.#inputClosed || this.#ended) return false;
    const message = line as JsonRecord;
    switch (message['type']) {
      case 'user':
        this.#queue.push(message);
        void this.#pump();
        return true;
      case 'control_request':
        void this.#control(str(message['request_id']) ?? '', isRecord(message['request']) ? message['request'] : {});
        return true;
      case 'control_response':
        void this.#answer(isRecord(message['response']) ? message['response'] : {});
        return true;
      default:
        return true;
    }
  }

  #note(text: string): void {
    this.#stderr = `${this.#stderr}${text}\n`.slice(-8_192);
  }

  #emit(line: JsonRecord): void {
    this.#options.onLine(JSON.stringify(line));
  }

  // ── the server ────────────────────────────────────────────────────────────

  async #start(): Promise<boolean> {
    let port: number;
    try {
      port = await freePort();
    } catch (error) {
      this.#settle({ code: null, signal: null, spawnError: error instanceof Error ? error : new Error(String(error)) });
      return false;
    }
    const [cmd, ...prefix] = this.#options.command as [string, ...string[]];
    const env: NodeJS.ProcessEnv = {
      ...this.#options.env,
      OPENCODE_SERVER_PASSWORD: this.#password,
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_CONFIG_CONTENT: configContent(this.#options.env['OPENCODE_CONFIG_CONTENT']),
    };
    const child = spawn(cmd, [...prefix, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: this.#options.cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.#child = child;
    let listening: (url: string) => void = () => undefined;
    const url = new Promise<string>((resolve) => {
      listening = resolve;
    });
    const splitter = new LineSplitter((line) => {
      // VERIFIED (serve.ts): "opencode server listening on http://<host>:<port>"; the SDK reads it the same way.
      const found = /opencode server listening on (https?:\/\/\S+)/.exec(line);
      if (found?.[1]) listening(found[1]);
      else this.#note(line);
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => splitter.push(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-8_192);
    });
    child.once('error', (error: Error) => {
      if (child.pid === undefined) setImmediate(() => this.#settle({ code: null, signal: null, spawnError: error }));
    });
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => this.#settle({ code, signal, spawnError: null }));
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      url,
      this.#exited.then(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), OPENCODE_START_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!outcome) {
      if (!this.#ended) {
        this.#note(`Switchboard: opencode serve did not report its address within ${OPENCODE_START_TIMEOUT_MS / 1000} s`);
        child.kill('SIGTERM');
      }
      return false;
    }
    this.#base = outcome.replace(/\/$/, '');
    try {
      await this.#subscribe();
      try {
        const health = await this.#http('GET', '/global/health');
        const version = isRecord(health) ? str(health['version']) : null;
        if (version) this.#version = `opencode ${version}`;
      } catch {
        // The version is cosmetic (`system/init`'s CLI version).
      }
      await this.#openSession();
      void this.#pump();
      return true;
    } catch (error) {
      this.#note(`Switchboard: OpenCode did not start: ${error instanceof Error ? error.message : String(error)}`);
      child.kill('SIGTERM');
      return false;
    }
  }

  #settle(exit: ProcessExit): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#inputClosed = true;
    this.#events.abort();
    this.#resolveExit(exit);
  }

  #url(path: string): string {
    const separator = path.includes('?') ? '&' : '?';
    return `${this.#base}${path}${separator}directory=${encodeURIComponent(this.#options.cwd)}`;
  }

  #headers(json: boolean): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(`opencode:${this.#password}`).toString('base64')}`,
      'x-opencode-directory': encodeURIComponent(this.#options.cwd),
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  }

  async #http(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(this.#url(path), { method, headers: this.#headers(body !== undefined), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      const message = isRecord(parsed) && isRecord(parsed['data']) ? str(parsed['data']['message']) : typeof parsed === 'string' ? parsed : null;
      throw new HttpError(response.status, message ?? `HTTP ${response.status}`);
    }
    return parsed;
  }

  /** `GET /event` (SSE: `data: {type, properties}` frames); resolves once `server.connected` came. */
  async #subscribe(): Promise<void> {
    const response = await fetch(this.#url('/event'), { headers: { ...this.#headers(false), accept: 'text/event-stream' }, signal: this.#events.signal });
    if (!response.ok || !response.body) throw new Error(`the event stream answered HTTP ${response.status}`);
    let connected: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut = buffer.indexOf('\n\n');
          while (cut >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (data !== '') {
              try {
                const event: unknown = JSON.parse(data);
                if (isRecord(event)) {
                  if (event['type'] === 'server.connected') connected();
                  this.#event(str(event['type']) ?? '', isRecord(event['properties']) ? event['properties'] : {});
                }
              } catch (error) {
                this.#note(`Switchboard: an OpenCode event could not be read: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
            cut = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // Aborted (the process ended) or cut.
      }
      connected();
      // Cut while the server lives: subscribe again (ASSUMED D62-opencode-sse).
      if (!this.#ended && !this.#events.signal.aborted) void this.#resubscribe();
    })();
    await ready;
  }

  /**
   * The event stream was cut while the server lives: subscribe again (up to 5
   * tries, 1 s apart); a prompt that ended meanwhile (`GET /session/status` no
   * longer says busy) ends here with what was seen of it.
   */
  async #resubscribe(): Promise<void> {
    for (let attempt = 1; attempt <= 5 && !this.#ended; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (this.#ended) return;
      try {
        await this.#subscribe();
        const turn = this.#turn;
        if (turn?.posted && this.#sessionId) {
          const statuses = await this.#http('GET', '/session/status');
          const entry = isRecord(statuses) ? statuses[this.#sessionId] : null;
          const status = isRecord(entry) ? str(entry['type']) : null;
          if (status !== 'busy' && status !== 'retry') this.#finish(turn);
        }
        return;
      } catch (error) {
        this.#note(`Switchboard: OpenCode's event stream could not reconnect (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async #openSession(): Promise<void> {
    if (this.#options.nativeId) {
      try {
        const found = await this.#http('GET', `/session/${encodeURIComponent(this.#options.nativeId)}`);
        if (isRecord(found) && str(found['id'])) {
          this.#sessionId = str(found['id']);
          return;
        }
      } catch (error) {
        this.#options.onNotice?.(`OpenCode could not reopen its session ${this.#options.nativeId} (${error instanceof Error ? error.message : String(error)}); a new session started`);
      }
    }
    const created = await this.#http('POST', '/session', { title: this.#options.title });
    const id = isRecord(created) ? str(created['id']) : null;
    if (!id) throw new Error('OpenCode reported no session id');
    this.#sessionId = id;
    this.#options.onNativeId?.(id);
  }

  #stopWhenIdle(): void {
    if (this.#turn || this.#ended) return;
    this.#child?.kill('SIGTERM');
  }

  // ── prompts ───────────────────────────────────────────────────────────────

  async #pump(): Promise<void> {
    if (this.#turn || this.#queue.length === 0 || this.#ended) return;
    if (!(await this.#ready) || !this.#sessionId) return;
    if (this.#turn || this.#queue.length === 0) return;
    const message = this.#queue.shift() as JsonRecord;
    const turn: Turn = { startedAt: Date.now(), text: null, error: null, aborted: false, posted: false, busy: false, done: false, model: this.#model };
    this.#turn = turn;
    const body = isRecord(message['message']) ? message['message'] : {};
    this.#emit({ type: 'system', subtype: 'init', session_id: this.#sessionId, cwd: this.#options.cwd, model: this.#model ?? 'default', permissionMode: this.#options.permissionMode, tools: [], claude_code_version: this.#version });
    this.#emit({ type: 'user', message: body, isReplay: true, session_id: this.#sessionId });
    const { text, images, pdfs } = contentBlocks(body['content']);
    const parts: JsonRecord[] = [];
    if (text !== '') parts.push({ type: 'text', text });
    images.forEach((url, index) => parts.push({ type: 'file', mime: /^data:([^;]+);/.exec(url)?.[1] ?? 'image/png', url, filename: `image-${index + 1}` }));
    for (const pdf of pdfs) parts.push({ type: 'file', mime: 'application/pdf', url: pdf.url, filename: pdf.name ?? 'document.pdf' });
    const [providerID, ...rest] = (this.#model ?? '').split('/');
    const model = this.#model && providerID && rest.length > 0 ? { providerID, modelID: rest.join('/') } : null;
    try {
      await this.#http('POST', `/session/${encodeURIComponent(this.#sessionId)}/prompt_async`, { parts, ...(model ? { model } : {}), ...(this.#variant ? { variant: this.#variant } : {}) });
      turn.posted = true;
    } catch (error) {
      turn.error = error instanceof Error ? error.message : String(error);
      this.#finish(turn);
    }
  }

  #finish(turn: Turn): void {
    if (turn.done) return;
    turn.done = true;
    for (const [requestId, open] of this.#requests) {
      if (open.turn === turn) {
        this.#requests.delete(requestId);
        this.#emit({ type: 'control_cancel_request', request_id: requestId });
      }
    }
    const durationMs = Date.now() - turn.startedAt;
    const window = turn.model ? this.#windows.get(turn.model) : undefined;
    const modelUsage = window ? { [turn.model ?? 'default']: { contextWindow: window } } : {};
    if (turn.aborted) {
      this.#emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', errors: [], num_turns: 1, duration_ms: durationMs, modelUsage, session_id: this.#sessionId });
    } else if (turn.error) {
      this.#emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'error', errors: [`OpenCode: ${turn.error}`], num_turns: 1, duration_ms: durationMs, modelUsage, session_id: this.#sessionId });
    } else {
      this.#emit({ type: 'result', subtype: 'success', is_error: false, result: turn.text ?? '', num_turns: 1, duration_ms: durationMs, modelUsage, session_id: this.#sessionId });
    }
    if (this.#turn === turn) this.#turn = null;
    if (this.#inputClosed) this.#stopWhenIdle();
    else void this.#pump();
  }

  // ── stdin control requests ────────────────────────────────────────────────

  async #control(requestId: string, request: JsonRecord): Promise<void> {
    const subtype = str(request['subtype']) ?? '';
    switch (subtype) {
      case 'initialize': {
        const started = await this.#ready;
        let models: JsonRecord[] | null = null;
        if (started) {
          try {
            models = this.#models(await this.#http('GET', '/config/providers'));
          } catch {
            models = null;
          }
        }
        this.#emit(controlSuccess(requestId, { ...(models ? { models } : {}), remote_control_available: false, provider: 'opencode' }));
        return;
      }
      case 'interrupt': {
        if (request['cancel_queued'] === true) this.#queue.length = 0;
        const turn = this.#turn;
        if (!turn || !this.#sessionId) {
          this.#emit(controlSuccess(requestId, { still_queued: [], cancelled: [] }));
          return;
        }
        turn.aborted = true;
        try {
          await this.#http('POST', `/session/${encodeURIComponent(this.#sessionId)}/abort`);
          this.#emit(controlSuccess(requestId, { still_queued: [], cancelled: [] }));
          // A prompt that never reached the server has nothing to abort: it ends here.
          if (!turn.posted) this.#finish(turn);
        } catch (error) {
          this.#emit(controlError(requestId, error instanceof Error ? error.message : String(error)));
        }
        return;
      }
      case 'set_model': {
        const model = str(request['model']);
        this.#model = model && model !== 'default' ? model : null;
        this.#emit(controlSuccess(requestId, {}));
        return;
      }
      case 'apply_flag_settings': {
        const settings = isRecord(request['settings']) ? request['settings'] : {};
        if ('effortLevel' in settings) this.#variant = str(settings['effortLevel']);
        this.#emit(controlSuccess(requestId, {}));
        return;
      }
      case 'set_permission_mode':
        this.#emit(controlSuccess(requestId, {}));
        return;
      default:
        this.#emit(controlError(requestId, `"${subtype}" is not available in OpenCode`));
    }
  }

  /** `GET /config/providers` as an `initialize` reply's `models[]` (`provider/model`, variants as effort levels). */
  #models(answer: unknown): JsonRecord[] | null {
    const out = opencodeModels(answer);
    if (!out) return null;
    for (const [key, window] of out.windows) this.#windows.set(key, window);
    return out.models;
  }

  async #answer(response: JsonRecord): Promise<void> {
    const requestId = str(response['request_id']) ?? '';
    const open = this.#requests.get(requestId);
    if (!open) return;
    this.#requests.delete(requestId);
    const decision = response['subtype'] === 'success' && isRecord(response['response']) ? response['response'] : null;
    const allowed = decision?.['behavior'] === 'allow';
    try {
      if (open.kind === 'question') {
        if (!allowed) {
          await this.#http('POST', `/question/${encodeURIComponent(open.id)}/reject`);
          return;
        }
        const updated = isRecord(decision?.['updatedInput']) ? (decision['updatedInput'] as JsonRecord) : {};
        const byId = mapAnswers(open.questions, isRecord(updated['answers']) ? updated['answers'] : {});
        await this.#http('POST', `/question/${encodeURIComponent(open.id)}/reply`, { answers: open.questions.map((question) => byId[question.id] ?? []) });
        return;
      }
      const always = Array.isArray(decision?.['updatedPermissions']) && (decision['updatedPermissions'] as unknown[]).length > 0;
      const message = !allowed ? str(decision?.['message']) : null;
      await this.#http('POST', `/permission/${encodeURIComponent(open.id)}/reply`, { reply: allowed ? (always ? 'always' : 'once') : 'reject', ...(message ? { message } : {}) });
    } catch (error) {
      this.#note(`Switchboard: OpenCode did not take the answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── events → stream-json ──────────────────────────────────────────────────

  /** `null` = the session's own line, a call id = a subagent's (its `parent_tool_use_id`), `undefined` = not ours. */
  #parentOf(sessionID: string | null): string | null | undefined {
    if (!sessionID || sessionID === this.#sessionId) return sessionID ? null : undefined;
    // A child session whose `task` call is not known yet ('') is not shown.
    return this.#children.get(sessionID) || undefined;
  }

  #assistant(blocks: JsonRecord[], parent: string | null, messageId: string, usage?: JsonRecord): void {
    this.#emit({ type: 'assistant', message: { id: messageId, model: this.#model ?? 'default', role: 'assistant', content: blocks, ...(usage ? { usage } : {}) }, parent_tool_use_id: parent, session_id: this.#sessionId });
  }

  #event(type: string, properties: JsonRecord): void {
    const turn = this.#turn;
    switch (type) {
      case 'session.created': {
        const info = isRecord(properties['info']) ? properties['info'] : {};
        // A subagent's child session: mapped once its `task` call names it (state.metadata.sessionId).
        if (str(info['parentID']) === this.#sessionId && str(info['id'])) this.#children.set(str(info['id']) as string, this.#children.get(str(info['id']) as string) ?? '');
        return;
      }
      case 'message.updated': {
        const info = isRecord(properties['info']) ? properties['info'] : {};
        const parent = this.#parentOf(str(info['sessionID']) ?? str(properties['sessionID']));
        if (parent === undefined) return;
        const id = str(info['id']) ?? '';
        if (info['role'] === 'user') {
          this.#userMessages.add(id);
          return;
        }
        const time = isRecord(info['time']) ? info['time'] : {};
        if (parent === null && turn) {
          const provider = str(info['providerID']);
          const model = str(info['modelID']);
          if (provider && model) turn.model = `${provider}/${model}`;
          const error = isRecord(info['error']) ? info['error'] : null;
          if (error && str(error['name']) !== 'MessageAbortedError') turn.error = str(isRecord(error['data']) ? error['data']['message'] : null) ?? str(error['name']) ?? 'the prompt failed';
        }
        if (num(time['completed']) !== null && isRecord(info['tokens']) && parent === null && !this.#usageShown.has(id)) {
          this.#usageShown.add(id);
          const tokens = info['tokens'];
          const cache = isRecord(tokens['cache']) ? tokens['cache'] : {};
          this.#assistant([], null, id, {
            input_tokens: num(tokens['input']) ?? 0,
            cache_read_input_tokens: num(cache['read']) ?? 0,
            cache_creation_input_tokens: num(cache['write']) ?? 0,
            output_tokens: num(tokens['output']) ?? 0,
          });
        }
        return;
      }
      case 'message.part.updated': {
        const part = isRecord(properties['part']) ? properties['part'] : {};
        const parent = this.#parentOf(str(part['sessionID']) ?? str(properties['sessionID']));
        if (parent === undefined) return;
        if (this.#userMessages.has(str(part['messageID']) ?? '')) return;
        this.#part(part, parent);
        return;
      }
      case 'permission.asked': {
        const parent = this.#parentOf(str(properties['sessionID']));
        if (parent === undefined) return;
        const id = str(properties['id']) ?? '';
        const permission = str(properties['permission']) ?? 'tool';
        const patterns = Array.isArray(properties['patterns']) ? properties['patterns'].filter((value): value is string => typeof value === 'string') : [];
        const metadata = isRecord(properties['metadata']) ? properties['metadata'] : {};
        const tool = isRecord(properties['tool']) ? properties['tool'] : {};
        const always = Array.isArray(properties['always']) ? properties['always'] : [];
        const requestId = `opencode-${id}`;
        this.#requests.set(requestId, { id, kind: 'permission', questions: [], turn });
        this.#emit({
          type: 'control_request',
          request_id: requestId,
          request: {
            subtype: 'can_use_tool',
            tool_name: PERMISSION_TOOLS[permission] ?? permission,
            input: { ...opencodeToolInput(permission, metadata), ...(patterns.length > 0 ? { patterns } : {}) },
            tool_use_id: str(tool['callID']),
            description: patterns.join(', ') || null,
            switchboard_always: [{ type: 'opencode', reply: 'always', patterns: always }],
          },
        });
        return;
      }
      case 'question.asked': {
        const parent = this.#parentOf(str(properties['sessionID']));
        if (parent === undefined) return;
        const id = str(properties['id']) ?? '';
        const raw = Array.isArray(properties['questions']) ? properties['questions'].filter(isRecord) : [];
        const questions = raw.map((question, index) => ({ id: String(index), text: str(question['question']) ?? '' }));
        const requestId = `opencode-${id}`;
        const tool = isRecord(properties['tool']) ? properties['tool'] : {};
        this.#requests.set(requestId, { id, kind: 'question', questions, turn });
        this.#emit({
          type: 'control_request',
          request_id: requestId,
          request: {
            subtype: 'can_use_tool',
            tool_name: 'AskUserQuestion',
            input: {
              questions: raw.map((question) => ({
                question: str(question['question']) ?? '',
                header: str(question['header']) ?? '',
                options: Array.isArray(question['options']) ? question['options'].filter(isRecord).map((option) => ({ label: str(option['label']) ?? '', description: str(option['description']) ?? '' })) : [],
                multiSelect: question['multiple'] === true,
              })),
            },
            tool_use_id: str(tool['callID']),
          },
        });
        return;
      }
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected': {
        // Answered elsewhere (OpenCode's own UI): withdrawn here.
        const requestId = `opencode-${str(properties['requestID']) ?? str(properties['id']) ?? ''}`;
        if (this.#requests.delete(requestId)) this.#emit({ type: 'control_cancel_request', request_id: requestId });
        return;
      }
      case 'session.status': {
        if (str(properties['sessionID']) !== this.#sessionId || !turn) return;
        const status = isRecord(properties['status']) ? str(properties['status']['type']) : null;
        if (status === 'busy') turn.busy = true;
        if (status === 'idle' && turn.posted) this.#finish(turn);
        return;
      }
      case 'session.idle':
        if (str(properties['sessionID']) === this.#sessionId && turn?.posted) this.#finish(turn);
        return;
      case 'session.error': {
        if (str(properties['sessionID']) !== this.#sessionId || !turn) return;
        const error = isRecord(properties['error']) ? properties['error'] : {};
        if (str(error['name']) === 'MessageAbortedError') turn.aborted = true;
        else turn.error = str(isRecord(error['data']) ? error['data']['message'] : null) ?? str(error['name']) ?? 'the prompt failed';
        return;
      }
      default:
        return;
    }
  }

  #part(part: JsonRecord, parent: string | null): void {
    const id = str(part['id']) ?? '';
    const messageId = str(part['messageID']) ?? id;
    switch (part['type']) {
      case 'text': {
        const time = isRecord(part['time']) ? part['time'] : {};
        const text = str(part['text']) ?? '';
        if (num(time['end']) === null || text.trim() === '' || part['synthetic'] === true || this.#shownParts.has(id)) return;
        this.#shownParts.add(id);
        if (parent === null && this.#turn) this.#turn.text = text;
        this.#assistant([{ type: 'text', text }], parent, messageId);
        return;
      }
      case 'reasoning':
        if (this.#shownParts.has(id)) return;
        this.#shownParts.add(id);
        this.#assistant([{ type: 'thinking', thinking: '' }], parent, messageId);
        return;
      case 'compaction':
        if (parent === null && !this.#shownParts.has(id)) {
          this.#shownParts.add(id);
          this.#emit({ type: 'system', subtype: 'compact_boundary', session_id: this.#sessionId, compact_metadata: { trigger: part['auto'] === false ? 'manual' : 'auto', pre_tokens: null } });
        }
        return;
      case 'tool': {
        const callID = str(part['callID']) ?? id;
        const tool = str(part['tool']) ?? 'tool';
        const state = isRecord(part['state']) ? part['state'] : {};
        const status = str(state['status']);
        const input = isRecord(state['input']) ? state['input'] : {};
        if (tool === 'task') {
          const metadata = isRecord(state['metadata']) ? state['metadata'] : {};
          const child = str(metadata['sessionId']);
          if (child) this.#children.set(child, callID);
        }
        let entry = this.#tools.get(callID);
        if (!entry && (status === 'running' || status === 'completed' || status === 'error')) {
          entry = { finished: false };
          this.#tools.set(callID, entry);
          const name = TOOL_NAMES[tool] ?? (tool.includes('_') ? `mcp__${tool.replace('_', '__')}` : tool);
          this.#assistant([{ type: 'tool_use', id: callID, name, input: opencodeToolInput(tool, input) }], parent, messageId);
        }
        if (entry && !entry.finished && (status === 'completed' || status === 'error')) {
          entry.finished = true;
          const text = status === 'completed' ? (str(state['output']) ?? '') : (str(state['error']) ?? 'The tool failed.');
          this.#emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callID, content: text, is_error: status === 'error' }] }, parent_tool_use_id: parent, session_id: this.#sessionId });
        }
        return;
      }
      default:
        return;
    }
  }
}

class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Turn {
  readonly startedAt: number;
  text: string | null;
  error: string | null;
  aborted: boolean;
  /** `prompt_async` answered (the server took the prompt). */
  posted: boolean;
  busy: boolean;
  done: boolean;
  /** `provider/model` the reply came from (its context window). */
  model: string | null;
}

interface OpenRequest {
  readonly id: string;
  readonly kind: 'permission' | 'question';
  readonly questions: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  readonly turn: Turn | null;
}

/**
 * `GET /config/providers` (`{providers: [{id, name, models: {<id>: {name, limit,
 * variants}}}], default: {<provider>: <model>}}`) as an `initialize` reply's
 * `models[]`: `Default` first, then `provider/model` with the model's variants
 * as effort levels; and each model's context window.
 */
export function opencodeModels(answer: unknown): { readonly models: JsonRecord[]; readonly windows: Map<string, number> } | null {
  if (!isRecord(answer) || !Array.isArray(answer['providers'])) return null;
  const windows = new Map<string, number>();
  const models: JsonRecord[] = [];
  for (const provider of answer['providers'].filter(isRecord)) {
    const providerId = str(provider['id']);
    if (!providerId || !isRecord(provider['models'])) continue;
    for (const [modelId, model] of Object.entries(provider['models'])) {
      if (!isRecord(model)) continue;
      const value = `${providerId}/${modelId}`;
      const limit = isRecord(model['limit']) ? num(model['limit']['context']) : null;
      if (limit) windows.set(value, limit);
      models.push({
        value,
        displayName: `${str(provider['name']) ?? providerId} · ${str(model['name']) ?? modelId}`,
        supportedEffortLevels: isRecord(model['variants']) ? Object.keys(model['variants']) : [],
      });
    }
  }
  if (models.length === 0) return null;
  const defaults = isRecord(answer['default']) ? answer['default'] : {};
  const [first] = Object.entries(defaults);
  const fallback = first ? `${first[0]}/${String(first[1])}` : null;
  const fallbackModel = models.find((model) => model['value'] === fallback);
  return {
    models: [{ value: 'default', displayName: 'Default', description: `OpenCode's default (${fallbackModel ? String(fallbackModel['displayName']) : 'its own'})`, supportedEffortLevels: fallbackModel ? fallbackModel['supportedEffortLevels'] : [] }, ...models],
    windows,
  };
}

/**
 * D62: Settings → CLIs' model list without a session: `opencode models` prints
 * `provider/model` lines (VERIFIED `packages/opencode/src/cli/cmd/models.ts`);
 * no effort levels (those come with a session's `initialize`).
 */
export async function listOpencodeModels(command: readonly string[], env: NodeJS.ProcessEnv, cwd: string, run: (command: readonly string[], args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number | null; stdout: string }>): Promise<JsonRecord[] | null> {
  const result = await run(command, ['models'], { cwd, env, timeoutMs: 20_000 });
  if (result.code !== 0) return null;
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[^\s/]+\/\S+$/.test(line));
  if (lines.length === 0) return null;
  return [{ value: 'default', displayName: 'Default', description: "OpenCode's default model" }, ...lines.map((line) => ({ value: line, displayName: line }))];
}
