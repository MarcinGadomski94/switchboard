import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { HistoryItem, Session } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { parseOpencodeExport, parseOpencodeSessions, rolloutMessages } from '../../../src/server/history/cli-history.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, until } from '../../helpers/supervisor.ts';

const PORT = 4872;
const HOST = `127.0.0.1:${PORT}`;
let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
});

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({ method, url, headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}

const THREAD = '0199a6d1-5f1a-7c3e-9a10-1234567890ab';

async function setup(): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld();
  const w = world;
  token = generateToken();
  await seedFolder(w.store, w.workspace);
  // A Codex terminal conversation (its rollout file) and an OpenCode one (the fake's store), both in the saved folder.
  const day = path.join(w.codexHome, 'sessions', '2026', '09', '30');
  await mkdir(day, { recursive: true });
  const line = (type: string, payload: unknown, ts = '2026-09-30T10:00:00.000Z') => JSON.stringify({ timestamp: ts, type, payload });
  await writeFile(
    path.join(day, `rollout-2026-09-30T10-00-00-${THREAD}.jsonl`),
    [
      line('session_meta', { id: THREAD, timestamp: '2026-09-30T10:00:00.000Z', cwd: w.workspace, originator: 'codex_cli_rs', cli_version: '0.159.3' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the flaky test' }] }, '2026-09-30T10:00:01.000Z'),
      line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed: a race in the setup.' }] }, '2026-09-30T10:00:02.000Z'),
    ].join('\n') + '\n',
  );
  await mkdir(path.join(w.opencodeData, 'opencode'), { recursive: true });
  await writeFile(
    path.join(w.opencodeData, 'opencode', 'fake-store.json'),
    JSON.stringify({
      sessions: [{ id: 'ses_term', title: 'Write the docs', directory: w.workspace, projectID: 'p', time: { created: Date.parse('2026-09-29T08:00:00.000Z'), updated: Date.parse('2026-09-29T08:05:00.000Z') } }],
      messages: {
        ses_term: [
          { info: { role: 'user', time: { created: Date.parse('2026-09-29T08:00:00.000Z') } }, parts: [{ type: 'text', text: 'Write the docs' }] },
          { info: { role: 'assistant', time: { created: Date.parse('2026-09-29T08:01:00.000Z') } }, parts: [{ type: 'text', text: 'Done.' }, { type: 'tool', tool: 'write' }] },
        ],
      },
      mcp: {},
    }),
  );
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  app = await buildApp({ config: { ...base, port: PORT }, token, store: w.store, webRoot: w.root, supervisor: w.supervisor });
  await app.ready();
  return w;
}

describe('D62 P7 · History lists and moves Codex / OpenCode terminal conversations', () => {
  it('only with ?cli=1; a move needs confirm, imports the messages, reopens the CLI\'s own conversation idle; then the row is gone', async () => {
    const w = await setup();
    expect(((await call('GET', '/api/history')).json() as HistoryItem[]).some((item) => item.provider)).toBe(false);
    const rows = (await call('GET', '/api/history?cli=1')).json() as HistoryItem[];
    const codex = rows.find((item) => item.provider === 'codex');
    const opencode = rows.find((item) => item.provider === 'opencode');
    expect(codex).toMatchObject({ claudeSessionId: `codex:${THREAD}`, nativeId: THREAD, name: 'Fix the flaky test', mode: 'terminal · Codex CLI', summary: 'Fixed: a race in the setup.', terminal: true, cwd: w.workspace });
    expect(opencode).toMatchObject({ nativeId: 'ses_term', name: 'Write the docs', mode: 'terminal · OpenCode' });
    expect(((await call('GET', '/api/history?cli=1&q=flaky')).json() as HistoryItem[]).map((item) => item.nativeId)).toEqual([THREAD]);

    const asked = await call('POST', `/api/history/cli/codex/${THREAD}/continue`, {});
    expect(asked.statusCode).toBe(409);
    expect(asked.json()).toMatchObject({ error: 'terminal-open', reasons: [{ kind: 'liveness-unknown' }] });
    const moved = await call('POST', `/api/history/cli/codex/${THREAD}/continue`, { confirm: true });
    expect(moved.statusCode).toBe(201);
    const session = moved.json() as Session;
    expect(session).toMatchObject({ provider: 'codex', title: 'Fix the flaky test', name: 'fix-the-flaky-test', origin: 'terminal', status: 'idle' });
    const events = await w.store.events.list(session.id);
    expect(events.map((event) => [event.ts, event.label])).toEqual(
      expect.arrayContaining([
        ['2026-09-30T10:00:01.000Z', 'Fix the flaky test'],
        ['2026-09-30T10:00:02.000Z', 'Fixed: a race in the setup.'],
      ]),
    );
    await until(async () => (await import('node:fs/promises')).readFile(w.codexLog, 'utf8').then((text) => text.includes('thread/resume')).catch(() => false), 'thread/resume');
    expect(await w.store.providers.nativeId(session.id, 'codex')).toBe(THREAD);
    expect(((await call('GET', '/api/history?cli=1')).json() as HistoryItem[]).some((item) => item.nativeId === THREAD)).toBe(false);
    expect((await call('POST', `/api/history/cli/codex/${THREAD}/continue`, { confirm: true })).json()).toMatchObject({ error: 'already-in-switchboard', sessionId: session.id });

    const second = await call('POST', '/api/history/cli/opencode/ses_term/continue', { confirm: true, title: 'Docs' });
    expect(second.statusCode).toBe(201);
    const docs = second.json() as Session;
    expect(docs).toMatchObject({ provider: 'opencode', title: 'Docs', name: 'docs' });
    expect((await w.store.events.list(docs.id)).map((event) => event.label)).toEqual(expect.arrayContaining(['Write the docs', 'Done.']));
    expect((await call('POST', '/api/history/cli/gpt/x/continue', { confirm: true })).statusCode).toBe(404);
    expect((await call('POST', '/api/history/cli/codex/nope/continue', { confirm: true })).statusCode).toBe(404);
  });

  it('parsers: rollout lines (Codex\'s own context blocks left out), `session list --format json`, `export`', () => {
    const { meta, messages } = rolloutMessages([
      JSON.stringify({ type: 'session_meta', payload: { id: 't', cwd: '/w' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_instructions>x</user_instructions>' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }),
      'not json',
    ]);
    expect(meta).toMatchObject({ id: 't' });
    expect(messages).toEqual([{ role: 'user', text: 'hi', ts: null }]);
    expect(parseOpencodeSessions('[{"id":"ses_1","title":"T","created":0,"directory":"/w"}]')).toEqual([{ provider: 'opencode', nativeId: 'ses_1', title: 'T', firstPrompt: null, lastText: null, startedAt: '1970-01-01T00:00:00.000Z', cwd: '/w' }]);
    expect(parseOpencodeSessions('nope')).toEqual([]);
    expect(parseOpencodeExport('{"info":{},"messages":[{"info":{"role":"assistant"},"parts":[{"type":"text","text":"a","synthetic":true},{"type":"text","text":"b"}]}]}')).toEqual([{ role: 'assistant', text: 'b', ts: null }]);
    expect(parseOpencodeExport('[]')).toBeNull();
  });
});
