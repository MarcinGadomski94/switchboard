import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem, Session, SessionDetail, TerminalSession } from '../../../src/core/api.ts';
import type { TerminalAgentRow } from '../../../src/core/hooks.ts';
import { buildApp, createSessionServices } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HookService } from '../../../src/server/hooks/service.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { HOOK_TOKEN_FILE, generateToken, loadOrCreateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { assistantTextLine, lastUuid, ndjson, terminalUserLine, writeTranscript } from '../../helpers/transcripts.ts';

/**
 * D48 P4 over the real routes (`inject`): a fake terminal session (a `claude
 * agents --json` row + a transcript under a temp CLAUDE_CONFIG_DIR) and the hook
 * script's calls simulated against `/hook/v1/*` with the hook token. Covers
 * hooking, the transcript chat, exactly-once delivery (the spike's runaway made
 * impossible), the rate limit, holding while a turn runs, permissions (Allow once,
 * Always allow, Deny with a message), AskUserQuestion, "answered in the terminal",
 * Switchboard's own sessions ignored, and the hook token guard.
 */

const PORT = 4961;
const HOST = `127.0.0.1:${PORT}`;
const CS = '0b7c3e0a-1111-4222-8333-944455556666';

interface Rig {
  readonly root: string;
  readonly store: Store;
  readonly app: FastifyInstance;
  readonly hooks: HookService;
  readonly token: string;
  readonly hookToken: string;
  readonly configDir: string;
  readonly cwd: string;
  rows: TerminalAgentRow[];
  transcript: string;
  lines: Record<string, unknown>[];
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.app.close();
  await rig?.store.close();
  if (rig) await removeTempDir(rig.root);
  rig = undefined;
});

async function setup(limit = { max: 3, windowMs: 60_000 }): Promise<Rig> {
  const root = await makeTempDir('hooks');
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'claude-config');
  const cwd = path.join(root, 'project');
  await mkdir(cwd, { recursive: true });
  await mkdir(configDir, { recursive: true });
  const store = await openTempStore(dataDir);
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: dataDir }, platform: 'linux', home: root, cwd: root }), port: PORT };
  const bus = new HubBus();
  const { supervisor, questions } = createSessionServices(config, store, bus);
  const hookToken = await loadOrCreateToken(dataDir, HOOK_TOKEN_FILE);
  const holder: { rows: TerminalAgentRow[] } = { rows: [] };
  const hooks = new HookService({
    config,
    store,
    bus,
    questions,
    hookTokenFile: path.join(dataDir, HOOK_TOKEN_FILE),
    env: { CLAUDE_CONFIG_DIR: configDir },
    listAgents: async () => holder.rows,
    cliVersion: async () => '2.1.284 (Claude Code)',
    limit,
  });
  const token = generateToken();
  const app = await buildApp({ config, token, store, webRoot: root, supervisor, questions, bus, hooks, hookToken });
  await app.ready();
  // Install hooks into the temp config dir (CLI 2.1.284: the internal rewake fields, so the waiter's text is the message itself).
  const installed = await app.inject({ method: 'POST', url: '/api/hooks/install', headers: { host: HOST, cookie: `sb_token=${token}` } });
  expect(installed.json()).toMatchObject({ state: 'installed', rewake: 'internal', settingsPath: path.join(configDir, 'settings.json') });
  const lines = [
    terminalUserLine({ sessionId: CS, cwd, content: 'Fix the flaky test.', parentUuid: null, timestamp: '2026-09-29T10:00:00.000Z' }),
  ];
  lines.push(assistantTextLine({ sessionId: CS, cwd, text: 'Looking at it.', parentUuid: lastUuid(lines), timestamp: '2026-09-29T10:00:05.000Z' }));
  const transcript = await writeTranscript(configDir, cwd, CS, lines);
  const r: Rig = { root, store, app, hooks, token, hookToken, configDir, cwd, rows: [], transcript, lines };
  Object.defineProperty(r, 'rows', { get: () => holder.rows, set: (value: TerminalAgentRow[]) => (holder.rows = value) });
  r.rows = [{ pid: process.pid, sessionId: CS, cwd, kind: 'interactive', name: 'flaky-fix', status: 'idle', waitingFor: null, startedAt: Date.parse('2026-09-29T09:59:00.000Z') }];
  rig = r;
  return r;
}

