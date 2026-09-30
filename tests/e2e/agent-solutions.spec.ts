import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { SOLUTIONS_NOT_CHOSEN, agentWorktreesInstruction } from '../../src/core/first-turn.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { openWithHub } from './question-world.ts';
import { rememberNewSessionModeInDataDir } from '../helpers/new-session-mode.ts';

/**
 * D38 oracle (E2E, real path, no demo seed, D13): a workspace session started
 * from the New-session modal **without picked solutions**. `node
 * src/server/main.ts` with fake-claude as the CLI, fake gh, a temp data folder
 * and a fixture workspace (git repos `microfrontends/acme-app-front`, `mobile`).
 * 1. Worktrees off: the form starts without a chip picked (the summary reads
 *    `solutions  chosen by the agent`); the first message carries the "not
 *    chosen" answer; a `[fake:write …]` into `microfrontends/acme-app-front`
 *    fills in the session's solution chip live (`scope acme-app-front`).
 * 2. Worktrees on, a ticket title: the first message tells the agent to create
 *    its worktrees on the ticket branch; the agent (`[fake:worktree-add]`) runs
 *    `git worktree add` and Switchboard adopts the worktree: the chip fills in and
 *    the Diff tab shows a write in it on the ticket branch.
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

async function listSessions(page: Page): Promise<Session[]> {
  return page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as Session[]);
}

/** The session's first user message as the agent got it (the task + the answers block). */
async function firstMessage(page: Page, id: string): Promise<string[]> {
  const events = (await page.evaluate(async (sid) => (await fetch(`/api/sessions/${sid}/events`)).json(), id)) as Array<{ payload: { type?: string; text?: string } }>;
  return (events.find((event) => event.payload.type === 'user')?.payload.text ?? '').split('\n');
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

async function send(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId('chat-input');
  await composer.fill(text);
  await composer.press('Enter');
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-agent-solutions'));
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
  await makeRepo(path.join(workspace, 'microfrontends', 'acme-app-front'));
  await makeRepo(path.join(workspace, 'mobile'));
  // D14: the workspace is a saved folder (the default) in the server's database.
  await seedFolderInDataDir(dataDir, workspace);
  // D56: this spec exercises the Full New-session form (Simple is the fresh-install default).
  await rememberNewSessionModeInDataDir(dataDir, 'full');
  server = await startServer({
    ...gitEnv,
    SWITCHBOARD_DATA_DIR: dataDir,
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    FAKE_CLAUDE_SCENARIO: 'handoff-start',
    FAKE_GH_PRS: path.join(tmp, 'fake-gh-prs.json'),
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  if (tmp) await removeTempDir(tmp);
});

test('no solution picked: the agent is told to choose; a write into acme-app-front fills in the solution chip', async ({ page }) => {
  await openWithHub(page, `${server.baseUrl}/inbox`);
  const modal = await openModal(page);
  await modal.getByTestId('ns-name').fill('agent-picks');
  await modal.getByTestId('ns-task').fill('Add the free talk screen.');
  await modal.getByTestId('ns-switch-worktrees').click();
  await expect(modal.getByTestId('ns-solutions-hint')).toHaveText('0 selected · leave empty to let the agent choose · read-only folders locked');
  expect(await summary(modal)).toEqual([
    '# claude code · background · Max',
    'folder    work space · workspace',
    `cwd       ${workspace}`,
    'work      feature-building',
    'mode      single-solution',
    'phase     UI-first',
    'ultracode off',
    'model     Default', // D42: the Model row's choice (the CLI default here)
    ' ',
    '# no worktrees · edits in place',
    'solutions  chosen by the agent',
    ' ',
    '✓ answers pre-filled → agent confirms, no re-ask',
  ]);
  await expect(modal.getByTestId('ns-start')).toBeEnabled();
  const posted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions');
  await modal.getByTestId('ns-start').click();
  expect((await posted).postDataJSON()).toMatchObject({ name: 'agent-picks', solutions: [], worktrees: false });
  await expect(modal).toHaveCount(0);
  const view = page.getByTestId('view-session');
  await expect(view).toBeVisible();

  const created = (await listSessions(page)).find((s) => s.name === 'agent-picks');
  expect(created?.solutions).toEqual([]);
  const lines = await firstMessage(page, created?.id ?? '');
  expect(lines[0]).toBe('Add the free talk screen.');
  expect(lines).toContain(`- Solutions in scope: ${SOLUTIONS_NOT_CHOSEN}`);
  expect(lines).toContain('- Worktrees: no worktrees · edits in place');
  expect(lines.some((line) => line.startsWith('- Mobile coordination'))).toBe(false);
  // No solution yet: no scope chip.
  await expect(page.getByTestId('session-chip')).toHaveText(['work feature-building', 'mode single-solution', 'phase UI-first']);

  // The agent writes into microfrontends/acme-app-front: the solution joins the session, the chip follows live.
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await send(page, 'Start there. [fake:write microfrontends/acme-app-front/notes.md]');
  await expect(page.getByTestId('session-chip')).toHaveText(['work feature-building', 'mode single-solution', 'phase UI-first', 'scope acme-app-front']);
  expect((await listSessions(page)).find((s) => s.name === 'agent-picks')?.solutions).toEqual(['acme-app-front']);
});

test('Worktrees on + a ticket branch: the agent creates its worktree, Switchboard adopts it (chip, Diff tab)', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${server.baseUrl}/inbox`);
  const modal = await openModal(page);
  await modal.getByTestId('ns-name').fill('PROJ-38 Agent worktree');
  // D32: the Branch field still shows with Worktrees on (the agent may create a worktree) and is pre-filled from the title.
  await expect(modal.getByTestId('ns-branch')).toHaveValue('PROJ-38-agent-worktree');
  const name = 'proj-38-agent-worktree';
  const worktree = path.join(workspace, 'microfrontends', `acme-app-front-wt-${name}`);
  await modal
    .getByTestId('ns-task')
    .fill(`Build it in a worktree. [fake:worktree-add microfrontends/acme-app-front PROJ-38-agent-worktree microfrontends/acme-app-front-wt-${name}]`);
  expect(await summary(modal)).toEqual(expect.arrayContaining(['# worktrees', 'branch    PROJ-38-agent-worktree', 'solutions  chosen by the agent']));
  await modal.getByTestId('ns-start').click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('view-session')).toBeVisible();

  const created = (await listSessions(page)).find((s) => s.name === name);
  expect(created).toMatchObject({ worktrees: true });
  // No worktree up front; the first message tells the agent where to create its own.
  const lines = await firstMessage(page, created?.id ?? '');
  expect(lines).toContain(`- Solutions in scope: ${SOLUTIONS_NOT_CHOSEN}`);
  expect(lines).toContain(`- Worktrees: ${agentWorktreesInstruction('PROJ-38-agent-worktree', name, { epic: null, base: 'dev' })}`);

  // The fake ran `git worktree add` (a main-agent Bash): the worktree is adopted and acme-app-front joins the session.
  await expect(page.getByTestId('session-chip').filter({ hasText: 'scope' })).toHaveText('scope acme-app-front');
  expect(await git(worktree, 'branch', '--show-current')).toBe('PROJ-38-agent-worktree');

  // A write in the worktree: the Diff tab shows it on the ticket branch.
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await send(page, `Write the plan. [fake:write microfrontends/acme-app-front-wt-${name}/notes/plan.md]`);
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await page.goto(`${server.baseUrl}/sessions/${created?.id}/diff`);
  const row = page.getByTestId('diff-file').filter({ hasText: 'plan.md' });
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await expect(row.locator('.sb-diff__file-sub')).toHaveText('acme-app-front · notes/plan.md');
  await row.click();
  await expect(page.getByTestId('diff-branch')).toHaveText('⎇ PROJ-38-agent-worktree');
  // The main checkout never got the plan (only the first test's in-place notes.md).
  expect(await git(path.join(workspace, 'microfrontends', 'acme-app-front'), 'status', '--porcelain', '--untracked-files=all')).toBe('?? notes.md');
});
