#!/usr/bin/env node
/**
 * tools/fake-codex: a stand-in for the OpenAI Codex CLI (`codex-cli 0.159.3`)
 * with the surface Switchboard uses (D62, `docs/providers.md`): `--version`,
 * `login status`, `mcp list|get|add|remove`, and `app-server`, the JSON-RPC
 * protocol over stdio the IDE extension drives. The shapes model the source read
 * at `rust-v0.159.3` (`docs/providers.md` → *Evidence*); the real CLI was never
 * run (`docs/spike-providers.md`). Tests never call the real `codex`.
 *
 * Environment: `CODEX_HOME` (threads are kept there as rollout files; unset =
 * nothing is kept and `thread/resume` fails), `FAKE_CODEX_LOG` (argv + every
 * stdin line), `FAKE_CODEX_SIGNED_OUT=1`, `FAKE_CODEX_RATE_LIMITS=<primary>,<secondary>`
 * (used percent; 100 makes every turn fail with the usage-limit error),
 * `FAKE_CODEX_MODELS=none`. Behaviour per message: `docs/fake-codex.md`.
 */
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';

export const FAKE_CODEX_VERSION = '0.159.3';

process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

type Json = Record<string, unknown>;

const env = process.env;
const logFile = env['FAKE_CODEX_LOG'];
let logWrites: Promise<void> = Promise.resolve();
function log(entry: Json): Promise<void> {
  if (!logFile) return Promise.resolve();
  const text = `${JSON.stringify({ ...entry, pid: process.pid })}\n`;
  logWrites = logWrites.then(() => appendFile(logFile, text));
  return logWrites;
}

function out(text: string): Promise<void> {
  return new Promise((resolve) => process.stdout.write(text, () => resolve()));
}

function err(text: string): Promise<void> {
  return new Promise((resolve) => process.stderr.write(text, () => resolve()));
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── models, account, limits ─────────────────────────────────────────────────

/** The fake's `model/list` (VERIFIED field names, `codex-rs/app-server-protocol/src/protocol/v2/model.rs`). */
export const FAKE_CODEX_MODELS: readonly Json[] = [
  {
    id: 'gpt-5.5-codex',
    model: 'gpt-5.5-codex',
    displayName: 'GPT-5.5 Codex',
    description: 'fake-codex: the default coding model',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'fast' },
      { reasoningEffort: 'medium', description: 'balanced' },
      { reasoningEffort: 'high', description: 'thorough' },
      { reasoningEffort: 'xhigh', description: 'deepest' },
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    isDefault: true,
  },
  {
    id: 'gpt-5.5-mini',
    model: 'gpt-5.5-mini',
    displayName: 'GPT-5.5 mini',
    description: 'fake-codex: a small model',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'fast' },
      { reasoningEffort: 'medium', description: 'balanced' },
    ],
    defaultReasoningEffort: 'low',
    inputModalities: ['text'],
    isDefault: false,
  },
];

/** The context window every fake model reports. */
export const FAKE_CODEX_WINDOW = 272_000;

/** D63: `<CODEX_HOME>/.fake-rate-limits` (`<primary>,<secondary>`) sets this account's windows, over `FAKE_CODEX_RATE_LIMITS`. */
function rateLimitsSetting(): string {
  const home = env['CODEX_HOME'];
  if (home && home.trim() !== '') {
    try {
      return readFileSync(path.join(home, '.fake-rate-limits'), 'utf8').trim();
    } catch {
      // No file: the environment's.
    }
  }
  return env['FAKE_CODEX_RATE_LIMITS'] ?? '12,40';
}

function rateLimits(): Json {
  const [primary, secondary] = rateLimitsSetting().split(',').map((part) => Number(part.trim()));
  const now = Math.floor(Date.now() / 1000);
  return {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: Number.isFinite(primary) ? primary : 12, windowDurationMins: 300, resetsAt: now + 3_600 },
    secondary: { usedPercent: Number.isFinite(secondary) ? secondary : 40, windowDurationMins: 10_080, resetsAt: now + 3 * 86_400 },
    credits: null,
    planType: 'plus',
    rateLimitReachedType: null,
  };
}

function limitReached(): boolean {
  const limits = rateLimits();
  return [limits['primary'], limits['secondary']].some((window) => isRecord(window) && Number(window['usedPercent']) >= 100);
}

// ── rollout files (threads) ─────────────────────────────────────────────────

