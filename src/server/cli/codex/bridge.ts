import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { LineSplitter } from '../../../core/stream-json.ts';
import type { AgentProcess, ProcessExit } from '../agent-process.ts';
import { type BridgeCommon, type JsonRecord, type ProviderUsage, contentBlocks, controlError, controlSuccess, isRecord, mapAnswers, num, str, toolInputFor } from '../bridge-common.ts';

/**
 * D62 · Codex CLI behind the stream-json seam (`docs/providers.md` → *Design*).
 *
 * Spawns `codex app-server` (newline-delimited JSON-RPC over stdio without the
 * `jsonrpc` field; VERIFIED `codex-rs/app-server-transport/src/transport/stdio.rs`
 * and `app-server-protocol/src/rpc.rs` at rust-v0.159.3) in the session's cwd and
 * translates:
 * - stdin stream-json → JSON-RPC: a user message → `turn/start`; `interrupt` →
 *   `turn/interrupt`; `initialize` → `model/list` (the reply's `models[]`);
 *   `set_model` / `apply_flag_settings` → the next turn's `model` / `effort`;
 *   a `can_use_tool` reply → the approval's / question's JSON-RPC response;
 * - Codex notifications and server requests → stream-json stdout lines:
 *   `system/init` + the replay when a turn starts, `assistant` text / thinking /
 *   `tool_use` blocks from `item/*`, `user` `tool_result`s, `can_use_tool`
 *   control requests for approvals and `requestUserInput`, a usage-only
 *   `assistant` line from `thread/tokenUsage/updated` (D49), `result` from
 *   `turn/completed` (an interrupted turn as `aborted_streaming`, D50).
 * A message written while a turn runs waits in the bridge (D44's clock shows) and
 * starts when the turn ends; a Stop with `cancel_queued` drops them.
 */
export class CodexBridge implements AgentProcess {
  readonly #options: BridgeCommon;
  readonly #child: ChildProcess;
  readonly #exited: Promise<ProcessExit>;
  #stderr = '';
  #ended = false;
  #inputClosed = false;
  #stdinClosed = false;
  #nextId = 1;
  readonly #pending = new Map<number, { readonly resolve: (result: JsonRecord) => void; readonly reject: (error: Error) => void }>();
  #threadId: string | null = null;
  readonly #ready: Promise<boolean>;
  /** Messages written and not started yet (in order). */
  readonly #queue: JsonRecord[] = [];
  #turn: Turn | null = null;
  #model: string | null;
  #effort: string | null;
  #version: string;
  /** Open approvals / questions by the `request_id` Switchboard sees. */
  readonly #requests = new Map<string, OpenRequest>();
  /** File changes by item id (an approval names the item, not the path). */
  readonly #fileItems = new Map<string, readonly string[]>();
  /** A collab subagent's thread → its `spawnAgent` item id (the subagent's lines carry it as `parent_tool_use_id`). */
  readonly #childThreads = new Map<string, string>();
  #window: number | null = null;
  #usageCount = 0;

