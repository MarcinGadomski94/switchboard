import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestPayload, ToolPayload } from '../../../src/core/event-payload.ts';
import type { ProviderUsage } from '../../../src/server/cli/bridge-common.ts';
import { codexModels, listCodexModels } from '../../../src/server/cli/codex/bridge.ts';
import type { CanUseToolContext } from '../../../src/server/supervisor/supervisor.ts';
import { SessionSupervisor } from '../../../src/server/supervisor/supervisor.ts';
import { fakeCodexCommand } from '../../../tools/fake-codex/command.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, payloadType, until, waitForEvent, waitForStatus } from '../../helpers/supervisor.ts';

let world: SupervisorWorld | undefined;
let extra: SessionSupervisor | undefined;

afterEach(async () => {
  await extra?.shutdown();
  extra = undefined;
  await world?.cleanup();
  world = undefined;
});

interface CodexLogLine {
  readonly kind: string;
  readonly pid: number;
  readonly argv?: string[];
  readonly line?: string;
  readonly decision?: unknown;
  readonly answers?: unknown;
}

async function codexLog(file: string): Promise<CodexLogLine[]> {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CodexLogLine);
}

/** The JSON-RPC messages Switchboard wrote to the fake app-server (every process, in order). */
async function rpcSent(file: string): Promise<Array<Record<string, unknown>>> {
  return (await codexLog(file)).filter((line) => line.kind === 'stdin' && line.line).map((line) => JSON.parse(line.line as string) as Record<string, unknown>);
}

async function startCodex(task: string, options: Parameters<typeof makeSupervisorWorld>[0] = {}) {
  world = await makeSupervisorWorld(options);
  const session = await world.supervisor.start({ ...newSession({ task }), provider: 'codex' }, world.place);
  return { w: world, session };
}

