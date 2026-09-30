import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Folder, NewSimpleSession, Session } from '../../../src/core/api.ts';
import { REPO_WORKTREE_NOTE_HEADER, SESSION_START_HEADER } from '../../../src/core/first-turn.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { validateScheduleInput } from '../../../src/server/schedules/validate.ts';
import { PLAIN_FOLDER_FULL_MESSAGE } from '../../../src/server/sessions/validate.ts';
import { generateToken } from '../../../src/server/token.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { REPO_ROOT } from '../../helpers/net.ts';
import { type SupervisorWorld, isHandshake, makeSupervisorWorld, readFakeLog, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D56 oracle (server, real path, D13): a **simple** start (`simple: true`, the
 * simple New-session form) through `POST /api/sessions` with fake-claude as the
 * CLI, real git repositories and the real worktree manager. A workspace folder
 * (router AGENTS.md): no router fields, no solutions, the process at the folder
 * root, and the first message is the message alone (no "Session-start answers"
 * block); a worktree or solutions are refused there. A repo folder: without a
 * worktree the message alone; with one, the worktree on `sb/<name>` (or the
 * branch sent: any valid git branch name, no ticket rule) and the message plus
 * only the worktree note.
 */
const PORT = 4877; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const ROUTER_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md');

let sw: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await sw?.cleanup();
  app = undefined;
  sw = undefined;
});

interface Rig {
  readonly s: SupervisorWorld;
  readonly g: GitWorld;
  readonly workspace: Folder;
  readonly repo: Folder;
  readonly repoPath: string;
}

async function setup(): Promise<Rig> {
  sw = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  await writeFile(path.join(g.workspace, 'AGENTS.md'), await readFile(ROUTER_FIXTURE, 'utf8'));
  await mkdir(path.join(g.workspace, '.claude'), { recursive: true });
  const repoPath = await g.makeRepo(path.join(sw.root, 'solo'));
  const worktrees = g.manager({ sessions: sw.supervisor });
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
  app = await buildApp({ config: { ...base, port: PORT }, token, store: sw.store, webRoot: sw.root, supervisor: sw.supervisor, worktrees, providers: { diff: worktrees } });
  await app.ready();
  const workspace = (await call('POST', '/api/folders', { path: g.workspace })).json() as Folder;
  const repo = (await call('POST', '/api/folders', { path: repoPath })).json() as Folder;
  return { s: sw, g, workspace, repo, repoPath };
}

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

function simple(folder: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body: NewSimpleSession = { simple: true, name: 'fix-the-login-redirect', title: 'Fix the login redirect', task: 'Fix the login redirect.\nIt loops on /callback.', folder };
  return { ...body, ...overrides };
}

/** The session's spawn line and its first stdin user message's content. */
async function spawnOf(s: SupervisorWorld, session: Session): Promise<{ cwd: string; first: string }> {
  const spawn = await until(async () => (await readFakeLog(s.logFile)).find((line) => line.kind === 'argv' && line.argv?.includes(session.claudeSessionId)), 'the spawn');
  const first = await until(async () => {
    const line = (await readFakeLog(s.logFile)).find((entry) => entry.kind === 'stdin' && entry.pid === spawn.pid && !isHandshake(JSON.parse(entry.line as string) as Record<string, unknown>));
    return line ? (JSON.parse(line.line as string) as { message: { content: string } }).message.content : undefined;
  }, 'the first message');
  return { cwd: spawn.cwd ?? '', first };
}

