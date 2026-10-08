import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Folder, HistoryItem, Session, SessionEvent, TeleportRefusal } from '../../../src/core/api.ts';
import type { LifecyclePayload, UserPayload } from '../../../src/core/event-payload.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { findTranscriptFile } from '../../../src/server/supervisor/attach.ts';
import { buildClaudeArgs } from '../../../src/server/supervisor/argv.ts';
import { generateToken } from '../../../src/server/token.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { REPO_ROOT } from '../../helpers/net.ts';
import { type SupervisorWorld, makeSupervisorWorld, payloadType, spawnedArgv, until, waitForStatus } from '../../helpers/supervisor.ts';

/** D68: every spawn carries the session's switchboard MCP tools (its config file is per session). */
const D68_MCP_ARGS = ['--mcp-config', expect.stringMatching(/agent-mcp[\\/][^\\/]+\.json$/) as unknown as string, '--allowedTools', 'mcp__switchboard'];

/**
 * D25 oracle (server): `POST /api/sessions/teleport` on the real path: fake-claude
 * as the CLI (`--teleport`, docs/fake-claude.md → *Teleport*), a real git repo
 * saved as a repo folder, the real worktree manager, `app.inject`. The happy path
 * (a new worktree, `--teleport session_X` without `--session-id`, the local id
 * from `system/init`, the remote source and the checked-out branch stored, the
 * remote history in the chat, `--resume <local id>` later), the first-message
 * path for a CLI that reports `init` only with a turn, every refusal (the CLI's
 * text verbatim; no worktree, branch or session left), the timeout, and the 422s.
 */
const PORT = 4876; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const ROUTER_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md');
const X = '011CUteleportABCdef';
const ID = `session_${X}`;

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
  /** `<root>/solo`, a git repo with one commit on `main`, saved as a repo folder. */
  readonly repo: Folder;
  readonly repoPath: string;
}

