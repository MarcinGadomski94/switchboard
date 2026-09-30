import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { Folder, Session } from '../../src/core/api.ts';
import { SESSION_START_HEADER, REPO_WORKTREE_NOTE_HEADER } from '../../src/core/first-turn.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * D56 oracle (E2E, real path: `node src/server/main.ts` with fake-claude and fake
 * gh, a temp data folder, a fixture workspace with a router AGENTS.md and a git
 * repo, and a standalone git repo folder; no demo seed; nothing remembered, so
 * this is a fresh install):
 * 1. "+ New session" opens the **Simple** form: Folder, Message, Title, Model;
 *    no router sections, no solutions, no worktree for a workspace folder.
 *    Enter types a new line, ⌘↩ / Ctrl+↩ starts: the session opens, its title
 *    comes from the message, and the agent's first message is the message alone
 *    (no "Session-start answers" block).
 * 2. A repo folder offers "Work in its own git worktree" with the derived
 *    branch (`sb/<slug>`, editable); switching to Full keeps the folder, the
 *    message, the title, the model and the worktree; the mode is remembered
 *    across a reload (the palette's New session opens in it too). Start from
 *    Simple: the session runs in `../solo-wt-<name>` on the edited branch, its
 *    first message is the message + only the worktree note.
 * 3. D59: a plain folder (no AGENTS.md, not a git repository), typed into
 *    Browse…: its check line says so, Add saves it (kind `folder` in Settings →
 *    Folders) and selects it; no worktree checkbox; Full shows its note with
 *    **Use Simple** and cannot start; Start from Simple runs claude in the folder
 *    with the message alone; next time the dropdown offers the folder.
 */

let tmp: string;
let workspace: string;
let soloRepo: string;
let notes: string;
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

async function listSessions(page: Page): Promise<Session[]> {
  return page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as Session[]);
}

async function savedFolders(page: Page): Promise<Folder[]> {
  return page.evaluate(async () => (await (await fetch('/api/folders')).json()) as Folder[]);
}

async function storedMode(page: Page): Promise<unknown> {
  return page.evaluate(async () => ((await (await fetch('/api/settings')).json()) as Record<string, unknown>)['newSession.mode']);
}

/** The session's first user message as the agent got it. */
async function firstMessage(page: Page, id: string): Promise<string> {
  let text = '';
  await expect
    .poll(async () => {
      const events = (await page.evaluate(async (sid) => (await fetch(`/api/sessions/${sid}/events`)).json(), id)) as Array<{ payload: { type?: string; text?: string } }>;
      text = events.find((event) => event.payload.type === 'user')?.payload.text ?? '';
      return text;
    })
    .not.toBe('');
  return text;
}

async function openModal(page: Page): Promise<Locator> {
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal).toBeVisible();
  await expect(modal).not.toHaveAttribute('data-mode', 'loading');
  return modal;
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-simple-session'));
  workspace = path.join(tmp, 'work space');
  soloRepo = path.join(tmp, 'solo');
  notes = path.join(tmp, 'my notes');
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
  await makeRepo(soloRepo);
  // D59: a plain folder: no AGENTS.md, not a git repository.
  await mkdir(notes, { recursive: true });
  await writeFile(path.join(notes, 'todo.txt'), 'buy milk\n');
  // D14: the workspace is the default folder, the repo a second one. Nothing else is stored (no remembered mode).
  await seedFolderInDataDir(dataDir, workspace);
  await seedFolderInDataDir(dataDir, soloRepo, { kind: 'repo' });
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

