import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewSession, Session } from '../../../src/core/api.ts';
import { SESSION_START_KIND } from '../../../src/core/first-turn.ts';
import type { UserPayload } from '../../../src/core/event-payload.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { delay } from '../../helpers/fake-claude.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { REPO_ROOT } from '../../helpers/net.ts';
import { type FakeLogLine, type SupervisorWorld, isHandshake, makeSupervisorWorld, payloadType, readFakeLog, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * M5.2 oracle: the first-turn payload on the real code path (D13, no demo).
 * Sessions are started through `POST /api/sessions` (the route the New-session
 * modal posts to) with fake-claude as the CLI (`FAKE_CLAUDE_LOG`), real git
 * repositories in a temp workspace and the real worktree manager (fake gh). The
 * argv carries no prompt, and the first stdin line is exactly one user message
 * whose content equals a golden file (`tests/fixtures/first-turn/*.txt`,
 * `<workspace>` = the temp workspace root).
 */
const PORT = 4874; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const GOLDEN = path.join(REPO_ROOT, 'tests', 'fixtures', 'first-turn');

let sw: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await sw?.cleanup();
  app = undefined;
  sw = undefined;
});

async function setup(): Promise<{ s: SupervisorWorld; g: GitWorld }> {
  sw = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  const worktrees = g.manager({ sessions: sw.supervisor });
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
  await seedFolder(sw.store, g.workspace);
  app = await buildApp({
    config: { ...base, port: PORT },
    token,
    store: sw.store,
    webRoot: sw.root,
    supervisor: sw.supervisor,
    worktrees,
  });
  await app.ready();
  return { s: sw, g };
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

/** A golden payload with `<workspace>/a/b` turned into the OS path under the temp workspace. */
async function golden(name: string, workspace: string): Promise<string> {
  const text = await readFile(path.join(GOLDEN, `${name}.txt`), 'utf8');
  return text
    .replace(/\n$/, '')
    .replace(/<workspace>((?:\/[^\s/)]+)*)/g, (_match, rest: string) => path.join(workspace, ...rest.split('/').filter(Boolean)));
}

/** The exact line the supervisor must write: `{"type":"user","message":{"role":"user","content":<payload>}}`. */
function userLine(content: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}

/** The argv of a new session: the baseline, `--session-id`, `--name`, the two stream flags. No prompt. */
function expectedArgv(claudeSessionId: string, name: string): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-prompt-tool',
    'stdio',
    '--permission-mode',
    'auto',
    '--session-id',
    claudeSessionId,
    // D68: every spawn carries the session's switchboard MCP tools.
    '--mcp-config',
    expect.stringMatching(/agent-mcp[\\/][^\\/]+\.json$/),
    '--allowedTools',
    'mcp__switchboard',
    '--name',
    name,
    '--forward-subagent-text',
    '--replay-user-messages',
  ];
}

/** Starts a session through the route and returns it with the fake's argv line and raw stdin lines. */
async function start(s: SupervisorWorld, body: NewSession): Promise<{ session: Session; spawn: FakeLogLine; stdin: string[] }> {
  const response = await call('POST', '/api/sessions', body);
  expect(response.statusCode, response.body).toBe(201);
  const session = response.json() as Session;
  const pid = (await s.store.sessions.get(session.id))?.pid ?? null;
  await waitForStatus(s.store, session.id, ['done', 'idle']);
  const spawn = await until(async () => {
    const log = await readFakeLog(s.logFile);
    return log.find((line) => line.kind === 'argv' && line.argv?.includes(session.claudeSessionId));
  }, `the spawn of ${body.name}`);
  if (pid !== null) expect(spawn.pid).toBe(pid);
  const stdin = (await readFakeLog(s.logFile)).filter((line) => line.kind === 'stdin' && line.pid === spawn.pid && !isHandshake(JSON.parse(line.line as string) as Record<string, unknown>)).map((line) => line.line as string);
  return { session, spawn, stdin };
}

const FEATURE_SINGLE: NewSession = {
  name: 'feature-single',
  task: 'Build the free talk screen at 640 on web.',
  workType: 'feature',
  mode: 'single',
  solutions: ['web-front'],
  phase: 'ui-first',
  coordination: 'sequential',
  qa: null,
  worktrees: true,
  ultracode: false,
  // D32: the developer's ticket branch, which the worktree line names.
  branch: 'PROJ-0640-free-talk-web',
};

const ORCHESTRATOR: NewSession = {
  name: 'orchestrator-run',
  task: '  Wire the free talk screen to the Gateway on web and mobile.\nThe contract is in contracts/free-talk.md.\n',
  workType: 'feature',
  mode: 'orchestrator',
  solutions: ['web-front', 'mobile'],
  phase: 'integration',
  coordination: null,
  qa: null,
  worktrees: true,
  ultracode: true,
  // D32: one ticket branch in every solution's repo.
  branch: 'PROJ-0641-free-talk-gateway',
};

