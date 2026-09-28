import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { ScheduleRunResult } from '../../src/core/model.ts';
import type { Folder, Session } from '../../src/core/api.ts';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';

/**
 * M5.1 oracle (E2E): the New-session modal on the real code path (no demo seed,
 * D13): `node src/server/main.ts` with fake-claude as the CLI, fake gh, a temp
 * data folder and a fixture workspace in a temp folder (git repos
 * `microfrontends/web-front`, `microfrontends/billing-front`, `mobile`; plain
 * folders `nugets/ui-nuget`, `other/tool`; read-only `deprecated/microfrontends/
 * old-front` and `infrastructure`). A failed scheduled run is recorded before the
 * start so the Inbox offers "Open fix session" (M3.3).
 * 1. The form: sections 1–6 in order, pills, chips from the scanner (read-only
 *    locked at 40%), coordination only for feature + single + a *-front, the QA
 *    contract for test-authoring, the toggles, the live summary with the worktree
 *    folders (gap #1), Start disabled without solutions or with a taken name.
 * 2. Start session → `POST /api/sessions` → the session view; the stored session
 *    and the worktrees on disk match the form.
 * 3. A server refusal (422) stays in the modal as one line.
 * 4. The contract's validation through the API: 422 for read-only paths, a
 *    duplicate name, missing solutions, a QA session without `qa`.
 * 5. "Open fix session" opens the form prefilled; Start creates that session.
 * D14: the Folder row sits above section 1 (the saved workspace, preselected as
 * the default); the summary names the folder; Start posts its id. Switching
 * folders and repo folders are in `tests/e2e/folders.spec.ts`.
 */

let tmp: string;
let workspace: string;
let server: ServerProcess;
let gitEnv: Record<string, string>;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...gitEnv } });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
  return result.stdout.trim();
}

async function makeRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'init');
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Records a schedule whose last run failed, so the Inbox raises "Scheduled run failed" with "Open fix session" (M3.3). */
async function insertFailedSchedule(dataDir: string): Promise<void> {
  const store = await openStore(storeFile(dataDir));
  try {
    const schedule = await store.schedules.create({
      name: 'nightly-build-verify',
      description: '',
      cron: '0 2 * * *',
      template: { task: 'Build and verify.', workType: 'feature', mode: 'single', solutions: ['web-front'], phase: 'integration', coordination: 'parallel-twin', worktrees: false, ultracode: true },
    });
    const results: ScheduleRunResult[] = ['ok', 'fail'];
    const end = Date.now() - 10 * 60_000;
    for (const [index, result] of results.entries()) {
      const finished = end - (results.length - 1 - index) * 3_600_000;
      await store.schedules.addRun({
        scheduleId: schedule.id,
        ts: new Date(finished - 5 * 60_000).toISOString(),
        finishedAt: new Date(finished).toISOString(),
        result,
        summary: index === results.length - 1 ? 'Build failed at XamlC' : 'OK',
        triggeredBy: 'cron',
      });
    }
  } finally {
    await store.close();
  }
}

/** `POST /api/sessions` from the page (same origin, the sb_token cookie). */
async function postSession(page: Page, body: unknown): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async (payload) => {
    const response = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
  }, body);
}

async function savedFolders(page: Page): Promise<Folder[]> {
  return page.evaluate(async () => (await (await fetch('/api/folders')).json()) as Folder[]);
}

async function listSessions(page: Page): Promise<Session[]> {
  return page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as Session[]);
}

function pill(modal: Locator, group: string, value: string): Locator {
  return modal.locator(`[data-testid="ns-pill"][data-group="${group}"][data-value="${value}"]`);
}

function chip(modal: Locator, solution: string): Locator {
  return modal.locator(`[data-testid="ns-chip"][data-solution="${solution}"]`);
}

async function summary(modal: Locator): Promise<string[]> {
  return modal.getByTestId('ns-summary-line').allTextContents();
}