test('a fresh install opens Simple; a workspace session starts with the message alone (⌘↩ / Ctrl+↩), titled from the message', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  expect(await storedMode(page)).toBe('simple');
  const modal = await openModal(page);
  await expect(modal).toHaveAttribute('data-mode', 'simple');
  await expect(modal.getByTestId('ns-mode-simple')).toHaveAttribute('aria-checked', 'true');
  await expect(modal.getByTestId('ns-mode-full')).toHaveAttribute('aria-checked', 'false');
  await expect(modal.locator('.sb-ns-label')).toHaveText(['Folder', 'Message', 'Title optional']);
  // No router sections, solutions, branching, ultracode, QA, resume or remote pills in Simple.
  for (const id of ['ns-section', 'ns-pill', 'ns-chip', 'ns-recommended', 'ns-switch-ultracode', 'ns-resume', 'ns-remote', 'ns-branch', 'ns-summary']) await expect(modal.getByTestId(id)).toHaveCount(0);
  await expect(modal.getByTestId('ns-folder').locator('option:checked')).toHaveText('work space (default)');
  // A workspace folder works in place: no worktree checkbox; nothing is pre-answered.
  await expect(modal.getByTestId('ns-worktree')).toHaveCount(0);
  await expect(modal.getByTestId('ns-simple-workspace-note')).toHaveText('No session-start answers are sent: the agent asks what the workspace router needs.');
  await expect(modal.getByTestId('ns-simple-where').locator('div').first()).toHaveText(`Runs in ${workspace}`);
  await expect(modal.getByTestId('ns-model-button')).toBeEnabled();
  await expect(modal.getByTestId('ns-start')).toBeDisabled();
  await expect(modal.getByTestId('ns-simple-waiting')).toHaveText('type the message');

  // Enter in the message is a new line (never a start); the title placeholder follows the first line.
  const message = modal.getByTestId('ns-message');
  await message.click();
  await page.keyboard.type('Fix the login redirect.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('It loops on /callback.');
  await expect(modal).toBeVisible();
  await expect(message).toHaveValue('Fix the login redirect.\nIt loops on /callback.');
  await expect(modal.getByTestId('ns-simple-title')).toHaveAttribute('placeholder', 'Fix the login redirect.');
  await expect(modal.getByTestId('ns-start')).toBeEnabled();

  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('view-session')).toBeVisible();
  await expect(page.getByTestId('session-name')).toHaveText('Fix the login redirect.');
  const session = (await listSessions(page)).find((s) => s.name === 'fix-the-login-redirect');
  expect(session).toMatchObject({ title: 'Fix the login redirect.', solutions: [], workType: null, mode: null, phase: null, worktrees: false, cwd: workspace });
  const first = await firstMessage(page, session!.id);
  expect(first).toBe('Fix the login redirect.\nIt loops on /callback.');
  expect(first).not.toContain(SESSION_START_HEADER[0]);
});

