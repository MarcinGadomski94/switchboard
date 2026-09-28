import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * D22 oracle (E2E, real path: `node src/server/main.ts` with fake-claude and fake
 * gh, a temp data folder, a fixture workspace with git repos; no demo seed):
 * 1. The New-session form takes "JIRA Ticket handling" as the title: the summary
 *    shows the derived short name, Start posts both, the sidebar and the header
 *    show the title, and the worktree's branch is `session/jira-ticket-handling`.
 * 2. Rename from the header (click; Enter saves, Esc cancels, leaving the field
 *    saves) and from the sidebar (double-click); both places follow.
 * 3. An 81-character title is refused: in the form (warning, Start disabled) and
 *    by the server on a rename (its message under the field).
 */

let tmp: string;
let workspace: string;
let server: ServerProcess;
let gitEnv: Record<string, string>;

const TITLE = 'JIRA Ticket handling';
const NAME = 'jira-ticket-handling';
const LONG = 'L'.repeat(81);

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

async function listSessions(page: Page): Promise<Session[]> {
  return page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as Session[]);
}

async function summary(modal: Locator): Promise<string[]> {
  return modal.getByTestId('ns-summary-line').allTextContents();
}

async function openModal(page: Page): Promise<Locator> {
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId('ns-group').first()).toBeVisible();
  return modal;
}

/** The sidebar row of the session with this id. */
function sidebarRow(page: Page, id: string): Locator {
  return page.getByTestId('sidebar-sessions').locator(`a[href$="/sessions/${id}"]`);
}

/** Waits until the stored session has this title (the API is the source of truth). */
async function expectStoredTitle(page: Page, id: string, title: string | null): Promise<void> {
  await expect.poll(async () => (await listSessions(page)).find((s) => s.id === id)?.title ?? null).toBe(title);
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-session-titles'));
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
  await writeFile(path.join(workspace, 'AGENTS.md'), '# AGENTS.md (Workspace Router)\n');
  await makeRepo(path.join(workspace, 'microfrontends', 'web-front'));
  await makeRepo(path.join(workspace, 'mobile'));
  // D14: the workspace is the saved (default) folder.
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

test('create "JIRA Ticket handling": the summary shows the short name; sidebar and header show the title; the branch is session/jira-ticket-handling', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const modal = await openModal(page);
  await modal.getByTestId('ns-name').fill(TITLE);
  // The field keeps the free text; the summary names the branch and the worktree after the short name.
  await expect(modal.getByTestId('ns-name')).toHaveValue(TITLE);
  await modal.getByTestId('ns-task').fill('Handle the JIRA ticket.');
  await modal.locator('[data-testid="ns-chip"][data-solution="web-front"]').click();
  expect(await summary(modal)).toEqual(expect.arrayContaining([`branch    session/${NAME}`, `../web-front-wt-${NAME}`]));

  await modal.getByTestId('ns-start').click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('view-session')).toBeVisible();
  await expect(page.getByTestId('session-name')).toHaveText(TITLE);
  // The composer names the session by its title too.
  await expect(page.getByTestId('chat-input')).toHaveAttribute('placeholder', `Message ${TITLE}…`);

  const session = (await listSessions(page)).find((s) => s.name === NAME);
  expect(session).toMatchObject({ name: NAME, title: TITLE, displayTitle: TITLE, worktrees: true, solutions: ['web-front'] });
  await expect(sidebarRow(page, session!.id).locator('.sb-session-name')).toHaveText(TITLE);
  await expect(page.getByTestId('session-name')).toHaveAttribute('title', `${TITLE} (${NAME}) · click to rename`);
  await expect(sidebarRow(page, session!.id).locator('.sb-session-name')).toHaveAttribute('title', `${TITLE} (${NAME}) · double-click to rename`);

  // The worktree and its branch are built from the short name, never from the title.
  const worktree = path.join(workspace, 'microfrontends', `web-front-wt-${NAME}`);
  expect(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`session/${NAME}`);

  // The same title again: the short name gets -2.
  const again = await openModal(page);
  await again.getByTestId('ns-name').fill(TITLE);
  await again.locator('[data-testid="ns-chip"][data-solution="mobile"]').click();
  expect(await summary(again)).toEqual(expect.arrayContaining([`branch    session/${NAME}-2`, `../mobile-wt-${NAME}-2`]));
  await page.keyboard.press('Escape');
});