const codexHome = env['CODEX_HOME'] && env['CODEX_HOME'].trim() !== '' ? env['CODEX_HOME'] : null;

function stamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/:/g, '-');
}

async function rolloutFiles(): Promise<string[]> {
  if (!codexHome) return [];
  const root = path.join(codexHome, 'sessions');
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/^rollout-.*\.jsonl$/.test(entry.name)) found.push(full);
    }
  };
  await walk(root);
  return found.sort();
}

async function findRollout(threadId: string): Promise<string | null> {
  return (await rolloutFiles()).find((file) => file.endsWith(`-${threadId}.jsonl`)) ?? null;
}

interface Thread {
  readonly id: string;
  readonly cwd: string;
  readonly file: string | null;
  readonly createdAt: number;
  preview: string;
}

async function rolloutLine(thread: Thread, type: string, payload: Json): Promise<void> {
  if (!thread.file) return;
  await appendFile(thread.file, `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`);
}

async function newThread(cwd: string): Promise<Thread> {
  const id = randomUUID();
  const now = new Date();
  let file: string | null = null;
  if (codexHome) {
    const dir = path.join(codexHome, 'sessions', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'));
    await mkdir(dir, { recursive: true });
    file = path.join(dir, `rollout-${stamp(now)}-${id}.jsonl`);
  }
  const thread: Thread = { id, cwd, file, createdAt: Math.floor(now.getTime() / 1000), preview: '' };
  if (file) {
    await writeFile(file, '');
    await rolloutLine(thread, 'session_meta', { id, timestamp: now.toISOString(), cwd, originator: 'codex_cli_rs', cli_version: FAKE_CODEX_VERSION, source: 'vscode', model_provider: 'openai' });
  }
  return thread;
}

async function readThread(file: string): Promise<{ thread: Thread; messages: Array<{ role: string; text: string }> } | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  let meta: Json | null = null;
  const messages: Array<{ role: string; text: string }> = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed['payload'])) continue;
    const payload = parsed['payload'];
    if (parsed['type'] === 'session_meta') meta = payload;
    if (parsed['type'] === 'response_item' && payload['type'] === 'message') {
      const content = Array.isArray(payload['content']) ? payload['content'] : [];
      const joined = content.filter(isRecord).map((block) => String(block['text'] ?? '')).join('\n');
      messages.push({ role: String(payload['role']), text: joined });
    }
  }
  if (!meta) return null;
  const created = Date.parse(String(meta['timestamp'] ?? ''));
  const thread: Thread = {
    id: String(meta['id']),
    cwd: String(meta['cwd'] ?? ''),
    file,
    createdAt: Number.isFinite(created) ? Math.floor(created / 1000) : 0,
    preview: messages.find((message) => message.role === 'user')?.text ?? '',
  };
  return { thread, messages };
}

function threadWire(thread: Thread, extra: Json = {}): Json {
  return {
    id: thread.id,
    sessionId: thread.id,
    forkedFromId: null,
    parentThreadId: null,
    preview: thread.preview,
    ephemeral: thread.file === null,
    modelProvider: 'openai',
    model: FAKE_CODEX_MODELS[0]?.['model'],
    reasoningEffort: 'medium',
    createdAt: thread.createdAt,
    updatedAt: thread.createdAt,
    status: { type: 'idle' },
    path: thread.file,
    cwd: thread.cwd,
    cliVersion: FAKE_CODEX_VERSION,
    source: 'vscode',
    turns: [],
    ...extra,
  };
}

// ── CLI subcommands ─────────────────────────────────────────────────────────

interface FakeMcpServer {
  readonly name: string;
  readonly transport: Json;
  readonly enabled: boolean;
}

function mcpFile(): string | null {
  return codexHome ? path.join(codexHome, 'fake-mcp.json') : null;
}

async function readMcp(): Promise<FakeMcpServer[]> {
  const file = mcpFile();
  if (!file) return [];
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as FakeMcpServer[]) : [];
  } catch {
    return [];
  }
}

async function writeMcp(servers: readonly FakeMcpServer[]): Promise<void> {
  const file = mcpFile();
  if (!file) throw new Error('CODEX_HOME is not set');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(servers, null, 2));
}

function mcpWire(server: FakeMcpServer): Json {
  return { name: server.name, enabled: server.enabled, disabled_reason: null, transport: server.transport, startup_timeout_sec: null, tool_timeout_sec: null, auth_status: 'unsupported' };
}