  constructor(options: BridgeCommon) {
    this.#options = options;
    this.#model = options.model;
    this.#effort = options.effort;
    this.#version = 'codex-cli';
    const [cmd, ...prefix] = options.command;
    if (!cmd) throw new Error('empty CLI command');
    const child = spawn(cmd, [...prefix, 'app-server'], { cwd: options.cwd, env: options.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#child = child;
    const splitter = new LineSplitter((line) => this.#fromServer(line));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => splitter.push(chunk));
    child.stdout?.on('end', () => splitter.flush());
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-8_192);
    });
    child.stdin?.on('error', () => undefined);
    this.#exited = new Promise<ProcessExit>((resolve) => {
      let settled = false;
      const settle = (exit: ProcessExit): void => {
        if (settled) return;
        settled = true;
        splitter.flush();
        this.#ended = true;
        this.#inputClosed = true;
        for (const pending of this.#pending.values()) pending.reject(new Error('codex app-server ended'));
        this.#pending.clear();
        resolve(exit);
      };
      child.once('error', (error: Error) => {
        if (child.pid === undefined) setImmediate(() => settle({ code: null, signal: null, spawnError: error }));
      });
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => settle({ code, signal, spawnError: null }));
    });
    this.#ready = this.#start();
  }

  get pid(): number | null {
    return this.#child.pid ?? null;
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
    if (this.#ended) return false;
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

  /** EOF: nothing new starts; the running turn finishes, then the app-server's stdin closes (it exits). */
  endInput(): void {
    if (this.#inputClosed) return;
    this.#inputClosed = true;
    this.#queue.length = 0;
    void this.#closeWhenIdle();
  }

  /** One stream-json stdin object (`docs/providers.md` → *What a bridge reads*). */
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
        this.#answer(isRecord(message['response']) ? message['response'] : {});
        return true;
      default:
        return true;
    }
  }

  // ── JSON-RPC ──────────────────────────────────────────────────────────────

  #send(message: JsonRecord): void {
    if (this.#stdinClosed || !this.#child.stdin || this.#child.stdin.destroyed) return;
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #request(method: string, params: JsonRecord): Promise<JsonRecord> {
    const id = this.#nextId++;
    return new Promise<JsonRecord>((resolve, reject) => {
      if (this.#ended) {
        reject(new Error('codex app-server ended'));
        return;
      }
      this.#pending.set(id, { resolve, reject });
      this.#send({ id, method, params });
    });
  }

  #emit(line: JsonRecord): void {
    this.#options.onLine(JSON.stringify(line));
  }

  #fromServer(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#stderr = `${this.#stderr}${line}\n`.slice(-8_192);
      return;
    }
    if (!isRecord(message)) return;
    const method = str(message['method']);
    const id = message['id'];
    if (method && (typeof id === 'number' || typeof id === 'string')) {
      this.#serverRequest(id, method, isRecord(message['params']) ? message['params'] : {});
    } else if (method) {
      this.#notification(method, isRecord(message['params']) ? message['params'] : {});
    } else if (typeof id === 'number' && this.#pending.has(id)) {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      if (isRecord(message['error'])) pending?.reject(new Error(str(message['error']['message']) ?? 'codex app-server error'));
      else pending?.resolve(isRecord(message['result']) ? message['result'] : {});
    }
  }

  // ── start ─────────────────────────────────────────────────────────────────

  async #start(): Promise<boolean> {
    try {
      const init = await this.#request('initialize', {
        clientInfo: { name: 'switchboard', title: 'Switchboard', version: this.#options.clientVersion ?? '0' },
        // ASSUMED D62-codex-experimental: `item/tool/requestUserInput` (questions) is an experimental request.
        capabilities: { experimentalApi: true },
      });
      const agent = str(init['userAgent']);
      const version = agent ? /\/(\d[^\s(]*)/.exec(agent)?.[1] : undefined;
      this.#version = version ? `codex-cli ${version}` : 'codex-cli';
      this.#send({ method: 'initialized' });
      const overrides: JsonRecord = {
        cwd: this.#options.cwd,
        // D6 equivalent: edits and commands inside the workspace run; leaving the sandbox asks (Codex's "Auto").
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        ...(this.#model ? { model: this.#model } : {}),
      };
      let threadId: string | null = null;
      if (this.#options.nativeId) {
        try {
          const resumed = await this.#request('thread/resume', { threadId: this.#options.nativeId, ...overrides });
          threadId = str(isRecord(resumed['thread']) ? resumed['thread']['id'] : null) ?? this.#options.nativeId;
        } catch (error) {
          this.#options.onNotice?.(`Codex could not reopen its thread ${this.#options.nativeId} (${error instanceof Error ? error.message : String(error)}); a new thread started`);
        }
      }
      if (!threadId) {
        const started = await this.#request('thread/start', overrides);
        threadId = str(isRecord(started['thread']) ? started['thread']['id'] : null);
      }
      if (!threadId) throw new Error('codex app-server reported no thread id');
      this.#threadId = threadId;
      if (threadId !== this.#options.nativeId) this.#options.onNativeId?.(threadId);
      void this.#readLimits();
      void this.#pump();
      return true;
    } catch (error) {
      this.#stderr = `${this.#stderr}Switchboard: Codex did not start: ${error instanceof Error ? error.message : String(error)}\n`.slice(-8_192);
      this.#child.kill('SIGTERM');
      return false;
    }
  }

  /** D62 P7: the account's rate limits at start (the usage footer's Codex rows). */
  async #readLimits(): Promise<void> {
    try {
      const read = await this.#request('account/rateLimits/read', {});
      if (isRecord(read['rateLimits'])) this.#limits(read['rateLimits']);
    } catch {
      // An account without limits (an API key) has none to show.
    }
  }

  #limits(snapshot: JsonRecord): void {
    const window = (value: unknown): ProviderUsage['windows'][number] | null => {
      if (!isRecord(value)) return null;
      const pct = num(value['usedPercent']);
      if (pct === null) return null;
      const minutes = num(value['windowDurationMins']);
      const resets = num(value['resetsAt']);
      return { pct, minutes, resetsAt: resets === null ? null : new Date(resets * 1000).toISOString() };
    };
    const windows = [window(snapshot['primary']), window(snapshot['secondary'])].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    this.#options.onUsage?.({ provider: 'codex', windows, at: new Date().toISOString() });
  }

  // ── turns ─────────────────────────────────────────────────────────────────

  async #pump(): Promise<void> {
    if (this.#turn || this.#queue.length === 0 || this.#ended) return;
    if (!(await this.#ready) || !this.#threadId) return;
    if (this.#turn || this.#queue.length === 0) return;
    const message = this.#queue.shift() as JsonRecord;
    const turn: Turn = { id: null, startedAt: Date.now(), text: null, error: null, interrupted: false, idWaiters: [], done: false };
    this.#turn = turn;
    const body = isRecord(message['message']) ? message['message'] : {};
    // A turn starts: `system/init` and the replay of the message it took up (D44: its clock clears).
    this.#emit({
      type: 'system',
      subtype: 'init',
      session_id: this.#threadId,
      cwd: this.#options.cwd,
      model: this.#model ?? 'default',
      permissionMode: this.#options.permissionMode,
      tools: [],
      claude_code_version: this.#version,
    });
    this.#emit({ type: 'user', message: body, isReplay: true, session_id: this.#threadId });
    const { text, images, dropped } = contentBlocks(body['content']);
    const input: JsonRecord[] = [];
    const note = dropped > 0 ? `\n\n[Switchboard: ${dropped} attachment${dropped === 1 ? '' : 's'} not sent: Codex CLI takes images only]` : '';
    if (text || note) input.push({ type: 'text', text: `${text}${note}`, text_elements: [] });
    for (const image of images) input.push({ type: 'image', url: image });
    try {
      const started = await this.#request('turn/start', {
        threadId: this.#threadId,
        input,
        ...(this.#model ? { model: this.#model } : {}),
        ...(this.#effort ? { effort: this.#effort } : {}),
      });
      const id = str(isRecord(started['turn']) ? started['turn']['id'] : null);
      if (id && !turn.id) this.#turnId(turn, id);
    } catch (error) {
      turn.error = error instanceof Error ? error.message : String(error);
      this.#finish(turn, 'failed');
    }
  }

  #turnId(turn: Turn, id: string): void {
    turn.id = id;
    for (const waiter of turn.idWaiters.splice(0)) waiter(id);
  }

  #finish(turn: Turn, status: string): void {
    if (turn.done) return;
    turn.done = true;
    for (const [requestId, open] of this.#requests) {
      // The CLI's withdrawn requests: never answered (M0.2).
      if (open.turn === turn) {
        this.#requests.delete(requestId);
        this.#emit({ type: 'control_cancel_request', request_id: requestId });
      }
    }
    const durationMs = Date.now() - turn.startedAt;
    const model = this.#model ?? 'default';
    const modelUsage = this.#window ? { [model]: { contextWindow: this.#window } } : {};
    if (status === 'interrupted' || turn.interrupted) {
      this.#emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', errors: [], num_turns: 1, duration_ms: durationMs, modelUsage, session_id: this.#threadId });
    } else if (status === 'failed' || turn.error) {
      this.#emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'error',
        errors: [`Codex: ${turn.error ?? 'the turn failed'}`],
        num_turns: 1,
        duration_ms: durationMs,
        modelUsage,
        session_id: this.#threadId,
      });
    } else {
      this.#emit({ type: 'result', subtype: 'success', is_error: false, result: turn.text ?? '', num_turns: 1, duration_ms: durationMs, modelUsage, session_id: this.#threadId });
    }
    if (this.#turn === turn) this.#turn = null;
    if (this.#inputClosed) void this.#closeWhenIdle();
    else void this.#pump();
  }

  async #closeWhenIdle(): Promise<void> {
    if (this.#turn || this.#stdinClosed) return;
    this.#stdinClosed = true;
    this.#child.stdin?.end();
  }

  // ── stdin control requests ────────────────────────────────────────────────

  async #control(requestId: string, request: JsonRecord): Promise<void> {
    const subtype = str(request['subtype']) ?? '';
    switch (subtype) {
      case 'initialize': {
        await this.#ready;
        let models: JsonRecord[] | null = null;
        try {
          models = codexModels(await this.#request('model/list', {}));
        } catch {
          models = null;
        }
        this.#emit(controlSuccess(requestId, { ...(models ? { models } : {}), remote_control_available: false, provider: 'codex' }));
        return;
      }
      case 'interrupt': {
        if (request['cancel_queued'] === true) this.#queue.length = 0;
        const turn = this.#turn;
        if (!turn) {
          this.#emit(controlSuccess(requestId, { still_queued: [], cancelled: [] }));
          return;
        }
        turn.interrupted = true;
        const id = turn.id ?? (await new Promise<string>((resolve) => turn.idWaiters.push(resolve)));
        try {
          await this.#request('turn/interrupt', { threadId: this.#threadId, turnId: id });
          this.#emit(controlSuccess(requestId, { still_queued: [], cancelled: [] }));
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
        if ('effortLevel' in settings) this.#effort = str(settings['effortLevel']);
        this.#emit(controlSuccess(requestId, {}));
        return;
      }
      case 'set_permission_mode':
        // D6's fallback has no Codex equivalent: the approval policy is fixed at thread start.
        this.#emit(controlSuccess(requestId, {}));
        return;
      default:
        this.#emit(controlError(requestId, `"${subtype}" is not available in Codex CLI`));
    }
  }

  /** A `can_use_tool` reply → the waiting JSON-RPC request's response. */
  #answer(response: JsonRecord): void {
    const requestId = str(response['request_id']) ?? '';
    const open = this.#requests.get(requestId);
    if (!open) return;
    this.#requests.delete(requestId);
    const decision = response['subtype'] === 'success' && isRecord(response['response']) ? response['response'] : null;
    const allowed = decision?.['behavior'] === 'allow';
    if (open.kind === 'question') {
      const updated = isRecord(decision?.['updatedInput']) ? (decision['updatedInput'] as JsonRecord) : {};
      const answers = allowed ? mapAnswers(open.questions, isRecord(updated['answers']) ? updated['answers'] : {}) : {};
      const wire: JsonRecord = {};
      for (const [questionId, labels] of Object.entries(answers)) wire[questionId] = { answers: labels };
      this.#send({ id: open.rpcId, result: { answers: wire } });
      return;
    }
    const always = Array.isArray(decision?.['updatedPermissions']) && (decision['updatedPermissions'] as unknown[]).length > 0;
    this.#send({ id: open.rpcId, result: { decision: allowed ? (always ? 'acceptForSession' : 'accept') : 'decline' } });
  }

  // ── Codex → stream-json ───────────────────────────────────────────────────

  #parentOf(threadId: string | null): string | null | undefined {
    if (!threadId || threadId === this.#threadId) return null;
    return this.#childThreads.get(threadId);
  }

  #notification(method: string, params: JsonRecord): void {
    const parent = this.#parentOf(str(params['threadId']));
    if (parent === undefined && method !== 'account/rateLimits/updated') return;
    const turn = this.#turn;
    switch (method) {
      case 'turn/started': {
        const id = str(isRecord(params['turn']) ? params['turn']['id'] : null);
        if (parent === null && turn && id && !turn.id) this.#turnId(turn, id);
        return;
      }
      case 'item/started':
        if (isRecord(params['item'])) this.#itemStarted(params['item'], parent ?? null);
        return;
      case 'item/completed':
        if (isRecord(params['item'])) this.#itemCompleted(params['item'], parent ?? null);
        return;
      case 'thread/tokenUsage/updated': {
        if (parent !== null) return;
        const usage = isRecord(params['tokenUsage']) ? params['tokenUsage'] : {};
        const window = num(usage['modelContextWindow']);
        if (window !== null && window > 0) this.#window = window;
        const last = isRecord(usage['last']) ? usage['last'] : null;
        if (!last) return;
        const input = num(last['inputTokens']) ?? 0;
        const cached = num(last['cachedInputTokens']) ?? 0;
        // D49: OpenAI's input tokens include the cached ones (ASSUMED D62-codex-context): context = inputTokens.
        this.#emit({
          type: 'assistant',
          message: {
            id: `codex-usage-${++this.#usageCount}`,
            model: this.#model ?? 'default',
            role: 'assistant',
            content: [],
            usage: { input_tokens: Math.max(0, input - cached), cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: num(last['outputTokens']) ?? 0 },
          },
          parent_tool_use_id: null,
          session_id: this.#threadId,
        });
        return;
      }
      case 'turn/completed': {
        if (parent !== null || !turn) return;
        const done = isRecord(params['turn']) ? params['turn'] : {};
        const status = str(done['status']) ?? 'completed';
        if (status === 'failed' && !turn.error) turn.error = str(isRecord(done['error']) ? done['error']['message'] : null) ?? 'the turn failed';
        this.#finish(turn, status);
        return;
      }
      case 'error': {
        if (parent !== null || !turn || params['willRetry'] === true) return;
        turn.error = str(isRecord(params['error']) ? params['error']['message'] : null) ?? turn.error;
        return;
      }
      case 'account/rateLimits/updated':
        if (isRecord(params['rateLimits'])) this.#limits(params['rateLimits']);
        return;
      case 'serverRequest/resolved': {
        // Codex resolved a request itself (a turn interrupt): it is withdrawn.
        const rpcId = params['requestId'];
        for (const [requestId, open] of this.#requests) {
          if (open.rpcId === rpcId) {
            this.#requests.delete(requestId);
            this.#emit({ type: 'control_cancel_request', request_id: requestId });
          }
        }
        return;
      }
      default:
        return;
    }
  }

  #assistant(blocks: JsonRecord[], parent: string | null, messageId: string): void {
    this.#emit({ type: 'assistant', message: { id: messageId, model: this.#model ?? 'default', role: 'assistant', content: blocks }, parent_tool_use_id: parent, session_id: this.#threadId });
  }

  #toolResult(toolUseId: string, text: string, isError: boolean, parent: string | null): void {
    this.#emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }] }, parent_tool_use_id: parent, session_id: this.#threadId });
  }

  #itemStarted(item: JsonRecord, parent: string | null): void {
    const id = str(item['id']) ?? randomUUID();
    switch (item['type']) {
      case 'reasoning':
        this.#assistant([{ type: 'thinking', thinking: '' }], parent, id);
        return;
      case 'commandExecution':
        this.#assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: str(item['command']) ?? '', ...(str(item['cwd']) ? { cwd: str(item['cwd']) } : {}) } }], parent, id);
        return;
      case 'fileChange': {
        const changes = Array.isArray(item['changes']) ? item['changes'].filter(isRecord) : [];
        this.#fileItems.set(id, changes.map((change) => str(change['path']) ?? ''));
        changes.forEach((change, index) => {
          const kind = isRecord(change['kind']) ? str(change['kind']['type']) : str(change['kind']);
          const name = kind === 'add' ? 'Write' : kind === 'delete' ? 'Delete' : 'Edit';
          this.#assistant([{ type: 'tool_use', id: changes.length === 1 ? id : `${id}#${index}`, name, input: toolInputFor(name, { file_path: str(change['path']) ?? '', diff: str(change['diff']) ?? '' }) }], parent, `${id}#${index}`);
        });
        return;
      }
      case 'mcpToolCall':
        this.#assistant([{ type: 'tool_use', id, name: `mcp__${str(item['server']) ?? 'server'}__${str(item['tool']) ?? 'tool'}`, input: isRecord(item['arguments']) ? item['arguments'] : {} }], parent, id);
        return;
      case 'webSearch':
        this.#assistant([{ type: 'tool_use', id, name: 'WebSearch', input: { query: str(item['query']) ?? '' } }], parent, id);
        return;
      case 'collabAgentToolCall': {
        if (str(item['tool']) !== 'spawnAgent') return;
        const prompt = str(item['prompt']) ?? '';
        const receivers = Array.isArray(item['receiverThreadIds']) ? item['receiverThreadIds'].filter((value): value is string => typeof value === 'string') : [];
        for (const thread of receivers) this.#childThreads.set(thread, id);
        // A Codex subagent shows as an Agent call (D21: one agent per Agent tool call).
        this.#assistant([{ type: 'tool_use', id, name: 'Agent', input: { description: prompt.split('\n')[0]?.slice(0, 80) ?? 'subagent', prompt, subagent_type: 'codex' } }], parent, id);
        return;
      }
      case 'contextCompaction':
        if (parent === null) this.#emit({ type: 'system', subtype: 'compact_boundary', session_id: this.#threadId, compact_metadata: { trigger: 'auto', pre_tokens: null } });
        return;
      default:
        return;
    }
  }

  #itemCompleted(item: JsonRecord, parent: string | null): void {
    const id = str(item['id']) ?? '';
    const status = str(item['status']);
    const failed = status === 'failed' || status === 'declined';
    switch (item['type']) {
      case 'agentMessage': {
        const text = str(item['text']) ?? '';
        if (text.trim() === '') return;
        if (parent === null && this.#turn) this.#turn.text = text;
        this.#assistant([{ type: 'text', text }], parent, id);
        return;
      }
      case 'commandExecution': {
        const output = str(item['aggregatedOutput']) ?? '';
        const code = num(item['exitCode']);
        const text = status === 'declined' ? 'The command was declined.' : `${output}${code !== null && code !== 0 ? `\nExit code ${code}` : ''}`;
        this.#toolResult(id, text, failed || (code !== null && code !== 0), parent);
        return;
      }
      case 'fileChange': {
        const paths = this.#fileItems.get(id) ?? (Array.isArray(item['changes']) ? item['changes'].filter(isRecord).map((change) => str(change['path']) ?? '') : []);
        this.#fileItems.delete(id);
        paths.forEach((path, index) => this.#toolResult(paths.length === 1 ? id : `${id}#${index}`, failed ? `The change to ${path} was ${status}.` : `Updated ${path}`, failed, parent));
        return;
      }
      case 'mcpToolCall': {
        const error = item['error'];
        const result = item['result'];
        const text = error ? (isRecord(error) ? (str(error['message']) ?? JSON.stringify(error)) : String(error)) : typeof result === 'string' ? result : JSON.stringify(result ?? null);
        this.#toolResult(id, text, Boolean(error) || failed, parent);
        return;
      }
      case 'webSearch':
        this.#toolResult(id, 'Searched the web.', failed, parent);
        return;
      case 'collabAgentToolCall': {
        if (str(item['tool']) !== 'spawnAgent') return;
        const states = isRecord(item['agentsStates']) ? item['agentsStates'] : {};
        const messages = Object.values(states)
          .map((state) => (isRecord(state) ? str(state['message']) : null))
          .filter((message): message is string => message !== null);
        this.#toolResult(id, messages.join('\n\n') || 'The subagent finished.', failed, parent);
        return;
      }
      default:
        return;
    }
  }

  #serverRequest(rpcId: number | string, method: string, params: JsonRecord): void {
    const turn = this.#turn;
    const itemId = str(params['itemId']);
    const requestId = `codex-${String(rpcId)}`;
    const always = [{ type: 'codex', decision: 'acceptForSession' }];
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const input = { command: str(params['command']) ?? '', ...(str(params['cwd']) ? { cwd: str(params['cwd']) } : {}), ...(str(params['reason']) ? { reason: str(params['reason']) } : {}) };
        this.#requests.set(requestId, { rpcId, kind: 'command', questions: [], turn });
        this.#emit({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', input, tool_use_id: itemId, description: str(params['reason']), switchboard_always: always } });
        return;
      }
      case 'item/fileChange/requestApproval': {
        const paths = itemId ? (this.#fileItems.get(itemId) ?? []) : [];
        const input = { file_path: paths[0] ?? '', ...(paths.length > 1 ? { files: paths } : {}), ...(str(params['reason']) ? { reason: str(params['reason']) } : {}) };
        this.#requests.set(requestId, { rpcId, kind: 'file', questions: [], turn });
        this.#emit({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Edit', input, tool_use_id: paths.length === 1 ? itemId : null, description: str(params['reason']), switchboard_always: always } });
        return;
      }
      case 'item/tool/requestUserInput': {
        const raw = Array.isArray(params['questions']) ? params['questions'].filter(isRecord) : [];
        const questions = raw.map((question) => ({ id: str(question['id']) ?? '', text: str(question['question']) ?? '' }));
        this.#requests.set(requestId, { rpcId, kind: 'question', questions, turn });
        // Codex's questions become an AskUserQuestion batch (M3.1's question cards).
        const input = {
          questions: raw.map((question) => ({
            question: str(question['question']) ?? '',
            header: str(question['header']) ?? '',
            options: Array.isArray(question['options']) ? question['options'].filter(isRecord).map((option) => ({ label: str(option['label']) ?? '', description: str(option['description']) ?? '' })) : [],
            multiSelect: false,
          })),
        };
        this.#emit({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: itemId } });
        return;
      }
      default:
        // Elicitations, dynamic tool calls, token refreshes: Switchboard has nothing to answer with.
        this.#send({ id: rpcId, error: { code: -32601, message: `Switchboard does not handle ${method}` } });
    }
  }
}