test('a repo folder: own worktree with the derived branch; Full keeps what was typed; the mode is remembered; Start runs in the worktree', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const solo = (await savedFolders(page)).find((folder) => folder.kind === 'repo')!;
  let modal = await openModal(page);
  await expect(modal).toHaveAttribute('data-mode', 'simple');
  await modal.getByTestId('ns-folder').selectOption(solo.id);
  await modal.getByTestId('ns-message').fill('Tidy the README.');
  await modal.getByTestId('ns-simple-title').fill('Tidy readme');
  // The model: pick Sonnet (the CLI's aliases before any process reported a list).
  await modal.getByTestId('ns-model-button').click();
  await modal.locator('[data-testid="model-option"][data-value="sonnet"]').click();
  await page.keyboard.press('Escape');
  await expect(modal).toBeVisible();
  const modelText = (await modal.getByTestId('ns-model-button').textContent()) ?? '';
  expect(modelText).toMatch(/sonnet/i);

  // Own worktree: offered for a git repo, on by default, the branch derived as a plain slug (read-only until Edit).
  const worktree = modal.getByTestId('ns-worktree');
  await expect(worktree).toBeChecked();
  await expect(modal.getByTestId('ns-simple-branch-name')).toHaveText('sb/tidy-readme');
  await expect(modal.getByTestId('ns-simple-where').locator('div').first()).toHaveText(`Runs in ${path.join(tmp, 'solo-wt-tidy-readme')}`);
  await expect(modal.getByTestId('ns-simple-workspace-note')).toHaveCount(0);

  // Switch to Full: the folder, the message, the title, the model and Worktree carry over; the choice is stored.
  await modal.getByTestId('ns-mode-full').click();
  await expect(modal).toHaveAttribute('data-mode', 'full');
  await expect(modal.getByTestId('ns-mode-full')).toHaveAttribute('aria-checked', 'true');
  await expect(modal.getByTestId('ns-folder')).toHaveValue(solo.id);
  await expect(modal.getByTestId('ns-task')).toHaveValue('Tidy the README.');
  await expect(modal.getByTestId('ns-name')).toHaveValue('Tidy readme');
  await expect(modal.getByTestId('ns-switch-worktrees')).toHaveAttribute('aria-checked', 'true');
  await expect(modal.getByTestId('ns-model-button')).toHaveText(modelText);
  await expect.poll(() => storedMode(page)).toBe('full');
  // Full's own rules still apply (D32's ticket branch): nothing leaks from Simple's branch.
  await expect(modal.getByTestId('ns-branch')).toHaveValue('');
  // Worktree off in Full shows unchecked in Simple, and back.
  await modal.getByTestId('ns-switch-worktrees').click();
  await modal.getByTestId('ns-mode-simple').click();
  await expect(modal).toHaveAttribute('data-mode', 'simple');
  await expect(modal.getByTestId('ns-message')).toHaveValue('Tidy the README.');
  await expect(modal.getByTestId('ns-simple-title')).toHaveValue('Tidy readme');
  await expect(modal.getByTestId('ns-folder')).toHaveValue(solo.id);
  await expect(worktree).not.toBeChecked();
  await worktree.check();
  await expect.poll(() => storedMode(page)).toBe('simple');

  // Remembered across a reload: Full, then Simple again; the palette's New session opens in it too.
  await modal.getByTestId('ns-mode-full').click();
  await expect.poll(() => storedMode(page)).toBe('full');
  await page.reload();
  modal = await openModal(page);
  await expect(modal).toHaveAttribute('data-mode', 'full');
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await page.getByTestId('open-palette').click();
  await page.getByTestId('palette-input').fill('New session');
  await page.keyboard.press('Enter');
  await expect(modal).toHaveAttribute('data-mode', 'full');
  await modal.getByTestId('ns-mode-simple').click();
  await expect.poll(() => storedMode(page)).toBe('simple');
  await page.reload();
  modal = await openModal(page);
  await expect(modal).toHaveAttribute('data-mode', 'simple');

  // Start from Simple in the repo with its own worktree, on an edited branch.
  await modal.getByTestId('ns-folder').selectOption(solo.id);
  await modal.getByTestId('ns-message').fill('Tidy the README.\nKeep it short.');
  await modal.getByTestId('ns-simple-title').fill('Tidy readme');
  await expect(modal.getByTestId('ns-worktree')).toBeChecked();
  await modal.getByTestId('ns-simple-branch-edit').click();
  const branch = modal.getByTestId('ns-simple-branch');
  await expect(branch).toHaveValue('sb/tidy-readme');
  await branch.fill('bad..name');
  await expect(modal.getByTestId('ns-simple-branch-problem')).toHaveText('the branch must be a valid git branch name, e.g. sb/short-description');
  await expect(modal.getByTestId('ns-start')).toBeDisabled();
  await branch.fill('docs/tidy-readme');
  await expect(modal.getByTestId('ns-start')).toBeEnabled();
  await modal.getByTestId('ns-start').click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('session-name')).toHaveText('Tidy readme');

  const dir = path.join(tmp, 'solo-wt-tidy-readme');
  const session = (await listSessions(page)).find((s) => s.name === 'tidy-readme');
  expect(session).toMatchObject({ title: 'Tidy readme', solutions: ['solo'], workType: null, worktrees: true, cwd: dir, folderKind: 'repo' });
  expect((await stat(dir)).isDirectory()).toBe(true);
  expect(await git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('docs/tidy-readme');
  const first = await firstMessage(page, session!.id);
  expect(first.split('\n')).toEqual([
    'Tidy the README.',
    'Keep it short.',
    '',
    REPO_WORKTREE_NOTE_HEADER,
    `- Worktree: ${dir} (branch docs/tidy-readme, from main); it is your working folder: make every change here.`,
    `- Main checkout: ${soloRepo} (leave it as it is).`,
  ]);
});

