import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LifecyclePayload, RequestPayload, ToolPayload, UserPayload } from '../../../src/core/event-payload.ts';
import { toAgent, toEvent } from '../../../src/server/sessions/wire.ts';
import type { CanUseToolContext } from '../../../src/server/supervisor/supervisor.ts';
import { subagentChat } from '../../../src/web/views/session/chat.ts';
import { BASELINE, delay, listTranscripts, readTranscript } from '../../helpers/fake-claude.ts';
import {
  type SupervisorWorld,
  makeSupervisorWorld,
  newSession,
  payloadType,
  readFakeLog,
  spawnedArgv,
  stdinOf,
  until,
  waitForEvent,
  waitForStatus,
} from '../../helpers/supervisor.ts';

let world: SupervisorWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

async function start(options: Parameters<typeof makeSupervisorWorld>[0], overrides: Parameters<typeof newSession>[0] = {}) {
  world = await makeSupervisorWorld(options);
  const session = await world.supervisor.start(newSession(overrides), world.place);
  return { w: world, session };
}

function lifecycle(events: ReadonlyArray<{ payload: unknown }>, action: string): LifecyclePayload | undefined {
  return events.map((e) => e.payload as LifecyclePayload).find((p) => p?.type === 'lifecycle' && p.action === action);
}

describe('SessionSupervisor · start (argv, env, cwd, first message)', () => {
  it('spawns the baseline argv with --session-id and --name, a scrubbed env, cwd = workspace root; the task is the first stdin line', async () => {
    const { w, session } = await start({
      scenario: 'multiturn',
      parentEnv: {
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SSE_PORT: '1234',
        CLAUDE_PID: '42',
        CLAUDE_EFFORT: 'high',
        CLAUDE_UNRELATED: 'kept',
      },
    });
    expect(session.pid).toBeGreaterThan(0);
    expect(session.status).toBe('run');
    expect(session.cwd).toBe(w.workspace);
    expect(session.requestedPermissionMode).toBe('auto');
    await waitForStatus(w.store, session.id, ['done']);

    const [spawned, ...more] = await spawnedArgv(w.logFile);
    expect(more).toHaveLength(0);
    expect(spawned?.pid).toBe(session.pid);
    expect(spawned?.argv).toEqual([
      ...BASELINE,
      '--session-id',
      session.claudeSessionId,
      '--name',
      'demo-session',
      '--forward-subagent-text',
      '--replay-user-messages',
    ]);
    expect(spawned?.cwd).toBe(w.workspace);
    expect(spawned?.claudeEnvKeys).toEqual(['CLAUDE_CONFIG_DIR', 'CLAUDE_UNRELATED']);
    expect(spawned?.env?.['CLAUDE_CONFIG_DIR']).toBe(w.configDir);
    const stdin = await stdinOf(w.logFile, spawned?.pid ?? -1);
    expect(stdin[0]).toEqual({ type: 'user', message: { role: 'user', content: newSession().task } });

    const stored = await w.store.sessions.get(session.id);
    expect(stored?.observedPermissionMode).toBe('auto');
    expect(stored?.cliVersion).toBe('2.1.283');
    expect(stored?.pid).toBe(session.pid);
    expect(w.supervisor.isLive(session.id)).toBe(true);
  });

  it('appends SWITCHBOARD_CLAUDE_EXTRA_ARGS flags last', async () => {
    const { w, session } = await start({ scenario: 'handoff-start', extraArgs: ['--model', 'haiku', '--max-turns', '3'] });
    await waitForStatus(w.store, session.id, ['done']);
    const [spawned] = await spawnedArgv(w.logFile);
    expect(spawned?.argv?.slice(-4)).toEqual(['--model', 'haiku', '--max-turns', '3']);
  });

  it('a missing CLI binary ends the session as fail with the reason', async () => {
    const { w, session } = await start({ command: [path.join('/nonexistent', 'claude-binary')] });
    await waitForStatus(w.store, session.id, ['fail']);
    const failed = await waitForEvent(w.store, session.id, (e) => e.kind === 'error');
    expect(failed.label).toMatch(/^Could not start claude: /);
    expect((await w.store.sessions.get(session.id))?.pid).toBeNull();
    expect(w.supervisor.isLive(session.id)).toBe(false);
  });
});