describe('D62 · Codex CLI through the bridge (fake-codex)', () => {
  it('spawns `codex app-server`, starts a thread in the cwd, chats: the reply, the result, the thread id kept, the models and version', async () => {
    const { w, session } = await startCodex('Say OK.');
    expect(session.provider).toBe('codex');
    const done = await waitForStatus(w.store, session.id, ['done']);
    expect(done.cliVersion).toBe('codex-cli 0.159.3');
    const argv = (await codexLog(w.codexLog)).filter((line) => line.kind === 'argv');
    expect(argv.map((line) => line.argv)).toEqual([['app-server']]);
    const sent = await rpcSent(w.codexLog);
    expect(sent.some((message) => 'jsonrpc' in message)).toBe(false);
    expect(sent.map((message) => message['method'] ?? 'response')).toEqual(['initialize', 'initialized', 'thread/start', 'account/rateLimits/read', 'model/list', 'turn/start']);
    expect(sent[2]?.['params']).toEqual({ cwd: w.workspace, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    expect((sent[5]?.['params'] as Record<string, unknown>)['input']).toEqual([{ type: 'text', text: 'Say OK.', text_elements: [] }]);
    const threadId = await w.store.providers.nativeId(session.id, 'codex');
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
    const events = await w.store.events.list(session.id);
    expect(events.map((event) => [event.kind, event.label])).toEqual(
      expect.arrayContaining([
        ['text', 'Say OK.'],
        ['text', 'OK'],
      ]),
    );
    const user = events.find((event) => payloadType(event) === 'user');
    expect(user?.payload).toMatchObject({ delivered: true });
    expect(events.at(-1)?.payload).toMatchObject({ type: 'result', isError: false, text: 'OK' });
    // D31: the models from `model/list`, Default first, with their reasoning efforts.
    expect(done.modelOptions?.map((option) => [option.value, option.efforts ?? []])).toEqual([
      ['default', ['low', 'medium', 'high', 'xhigh']],
      ['gpt-5.5-codex', ['low', 'medium', 'high', 'xhigh']],
      ['gpt-5.5-mini', ['low', 'medium']],
    ]);
    // D49: tokenUsage → the context meter with the model's window.
    const detail = await w.store.sessions.get(session.id);
    expect(detail?.context).toMatchObject({ tokens: 21_000 });
    expect(Object.values(detail?.context?.windows ?? {})).toContain(272_000);
    expect(w.errors).toEqual([]);
  });

  it('tool steps: a command and a file change are Bash / Write steps closed by their results; the file is written', async () => {
    const { w, session } = await startCodex('[fake:cmd ls -la] [fake:write notes/a.txt]');
    await waitForStatus(w.store, session.id, ['done']);
    const tools = (await w.store.events.list(session.id)).filter((event) => payloadType(event) === 'tool').map((event) => event.payload as ToolPayload);
    expect(tools.map((tool) => [tool.name, tool.input])).toEqual([
      ['Bash', { command: 'ls -la', cwd: w.workspace }],
      ['Write', { file_path: path.join(w.workspace, 'notes', 'a.txt'), diff: '+written by fake-codex\n' }],
    ]);
    expect(tools.map((tool) => [tool.result, tool.isError])).toEqual([
      ['fake-codex: ran ls -la\n', false],
      [`Updated ${path.join(w.workspace, 'notes', 'a.txt')}`, false],
    ]);
    expect(await readFile(path.join(w.workspace, 'notes', 'a.txt'), 'utf8')).toBe('written by fake-codex\n');
  });

  it('permission: an approval is an Inbox request with Codex\'s "always"; Allow once → accept, Always → acceptForSession, Deny → decline', async () => {
    const seen: CanUseToolContext[] = [];
    const { w, session } = await startCodex('[fake:approve-cmd curl https://example.com]', { controlHandler: { canUseTool: (context) => void seen.push(context) } });
    await waitForStatus(w.store, session.id, ['need']);
    const request = seen[0]?.request;
    expect(request).toMatchObject({ toolName: 'Bash', input: { command: 'curl https://example.com', cwd: w.workspace, reason: 'fake-codex: this command needs network access' }, hookSuggestions: [{ type: 'codex', decision: 'acceptForSession' }] });
    const ask = await waitForEvent(w.store, session.id, (event) => payloadType(event) === 'request');
    expect((ask.payload as RequestPayload).toolName).toBe('Bash');
    await w.supervisor.respond(session.id, request?.requestId ?? '', { behavior: 'allow', updatedInput: request?.input ?? {}, updatedPermissions: request?.hookSuggestions ?? [] });
    await waitForStatus(w.store, session.id, ['done']);
    expect((await w.store.events.list(session.id)).at(-1)?.payload).toMatchObject({ text: 'ran it (acceptForSession)' });

    await w.supervisor.sendMessage(session.id, '[fake:approve-cmd rm -rf build]');
    await until(async () => seen.length === 2, 'the second request');
    await w.supervisor.respond(session.id, seen[1]?.request.requestId ?? '', { behavior: 'deny', message: 'no' });
    await waitForStatus(w.store, session.id, ['done']);
    const decisions = (await codexLog(w.codexLog)).filter((line) => line.kind === 'decision').map((line) => line.decision);
    expect(decisions).toEqual(['acceptForSession', 'decline']);
  });

  it('question: requestUserInput is a question batch; the answer goes back by question id', async () => {
    const seen: CanUseToolContext[] = [];
    const { w, session } = await startCodex('[fake:ask]', { controlHandler: { canUseTool: (context) => void seen.push(context) } });
    await waitForStatus(w.store, session.id, ['need']);
    const request = seen[0]?.request;
    expect(request?.toolName).toBe('AskUserQuestion');
    expect(request?.input).toEqual({ questions: [{ question: 'Which color should the button be?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }], multiSelect: false }] });
    await w.supervisor.respond(session.id, request?.requestId ?? '', { behavior: 'allow', updatedInput: { ...request?.input, answers: { 'Which color should the button be?': 'Blue' } } });
    await waitForStatus(w.store, session.id, ['done']);
    expect((await codexLog(w.codexLog)).find((line) => line.kind === 'answers')?.answers).toEqual({ color: { answers: ['Blue'] } });
    expect((await w.store.events.list(session.id)).at(-1)?.payload).toMatchObject({ text: 'You chose Blue' });
  });

  it('Stop (D50): turn/interrupt, the "Stopped" line, idle; a message queued meanwhile comes back and never runs', async () => {
    const { w, session } = await startCodex('[fake:hold 20]');
    await waitForStatus(w.store, session.id, ['run']);
    await until(async () => (await rpcSent(w.codexLog)).some((message) => message['method'] === 'turn/start'), 'the turn');
    await w.supervisor.sendMessage(session.id, 'queued while it holds');
    const reply = await w.supervisor.interrupt(session.id);
    expect(reply.outcome).toBe('stopped');
    expect(reply.withdrawn).toEqual(['queued while it holds']);
    expect(reply.record.status).toBe('idle');
    const sent = await rpcSent(w.codexLog);
    expect(sent.filter((message) => message['method'] === 'turn/interrupt')).toHaveLength(1);
    expect(sent.filter((message) => message['method'] === 'turn/start')).toHaveLength(1);
    expect((await w.store.events.list(session.id)).some((event) => event.label === 'Stopped')).toBe(true);
  });

  it('pause and resume (D7): the app-server ends; Resume reopens the same thread (thread/resume) with "Continue."', async () => {
    const { w, session } = await startCodex('first');
    await waitForStatus(w.store, session.id, ['done']);
    const threadId = await w.store.providers.nativeId(session.id, 'codex');
    const paused = await w.supervisor.pause(session.id);
    expect(paused.status).toBe('paused');
    expect(w.supervisor.isLive(session.id)).toBe(false);
    await w.supervisor.resume(session.id);
    await waitForStatus(w.store, session.id, ['done']);
    const sent = await rpcSent(w.codexLog);
    expect(sent.find((message) => message['method'] === 'thread/resume')?.['params']).toMatchObject({ threadId, cwd: w.workspace, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    expect(sent.filter((message) => message['method'] === 'thread/start')).toHaveLength(1);
    const turns = sent.filter((message) => message['method'] === 'turn/start').map((message) => (message['params'] as { input: Array<{ text: string }> }).input[0]?.text);
    expect(turns).toEqual(['first', 'Continue.']);
    expect(await w.store.providers.nativeId(session.id, 'codex')).toBe(threadId);
  });

  it('a thread Codex cannot reopen: a new one starts, and the chat says so', async () => {
    const { w, session } = await startCodex('first');
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    await w.store.providers.rememberNative(session.id, 'codex', '00000000-0000-0000-0000-000000000000');
    await w.supervisor.sendMessage(session.id, 'again');
    await waitForStatus(w.store, session.id, ['done']);
    const notice = (await w.store.events.list(session.id)).find((event) => event.kind === 'error' && event.label.startsWith('Codex could not reopen its thread 00000000-'));
    expect(notice).toBeDefined();
    expect(await w.store.providers.nativeId(session.id, 'codex')).not.toBe('00000000-0000-0000-0000-000000000000');
  });

  it('model and effort (D31): a change while live applies to the next turn/start; checked against model/list', async () => {
    const { w, session } = await startCodex('first');
    await waitForStatus(w.store, session.id, ['done']);
    await expect(w.supervisor.setModel(session.id, { model: 'gpt-9' })).rejects.toMatchObject({ code: 'invalid-model' });
    const updated = await w.supervisor.setModel(session.id, { model: 'gpt-5.5-mini', effort: 'low' });
    expect(updated).toMatchObject({ model: 'gpt-5.5-mini', effort: 'low' });
    await w.supervisor.sendMessage(session.id, 'second');
    await waitForStatus(w.store, session.id, ['done']);
    const turns = (await rpcSent(w.codexLog)).filter((message) => message['method'] === 'turn/start').map((message) => message['params'] as Record<string, unknown>);
    expect(turns[0]).not.toHaveProperty('model');
    expect(turns[1]).toMatchObject({ model: 'gpt-5.5-mini', effort: 'low' });
  });

  it('a message written while a turn runs waits in the bridge (D44 queued), then starts its own turn', async () => {
    const { w, session } = await startCodex('[fake:hold 0.6]');
    await waitForStatus(w.store, session.id, ['run']);
    await w.supervisor.sendMessage(session.id, 'next one');
    const queued = await waitForEvent(w.store, session.id, (event) => payloadType(event) === 'user' && event.label === 'next one');
    expect(queued.payload).toMatchObject({ queued: 'turn' });
    await until(async () => (await w.store.events.list(session.id)).filter((event) => payloadType(event) === 'result').length === 2, 'two results', 15_000);
    const delivered = await w.store.events.get(queued.id);
    expect(delivered?.payload).not.toHaveProperty('queued');
    expect((await w.store.sessions.get(session.id))?.status).toBe('done');
  });

  it('a subagent (spawnAgent) is an Agent card; usage limits reach the supervisor; a failed turn is an error result', async () => {
    const usage: Array<{ sessionId: string; usage: ProviderUsage }> = [];
    world = await makeSupervisorWorld();
    const w = world;
    extra = new SessionSupervisor({ store: w.store, claudeCommand: [], providers: w.supervisor.cliRegistry, env: w.env, onProviderUsage: (sessionId, reading) => usage.push({ sessionId, usage: reading }) });
    const session = await extra.start({ ...newSession({ task: '[fake:subagent look around]' }), provider: 'codex' }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const agents = await w.store.agents.listBySession(session.id);
    expect(agents.map((agent) => [agent.kind, agent.description])).toEqual([
      ['main', null],
      ['subagent', 'look around'],
    ]);
    await until(async () => usage.length > 0, 'a usage reading');
    expect(usage[0]?.usage.windows.map((window) => [window.pct, window.minutes])).toEqual([
      [12, 300],
      [40, 10_080],
    ]);
    await extra.sendMessage(session.id, '[fake:fail the model is overloaded]');
    await until(async () => payloadType((await w.store.events.list(session.id)).at(-1) ?? ({ payload: null } as never)) === 'result' && (await w.store.events.list(session.id)).at(-1)?.kind === 'error', 'the failed result');
    expect((await w.store.events.list(session.id)).at(-1)?.payload).toMatchObject({ isError: true, errors: ['Codex: the model is overloaded'] });
  });

  it('PDFs are not inline for Codex; images go as data: URLs', async () => {
    const { w, session } = await startCodex('');
    await w.supervisor.sendMessage(session.id, 'look', 'user', {
      refs: [],
      blocks: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }],
      filesText: '',
    });
    await waitForStatus(w.store, session.id, ['done']);
    const turn = (await rpcSent(w.codexLog)).find((message) => message['method'] === 'turn/start');
    expect((turn?.['params'] as { input: unknown[] }).input).toEqual([
      { type: 'text', text: 'look', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
    ]);
    expect((await w.store.events.list(session.id)).at(-1)?.payload).toMatchObject({ text: '[fake-codex: 1 image]' });
  });

  it('Settings → CLIs reads the models without a session (initialize + model/list only)', async () => {
    world = await makeSupervisorWorld();
    const models = await listCodexModels(fakeCodexCommand(), world.env, world.root);
    expect(models?.map((model) => model['value'])).toEqual(['default', 'gpt-5.5-codex', 'gpt-5.5-mini']);
    const sent = await rpcSent(world.codexLog);
    expect(sent.map((message) => message['method'])).toEqual(['initialize', 'initialized', 'model/list']);
    expect(codexModels({ data: [{ id: 'x', model: 'x', hidden: true }] })).toBeNull();
  });
});