describe('POST /api/sessions with simple: true (D56)', () => {
  it('a workspace folder: no router fields or solutions, runs at the root, the first message is the message alone (no answers block)', async () => {
    const { s, g, workspace } = await setup();
    const response = await call('POST', '/api/sessions', simple(workspace.id));
    expect(response.statusCode, response.body).toBe(201);
    const session = response.json() as Session;
    expect(session).toMatchObject({
      name: 'fix-the-login-redirect',
      title: 'Fix the login redirect',
      solutions: [],
      workType: null,
      mode: null,
      phase: null,
      coordination: null,
      qaStack: null,
      worktrees: false,
      ultracode: false,
      folder: workspace.id,
      folderKind: 'workspace',
      cwd: g.workspace,
    });
    const { cwd, first } = await spawnOf(s, session);
    expect(cwd).toBe(g.workspace);
    expect(first).toBe('Fix the login redirect.\nIt loops on /callback.');
    expect(first).not.toContain(SESSION_START_HEADER[0]);
    await waitForStatus(s.store, session.id, ['done']);
    // Nothing waits in the outbox (there is no block to hold back).
    expect(await s.store.pendingMessages.pending(session.id)).toEqual([]);
  });

  it('a workspace folder refuses a worktree and solutions; simple must be a boolean; the name / title rules still apply', async () => {
    const { workspace } = await setup();
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [simple(workspace.id, { worktrees: true }), ['worktrees']],
      [simple(workspace.id, { solutions: ['mobile'] }), ['solutions']],
      [simple(workspace.id, { simple: 'yes' }), ['simple']],
      [simple(workspace.id, { name: 'Not Kebab' }), ['name']],
      [simple(workspace.id, { title: 'x'.repeat(81) }), ['title']],
      [simple(workspace.id, { ultracode: 'on' }), ['ultracode']],
    ];
    for (const [body, fields] of cases) {
      const response = await call('POST', '/api/sessions', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
      expect((response.json() as { errors: Array<{ field: string }> }).errors.map((e) => e.field), JSON.stringify(body)).toEqual(fields);
    }
    const worktree = await call('POST', '/api/sessions', simple(workspace.id, { worktrees: true }));
    expect(worktree.json()).toMatchObject({ errors: [{ field: 'worktrees', message: 'a simple session in a workspace folder works in place: its own worktree needs a git repo folder' }] });
    // simple: false is a normal NewSession (the router fields are required again).
    const full = await call('POST', '/api/sessions', simple(workspace.id, { simple: false }));
    expect(full.statusCode).toBe(422);
    expect((full.json() as { errors: Array<{ field: string }> }).errors.map((e) => e.field)).toEqual(expect.arrayContaining(['workType', 'mode', 'phase']));
  });

  it('a repo folder without a worktree: runs in the repo, its one solution, the message alone', async () => {
    const { s, repo, repoPath } = await setup();
    const response = await call('POST', '/api/sessions', simple(repo.id, { worktrees: false }));
    expect(response.statusCode, response.body).toBe(201);
    const session = response.json() as Session;
    expect(session).toMatchObject({ solutions: ['solo'], workType: null, worktrees: false, cwd: repoPath, folderKind: 'repo' });
    const { cwd, first } = await spawnOf(s, session);
    expect(cwd).toBe(repoPath);
    expect(first).toBe('Fix the login redirect.\nIt loops on /callback.');
  });

  it('a repo folder with its own worktree: on sb/<name> by default, the message + only the worktree note', async () => {
    const { s, g, repo, repoPath } = await setup();
    const response = await call('POST', '/api/sessions', simple(repo.id, { worktrees: true }));
    expect(response.statusCode, response.body).toBe(201);
    const session = response.json() as Session;
    const worktree = path.join(path.dirname(repoPath), 'solo-wt-fix-the-login-redirect');
    expect(session).toMatchObject({ cwd: worktree, worktrees: true, solutions: ['solo'], workType: null });
    expect((await stat(worktree)).isDirectory()).toBe(true);
    expect(await g.git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe('sb/fix-the-login-redirect');
    const { cwd, first } = await spawnOf(s, session);
    expect(cwd).toBe(worktree);
    expect(first.split('\n')).toEqual([
      'Fix the login redirect.',
      'It loops on /callback.',
      '',
      REPO_WORKTREE_NOTE_HEADER,
      `- Worktree: ${worktree} (branch sb/fix-the-login-redirect, from main); it is your working folder: make every change here.`,
      `- Main checkout: ${repoPath} (leave it as it is).`,
    ]);
    expect(first).not.toContain(SESSION_START_HEADER[0]);
  });

  it('a repo folder with its own worktree takes any valid git branch name (no ticket rule) and refuses an invalid one', async () => {
    const { s, g, repo, repoPath } = await setup();
    const bad = await call('POST', '/api/sessions', simple(repo.id, { worktrees: true, branch: 'bad..name' }));
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ errors: [{ field: 'branch', message: 'the branch must be a valid git branch name, e.g. sb/short-description' }] });
    const response = await call('POST', '/api/sessions', simple(repo.id, { name: 'free-form', worktrees: true, branch: ' feature/free_form.1 ' }));
    expect(response.statusCode, response.body).toBe(201);
    const worktree = path.join(path.dirname(repoPath), 'solo-wt-free-form');
    expect(await g.git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/free_form.1');
    expect((await s.store.sessions.get((response.json() as Session).id))?.branch).toBe('feature/free_form.1');
  });
});