describe('SessionSupervisor · stream-json → typed events (gap #7, #8)', () => {
  it('multiturn: user, assistant and ok events per turn; replay = delivery ack; usage reading; transcript sync point', async () => {
    const { w, session } = await start({ scenario: 'multiturn' });
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.sendMessage(session.id, 'What code word did I ask you to remember? Reply with just the word.');
    await until(async () => (await w.store.events.list(session.id)).filter((e) => e.kind === 'ok').length === 2, 'two ok events');
    await waitForStatus(w.store, session.id, ['done']);

    const events = await w.store.events.list(session.id);
    expect(events.map((e) => [e.kind, payloadType(e), e.label])).toEqual([
      ['text', 'lifecycle', 'Started'],
      ['text', 'user', newSession().task],
      ['text', 'assistant', 'OK'],
      ['ok', 'result', 'OK'],
      ['text', 'user', 'What code word did I ask you to remember? Reply with just the word.'],
      ['text', 'assistant', 'zeppelin'],
      ['ok', 'result', 'zeppelin'],
    ]);
    const users = events.filter((e) => payloadType(e) === 'user');
    expect(users.map((e) => (e.payload as UserPayload).delivered)).toEqual([true, true]);
    expect(users.map((e) => (e.payload as UserPayload).origin)).toEqual(['task', 'user']);
    expect(users.every((e) => typeof e.uuid === 'string')).toBe(true);

    const agents = await w.store.agents.listBySession(session.id);
    expect(agents.map((a) => [a.kind, a.name, a.status])).toEqual([['main', 'acme-app-front', 'done']]);
    expect(events.filter((e) => payloadType(e) !== 'lifecycle').every((e) => e.agentId === agents[0]?.id)).toBe(true);

    const usage = await w.store.usage.latest();
    expect(usage).toMatchObject({ source: 'rate_limit_event', sessionId: session.id, fiveHourPct: 8, sevenDayPct: 17 });
    expect(usage?.fiveHourResetsAt).toBe(new Date(1790552400 * 1000).toISOString());

    const stored = await w.store.sessions.get(session.id);
    const [file] = await listTranscripts(w.configDir);
    const entries = await readTranscript(file as string);
    expect(entries.some((entry) => entry['uuid'] === stored?.lastTranscriptUuid && entry['type'] === 'assistant')).toBe(true);
    expect(stored?.lastActivityAt).not.toBeNull();
  });

  it('tool-use: Write and Bash are impl blocks closed by their tool_result, then ok', async () => {
    const { w, session } = await start({ scenario: 'tool-use' });
    await waitForStatus(w.store, session.id, ['done']);
    const events = (await w.store.events.list(session.id)).filter((e) => payloadType(e) !== 'lifecycle' && payloadType(e) !== 'user');
    expect(events.map((e) => [e.kind, payloadType(e)])).toEqual([
      ['impl', 'tool'],
      ['impl', 'tool'],
      ['text', 'assistant'],
      ['ok', 'result'],
    ]);
    const [write, bash] = events as [(typeof events)[0], (typeof events)[0]];
    expect(write.label).toBe('Write · out.txt');
    expect(bash.label).toMatch(/^Bash · /);
    for (const tool of [write, bash]) {
      const payload = tool.payload as ToolPayload;
      expect(tool.endTs).not.toBeNull();
      expect(tool.toolUseId).toBe(payload.toolUseId);
      expect(payload.isError).toBe(false);
      expect(typeof payload.result).toBe('string');
    }
    expect((write.payload as ToolPayload).input['file_path']).toBe(path.join(w.workspace, 'out.txt'));
  });

  it('subagent-forward: one agent per Agent call, its lines attributed to it, done after task_notification', async () => {
    const { w, session } = await start({ scenario: 'subagent-forward' }, { mode: 'orchestrator', solutions: ['acme-app-front', 'mobile'] });
    await waitForStatus(w.store, session.id, ['done']);
    const agents = await w.store.agents.listBySession(session.id);
    expect(agents.map((a) => [a.kind, a.name])).toEqual([
      ['main', 'orchestrator'],
      ['subagent', 'general-purpose'],
    ]);
    const [main, sub] = agents as [(typeof agents)[0], (typeof agents)[0]];
    expect(sub.description).toBe('Read hello.txt and return first line');
    expect(sub.subagentType).toBe('general-purpose');
    expect(sub.taskId).toMatch(/\S/);
    expect(sub.toolUseId).toMatch(/^toolu_/);
    expect(sub.status).toBe('done');
    expect(sub.endedAt).not.toBeNull();

    const events = await w.store.events.list(session.id);
    const byAgent = (id: string) => events.filter((e) => e.agentId === id).map((e) => [e.kind, payloadType(e)]);
    expect(byAgent(sub.id)).toEqual([
      ['text', 'agent-prompt'],
      ['text', 'assistant'],
      ['plan', 'tool'],
      ['text', 'assistant'],
    ]);
    const agentCall = events.find((e) => e.toolUseId === sub.toolUseId && payloadType(e) === 'tool');
    expect(agentCall?.agentId).toBe(main.id);
    expect(agentCall?.kind).toBe('tool');
    expect(agentCall?.label).toBe('Agent · general-purpose · Read hello.txt and return first line');
    expect(agentCall?.endTs).not.toBeNull();
    expect(events.at(-1)?.kind).toBe('ok');

    // D36: the wire agent carries its call's id, and its chat builds from the session's stored events
    // (the brief = the call's prompt, its own text and Read step, the call's result).
    expect(toAgent(sub).toolUseId).toBe((agentCall?.payload as ToolPayload).toolUseId);
    expect(toAgent(main).toolUseId).toBeNull();
    const chat = subagentChat(events.map(toEvent), [], toAgent(sub), agents.map(toAgent));
    expect(chat.brief).toBe('Read the file hello.txt in the current directory and reply with its first line only.');
    expect(chat.items.map((item) => (item.kind === 'agent' ? [item.text, item.steps.map((step) => `${step.mark} ${step.label}`)] : item.kind))).toEqual([
      ["I'll read the hello.txt file from the current directory.", ['✓ Read · hello.txt']],
      ['alpha line one', []],
    ]);
    expect(chat.result?.text).toContain('alpha line one');
    expect(chat.result?.isError).toBe(false);
  });

  it('perm-auto: auto silently reported as default → switched to acceptEdits (D6 fallback); the automatic denial is an ask event', async () => {
    const { w, session } = await start({ scenario: 'perm-auto' });
    await waitForStatus(w.store, session.id, ['done']);
    const events = await w.store.events.list(session.id);
    const mismatch = events.find((e) => payloadType(e) === 'mode-mismatch');
    expect(mismatch?.kind).toBe('text');
    expect(mismatch?.label).toBe('Auto mode is not available for this model: permissions use acceptEdits');
    expect(mismatch?.payload).toEqual({ type: 'mode-mismatch', requested: 'auto', observed: 'default', fallback: 'acceptEdits' });
    expect(events.filter((e) => payloadType(e) === 'mode-mismatch')).toHaveLength(1);
    expect((await w.store.sessions.get(session.id))?.requestedPermissionMode).toBe('acceptEdits');
    const stdin = await stdinOf(w.logFile, session.pid ?? -1);
    expect(stdin).toContainEqual(expect.objectContaining({ type: 'control_request', request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } }));
    const denied = events.find((e) => payloadType(e) === 'denied');
    expect(denied?.kind).toBe('ask');
    expect(denied?.label).toBe('Denied · Write');
    expect((await w.store.sessions.get(session.id))?.observedPermissionMode).toBe('default');
  });

  it('a model without auto mode: one switch to acceptEdits, later turns report it, no mismatch error (D6)', async () => {
    const { w, session } = await start({ scenario: 'multiturn', parentEnv: { FAKE_CLAUDE_AUTO_MODE: 'unsupported' } });
    await waitForStatus(w.store, session.id, ['done']);
    // The second turn's system/init shows the mode the switch set.
    await w.supervisor.sendMessage(session.id, 'What code word did I ask you to remember? Reply with just the word.');
    await waitForStatus(w.store, session.id, ['done']);
    const events = await w.store.events.list(session.id);
    const modeEvents = events.filter((e) => payloadType(e) === 'mode-mismatch');
    expect(modeEvents.map((e) => e.kind)).toEqual(['text']);
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(0);
    const stored = await w.store.sessions.get(session.id);
    expect(stored?.requestedPermissionMode).toBe('acceptEdits');
    expect(stored?.observedPermissionMode).toBe('acceptEdits');
  });

  it('written files become artifacts (CONTRACT at the root; DOC + DIFF inside a solution)', async () => {
    const { w, session } = await start({}, { task: 'Write the contract. [fake:write contracts/free-talk.md]' });
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.sendMessage(session.id, 'And the notes. [fake:write microfrontends/acme-app-front/docs/notes.md]');
    await until(async () => (await w.store.artifacts.list({ sessionId: session.id })).length === 3, 'three artifacts');
    const artifacts = await w.store.artifacts.list({ sessionId: session.id });
    const summary = artifacts.map((a) => [a.type, a.name, a.solution]).sort();
    expect(summary).toEqual([
      ['CONTRACT', 'contracts/free-talk.md', null],
      ['DIFF', 'docs · 1 file', 'acme-app-front'],
      ['DOC', 'docs/notes.md', 'acme-app-front'],
    ]);
    expect(await readFile(path.join(w.workspace, 'contracts', 'free-talk.md'), 'utf8')).toContain('fake-claude');
  });
});