/** `codex mcp …` (VERIFIED `codex-rs/cli/src/mcp_cmd.rs`: list --json, get, add <name> [--env K=V] -- <cmd> | --url <url>, remove <name>). */
async function mcp(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  const servers = await readMcp();
  if (sub === 'list') {
    if (rest.includes('--json')) await out(`${JSON.stringify(servers.map(mcpWire), null, 2)}\n`);
    else if (servers.length === 0) await out('No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.\n');
    else for (const server of servers) await out(`${server.name}\t${JSON.stringify(server.transport)}\n`);
    return 0;
  }
  if (sub === 'get') {
    const name = rest.find((part) => !part.startsWith('--'));
    const server = servers.find((s) => s.name === name);
    if (!server) {
      await err(`Error: No MCP server named '${name ?? ''}' found.\n`);
      return 1;
    }
    await out(`${JSON.stringify(mcpWire(server), null, 2)}\n`);
    return 0;
  }
  if (sub === 'add') {
    const name = rest[0];
    if (!name || name.startsWith('-')) {
      await err('error: the following required arguments were not provided: <NAME>\n');
      return 2;
    }
    const envVars: Json = {};
    let url: string | null = null;
    let index = 1;
    while (index < rest.length && rest[index] !== '--') {
      const flag = rest[index];
      if (flag === '--env' && rest[index + 1]) {
        const [key, ...value] = String(rest[index + 1]).split('=');
        envVars[key as string] = value.join('=');
        index += 2;
      } else if (flag === '--url' && rest[index + 1]) {
        url = String(rest[index + 1]);
        index += 2;
      } else {
        await err(`error: unexpected argument '${flag}' found\n`);
        return 2;
      }
    }
    const command = rest.slice(index + 1);
    if (!url && command.length === 0) {
      await err('error: a command after -- or --url is required\n');
      return 2;
    }
    const transport: Json = url ? { type: 'streamable_http', url, bearer_token_env_var: null, http_headers: null, env_http_headers: null } : { type: 'stdio', command: command[0], args: command.slice(1), env: envVars, env_vars: [], cwd: null };
    await writeMcp([...servers.filter((s) => s.name !== name), { name, transport, enabled: true }]);
    await out(`Added global MCP server '${name}'.\n`);
    return 0;
  }
  if (sub === 'remove') {
    const name = rest[0];
    if (!servers.some((s) => s.name === name)) {
      await err(`No MCP server named '${name ?? ''}' found.\n`);
      return 1;
    }
    await writeMcp(servers.filter((s) => s.name !== name));
    await out(`Removed global MCP server '${name}'.\n`);
    return 0;
  }
  await err(`error: unrecognized subcommand '${sub ?? ''}'\n`);
  return 2;
}

// ── app-server ──────────────────────────────────────────────────────────────

interface Turn {
  readonly id: string;
  readonly thread: Thread;
  readonly startedAt: number;
  interrupted: boolean;
  readonly interrupt: Promise<void>;
  readonly fireInterrupt: () => void;
  done: boolean;
}

let initialized = false;
let nextServerRequest = 1;
const waiting = new Map<number, (message: Json) => void>();
const threads = new Map<string, Thread>();
let current: Turn | null = null;
let inputEnded = false;
const turnModel = new Map<string, { model: string | null; effort: string | null }>();

async function send(message: Json): Promise<void> {
  await out(`${JSON.stringify(message)}\n`);
}

function notify(method: string, params: Json): Promise<void> {
  return send({ method, params });
}

/** A server→client request; resolves with the client's response (`result` or `error`). */
async function request(method: string, params: Json, turn: Turn): Promise<Json | null> {
  const id = nextServerRequest++;
  const answer = new Promise<Json>((resolve) => waiting.set(id, resolve));
  await send({ id, method, params });
  const outcome = await Promise.race([answer, turn.interrupt.then(() => null)]);
  if (outcome === null) {
    waiting.delete(id);
    await notify('serverRequest/resolved', { threadId: turn.thread.id, requestId: id });
  }
  return outcome;
}

function textOf(input: readonly unknown[]): { text: string; images: number } {
  let text = '';
  let images = 0;
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (item['type'] === 'text') text += `${text ? '\n' : ''}${String(item['text'] ?? '')}`;
    if (item['type'] === 'image' || item['type'] === 'localImage') images += 1;
  }
  return { text, images };
}