/**
 * D59 oracle (server, real path): a **plain** folder (no AGENTS.md, not a git
 * repository) is saved like the others (kind `plain`) and takes Simple starts:
 * the process runs in the folder, no solutions, no worktree, the first message is
 * the message alone (plus D57's attachment lines); the session remembers the
 * folder as `plain` (stored as `root_kind` NULL next to its `root`, 0022). A Full
 * start, a worktree, solutions and a schedule template are refused there.
 */
describe('a plain folder (D59)', () => {
  async function plainRig(): Promise<Rig & { readonly plain: Folder; readonly plainPath: string }> {
    const rig = await setup();
    const plainPath = path.join(rig.s.root, 'notes folder');
    await mkdir(plainPath, { recursive: true });
    await writeFile(path.join(plainPath, 'todo.txt'), 'buy milk\n');
    const added = await call('POST', '/api/folders', { path: plainPath });
    expect(added.statusCode, added.body).toBe(201);
    return { ...rig, plain: added.json() as Folder, plainPath };
  }

  it('is saved with kind plain (201; 200 again); its check says plain; it lists with the others; its Solutions are empty', async () => {
    const { plain, plainPath } = await plainRig();
    expect(plain).toMatchObject({ path: plainPath, name: 'notes folder', kind: 'plain', isDefault: false, check: { kind: 'plain', problem: null, solutionCount: 0, router: null, repoName: null } });
    const again = await call('POST', '/api/folders', { path: plainPath });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: plain.id });
    expect(((await call('GET', '/api/folders')).json() as Folder[]).map((f) => f.kind)).toEqual(['workspace', 'repo', 'plain']);
    const check = await call('GET', `/api/folders/check?path=${encodeURIComponent(plainPath)}`);
    expect(check.json()).toMatchObject({ kind: 'plain', exists: true, problem: null, message: '' });
    // Still refused: a file, a missing folder.
    const file = await call('POST', '/api/folders', { path: path.join(plainPath, 'todo.txt') });
    expect(file.statusCode).toBe(422);
    expect(file.json()).toMatchObject({ error: 'invalid', check: { problem: 'not-a-folder' } });
    const solutions = await call('GET', `/api/solutions?folder=${plain.id}`);
    expect(solutions.statusCode, solutions.body).toBe(200);
    expect(solutions.json()).toEqual([]);
  });

  it('a Simple start runs claude in the folder with the message alone; the session remembers the folder as plain', async () => {
    const { s, plain, plainPath } = await plainRig();
    const response = await call('POST', '/api/sessions', simple(plain.id));
    expect(response.statusCode, response.body).toBe(201);
    const session = response.json() as Session;
    expect(session).toMatchObject({ solutions: [], workType: null, mode: null, phase: null, worktrees: false, folder: plain.id, folderPath: plainPath, folderKind: 'plain', cwd: plainPath });
    const { cwd, first } = await spawnOf(s, session);
    expect(cwd).toBe(plainPath);
    expect(first).toBe('Fix the login redirect.\nIt loops on /callback.');
    expect(first).not.toContain(SESSION_START_HEADER[0]);
    expect(first).not.toContain(REPO_WORKTREE_NOTE_HEADER);
    await waitForStatus(s.store, session.id, ['done']);
    // Stored as root + root_kind NULL (0003's CHECK), read back as plain.
    const raw = s.store.db.prepare('SELECT root, root_kind, folder_id FROM sessions WHERE id = ?').get(session.id);
    expect(raw).toEqual({ root: plainPath, root_kind: null, folder_id: plain.id });
    expect((await s.store.sessions.get(session.id))?.rootKind).toBe('plain');
    expect((await call('GET', `/api/sessions/${session.id}`)).json()).toMatchObject({ folderKind: 'plain', folderPath: plainPath });
    // The folder moved up the "recently used" order.
    expect(((await call('GET', '/api/folders')).json() as Folder[]).find((f) => f.id === plain.id)?.lastUsedAt).toEqual(expect.any(String));
  });

  it('a Simple start with a file attachment: the message plus only the attachment lines', async () => {
    const { s, plain } = await plainRig();
    const uploaded = await call('POST', '/api/attachments', { name: 'notes.txt', data: Buffer.from('hello\n').toString('base64') });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const id = (uploaded.json() as { id: string }).id;
    const response = await call('POST', '/api/sessions', simple(plain.id, { task: 'Read my notes.', attachments: [id] }));
    expect(response.statusCode, response.body).toBe(201);
    const { first } = await spawnOf(s, response.json() as Session);
    const lines = first.split('\n');
    expect(lines[0]).toBe('Read my notes.');
    expect(lines).toContain('Attached files:');
    expect(lines.at(-1)).toMatch(new RegExp(`^- .*${id}-notes\\.txt \\(`));
    expect(first).not.toContain(SESSION_START_HEADER[0]);
  });

  it('refuses a worktree, solutions and a Full start there', async () => {
    const { plain } = await plainRig();
    const worktree = await call('POST', '/api/sessions', simple(plain.id, { worktrees: true }));
    expect(worktree.statusCode).toBe(422);
    expect(worktree.json()).toMatchObject({ errors: [{ field: 'worktrees', message: 'a simple session in a plain folder works in place: its own worktree needs a git repo folder' }] });
    const solutions = await call('POST', '/api/sessions', simple(plain.id, { solutions: ['notes'] }));
    expect(solutions.statusCode).toBe(422);
    expect((solutions.json() as { errors: Array<{ field: string }> }).errors.map((e) => e.field)).toEqual(['solutions']);
    const full = await call('POST', '/api/sessions', simple(plain.id, { simple: false, workType: 'feature', mode: 'single', phase: 'ui-first' }));
    expect(full.statusCode).toBe(422);
    expect(full.json()).toMatchObject({ errors: [{ field: 'folder', message: PLAIN_FOLDER_FULL_MESSAGE }] });
  });

  it('a schedule template in a plain folder is refused (schedules are Full starts)', async () => {
    const result = await validateScheduleInput(
      { cron: '0 2 * * *', template: { name: 'nightly', task: 'Tidy up.', workType: 'feature', mode: 'single', phase: 'ui-first', solutions: [], coordination: null, qa: null, worktrees: false, ultracode: false } },
      { scheduleNameTaken: async () => false, folder: { id: 'f-plain', kind: 'plain', repoName: 'notes' } },
    );
    expect(result).toEqual({ ok: false, errors: [{ field: 'template.folder', message: PLAIN_FOLDER_FULL_MESSAGE }] });
  });
});