describe('SessionSupervisor · questions (hand-off to M3.1)', () => {
  it('ask-2q: the request makes the session need; the reply written through respond() lets the turn finish', async () => {
    const seen: CanUseToolContext[] = [];
    const { w, session } = await start({ scenario: 'ask-2q', controlHandler: { canUseTool: (context) => void seen.push(context) } });
    const needing = await waitForStatus(w.store, session.id, ['need']);
    expect(needing.status).toBe('need');
    expect(seen).toHaveLength(1);
    const request = seen[0]?.request;
    expect(request?.toolName).toBe('AskUserQuestion');
    const questions = request?.input['questions'] as Array<{ question: string }>;
    expect(questions.map((q) => q.question)).toEqual(['Which color should the button be?', 'Which size should it be?']);

    const ask = await waitForEvent(w.store, session.id, (e) => e.kind === 'ask');
    expect(ask.label).toBe('2 questions · Which color should the button be?');
    expect(ask.payload).toMatchObject({ type: 'tool', name: 'AskUserQuestion', requestId: request?.requestId, requestState: 'open' });

    const answers = { 'Which color should the button be?': 'Green', 'Which size should it be?': 'Small' };
    await w.supervisor.respond(session.id, request?.requestId ?? '', { behavior: 'allow', updatedInput: { ...request?.input, answers } });
    await waitForStatus(w.store, session.id, ['done']);
    const events = await w.store.events.list(session.id);
    expect((events.find((e) => e.id === ask.id)?.payload as ToolPayload).requestState).toBe('responded');
    expect(events.at(-1)?.label).toBe('You chose a green button in small size.');
    const stdin = await stdinOf(w.logFile, session.pid ?? -1);
    expect(stdin[1]).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: request?.requestId, response: { behavior: 'allow', updatedInput: { ...request?.input, answers } } },
    });
    await expect(w.supervisor.respond(session.id, request?.requestId ?? '', { behavior: 'deny', message: 'no' })).rejects.toMatchObject({
      code: 'request-not-open',
    });
  });

  it('perm-allow: a permission request is its own ask event, attributed and answered', async () => {
    const seen: CanUseToolContext[] = [];
    const { w, session } = await start({ scenario: 'perm-allow', controlHandler: { canUseTool: (context) => void seen.push(context) } });
    await waitForStatus(w.store, session.id, ['need']);
    const ask = await waitForEvent(w.store, session.id, (e) => payloadType(e) === 'request');
    const payload = ask.payload as RequestPayload;
    expect(ask.kind).toBe('ask');
    expect(payload).toMatchObject({ toolName: 'Bash', state: 'open', agentId: null });
    expect(payload.decisionReason).toMatch(/\S/);
    await w.supervisor.respond(session.id, payload.requestId, { behavior: 'allow', updatedInput: seen[0]?.request.input ?? {} });
    await waitForStatus(w.store, session.id, ['done']);
    expect(((await w.store.events.get(ask.id))?.payload as RequestPayload)).toMatchObject({ state: 'responded', behavior: 'allow' });
  });

  it('ask-interrupt: pausing with a question open cancels it (never answered) and ends paused (exit 1)', async () => {
    const cancelled: string[] = [];
    const orphaned: string[] = [];
    const { w, session } = await start({
      scenario: 'ask-interrupt',
      controlHandler: { cancelled: (_s, id) => void cancelled.push(id), orphaned: (_s, ids) => void orphaned.push(...ids) },
    });
    await waitForStatus(w.store, session.id, ['need']);
    const ask = await waitForEvent(w.store, session.id, (e) => e.kind === 'ask');
    const requestId = (ask.payload as ToolPayload).requestId;
    const paused = await w.supervisor.pause(session.id);
    expect(paused.status).toBe('paused');
    expect(cancelled).toEqual([requestId]);
    expect(orphaned).toEqual([]);
    const events = await w.store.events.list(session.id);
    expect((events.find((e) => e.id === ask.id)?.payload as ToolPayload).requestState).toBe('cancelled');
    expect(lifecycle(events, 'paused')?.code).toBe(1);
    const stdin = await stdinOf(w.logFile, session.pid ?? -1);
    expect(stdin.some((line) => line['type'] === 'control_response')).toBe(false);
  });
});