/** Holds `ms`, cut short by an interrupt; `true` when it ran out. */
async function hold(ms: number, turn: Turn): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const done = await Promise.race([
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), ms);
    }),
    turn.interrupt.then(() => false),
  ]);
  clearTimeout(timer);
  return done;
}

async function itemPair(turn: Turn, started: Json, completed: Json): Promise<void> {
  await notify('item/started', { item: started, threadId: turn.thread.id, turnId: turn.id, startedAtMs: Date.now() });
  await notify('item/completed', { item: completed, threadId: turn.thread.id, turnId: turn.id, completedAtMs: Date.now() });
}

async function agentMessage(turn: Turn, text: string): Promise<void> {
  const id = `msg_${randomUUID().slice(0, 8)}`;
  await notify('item/started', { item: { type: 'agentMessage', id, text: '', phase: null }, threadId: turn.thread.id, turnId: turn.id, startedAtMs: Date.now() });
  const half = Math.ceil(text.length / 2);
  for (const delta of [text.slice(0, half), text.slice(half)]) {
    if (delta) await notify('item/agentMessage/delta', { threadId: turn.thread.id, turnId: turn.id, itemId: id, delta });
  }
  await notify('item/completed', { item: { type: 'agentMessage', id, text, phase: null }, threadId: turn.thread.id, turnId: turn.id, completedAtMs: Date.now() });
  await rolloutLine(turn.thread, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
}

async function tokenUsage(turn: Turn, tokens: number, window: number): Promise<void> {
  const cached = Math.floor(tokens * 0.75);
  const last = { totalTokens: tokens + 12, inputTokens: tokens, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: 12, reasoningOutputTokens: 0 };
  await notify('thread/tokenUsage/updated', { threadId: turn.thread.id, turnId: turn.id, tokenUsage: { total: last, last, modelContextWindow: window } });
}

async function finish(turn: Turn, status: 'completed' | 'interrupted' | 'failed', error: Json | null = null): Promise<void> {
  if (turn.done) return;
  turn.done = true;
  await notify('turn/completed', {
    threadId: turn.thread.id,
    turn: { id: turn.id, items: [], itemsView: 'notLoaded', status, error, startedAt: turn.startedAt, completedAt: Math.floor(Date.now() / 1000), durationMs: Date.now() - turn.startedAt * 1000 },
  });
  if (current === turn) current = null;
}

/** Plays one turn for `text` (the `[fake:…]` tokens in `docs/fake-codex.md`). */
async function play(turn: Turn, text: string, images: number): Promise<void> {
  const { thread } = turn;
  await notify('turn/started', { threadId: thread.id, turn: { id: turn.id, items: [], status: 'inProgress', error: null, startedAt: turn.startedAt } });
  const userItem = { type: 'userMessage', id: `user_${randomUUID().slice(0, 8)}`, clientId: null, content: [{ type: 'text', text, text_elements: [] }] };
  await itemPair(turn, userItem, userItem);
  await rolloutLine(thread, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  if (!thread.preview) thread.preview = text;
  if (limitReached()) {
    const error = { message: "You've hit your usage limit. Upgrade or try again later.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null };
    await notify('error', { error, willRetry: false, threadId: thread.id, turnId: turn.id });
    return finish(turn, 'failed', error);
  }
  let tokens = 21_000;
  let window = FAKE_CODEX_WINDOW;
  const usage = /\[fake:usage (\d+)(?: (\d+))?\]/.exec(text);
  if (usage) {
    tokens = Number(usage[1]);
    if (usage[2]) window = Number(usage[2]);
  }
  await notify('item/started', { item: { type: 'reasoning', id: `rs_${randomUUID().slice(0, 8)}`, summary: [], content: [] }, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() });
  let reply = images > 0 ? `[fake-codex: ${images} image${images === 1 ? '' : 's'}]` : 'OK';
  const say = /\[fake:say ("(?:[^"\\]|\\.)*")\]/.exec(text);
  if (say) reply = JSON.parse(say[1] as string) as string;

  const holdToken = /\[fake:hold (\d+(?:\.\d+)?)\]/.exec(text);
  if (holdToken && !(await hold(Number(holdToken[1]) * 1000, turn))) return finish(turn, 'interrupted');

  const cmd = /\[fake:cmd ([^\]]+)\]/.exec(text);
  if (cmd) {
    const id = `call_${randomUUID().slice(0, 8)}`;
    const base = { type: 'commandExecution', id, command: cmd[1], cwd: thread.cwd, processId: null, source: 'agent', commandActions: [], durationMs: null };
    await notify('item/started', { item: { ...base, status: 'inProgress', aggregatedOutput: null, exitCode: null }, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() });
    await notify('item/commandExecution/outputDelta', { threadId: thread.id, turnId: turn.id, itemId: id, delta: `fake-codex: ran ${cmd[1]}\n` });
    await notify('item/completed', { item: { ...base, status: 'completed', aggregatedOutput: `fake-codex: ran ${cmd[1]}\n`, exitCode: 0, durationMs: 5 }, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() });
  }

  const write = /\[fake:write ([^\]\s]+)\]/.exec(text);
  if (write) {
    const relative = write[1] as string;
    const target = path.resolve(thread.cwd, relative);
    if (!target.startsWith(path.resolve(thread.cwd) + path.sep)) {
      await err(`fake-codex: ${relative} leaves the cwd\n`);
      process.exit(1);
    }
    let existed = true;
    try {
      await readFile(target);
    } catch {
      existed = false;
    }
    const id = `patch_${randomUUID().slice(0, 8)}`;
    const change = { path: target, kind: existed ? { type: 'update', move_path: null } : { type: 'add' }, diff: '+written by fake-codex\n' };
    await notify('item/started', { item: { type: 'fileChange', id, changes: [change], status: 'inProgress' }, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'written by fake-codex\n');
    await notify('item/completed', { item: { type: 'fileChange', id, changes: [change], status: 'completed' }, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() });
  }

  const approveCmd = /\[fake:approve-cmd ([^\]]+)\]/.exec(text);
  if (approveCmd) {
    const id = `call_${randomUUID().slice(0, 8)}`;
    const base = { type: 'commandExecution', id, command: approveCmd[1], cwd: thread.cwd, processId: null, source: 'agent', commandActions: [], durationMs: null };
    await notify('item/started', { item: { ...base, status: 'inProgress', aggregatedOutput: null, exitCode: null }, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() });
    const answer = await request('item/commandExecution/requestApproval', { threadId: thread.id, turnId: turn.id, itemId: id, startedAtMs: Date.now(), reason: 'fake-codex: this command needs network access', command: approveCmd[1], cwd: thread.cwd }, turn);
    if (answer === null) return finish(turn, 'interrupted');
    const decision = isRecord(answer['result']) ? answer['result']['decision'] : undefined;
    await log({ kind: 'decision', method: 'item/commandExecution/requestApproval', decision });
    if (decision === 'cancel') {
      await notify('item/completed', { item: { ...base, status: 'declined', aggregatedOutput: null, exitCode: null }, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() });
      return finish(turn, 'interrupted');
    }
    const accepted = decision === 'accept' || decision === 'acceptForSession';
    await notify('item/completed', {
      item: { ...base, status: accepted ? 'completed' : 'declined', aggregatedOutput: accepted ? `fake-codex: ran ${approveCmd[1]}\n` : null, exitCode: accepted ? 0 : null },
      threadId: thread.id,
      turnId: turn.id,
      completedAtMs: Date.now(),
    });
    reply = accepted ? `ran it (${String(decision)})` : 'the command was declined';
  }

  const approveFile = /\[fake:approve-file ([^\]\s]+)\]/.exec(text);
  if (approveFile) {
    const id = `patch_${randomUUID().slice(0, 8)}`;
    const target = path.resolve(thread.cwd, approveFile[1] as string);
    const change = { path: target, kind: { type: 'add' }, diff: '+approved\n' };
    await notify('item/started', { item: { type: 'fileChange', id, changes: [change], status: 'inProgress' }, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() });
    const answer = await request('item/fileChange/requestApproval', { threadId: thread.id, turnId: turn.id, itemId: id, startedAtMs: Date.now(), reason: 'fake-codex: writes outside the workspace', grantRoot: null }, turn);
    if (answer === null) return finish(turn, 'interrupted');
    const decision = isRecord(answer['result']) ? answer['result']['decision'] : undefined;
    await log({ kind: 'decision', method: 'item/fileChange/requestApproval', decision });
    const accepted = decision === 'accept' || decision === 'acceptForSession';
    await notify('item/completed', { item: { type: 'fileChange', id, changes: [change], status: accepted ? 'completed' : 'declined' }, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() });
    reply = accepted ? 'file written' : 'the change was declined';
  }

  if (text.includes('[fake:ask]')) {
    const id = `ask_${randomUUID().slice(0, 8)}`;
    const answer = await request(
      'item/tool/requestUserInput',
      {
        threadId: thread.id,
        turnId: turn.id,
        itemId: id,
        isBlocking: true,
        questions: [
          {
            id: 'color',
            header: 'Color',
            question: 'Which color should the button be?',
            isOther: false,
            isSecret: false,
            options: [
              { label: 'Red', description: 'warm' },
              { label: 'Blue', description: 'cool' },
            ],
          },
        ],
      },
      turn,
    );
    if (answer === null) return finish(turn, 'interrupted');
    const answers = isRecord(answer['result']) && isRecord(answer['result']['answers']) ? answer['result']['answers'] : {};
    const color = isRecord(answers['color']) && Array.isArray(answers['color']['answers']) ? answers['color']['answers'].join(', ') : '(none)';
    await log({ kind: 'answers', answers });
    reply = `You chose ${color}`;
  }

  const subagent = /\[fake:subagent ([^\]]+)\]/.exec(text);
  if (subagent) {
    const id = `collab_${randomUUID().slice(0, 8)}`;
    const child = randomUUID();
    const base = { type: 'collabAgentToolCall', id, tool: 'spawnAgent', senderThreadId: thread.id, receiverThreadIds: [child], prompt: subagent[1], model: 'gpt-5.5-mini', reasoningEffort: 'low', agentsStates: {} };
    await notify('item/started', { item: { ...base, status: 'inProgress' }, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() });
    await notify('item/completed', { item: { ...base, status: 'completed', agentsStates: { [child]: { status: 'completed', message: 'fake-codex: the subagent is done' } } }, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() });
  }

  if (text.includes('[fake:compact]')) {
    await itemPair(turn, { type: 'contextCompaction', id: `cmp_${randomUUID().slice(0, 8)}` }, { type: 'contextCompaction', id: `cmp_${randomUUID().slice(0, 8)}` });
    tokens = 4_000;
  }

  const fail = /\[fake:fail ([^\]]+)\]/.exec(text);
  if (fail) {
    const error = { message: fail[1], codexErrorInfo: 'other', additionalDetails: null };
    await notify('error', { error, willRetry: false, threadId: thread.id, turnId: turn.id });
    return finish(turn, 'failed', error);
  }

  if (text.includes('[fake:handover]')) {
    reply = 'Handover: goal = the fake task; decisions = none; files changed = none; open tasks = none; next step = continue; uncommitted = nothing.';
  }

  if (turn.interrupted) return finish(turn, 'interrupted');
  await agentMessage(turn, reply);
  await tokenUsage(turn, tokens, window);
  await notify('account/rateLimits/updated', { rateLimits: rateLimits() });
  await finish(turn, 'completed');
}

