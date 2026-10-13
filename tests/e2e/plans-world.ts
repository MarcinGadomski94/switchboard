import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect } from '@playwright/test';
import type { Plan, PlanItem, PlanItemState } from '../../src/core/plans.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { type FakeJira, startFakeJira } from '../helpers/fake-jira.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { type GitWorld, makeGitWorld } from '../helpers/git.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * D99 · the Plans page's real-path world (no demo seed: demo mode never runs plans):
 * `node src/server/main.ts` with fake-claude and fake gh over temp git repos. The source
 * session works in the `mobile` repo (a repo folder without a remote, so items merge
 * locally); helpers switch Plans on, add todos, and play an item's agent (a commit in its
 * worktree, then a message so its turn ends) the way the core's integration test does. The
 * server's Jira credentials point at the fake Jira (`tests/helpers/fake-jira.ts`).
 */
export interface PlansWorld {
  readonly git: GitWorld;
  readonly server: ServerProcess;
  readonly baseUrl: string;
  /** The fake Jira the server's ATL_* point at (loopback; never the real Jira). */
  readonly jira: FakeJira;
  /** Calls the agent API as session `sessionId`'s own agent (its token from the MCP config Switchboard wrote for it). */
  asAgent(sessionId: string, url: string, body: unknown): Promise<{ readonly status: number; readonly body: any }>;
  /** The epic branch every plan here targets. */
  readonly target: string;
  /** Calls the local API from the page (same origin, the sb_token cookie). */
  call(page: Page, method: string, url: string, body?: unknown): Promise<{ readonly status: number; readonly body: any }>;
  /** Settings → Experimental → Plans through `PUT /api/settings`. */
  setPlans(page: Page, on: boolean): Promise<void>;
  /** A simple session in the `mobile` repo folder (its todos are the plan's items). */
  sourceSession(page: Page, name: string): Promise<string>;
  /** Adds a todo to `sessionId`; answers its id. */
  addTodo(page: Page, sessionId: string, title: string, estimateMinutes?: number): Promise<string>;
  /** The plan as the API answers it. */
  plan(page: Page, planId: string): Promise<Plan>;
  /** Waits for item `key` of `planId` to be in `state`. */
  itemIn(page: Page, planId: string, key: string, state: PlanItemState, timeoutMs?: number): Promise<PlanItem>;
  /** Plays item `key`'s agent: waits for its first turn, commits a file in its worktree, sends "Finished." (its turn ends; a Review card follows). */
  agentWorks(page: Page, planId: string, key: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startPlansWorld(): Promise<PlansWorld> {
  const git = await makeGitWorld();
  const claudeConfig = path.join(git.root, 'claude-config');
  await mkdir(claudeConfig, { recursive: true });
  await seedFolderInDataDir(path.join(git.root, 'data'), git.workspace);
  const jira = await startFakeJira();
  const server = await startServer({
    ATL_BASE_URL: jira.url,
    ATL_USER: jira.email,
    ATL_TOKEN: jira.token,
    SWITCHBOARD_DATA_DIR: path.join(git.root, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: claudeConfig,
    FAKE_GH_PRS: git.prsFile,
    GIT_CONFIG_GLOBAL: String(git.env['GIT_CONFIG_GLOBAL']),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Switchboard Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  });
  const call: PlansWorld['call'] = async (page, method, url, body) =>
    page.evaluate(
      async ({ method, url, body }) => {
        const response = await fetch(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
      },
      { method, url, body },
    );
  const plan: PlansWorld['plan'] = async (page, planId) => {
    const answer = await call(page, 'GET', `/api/plans/${planId}`);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body as Plan;
  };
  const itemOf = async (page: Page, planId: string, key: string): Promise<PlanItem> => {
    const found = (await plan(page, planId)).items.find((item) => item.key === key);
    if (!found) throw new Error(`no item ${key}`);
    return found;
  };
  const itemIn: PlansWorld['itemIn'] = async (page, planId, key, state, timeoutMs = 30_000) => {
    await expect.poll(async () => (await itemOf(page, planId, key)).state, { timeout: timeoutMs, message: `${key} ${state}` }).toBe(state);
    return itemOf(page, planId, key);
  };
  return {
    git,
    server,
    jira,
    async asAgent(sessionId, url, body) {
      const config = JSON.parse(await readFile(path.join(git.root, 'data', 'agent-mcp', `${sessionId}.json`), 'utf8')) as { mcpServers: { switchboard: { env: Record<string, string> } } };
      const response = await fetch(`${server.baseUrl}${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.mcpServers.switchboard.env['SWITCHBOARD_TODO_TOKEN']}`, 'x-switchboard-session': sessionId },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    baseUrl: server.baseUrl,
    target: 'feature/PROJ-100-acme-epic',
    call,
    async setPlans(page, on) {
      const answer = await call(page, 'PUT', '/api/settings', { 'experimental.plans': on });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    },
    async sourceSession(page, name) {
      const folder = await call(page, 'POST', '/api/folders', { path: git.mobile });
      expect(folder.status, JSON.stringify(folder.body)).toBeLessThan(300);
      const started = await call(page, 'POST', '/api/sessions', { simple: true, name, title: name, task: 'Hello', folder: folder.body.id, worktrees: false });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      const id = started.body.id as string;
      await expect.poll(async () => (await call(page, 'GET', `/api/sessions/${id}`)).body.status, { timeout: 20_000 }).not.toBe('run');
      return id;
    },
    async addTodo(page, sessionId, title, estimateMinutes = 30) {
      const answer = await call(page, 'POST', `/api/sessions/${sessionId}/todos`, { title, estimateMinutes });
      expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(300);
      const todo = (answer.body.todos as { id: string; title: string }[]).find((entry) => entry.title === title);
      if (!todo) throw new Error(`no todo ${title}`);
      return todo.id;
    },
    plan,
    itemIn,
    async agentWorks(page, planId, key) {
      const item = await itemIn(page, planId, key, 'running');
      const runId = item.runSessionId as string;
      await expect.poll(async () => (await call(page, 'GET', `/api/sessions/${runId}`)).body.status, { timeout: 20_000, message: `${key}'s first turn` }).not.toBe('run');
      const cwd = (await call(page, 'GET', `/api/sessions/${runId}`)).body.cwd as string;
      await git.commit(cwd, `${key}.txt`, `${key}\n`, `${key}: work`);
      const sent = await call(page, 'POST', `/api/sessions/${runId}/messages`, { text: 'Finished.' });
      expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    },
    async stop() {
      try {
        expect(await server.stop()).toBe(0);
      } finally {
        await jira.close();
        await git.cleanup();
      }
    },
  };
}