describe('SessionSupervisor · pause / resume (D7)', () => {
  it('pause while idle (handoff-start): interrupt → ack → EOF → exit 0 → paused', async () => {
    const { w, session } = await start({ scenario: 'handoff-start' });
    await waitForStatus(w.store, session.id, ['done']);
    const paused = await w.supervisor.pause(session.id);
    expect(paused).toMatchObject({ status: 'paused', pid: null, stopReason: null, attached: true });
    expect(w.supervisor.isLive(session.id)).toBe(false);
    const events = await w.store.events.list(session.id);
    expect(lifecycle(events, 'paused')).toMatchObject({ code: 0, signal: null, stoppedBy: 'eof', pid: session.pid });
    const stdin = await stdinOf(w.logFile, session.pid ?? -1);
    expect(stdin.at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
    expect((await w.store.agents.listBySession(session.id))[0]?.status).toBe('paused');
  });

  it('pause mid-tool (handoff-midturn): the rejected tool closes, no result event, exit 1 → paused', async () => {
    const { w, session } = await start({ scenario: 'handoff-midturn' });
    const bash = await waitForEvent(w.store, session.id, (e) => e.kind === 'impl');
    expect((await w.store.sessions.get(session.id))?.status).toBe('run');
    const paused = await w.supervisor.pause(session.id);
    expect(paused.status).toBe('paused');
    const events = await w.store.events.list(session.id);
    expect(lifecycle(events, 'paused')).toMatchObject({ code: 1, stoppedBy: 'eof' });
    expect((events.find((e) => e.id === bash.id)?.payload as ToolPayload).isError).toBe(true);
    expect(events.some((e) => payloadType(e) === 'result')).toBe(false);
  });

  it('resume spawns --resume with the same id (+ --permission-mode, --name) and sends "Continue."', async () => {
    const { w, session } = await start({ scenario: 'handoff-start' });
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    const resumed = await w.supervisor.resume(session.id);
    expect(resumed.status).toBe('run');
    expect(resumed.claudeSessionId).toBe(session.claudeSessionId);
    await waitForStatus(w.store, session.id, ['done']);
    const spawns = await spawnedArgv(w.logFile);
    expect(spawns).toHaveLength(2);
    const second = spawns[1];
    expect(second?.argv).toEqual([
      ...BASELINE,
      '--resume',
      session.claudeSessionId,
      '--name',
      'demo-session',
      '--forward-subagent-text',
      '--replay-user-messages',
    ]);
    expect(second?.pid).toBe(resumed.pid);
    const stdin = await stdinOf(w.logFile, second?.pid ?? -1);
    expect(stdin[0]).toEqual({ type: 'user', message: { role: 'user', content: 'Continue.' } });
    const events = await w.store.events.list(session.id);
    const continued = events.find((e) => payloadType(e) === 'user' && (e.payload as UserPayload).origin === 'resume');
    expect(continued?.label).toBe('Continue.');
    expect((await listTranscripts(w.configDir))).toHaveLength(1);
    await expect(w.supervisor.resume(session.id)).rejects.toMatchObject({ code: 'already-running' });
  });

  it('crash: an exit Switchboard did not ask for ends the session as fail', async () => {
    const { w, session } = await start({ scenario: 'crash' });
    const failed = await waitForStatus(w.store, session.id, ['fail']);
    expect(failed.pid).toBeNull();
    expect(failed.endedAt).not.toBeNull();
    const events = await w.store.events.list(session.id);
    const error = events.find((e) => e.kind === 'error');
    expect(error?.label).toBe('claude exited unexpectedly (code 1)');
    expect((error?.payload as LifecyclePayload).stderr).toContain('simulated crash');
    expect(w.supervisor.isLive(session.id)).toBe(false);
  });

  it('a message to a paused session resumes it with that message instead of "Continue."', async () => {
    const { w, session } = await start({ scenario: 'handoff-start' });
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    await w.supervisor.sendMessage(session.id, 'Hello again.');
    await waitForStatus(w.store, session.id, ['done']);
    const spawns = await spawnedArgv(w.logFile);
    expect(spawns[1]?.argv).toContain('--resume');
    const stdin = await stdinOf(w.logFile, spawns[1]?.pid ?? -1);
    expect(stdin[0]).toEqual({ type: 'user', message: { role: 'user', content: 'Hello again.' } });
  });

  it('escalates SIGINT → SIGTERM when the process ignores the interrupt and EOF; still paused', async () => {
    const script = [
      "process.on('SIGINT', () => {});",
      "process.stdin.on('data', () => {});",
      "process.stdin.on('end', () => {});",
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const { w, session } = await start({
      command: [process.execPath, '-e', script, '--'],
      timeouts: { ack: 200, result: 200, exit: 300, signal: 400 },
    });
    expect(session.status).toBe('run');
    const paused = await w.supervisor.pause(session.id);
    expect(paused.status).toBe('paused');
    const events = await w.store.events.list(session.id);
    expect(lifecycle(events, 'paused')).toMatchObject({ stoppedBy: 'SIGTERM', signal: 'SIGTERM' });
  });

  it('answers a control request subtype it does not handle with an error reply', async () => {
    const script = [
      "const fs = require('node:fs');",
      `process.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'cli-1', request: { subtype: 'hook_callback' } }) + '\\n');`,
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (d) => fs.appendFileSync(process.env.STUB_LOG, d));",
      "process.stdin.on('end', () => process.exit(0));",
    ].join(' ');
    world = await makeSupervisorWorld({ command: [process.execPath, '-e', script, '--'] });
    world.env['STUB_LOG'] = path.join(world.root, 'stub.log');
    const w = world;
    const session = await w.supervisor.start(newSession({ task: '' }), w.place);
    const logged = await until(async () => {
      const text = await readFile(path.join(w.root, 'stub.log'), 'utf8').catch(() => '');
      return text.includes('cli-1') ? text : undefined;
    }, 'the error reply');
    // D24: the first line is the `initialize` handshake the stub never answers; the error reply follows.
    const lines = logged.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize', hooks: null } });
    expect(lines.find((line) => line['type'] === 'control_response')).toEqual({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'cli-1', error: 'Switchboard does not handle control request subtype "hook_callback"' },
    });
    expect((await w.store.sessions.get(session.id))?.status).toBe('idle');
  });
});

describe('SessionSupervisor · shutdown', () => {
  it('stops live processes but keeps their stored status (for the restart, M2.4)', async () => {
    const { w, session } = await start({ scenario: 'hang' });
    await waitForEvent(w.store, session.id, (e) => payloadType(e) === 'user' && (e.payload as UserPayload).delivered);
    expect((await w.store.sessions.get(session.id))?.status).toBe('run');
    await w.supervisor.shutdown();
    const stored = await w.store.sessions.get(session.id);
    expect(stored).toMatchObject({ status: 'run', pid: null });
    expect(lifecycle(await w.store.events.list(session.id), 'stopped')).toBeDefined();
    await expect(w.supervisor.start(newSession({ name: 'another' }), w.place)).rejects.toMatchObject({ code: 'closing' });
    await delay(10);
    expect((await readFakeLog(w.logFile)).filter((l) => l.kind === 'argv')).toHaveLength(1);
  });
});
