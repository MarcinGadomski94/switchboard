import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolPayload } from '../../../src/core/event-payload.ts';
import { configContent, listOpencodeModels, opencodeModels, opencodeToolInput } from '../../../src/server/cli/opencode/bridge.ts';
import { runCommand } from '../../../src/server/exec.ts';
import type { CanUseToolContext } from '../../../src/server/supervisor/supervisor.ts';
import { fakeOpencodeCommand } from '../../../tools/fake-opencode/command.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, payloadType, until, waitForStatus } from '../../helpers/supervisor.ts';

let world: SupervisorWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

interface OpencodeLogLine {
  readonly kind: string;
  readonly pid: number;
  readonly argv?: string[];
  readonly env?: Record<string, string>;
  readonly method?: string;
  readonly path?: string;
  readonly query?: Record<string, string>;
  readonly auth?: string | null;
  readonly body?: Record<string, unknown>;
  readonly reply?: string;
  readonly message?: string | null;
  readonly answers?: unknown;
  readonly rejected?: boolean;
}

async function opencodeLog(file: string): Promise<OpencodeLogLine[]> {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as OpencodeLogLine);
}

async function prompts(file: string): Promise<Array<Record<string, unknown>>> {
  return (await opencodeLog(file)).filter((line) => line.kind === 'prompt').map((line) => line.body ?? {});
}

async function startOpencode(task: string, options: Parameters<typeof makeSupervisorWorld>[0] = {}) {
  world = await makeSupervisorWorld(options);
  const session = await world.supervisor.start({ ...newSession({ task }), provider: 'opencode' }, world.place);
  return { w: world, session };
}