async function openModal(page: Page): Promise<Locator> {
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal).toBeVisible();
  // The chips come from GET /api/solutions (the workspace scan).
  await expect(modal.getByTestId('ns-group').first()).toBeVisible();
  return modal;
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-new-session'));
  workspace = path.join(tmp, 'work space');
  const gitConfig = path.join(tmp, 'gitconfig');
  const dataDir = path.join(tmp, 'data');
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  await writeFile(gitConfig, '');
  await writeFile(path.join(tmp, 'fake-gh-prs.json'), '{}');
  gitEnv = {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Switchboard Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  await makeRepo(path.join(workspace, 'microfrontends', 'web-front'));
  await makeRepo(path.join(workspace, 'microfrontends', 'billing-front'));
  await makeRepo(path.join(workspace, 'mobile'));
  await makeRepo(path.join(workspace, 'deprecated', 'microfrontends', 'old-front'));
  await mkdir(path.join(workspace, 'nugets', 'ui-nuget'), { recursive: true });
  await mkdir(path.join(workspace, 'other', 'tool'), { recursive: true });
  await mkdir(path.join(workspace, 'infrastructure'), { recursive: true });
  await insertFailedSchedule(dataDir);
  // D14: the workspace is a saved folder (the default) in the server's database.
  await seedFolderInDataDir(dataDir, workspace);
  server = await startServer({
    ...gitEnv,
    SWITCHBOARD_DATA_DIR: dataDir,
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    FAKE_GH_PRS: path.join(tmp, 'fake-gh-prs.json'),
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  if (tmp) await removeTempDir(tmp);
});

test('the form: sections, chips from the scan, visibility rules, toggles, live summary, Start disabled rules', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  // A session that already exists: its name is taken.
  expect((await postSession(page, { name: 'existing-one', task: '', workType: 'feature', mode: 'single', solutions: ['mobile'], phase: 'ui-first', coordination: null, qa: null, worktrees: false, ultracode: false })).status).toBe(201);

  const modal = await openModal(page);
  await expect(modal.locator('.sb-ns-title')).toHaveText('New session');
  await expect(modal.locator('.sb-ns-sub')).toHaveText('Claude Code · background · Max');
  await expect(modal.getByTestId('ns-recommended')).toHaveText('Accept recommended');
  await expect(modal.getByTestId('ns-section')).toHaveCount(6);
  await expect(modal.locator('.sb-ns-form .sb-ns-label')).toHaveText([
    'Folder',
    '1 · Task definition',
    '2 · Work type',
    '3 · Mode',
    '4 · Solutions in scope0 selected · read-only folders locked',
    '5 · Phase',
  ]);
  await expect(modal.getByTestId('ns-name')).toHaveAttribute('placeholder', 'session-name');
  await expect(modal.getByTestId('ns-task')).toHaveAttribute('placeholder', 'What should be implemented?');
  // D14: the Folder row: the one saved folder, preselected (the default), Browse…, its check line.
  const [saved] = await savedFolders(page);
  await expect(modal.getByTestId('ns-folder')).toHaveValue(saved?.id ?? '');
  await expect(modal.getByTestId('ns-folder').locator('option')).toHaveText(['work space (default)']);
  await expect(modal.getByTestId('ns-folder-browse')).toHaveText('Browse…');
  await expect(modal.getByTestId('ns-folder-check')).toBeVisible();

  // Pills: the router's recommended answers are selected (#26272c bg, #8d8c87 border).
  await expect(modal.locator('[data-testid="ns-pill"][data-group="work-type"]')).toHaveText(['Feature-building', 'Test-authoring (QA)']);
  await expect(modal.locator('[data-testid="ns-pill"][data-group="mode"]')).toHaveText(['Single-solution', 'Workspace orchestrator']);
  await expect(modal.locator('[data-testid="ns-pill"][data-group="phase"]')).toHaveText(['UI-first', 'Integration']);
  for (const [group, value] of [['work-type', 'feature'], ['mode', 'single'], ['phase', 'ui-first']] as const) {
    await expect(pill(modal, group, value)).toHaveAttribute('aria-checked', 'true');
    await expect(pill(modal, group, value)).toHaveCSS('background-color', 'rgb(38, 39, 44)');
    await expect(pill(modal, group, value)).toHaveCSS('border-top-color', 'rgb(141, 140, 135)');
  }
  await expect(pill(modal, 'mode', 'orchestrator')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  // Section 4: the scan's groups; read-only folders collapsed, locked at 40% with a not-allowed cursor.
  await expect(modal.getByTestId('ns-group').locator('.sb-ns-folder')).toHaveText(['microfrontends/', 'mobile/', 'nugets/', 'other/', 'read-only']);
  await expect(modal.getByTestId('ns-group').nth(0).getByTestId('ns-chip')).toHaveText(['billing-front', 'web-front']);
  await expect(modal.getByTestId('ns-group').nth(1).getByTestId('ns-chip')).toHaveText(['mobile']);
  await expect(modal.getByTestId('ns-group').nth(2).getByTestId('ns-chip')).toHaveText(['ui-nuget']);
  await expect(modal.getByTestId('ns-group').nth(3).getByTestId('ns-chip')).toHaveText(['tool']);
  const locked = modal.getByTestId('ns-group').nth(4).getByTestId('ns-chip');
  await expect(locked).toHaveText(['deprecated/*', 'infrastructure']);
  for (const index of [0, 1]) {
    await expect(locked.nth(index)).toBeDisabled();
    await expect(locked.nth(index)).toHaveCSS('opacity', '0.4');
    await expect(locked.nth(index)).toHaveCSS('cursor', 'not-allowed');
  }
  await locked.nth(0).click({ force: true });
  await expect(locked.nth(0)).toHaveAttribute('data-selected', 'false');
  await expect(modal.getByTestId('ns-solutions-hint')).toHaveText('0 selected · read-only folders locked');

  // Nothing picked: Start disabled at 45%, the summary says why.
  const start = modal.getByTestId('ns-start');
  await expect(start).toBeDisabled();
  await expect(start).toHaveCSS('opacity', '0.45');
  expect(await summary(modal)).toEqual([
    '# claude code · background · Max',
    'folder    work space · workspace',
    `cwd       ${workspace}`,
    'work      feature-building',
    'mode      single-solution',
    'phase     UI-first',
    'ultracode off',
    ' ',
    '# worktrees',
    '⚠ pick at least one solution',
    ' ',
    '✓ answers pre-filled → agent confirms, no re-ask',
  ]);

  // A *-front in a single-solution feature session: section 6 · Mobile coordination appears.
  await chip(modal, 'web-front').click();
  await expect(chip(modal, 'web-front')).toHaveText('✓ web-front');
  await expect(chip(modal, 'web-front')).toHaveCSS('background-color', 'oklch(0.25 0.04 250)');
  await expect(modal.getByTestId('ns-solutions-hint')).toHaveText('1 selected · read-only folders locked');
  await expect(modal.locator('[data-section="coordination"] .sb-ns-label')).toHaveText('6 · Mobile coordination');
  await expect(modal.locator('[data-testid="ns-pill"][data-group="coordination"]')).toHaveText(['Sequential follow-up', 'Parallel-twin', 'No mobile counterpart']);
  await expect(pill(modal, 'coordination', 'sequential')).toHaveAttribute('aria-checked', 'true');
  await expect(start).toBeEnabled();
  await expect(start).toHaveCSS('opacity', '1');
  expect(await summary(modal)).toContain('mobile    sequential');
  expect(await summary(modal)).toContain('../web-front-wt-session');

  // The name: whitespace → dashes, lower case; the worktree folder follows it.
  await modal.getByTestId('ns-name').fill('Free Talk 640');
  await expect(modal.getByTestId('ns-name')).toHaveValue('free-talk-640');
  expect(await summary(modal)).toContain('../web-front-wt-free-talk-640');

  // Orchestrator hides the coordination section; back to single shows it again.
  await pill(modal, 'mode', 'orchestrator').click();
  await expect(modal.locator('[data-section="coordination"]')).toHaveCount(0);
  expect(await summary(modal)).toContain('mode      workspace orchestrator');
  expect((await summary(modal)).some((line) => line.startsWith('mobile '))).toBe(false);
  await pill(modal, 'mode', 'single').click();
  await pill(modal, 'coordination', 'parallel-twin').click();
  expect(await summary(modal)).toContain('mobile    parallel-twin');
  // Without a *-front the section goes away.
  await chip(modal, 'web-front').click();
  await chip(modal, 'mobile').click();
  await expect(modal.locator('[data-section="coordination"]')).toHaveCount(0);
  await chip(modal, 'web-front').click();
  expect((await summary(modal)).filter((line) => line.startsWith('../'))).toEqual(['../mobile-wt-free-talk-640', '../web-front-wt-free-talk-640']);

  // Toggles (32×18): worktrees off → edits in place; ultracode on.
  const wt = modal.getByTestId('ns-switch-worktrees');
  const ultra = modal.getByTestId('ns-switch-ultracode');
  await expect(wt).toHaveAttribute('aria-checked', 'true');
  expect(await wt.boundingBox()).toMatchObject({ width: 32, height: 18 });
  await expect(wt).toHaveCSS('background-color', 'rgb(232, 231, 227)');
  await expect(ultra).toHaveCSS('background-color', 'rgb(51, 52, 58)');
  await expect(modal.locator('.sb-ns-toggle-title')).toHaveText(['Worktree per solution', 'Ultracode (workflows)']);
  await expect(modal.locator('.sb-ns-toggle-desc')).toHaveText(['Kept until the PR is merged on GitHub', 'Dispatch via the Workflow tool']);
  await wt.click();
  await expect(wt).toHaveAttribute('aria-checked', 'false');
  expect(await summary(modal)).toContain('# no worktrees · edits in place');
  expect((await summary(modal)).some((line) => line.startsWith('../'))).toBe(false);
  await wt.click();
  await ultra.click();
  await expect(ultra).toHaveAttribute('aria-checked', 'true');
  expect(await summary(modal)).toContain('ultracode on');

  // QA: section 6 · QA contract (stack + the two sources, all required), no coordination.
  await pill(modal, 'work-type', 'qa').click();
  await expect(modal.locator('[data-section="coordination"]')).toHaveCount(0);
  await expect(modal.locator('[data-section="qa"] .sb-ns-label')).toHaveText('6 · QA contract');
  await expect(modal.locator('[data-testid="ns-pill"][data-group="stack"]')).toHaveText(['Web · Playwright', 'Mobile · Appium', 'Both']);
  await expect(modal.locator('[data-testid="ns-pill"][data-group="stack"][aria-checked="true"]')).toHaveCount(0);
  await expect(modal.getByTestId('ns-confluence')).toHaveAttribute('placeholder', 'Confluence page URL (required)');
  await expect(modal.getByTestId('ns-figma')).toHaveAttribute('placeholder', 'Figma frame URL per breakpoint (required)');
  await expect(start).toBeDisabled();
  expect(await summary(modal)).toEqual(expect.arrayContaining(['work      test-authoring (QA)', 'stack     —', '⚠ pick the stack under test', '⚠ add the Confluence page URL', '⚠ add the Figma frame URLs']));
  await pill(modal, 'stack', 'both').click();
  await modal.getByTestId('ns-confluence').fill('https://example.atlassian.net/wiki/pages/1');
  await modal.getByTestId('ns-figma').fill('https://www.figma.com/design/x?node-id=1 https://www.figma.com/design/x?node-id=2');
  await expect(start).toBeEnabled();
  expect(await summary(modal)).toContain('stack     both');
  expect((await summary(modal)).some((line) => line.startsWith('⚠'))).toBe(false);

  // Accept recommended: feature-building, single-solution, UI-first, sequential.
  await pill(modal, 'phase', 'integration').click();
  await pill(modal, 'mode', 'orchestrator').click();
  await modal.getByTestId('ns-recommended').click();
  await expect(pill(modal, 'work-type', 'feature')).toHaveAttribute('aria-checked', 'true');
  await expect(pill(modal, 'mode', 'single')).toHaveAttribute('aria-checked', 'true');
  await expect(pill(modal, 'phase', 'ui-first')).toHaveAttribute('aria-checked', 'true');
  await expect(pill(modal, 'coordination', 'sequential')).toHaveAttribute('aria-checked', 'true');

  // A taken name disables Start.
  await modal.getByTestId('ns-name').fill('existing-one');
  await expect(start).toBeDisabled();
  expect(await summary(modal)).toContain('⚠ a session with this name exists');
  await modal.getByTestId('ns-name').fill('');
  expect(await summary(modal)).toContain('../web-front-wt-session');
  await expect(start).toBeEnabled();

  // Cancel closes without starting anything.
  await modal.getByTestId('ns-cancel').click();
  await expect(modal).toHaveCount(0);
  expect((await listSessions(page)).map((s) => s.name)).toEqual(['existing-one']);
});

test('Start session posts the form, opens the session, and creates the worktrees', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const modal = await openModal(page);
  await modal.getByTestId('ns-name').fill('free-talk-640');
  await modal.getByTestId('ns-task').fill('Free talk screen at 640, web and mobile.');
  await chip(modal, 'web-front').click();
  await chip(modal, 'mobile').click();
  await pill(modal, 'coordination', 'parallel-twin').click();
  await modal.getByTestId('ns-switch-ultracode').click();
  expect((await summary(modal)).filter((line) => line.startsWith('../'))).toEqual(['../web-front-wt-free-talk-640', '../mobile-wt-free-talk-640']);

  const [folder] = await savedFolders(page);
  const posted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions');
  await modal.getByTestId('ns-start').click();
  expect((await posted).postDataJSON()).toEqual({
    name: 'free-talk-640',
    task: 'Free talk screen at 640, web and mobile.',
    workType: 'feature',
    mode: 'single',
    solutions: ['web-front', 'mobile'],
    phase: 'ui-first',
    coordination: 'parallel-twin',
    qa: null,
    worktrees: true,
    ultracode: true,
    folder: folder?.id,
  });
  await expect(modal).toHaveCount(0);
  const view = page.getByTestId('view-session');
  await expect(view).toBeVisible();

  const created = (await listSessions(page)).find((s) => s.name === 'free-talk-640');
  expect(created).toMatchObject({
    workType: 'feature',
    mode: 'single',
    phase: 'ui-first',
    coordination: 'parallel-twin',
    qaStack: null,
    ultracode: true,
    worktrees: true,
    solutions: ['web-front', 'mobile'],
  });
  await expect(view).toHaveAttribute('data-session-id', created?.id ?? '');
  expect(new URL(page.url()).pathname).toBe(`/sessions/${created?.id}`);

  // Gap #1: session/{name} at ../{repo}-wt-{name}, next to each repo.
  expect(await exists(path.join(workspace, 'microfrontends', 'web-front-wt-free-talk-640'))).toBe(true);
  expect(await exists(path.join(workspace, 'mobile-wt-free-talk-640'))).toBe(true);
  expect(await git(path.join(workspace, 'microfrontends', 'web-front'), 'branch', '--list', 'session/free-talk-640')).not.toBe('');
  expect(await git(path.join(workspace, 'mobile'), 'branch', '--list', 'session/free-talk-640')).not.toBe('');

  // M5.2: the first message the agent got = the task, then the confirmed answers with the worktree paths.
  const events = (await page.evaluate(async (id) => (await fetch(`/api/sessions/${id}/events`)).json(), created?.id ?? '')) as Array<{ payload: { type?: string; origin?: string; text?: string } }>;
  const first = events.find((event) => event.payload.type === 'user');
  expect(first?.payload.origin).toBe('task');
  const lines = (first?.payload.text ?? '').split('\n');
  expect(lines.slice(0, 3)).toEqual(['Free talk screen at 640, web and mobile.', '', "Session-start answers, confirmed by the developer in Switchboard's new-session form before this session started."]);
  expect(lines).toContain('- Solutions in scope: microfrontends/web-front, mobile');
  expect(lines).toContain('- Mobile coordination: parallel-twin');
  expect(lines).toContain('- Ultracode: on');
  expect(lines).toContain(`  - microfrontends/web-front: ${path.join(workspace, 'microfrontends', 'web-front-wt-free-talk-640')} (branch session/free-talk-640)`);
  expect(lines).toContain(`  - mobile: ${path.join(workspace, 'mobile-wt-free-talk-640')} (branch session/free-talk-640)`);

  // The name is now taken.
  const again = await openModal(page);
  await chip(again, 'billing-front').click();
  await again.getByTestId('ns-name').fill('free-talk-640');
  await expect(again.getByTestId('ns-start')).toBeDisabled();
  await page.keyboard.press('Escape');
});

