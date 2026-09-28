import { appendFile, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HistoryItem } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { TranscriptHistory, claudeConfigDir } from '../../../src/server/history/transcripts.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import {
  asTerminal,
  assistantTextLine,
  fixtureLines,
  lastUuid,
  ndjson,
  terminalUserLine,
  withSessionId,
  withoutTypes,
  writeTranscript,
} from '../../helpers/transcripts.ts';

const PORT = 4871; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const OLD = new Date('2026-09-27T22:00:00.000Z');

let tmp: string;
let root: string;
let configDir: string;
let store: Store;
const files: Record<string, string> = {};

/** Every file under `dir` with its size and mtime (the "never written" check). */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const info = await stat(full);
    out.push(`${full} ${entry.isFile() ? info.size : 'dir'} ${info.mtimeMs}`);
  }
  return out.sort();
}

beforeAll(async () => {
  tmp = await realpath(await makeTempDir('history'));
  root = path.join(tmp, 'work space');
  configDir = path.join(tmp, 'claude config');
  await mkdir(root, { recursive: true });
  const sandbox = path.join(root, 'other');
  store = await openTempStore(tmp);

  // A terminal session (cli) with its title; a forked terminal file; a headless file nobody stored.
  files['tx'] = await writeTranscript(configDir, path.join(sandbox, 'tx main'), 'term-tx', asTerminal(withSessionId(await fixtureLines('tx-main', sandbox), 'term-tx')), OLD);
  files['conc'] = await writeTranscript(configDir, path.join(sandbox, 'handoff-conc'), 'term-conc', asTerminal(withSessionId(await fixtureLines('handoff-conc', sandbox), 'term-conc')), OLD);
  files['headless'] = await writeTranscript(configDir, path.join(sandbox, 'handoff-mid'), 'headless-mid', withSessionId(await fixtureLines('handoff-mid', sandbox), 'headless-mid'), OLD);
  // A stub (no prompt, no command) and a file from another root whose folder shares the prefix.
  files['stub'] = await writeTranscript(configDir, root, 'term-stub', withoutTypes(asTerminal(withSessionId(await fixtureLines('tx-main', root), 'term-stub')), 'user', 'assistant').map((line) => ({ ...line, cwd: root })), OLD);
  const otherRoot = path.join(tmp, 'work space2');
  files['other'] = await writeTranscript(configDir, otherRoot, 'term-other', asTerminal(withSessionId(await fixtureLines('tx-main', otherRoot), 'term-other')), OLD);

  // A Switchboard session continued in a terminal: its file mixes sdk-cli and cli lines.
  const stored = withSessionId(await fixtureLines('handoff', sandbox), 'stored-1');
  const cwd = path.join(sandbox, 'handoff');
  const prompt = terminalUserLine({ sessionId: 'stored-1', cwd, content: 'Terminal question', parentUuid: lastUuid(stored), timestamp: '2026-09-27T22:00:00.000Z', gitBranch: 'main' });
  const reply = assistantTextLine({ sessionId: 'stored-1', cwd, text: 'Terminal answer', parentUuid: String(prompt['uuid']), timestamp: '2026-09-27T22:00:01.000Z', gitBranch: 'main' });
  files['stored'] = await writeTranscript(configDir, cwd, 'stored-1', [...stored, prompt, reply], OLD);
  const session = await store.sessions.create({
    name: 'pay-flow',
    claudeSessionId: 'stored-1',
    task: 'Build the pay flow.',
    status: 'paused',
    workType: 'feature',
    mode: 'single',
    phase: 'ui-first',
    solutions: ['alpha-front', 'mobile'],
  });
  await store.worktrees.create({ repo: 'alpha-front', repoPath: path.join(root, 'microfrontends', 'alpha-front'), branch: 'session/pay-flow', path: path.join(root, 'microfrontends', 'alpha-front-wt-pay-flow'), sessionId: session.id });
  // A stored session that never got a message (no transcript).
  await store.sessions.create({ name: 'fresh', claudeSessionId: 'stored-2', task: 'Nothing yet.', status: 'idle', workType: 'qa', mode: 'orchestrator', phase: null, solutions: ['mobile'] });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await store.close();
  await removeTempDir(tmp);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The provider under test; the files are written with old mtimes, so the real clock reads them as ended. */
function provider(options: { root?: string | null } = {}): TranscriptHistory {
  return new TranscriptHistory({ store, workspaceRoot: options.root === undefined ? root : options.root, configDir, platform: 'darwin' });
}

const summary = (items: HistoryItem[]) => items.map((i) => [i.claudeSessionId, i.name, i.mode, i.summary, i.outcome, i.status]);

describe('TranscriptHistory (M7.4)', () => {
  it('lists stored sessions and terminal sessions of this root, and hides headless files, stubs and other roots', async () => {
    const history = provider();
    const items = await history.history();
    expect(summary(items)).toEqual([
      ['stored-2', 'fresh', 'orch · QA', 'Nothing yet.', 'idle', 'idle'],
      ['stored-1', 'pay-flow', 'single · feature · UI-first', 'Terminal answer', 'paused', 'paused'],
      ['term-conc', 'sb-handoff-conc', 'terminal', 'lantern, walnut', 'ended', 'idle'],
      ['term-tx', 'sb-tx-probe', 'terminal', 'finished', 'ended', 'idle'],
    ]);
    const byId = Object.fromEntries(items.map((i) => [i.claudeSessionId, i]));
    expect(byId['stored-1']).toMatchObject({ branches: [{ solution: 'alpha-front', branch: 'session/pay-flow' }], solutions: ['mobile'] });
    expect(byId['term-tx']).toMatchObject({ sessionId: null, startedAt: '2026-09-27T21:19:49.586Z', branches: [{ solution: 'tx main', branch: 'feature/tx-probe' }], solutions: [] });
    expect(byId['term-conc']).toMatchObject({ branches: [{ solution: 'handoff-conc', branch: 'main' }] });
    expect(history.parseCount).toBe(6);
  });

  it('searches server-side', async () => {
    const history = provider();
    expect((await history.history('walnut')).map((i) => i.claudeSessionId)).toEqual(['term-conc']);
    expect((await history.history('TERMINAL QUESTION')).map((i) => i.claudeSessionId)).toEqual(['stored-1']);
    expect((await history.history('feature/tx-probe')).map((i) => i.claudeSessionId)).toEqual(['term-tx']);
    expect(await history.history('no such thing')).toEqual([]);
  });

  it('parses each file once per (size, mtime): memory, then history_cache across instances; a change is re-read; gone files are pruned', async () => {
    const first = provider();
    await first.history();
    await first.history('x');
    expect(first.parseCount).toBe(0); // the instances above already filled history_cache
    const cached = await store.historyCache.get(files['tx']!);
    expect(cached).toMatchObject({ claudeSessionId: 'term-tx', item: { sessionId: 'term-tx', lastText: 'finished' } });

    const lines = asTerminal(withSessionId(await fixtureLines('tx-main', path.join(root, 'other')), 'term-tx'));
    const cwd = path.join(root, 'other', 'tx main');
    const prompt = terminalUserLine({ sessionId: 'term-tx', cwd, content: 'One more thing', parentUuid: lastUuid(lines), timestamp: '2026-09-28T11:59:30.000Z' });
    await appendFile(files['tx']!, ndjson([prompt, assistantTextLine({ sessionId: 'term-tx', cwd, text: 'Done again', parentUuid: String(prompt['uuid']), timestamp: '2026-09-28T11:59:31.000Z' })]));
    const after = await first.history();
    expect(first.parseCount).toBe(1);
    // The file changed just now: the terminal session is active.
    expect(after.find((i) => i.claudeSessionId === 'term-tx')).toMatchObject({ summary: 'Done again', outcome: 'active', status: 'run' });

    await rm(files['conc']!);
    expect((await first.history()).map((i) => i.claudeSessionId)).not.toContain('term-conc');
    expect(await store.historyCache.get(files['conc']!)).toBeNull();
    expect(await store.historyCache.get(files['headless']!)).not.toBeNull();
  });

  it('never writes under the config folder', async () => {
    const before = await snapshot(configDir);
    const history = provider();
    await history.history();
    await history.history('tangerine');
    expect(await snapshot(configDir)).toEqual(before);
  });

  it('without a workspace root lists only the stored sessions (no scan)', async () => {
    const items = await provider({ root: null }).history();
    expect(items.map((i) => i.claudeSessionId)).toEqual(['stored-2', 'stored-1']);
    expect(items[1]?.summary).toBe('Build the pay flow.');
  });

  it('a missing projects folder is not an error', async () => {
    const empty = new TranscriptHistory({ store, workspaceRoot: root, configDir: path.join(tmp, 'nowhere') });
    expect((await empty.history()).map((i) => i.name)).toEqual(['fresh', 'pay-flow']);
  });

  it('claudeConfigDir: $CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/x/y' }, '/home/u')).toBe(path.resolve('/x/y'));
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: ' ' }, '/home/u')).toBe(path.join('/home/u', '.claude'));
    expect(claudeConfigDir({}, '/home/u')).toBe(path.join('/home/u', '.claude'));
  });
});