describe('D62 · OpenCode through the bridge (fake-opencode)', () => {
  it('runs `opencode serve` on a loopback port with a password, opens a session in the cwd, chats: the reply, the result, the models, the meter', async () => {
    const { w, session } = await startOpencode('Say OK.');
    expect(session.provider).toBe('opencode');
    const done = await waitForStatus(w.store, session.id, ['done']);
    expect(done.cliVersion).toBe('opencode 1.18.34');
    const log = await opencodeLog(w.opencodeLog);
    const argv = log.find((line) => line.kind === 'argv')?.argv ?? [];
    expect(argv.slice(0, 4)).toEqual(['serve', '--hostname', '127.0.0.1', '--port']);
    expect(Number(argv[4])).toBeGreaterThan(0);
    // D6 equivalent: edits allowed, the rest asks; HTTP Basic on every request; the project folder on every route.
    expect(JSON.parse(log.find((line) => line.kind === 'argv')?.env?.['OPENCODE_CONFIG_CONTENT'] ?? '{}')).toEqual({ permission: { edit: 'allow', bash: 'ask', webfetch: 'ask', external_directory: 'ask' } });
    const http = log.filter((line) => line.kind === 'http');
    expect(http.every((line) => line.auth === 'basic')).toBe(true);
    expect(http.every((line) => line.query?.['directory'] === w.workspace)).toBe(true);
    expect(http.map((line) => `${line.method} ${line.path}`)).toEqual(expect.arrayContaining(['GET /event', 'POST /session', 'GET /config/providers']));
    expect(await prompts(w.opencodeLog)).toEqual([{ parts: [{ type: 'text', text: 'Say OK.' }] }]);
    const sessionId = await w.store.providers.nativeId(session.id, 'opencode');
    expect(sessionId).toMatch(/^ses_/);
    const events = await w.store.events.list(session.id);
    expect(events.find((event) => payloadType(event) === 'user')?.payload).toMatchObject({ delivered: true });
    expect(events.at(-1)?.payload).toMatchObject({ type: 'result', isError: false, text: 'OK' });
    // The prompt's own echo is never shown as the agent's text.
    expect(events.filter((event) => event.label === 'Say OK.')).toHaveLength(1);
    expect(done.modelOptions?.map((option) => [option.value, option.efforts ?? []])).toEqual([
      ['default', ['high', 'max']],
      ['anthropic/claude-sonnet-5', ['high', 'max']],
      ['openai/gpt-5.5', ['low', 'medium', 'high']],
    ]);
    expect((await w.store.sessions.get(session.id))?.context).toMatchObject({ tokens: 18_000 });
    expect(w.errors).toEqual([]);
  });

  it('tool steps and permission: a write is a Write step (allowed); a shell command asks: Allow once → once, Always → always, Deny → reject with the message', async () => {
    const seen: CanUseToolContext[] = [];
    const { w, session } = await startOpencode('[fake:write docs/a.md]', { controlHandler: { canUseTool: (context) => void seen.push(context) } });
    await waitForStatus(w.store, session.id, ['done']);
    const write = (await w.store.events.list(session.id)).filter((event) => payloadType(event) === 'tool').map((event) => event.payload as ToolPayload);
    expect(write.map((tool) => [tool.name, tool.input['file_path'], tool.result])).toEqual([['Write', path.join(w.workspace, 'docs', 'a.md'), 'Wrote file successfully.']]);
    expect(await readFile(path.join(w.workspace, 'docs', 'a.md'), 'utf8')).toBe('written by fake-opencode\n');

    await w.supervisor.sendMessage(session.id, '[fake:approve-cmd npm test]');
    await waitForStatus(w.store, session.id, ['need']);
    const request = seen[0]?.request;
    expect(request).toMatchObject({ toolName: 'Bash', input: { command: 'npm test', patterns: ['npm test'] }, hookSuggestions: [{ type: 'opencode', reply: 'always', patterns: ['npm test*'] }] });
    await w.supervisor.respond(session.id, request?.requestId ?? '', { behavior: 'allow', updatedInput: request?.input ?? {}, updatedPermissions: request?.hookSuggestions ?? [] });
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.sendMessage(session.id, '[fake:approve-cmd rm -rf /]');
    await until(async () => seen.length === 2, 'the second request');
    await w.supervisor.respond(session.id, seen[1]?.request.requestId ?? '', { behavior: 'deny', message: 'not that' });
    await waitForStatus(w.store, session.id, ['done']);
    const replies = (await opencodeLog(w.opencodeLog)).filter((line) => line.kind === 'permission-reply').map((line) => [line.reply, line.message]);
    expect(replies).toEqual([
      ['always', null],
      ['reject', 'not that'],
    ]);
    expect((await w.store.events.list(session.id)).at(-1)?.payload).toMatchObject({ text: 'the command was rejected' });
  });

  it('question: question.asked is a question batch; the answer goes back as labels per question', async () => {
    const seen: CanUseToolContext[] = [];
    const { w, session } = await startOpencode('[fake:ask]', { controlHandler: { canUseTool: (context) => void seen.push(context) } });
    await waitForStatus(w.store, session.id, ['need']);
    const request = seen[0]?.request;
    expect(request?.toolName).toBe('AskUserQuestion');
    await w.supervisor.respond(session.id, request?.requestId ?? '', { behavior: 'allow', updatedInput: { ...request?.input, answers: { 'Which color should the button be?': 'Red' } } });
    await waitForStatus(w.store, session.id, ['done']);
    expect((await opencodeLog(w.opencodeLog)).find((line) => line.kind === 'question-reply')?.answers).toEqual([['Red']]);
    expect((await w.store.events.list(session.id)).at(-1)?.payload).toMatchObject({ text: 'You chose Red' });
  });

  it('Stop (D50): abort → the "Stopped" line, idle; a queued message comes back and never runs', async () => {
    const { w, session } = await startOpencode('[fake:hold 20]');
    await until(async () => (await prompts(w.opencodeLog)).length === 1, 'the prompt');
    await w.supervisor.sendMessage(session.id, 'queued meanwhile');
    const reply = await w.supervisor.interrupt(session.id);
    expect(reply.outcome).toBe('stopped');
    expect(reply.withdrawn).toEqual(['queued meanwhile']);
    expect(reply.record.status).toBe('idle');
    expect((await opencodeLog(w.opencodeLog)).filter((line) => line.kind === 'http' && line.path?.endsWith('/abort'))).toHaveLength(1);
    expect(await prompts(w.opencodeLog)).toHaveLength(1);
    expect((await w.store.events.list(session.id)).some((event) => event.label === 'Stopped')).toBe(true);
  });

  it('pause and resume (D7): the server ends (SIGTERM); Resume reopens the same OpenCode session with "Continue."', async () => {
    const { w, session } = await startOpencode('first');
    await waitForStatus(w.store, session.id, ['done']);
    const sessionId = await w.store.providers.nativeId(session.id, 'opencode');
    expect((await w.supervisor.pause(session.id)).status).toBe('paused');
    await w.supervisor.resume(session.id);
    await waitForStatus(w.store, session.id, ['done']);
    const log = await opencodeLog(w.opencodeLog);
    expect(log.filter((line) => line.kind === 'argv')).toHaveLength(2);
    expect(log.filter((line) => line.kind === 'http' && line.method === 'POST' && line.path === '/session')).toHaveLength(1);
    expect(log.some((line) => line.kind === 'http' && line.method === 'GET' && line.path === `/session/${sessionId}`)).toBe(true);
    expect((await prompts(w.opencodeLog)).map((body) => (body['parts'] as Array<{ text: string }>)[0]?.text)).toEqual(['first', 'Continue.']);
  });

  it('model and effort: provider/model and its variant go with the next prompt', async () => {
    const { w, session } = await startOpencode('first');
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.setModel(session.id, { model: 'openai/gpt-5.5', effort: 'high' });
    await w.supervisor.sendMessage(session.id, 'second');
    await waitForStatus(w.store, session.id, ['done']);
    const sent = await prompts(w.opencodeLog);
    expect(sent[1]).toMatchObject({ model: { providerID: 'openai', modelID: 'gpt-5.5' }, variant: 'high' });
    expect(sent[0]).not.toHaveProperty('model');
    // The context window follows the model (limit.context).
    expect(Object.values((await w.store.sessions.get(session.id))?.context?.windows ?? {})).toContain(400_000);
  });

  it('a subagent (task) is an Agent card with its child session\'s lines; images and PDFs go as file parts; a failure is an error result', async () => {
    const { w, session } = await startOpencode('[fake:subagent find the config]');
    await waitForStatus(w.store, session.id, ['done']);
    const agents = await w.store.agents.listBySession(session.id);
    expect(agents.map((agent) => [agent.kind, agent.description])).toEqual([
      ['main', null],
      ['subagent', 'fake subagent'],
    ]);
    const sub = agents.find((agent) => agent.kind === 'subagent');
    const subEvents = (await w.store.events.list(session.id)).filter((event) => event.agentId === sub?.id);
    expect(subEvents.map((event) => event.label)).toContain('fake-opencode: the subagent looked around');

    await w.supervisor.sendMessage(session.id, 'look', 'user', {
      refs: [],
      blocks: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' }, title: 'spec.pdf' },
      ],
      filesText: '',
    });
    await waitForStatus(w.store, session.id, ['done']);
    expect((await prompts(w.opencodeLog)).at(-1)?.['parts']).toEqual([
      { type: 'text', text: 'look' },
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=', filename: 'image-1' },
      { type: 'file', mime: 'application/pdf', url: 'data:application/pdf;base64,JVBERi0=', filename: 'spec.pdf' },
    ]);
    await w.supervisor.sendMessage(session.id, '[fake:fail rate limited]');
    await until(async () => (await w.store.events.list(session.id)).at(-1)?.kind === 'error', 'the failed result');
    expect((await w.store.events.list(session.id)).at(-1)?.payload).toMatchObject({ isError: true, errors: ['OpenCode: rate limited'] });
  });

  it('an event stream cut mid-prompt reconnects; the prompt still ends with its result', async () => {
    const { w, session } = await startOpencode('[fake:hold 2.5]');
    await until(async () => (await prompts(w.opencodeLog)).length === 1, 'the prompt');
    const port = (await opencodeLog(w.opencodeLog)).find((line) => line.kind === 'argv')?.argv?.[4];
    expect((await fetch(`http://127.0.0.1:${port}/__fake/cut-events`, { method: 'POST' })).status).toBe(200);
    await waitForStatus(w.store, session.id, ['done'], 15_000);
    expect((await w.store.events.list(session.id)).at(-1)?.payload).toMatchObject({ type: 'result', text: 'OK' });
    expect((await opencodeLog(w.opencodeLog)).filter((line) => line.kind === 'http' && line.path === '/event').length).toBeGreaterThanOrEqual(2);
  });

  it('a session OpenCode cannot reopen: a new one starts, and the chat says so', async () => {
    const { w, session } = await startOpencode('first');
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    await w.store.providers.rememberNative(session.id, 'opencode', 'ses_gone');
    await w.supervisor.sendMessage(session.id, 'again');
    await waitForStatus(w.store, session.id, ['done']);
    expect((await w.store.events.list(session.id)).some((event) => event.kind === 'error' && event.label.startsWith('OpenCode could not reopen its session ses_gone'))).toBe(true);
  });

  it('helpers: the permission config merges into an existing OPENCODE_CONFIG_CONTENT; tool inputs in Claude Code names; models from /config/providers and `opencode models`', async () => {
    expect(JSON.parse(configContent('{"model":"x","permission":{"read":"deny","bash":"allow"}}'))).toEqual({ model: 'x', permission: { read: 'deny', bash: 'ask', edit: 'allow', webfetch: 'ask', external_directory: 'ask' } });
    expect(JSON.parse(configContent('not json'))).toEqual({ permission: { edit: 'allow', bash: 'ask', webfetch: 'ask', external_directory: 'ask' } });
    expect(opencodeToolInput('edit', { filePath: '/a', oldString: 'x' })).toEqual({ file_path: '/a', oldString: 'x' });
    expect(opencodeToolInput('task', { description: 'd', prompt: 'p', subagent_type: 'general' })).toEqual({ description: 'd', prompt: 'p', subagent_type: 'general' });
    expect(opencodeModels({ providers: [] })).toBeNull();
    world = await makeSupervisorWorld();
    expect((await listOpencodeModels(fakeOpencodeCommand(), world.env, world.root, runCommand))?.map((model) => model['value'])).toEqual(['default', 'anthropic/claude-sonnet-5', 'openai/gpt-5.5']);
  });
});
