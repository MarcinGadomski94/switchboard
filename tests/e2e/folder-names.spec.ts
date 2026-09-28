import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { Folder, Session } from '../../src/core/api.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D18 UI oracle (E2E, real path, no demo seed): a saved folder's custom name,
 * driven through the UI of `node src/server/main.ts` with fake-claude, fake gh and
 * temp folders:
 * - `work space`: a workspace (router `AGENTS.md`) with `microfrontends/web-front`,
 *   saved as the default before the start;
 * - `tool-repo` and `side-repo`: git main checkouts on their own (repo folders).
 * 1. Settings → Folders: Add… `tool-repo` with a Name (the field's placeholder is
 *    the folder's own name), shown in bold with its path under it; Rename it
 *    (Enter saves, Esc cancels); a taken name (another case) is refused on Add…
 *    and on Rename with the server's message; an empty name goes back to the
 *    folder's own name.
 * 2. The new name is what the New-session Folder dropdown, the Solutions folder
 *    switcher and a session's folder tag show (the path as their tooltip), while
 *    the session's worktree is still named after the folder itself.
 */

let tmp: string;
let workspace: string;
let repo: string;
let side: string;
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

async function fetchJson<T>(page: Page, url: string): Promise<T> {
  return page.evaluate(async (target) => (await (await fetch(target)).json()) as unknown, url) as Promise<T>;
}

const savedFolders = (page: Page) => fetchJson<Folder[]>(page, '/api/folders');

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
  tmp = await realpath(await makeTempDir('e2e-folder-names'));
  workspace = path.join(tmp, 'work space');
  repo = path.join(tmp, 'tool-repo');
  side = path.join(tmp, 'side-repo');
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
  await mkdir(workspace, { recursive: true });
  await copyFile(ROUTER_FIXTURE, path.join(workspace, 'AGENTS.md'));
  await makeRepo(path.join(workspace, 'microfrontends', 'web-front'));
  await makeRepo(repo);
  await makeRepo(side);
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

test('Settings → Folders: Add… with a name, Rename (Enter saves, Esc cancels), a taken name is refused, an empty name resets', async ({ page }) => {
  await page.goto(`${server.baseUrl}/settings/folders`);
  const rows = page.getByTestId('settings-folder');
  await expect(rows).toHaveCount(1);

  // Add… with a Name: the field's placeholder is the folder's own name once a path is typed.
  await page.getByTestId('settings-folder-add').click();
  const panel = page.getByTestId('settings-folder-add-panel');
  const nameField = panel.getByTestId('settings-folder-add-name');
  await expect(nameField).toHaveAttribute('placeholder', 'optional');
  await panel.getByTestId('settings-folder-add-input').fill(repo);
  await expect(panel.getByTestId('settings-folder-add-line')).toHaveText('✓ git repo · single solution');
  await expect(nameField).toHaveAttribute('placeholder', 'tool-repo');
  await nameField.fill('  Tool box ');
  await panel.getByTestId('settings-folder-add-add').click();
  await expect(panel).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  const repoRow = rows.filter({ has: page.getByTestId('settings-folder-path').filter({ hasText: repo }) });
  await expect(repoRow.getByTestId('settings-folder-name')).toHaveText('Tool box');
  await expect(repoRow.getByTestId('settings-folder-name')).toHaveCSS('font-weight', '600');
  await expect(repoRow.getByTestId('settings-folder-path')).toHaveText(repo);
  await expect(repoRow.getByTestId('settings-folder-kind')).toHaveText('git repo');
  // The scan block names the added folder by its name too.
  await expect(page.locator('[data-row="workspace-root"] .sb-set-row-label')).toHaveText('Solutions in Tool box');
  expect((await savedFolders(page)).find((f) => f.path === repo)).toMatchObject({ name: 'tool-repo', label: 'Tool box', displayName: 'Tool box' });

  // Rename: the field holds the current name; Esc cancels, Enter saves.
  await repoRow.getByTestId('settings-folder-rename').click();
  const input = repoRow.getByTestId('settings-folder-rename-input');
  await expect(input).toHaveValue('Tool box');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('placeholder', 'tool-repo');
  await input.fill('Nothing to see');
  await input.press('Escape');
  await expect(repoRow.getByTestId('settings-folder-rename-input')).toHaveCount(0);
  await expect(repoRow.getByTestId('settings-folder-name')).toHaveText('Tool box');
  await repoRow.getByTestId('settings-folder-rename').click();
  await repoRow.getByTestId('settings-folder-rename-input').fill('Handy tools');
  await repoRow.getByTestId('settings-folder-rename-input').press('Enter');
  await expect(repoRow.getByTestId('settings-folder-name')).toHaveText('Handy tools');
  expect((await savedFolders(page)).find((f) => f.path === repo)?.label).toBe('Handy tools');

  // A taken name (in another case) on Add…: refused with the server's message, nothing saved.
  await page.getByTestId('settings-folder-add').click();
  await panel.getByTestId('settings-folder-add-input').fill(side);
  await expect(panel.getByTestId('settings-folder-add-line')).toHaveText('✓ git repo · single solution');
  await panel.getByTestId('settings-folder-add-name').fill('HANDY tools');
  await panel.getByTestId('settings-folder-add-add').click();
  await expect(panel.getByTestId('settings-folder-add-error')).toHaveText(`Not added: "HANDY tools" is already the name of another folder (${repo}); pick another name`);
  expect((await savedFolders(page)).map((f) => f.path)).toEqual([workspace, repo]);
  // Another name adds it.
  await panel.getByTestId('settings-folder-add-name').fill('Side');
  await panel.getByTestId('settings-folder-add-name').press('Enter');
  await expect(panel).toHaveCount(0);
  await expect(rows).toHaveCount(3);

  // A taken name on Rename: the refusal under the field, the field stays open; Cancel keeps the name.
  const wsRow = rows.filter({ has: page.getByTestId('settings-folder-path').filter({ hasText: workspace }) });
  await wsRow.getByTestId('settings-folder-rename').click();
  await expect(wsRow.getByTestId('settings-folder-rename-input')).toHaveValue('');
  await expect(wsRow.getByTestId('settings-folder-rename-input')).toHaveAttribute('placeholder', 'work space');
  await wsRow.getByTestId('settings-folder-rename-input').fill('handy TOOLS');
  await wsRow.getByTestId('settings-folder-rename-save').click();
  await expect(wsRow.getByTestId('settings-folder-rename-error')).toHaveText(`Not renamed: "handy TOOLS" is already the name of another folder (${repo}); pick another name`);
  await expect(wsRow.getByTestId('settings-folder-rename-input')).toHaveValue('handy TOOLS');
  await wsRow.getByTestId('settings-folder-rename-cancel').click();
  await expect(wsRow.getByTestId('settings-folder-name')).toHaveText('work space');
  expect((await savedFolders(page)).find((f) => f.path === workspace)?.label).toBeNull();

  // An empty name goes back to the folder's own name.
  const sideRow = rows.filter({ has: page.getByTestId('settings-folder-path').filter({ hasText: side }) });
  await expect(sideRow.getByTestId('settings-folder-name')).toHaveText('Side');
  await sideRow.getByTestId('settings-folder-rename').click();
  await sideRow.getByTestId('settings-folder-rename-input').fill('   ');
  await sideRow.getByTestId('settings-folder-rename-save').click();
  await expect(sideRow.getByTestId('settings-folder-name')).toHaveText('side-repo');
  expect((await savedFolders(page)).find((f) => f.path === side)).toMatchObject({ label: null, displayName: 'side-repo' });
});

test('the new name shows in the New-session dropdown, the Solutions switcher and the session tag; the worktree keeps the folder name', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const folders = await savedFolders(page);
  const tool = folders.find((f) => f.path === repo);
  expect(tool).toMatchObject({ displayName: 'Handy tools', name: 'tool-repo' });

  // The New-session Folder dropdown: the display name, the path as the tooltip.
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  const select = modal.getByTestId('ns-folder');
  await expect(select.locator('option')).toHaveText(['work space (default)', 'Handy tools', 'side-repo']);
  expect(await select.locator('option').evaluateAll((els) => els.map((el) => el.getAttribute('title')))).toEqual([workspace, repo, side]);
  await select.selectOption({ label: 'Handy tools' });
  await expect(select).toHaveAttribute('title', repo);
  await expect(modal.getByTestId('ns-chip')).toHaveText(['✓ tool-repo']);
  await modal.getByTestId('ns-name').fill('named-fix');
  await modal.getByTestId('ns-task').fill('Tidy the README.');
  // D32: the repo folder's worktree is on a ticket branch.
  await modal.getByTestId('ns-branch').fill('TOOL-3-named-fix');
  const worktree = path.join(tmp, 'tool-repo-wt-named-fix');
  expect((await modal.getByTestId('ns-summary-line').allTextContents()).slice(1, 3)).toEqual(['folder    Handy tools · git repo', `cwd       ${worktree}`]);
  await modal.getByTestId('ns-start').click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('view-session')).toBeVisible();

  // The session runs in the worktree named after the folder itself, not its custom name.
  const created = (await fetchJson<Session[]>(page, '/api/sessions')).find((s) => s.name === 'named-fix');
  expect(created).toMatchObject({ folder: tool?.id, folderPath: repo, cwd: worktree, solutions: ['tool-repo'] });
  await expect.poll(fakeCwds).toEqual([worktree]);

  // Its folder tag in the sidebar: the display name, the path as the tooltip.
  const tag = page.getByTestId('sidebar-sessions').locator('a').filter({ hasText: 'named-fix' }).getByTestId('folder-tag');
  await expect(tag).toHaveText('Handy tools');
  await expect(tag).toHaveAttribute('title', repo);

  // The Solutions switcher: the display names, the path as each option's tooltip.
  await page.getByTestId('nav-solutions').click();
  const switcher = page.getByTestId('solutions-folder');
  await expect(switcher.locator('option')).toHaveText(['work space (default)', 'Handy tools', 'side-repo']);
  await switcher.selectOption({ label: 'Handy tools' });
  await expect(page).toHaveURL(`${server.baseUrl}/solutions?folder=${tool?.id}`);
  await expect(switcher).toHaveAttribute('title', repo);
  await expect(page.getByTestId('solution-row')).toHaveAttribute('data-solution', 'tool-repo');

  // A rename shows everywhere the folder is shown (after the lists reload).
  await page.goto(`${server.baseUrl}/settings/folders`);
  const row = page.getByTestId('settings-folder').filter({ has: page.getByTestId('settings-folder-path').filter({ hasText: repo }) });
  await row.getByTestId('settings-folder-rename').click();
  await row.getByTestId('settings-folder-rename-input').fill('Toolbox');
  await row.getByTestId('settings-folder-rename-input').press('Enter');
  await expect(row.getByTestId('settings-folder-name')).toHaveText('Toolbox');
  await expect(page.getByTestId('sidebar-sessions').locator('a').filter({ hasText: 'named-fix' }).getByTestId('folder-tag')).toHaveText('Toolbox');
  await page.goto(`${server.baseUrl}/solutions?folder=${tool?.id}`);
  await expect(page.getByTestId('solutions-folder').locator('option')).toHaveText(['work space (default)', 'Toolbox', 'side-repo']);
  await expect.poll(async () => (await fetchJson<Session[]>(page, '/api/sessions')).find((s) => s.name === 'named-fix')?.status, { timeout: 15_000 }).toBe('done');
});