function api(r: Rig, method: InjectOptions['method'], url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return r.app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${r.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

/** A hook script's call (`kind`) for the terminal session, with `event` as the hook input. */
function hookCall(r: Rig, kind: 'event' | 'permission' | 'waiter', event: Record<string, unknown>, entrypoint = 'cli'): Promise<LightMyRequestResponse> {
  return r.app.inject({
    method: 'POST',
    url: `/hook/v1/${kind}`,
    headers: { host: HOST, authorization: `Bearer ${r.hookToken}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ event: { session_id: CS, cwd: r.cwd, transcript_path: r.transcript, ...event }, claudePid: process.pid, entrypoint }),
  });
}

/** `true` when `promise` settles within `ms`. */
async function settles(promise: Promise<unknown>, ms = 150): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
}

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function hookIn(r: Rig): Promise<Session> {
  const listed = await api(r, 'GET', '/api/terminal-sessions');
  expect(listed.statusCode).toBe(200);
  expect((listed.json() as TerminalSession[]).map((row) => row.id)).toEqual([CS]);
  const hooked = await api(r, 'POST', `/api/terminal-sessions/${CS}/hook`);
  expect(hooked.statusCode).toBe(201);
  return hooked.json() as Session;
}

/** Appends lines to the transcript (the terminal's turn). */
async function append(r: Rig, ...lines: Record<string, unknown>[]): Promise<void> {
  r.lines.push(...lines);
  await appendFile(r.transcript, ndjson(lines));
}

describe('D48 P4 hooking a terminal session', () => {
  it('lists it (Switchboard\'s own sessions left out), hooks it, and imports its chat from the transcript', async () => {
    const r = await setup();
    // A Switchboard-supervised process on this machine: its hooks are answered at once and it is never listed.
    expect((await hookCall(r, 'waiter', { hook_event_name: 'SessionStart', session_id: 'sdk-session' }, 'sdk-cli')).statusCode).toBe(204);
    const session = await hookIn(r);
    expect(session).toMatchObject({ hooked: true, origin: 'terminal', title: 'flaky-fix', status: 'idle', claudeSessionId: CS });
    const detail = (await api(r, 'GET', `/api/sessions/${session.id}`)).json() as SessionDetail;
    expect(detail.events.map((event) => (event.payload as { text?: string }).text)).toEqual(['Fix the flaky test.', 'Looking at it.']);
    // Hooking again is the same session.
    expect((await api(r, 'POST', `/api/terminal-sessions/${CS}/hook`)).statusCode).toBe(200);
    expect(((await api(r, 'GET', '/api/terminal-sessions')).json() as TerminalSession[])[0]).toMatchObject({ hooked: true, sessionId: session.id });
    // What hooks cannot do.
    // D50: Stop (interrupt) and the background-task stop too.
    for (const [method, route] of [['POST', 'pause'], ['POST', 'resume'], ['PUT', 'model'], ['PUT', 'remote'], ['POST', 'detach'], ['POST', 'attach'], ['POST', 'interrupt'], ['POST', 'background/stop']] as const) {
      const answer = await api(r, method, `/api/sessions/${session.id}/${route}`, method === 'PUT' ? (route === 'model' ? { model: 'opus' } : { enabled: true }) : undefined);
      expect(answer.statusCode, route).toBe(409);
      expect(answer.json()).toMatchObject({ error: 'hooked-unavailable' });
    }
    expect((await api(r, 'POST', `/api/sessions/${session.id}/interrupt`)).json()).toEqual({
      error: 'hooked-unavailable',
      message: 'Stop stays in the terminal (Esc there): hooks cannot interrupt a turn of a process Switchboard does not run.',
    });
    // A turn on the PC: the hook events bring the new lines in.
    await append(r, terminalUserLine({ sessionId: CS, cwd: r.cwd, content: 'Now run it.', parentUuid: lastUuid(r.lines), timestamp: '2026-09-29T10:01:00.000Z' }));
    await hookCall(r, 'event', { hook_event_name: 'UserPromptSubmit' });
    await until('running', async () => ((await api(r, 'GET', `/api/sessions/${session.id}`)).json() as SessionDetail).status === 'run');
    await append(r, assistantTextLine({ sessionId: CS, cwd: r.cwd, text: 'All green.', parentUuid: lastUuid(r.lines), timestamp: '2026-09-29T10:01:09.000Z' }));
    await hookCall(r, 'event', { hook_event_name: 'Stop' });
    const after = await until('the new turn imported', async () => {
      const d = (await api(r, 'GET', `/api/sessions/${session.id}`)).json() as SessionDetail;
      return d.events.length === 4 && d.status === 'idle' ? d : null;
    });
    expect(after.events.map((event) => (event.payload as { text?: string }).text)).toEqual(['Fix the flaky test.', 'Looking at it.', 'Now run it.', 'All green.']);
  });
});

describe('D48 P4 hooked subagents (ruling D48-hooked-subagents)', () => {
  it('imports each plain subagent (agent-*.jsonl + .meta.json) as an agent with its chat; done once its file ends its turn; workflow files are left to D51', async () => {
    const r = await setup();
    const session = await hookIn(r);
    const dir = path.join(path.dirname(r.transcript), CS, 'subagents');
    await mkdir(path.join(dir, 'workflows', 'run-1'), { recursive: true });
    await writeFile(path.join(dir, 'agent-a015af7abcb52ccc2.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find the flaky test', toolUseId: 'toolu_agent_1', requestShape: 'background' }));
    const prompt: Record<string, unknown> = { ...terminalUserLine({ sessionId: CS, cwd: r.cwd, content: 'Look for the flaky test.', parentUuid: null, timestamp: '2026-09-29T10:00:10.000Z' }), isSidechain: true, agentId: 'a015af7abcb52ccc2' };
    const working: Record<string, unknown> = { ...assistantTextLine({ sessionId: CS, cwd: r.cwd, text: 'Searching the specs.', parentUuid: prompt.uuid as string, timestamp: '2026-09-29T10:00:12.000Z' }), isSidechain: true };
    (working['message'] as Record<string, unknown>)['stop_reason'] = 'tool_use';
    await writeFile(path.join(dir, 'agent-a015af7abcb52ccc2.jsonl'), ndjson([prompt, working]));
    // A workflow agent's file (D51's): not read here.
    await writeFile(path.join(dir, 'workflows', 'run-1', 'agent-wf.jsonl'), ndjson([prompt]));
    await hookCall(r, 'event', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {} });
    const detail = await until('the subagent', async () => {
      const d = (await api(r, 'GET', `/api/sessions/${session.id}`)).json() as SessionDetail;
      return d.agents.some((agent) => agent.kind === 'subagent') ? d : null;
    });
    const agent = detail.agents.find((entry) => entry.kind === 'subagent');
    expect(agent).toMatchObject({ name: 'Explore', description: 'Find the flaky test', toolUseId: 'toolu_agent_1', status: 'run' });
    expect(detail.agents.filter((entry) => entry.kind === 'subagent')).toHaveLength(1);
    const own = detail.events.filter((event) => event.agentId === agent?.id).map((event) => event.payload as { type: string; text: string });
    expect(own).toEqual([expect.objectContaining({ type: 'agent-prompt', text: 'Look for the flaky test.' }), expect.objectContaining({ type: 'assistant', text: 'Searching the specs.' })]);
    // Its last message ends its turn: done.
    const done: Record<string, unknown> = { ...assistantTextLine({ sessionId: CS, cwd: r.cwd, text: 'It is timeline.spec.', parentUuid: working.uuid as string, timestamp: '2026-09-29T10:00:20.000Z' }), isSidechain: true };
    await appendFile(path.join(dir, 'agent-a015af7abcb52ccc2.jsonl'), ndjson([done]));
    await hookCall(r, 'event', { hook_event_name: 'Stop' });
    await until('done', async () => ((await api(r, 'GET', `/api/sessions/${session.id}`)).json() as SessionDetail).agents.find((entry) => entry.kind === 'subagent')?.status === 'done');
  });
});

describe('D48 P4 messages: exactly once, one wake-up per turn, rate-limited', () => {
  it('delivers a message once to an idle waiter; re-armed waiters after every turn get nothing (the spike\'s runaway)', async () => {
    const r = await setup();
    const session = await hookIn(r);
    // Slash commands stay in the terminal (they would reach the model as text).
    const slash = await api(r, 'POST', `/api/sessions/${session.id}/messages`, { text: '/compact now' });
    expect(slash.statusCode).toBe(409);
    expect(slash.json()).toMatchObject({ error: 'hooked-unavailable' });
    expect((await api(r, 'POST', `/api/sessions/${session.id}/messages`, { text: 'Also update the docs.' })).statusCode).toBe(202);
    const queued = ((await api(r, 'GET', `/api/sessions/${session.id}`)).json() as SessionDetail).events.at(-1);
    expect(queued?.payload).toMatchObject({ type: 'user', text: 'Also update the docs.', delivered: false, queued: 'turn' });
    const first = await hookCall(r, 'waiter', { hook_event_name: 'SessionStart', source: 'startup' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ message: 'Also update the docs.' });
    // The woken turn and 25 more turn ends, each re-arming a waiter: nothing is delivered again.
    let deliveries = 1;
    let open: Promise<LightMyRequestResponse> | null = null;
    for (let turn = 0; turn < 25; turn++) {
      await hookCall(r, 'event', { hook_event_name: 'UserPromptSubmit' });
      await hookCall(r, 'event', { hook_event_name: 'Stop' });
      const waiter = hookCall(r, 'waiter', { hook_event_name: 'Stop' });
      if (await settles(waiter, 40)) {
        const answer = await waiter;
        if (answer.statusCode === 200) deliveries++;
      }
      open = waiter;
    }
    expect(deliveries).toBe(1);
    expect(r.hooks.waiterCount).toBe(1);
    // The transcript's copy of the wake-up marks the bubble delivered (no second bubble).
    await append(r, {
      type: 'user',
      uuid: 'wake-1',
      parentUuid: lastUuid(r.lines),
      timestamp: '2026-09-29T10:02:00.000Z',
      message: { role: 'user', content: '<task-notification>\n<summary>Message from Switchboard</summary>\n</task-notification>\n<system-reminder>\nThe developer sent this message from Switchboard: Also update the docs.\n</system-reminder>' },
      origin: { kind: 'task-notification', producer: 'session-task' },
    });
    await hookCall(r, 'event', { hook_event_name: 'Stop' });
    const events = await until('the bubble delivered', async () => {
      const d = (await api(r, 'GET', `/api/sessions/${session.id}`)).json() as SessionDetail;
      const user = d.events.filter((event) => (event.payload as { text?: string }).text === 'Also update the docs.');
      return user.length === 1 && (user[0]?.payload as { delivered?: boolean }).delivered === true ? d.events : null;
    });
    expect(events.filter((event) => (event.payload as { type?: string }).type === 'user')).toHaveLength(2);
    // The held waiter is released (no message) when the session ends.
    await hookCall(r, 'event', { hook_event_name: 'SessionEnd', reason: 'other' });
    expect((await (open as Promise<LightMyRequestResponse>)).statusCode).toBe(204);
    expect(r.hooks.waiterCount).toBe(0);
  });

  it('delivers while a turn runs (ruling D48-midturn-policy); one wake-up in flight; one waiter per session (a newer one supersedes); several queued messages go out together', async () => {
    const r = await setup();
    const session = await hookIn(r);
    const first = hookCall(r, 'waiter', { hook_event_name: 'SessionStart' });
    await hookCall(r, 'event', { hook_event_name: 'UserPromptSubmit' });
    // A newer waiter supersedes the older one (answered with no message).
    const older = hookCall(r, 'waiter', { hook_event_name: 'SessionStart' });
    expect((await first).statusCode).toBe(204);
    // Mid-turn: delivered at once (the CLI folds it in at the next tool boundary).
    await api(r, 'POST', `/api/sessions/${session.id}/messages`, { text: 'First.' });
    expect((await older).json()).toEqual({ message: 'First.' });
    // The next ones wait while the first is in flight: its fold (UserPromptSubmit), then the turn's end.
    await api(r, 'POST', `/api/sessions/${session.id}/messages`, { text: 'Second.' });
    await api(r, 'POST', `/api/sessions/${session.id}/messages`, { text: 'Third.' });
    await hookCall(r, 'event', { hook_event_name: 'UserPromptSubmit' });
    await hookCall(r, 'event', { hook_event_name: 'Stop' });
    const next = hookCall(r, 'waiter', { hook_event_name: 'Stop' });
    expect((await next).json()).toEqual({ message: 'Second.\n\nThird.' });
    // A turn that ends before the fold: the message starts the next turn, and the one after waits for that turn.
    const again = hookCall(r, 'waiter', { hook_event_name: 'Stop' });
    await hookCall(r, 'event', { hook_event_name: 'Stop' });
    await api(r, 'POST', `/api/sessions/${session.id}/messages`, { text: 'Fourth.' });
    expect(await settles(again, 200)).toBe(false);
    await hookCall(r, 'event', { hook_event_name: 'UserPromptSubmit' });
    expect(await settles(again, 100)).toBe(false);
    await hookCall(r, 'event', { hook_event_name: 'Stop' });
    expect((await again).json()).toEqual({ message: 'Fourth.' });
  });

  it('at most 3 wake-ups a minute: a 4th message waits for the window', async () => {
    const r = await setup({ max: 3, windowMs: 1_500 });
    const session = await hookIn(r);
    const delivered: string[] = [];
    for (let n = 1; n <= 4; n++) {
      await api(r, 'POST', `/api/sessions/${session.id}/messages`, { text: `Message ${n}.` });
      const waiter = hookCall(r, 'waiter', { hook_event_name: n === 1 ? 'SessionStart' : 'Stop' });
      if (await settles(waiter, 300)) delivered.push((await waiter).json().message as string);
      else {
        expect(n).toBe(4);
        const late = await waiter;
        delivered.push(late.json().message as string);
      }
      await hookCall(r, 'event', { hook_event_name: 'UserPromptSubmit' });
      await hookCall(r, 'event', { hook_event_name: 'Stop' });
    }
    expect(delivered).toEqual(['Message 1.', 'Message 2.', 'Message 3.', 'Message 4.']);
  });
});

describe('D48 P4 permissions and questions', () => {
  it('Allow once, Always allow (the suggested rules) and Deny with a message go back as the hook\'s output', async () => {
    const r = await setup();
    const session = await hookIn(r);
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }];
    const asked = hookCall(r, 'permission', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_suggestions: suggestions });
    const item = await until('the Inbox item', async () => ((await api(r, 'GET', '/api/inbox')).json() as InboxItem[]).find((entry) => entry.kind === 'permission') ?? null);
    expect(item.sessionId).toBe(session.id);
    expect(item.actions?.map((action) => action.id)).toEqual(['allow-once', 'always-allow', 'deny']);
    expect(item.permission?.hook).toEqual({ denyMessage: true, alwaysAllow: true });
    expect(((await api(r, 'GET', `/api/sessions/${session.id}`)).json() as SessionDetail).status).toBe('need');
    expect((await api(r, 'POST', `/api/inbox/${item.id}/actions/always-allow`)).statusCode).toBe(204);
    expect((await asked).json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { command: 'npm test' }, updatedPermissions: suggestions } },
    });

    const denied = hookCall(r, 'permission', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    const second = await until('the second item', async () => ((await api(r, 'GET', '/api/inbox')).json() as InboxItem[]).find((entry) => entry.kind === 'permission') ?? null);
    expect(second.actions?.map((action) => action.id)).toEqual(['allow-once', 'deny']);
    expect((await api(r, 'POST', `/api/inbox/${second.id}/actions/always-allow`)).statusCode).toBe(400);
    expect((await api(r, 'POST', `/api/inbox/${second.id}/actions/deny`, { message: 'Not the build folder, use npm run clean.' })).statusCode).toBe(204);
    expect((await denied).json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Not the build folder, use npm run clean.' } } });
  });

  it('answered in the terminal first: the item closes and the hook call gets no decision; a session that is not hooked gets none at once', async () => {
    const r = await setup();
    // Not hooked yet: answered at once, no item.
    expect((await hookCall(r, 'permission', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })).statusCode).toBe(204);
    await hookIn(r);
    const asked = hookCall(r, 'permission', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
    await until('the item', async () => ((await api(r, 'GET', '/api/inbox')).json() as InboxItem[]).length === 1);
    await hookCall(r, 'event', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1' });
    expect((await asked).statusCode).toBe(204);
    await until('the Inbox empty', async () => ((await api(r, 'GET', '/api/inbox')).json() as InboxItem[]).length === 0);
  });

  it('AskUserQuestion becomes a question card; the answers go back as updatedInput.answers (verified on CLI 2.1.284)', async () => {
    const r = await setup();
    const session = await hookIn(r);
    const questions = [{ question: 'Which color do you prefer?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }];
    const asked = hookCall(r, 'permission', { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions } });
    const batch = await until('the question batch', async () => ((await api(r, 'GET', '/api/inbox')).json() as InboxItem[]).find((entry) => entry.kind === 'questions') ?? null);
    expect(batch.sessionId).toBe(session.id);
    const questionId = batch.questions?.[0]?.id as string;
    expect((await api(r, 'POST', `/api/questions/batch/${batch.id}/answers`, { answers: [{ questionId, answerIndex: 1 }] })).statusCode).toBe(204);
    expect((await asked).json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { questions, answers: { 'Which color do you prefer?': 'Blue' } } } },
    });
  });
});

describe('D48 P4 hook endpoint guard', () => {
  it('/hook/* takes only the hook token: no token, the UI cookie, a wrong token or any Origin are refused', async () => {
    const r = await setup();
    const payload = JSON.stringify({ event: { session_id: CS, hook_event_name: 'Stop' } });
    const post = (headers: Record<string, string>) => r.app.inject({ method: 'POST', url: '/hook/v1/event', headers: { host: HOST, 'content-type': 'application/json', ...headers }, payload });
    expect((await post({})).statusCode).toBe(401);
    expect((await post({ cookie: `sb_token=${r.token}` })).statusCode).toBe(401);
    expect((await post({ authorization: `Bearer ${r.token}` })).statusCode).toBe(401);
    expect((await post({ authorization: `Bearer ${r.hookToken}`, origin: `http://${HOST}` })).statusCode).toBe(403);
    expect((await post({ authorization: `Bearer ${r.hookToken}`, host: `evil.example:${PORT}` })).statusCode).toBe(403);
    expect((await post({ authorization: `Bearer ${r.hookToken}` })).statusCode).toBe(204);
    // The API does not take the hook token.
    expect((await r.app.inject({ method: 'GET', url: '/api/sessions', headers: { host: HOST, authorization: `Bearer ${r.hookToken}` } })).statusCode).toBe(401);
  });
});
