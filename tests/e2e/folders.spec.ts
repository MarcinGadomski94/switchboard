import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { Folder, Schedule, Session } from '../../src/core/api.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D14 UI oracle (E2E, real path, no demo seed): saved folders driven through the
 * UI of `node src/server/main.ts` with fake-claude, fake gh and temp folders:
 * - `work space`: a workspace (router `AGENTS.md`) with git repos
 *   `microfrontends/web-front` and `mobile`, saved as the default before the start;
 * - `second ws`: another workspace with `microfrontends/pay-front`;
 * - `tool-repo`: a git main checkout on its own (a repo folder);
 * - `plain folder`: neither, refused.
 * 1. Settings → Folders: Add… a repo, a workspace picked with Browse…, and a
 *    repo inside the workspace; a plain folder is refused and not added; Make
 *    default; Remove; the scan of the folder clicked.
 * 2. The New-session form's Folder row: switching folders changes the chips; a
 *    repo folder hides the router sections, shows the repo as its one locked
 *    chip, posts a NewRepoSession and starts in the repo's worktree (cwd, the
 *    first message with the worktree note, the header, the handoff card, the
 *    folder tag in the sidebar and the Inbox).
 * 3. A schedule saved for another folder stores it, carries its tag, and Edit
 *    reopens the form with it.
 * 4. The Solutions switcher and the Codebase Memory strip: one folder at a time,
 *    `?folder=` survives a reload, a repo is one solution; a folder removed from
 *    the list stays in the switcher while a session uses it.
 */

let tmp: string;
let workspace: string;
let second: string;
let repo: string;
let plain: string;
let server: ServerProcess;
let gitEnv: Record<string, string>;
const ROUTER_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md');

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

async function fetchJson<T>(page: Page, url: string): Promise<T> {
  return page.evaluate(async (target) => (await (await fetch(target)).json()) as unknown, url) as Promise<T>;
}

const savedFolders = (page: Page) => fetchJson<Folder[]>(page, '/api/folders');
const listSessions = (page: Page) => fetchJson<Session[]>(page, '/api/sessions');

async function folderId(page: Page, name: string): Promise<string> {
  const folder = (await savedFolders(page)).find((f) => f.name === name);
  if (!folder) throw new Error(`no saved folder ${name}`);
  return folder.id;
}

function chip(modal: Locator, solution: string): Locator {
  return modal.locator(`[data-testid="ns-chip"][data-solution="${solution}"]`);
}

async function summary(modal: Locator): Promise<string[]> {
  return modal.getByTestId('ns-summary-line').allTextContents();
}