async function setup(options: { readonly teleportInitTimeoutMs?: number } = {}): Promise<Rig> {
  sw = await makeSupervisorWorld({ ...(options.teleportInitTimeoutMs !== undefined ? { teleportInitTimeoutMs: options.teleportInitTimeoutMs } : {}) });
  const g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  // The fake runs git in the worktree: give it the test's isolated git config too.
  for (const [key, value] of Object.entries(g.env)) if (key.startsWith('GIT_') && value !== undefined) sw.env[key] = value;
  await writeFile(path.join(g.workspace, 'AGENTS.md'), await readFile(ROUTER_FIXTURE, 'utf8'));
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

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(g: GitWorld, repo: string, branch: string): Promise<boolean> {
  return (await g.git(repo, 'branch', '--list', branch)).trim() !== '';
}

async function eventsOf(id: string): Promise<SessionEvent[]> {
  return (await call('GET', `/api/sessions/${id}/events`)).json() as SessionEvent[];
}

describe('POST /api/sessions/teleport (D25)', () => {
  it('pulls a remote session into a new worktree: --teleport, the local id from init, the source + branch stored, the history, later --resume', async () => {
    const { s, g, repo, repoPath } = await setup();
    const response = await call('POST', '/api/sessions/teleport', { remote: `https://claude.ai/code/${ID}?from=cli&m=0`, folder: repo.id });
    expect(response.statusCode, response.body).toBe(201);
    const session = response.json() as Session;
    const worktree = path.join(s.root, 'solo-wt-remote-011cutel');
    expect(session).toMatchObject({
      name: 'remote-011cutel',
      title: 'Remote 011CUtel',
      displayTitle: 'Remote 011CUtel',
      remoteSource: ID,
      folder: repo.id,
      folderKind: 'repo',
      folderPath: repoPath,
      cwd: worktree,
      solutions: ['solo'],
      worktrees: true,
      workType: null,
      mode: null,
      phase: null,
      status: 'idle',
      live: true,
      origin: 'switchboard',
    });

    // The spawn: --teleport with the session_ form, no --session-id / --resume, in the new worktree.
    const [spawn] = await spawnedArgv(s.logFile);
    expect(spawn?.cwd).toBe(worktree);
    expect(spawn?.argv).toEqual(buildClaudeArgs({ start: { kind: 'teleport', remoteSession: ID }, name: 'Remote 011CUtel', permissionMode: 'auto', mcpArgs: D68_MCP_ARGS }));
    expect(spawn?.argv).not.toContain('--session-id');
    expect(spawn?.argv).not.toContain('--resume');

    // The local copy's id is the one its system/init reported (its transcript is named after it), never a provisional one.
    expect(session.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await findTranscriptFile(s.configDir, session.claudeSessionId)).not.toBeNull();
    expect(session.resumeCommand).toBe(`claude --resume ${session.claudeSessionId}`);

    // The worktree: on the branch the teleport checked out, recorded on its row; Switchboard's session/<name> stays.
    expect(await g.git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`claude/${ID}`);
    const [row] = await s.store.worktrees.list({ sessionId: session.id });
    expect(row).toMatchObject({ repo: 'solo', repoPath, path: worktree, branch: `claude/${ID}`, baseRef: 'main', removedAt: null });
    expect(await branchExists(g, repoPath, 'session/remote-011cutel')).toBe(true);
    expect(await s.store.sessions.get(session.id)).toMatchObject({ remoteSource: ID });

    // The remote history is the chat's start (prompts with origin remote), after the lifecycle note naming the source.
    const events = await eventsOf(session.id);
    const lifecycle = events.find((event) => payloadType(event as never) === 'lifecycle');
    expect(lifecycle).toMatchObject({ label: 'Continued from a remote session', payload: { action: 'teleported', message: ID } });
    const chat = events.filter((event) => ['user', 'assistant'].includes(payloadType(event as never)));
    expect(chat.map((event) => [payloadType(event as never), (event.payload as UserPayload).text, (event.payload as Partial<UserPayload>).origin ?? null])).toEqual([
      ['user', 'Remote history 1: add a /health endpoint to the API.', 'remote'],
      ['assistant', 'Remote reply 1: added GET /health, which answers { ok: true }, and a test for it.', null],
      ['user', 'Remote history 2: push the branch.', 'remote'],
      ['assistant', `Remote reply 2: pushed claude/${ID}.`, null],
    ]);

    // Listed, tagged in History; a message is an ordinary turn of the local copy.
    expect(((await call('GET', '/api/sessions')).json() as Session[]).map((listed) => listed.id)).toEqual([session.id]);
    const history = (await call('GET', '/api/history')).json() as HistoryItem[];
    expect(history.find((item) => item.sessionId === session.id)).toMatchObject({ mode: 'remote · local copy' });
    expect((await call('POST', `/api/sessions/${session.id}/messages`, { text: 'Reply with just OK.' })).statusCode).toBe(202);
    await waitForStatus(s.store, session.id, ['done']);
    // The first turn's end does not import the history twice.
    const remotePrompts = (await eventsOf(session.id)).filter((event) => payloadType(event as never) === 'user' && (event.payload as UserPayload).origin === 'remote');
    expect(remotePrompts).toHaveLength(2);

    // Pause, then Resume: --resume <local id> with the baseline flags, in the worktree; never --teleport again.
    expect((await call('POST', `/api/sessions/${session.id}/pause`)).statusCode).toBe(200);
    expect((await call('POST', `/api/sessions/${session.id}/resume`)).statusCode).toBe(200);
    const spawns = await until(async () => {
      const all = await spawnedArgv(s.logFile);
      return all.length >= 2 ? all : undefined;
    }, 'the resume spawn');
    expect(spawns[1]?.cwd).toBe(worktree);
    expect(spawns[1]?.argv).toEqual(buildClaudeArgs({ start: { kind: 'resume', claudeSessionId: session.claudeSessionId }, name: 'Remote 011CUtel', permissionMode: 'auto', mcpArgs: D68_MCP_ARGS }));
    expect(spawns[1]?.argv).not.toContain('--teleport');
    await waitForStatus(s.store, session.id, ['done']);
  });

  it('a typed title names it (D22), a cse_ id is the same session; the next default name gets -2', async () => {
    const { s, repo } = await setup();
    const titled = await call('POST', '/api/sessions/teleport', { remote: `cse_${X}`, folder: repo.id, title: '  Cloud health work ' });
    expect(titled.statusCode, titled.body).toBe(201);
    expect(titled.json()).toMatchObject({ name: 'cloud-health-work', title: 'Cloud health work', remoteSource: ID, cwd: path.join(s.root, 'solo-wt-cloud-health-work') });
    // A session already named remote-<8>: the default name of another remote session with the same 8 characters gets -2.
    await s.store.sessions.create({ name: 'remote-011cutel', claudeSessionId: 'c-taken' });
    const other = await call('POST', '/api/sessions/teleport', { remote: `session_${X}zz`, folder: repo.id });
    expect(other.statusCode, other.body).toBe(201);
    expect(other.json()).toMatchObject({ name: 'remote-011cutel-2', title: 'Remote 011CUtel', remoteSource: `session_${X}zz` });
  });

  it('a CLI that reports init only with a turn: the optional first message starts it; its id, then the history, are taken from that turn', async () => {
    const { s, repo } = await setup();
    s.env['FAKE_CLAUDE_TELEPORT'] = 'no-init';
    const response = await call('POST', '/api/sessions/teleport', { remote: ID, folder: repo.id, task: 'Reply with just OK.' });
    expect(response.statusCode, response.body).toBe(201);
    const session = response.json() as Session;
    expect(session.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    const [spawn] = await spawnedArgv(s.logFile);
    expect(spawn?.argv).toContain('--teleport');
    await waitForStatus(s.store, session.id, ['done']);
    // The history is imported after the first turn, in front of it (its timestamps are older); the task is not duplicated.
    const chat = await until(async () => {
      const events = (await eventsOf(session.id)).filter((event) => ['user', 'assistant'].includes(payloadType(event as never)));
      return events.some((event) => (event.payload as Partial<UserPayload>).origin === 'remote') ? events : undefined;
    }, 'the remote history');
    const sorted = [...chat].sort((a, b) => (a.ts === b.ts ? a.id - b.id : a.ts < b.ts ? -1 : 1));
    expect(sorted.map((event) => [payloadType(event as never), (event.payload as Partial<UserPayload>).origin ?? null])).toEqual([
      ['user', 'remote'],
      ['assistant', null],
      ['user', 'remote'],
      ['assistant', null],
      ['user', 'task'],
      ['assistant', null],
    ]);
    expect(sorted[4]?.payload).toMatchObject({ text: 'Reply with just OK.', delivered: true });
  });

  it('each CLI refusal comes back verbatim (502) and leaves no worktree, branch or session', async () => {
    const { s, g, repo, repoPath } = await setup();
    const cases: Array<[Record<string, string>, string]> = [
      [{ FAKE_CLAUDE_TELEPORT: 'dirty' }, 'Git working directory is not clean. Please commit or stash your changes before using --teleport.'],
      [{ FAKE_CLAUDE_TELEPORT: 'wrong-repo', FAKE_CLAUDE_TELEPORT_REPO: 'acme/web-front' }, `You must run claude --teleport ${ID} from a checkout of acme/web-front`],
      [{ FAKE_CLAUDE_TELEPORT: 'not-pushed' }, `Failed to fetch branch claude/${ID} from origin: fatal: couldn't find remote ref claude/${ID}`],
      [{ FAKE_CLAUDE_TELEPORT: 'archived' }, `cloud session ${ID} is archived and cannot accept new messages`],
      [{ FAKE_CLAUDE_SIGNED_OUT: '1' }, 'Not logged in · Please run /login'],
    ];
    for (const [env, text] of cases) {
      for (const key of ['FAKE_CLAUDE_TELEPORT', 'FAKE_CLAUDE_TELEPORT_REPO', 'FAKE_CLAUDE_SIGNED_OUT']) delete s.env[key];
      Object.assign(s.env, env);
      const response = await call('POST', '/api/sessions/teleport', { remote: ID, folder: repo.id, title: 'Pulled work' });
      expect(response.statusCode, JSON.stringify(env)).toBe(502);
      expect(response.json()).toEqual<TeleportRefusal>({ error: 'teleport-failed', message: text });
      expect(await exists(path.join(s.root, 'solo-wt-pulled-work')), JSON.stringify(env)).toBe(false);
      expect(await branchExists(g, repoPath, 'session/pulled-work'), JSON.stringify(env)).toBe(false);
      expect(await s.store.sessions.list(), JSON.stringify(env)).toEqual([]);
      expect(s.supervisor.liveCount).toBe(0);
    }
    expect(await s.store.worktrees.list()).toEqual([]);
    expect((await s.store.worktrees.list({ includeRemoved: true })).every((row) => row.removedAt !== null)).toBe(true);
    expect((await call('GET', '/api/sessions')).json()).toEqual([]);
    // The repo's own checkout never moved.
    expect(await g.git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('a git failure inside the teleport is shown as git said it: the same remote session pulled twice (its branch is checked out in the first copy)', async () => {
    const { s, repo } = await setup();
    expect((await call('POST', '/api/sessions/teleport', { remote: ID, folder: repo.id })).statusCode).toBe(201);
    const again = await call('POST', '/api/sessions/teleport', { remote: ID, folder: repo.id });
    expect(again.statusCode).toBe(502);
    const body = again.json() as TeleportRefusal;
    expect(body.error).toBe('teleport-failed');
    expect(body.message).toContain(`claude/${ID}`);
    expect(body.message).toMatch(/already (checked out|used by worktree)/);
    expect(await exists(path.join(s.root, 'solo-wt-remote-011cutel-2'))).toBe(false);
    expect((await s.store.sessions.list()).map((session) => session.name)).toEqual(['remote-011cutel']);
  });

  it('no system/init in time: 504, the process stopped, nothing left; the text says to try with a first message', async () => {
    const { s, g, repo, repoPath } = await setup({ teleportInitTimeoutMs: 1_500 });
    s.env['FAKE_CLAUDE_TELEPORT'] = 'no-init';
    const response = await call('POST', '/api/sessions/teleport', { remote: ID, folder: repo.id });
    expect(response.statusCode).toBe(504);
    const body = response.json() as TeleportRefusal;
    expect(body).toMatchObject({ error: 'teleport-timeout' });
    expect(body.message).toContain('no system/init');
    expect(body.message).toContain('try again with a first message');
    expect(s.supervisor.liveCount).toBe(0);
    expect(await s.store.sessions.list()).toEqual([]);
    expect(await exists(path.join(s.root, 'solo-wt-remote-011cutel'))).toBe(false);
    expect(await branchExists(g, repoPath, 'session/remote-011cutel')).toBe(false);
  });

  it('refuses a workspace folder, an unknown or missing folder, and bad input (422), before anything is made', async () => {
    const { s, workspace, repo } = await setup();
    const expectInvalid = async (body: unknown, field: string): Promise<void> => {
      const response = await call('POST', '/api/sessions/teleport', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
      const json = response.json() as { error: string; errors: Array<{ field: string; message: string }> };
      expect(json.error).toBe('invalid');
      expect(json.errors.map((error) => error.field)).toContain(field);
    };
    await expectInvalid({ remote: ID, folder: workspace.id }, 'folder');
    const workspaceRefusal = (await call('POST', '/api/sessions/teleport', { remote: ID, folder: workspace.id })).json() as { errors: Array<{ message: string }> };
    expect(workspaceRefusal.errors[0]?.message).toContain('pick a git repo folder');
    await expectInvalid({ remote: ID, folder: 'nope' }, 'folder');
    await expectInvalid({ remote: ID }, 'folder');
    await expectInvalid({ remote: 'not-a-session', folder: repo.id }, 'remote');
    await expectInvalid({ remote: 'https://example.com/code/session_x', folder: repo.id }, 'remote');
    await expectInvalid({ folder: repo.id }, 'remote');
    await expectInvalid({ remote: ID, folder: repo.id, title: 'x'.repeat(81) }, 'title');
    await expectInvalid({ remote: ID, folder: repo.id, task: 42 }, 'task');
    await expectInvalid('just text', '');
    expect((await call('POST', '/api/sessions/teleport')).statusCode).toBe(422);
    expect(await spawnedArgv(s.logFile)).toEqual([]);
    expect(await s.store.worktrees.list({ includeRemoved: true })).toEqual([]);
    expect(await s.store.sessions.list()).toEqual([]);
  });

  it('a saved repo folder gone from disk is 409 folder-missing', async () => {
    const { s, repo, repoPath } = await setup();
    await mkdir(path.join(s.root, 'elsewhere'), { recursive: true });
    await rename(repoPath, path.join(s.root, 'elsewhere', 'solo'));
    const response = await call('POST', '/api/sessions/teleport', { remote: ID, folder: repo.id });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'folder-missing' });
  });

  it('while a teleport has not reported init, the session is not listed and not announced', async () => {
    const { s, repo } = await setup({ teleportInitTimeoutMs: 1_500 });
    s.env['FAKE_CLAUDE_TELEPORT'] = 'no-init';
    const updates: string[] = [];
    s.supervisor.on('sessionUpdated', (session) => updates.push(session.id));
    const pending = call('POST', '/api/sessions/teleport', { remote: ID, folder: repo.id });
    const stored = await until(async () => (await s.store.sessions.list())[0], 'the stored session');
    expect(s.supervisor.isStarting(stored.id)).toBe(true);
    expect(stored.claudeSessionId).toMatch(/^teleport-pending-/);
    expect((await call('GET', '/api/sessions')).json()).toEqual([]);
    // Its lifecycle note is stored, but no event reached the hub for it.
    const lifecycle = await until(async () => {
      const found = (await s.store.events.list(stored.id)).filter((event) => (event.payload as LifecyclePayload).type === 'lifecycle');
      return found.length > 0 ? found : undefined;
    }, 'the lifecycle note');
    expect(lifecycle.map((event) => event.label)).toEqual(['Continued from a remote session']);
    expect((await pending).statusCode).toBe(504);
    expect(updates).toEqual([]);
  });
});