test('rename from the header: Enter saves, Esc cancels, leaving the field saves; the sidebar follows', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const session = (await listSessions(page)).find((s) => s.name === NAME)!;
  await page.goto(`${server.baseUrl}/sessions/${session.id}`);
  const name = page.getByTestId('session-name');
  await expect(name).toHaveText(TITLE);

  await name.click();
  const input = page.getByTestId('session-header').getByTestId('title-input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(TITLE);
  await input.fill('Billing: fix invoices');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(name).toHaveText('Billing: fix invoices');
  await expect(sidebarRow(page, session.id).locator('.sb-session-name')).toHaveText('Billing: fix invoices');
  await expectStoredTitle(page, session.id, 'Billing: fix invoices');
  // Only the title changed.
  expect((await listSessions(page)).find((s) => s.id === session.id)).toMatchObject({ name: NAME, claudeSessionId: session.claudeSessionId });

  // Esc cancels.
  await name.click();
  await input.fill('Not this one');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(name).toHaveText('Billing: fix invoices');
  await expectStoredTitle(page, session.id, 'Billing: fix invoices');

  // Leaving the field saves.
  await name.click();
  await input.fill('Saved on blur');
  await page.getByTestId('session-chips').click();
  await expect(input).toHaveCount(0);
  await expect(name).toHaveText('Saved on blur');
  await expectStoredTitle(page, session.id, 'Saved on blur');

  // The palette finds the session by its title and by its short name.
  await page.getByTestId('open-palette').click();
  await page.getByTestId('palette-input').fill('saved on blur');
  await expect(page.getByTestId('palette-row').filter({ hasText: 'Saved on blur' })).toHaveCount(1);
  await page.getByTestId('palette-input').fill(NAME);
  await expect(page.getByTestId('palette-row').filter({ hasText: 'Saved on blur' })).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('rename from the sidebar: double-click the name; the header follows', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const session = (await listSessions(page)).find((s) => s.name === NAME)!;
  const row = sidebarRow(page, session.id);
  await row.locator('.sb-session-name').dblclick();
  const input = row.getByTestId('title-input');
  await expect(input).toBeFocused();
  // The double-click's clicks opened the session (the row is a link); a click in the field keeps it open and stays put.
  await expect(page.getByTestId('view-session')).toBeVisible();
  const url = page.url();
  await input.click();
  await expect(input).toBeFocused();
  expect(page.url()).toBe(url);
  await input.fill('Renamed in the sidebar');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(row.locator('.sb-session-name')).toHaveText('Renamed in the sidebar');
  await expect(page.getByTestId('session-name')).toHaveText('Renamed in the sidebar');
  await expectStoredTitle(page, session.id, 'Renamed in the sidebar');
});

test('an 81-character title is refused: in the form, and by the server on a rename (its message shown)', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const modal = await openModal(page);
  await modal.locator('[data-testid="ns-chip"][data-solution="mobile"]').click();
  await modal.getByTestId('ns-name').fill(LONG);
  await expect(modal.getByTestId('ns-start')).toBeDisabled();
  expect(await summary(modal)).toContain('⚠ the title must be at most 80 characters');
  await modal.getByTestId('ns-name').fill('L'.repeat(80));
  await expect(modal.getByTestId('ns-start')).toBeEnabled();
  await page.keyboard.press('Escape');

  const session = (await listSessions(page)).find((s) => s.name === NAME)!;
  await page.goto(`${server.baseUrl}/sessions/${session.id}`);
  const name = page.getByTestId('session-name');
  await expect(name).toHaveText('Renamed in the sidebar');
  await name.click();
  const input = page.getByTestId('session-header').getByTestId('title-input');
  await input.fill(LONG);
  await input.press('Enter');
  await expect(page.getByTestId('title-error')).toHaveText('Not renamed: the title must be text of 1–80 characters');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveValue(LONG);
  await expectStoredTitle(page, session.id, 'Renamed in the sidebar');
  // Esc gives up; the title stays.
  await input.press('Escape');
  await expect(name).toHaveText('Renamed in the sidebar');

  // An emptied field clears the title: the short name is shown again.
  await name.click();
  await input.fill('');
  await input.press('Enter');
  await expect(name).toHaveText(NAME);
  await expectStoredTitle(page, session.id, null);
});