/** The cwds fake-claude was started in, one per `--session-id` / `--resume` process. */
async function fakeCwds(): Promise<string[]> {
  const text = await readFile(path.join(tmp, 'fake.log'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind?: string; cwd?: string; argv?: string[] })
    .filter((entry) => entry.kind === 'argv' && (entry.argv?.includes('--session-id') || entry.argv?.includes('--resume')))
    .map((entry) => entry.cwd ?? '');
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-folders'));
  workspace = path.join(tmp, 'work space');
  second = path.join(tmp, 'second ws');
  repo = path.join(tmp, 'tool-repo');
  plain = path.join(tmp, 'plain folder');
  const gitConfig = path.join(tmp, 'gitconfig');
  await writeFile(gitConfig, '');
  gitEnv = {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Switchboard Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  for (const root of [workspace, second]) {
    await mkdir(root, { recursive: true });
    await copyFile(ROUTER_FIXTURE, path.join(root, 'AGENTS.md'));
  }
  await makeRepo(path.join(workspace, 'microfrontends', 'web-front'));
  await makeRepo(path.join(workspace, 'mobile'));
  await makeRepo(path.join(second, 'microfrontends', 'pay-front'));
  await makeRepo(repo);
  await mkdir(plain, { recursive: true });
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  await writeFile(path.join(tmp, 'fake-gh-prs.json'), '{}');
  // The workspace is saved (the default) before the start, as a user had done in Settings.
  await seedFolderInDataDir(path.join(tmp, 'data'), workspace);
  server = await startServer({
    ...gitEnv,
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    FAKE_GH_PRS: path.join(tmp, 'fake-gh-prs.json'),
    FAKE_CLAUDE_LOG: path.join(tmp, 'fake.log'),
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  if (tmp) await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

test('Settings → Folders: Add… a repo and a workspace (Browse…), a plain folder is refused, Make default, Remove, the scan of the folder clicked', async ({ page }) => {
  await page.goto(`${server.baseUrl}/settings/workspace`);
  await expect(page.getByTestId('settings-title')).toHaveText('Folders');
  const rows = page.getByTestId('settings-folder');
  await expect(rows).toHaveCount(1);
  await expect(rows.getByTestId('settings-folder-check')).toHaveText('✓ AGENTS.md (Workspace Router) · 2 solutions');
  await expect(page.getByTestId('settings-scan').locator('.sb-set-scan-folder')).toHaveText(['microfrontends/', 'mobile/']);

  // A plain folder: its check line says why, Add refuses it, nothing is saved.
  await page.getByTestId('settings-folder-add').click();
  const panel = page.getByTestId('settings-folder-add-panel');
  await expect(panel).toBeVisible();
  // Browse… starts in the default folder.
  await expect(panel.getByTestId('settings-folder-add-browser-path')).toHaveText(workspace);
  const input = panel.getByTestId('settings-folder-add-input');
  await input.fill(plain);
  await expect(panel.getByTestId('settings-folder-add-line')).toHaveText('✕ no AGENTS.md here and not a git repository');
  await expect(panel.getByTestId('settings-folder-add-line')).toHaveAttribute('data-ok', 'false');
  await panel.getByTestId('settings-folder-add-add').click();
  await expect(panel.getByTestId('settings-folder-add-error')).toHaveText('Not added: no AGENTS.md here and not a git repository');
  expect((await savedFolders(page)).map((f) => f.path)).toEqual([workspace]);

  // A git repo on its own: a repo folder.
  await input.fill(repo);
  await expect(panel.getByTestId('settings-folder-add-line')).toHaveText('✓ git repo · single solution');
  await expect(panel.getByTestId('settings-folder-add-error')).toHaveCount(0);
  await panel.getByTestId('settings-folder-add-add').click();
  await expect(panel).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  const repoRow = rows.filter({ has: page.getByTestId('settings-folder-name').filter({ hasText: /^tool-repo$/ }) });
  await expect(repoRow.getByTestId('settings-folder-kind')).toHaveText('git repo');
  await expect(repoRow.getByTestId('settings-folder-check')).toHaveText('✓ git repo · single solution');
  await expect(repoRow.getByTestId('settings-folder-default')).toHaveCount(0);
  // The added folder's scan shows below: a repo is its one solution.
  await expect(page.locator('[data-row="workspace-root"] .sb-set-row-label')).toHaveText('Solutions in tool-repo');
  await expect(page.getByTestId('settings-scan').locator('.sb-set-scan-row')).toHaveText([/^tool-repo\/1tool-repoeditable$/]);

  // A second workspace, picked with Browse…: up from the default folder, then into it.
  await page.getByTestId('settings-folder-add').click();
  await expect(panel.getByTestId('settings-folder-add-browser-path')).toHaveText(workspace);
  await panel.getByTestId('settings-folder-add-folder-up').click();
  await expect(panel.getByTestId('settings-folder-add-browser-path')).toHaveText(tmp);
  await panel.getByTestId('settings-folder-add-folder').filter({ hasText: /^second ws\/$/ }).click();
  await expect(input).toHaveValue(second);
  await expect(panel.getByTestId('settings-folder-add-line')).toHaveText('✓ AGENTS.md (Workspace Router) · 1 solution');
  await input.press('Enter');
  await expect(panel).toHaveCount(0);
  await expect(rows).toHaveCount(3);
  expect((await savedFolders(page)).map((f) => [f.name, f.kind, f.isDefault])).toEqual([
    ['work space', 'workspace', true],
    ['tool-repo', 'repo', false],
    ['second ws', 'workspace', false],
  ]);

  // Clicking a folder shows its scan.
  await rows.filter({ hasText: 'work space' }).locator('.sb-set-folder-text').click();
  await expect(page.locator('[data-row="workspace-root"] .sb-set-row-label')).toHaveText('Solutions in work space');

  // Make default moves the marker (the list keeps one default); back again.
  const secondRow = rows.filter({ has: page.getByTestId('settings-folder-name').filter({ hasText: /^second ws$/ }) });
  await secondRow.getByTestId('settings-folder-make-default').click();
  await expect(secondRow.getByTestId('settings-folder-default')).toHaveText('default');
  await expect(page.getByTestId('settings-folder-default')).toHaveCount(1);
  expect((await savedFolders(page))[0]?.name).toBe('second ws');
  const firstRow = rows.filter({ has: page.getByTestId('settings-folder-name').filter({ hasText: /^work space$/ }) });
  await firstRow.getByTestId('settings-folder-make-default').click();
  await expect(firstRow.getByTestId('settings-folder-default')).toHaveText('default');
  expect((await savedFolders(page))[0]?.name).toBe('work space');

  // A repo inside the workspace is a folder of its own; Remove takes it off the list again.
  await page.getByTestId('settings-folder-add').click();
  await input.fill(path.join(workspace, 'mobile'));
  await expect(panel.getByTestId('settings-folder-add-line')).toHaveText('✓ git repo · single solution');
  await panel.getByTestId('settings-folder-add-add').click();
  await expect(rows).toHaveCount(4);
  page.once('dialog', (dialog) => void dialog.accept());
  await rows.filter({ has: page.getByTestId('settings-folder-name').filter({ hasText: /^mobile$/ }) }).getByTestId('settings-folder-remove').click();
  await expect(rows).toHaveCount(3);
  expect((await savedFolders(page)).map((f) => f.name)).toEqual(['work space', 'tool-repo', 'second ws']);
  expect(await exists(path.join(workspace, 'mobile', 'README.md'))).toBe(true);
});

test('New session: the Folder row switches the chips; a repo folder hides the router sections and starts in its worktree', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal.getByTestId('ns-group').first()).toBeVisible();
  const select = modal.getByTestId('ns-folder');
  await expect(select.locator('option')).toHaveText(['work space (default)', 'tool-repo', 'second ws']);
  await expect(select).toHaveValue(await folderId(page, 'work space'));
  await expect(modal.getByTestId('ns-folder-check')).toHaveText('✓ AGENTS.md (Workspace Router) · 2 solutions');
  await expect(modal.getByTestId('ns-chip')).toHaveText(['web-front', 'mobile']);
  await chip(modal, 'web-front').click();
  await expect(modal.getByTestId('ns-solutions-hint')).toHaveText('1 selected · read-only folders locked');

  // Another workspace: its own chips; the selection does not carry over.
  await select.selectOption({ label: 'second ws' });
  await expect(modal.getByTestId('ns-chip')).toHaveText(['pay-front']);
  await expect(modal.getByTestId('ns-solutions-hint')).toHaveText('0 selected · read-only folders locked');
  await expect(modal.getByTestId('ns-folder-check')).toHaveText('✓ AGENTS.md (Workspace Router) · 1 solution');
  expect((await summary(modal)).slice(0, 3)).toEqual(['# claude code · background · Max', 'folder    second ws · workspace', `cwd       ${second}`]);

  // The repo folder: only Task, Worktree and Ultracode; the repo is the one locked solution.
  await select.selectOption({ label: 'tool-repo' });
  await expect(modal.getByTestId('ns-folder-check')).toHaveText('✓ git repo · single solution');
  await expect(modal.getByTestId('ns-section')).toHaveCount(3);
  await expect(modal.locator('.sb-ns-form .sb-ns-label')).toHaveText(['Folder', '1 · Task definition', '2 · Solution in scope1 selected · a git repo is one solution']);
  for (const section of ['work-type', 'mode', 'phase', 'coordination', 'qa']) await expect(modal.locator(`[data-section="${section}"]`)).toHaveCount(0);
  await expect(modal.getByTestId('ns-recommended')).toHaveCount(0);
  await expect(modal.getByTestId('ns-chip')).toHaveText(['✓ tool-repo']);
  await expect(chip(modal, 'tool-repo')).toBeDisabled();
  await expect(chip(modal, 'tool-repo')).toHaveAttribute('data-fixed', 'true');
  await expect(modal.locator('.sb-ns-toggle-title')).toHaveText(['Worktree', 'Ultracode (workflows)']);
  await modal.getByTestId('ns-name').fill('repo-fix');
  await modal.getByTestId('ns-task').fill('[fake:ask-2q] Fix the tool.');
  expect(await summary(modal)).toEqual([
    '# claude code · background · Max',
    'folder    tool-repo · git repo',
    `cwd       ${path.join(tmp, 'tool-repo-wt-repo-fix')}`,
    'ultracode off',
    ' ',
    '# worktree',
    '../tool-repo-wt-repo-fix',
    ' ',
    '✓ task + worktree note · no router answers',
  ]);
  // Worktree off: the session would run in the repo itself.
  await modal.getByTestId('ns-switch-worktrees').click();
  expect((await summary(modal)).slice(2, 6)).toEqual([`cwd       ${repo}`, 'ultracode off', ' ', '# no worktree · edits in place']);
  await modal.getByTestId('ns-switch-worktrees').click();

  const posted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions');
  await modal.getByTestId('ns-start').click();
  const repoId = await folderId(page, 'tool-repo');
  expect((await posted).postDataJSON()).toEqual({ name: 'repo-fix', task: '[fake:ask-2q] Fix the tool.', folder: repoId, solutions: ['tool-repo'], worktrees: true, ultracode: false });
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('view-session')).toBeVisible();

  // The session runs in the repo's worktree (gap #1: ../{repo}-wt-{name}, branch session/{name}).
  const worktree = path.join(tmp, 'tool-repo-wt-repo-fix');
  const created = (await listSessions(page)).find((s) => s.name === 'repo-fix');
  expect(created).toMatchObject({ folder: repoId, folderPath: repo, folderKind: 'repo', cwd: worktree, solutions: ['tool-repo'], workType: null, mode: null, phase: null });
  expect(await exists(path.join(worktree, 'README.md'))).toBe(true);
  expect(await git(repo, 'branch', '--list', 'session/repo-fix')).not.toBe('');
  await expect.poll(fakeCwds).toEqual([worktree]);
  await expect(page.getByTestId('session-root')).toHaveText(`${worktree} · worktree of tool-repo`);
  await expect(page.getByTestId('handoff-cwd')).toHaveText(`cwd ${worktree}`);
  // The first message: the task plus the worktree note, no router answers.
  const events = await fetchJson<Array<{ payload: { type?: string; origin?: string; text?: string } }>>(page, `/api/sessions/${created?.id}/events`);
  const first = events.find((event) => event.payload.type === 'user')?.payload.text ?? '';
  expect(first.split('\n')[0]).toBe('[fake:ask-2q] Fix the tool.');
  expect(first).toContain('Worktree note from Switchboard: this session runs in a git worktree, not in the main checkout of the repository.');
  expect(first).not.toContain('Session-start answers');

  // Tags: the session belongs to another folder than the default one.
  const sidebarRow = page.getByTestId('sidebar-sessions').locator('a').filter({ hasText: 'repo-fix' });
  await expect(sidebarRow.getByTestId('folder-tag')).toHaveText('tool-repo');
  await expect.poll(async () => (await listSessions(page)).find((s) => s.name === 'repo-fix')?.status).toBe('need');
  await page.getByTestId('nav-inbox').click();
  await expect(page.getByTestId('inbox-meta').getByTestId('folder-tag')).toHaveText('tool-repo');
  const questions = page.getByTestId('question');
  await questions.nth(0).getByTestId('question-option').filter({ hasText: 'Green' }).click();
  await questions.nth(1).getByTestId('question-option').filter({ hasText: 'Small' }).click();
  await page.getByTestId('question-send').click();
  await expect(page.getByTestId('inbox-zero')).toBeVisible();
  await expect.poll(async () => (await listSessions(page)).find((s) => s.name === 'repo-fix')?.status, { timeout: 15_000 }).toBe('done');
  // History lists it with its folder tag.
  await page.getByTestId('nav-history').click();
  await expect(page.getByTestId('history-row').filter({ hasText: 'repo-fix' }).getByTestId('folder-tag')).toHaveText('tool-repo');
});

test('a schedule saved for another folder stores it, carries its tag, and Edit reopens the form with it', async ({ page }) => {
  await page.goto(`${server.baseUrl}/schedules`);
  await page.getByTestId('schedule-new').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal.getByTestId('ns-group').first()).toBeVisible();
  await modal.getByTestId('ns-folder').selectOption({ label: 'second ws' });
  await chip(modal, 'pay-front').click();
  await modal.getByTestId('ns-name').fill('second-nightly');
  await modal.getByTestId('ns-task').fill('Check the build.');
  await modal.getByTestId('ns-cron').fill('0 2 * * *');
  await modal.getByTestId('ns-save-schedule').click();
  await expect(modal).toHaveCount(0);

  const secondId = await folderId(page, 'second ws');
  const saved = (await fetchJson<Schedule[]>(page, '/api/schedules')).find((s) => s.name === 'second-nightly');
  expect(saved).toMatchObject({ folder: secondId, template: { folder: secondId, solutions: ['pay-front'] } });
  const row = page.getByTestId('schedule-row').filter({ hasText: 'second-nightly' });
  await expect(row.getByTestId('folder-tag')).toHaveText('second ws');

  await row.getByTestId('schedule-edit').click();
  const edit = page.getByTestId('modal-new-session');
  await expect(edit.getByTestId('ns-title')).toHaveText('Edit scheduled run');
  await expect(edit.getByTestId('ns-folder')).toHaveValue(secondId);
  await expect(chip(edit, 'pay-front')).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('Escape');
});

