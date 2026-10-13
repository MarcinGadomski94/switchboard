import { mkdir } from 'node:fs/promises';
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
