import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { CLI_VERSION, type RunArgs } from './args.ts';
import { type Fixture, type FixtureStore, type Step, requestOf } from './fixtures.ts';
import { type Json, type JsonObject, asArray, asObject, asString, clone, isObject } from './json.ts';
import type { Logger } from './log.ts';
import { IdMap, type RewriteContext, rewriteLine, sortReplacements } from './rewrite.ts';
import {
  BUILT_IN_SCENARIOS,
  DEFAULT_FIXTURE,
  FIRE_PROMPT,
  KEEP_RECORDED_PERMISSION_MODE,
  SIBLINGS,
  WRITE_CONTENT,
  applyMaxTurns,
  fireToken,
  formatAnswers,
  messageText,
  reportedPermissionMode,
  resolveInside,
  sayToken,
  scenarioToken,
  toolResultText,
  toolToken,
  writeToken, autoModeSupported } from './scenarios.ts';
import { remoteHistory, remoteHistoryEntries, reportsInitAtStart, teleportInto } from './teleport.ts';
import { LiveFile, ResumeError, Transcript, gitBranchOf, slugForCwd, templatesFrom } from './transcript.ts';

/** How a turn playback ended. */
type Outcome = 'done' | 'sigint' | 'crash';

/** What unblocks a playback that waits (an open request or a recorded interrupt point). */
type WaitEvent =
  | { kind: 'response'; response: JsonObject }
  | { kind: 'interrupt'; requestId: string }
  | { kind: 'sigint' }
  | { kind: 'eof' };

interface Waiter {
  readonly requestId: string | null;
  readonly acceptsEof: boolean;
  resolve(event: WaitEvent): void;
}

/** A `can_use_tool` request the host has not answered yet. */
interface OpenRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Json;
}

/** A queued stdin user message (or, with `fired`, a turn the fake runs on its own: `[fake:fire]`). */
interface UserMessage {
  content: Json;
  text: string;
  uuid: string;
  fired?: boolean;
}

/** A `[fake:tool]` call in progress. */
interface ToolSpec {
  name: string;
  input: JsonObject;
}

/** A `[fake:write]` in progress. */
interface WriteSpec {
  target: string;
  existed: boolean;
  original: string | null;
}

/** Steps the runner plays: fixture steps plus a tool_result built from the host's decision. */
type PlayStep = Step | { readonly t: 'decided'; readonly line: JsonObject; readonly payload: JsonObject };

interface TurnState {
  readonly msg: UserMessage;
  readonly scenario: string;
  readonly turnIndex: number;
  readonly ids: IdMap;
  readonly extra: Array<readonly [string, string]>;
  readonly write: WriteSpec | null;
  readonly tool: ToolSpec | null;
  /** `[fake:say]`: the reply text that replaces the recorded one. */
  readonly say: string | null;
  open: OpenRequest | null;
}

/** Everything a {@link Runner} needs from its process. */
export interface RunnerOptions {
  args: RunArgs;
  env: NodeJS.ProcessEnv;
  /** Canonical cwd (`realpath`). */
  cwd: string;
  store: FixtureStore;
  log: Logger | null;
  stdin: NodeJS.ReadableStream;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  /** Flushes stdout/stderr and ends the process with `code`. */
  exit(code: number): Promise<void>;
}

/** Recorded fixtures every run needs synchronously (loaded once at start). */
interface Core {
  base: Fixture;
  interrupt: Fixture;
  askInterrupt: Fixture;
  permDeny: Fixture;
  permNoflag: Fixture;
  preamble: Fixture;
  maxTurns: Fixture | null;
}

function firstStep<T extends Step['t']>(steps: readonly Step[], t: T): Extract<Step, { t: T }> | undefined {
  return steps.find((s): s is Extract<Step, { t: T }> => s.t === t);
}

function stepsAfterWait(steps: readonly Step[]): readonly Step[] {
  const at = steps.findIndex((s) => s.t === 'wait');
  return at < 0 ? [] : steps.slice(at + 1);
}

