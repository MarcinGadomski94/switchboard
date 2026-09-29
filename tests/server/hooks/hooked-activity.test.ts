import { appendFile, mkdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { HubEvents, Session, SessionDetail, TerminalSession } from '../../../src/core/api.ts';
import type { TerminalAgentRow } from '../../../src/core/hooks.ts';
import { buildApp, createSessionServices } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HookService } from '../../../src/server/hooks/service.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { HOOK_TOKEN_FILE, generateToken, loadOrCreateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { assistantTextLine, assistantToolLine, lastUuid, ndjson, terminalUserLine, toolResultLine, writeTranscript } from '../../helpers/transcripts.ts';

/**
 * D53 "Live activity for remote and hooked sessions" over the real routes
 * (`inject`, the rig of `service.test.ts`): a hooked terminal session's live
 * activity from its hook calls and its growing transcript (the 500 ms poll),
 * published as `/hub` `activity` events and carried by `Session.activity`; and
 * `Session.hookStatus`, what a message to it waits on.
 */

const PORT = 4962;
const HOST = `127.0.0.1:${PORT}`;
const CS = '0b7c3e0a-1111-4222-8333-944455556666';

interface Rig {
  readonly root: string;
  readonly store: Store;
  readonly app: FastifyInstance;
  readonly hooks: HookService;
  readonly activities: HubEvents['activity'][];
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
  await rig?.hooks.close();
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
  const activities: HubEvents['activity'][] = [];
  bus.subscribe((message) => {
    if (message.name === 'activity') activities.push(message.payload);
  });
  const r: Rig = { root, store, app, hooks, activities, token, hookToken, configDir, cwd, rows: [], transcript, lines };
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

async function detail(r: Rig, id: string): Promise<SessionDetail> {
  return (await api(r, 'GET', `/api/sessions/${id}`)).json() as SessionDetail;
}

const iso = (ms: number): string => new Date(ms).toISOString();

describe('D53 live activity of a hooked session', () => {
  it('UserPromptSubmit → thinking; the transcript\'s tool_use → ● Bash until its result; a held PermissionRequest → waiting; Stop → idle; published on /hub', async () => {
    const r = await setup();
    const session = await hookIn(r);
    expect((await detail(r, session.id)).activity).toBeNull();
    r.hooks.start();

    await append(r, terminalUserLine({ sessionId: CS, cwd: r.cwd, content: 'Run the tests.', parentUuid: lastUuid(r.lines), timestamp: iso(Date.now()) }));
    await hookCall(r, 'event', { hook_event_name: 'UserPromptSubmit' });
    const thinking = await until('thinking', async () => {
      const a = (await detail(r, session.id)).activity;
      return a?.state === 'thinking' ? a : null;
    });
    expect(thinking.quietSince).toBeTruthy();
    expect(r.activities.some((event) => event.sessionId === session.id && event.activity?.state === 'thinking')).toBe(true);

    // The CLI writes the tool_use line when the tool starts: no hook needed, the poll sees it.
    const toolAt = Date.now();
    await append(r, assistantToolLine({ sessionId: CS, cwd: r.cwd, toolUseId: 'toolu_bash', name: 'Bash', input: { command: 'npm test' }, parentUuid: lastUuid(r.lines), timestamp: iso(toolAt) }));
    const running = await until('● Bash', async () => {
      const a = (await detail(r, session.id)).activity;
      return a?.state === 'tool' ? a : null;
    });
    expect(running).toMatchObject({ tool: 'Bash', summary: 'npm test', since: iso(toolAt) });
    expect(r.activities.at(-1)).toMatchObject({ sessionId: session.id, activity: { state: 'tool', tool: 'Bash' } });

    // A permission prompt in the terminal: "Waiting for permission: Bash".
    const asked = hookCall(r, 'permission', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
    await until('waiting', async () => (await detail(r, session.id)).activity?.state === 'waiting');
    expect((await detail(r, session.id)).activity).toMatchObject({ state: 'waiting', tool: 'Bash', summary: 'rm -rf dist' });
    // Answered in the terminal (its PostToolUse): back to the tool.
    await hookCall(r, 'event', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
    expect((await asked).statusCode).toBe(204);
    await until('tool again', async () => (await detail(r, session.id)).activity?.state === 'tool');

    await append(r, toolResultLine({ sessionId: CS, cwd: r.cwd, toolUseId: 'toolu_bash', text: 'ok', parentUuid: lastUuid(r.lines), timestamp: iso(Date.now()) }));
    await until('thinking after the result', async () => (await detail(r, session.id)).activity?.state === 'thinking');
    await append(r, assistantTextLine({ sessionId: CS, cwd: r.cwd, text: 'All green.', parentUuid: lastUuid(r.lines), timestamp: iso(Date.now()) }));
    await hookCall(r, 'event', { hook_event_name: 'Stop' });
    await until('idle', async () => (await detail(r, session.id)).activity === null);
    expect(r.activities.at(-1)).toEqual({ sessionId: session.id, activity: null });
    // The sidebar list carries it too (the same derivation).
    const listed = ((await api(r, 'GET', '/api/sessions')).json() as Session[]).find((entry) => entry.id === session.id);
    expect(listed?.activity).toBeNull();
  });

  it('quietSince is the newest sign of life (the transcript\'s mtime, a hook call): the views add the staleness hint', async () => {
    const r = await setup();
    const session = await hookIn(r);
    const started = Date.now() - 10 * 60_000;
    await append(r, terminalUserLine({ sessionId: CS, cwd: r.cwd, content: 'Long job.', parentUuid: lastUuid(r.lines), timestamp: iso(started) }));
    await append(r, assistantToolLine({ sessionId: CS, cwd: r.cwd, toolUseId: 'toolu_sleep', name: 'Bash', input: { command: 'sleep 900' }, parentUuid: lastUuid(r.lines), timestamp: iso(started + 5_000) }));
    const quietAt = new Date(started + 6_000);
    await utimes(r.transcript, quietAt, quietAt);
    r.hooks.start();
    const activity = await until('the running tool', async () => (await detail(r, session.id)).activity);
    expect(activity).toMatchObject({ state: 'tool', tool: 'Bash', summary: 'sleep 900', turnStartedAt: iso(started), quietSince: iso(started + 6_000) });
  });
});

describe('D53 what a message to a hooked session waits on', () => {
  it('no hook listening yet → handed to the waiter → taken up (nothing to say) → session ended', async () => {
    const r = await setup();
    const session = await hookIn(r);
    expect((await detail(r, session.id)).hookStatus).toEqual({ waiter: false, hookSeen: false, delivery: 'no-waiter' });
    expect((await api(r, 'POST', `/api/sessions/${session.id}/messages`, { text: 'Also add a test.' })).statusCode).toBeLessThan(300);
    expect((await detail(r, session.id)).hookStatus).toMatchObject({ delivery: 'no-waiter' });

    // The terminal runs a hook (its next turn end): the waiter takes the message; the CLI has not taken it up yet.
    const waiter = hookCall(r, 'waiter', { hook_event_name: 'Stop' });
    expect((await waiter).statusCode).toBe(200);
    const handed = await until('handed', async () => {
      const status = (await detail(r, session.id)).hookStatus;
      return status?.delivery === 'handed' ? status : null;
    });
    expect(handed).toEqual({ waiter: false, hookSeen: true, delivery: 'handed' });
    // The wake-up's turn starts: nothing waits any more (its Stop will arm the next waiter).
    await hookCall(r, 'event', { hook_event_name: 'UserPromptSubmit' });
    await until('taken up', async () => (await detail(r, session.id)).hookStatus?.delivery === null);
    // A waiter armed again; then the terminal session ends.
    const next = hookCall(r, 'waiter', { hook_event_name: 'SessionStart', source: 'startup' });
    await until('waiter armed', async () => (await detail(r, session.id)).hookStatus?.waiter === true);
    await hookCall(r, 'event', { hook_event_name: 'SessionEnd' });
    expect((await next).statusCode).toBe(204);
    await until('ended', async () => (await detail(r, session.id)).hookStatus?.delivery === 'ended');
    expect((await detail(r, session.id)).activity).toBeNull();
  });
});