test('a refusal from POST /api/sessions stays in the modal as one line', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const modal = await openModal(page);
  await modal.getByTestId('ns-name').fill('bad-name-');
  await chip(modal, 'billing-front').click();
  await modal.getByTestId('ns-switch-worktrees').click();
  await modal.getByTestId('ns-start').click();
  await expect(modal.getByTestId('ns-error')).toHaveText('Not started: the name must be kebab-case (a-z, 0-9, single dashes), at most 64 characters');
  await expect(modal).toBeVisible();
  // Editing the form clears the line.
  await modal.getByTestId('ns-name').fill('good-name');
  await expect(modal.getByTestId('ns-error')).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect((await listSessions(page)).some((s) => s.name.startsWith('bad-name'))).toBe(false);
});

test('POST /api/sessions validates the contract: read-only paths 422, duplicate name, no solutions, qa for QA', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const base = { task: '', workType: 'feature', mode: 'single', phase: 'ui-first', coordination: null, qa: null, worktrees: false, ultracode: false };
  const field = (body: unknown, name: string): string[] =>
    ((body as { errors?: Array<{ field: string; message: string }> }).errors ?? []).filter((e) => e.field === name).map((e) => e.message);

  for (const solution of ['deprecated/microfrontends/old-front', 'infrastructure', 'deprecated']) {
    const refused = await postSession(page, { ...base, name: `ro-${solution.length}`, solutions: [solution] });
    expect(refused.status, solution).toBe(422);
    expect(field(refused.body, 'solutions'), solution).toEqual([`"${solution}" is read-only and cannot be a write target`]);
  }
  const duplicate = await postSession(page, { ...base, name: 'existing-one', solutions: ['billing-front'] });
  expect(duplicate.status).toBe(422);
  expect(field(duplicate.body, 'name')).toEqual(['a session named "existing-one" already exists']);
  const empty = await postSession(page, { ...base, name: 'no-solutions', solutions: [] });
  expect(empty.status).toBe(422);
  expect(field(empty.body, 'solutions')).toEqual(['choose at least one solution']);
  const qa = await postSession(page, { ...base, name: 'qa-without-contract', workType: 'qa', solutions: ['billing-front'] });
  expect(qa.status).toBe(422);
  expect(field(qa.body, 'qa')).toEqual(['qa is required for a QA session']);
  expect((await listSessions(page)).map((s) => s.name).sort()).toEqual(['existing-one', 'free-talk-640']);
});