test('Solutions and the Codebase Memory strip: one folder at a time, ?folder= survives a reload, a repo is one solution', async ({ page }) => {
  await page.goto(`${server.baseUrl}/solutions`);
  const switcher = page.getByTestId('solutions-folder');
  // D18: each folder by its display name (none has a custom name here: its own name), the path as the tooltip.
  await expect(switcher.locator('option')).toHaveText(['work space (default)', 'tool-repo', 'second ws']);
  expect(await switcher.locator('option').evaluateAll((els) => els.map((el) => el.getAttribute('title')))).toEqual([workspace, repo, second]);
  await expect(page.getByTestId('solution-row')).toHaveCount(2);
  await expect(page.getByTestId('solutions-meta')).toContainText('· 2 solutions ·');

  const repoId = await folderId(page, 'tool-repo');
  await switcher.selectOption({ label: 'tool-repo' });
  await expect(page).toHaveURL(`${server.baseUrl}/solutions?folder=${repoId}`);
  await expect(page.getByTestId('solution-group')).toHaveText(['tool-repo/']);
  await expect(page.getByTestId('solution-row')).toHaveCount(1);
  await expect(page.getByTestId('solution-row')).toHaveAttribute('data-solution', 'tool-repo');
  await expect(page.getByTestId('solution-path')).toHaveText(repo);
  await page.reload();
  await expect(page.getByTestId('solutions-folder')).toHaveValue(repoId);
  await expect(page.getByTestId('solution-row')).toHaveAttribute('data-solution', 'tool-repo');
  await page.getByTestId('solutions-folder').selectOption({ label: 'work space (default)' });
  await expect(page).toHaveURL(`${server.baseUrl}/solutions`);
  await expect(page.getByTestId('solution-row')).toHaveCount(2);

  // The Codebase Memory strip: its own switcher, the same ?folder=; a repo has no dirty list.
  await page.goto(`${server.baseUrl}/tools/cm`);
  const strip = page.getByTestId('cm-strip');
  await expect(strip.getByTestId('cm-folder').locator('option')).toHaveText(['work space (default)', 'tool-repo', 'second ws']);
  await strip.getByTestId('cm-folder').selectOption({ label: 'tool-repo' });
  await expect(page).toHaveURL(`${server.baseUrl}/tools/cm?folder=${repoId}`);
  await expect(strip.getByTestId('cm-clean')).toHaveText('nothing to reindex');

  // A folder removed from the list stays in the switcher while a session uses it (repo-fix ran in tool-repo).
  const removed = await page.evaluate(async (id) => (await fetch(`/api/folders/${id}`, { method: 'DELETE' })).status, repoId);
  expect(removed).toBe(200);
  await page.goto(`${server.baseUrl}/solutions`);
  const options = page.getByTestId('solutions-folder').locator('option');
  // A folder only a session uses: its path's last segment, the path as the tooltip.
  await expect(options).toHaveText(['work space (default)', 'second ws', 'tool-repo']);
  await expect(options.nth(2)).toHaveAttribute('data-saved', 'false');
  await expect(options.nth(2)).toHaveAttribute('title', repo);
  await page.getByTestId('solutions-folder').selectOption({ label: 'tool-repo' });
  await expect(page).toHaveURL(`${server.baseUrl}/solutions?folder=${encodeURIComponent(repo)}`);
  await expect(page.getByTestId('solution-row')).toHaveAttribute('data-solution', 'tool-repo');
  // The session keeps its tag (its folder's name) after the folder left the list.
  await expect(page.getByTestId('sidebar-sessions').locator('a').filter({ hasText: 'repo-fix' }).getByTestId('folder-tag')).toHaveText('tool-repo');
});