const QA: NewSession = {
  name: 'qa-free-talk',
  task: 'Write E2E tests for free talk at 360 and 640.',
  workType: 'qa',
  mode: 'single',
  solutions: ['microfrontends/web-front'],
  phase: 'ui-first',
  coordination: null,
  qa: {
    stack: 'web',
    confluenceUrl: 'https://example.atlassian.net/wiki/spaces/SL/pages/2231902/Free+talk',
    figmaUrls: ['https://www.figma.com/design/AbC123/Acme?node-id=2231-902', 'https://www.figma.com/design/AbC123/Acme?node-id=2231-990'],
  },
  worktrees: false,
  ultracode: false,
};

describe('first-turn payload (M5.2) through POST /api/sessions + fake-claude', () => {
  it('feature/single with worktrees, orchestrator, QA: no prompt argument, the first stdin line = the golden payload', async () => {
    const { s, g } = await setup();
    const cases: Array<[string, NewSession]> = [
      ['feature-single-worktrees', FEATURE_SINGLE],
      ['orchestrator', ORCHESTRATOR],
      ['qa', QA],
    ];
    for (const [file, body] of cases) {
      const { session, spawn, stdin } = await start(s, body);
      const payload = await golden(file, g.workspace);
      expect(spawn.argv, file).toEqual(expectedArgv(session.claudeSessionId, body.name));
      expect(spawn.cwd, file).toBe(g.workspace);
      expect(stdin[0], file).toBe(userLine(payload));
      expect(stdin, file).toHaveLength(1);
      // The same text is the session's first user event (origin task); the stored task stays as typed.
      const events = await s.store.events.list(session.id);
      const first = events.find((e) => payloadType(e) === 'user');
      expect((first?.payload as UserPayload).text, file).toBe(payload);
      expect((first?.payload as UserPayload).origin, file).toBe('task');
      expect((await s.store.sessions.get(session.id))?.task, file).toBe(body.task);
    }
    // The worktrees named in the payloads exist on disk, on the ticket branches (D32).
    for (const [repo, name, branch] of [
      [g.web, 'feature-single', 'PROJ-0640-free-talk-web'],
      [g.web, 'orchestrator-run', 'PROJ-0641-free-talk-gateway'],
      [g.mobile, 'orchestrator-run', 'PROJ-0641-free-talk-gateway'],
    ] as const) {
      const folder = path.join(path.dirname(repo), `${path.basename(repo)}-wt-${name}`);
      expect(await g.git(folder, 'symbolic-ref', '--short', 'HEAD')).toBe(branch);
    }
    expect(await s.store.worktrees.list({ sessionId: (await s.store.sessions.getByName('qa-free-talk'))?.id ?? '' })).toEqual([]);
  });

  it('an empty task starts the process idle; the answers go out ahead of the first message the developer writes', async () => {
    const { s, g } = await setup();
    const body: NewSession = { ...FEATURE_SINGLE, name: 'no-task-yet', task: '   ' };
    const { session, spawn, stdin } = await start(s, body);
    expect(spawn.argv).toEqual(expectedArgv(session.claudeSessionId, 'no-task-yet'));
    await delay(300);
    expect(stdin).toEqual([]);
    expect((await s.store.sessions.get(session.id))?.status).toBe('idle');
    const queued = await s.store.pendingMessages.pending(session.id);
    expect(queued.map((m) => m.kind)).toEqual([SESSION_START_KIND]);
    const block = (await golden('feature-single-worktrees', g.workspace))
      .replace('Build the free talk screen at 640 on web.\n\n', '')
      .replaceAll('feature-single', 'no-task-yet');
    expect(queued[0]?.text).toBe(block);

    expect((await call('POST', `/api/sessions/${session.id}/messages`, { text: 'Build the free talk screen at 640 on web.' })).statusCode).toBe(202);
    const lines = await until(async () => {
      const log = await readFakeLog(s.logFile);
      const own = log.filter((line) => line.kind === 'stdin' && line.pid === spawn.pid && !isHandshake(JSON.parse(line.line as string) as Record<string, unknown>)).map((line) => line.line as string);
      return own.length > 0 ? own : undefined;
    }, 'the first message');
    expect(lines[0]).toBe(userLine(`${block}\n\nBuild the free talk screen at 640 on web.`));
    expect(await s.store.pendingMessages.pending(session.id)).toEqual([]);
    await waitForStatus(s.store, session.id, ['done']);
    // Delivered once: the next message goes out alone.
    expect((await call('POST', `/api/sessions/${session.id}/messages`, { text: 'Next.' })).statusCode).toBe(202);
    const again = await until(async () => {
      const log = await readFakeLog(s.logFile);
      const own = log.filter((line) => line.kind === 'stdin' && line.pid === spawn.pid && !isHandshake(JSON.parse(line.line as string) as Record<string, unknown>)).map((line) => line.line as string);
      return own.length > 1 ? own : undefined;
    }, 'the second message');
    expect(again[1]).toBe(userLine('Next.'));
  });
});