test('"Open fix session" opens the form prefilled (M3.3); Start creates that session', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  await expect(page.getByTestId('inbox-title')).toHaveText('Build failed at XamlC');
  await page.getByTestId('inbox-action').filter({ hasText: 'Open fix session' }).click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId('ns-group').first()).toBeVisible();

  await expect(modal.getByTestId('ns-name')).toHaveValue('fix-nightly-build-verify');
  await expect(modal.getByTestId('ns-task')).toHaveValue('nightly-build-verify: Build failed at XamlC.');
  await expect(pill(modal, 'work-type', 'feature')).toHaveAttribute('aria-checked', 'true');
  await expect(pill(modal, 'mode', 'single')).toHaveAttribute('aria-checked', 'true');
  await expect(pill(modal, 'phase', 'integration')).toHaveAttribute('aria-checked', 'true');
  await expect(pill(modal, 'coordination', 'parallel-twin')).toHaveAttribute('aria-checked', 'true');
  await expect(chip(modal, 'web-front')).toHaveAttribute('data-selected', 'true');
  await expect(modal.getByTestId('ns-switch-worktrees')).toHaveAttribute('aria-checked', 'false');
  await expect(modal.getByTestId('ns-switch-ultracode')).toHaveAttribute('aria-checked', 'true');
  expect(await summary(modal)).toEqual([
    '# claude code · background · Max',
    'folder    work space · workspace',
    `cwd       ${workspace}`,
    'work      feature-building',
    'mode      single-solution',
    'phase     integration',
    'mobile    parallel-twin',
    'ultracode on',
    ' ',
    '# no worktrees · edits in place',
    ' ',
    '✓ answers pre-filled → agent confirms, no re-ask',
  ]);

  await modal.getByTestId('ns-start').click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('view-session')).toBeVisible();
  const created = (await listSessions(page)).find((s) => s.name === 'fix-nightly-build-verify');
  expect(created).toMatchObject({ mode: 'single', phase: 'integration', coordination: 'parallel-twin', worktrees: false, ultracode: true, solutions: ['web-front'] });
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-session-id', created?.id ?? '');
});