test('D59: a plain folder typed into Browse… is saved and selected; Full offers Simple; Simple starts claude there with the message alone; it is offered next time', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  let modal = await openModal(page);
  if ((await modal.getAttribute('data-mode')) !== 'simple') await modal.getByTestId('ns-mode-simple').click();
  await expect(modal).toHaveAttribute('data-mode', 'simple');
  await expect(modal.getByTestId('ns-folder').locator('option')).toHaveCount(2);

  // Browse…: type the plain folder's path; its check line says what it is; Add saves and selects it.
  await modal.getByTestId('ns-folder-browse').click();
  const panel = modal.getByTestId('ns-folder-add-panel');
  await panel.getByTestId('ns-folder-add-input').fill(notes);
  await expect(panel.getByTestId('ns-folder-add-line')).toHaveText('✓ folder · no AGENTS.md, not a git repo · Simple sessions');
  await expect(panel.getByTestId('ns-folder-add-line')).toHaveAttribute('data-ok', 'true');
  await panel.getByTestId('ns-folder-add-add').click();
  await expect(panel).toHaveCount(0);
  await expect(modal.getByTestId('ns-folder').locator('option:checked')).toHaveText('my notes');
  await expect(modal.getByTestId('ns-folder-check')).toHaveText('✓ folder · no AGENTS.md, not a git repo · Simple sessions');
  const saved = (await savedFolders(page)).find((folder) => folder.path === notes);
  expect(saved).toMatchObject({ kind: 'plain', name: 'my notes', check: { kind: 'plain' } });

  // No worktree, no workspace note: the plain note; it runs in the folder itself.
  await expect(modal.getByTestId('ns-simple-field').first()).toHaveAttribute('data-kind', 'plain');
  await expect(modal.getByTestId('ns-worktree')).toHaveCount(0);
  await expect(modal.getByTestId('ns-simple-workspace-note')).toHaveCount(0);
  await expect(modal.getByTestId('ns-simple-plain-note')).toHaveText('A plain folder (no AGENTS.md, not a git repository): Claude runs here with your message alone.');
  await expect(modal.getByTestId('ns-simple-where').locator('div').first()).toHaveText(`Runs in ${notes}`);
  await modal.getByTestId('ns-message').fill('Sort my notes by date.');

  // Full cannot start in a plain folder: its note offers Simple (and keeps what was typed).
  await modal.getByTestId('ns-mode-full').click();
  await expect(modal).toHaveAttribute('data-mode', 'full');
  await expect(modal.getByTestId('ns-plain-note')).toContainText("This folder has no AGENTS.md and isn't a git repository");
  await expect(modal.getByTestId('ns-recommended')).toHaveCount(0);
  await expect(modal.getByTestId('ns-start')).toBeDisabled();
  await modal.getByTestId('ns-plain-use-simple').click();
  await expect(modal).toHaveAttribute('data-mode', 'simple');
  await expect.poll(() => storedMode(page)).toBe('simple');
  await expect(modal.getByTestId('ns-message')).toHaveValue('Sort my notes by date.');
  await expect(modal.getByTestId('ns-folder')).toHaveValue(saved!.id);

  await modal.getByTestId('ns-start').click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('session-name')).toHaveText('Sort my notes by date.');
  const session = (await listSessions(page)).find((s) => s.name === 'sort-my-notes-by-date');
  expect(session).toMatchObject({ solutions: [], workType: null, worktrees: false, cwd: notes, folder: saved!.id, folderPath: notes, folderKind: 'plain' });
  const first = await firstMessage(page, session!.id);
  expect(first).toBe('Sort my notes by date.');
  await expect(page.getByTestId('session-root')).toContainText(`${notes} · folder`);

  // Next time: the dropdown offers it (recently used, after the default); Settings → Folders lists it as a "folder".
  modal = await openModal(page);
  await expect(modal.getByTestId('ns-folder').locator('option')).toHaveText(['work space (default)', 'my notes', 'solo']);
  await page.keyboard.press('Escape');
  await page.goto(`${server.baseUrl}/settings/folders`);
  const row = page.getByTestId('settings-folder').filter({ has: page.getByTestId('settings-folder-name').filter({ hasText: /^my notes$/ }) });
  await expect(row.getByTestId('settings-folder-kind')).toHaveText('folder');
  await expect(row.getByTestId('settings-folder-check')).toHaveText('✓ folder · no AGENTS.md, not a git repo · Simple sessions');
});