describe('GET /api/history (M7.4)', () => {
  let app: FastifyInstance;
  let token: string;

  async function start(options: { providers?: Parameters<typeof buildApp>[0]['providers']; workspaceRoot: string | null }): Promise<void> {
    token = generateToken();
    const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT, workspaceRoot: options.workspaceRoot };
    app = await buildApp({ config, token, store, webRoot: tmp, ...(options.providers ? { providers: options.providers } : {}) });
    await app.ready();
  }

  afterEach(async () => {
    await app?.close();
  });

  async function get(url: string): Promise<{ status: number; body: HistoryItem[] }> {
    const response = await app.inject({ method: 'GET', url, headers: { host: HOST, cookie: `sb_token=${token}` } });
    return { status: response.statusCode, body: response.json() as HistoryItem[] };
  }

  it('by default reads $CLAUDE_CONFIG_DIR for the configured root; q filters (last value wins)', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    await start({ workspaceRoot: root });
    const all = await get('/api/history');
    expect(all.status).toBe(200);
    expect(all.body.map((i) => i.claudeSessionId)).toEqual(['stored-2', 'stored-1', 'term-tx']);
    expect((await get('/api/history?q=tx-probe')).body.map((i) => i.name)).toEqual(['sb-tx-probe']);
    expect((await get('/api/history?q=zzz&q=pay')).body.map((i) => i.name)).toEqual(['pay-flow']);
    expect((await get('/api/history?q=')).body).toHaveLength(3);
  });

  it('uses providers.history when given (the demo)', async () => {
    const calls: Array<string | undefined> = [];
    await start({ workspaceRoot: root, providers: { history: { history: async (q) => (calls.push(q), []) } } });
    expect((await get('/api/history?q=abc')).body).toEqual([]);
    expect(calls).toEqual(['abc']);
  });

  it('is behind the cookie guard', async () => {
    await start({ workspaceRoot: null });
    expect((await app.inject({ method: 'GET', url: '/api/history', headers: { host: HOST } })).statusCode).toBe(401);
  });
});