function isDenyAnswer(line: JsonObject): boolean {
  const content = asArray(asObject(line['message'])?.['content']);
  return content.some((b) => isObject(b) && b['type'] === 'tool_result' && b['is_error'] === true);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * One fake `claude -p` process: replays the M0 fixtures with the stream-json
 * protocol recorded in `docs/spike-m0.md` (turns per stdin message, blocking
 * `can_use_tool` requests, interrupts, SIGINT, EOF, control requests) and
 * writes the transcript + live-process file under `CLAUDE_CONFIG_DIR`.
 */
export class Runner {
  private readonly o: RunnerOptions;
  private readonly args: RunArgs;
  private readonly stdio: boolean;
  private readonly configDir: string | null;
  private readonly sessionId: string;
  private permissionMode: string;
  private core!: Core;
  private transcript: Transcript | null = null;
  private live: LiveFile | null = null;
  private scenario: string;
  private turnIndex = 0;
  private resultIndex = 0;
  private turnsCompleted = 0;
  private lastResultIsError = false;
  private lastResultText: string | null = null;
  private lastResultErrors: string[] = [];
  private readonly queue: UserMessage[] = [];
  private running = false;
  private eof = false;
  private finished = false;
  private waiter: Waiter | null = null;
  private pendingInterrupt: string | null = null;
  private pendingSigint = false;
  private readonly unmatchedResponses = new Map<string, JsonObject>();
  private inbox: Promise<void> = Promise.resolve();
  private ctxCache: { count: number; pairs: Array<readonly [string, string]> } = { count: -1, pairs: [] };
  private readonly keepAlive: NodeJS.Timeout;
  /** The next `[fake:fire]` turn. */
  private fireTimer: NodeJS.Timeout | null = null;

  constructor(options: RunnerOptions) {
    this.o = options;
    this.args = options.args;
    this.stdio = this.args.permissionPromptTool === 'stdio' && this.args.inputFormat === 'stream-json';
    const rawConfig = options.env['CLAUDE_CONFIG_DIR'];
    this.configDir = rawConfig && rawConfig.trim() !== '' ? path.resolve(rawConfig) : null;
    this.sessionId = this.args.resume !== null && !this.args.forkSession ? this.args.resume : (this.args.sessionId ?? randomUUID());
    this.permissionMode = this.args.permissionMode ?? 'default';
    this.scenario = options.env['FAKE_CLAUDE_SCENARIO']?.trim() || 'default';
    // A waiting playback (hang, a tool "still running") must outlive stdin EOF.
    this.keepAlive = setInterval(() => undefined, 1 << 30);
  }

  private isScenario(name: string): boolean {
    return BUILT_IN_SCENARIOS.includes(name) || this.o.store.hasScenario(name);
  }

  /** Starts the run; the process ends through {@link RunnerOptions.exit}. */
  async start(): Promise<void> {
    if (!this.isScenario(this.scenario)) return this.fail(`fake-claude: unknown scenario "${this.scenario}" (FAKE_CLAUDE_SCENARIO)`);
    const { store } = this.o;
    const resuming = this.args.resume !== null;
    // D25: `--teleport <id>` checks the cwd, "fetches" the session and checks out its branch before anything is printed.
    let teleportedBranch: string | null = null;
    if (this.args.teleport !== null) {
      const result = await teleportInto(this.o.cwd, this.args.teleport, this.o.env);
      if (!result.ok) return this.fail(result.refusal.text, result.refusal.code);
      teleportedBranch = result.branch;
    }
    this.core = {
      base: await store.fixture(DEFAULT_FIXTURE),
      interrupt: await store.fixture('interrupt'),
      askInterrupt: await store.fixture('ask-interrupt'),
      permDeny: await store.fixture('perm-deny'),
      permNoflag: await store.fixture('perm-noflag'),
      preamble: await store.fixture(resuming ? 'handoff-reattach' : DEFAULT_FIXTURE),
      maxTurns: this.args.maxTurns !== null ? await store.fixture('max-turns') : null,
    };

    if (this.configDir === null) {
      if (resuming) return this.fail('fake-claude: --resume needs CLAUDE_CONFIG_DIR (the fake never reads ~/.claude)');
      this.o.writeStderr('fake-claude: CLAUDE_CONFIG_DIR is not set; no transcript or live-process file is written\n');
    } else {
      try {
        this.transcript = await Transcript.open({
          configDir: this.configDir,
          cwd: this.o.cwd,
          sessionId: this.sessionId,
          resumeFrom: this.args.resume,
          name: this.args.name,
          gitBranch: await gitBranchOf(this.o.cwd),
          version: CLI_VERSION,
          templates: templatesFrom(await store.transcript('tx-main'), await store.transcript('handoff-mid')),
          now: () => new Date().toISOString(),
        });
      } catch (error) {
        if (error instanceof ResumeError) return this.fail(`${error.message}\n`);
        throw error;
      }
      // D25: the remote history is the local copy's start, in its transcript before anything is reported.
      if (teleportedBranch !== null) {
        this.transcript.seed(remoteHistoryEntries(remoteHistory(teleportedBranch)));
        await this.transcript.flush();
      }
      this.live = new LiveFile(this.configDir, {
        pid: process.pid,
        sessionId: this.sessionId,
        cwd: this.o.cwd,
        startedAt: Date.now(),
        version: CLI_VERSION,
        status: 'idle',
        name: this.args.name ?? path.basename(this.o.cwd),
      });
    }

    process.on('SIGINT', () => this.onSigint());
    process.once('SIGTERM', () => {
      void (async () => {
        await this.live?.remove();
        process.kill(process.pid, 'SIGTERM');
      })();
    });

    const ids = new IdMap();
    for (const line of this.core.preamble.preamble) this.emit(line, this.bareTurn(ids));
    if (teleportedBranch !== null && reportsInitAtStart(this.o.env)) {
      // D25: a teleport reports its local session (`system/init`, a fresh id) at once, before any message (`no-init`: with its first turn).
      const init = (this.core.base.turns[0] ?? []).find((step) => step.t === 'line' && step.line['type'] === 'system' && step.line['subtype'] === 'init');
      if (init && init.t === 'line') this.emit(init.line, this.bareTurn(ids));
    }

    if (this.args.inputFormat === 'stream-json') {
      if (this.args.prompt !== null) this.enqueue(this.args.prompt);
      const lines = createInterface({ input: this.o.stdin, crlfDelay: Infinity });
      lines.on('line', (raw) => {
        this.inbox = this.inbox.then(() => this.onStdinLine(raw)).catch((error: unknown) => this.crashOn(error));
      });
      lines.on('close', () => {
        this.inbox = this.inbox.then(() => this.onEof()).catch((error: unknown) => this.crashOn(error));
      });
      return;
    }

    let prompt = this.args.prompt;
    if (prompt === null) {
      let text = '';
      this.o.stdin.setEncoding?.('utf8');
      for await (const chunk of this.o.stdin) text += String(chunk);
      prompt = text.replace(/\r?\n$/, '');
      if (prompt.trim() === '') {
        return this.fail('Error: Input must be provided either through stdin or as a prompt argument when using --print\n');
      }
    }
    this.eof = true;
    this.enqueue(prompt);
  }

  private enqueue(text: string, content: Json = text): void {
    this.queue.push({ content, text, uuid: randomUUID() });
    void this.pump();
  }

  // ---------------------------------------------------------------- stdin

  private async onStdinLine(raw: string): Promise<void> {
    await this.o.log?.stdin(raw);
    if (raw.trim() === '' || this.finished) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.o.writeStderr(`fake-claude: ignoring a stdin line that is not JSON: ${raw.slice(0, 80)}\n`);
      return;
    }
    if (!isObject(parsed)) return;
    const type = parsed['type'];
    if (type === 'user') {
      const content = asObject(parsed['message'])?.['content'] ?? '';
      this.enqueue(messageText(content), content);
    } else if (type === 'control_request') {
      await this.onControlRequest(parsed);
    } else if (type === 'control_response') {
      this.onControlResponse(parsed);
    }
  }

  private onEof(): void {
    this.eof = true;
    if (this.waiter?.acceptsEof) this.waiter.resolve({ kind: 'eof' });
    void this.pump();
  }

  private onSigint(): void {
    if (this.finished) return;
    if (this.waiter) {
      this.waiter.resolve({ kind: 'sigint' });
    } else if (this.running) {
      this.pendingSigint = true;
    } else {
      void this.finish(0);
    }
  }

  private onControlResponse(line: JsonObject): void {
    const response = asObject(line['response']);
    const requestId = asString(response?.['request_id']);
    if (!response || !requestId) return;
    if (this.waiter && this.waiter.requestId === requestId) this.waiter.resolve({ kind: 'response', response });
    else this.unmatchedResponses.set(requestId, response);
  }

  private async onControlRequest(line: JsonObject): Promise<void> {
    const requestId = String(line['request_id'] ?? '');
    const request = asObject(line['request']);
    const subtype = asString(request?.['subtype']) ?? '';
    switch (subtype) {
      case 'interrupt':
        if (this.waiter) this.waiter.resolve({ kind: 'interrupt', requestId });
        else if (this.running) this.pendingInterrupt = requestId;
        else this.writeAck(requestId);
        return;
      case 'get_usage':
        return this.replyFrom(requestId, this.turnsCompleted > 0 ? ['usage-turn', 'get_usage', -1] : ['usage-ctl', 'get_usage', 0]);
      case 'get_session_cost':
        return this.replyFrom(requestId, this.turnsCompleted > 0 ? ['usage-turn', 'get_session_cost', -1] : ['usage-ctl', 'get_session_cost', 0]);
      case 'initialize':
        return this.replyFrom(requestId, ['ctl-init', 'initialize', 0]);
      case 'set_permission_mode': {
        const mode = asString(request?.['mode']) ?? '';
        if (mode === 'auto' && !autoModeSupported()) return this.replyFrom(requestId, ['ctl-init', 'set_permission_mode', 0]);
        this.permissionMode = mode;
        this.writeJson({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { mode } } });
        return;
      }
      default:
        this.writeJson({
          type: 'control_response',
          response: { subtype: 'error', request_id: requestId, error: `Unsupported control request subtype: ${subtype}` },
        });
    }
  }

  /** Replies with the recorded `control_response` to the `nth` stdin request of `subtype` in `fixture` (-1 = last). */
  private async replyFrom(requestId: string, [fixtureName, subtype, nth]: [string, string, number]): Promise<void> {
    const fixture = await this.o.store.fixture(fixtureName);
    const requests = fixture.stdin.filter((l) => l['type'] === 'control_request' && requestOf(l)?.['subtype'] === subtype);
    const request = nth < 0 ? requests[requests.length + nth] : requests[nth];
    const recorded = fixture.stdout.find(
      (l) => l['type'] === 'control_response' && asObject(l['response'])?.['request_id'] === request?.['request_id'],
    );
    if (!recorded) throw new Error(`no recorded ${subtype} response in ${fixtureName}`);
    const line = rewriteLine(recorded, this.ctx([]), new IdMap());
    const response = asObject(line['response']);
    if (response) response['request_id'] = requestId;
    this.writeJson(line);
  }

  // ---------------------------------------------------------------- turns

  private async pump(): Promise<void> {
    if (this.running || this.finished) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.finished) {
        const msg = this.queue.shift() as UserMessage;
        let outcome = await this.runTurn(msg);
        if (this.pendingSigint) outcome = 'sigint';
        if (outcome === 'sigint') {
          this.running = false;
          await this.finish(0);
          return;
        }
        if (outcome === 'crash') {
          this.running = false;
          await this.crash('fake-claude: simulated crash (scenario "crash")');
          return;
        }
      }
    } catch (error) {
      this.running = false;
      await this.crashOn(error);
      return;
    }
    this.running = false;
    if (this.eof && !this.finished) await this.finish(this.lastResultIsError ? 1 : 0);
  }

  private async turnsOf(name: string): Promise<readonly (readonly Step[])[]> {
    const base = this.core.base.turns[0] ?? [];
    const firstAssistant = base.findIndex((s) => s.t === 'line' && s.line['type'] === 'assistant');
    const head = firstAssistant < 0 ? base : base.slice(0, firstAssistant);
    if (name === 'default') return [base];
    if (name === 'hang') return [[...head, { t: 'wait' }, ...stepsAfterWait(this.core.interrupt.turns[0] ?? [])]];
    if (name === 'crash') return [[...head, { t: 'crash' }]];
    return (await this.o.store.fixture(name)).turns;
  }

  private async runTurn(msg: UserMessage): Promise<Outcome> {
    const extra: Array<readonly [string, string]> = [];
    let steps: readonly Step[];
    let write: WriteSpec | null = null;
    let tool: ToolSpec | null = null;
    let scenario: string;
    let turnIndex: number;

    const writePath = msg.fired ? null : writeToken(msg.text);
    const toolCall = msg.fired || writePath !== null ? null : toolToken(msg.text);
    const fire = msg.fired ? null : fireToken(msg.text);
    const said = msg.fired || writePath !== null || toolCall !== null ? null : sayToken(msg.text);
    let say: string | null = null;
    if (msg.fired) {
      // A turn of its own (a cron firing): no stdin message, so no replay echo.
      steps = (this.core.base.turns[0] ?? []).filter((s) => s.t !== 'replay');
      scenario = DEFAULT_FIXTURE;
      turnIndex = 0;
    } else if (toolCall !== null && 'error' in toolCall) {
      await this.crash(`fake-claude: [fake:tool]: ${toolCall.error}`);
      return 'crash';
    } else if (toolCall !== null) {
      steps = (await this.o.store.fixture('tx-main')).turns[0] ?? [];
      tool = { name: toolCall.name, input: toolCall.input };
      scenario = 'tx-main';
      turnIndex = 0;
    } else if (writePath !== null) {
      const target = resolveInside(this.o.cwd, writePath);
      if (target === null) {
        await this.crash(`fake-claude: refusing [fake:write ${writePath}]: the path leaves the cwd`);
        return 'crash';
      }
      const txMain = await this.o.store.fixture('tx-main');
      const existed = await exists(target);
      write = { target, existed, original: existed ? await readFile(target, 'utf8') : null };
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, WRITE_CONTENT);
      extra.push([`${txMain.recordedCwd}/notes.txt`, target]);
      steps = txMain.turns[0] ?? [];
      scenario = 'tx-main';
      turnIndex = 0;
    } else if (said !== null && 'error' in said) {
      await this.crash(`fake-claude: [fake:say]: ${said.error}`);
      return 'crash';
    } else if (said !== null) {
      // The default turn ("OK") with the given reply text.
      steps = this.core.base.turns[0] ?? [];
      say = said.text;
      scenario = DEFAULT_FIXTURE;
      turnIndex = 0;
    } else {
      const token = scenarioToken(msg.text);
      if (token !== null) {
        if (!this.isScenario(token)) {
          await this.crash(`fake-claude: unknown scenario "${token}" ([fake:${token}] token)`);
          return 'crash';
        }
        this.scenario = token;
        this.turnIndex = 0;
      }
      scenario = this.scenario;
      turnIndex = this.turnIndex++;
      const turns = await this.turnsOf(scenario);
      steps = turns[turnIndex] ?? this.core.base.turns[0] ?? [];
    }

    if (!this.stdio && steps.some((s) => s.t === 'request')) {
      // Without --permission-prompt-tool stdio there is no host: the request is denied at once (M0.2 perm-noflag).
      steps = this.core.permNoflag.turns[0] ?? steps;
      scenario = 'perm-noflag';
    }
    if (this.args.maxTurns !== null && this.core.maxTurns) {
      const template = this.core.maxTurns.stdout.find((l) => l['type'] === 'result');
      if (template) steps = applyMaxTurns(steps, this.args.maxTurns, template);
    }

    const turn: TurnState = { msg, scenario, turnIndex, ids: new IdMap(), extra, write, tool, say, open: null };
    this.transcript?.beginTurn(msg.content, msg.uuid, this.permissionMode);
    this.live?.setStatus('busy');
    const outcome = await this.play(steps, turn);
    this.live?.setStatus('idle');
    if (fire && outcome === 'done') this.scheduleFires(fire.count, fire.everyMs);
    return outcome;
  }

  /** `[fake:fire n ms]`: `count` turns of the fake's own, one every `everyMs` (stops at EOF / exit). */
  private scheduleFires(count: number, everyMs: number): void {
    if (this.fireTimer) clearTimeout(this.fireTimer);
    let left = count;
    const tick = (): void => {
      this.fireTimer = null;
      if (this.finished || this.eof || left <= 0) return;
      left -= 1;
      this.queue.push({ content: FIRE_PROMPT, text: FIRE_PROMPT, uuid: randomUUID(), fired: true });
      void this.pump();
      if (left > 0) this.fireTimer = setTimeout(tick, everyMs);
    };
    if (left > 0) this.fireTimer = setTimeout(tick, everyMs);
  }

  private stopFires(): void {
    if (this.fireTimer) clearTimeout(this.fireTimer);
    this.fireTimer = null;
  }

  private async play(steps: readonly PlayStep[], turn: TurnState): Promise<Outcome> {
    for (let i = 0; i < steps.length; i++) {
      if (this.pendingInterrupt !== null || this.pendingSigint) return this.interruptNow(turn);
      const step = steps[i] as PlayStep;
      switch (step.t) {
        case 'line':
          this.emit(step.line, turn);
          break;
        case 'decided':
          this.emit(step.line, turn, (line) => this.applyDecision(line, step.payload, turn));
          break;
        case 'replay':
          if (this.args.replayUserMessages) this.writeReplay(turn.msg);
          break;
        case 'ack':
          break;
        case 'crash':
          return 'crash';
        case 'request': {
          const line = this.emit(step.line, turn);
          const request = line ? requestOf(line) : undefined;
          if (line && request) {
            turn.open = {
              requestId: String(line['request_id']),
              toolUseId: String(request['tool_use_id']),
              toolName: String(request['tool_name']),
              input: request['input'] ?? null,
            };
          }
          break;
        }
        case 'answer': {
          if (!turn.open) {
            this.emit(step.line, turn);
            break;
          }
          const event = await this.waitFor(turn.open.requestId, true);
          return this.afterRequest(event, turn, step.line, steps.slice(i + 1), null);
        }
        case 'wait': {
          const tail = steps.slice(i + 1);
          if (turn.open) {
            const event = await this.waitFor(turn.open.requestId, true);
            return this.afterRequest(event, turn, null, [], tail);
          }
          const event = await this.waitFor(null, false);
          if (event.kind === 'interrupt') {
            this.playTail(tail, turn, event.requestId);
            return 'done';
          }
          if (event.kind === 'sigint') {
            this.playTail(tail, turn, null);
            return 'sigint';
          }
          return 'done';
        }
      }
    }
    return 'done';
  }

  /** An interrupt or SIGINT that arrived while the turn had no wait point open: abort the streaming turn. */
  private interruptNow(turn: TurnState): Outcome {
    const requestId = this.pendingInterrupt;
    const sigint = this.pendingSigint;
    this.pendingInterrupt = null;
    this.pendingSigint = false;
    this.playTail(stepsAfterWait(this.core.interrupt.turns[0] ?? []), turn, sigint ? null : requestId);
    return sigint ? 'sigint' : 'done';
  }

  /** Emits an interrupt tail; `ackId` = the interrupt request to acknowledge (null for SIGINT / EOF: no ack). */
  private playTail(tail: readonly PlayStep[], turn: TurnState, ackId: string | null): void {
    let acked = ackId === null;
    if (ackId !== null && !tail.some((s) => s.t === 'ack')) {
      this.writeAck(ackId);
      acked = true;
    }
    for (const step of tail) {
      if (step.t === 'ack') {
        if (!acked && ackId !== null) this.writeAck(ackId);
        acked = true;
      } else if (step.t === 'line' || step.t === 'request' || step.t === 'answer') {
        this.emit(step.line, turn);
      }
    }
    turn.open = null;
  }

  private async afterRequest(
    event: WaitEvent,
    turn: TurnState,
    answer: JsonObject | null,
    rest: readonly PlayStep[],
    recordedTail: readonly PlayStep[] | null,
  ): Promise<Outcome> {
    const open = turn.open as OpenRequest;
    switch (event.kind) {
      case 'response': {
        const steps = await this.continuation(event.response, turn, answer, rest);
        const outcome = await this.play(steps, turn);
        turn.open = null;
        return outcome;
      }
      case 'interrupt':
      case 'sigint': {
        const tail = recordedTail ?? this.cancelTail(turn, open);
        this.playTail(tail, turn, event.kind === 'interrupt' ? event.requestId : null);
        return event.kind === 'sigint' ? 'sigint' : 'done';
      }
      case 'eof': {
        // stdin closed while the request was open: the CLI fails the request at once (M0.2 subagent-perm, first run).
        const template = this.aliasedAnswer(this.core.permDeny, turn, open);
        const payload: JsonObject = { behavior: 'deny', message: 'Tool permission request failed: AbortError: Stream closed' };
        const steps: PlayStep[] = [];
        if (template) steps.push({ t: 'decided', line: template, payload });
        steps.push(...this.completion());
        turn.open = null;
        return this.play(steps, turn);
      }
    }
  }

  /** The recorded answer line of `fixture`'s first request, with its ids aliased to the open request. */
  private aliasedAnswer(fixture: Fixture, turn: TurnState, open: OpenRequest, turnIndex = 0): JsonObject | null {
    const steps = fixture.turns[turnIndex] ?? fixture.turns[0] ?? [];
    const request = firstStep(steps, 'request');
    const answer = firstStep(steps, 'answer');
    if (!request || !answer) return null;
    const recorded = requestOf(request.line);
    turn.ids.alias(String(request.line['request_id']), open.requestId);
    turn.ids.alias(String(recorded?.['tool_use_id']), open.toolUseId);
    return answer.line;
  }

  /** The recorded cancel tail (`ask-interrupt`) aimed at the open request. */
  private cancelTail(turn: TurnState, open: OpenRequest): readonly Step[] {
    const steps = this.core.askInterrupt.turns[0] ?? [];
    const requestLine = firstStep(steps, 'request')?.line;
    if (requestLine) {
      turn.ids.alias(String(requestLine['request_id']), open.requestId);
      turn.ids.alias(String(requestOf(requestLine)?.['tool_use_id']), open.toolUseId);
    }
    const tail = stepsAfterWait(steps);
    return tail.map((step) => {
      if (step.t !== 'line' || step.line['type'] !== 'result') return step;
      const line = clone(step.line);
      line['permission_denials'] = asArray(line['permission_denials']).map((denial) =>
        isObject(denial) ? { ...denial, tool_name: open.toolName, tool_input: open.input } : denial,
      );
      return { t: 'line', line };
    });
  }

  /** The rest of the turn once the host answered: recorded, the sibling recording, or a neutral completion. */
  private async continuation(
    response: JsonObject,
    turn: TurnState,
    answer: JsonObject | null,
    rest: readonly PlayStep[],
  ): Promise<PlayStep[]> {
    const open = turn.open as OpenRequest;
    const payload = asObject(response['response']) ?? {};
    if (response['subtype'] === 'error') {
      payload['behavior'] = 'deny';
      payload['message'] = asString(response['error']) ?? 'Permission request failed';
    }
    const decision = payload['behavior'] === 'deny' ? 'deny' : 'allow';
    if (answer && (isDenyAnswer(answer) ? 'deny' : 'allow') === decision) {
      return [{ t: 'decided', line: answer, payload }, ...rest];
    }
    const siblingName = SIBLINGS[turn.scenario]?.[decision];
    if (siblingName) {
      const sibling = await this.o.store.fixture(siblingName);
      const siblingTurn = sibling.turns[turn.turnIndex] ?? sibling.turns[0] ?? [];
      const line = this.aliasedAnswer(sibling, turn, open, turn.turnIndex);
      const at = siblingTurn.findIndex((s) => s.t === 'answer');
      if (line && at >= 0) return [{ t: 'decided', line, payload }, ...siblingTurn.slice(at + 1)];
    }
    const template = answer ?? this.aliasedAnswer(this.core.permDeny, turn, open);
    return template ? [{ t: 'decided', line: template, payload }, ...this.completion()] : this.completion();
  }

  /** A neutral end of turn (the default recording's reply + result) after an unrecorded decision. */
  private completion(): Step[] {
    const base = this.core.base.turns[0] ?? [];
    const at = base.findIndex((s) => s.t === 'line' && s.line['type'] === 'assistant');
    return at < 0 ? [] : base.slice(at).filter((s) => s.t === 'line');
  }

  /** Builds the `tool_result` from the host's decision (answers, allow, or the deny message). */
  private applyDecision(line: JsonObject, payload: JsonObject, turn: TurnState): void {
    const open = turn.open;
    const block = asArray(asObject(line['message'])?.['content']).find((b): b is JsonObject => isObject(b) && b['type'] === 'tool_result');
    if (!block || !open) return;
    block['tool_use_id'] = open.toolUseId;
    if (payload['behavior'] === 'deny') {
      const message = asString(payload['message']) ?? 'Permission denied';
      block['content'] = message;
      block['is_error'] = true;
      line['tool_use_result'] = `Error: ${message}`;
      line['tool_result_meta'] = [{ id: open.toolUseId, non_execution_kind: 'permission-rule' }];
      return;
    }
    if (open.toolName === 'AskUserQuestion') {
      const updated = asObject(payload['updatedInput']) ?? {};
      const answers = asObject(updated['answers']) ?? {};
      block['content'] = formatAnswers(answers);
      delete block['is_error'];
      line['tool_use_result'] = { questions: updated['questions'] ?? asObject(open.input)?.['questions'] ?? [], answers };
      delete line['tool_result_meta'];
      return;
    }
    if (block['is_error'] === true) {
      block['content'] = '';
      block['is_error'] = false;
      line['tool_use_result'] = { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
      delete line['tool_result_meta'];
    }
  }

  private waitFor(requestId: string | null, acceptsEof: boolean): Promise<WaitEvent> {
    if (requestId !== null) {
      const early = this.unmatchedResponses.get(requestId);
      if (early) {
        this.unmatchedResponses.delete(requestId);
        return Promise.resolve({ kind: 'response', response: early });
      }
    }
    if (this.pendingSigint) {
      this.pendingSigint = false;
      return Promise.resolve({ kind: 'sigint' });
    }
    if (this.pendingInterrupt !== null) {
      const id = this.pendingInterrupt;
      this.pendingInterrupt = null;
      return Promise.resolve({ kind: 'interrupt', requestId: id });
    }
    if (acceptsEof && this.eof) return Promise.resolve({ kind: 'eof' });
    return new Promise((resolve) => {
      this.waiter = {
        requestId,
        acceptsEof,
        resolve: (event) => {
          this.waiter = null;
          resolve(event);
        },
      };
    });
  }

  // ---------------------------------------------------------------- output

  private ctx(extra: ReadonlyArray<readonly [string, string]>): RewriteContext {
    const loaded = this.o.store.loaded();
    if (this.ctxCache.count !== loaded.length) {
      const pairs: Array<readonly [string, string]> = [];
      const cwdSlug = slugForCwd(this.o.cwd);
      for (const fixture of loaded) {
        pairs.push([fixture.recordedCwd, this.o.cwd], [slugForCwd(fixture.recordedCwd), cwdSlug]);
        for (const id of fixture.sessionIds) pairs.push([id, this.sessionId]);
      }
      this.ctxCache = { count: loaded.length, pairs };
    }
    return {
      replacements: sortReplacements([...extra, ...this.ctxCache.pairs]),
      keep: new Set([this.sessionId]),
      now: () => new Date().toISOString(),
    };
  }

  private bareTurn(ids: IdMap): TurnState {
    return { msg: { content: '', text: '', uuid: '' }, scenario: '', turnIndex: 0, ids, extra: [], write: null, tool: null, say: null, open: null };
  }

  private passes(line: JsonObject): boolean {
    if (line['type'] === 'system' && (line['subtype'] === 'hook_started' || line['subtype'] === 'hook_response')) {
      return this.args.includeHookEvents || line['hook_event'] === 'SessionStart';
    }
    if (line['type'] === 'assistant' && line['parent_tool_use_id'] !== null && !this.args.forwardSubagentText) {
      const content = asArray(asObject(line['message'])?.['content']);
      return !content.every((b) => isObject(b) && (b['type'] === 'text' || b['type'] === 'thinking'));
    }
    return true;
  }

  private emit(recorded: JsonObject, turn: TurnState, patch?: (line: JsonObject) => void): JsonObject | null {
    if (!this.passes(recorded)) return null;
    const line = rewriteLine(recorded, this.ctx(turn.extra), turn.ids);
    if (line['type'] === 'system' && line['subtype'] === 'init') this.patchInit(line, turn);
    if (turn.write) this.patchWrite(line, turn.write);
    if (turn.tool) this.patchTool(line, turn.tool);
    if (turn.say !== null) this.patchSay(line, turn.say);
    if (line['type'] === 'result') line['result_index'] = this.resultIndex++;
    patch?.(line);
    this.writeJson(line);
    this.transcript?.onStdout(line);
    if (line['type'] === 'result') this.onResult(line);
    return line;
  }

  private patchInit(line: JsonObject, turn: TurnState): void {
    if (!KEEP_RECORDED_PERMISSION_MODE.has(turn.scenario)) line['permissionMode'] = reportedPermissionMode(this.permissionMode);
    const tools = asArray(line['tools']).filter((t) => t !== 'AskUserQuestion');
    if (this.stdio) tools.push('AskUserQuestion');
    line['tools'] = tools;
  }

  private patchWrite(line: JsonObject, write: WriteSpec): void {
    if (line['type'] === 'assistant') {
      for (const block of asArray(asObject(line['message'])?.['content'])) {
        if (isObject(block) && block['type'] === 'tool_use' && block['name'] === 'Write') {
          const input = asObject(block['input']);
          if (input) input['content'] = WRITE_CONTENT;
        }
      }
      for (const value of Object.values(asObject(line['wire_tool_inputs']) ?? {})) {
        if (isObject(value) && 'content' in value) value['content'] = WRITE_CONTENT;
      }
    }
    const result = asObject(line['tool_use_result']);
    if (line['type'] === 'user' && result && typeof result['filePath'] === 'string') {
      result['content'] = WRITE_CONTENT;
      result['type'] = write.existed ? 'update' : 'create';
      result['originalFile'] = write.original;
    }
  }

  /** `[fake:tool]`: the recorded Write call becomes `<Name>(input)` with an invented result text. */
  private patchTool(line: JsonObject, tool: ToolSpec): void {
    if (line['type'] === 'assistant') {
      for (const block of asArray(asObject(line['message'])?.['content'])) {
        if (isObject(block) && block['type'] === 'tool_use' && block['name'] === 'Write') {
          block['name'] = tool.name;
          block['input'] = clone(tool.input);
        }
      }
      return;
    }
    if (line['type'] !== 'user') return;
    const text = toolResultText(tool.name);
    for (const block of asArray(asObject(line['message'])?.['content'])) {
      if (isObject(block) && block['type'] === 'tool_result') block['content'] = text;
    }
    if ('tool_use_result' in line) line['tool_use_result'] = text;
  }

  /** `[fake:say]`: the main agent's reply text (and the result's) becomes `text`. */
  private patchSay(line: JsonObject, text: string): void {
    if (line['type'] === 'assistant' && line['parent_tool_use_id'] === null) {
      for (const block of asArray(asObject(line['message'])?.['content'])) {
        if (isObject(block) && block['type'] === 'text') block['text'] = text;
      }
    } else if (line['type'] === 'result' && typeof line['result'] === 'string') {
      line['result'] = text;
    }
  }

  private onResult(line: JsonObject): void {
    this.lastResultIsError = line['is_error'] === true;
    this.lastResultText = asString(line['result']) ?? null;
    this.lastResultErrors = asArray(line['errors']).map(String);
    if (asObject(line['origin'])?.['kind'] === 'task-notification') return;
    this.turnsCompleted++;
    this.transcript?.endTurn();
  }

  private writeJson(line: JsonObject): void {
    if (this.args.outputFormat === 'stream-json' && !this.finished) this.o.writeStdout(`${JSON.stringify(line)}\n`);
  }

  private writeAck(requestId: string): void {
    this.writeJson({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { still_queued: [] } } });
  }

  private writeReplay(msg: UserMessage): void {
    this.writeJson({
      type: 'user',
      message: { role: 'user', content: msg.content },
      session_id: this.sessionId,
      parent_tool_use_id: null,
      uuid: msg.uuid,
      timestamp: new Date().toISOString(),
      isReplay: true,
    });
  }

  // ---------------------------------------------------------------- exit

  private async finish(code: number): Promise<void> {
    if (this.finished) return;
    this.stopFires();
    if (this.args.outputFormat === 'text') {
      if (this.lastResultText !== null) this.o.writeStdout(`${this.lastResultText}\n`);
      else if (this.lastResultErrors.length > 0) this.o.writeStderr(`${this.lastResultErrors.join('\n')}\n`);
      this.transcript?.markTextMode();
    }
    this.finished = true;
    this.waiter = null;
    clearInterval(this.keepAlive);
    await this.transcript?.close();
    await this.live?.remove();
    await this.o.exit(code);
  }

  /** Exit 1 unasked: no `result`, no `cost-state`, the live-process file stays (as after a killed CLI). */
  private async crash(message: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.stopFires();
    this.o.writeStderr(`${message}\n`);
    clearInterval(this.keepAlive);
    await this.transcript?.flush();
    await this.live?.flush();
    await this.o.exit(1);
  }

  private async crashOn(error: unknown): Promise<void> {
    await this.crash(`fake-claude: internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }

  private async fail(message: string, code = 1): Promise<void> {
    this.finished = true;
    this.stopFires();
    clearInterval(this.keepAlive);
    this.o.writeStderr(message.endsWith('\n') ? message : `${message}\n`);
    await this.o.exit(code);
  }
}