async function startTurn(id: number | string, params: Json): Promise<void> {
  const threadId = String(params['threadId'] ?? '');
  const thread = threads.get(threadId);
  if (!thread) return send({ id, error: { code: -32600, message: `thread not found: ${threadId}` } });
  if (current && !current.done) return send({ id, error: { code: -32600, message: 'a turn is already running on this thread' } });
  const input = Array.isArray(params['input']) ? params['input'] : [];
  const { text, images } = textOf(input);
  turnModel.set(threadId, { model: typeof params['model'] === 'string' ? params['model'] : null, effort: typeof params['effort'] === 'string' ? params['effort'] : null });
  let fireInterrupt: () => void = () => undefined;
  const interrupt = new Promise<void>((resolve) => {
    fireInterrupt = resolve;
  });
  const turn: Turn = { id: `turn_${randomUUID().slice(0, 8)}`, thread, startedAt: Math.floor(Date.now() / 1000), interrupted: false, interrupt, fireInterrupt, done: false };
  current = turn;
  await send({ id, result: { turn: { id: turn.id, items: [], status: 'inProgress', error: null } } });
  void play(turn, text, images).catch(async (error: unknown) => {
    await err(`fake-codex: ${String(error)}\n`);
  });
}

async function handleRequest(id: number | string, method: string, params: Json): Promise<void> {
  if (method === 'initialize') {
    if (initialized) return send({ id, error: { code: -32600, message: 'Already initialized' } });
    initialized = true;
    return send({ id, result: { userAgent: `codex_cli_rs/${FAKE_CODEX_VERSION} (fake-codex)`, codexHome: codexHome ?? '', platformFamily: 'unix', platformOs: process.platform === 'darwin' ? 'macos' : process.platform } });
  }
  if (!initialized) return send({ id, error: { code: -32002, message: 'Not initialized' } });
  switch (method) {
    case 'model/list':
      return send({ id, result: { data: env['FAKE_CODEX_MODELS'] === 'none' ? [] : FAKE_CODEX_MODELS, nextCursor: null } });
    case 'account/read':
      return send({ id, result: { account: env['FAKE_CODEX_SIGNED_OUT'] === '1' ? null : { type: 'chatgpt', email: 'dev@example.com', planType: 'plus' }, requiresOpenaiAuth: true } });
    case 'account/rateLimits/read':
      return send({ id, result: { ordinaryUsageAllowed: !limitReached(), rateLimits: rateLimits(), rateLimitsByLimitId: {} } });
    case 'thread/start': {
      const cwd = typeof params['cwd'] === 'string' ? params['cwd'] : process.cwd();
      const thread = await newThread(cwd);
      threads.set(thread.id, thread);
      await send({
        id,
        result: {
          thread: threadWire(thread),
          model: typeof params['model'] === 'string' ? params['model'] : FAKE_CODEX_MODELS[0]?.['model'],
          modelProvider: 'openai',
          cwd,
          approvalPolicy: params['approvalPolicy'] ?? 'on-request',
          sandbox: { type: params['sandbox'] === 'workspace-write' ? 'workspaceWrite' : 'readOnly' },
          reasoningEffort: 'medium',
        },
      });
      return notify('thread/started', { thread: threadWire(thread) });
    }
    case 'thread/resume': {
      const threadId = String(params['threadId'] ?? '');
      const file = await findRollout(threadId);
      const read = file ? await readThread(file) : null;
      if (!read) return send({ id, error: { code: -32600, message: `no rollout found for thread id ${threadId}` } });
      const thread = { ...read.thread, cwd: typeof params['cwd'] === 'string' ? params['cwd'] : read.thread.cwd };
      threads.set(thread.id, thread);
      return send({ id, result: { thread: threadWire(thread), model: params['model'] ?? FAKE_CODEX_MODELS[0]?.['model'], modelProvider: 'openai', cwd: thread.cwd, approvalPolicy: params['approvalPolicy'] ?? 'on-request', reasoningEffort: 'medium' } });
    }
    case 'thread/list': {
      const cwd = typeof params['cwd'] === 'string' ? params['cwd'] : null;
      const data: Json[] = [];
      for (const file of await rolloutFiles()) {
        const read = await readThread(file);
        if (read && (cwd === null || read.thread.cwd === cwd)) data.push(threadWire(read.thread));
      }
      return send({ id, result: { data, nextCursor: null, backwardsCursor: null } });
    }
    case 'thread/read': {
      const threadId = String(params['threadId'] ?? '');
      const file = await findRollout(threadId);
      const read = file ? await readThread(file) : null;
      if (!read) return send({ id, error: { code: -32600, message: `no rollout found for thread id ${threadId}` } });
      const items = read.messages.map((message, index) =>
        message.role === 'user'
          ? { type: 'userMessage', id: `u${index}`, clientId: null, content: [{ type: 'text', text: message.text, text_elements: [] }] }
          : { type: 'agentMessage', id: `a${index}`, text: message.text, phase: null },
      );
      return send({ id, result: { thread: threadWire(read.thread, params['includeTurns'] === true ? { turns: [{ id: 'turn_0', items, status: 'completed', error: null }] } : {}) } });
    }
    case 'turn/start':
      return startTurn(id, params);
    case 'turn/interrupt': {
      const turn = current;
      await send({ id, result: {} });
      if (turn && !turn.done && turn.id === params['turnId']) {
        turn.interrupted = true;
        turn.fireInterrupt();
      }
      return;
    }
    default:
      return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

async function appServer(): Promise<number> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const work: Promise<void>[] = [];
  for await (const line of lines) {
    await log({ kind: 'stdin', line });
    if (line.trim() === '') continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      await send({ id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    if (!isRecord(message)) continue;
    if ('jsonrpc' in message) await log({ kind: 'jsonrpc-field', line });
    const method = typeof message['method'] === 'string' ? message['method'] : null;
    const id = message['id'];
    if (method && (typeof id === 'number' || typeof id === 'string')) {
      work.push(handleRequest(id, method, isRecord(message['params']) ? message['params'] : {}));
    } else if (method) {
      // `initialized` (the only client notification).
      continue;
    } else if (typeof id === 'number' && waiting.has(id)) {
      const resolve = waiting.get(id);
      waiting.delete(id);
      resolve?.(message);
    }
  }
  inputEnded = true;
  await Promise.all(work);
  // EOF: a running turn finishes first (ASSUMED D62-codex-eof), then the server exits.
  while (current && !current.done) await sleep(20);
  await logWrites;
  return 0;
}

/**
 * D63: the sign-in state of a home is `<CODEX_HOME>/.fake-auth.json` (`{loggedIn}`). Without the file a home is
 * signed in (as before D63) unless `FAKE_CODEX_SIGNED_OUT=1`, or `FAKE_CODEX_AUTH_REQUIRED=1` (then only a home with the file is).
 */
async function signedIn(): Promise<boolean> {
  if (env['FAKE_CODEX_SIGNED_OUT'] === '1') return false;
  if (codexHome) {
    try {
      return (JSON.parse(await readFile(path.join(codexHome, '.fake-auth.json'), 'utf8')) as { loggedIn?: unknown }).loggedIn === true;
    } catch {
      // No file: the rule above.
    }
  }
  return env['FAKE_CODEX_AUTH_REQUIRED'] !== '1';
}

/**
 * D63 `codex login [--device-auth]` (ASSUMED output shapes: the real CLI's wording was never captured, see
 * `docs/spike-providers.md`): the browser flow prints the local-server line and the authorize URL; the device flow
 * the verification URL and a one-time code. `FAKE_CODEX_LOGIN_MODE`: `auto` (default, signs in after
 * `FAKE_CODEX_LOGIN_MS`, 300 ms), `never` (waits until stopped), `fail` (exit 1).
 */
async function login(device: boolean): Promise<number> {
  const mode = env['FAKE_CODEX_LOGIN_MODE'] ?? 'auto';
  const url = env['FAKE_CODEX_LOGIN_URL'] ?? `https://auth.fake-codex.example.test/oauth/authorize?state=${randomUUID().slice(0, 8)}`;
  if (device) {
    await err(`Welcome to Codex [v${FAKE_CODEX_VERSION}]\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   https://auth.fake-codex.example.test/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   ABCD-12345\n`);
  } else {
    await err(`Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\n${url}\n`);
  }
  if (!codexHome) {
    await err('fake-codex: CODEX_HOME is not set\n');
    return 1;
  }
  if (mode === 'fail') {
    await err('Error logging in: the fake refused\n');
    return 1;
  }
  if (mode === 'never') await new Promise<never>(() => setInterval(() => undefined, 1 << 30));
  await sleep(Number(env['FAKE_CODEX_LOGIN_MS'] ?? 300));
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, '.fake-auth.json'), `${JSON.stringify({ loggedIn: true })}\n`);
  await err('Successfully logged in\n');
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  await log({ kind: 'argv', argv, cwd: process.cwd(), env: Object.fromEntries(Object.entries(env).filter(([key]) => key === 'CODEX_HOME' || key.startsWith('FAKE_CODEX_'))) });
  const [first, ...rest] = argv;
  if (first === '--version' || first === '-V') {
    await out(`codex-cli ${FAKE_CODEX_VERSION}\n`);
    return 0;
  }
  if (first === 'login' && rest[0] === 'status') {
    if (!(await signedIn())) {
      await err('Not logged in\n');
      return 1;
    }
    await err('Logged in using ChatGPT\n');
    return 0;
  }
  if (first === 'login') return login(rest.includes('--device-auth'));
  if (first === 'logout') {
    if (!codexHome) {
      await err('fake-codex: CODEX_HOME is not set\n');
      return 1;
    }
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, '.fake-auth.json'), `${JSON.stringify({ loggedIn: false })}\n`);
    await err('Successfully logged out\n');
    return 0;
  }
  if (first === 'mcp') return mcp(rest);
  if (first === 'app-server') {
    process.on('SIGTERM', () => process.exit(143));
    process.on('SIGINT', () => process.exit(130));
    return appServer();
  }
  if (first === 'resume') {
    await err('fake-codex: `codex resume` is interactive (a terminal), not supported by the fake\n');
    return 1;
  }
  await err(`error: unrecognized subcommand '${first ?? ''}'\n`);
  return 2;
}

void main().then(
  async (code) => {
    await logWrites;
    process.exitCode = code;
    if (inputEnded || code !== 0) process.exit(code);
  },
  async (error: unknown) => {
    await err(`fake-codex: ${String(error)}\n`);
    process.exit(1);
  },
);
