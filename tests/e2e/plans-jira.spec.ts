import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { type FakeJira, startFakeJira } from '../helpers/fake-jira.ts';
import { type GitWorld, makeGitWorld } from '../helpers/git.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * D99-Jira (E2E, the dialog's dev mount `/plans-jira-dev.html` until the Plans page mounts it):
 * a real Switchboard whose Jira credentials (ATL_*) point at the fake Jira on a loopback test
 * port (never the real Jira, never the developer's own ATL_* values: test servers drop them).
 * Paste the epic's link → Preview shows the items, the order ("PROJ-12 waits on PROJ-11"),
 * the cycle left out, the link outside the epic and the unlinked item → choose the write sync →
 * Create plan → a draft plan with five items, and its Jira section.
 */
let world: GitWorld;
let server: ServerProcess;
let fake: FakeJira;

test.beforeAll(async () => {
  // A workspace with the git world's solutions (web-front, mobile): the plan's repos.
  world = await makeGitWorld();
  await mkdir(path.join(world.root, 'claude-config'), { recursive: true });
  await seedFolderInDataDir(path.join(world.root, 'data'), world.workspace);
  fake = await startFakeJira();
  server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(world.root, 'data'),
    CLAUDE_CONFIG_DIR: path.join(world.root, 'claude-config'),
    GIT_CONFIG_GLOBAL: String(world.env['GIT_CONFIG_GLOBAL']),
    GIT_CONFIG_NOSYSTEM: '1',
    ATL_BASE_URL: fake.url,
    ATL_USER: fake.email,
    ATL_TOKEN: fake.token,
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  await fake?.close();
  await world?.cleanup();
});

async function call(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  return page.evaluate(
    async ({ method: m, url: u, body: b }) => {
      const response = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null, text };
    },
    { method, url, body },
  );
}

async function session(page: Page, name: string): Promise<string> {
  // The plan's repos are the session's solutions.
  const answer = await call(page, 'POST', '/api/sessions', { name, task: 'Reply with just OK.', workType: 'feature', mode: 'single', solutions: ['web-front'], phase: 'ui-first', coordination: 'none', qa: null, worktrees: false, ultracode: false });
  expect(answer.status, answer.text).toBe(201);
  return answer.body.id as string;
}

test('preview an epic, then create a draft plan with the write sync', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  // Plans is experimental (Settings → Experimental → Plans): the Jira routes answer plans-off until it is on.
  expect((await call(page, 'POST', `/api/sessions/x/plans/jira/preview`, { epic: 'PROJ-10' })).body.error).toBe('plans-off');
  expect((await call(page, 'PUT', '/api/settings', { 'experimental.plans': true })).status).toBe(200);
  const sessionId = await session(page, 'epic-planner');
  await page.goto(`${server.baseUrl}/plans-jira-dev.html?session=${encodeURIComponent(sessionId)}`);
  await page.getByTestId('dev-open-import').click();
  const dialog = page.getByTestId('jira-import');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('jira-epic').fill('https://acme.atlassian.net/browse/PROJ-10');
  await dialog.getByTestId('jira-preview').click();

  await expect(dialog.getByTestId('jira-items').locator('li')).toHaveCount(5);
  await expect(dialog.getByTestId('jira-edges').locator('li')).toHaveText(['PROJ-12 waits on PROJ-11', 'PROJ-13 waits on PROJ-12', 'PROJ-13 waits on PROJ-14']);
  await expect(dialog.getByTestId('jira-cycles')).toContainText('PROJ-14 waits on PROJ-13 was left out: PROJ-13 → PROJ-14 → PROJ-13 would be a cycle');
  await expect(dialog.getByTestId('jira-external')).toHaveText('PROJ-15 waits on PROJ-99 (outside the epic)');
  await expect(dialog.getByTestId('jira-unlinked-PROJ-15')).toBeVisible();
  await expect(dialog.getByTestId('jira-item-PROJ-11')).toHaveAttribute('data-unlinked', 'false');
  await expect(dialog.getByTestId('jira-title')).toHaveValue('PROJ-10 Acme checkout');
  await expect(dialog.getByTestId('jira-target')).toHaveValue('feature/PROJ-10-acme-checkout');
  // Nothing was written to Jira by the preview.
  expect(fake.calls(/^POST /)).toEqual([]);

  // The default sync is off; choose write: the transition names appear with their defaults.
  await expect(dialog.getByTestId('jira-sync-off')).toBeChecked();
  await dialog.getByTestId('jira-sync-write').check();
  await expect(dialog.getByTestId('jira-transition-progress')).toHaveValue('In Progress');
  await expect(dialog.getByTestId('jira-transition-review')).toHaveValue('In Review');
  await dialog.getByTestId('jira-create').click();

  const created = page.getByTestId('dev-imported');
  await expect(created).toContainText('Created PROJ-10 Acme checkout (draft, 5 items)');
  const planId = (await created.getAttribute('data-plan-id')) as string;
  const plan = await call(page, 'GET', `/api/plans/${encodeURIComponent(planId)}`);
  expect(plan.body).toMatchObject({ state: 'draft', mergeMode: null, external: { system: 'jira', key: 'PROJ-10' } });
  expect(plan.body.edges).toHaveLength(3);
  const jira = await call(page, 'GET', `/api/plans/${encodeURIComponent(planId)}/jira`);
  expect(jira.body).toMatchObject({ epicKey: 'PROJ-10', sync: 'write' });
  await expect(page.getByTestId('plan-jira-sync')).toHaveValue('write');
  // The token never reaches the page.
  expect(jira.text).not.toContain(fake.token);
  expect((await call(page, 'GET', '/api/integrations/jira')).text).not.toContain(fake.token);
});