interface Turn {
  id: string | null;
  readonly startedAt: number;
  /** The last agent message (the result's text). */
  text: string | null;
  error: string | null;
  interrupted: boolean;
  readonly idWaiters: Array<(id: string) => void>;
  done: boolean;
}

interface OpenRequest {
  readonly rpcId: number | string;
  readonly kind: 'command' | 'file' | 'question';
  readonly questions: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  readonly turn: Turn | null;
}

/**
 * Codex's `model/list` as an `initialize` reply's `models[]` (`parseInitializeModels`):
 * `Default` first (no `model` sent), then each visible model with its reasoning
 * efforts as effort levels.
 */
export function codexModels(list: JsonRecord): JsonRecord[] | null {
  const data = Array.isArray(list['data']) ? list['data'].filter(isRecord) : [];
  const visible = data.filter((model) => model['hidden'] !== true);
  if (visible.length === 0) return null;
  const efforts = (model: JsonRecord): string[] =>
    Array.isArray(model['supportedReasoningEfforts']) ? model['supportedReasoningEfforts'].filter(isRecord).map((effort) => str(effort['reasoningEffort']) ?? '').filter((value) => value !== '') : [];
  const fallback = visible.find((model) => model['isDefault'] === true) ?? visible[0];
  const label = (model: JsonRecord): string => str(model['displayName']) ?? str(model['model']) ?? str(model['id']) ?? '';
  return [
    { value: 'default', displayName: 'Default', description: `Codex's default (${fallback ? label(fallback) : 'its own'})`, supportedEffortLevels: fallback ? efforts(fallback) : [] },
    ...visible.map((model) => ({
      value: str(model['model']) ?? str(model['id']) ?? '',
      displayName: label(model),
      ...(str(model['description']) ? { description: str(model['description']) } : {}),
      supportedEffortLevels: efforts(model),
    })),
  ];
}

/**
 * D62: Settings → CLIs' model list without a session: a short-lived
 * `codex app-server` that only does `initialize` + `model/list` (no thread, no
 * model call), killed after 20 s at most.
 */
export async function listCodexModels(command: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<JsonRecord[] | null> {
  const [cmd, ...prefix] = command;
  if (!cmd) return null;
  const child = spawn(cmd, [...prefix, 'app-server'], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  child.stdin?.on('error', () => undefined);
  try {
    return await new Promise<JsonRecord[] | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 20_000);
      child.once('error', () => resolve(null));
      child.once('close', () => resolve(null));
      const splitter = new LineSplitter((line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!isRecord(message)) return;
        if (message['id'] === 1) {
          child.stdin?.write(`${JSON.stringify({ method: 'initialized' })}\n${JSON.stringify({ id: 2, method: 'model/list', params: {} })}\n`);
        } else if (message['id'] === 2) {
          clearTimeout(timer);
          resolve(isRecord(message['result']) ? codexModels(message['result']) : null);
        }
      });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => splitter.push(chunk));
      child.stdin?.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'switchboard', title: 'Switchboard', version: '0' } } })}\n`);
    });
  } finally {
    child.stdin?.end();
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}
