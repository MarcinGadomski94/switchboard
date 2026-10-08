import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { checkpointRef, revertDivider, revertNote, type CheckpointPlan, type SessionCheckpoints } from '../../../src/core/checkpoints.ts';
import { peerAnswerKind } from '../../../src/core/peer-wire.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import { failureText, runCommand, succeeded } from '../../../src/server/exec.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, readFakeLog, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D80 oracle, through the real supervisor and fake-claude (`[fake:write]` really
 * writes): the checkpoint is taken before each turn, the routes list / preview /
 * revert / Redo, a revert is refused while a turn runs, the chat gets the divider
 * and the agent its note with the next message; the routes are on the device and
 * peer allow-lists.
 */

const PORT = 4921; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';
let gitconfig = '';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git'], args, { cwd, env: world!.env });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
  return result.stdout.trim();
}

async function setup(): Promise<SupervisorWorld> {
  gitconfig = path.join(process.env['TMPDIR'] ?? '/tmp', `switchboard-d80-${process.pid}.gitconfig`);
  await writeFile(gitconfig, '[gc]\n\tauto = 0\n');
  world = await makeSupervisorWorld({
    parentEnv: {
      GIT_CONFIG_GLOBAL: gitconfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Dev',
      GIT_AUTHOR_EMAIL: 'dev@example.invalid',
      GIT_COMMITTER_NAME: 'Dev',
      GIT_COMMITTER_EMAIL: 'dev@example.invalid',
    },
  });
  // The session's folder is a git repo itself.
  await git(world.workspace, 'init', '-q', '-b', 'main');
  await writeFile(path.join(world.workspace, 'README.md'), 'hello\n');
  await git(world.workspace, 'add', '-A');
  await git(world.workspace, 'commit', '-q', '-m', 'init');
  token = generateToken();
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root }), port: PORT };
  await seedFolder(world.store, world.workspace, { kind: 'repo' });
  app = await buildApp({ config, token, store: world.store, webRoot: world.root, supervisor: world.supervisor, agentTools: false });
  await app.ready();
  return world;
}

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
  if (gitconfig) await rm(gitconfig, { force: true });
});

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function exists(file: string): Promise<boolean> {
  return readFile(file).then(
    () => true,
    () => false,
  );
}