test('at 360 px the dialog fills the screen and Create stays reachable', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`${server.baseUrl}/inbox`);
  expect((await call(page, 'PUT', '/api/settings', { 'experimental.plans': true })).status).toBe(200);
  const sessionId = await session(page, 'epic-planner-phone');
  await page.goto(`${server.baseUrl}/plans-jira-dev.html?session=${encodeURIComponent(sessionId)}`);
  await page.getByTestId('dev-open-import').click();
  const dialog = page.getByTestId('jira-import');
  await dialog.getByTestId('jira-epic').fill('PROJ-10');
  await dialog.getByTestId('jira-preview').click();
  await expect(dialog.getByTestId('jira-items').locator('li')).toHaveCount(5);
  const box = await dialog.boundingBox();
  expect(box?.width).toBe(360);
  await expect(dialog.getByTestId('jira-create')).toBeInViewport();
});

/** The agent's side: the session's own agent token, from the MCP config Switchboard wrote for its spawn. */
async function asAgent(sessionId: string, url: string, body: unknown): Promise<{ status: number; body: any }> {
  const config = JSON.parse(await readFile(path.join(world.root, 'data', 'agent-mcp', `${sessionId}.json`), 'utf8')) as { mcpServers: { switchboard: { env: Record<string, string> } } };
  const response = await fetch(`${server.baseUrl}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.mcpServers.switchboard.env['SWITCHBOARD_TODO_TOKEN']}`, 'x-switchboard-session': sessionId },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('the plan shows the proposed order; ✓ adds the dependency, ✕ rejects; Settings → Experimental → Plans holds the Jira connection', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  expect((await call(page, 'PUT', '/api/settings', { 'experimental.plans': true })).status).toBe(200);
  const sessionId = await session(page, 'epic-proposals');
  await expect.poll(async () => (await call(page, 'GET', `/api/sessions/${sessionId}`)).body.status, { timeout: 20_000 }).toBe('done');
  const imported = await call(page, 'POST', `/api/sessions/${sessionId}/plans/jira/import`, { epic: 'PROJ-10', targetBranch: 'feature/PROJ-10-proposals' });
  expect(imported.status, imported.text).toBe(201);
  expect(imported.body.askedForOrder).toBe(true);
  const planId = imported.body.plan.id as string;
  const proposed = await asAgent(sessionId, `/agent/v1/plans/${planId}/proposals`, {
    proposals: [
      { from: 'PROJ-14', to: 'PROJ-15', reason: 'the receipt needs the payment provider' },
      { from: 'PROJ-12', to: 'PROJ-15', reason: 'the receipt links to the cart' },
    ],
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const [first, second] = proposed.body.added as Array<{ id: string }>;

  await page.goto(`${server.baseUrl}/plans-jira-dev.html?plan=${encodeURIComponent(planId)}`);
  const list = page.getByTestId('plan-proposals');
  await expect(list).toContainText('Proposed order (2)');
  await expect(page.getByTestId(`plan-proposal-${first?.id}`)).toContainText('PROJ-15 should wait on PROJ-14 — the receipt needs the payment provider');
  await page.getByTestId(`plan-proposal-accept-${first?.id}`).click();
  await expect(page.getByTestId(`plan-proposal-${first?.id}`)).toHaveCount(0);
  await page.getByTestId(`plan-proposal-reject-${second?.id}`).click();
  await expect(list).toHaveCount(0);
  const plan = (await call(page, 'GET', `/api/plans/${encodeURIComponent(planId)}`)).body;
  const id = (key: string) => plan.items.find((item: { key: string }) => item.key === key).id;
  expect(plan.edges).toContainEqual({ from: id('PROJ-14'), to: id('PROJ-15') });
  expect(plan.edges).not.toContainEqual({ from: id('PROJ-12'), to: id('PROJ-15') });

  // Settings → Experimental: the Jira connection is part of the Plans row while Plans is on, gone while off.
  await page.goto(`${server.baseUrl}/settings/experimental`);
  const jira = page.getByTestId('experimental-plans-jira');
  await expect(jira).toBeVisible();
  await expect(jira.getByTestId('jira-credentials-source')).toContainText(`Connected to ${fake.url} as ${fake.email} (from the ATL_* environment).`);
  await expect(jira).not.toContainText(fake.token);
  expect((await call(page, 'PUT', '/api/settings', { 'experimental.plans': false })).status).toBe(200);
  await page.reload();
  await expect(page.getByText('Plans', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('experimental-plans-jira')).toHaveCount(0);
});

test('a workspace session without solutions: Create plan says to pick the repositories, then creates the plan with them (never a silent no-op)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${server.baseUrl}/inbox`);
  expect((await call(page, 'PUT', '/api/settings', { 'experimental.plans': true })).status).toBe(200);
  // D38: a workspace session may start without solutions (the agent determines them); the plan's target branch needs repos.
  const started = await call(page, 'POST', '/api/sessions', { name: 'epic-no-solutions', task: 'Reply with just OK.', workType: 'feature', mode: 'single', solutions: [], phase: 'ui-first', coordination: 'none', qa: null, worktrees: false, ultracode: false });
  expect(started.status, started.text).toBe(201);
  const sessionId = started.body.id as string;

  await page.goto(`${server.baseUrl}/plans`);
  await page.getByTestId('plans-import-jira').click();
  // D112: the import starts in a folder; an existing session on request.
  await page.getByTestId('jira-import').getByTestId('jira-use-session').click();
  const picker = page.getByTestId('plan-jira-source-dialog');
  await picker.getByTestId('plan-jira-source-session').selectOption(sessionId);
  await picker.getByTestId('plan-jira-source-continue').click();
  const dialog = page.getByTestId('jira-import');
  await dialog.getByTestId('jira-epic').fill('PROJ-10');
  await dialog.getByTestId('jira-preview').click();
  await expect(dialog.getByTestId('jira-items').locator('li')).toHaveCount(5);

  // Create plan cannot be pressed yet, and the footer says why.
  await expect(dialog.getByTestId('jira-create')).toBeDisabled();
  await expect(dialog.getByTestId('jira-create-blocked')).toHaveText('Pick the repositories the target branch lives in.');
  await expect(dialog.getByTestId('jira-create-blocked')).toBeInViewport();
  const repos = dialog.getByTestId('jira-repos');
  await expect(repos.getByRole('checkbox')).toHaveCount(2);
  await repos.getByTestId('jira-repo-mobile').check();
  await expect(dialog.getByTestId('jira-create-blocked')).toHaveCount(0);
  await dialog.getByTestId('jira-create').click();

  // The draft opens with the imported items, dependencies and the epic link.
  await expect(page.getByTestId('plan-title')).toHaveText('PROJ-10 Acme checkout');
  const planId = (await page.getByTestId('plan-page').getAttribute('data-plan-id')) as string;
  const plan = (await call(page, 'GET', `/api/plans/${encodeURIComponent(planId)}`)).body;
  expect(plan).toMatchObject({ state: 'draft', repos: ['mobile'], targetBranch: 'feature/PROJ-10-acme-checkout', external: { system: 'jira', key: 'PROJ-10' } });
  expect(plan.items.map((item: { key: string }) => item.key)).toEqual(['PROJ-11', 'PROJ-12', 'PROJ-13', 'PROJ-14', 'PROJ-15']);
  expect(plan.edges).toHaveLength(3);
  expect((await call(page, 'GET', `/api/plans/${encodeURIComponent(planId)}/jira`)).body).toMatchObject({ epicKey: 'PROJ-10', sync: 'off' });
});

test("a refused Create plan shows the server's reason by the button, even with the form scrolled", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 480 });
  await page.goto(`${server.baseUrl}/inbox`);
  expect((await call(page, 'PUT', '/api/settings', { 'experimental.plans': true })).status).toBe(200);
  const sessionId = await session(page, 'epic-refused');
  await page.goto(`${server.baseUrl}/plans-jira-dev.html?session=${encodeURIComponent(sessionId)}`);
  await page.getByTestId('dev-open-import').click();
  const dialog = page.getByTestId('jira-import');
  await dialog.getByTestId('jira-epic').fill('PROJ-10');
  await dialog.getByTestId('jira-preview').click();
  await expect(dialog.getByTestId('jira-items').locator('li')).toHaveCount(5);
  // The session names its solution: no repositories to pick.
  await expect(dialog.getByTestId('jira-repos')).toHaveCount(0);
  await dialog.getByTestId('jira-target').fill('not a branch');
  await dialog.getByTestId('jira-create').click();
  const refused = dialog.getByTestId('jira-create-error');
  await expect(refused).toBeVisible();
  await expect(refused).toBeInViewport();
  await expect(dialog.getByTestId('jira-target-error')).toBeVisible();
  await expect(page.getByTestId('dev-imported')).toHaveCount(0);
});
