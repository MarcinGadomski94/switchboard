/**
 * D109 · Import issues as todos (`docs/todos.md` → *Import issues (D109)*): the routes on a
 * built app; GitHub through tools/fake-gh (`FAKE_GH_ISSUES`), Jira through the fake Jira
 * (tests/helpers/fake-jira.ts) and the Plans Jira connection; never the real services.
 * Re-importing never duplicates; the device and peer classification of the new routes.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IssueImportPreview, IssueImportSources, SessionTodoList } from '../../../src/core/api.ts';
import { peerAnswerKind } from '../../../src/core/peer-wire.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import { runCommand } from '../../../src/server/exec.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { fakeGhBinEnv } from '../../../tools/fake-gh/command.ts';
import { type FakeJira, startFakeJira } from '../../helpers/fake-jira.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

const PORT = 4921; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let tmp: string;
let store: Store;
let app: FastifyInstance;
let token: string;
let jira: FakeJira | undefined;

const ISSUES = {
  'acme/web-front': [
    { number: 12, title: 'Checkout button overlaps the footer', body: 'On 360 px the button sits on the footer.\n\nSteps: open /checkout.', url: 'https://github.com/acme/web-front/issues/12', labels: [{ name: 'bug' }], assignees: [{ login: 'fake-gh' }], state: 'OPEN' },
    { number: 13, title: 'Add dark mode', body: '', url: 'https://github.com/acme/web-front/issues/13', labels: [{ name: 'feature' }], assignees: [], state: 'OPEN' },
    { number: 9, title: 'Old closed one', body: 'done', url: 'https://github.com/acme/web-front/issues/9', labels: [{ name: 'bug' }], assignees: [], state: 'CLOSED' },
  ],
};

beforeEach(async () => {
  tmp = await makeTempDir('api-todo-import');
  store = await openTempStore(tmp);
  token = generateToken();
  const issues = path.join(tmp, 'issues.json');
  await writeFile(issues, JSON.stringify(ISSUES));
  process.env['FAKE_GH_ISSUES'] = issues;
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp, SWITCHBOARD_GH_BIN: fakeGhBinEnv() }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp });
  await app.ready();
});

afterEach(async () => {
  delete process.env['FAKE_GH_ISSUES'];
  await app.close();
  await store.close();
  await jira?.close();
  jira = undefined;
  await removeTempDir(tmp);
});

function ui(method: InjectOptions['method'], url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function session(name: string): Promise<string> {
  return (await store.sessions.create({ name, claudeSessionId: randomUUID() })).id;
}

describe('D109 · import issues from GitHub', () => {
  it('previews the open issues (label, assigned to me), imports the ticked ones with a link back, and never twice', async () => {
    const id = await session('import-gh');
    const preview = await ui('POST', `/api/sessions/${id}/todos/import/preview`, { source: 'github', repo: 'acme/web-front', label: null, mine: false });
    expect(preview.statusCode, preview.body).toBe(200);
    const body = preview.json() as IssueImportPreview;
    expect(body.issues.map((issue) => issue.key)).toEqual(['acme/web-front#12', 'acme/web-front#13']);
    expect(body.issues[0]).toMatchObject({ title: 'Checkout button overlaps the footer', url: 'https://github.com/acme/web-front/issues/12', labels: ['bug'], imported: false });
    const filtered = (await ui('POST', `/api/sessions/${id}/todos/import/preview`, { source: 'github', repo: 'acme/web-front', label: 'bug', mine: true })).json() as IssueImportPreview;
    expect(filtered.issues.map((issue) => issue.key)).toEqual(['acme/web-front#12']);

    const imported = await ui('POST', `/api/sessions/${id}/todos/import`, { query: { source: 'github', repo: 'acme/web-front' }, keys: ['acme/web-front#12'] });
    expect(imported.statusCode, imported.body).toBe(201);
    const list = imported.json() as SessionTodoList;
    expect(list.todos).toHaveLength(1);
    expect(list.todos[0]).toMatchObject({ title: '#12 Checkout button overlaps the footer', addedBy: 'developer', state: 'open' });
    expect(list.todos[0]?.description).toBe('On 360 px the button sits on the footer.\n\nSteps: open /checkout.\n\nGitHub: https://github.com/acme/web-front/issues/12');
    expect(list.todos[0]?.plan).toBe('No plan: imported from GitHub (acme/web-front#12)');

    // Re-import: #12 is marked imported in the preview and skipped by the import; #13 is added once.
    const again = (await ui('POST', `/api/sessions/${id}/todos/import/preview`, { source: 'github', repo: 'acme/web-front' })).json() as IssueImportPreview;
    expect(again.issues.map((issue) => [issue.key, issue.imported])).toEqual([
      ['acme/web-front#12', true],
      ['acme/web-front#13', false],
    ]);
    const second = (await ui('POST', `/api/sessions/${id}/todos/import`, { query: { source: 'github', repo: 'acme/web-front' }, keys: ['acme/web-front#12', 'acme/web-front#13'] })).json() as SessionTodoList;
    expect(second.todos.map((todo) => todo.title)).toEqual(['#12 Checkout button overlaps the footer', '#13 Add dark mode']);
    // Even after the todo is removed, the issue is not imported again.
    await ui('DELETE', `/api/sessions/${id}/todos/${second.todos[0]?.id ?? ''}`);
    const third = (await ui('POST', `/api/sessions/${id}/todos/import`, { query: { source: 'github', repo: 'acme/web-front' }, keys: ['acme/web-front#12'] })).json() as SessionTodoList;
    expect(third.todos.map((todo) => todo.title)).toEqual(['#13 Add dark mode']);
    // Another session imports it on its own.
    const other = await session('import-other');
    const theirs = (await ui('POST', `/api/sessions/${other}/todos/import`, { query: { source: 'github', repo: 'acme/web-front' }, keys: ['acme/web-front#12'] })).json() as SessionTodoList;
    expect(theirs.todos).toHaveLength(1);
  });

  it('refuses a bad query (422), an unknown repo (502 with gh\'s message), nothing ticked, an unknown session (404)', async () => {
    const id = await session('import-bad');
    expect((await ui('POST', `/api/sessions/${id}/todos/import/preview`, { source: 'github', repo: 'not a repo' })).json()).toMatchObject({ error: 'invalid', field: 'repo' });
    const unknown = await ui('POST', `/api/sessions/${id}/todos/import/preview`, { source: 'github', repo: 'acme/nothing' });
    expect(unknown.statusCode).toBe(502);
    expect(unknown.json().message).toMatch(/Could not resolve to a Repository/);
    expect((await ui('POST', `/api/sessions/${id}/todos/import`, { query: { source: 'github', repo: 'acme/web-front' }, keys: [] })).statusCode).toBe(422);
    expect((await ui('POST', '/api/sessions/nope/todos/import/preview', { source: 'github', repo: 'acme/web-front' })).statusCode).toBe(404);
  });

  it('sources: the session\'s repositories as owner/repo (gh repo view) and whether Jira is connected', async () => {
    const id = await session('import-sources');
    const repo = path.join(tmp, 'acme-web');
    await mkdir(repo, { recursive: true });
    await runCommand(['git'], ['init', '-q', '-b', 'main'], { cwd: repo });
    await store.worktrees.create({ repo: 'acme-web', repoPath: repo, branch: 'main', path: repo, sessionId: id });
    const sources = (await ui('GET', `/api/sessions/${id}/todos/import/sources`)).json() as IssueImportSources;
    expect(sources.github).toEqual({ available: true, repos: ['fake/acme-web'], problem: null });
    expect(sources.jira.available).toBe(false);
    expect(sources.jira.problem).toMatch(/Settings → Jira/);
  });
});

describe('D109 · import issues from Jira', () => {
  it('uses the Plans Jira connection (Settings → Jira): JQL or a project key, a link back, no duplicates', async () => {
    jira = await startFakeJira();
    const id = await session('import-jira');
    // Without a connection: 409 with the explanation.
    expect((await ui('POST', `/api/sessions/${id}/todos/import/preview`, { source: 'jira', project: 'PROJ' })).json()).toMatchObject({ error: 'jira-unavailable' });
    // The connection lives in Settings → Jira (D132: Plans is always on).
    const saved = await ui('PUT', '/api/integrations/jira', { baseUrl: jira.url, email: jira.email, token: jira.token });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(((await ui('GET', `/api/sessions/${id}/todos/import/sources`)).json() as IssueImportSources).jira).toEqual({ available: true, problem: null });

    const preview = await ui('POST', `/api/sessions/${id}/todos/import/preview`, { source: 'jira', jql: 'parent = PROJ-10 ORDER BY key' });
    expect(preview.statusCode, preview.body).toBe(200);
    const issues = (preview.json() as IssueImportPreview).issues;
    expect(issues.length).toBeGreaterThan(1);
    const first = issues[0]!;
    expect(first.url).toBe(`${jira.url}/browse/${first.key}`);
    const imported = (await ui('POST', `/api/sessions/${id}/todos/import`, { query: { source: 'jira', jql: 'parent = PROJ-10 ORDER BY key' }, keys: [first.key] })).json() as SessionTodoList;
    expect(imported.todos).toHaveLength(1);
    expect(imported.todos[0]?.title.startsWith(`${first.key} `)).toBe(true);
    expect(imported.todos[0]?.description?.endsWith(`Jira: ${jira.url}/browse/${first.key}`)).toBe(true);
    // Re-import: skipped.
    const again = (await ui('POST', `/api/sessions/${id}/todos/import`, { query: { source: 'jira', jql: 'parent = PROJ-10 ORDER BY key' }, keys: [first.key] })).json() as SessionTodoList;
    expect(again.todos).toHaveLength(1);
    expect(((await ui('POST', `/api/sessions/${id}/todos/import/preview`, { source: 'jira', jql: 'parent = PROJ-10 ORDER BY key' })).json() as IssueImportPreview).issues.find((issue) => issue.key === first.key)?.imported).toBe(true);
    // The token went to the fake Jira only, in the Authorization header, never into an answer.
    expect(jira.requests.every((request) => request.authorization?.startsWith('Basic '))).toBe(true);
    expect(JSON.stringify(again)).not.toContain(jira.token);
  });
});

describe('D109 · routes for devices and paired machines', () => {
  it('phones may import and read the PR chip (Merge PR is the Inbox action); peers forward all of them', () => {
    for (const [method, url] of [
      ['GET', '/api/sessions/s1/todos/import/sources'],
      ['POST', '/api/sessions/s1/todos/import/preview'],
      ['POST', '/api/sessions/s1/todos/import'],
      ['GET', '/api/sessions/s1/ci'],
      ['POST', '/api/inbox/i1/actions/merge-pr'],
    ] as const) {
      expect(isLocalOnly(method, url), `${method} ${url}`).toBe(false);
      expect(peerApiAllowed(method, url), `${method} ${url}`).toBe(true);
    }
    // The import answers the session's list (namespaced like every todo route); sources / preview / ci carry no ids.
    expect(peerAnswerKind('POST', '/api/sessions/s1/todos/import')).toBe('todo-list');
    expect(peerAnswerKind('POST', '/api/sessions/s1/todos/import/preview')).toBe('none');
    expect(peerAnswerKind('GET', '/api/sessions/s1/ci')).toBe('none');
  });

  it('GET /api/sessions/{id}/ci: the watched PRs (none yet), 404 for an unknown session', async () => {
    const id = await session('ci-status');
    expect((await ui('GET', `/api/sessions/${id}/ci`)).json()).toEqual({ prs: [] });
    expect((await ui('GET', '/api/sessions/nope/ci')).statusCode).toBe(404);
  });
});