describe('D80 through the supervisor and the API', () => {
  it('checkpoints before each turn; preview, revert (divider + note with the next message), Redo', async () => {
    const w = await setup();
    const name = path.basename(w.workspace);
    const created = await call('POST', '/api/sessions', newSession({ solutions: [name], task: '[fake:write first.txt] Write the first file.' }));
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    await waitForStatus(w.store, id, ['done', 'idle']);
    expect(await exists(path.join(w.workspace, 'first.txt'))).toBe(true);

    // Turn 1's checkpoint is from before the write.
    const ref = checkpointRef(id, 1);
    expect(await git(w.workspace, 'ls-tree', '-r', '--name-only', ref)).toBe('README.md');

    expect((await call('POST', `/api/sessions/${id}/messages`, { text: '[fake:write second.txt] Write the second file.' })).statusCode).toBe(202);
    await until(async () => (await exists(path.join(w.workspace, 'second.txt'))) && (await w.store.sessions.get(id))?.status !== 'run', 'turn 2');
    await waitForStatus(w.store, id, ['done', 'idle']);

    const list = (await call('GET', `/api/sessions/${id}/checkpoints`)).json() as SessionCheckpoints;
    expect(list).toMatchObject({ enabled: true, unsupported: null, latestTurn: 2, running: false, redo: null });
    expect(list.turns.map((t) => [t.turn, t.firstLine])).toEqual([
      [1, '[fake:write first.txt] Write the first file.'],
      [2, '[fake:write second.txt] Write the second file.'],
    ]);

    const preview = (await call('GET', `/api/sessions/${id}/checkpoints/1`)).json() as CheckpointPlan;
    expect(preview.repos[0]!.files).toEqual([
      { path: 'first.txt', change: 'deleted' },
      { path: 'second.txt', change: 'deleted' },
    ]);
    expect((await call('GET', `/api/sessions/${id}/checkpoints/x`)).statusCode).toBe(422);
    expect((await call('GET', `/api/sessions/${id}/checkpoints/7`)).statusCode).toBe(404);
    expect((await call('POST', `/api/sessions/${id}/checkpoints/1/revert`, { filesOnly: 'yes' })).statusCode).toBe(422);

    const reverted = await call('POST', `/api/sessions/${id}/checkpoints/1/revert`, {});
    expect(reverted.statusCode).toBe(200);
    expect(await exists(path.join(w.workspace, 'first.txt'))).toBe(false);
    expect(await exists(path.join(w.workspace, 'second.txt'))).toBe(false);
    const events = await w.store.events.list(id);
    const divider = events.find((event) => (event.payload as { action?: string } | null)?.action === 'reverted');
    expect(divider?.label).toBe(revertDivider(1));

    // Redo, then revert again; the note goes with the next message (the conversation is not rewound).
    expect((await call('GET', `/api/sessions/${id}/checkpoints`)).json().redo).toMatchObject({ turn: 1 });
    expect((await call('POST', `/api/sessions/${id}/checkpoints/redo`)).statusCode).toBe(200);
    expect(await exists(path.join(w.workspace, 'second.txt'))).toBe(true);
    expect((await call('POST', `/api/sessions/${id}/checkpoints/redo`)).json().error).toBe('nothing-to-redo');
    expect((await call('POST', `/api/sessions/${id}/checkpoints/1/revert`)).statusCode).toBe(200);

    expect((await call('POST', `/api/sessions/${id}/messages`, { text: 'What now?' })).statusCode).toBe(202);
    const note = revertNote(1, '[fake:write first.txt] Write the first file.', 2);
    await until(async () => (await readFakeLog(w.logFile)).some((line) => line.kind === 'stdin' && typeof line.line === 'string' && line.line.includes(note)), 'the note on stdin');
    await waitForStatus(w.store, id, ['done', 'idle']);
    // Turn 3 has its own checkpoint.
    expect((await call('GET', `/api/sessions/${id}/checkpoints`)).json().turns.map((t: { turn: number }) => t.turn)).toEqual([1, 2, 3]);
  });

  it('refuses a revert while a turn runs (409 turn-running)', async () => {
    const w = await setup();
    const created = await call('POST', '/api/sessions', newSession({ solutions: [path.basename(w.workspace)], task: '[fake:hold 20] Think.' }));
    const id = (created.json() as { id: string }).id;
    await waitForStatus(w.store, id, ['run']);
    await until(async () => (await w.store.checkpoints.listOf(id)).length > 0, 'the checkpoint');
    const refused = await call('POST', `/api/sessions/${id}/checkpoints/1/revert`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('turn-running');
    expect((await call('GET', `/api/sessions/${id}/checkpoints`)).json().running).toBe(true);
    await call('POST', `/api/sessions/${id}/interrupt`);
  });
});

describe('D80 routes on the allow-lists', () => {
  it('phones may call them (with the confirm), paired machines forward them, answers pass unmapped', () => {
    const routes: Array<[string, string]> = [
      ['GET', '/api/sessions/s1/checkpoints'],
      ['GET', '/api/sessions/s1/checkpoints/3'],
      ['POST', '/api/sessions/s1/checkpoints/3/revert'],
      ['POST', '/api/sessions/s1/checkpoints/redo'],
    ];
    for (const [method, url] of routes) {
      expect(isLocalOnly(method, url), `${method} ${url}`).toBe(false);
      expect(isLocalOnly(method, `/api/machines/m1/api${url.slice(4)}`), `${method} ${url} via a peer`).toBe(false);
      expect(peerApiAllowed(method, url), `${method} ${url}`).toBe(true);
      expect(peerAnswerKind(method, url)).toBe('none');
    }
    expect(isLocalOnly('DELETE', '/api/sessions/s1/checkpoints/3')).toBe(true);
  });
});
