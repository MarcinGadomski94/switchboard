import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../helpers/git.ts';
import { REPO_ROOT } from '../helpers/net.ts';
import { type OriginRepo, makeOriginRepo } from '../helpers/origin.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { openWithHub } from './question-world.ts';

/**
 * D60 oracle (E2E, real path, no demo seed, D13): "Move … to worktree" onto an
 * **existing** branch. `node src/server/main.ts` with fake-claude, a fake gh and
 * a temp workspace whose `microfrontends/alpha-front` is cloned from a **local
 * bare origin** (never a real remote; origin: master and `PROJ-5-remote-only`).
 * Two sessions write alpha-front in place → the conflict card; the confirm step's
 * **Existing branch** lists the local and remote branches (master, checked out in
 * the main checkout, disabled with the reason), a branch pushed after the clone
 * appears once the automatic fetch is done, the search narrows the list, picking
 * `origin/PROJ-5-remote-only` and **Move to worktree** creates the session's
 * worktree on a local `PROJ-5-remote-only` tracking it, and the session's chat
 * shows the move message naming the existing branch.
 */
let world: GitWorld;
let alpha: OriginRepo;
let server: ServerProcess;

test.beforeAll(async () => {
  world = await makeGitWorld();
  await writeFile(path.join(world.workspace, 'AGENTS.md'), await readFile(path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md'), 'utf8'));
  const cloned = await makeOriginRepo(world.git, world.root, path.join(world.workspace, 'microfrontends', 'alpha-front'), [['PROJ-5-remote-only', 'master']]);
  alpha = { ...cloned, repo: await realpath(cloned.repo) };
  const claudeConfig = path.join(world.root, 'claude-config');
  await mkdir(claudeConfig, { recursive: true });
  await seedFolderInDataDir(path.join(world.root, 'data'), world.workspace);
  server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(world.root, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: claudeConfig,
    FAKE_CLAUDE_SCENARIO: 'handoff-start',
    FAKE_GH_PRS: world.prsFile,
    GIT_CONFIG_GLOBAL: String(world.env['GIT_CONFIG_GLOBAL']),
    GIT_CONFIG_NOSYSTEM: '1',
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  await world?.cleanup();
});

async function startSession(page: Page, body: Record<string, unknown>): Promise<number> {
  return page.evaluate(async (payload) => {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workType: 'feature', mode: 'single', phase: 'ui-first', coordination: 'none', qa: null, ultracode: false, ...payload }),
    });
    return response.status;
  }, body);
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

test('conflict card → Existing branch → pick a remote branch → the session is moved onto it and told so', async ({ page }) => {
  await page.goto(`${server.baseUrl}/solutions`);
  await expect(page.getByTestId('view-solutions')).toBeVisible();
  expect(await startSession(page, { name: 'first-writer', task: 'Reply with OK.', solutions: ['alpha-front'], worktrees: false })).toBe(201);
  expect(await startSession(page, { name: 'second-writer', task: 'Reply with OK.', solutions: ['alpha-front'], worktrees: false })).toBe(201);
  // Pushed after the clone: only the fetch brings it.
  await alpha.push('PROJ-9-late', 'late.txt', 'late\n');
  const statusBefore = await world.git(alpha.repo, 'status', '--porcelain');

  const row = page.locator('[data-testid="solution-row"][data-solution="alpha-front"]');
  await expect(row.locator('.sb-sol-flag')).toHaveText('⚠ shared working tree', { timeout: 15_000 });
  await row.click();
  const card = page.getByTestId('conflict-card');
  await card.getByRole('button', { name: 'Move second-writer to worktree' }).click();

  // New branch is the default (D32, unchanged); Existing branch switches to the picker.
  await expect(card.getByTestId('conflict-mode-new')).toHaveAttribute('aria-checked', 'true');
  await expect(card.getByTestId('conflict-branch')).toBeVisible();
  await card.getByTestId('conflict-mode-existing').click();
  await expect(card.getByTestId('conflict-mode-existing')).toHaveAttribute('aria-checked', 'true');
  await expect(card.getByTestId('conflict-confirm-text')).toHaveText('second-writer gets a new worktree of alpha-front on an existing branch (local or remote):');
  await expect(card.getByTestId('conflict-branch')).toHaveCount(0);
  await expect(card.getByTestId('conflict-confirm-move')).toBeDisabled();
  await expect(card.getByTestId('conflict-branch-note')).toHaveText('Pick the branch the worktree will be on');

  // The cached list, then the fetched one (the late branch appears; no warning stays).
  const options = card.getByTestId('conflict-pick-option');
  await expect(card.locator('[data-testid="conflict-pick-option"][data-branch="origin/PROJ-9-late"]')).toBeVisible({ timeout: 15_000 });
  await expect(card.getByTestId('conflict-pick-status')).toHaveCount(0);
  const names = await options.evaluateAll((els) => els.map((el) => el.getAttribute('data-branch')));
  expect(names[0]).toBe('master');
  expect([...names].sort()).toEqual(['master', 'origin/PROJ-5-remote-only', 'origin/PROJ-9-late', 'origin/master']);
  const master = card.locator('[data-testid="conflict-pick-option"][data-branch="master"]');
  await expect(master).toBeDisabled();
  await expect(master.getByTestId('conflict-pick-reason')).toHaveText(`checked out in ${alpha.repo}`);
  await expect(master.getByTestId('conflict-pick-kind')).toHaveText('local');

  // Search, pick the remote-only branch.
  await card.getByTestId('conflict-pick-search').fill('no-such-branch');
  await expect(card.getByTestId('conflict-pick-empty')).toHaveText('No branch matches the search.');
  await card.getByTestId('conflict-pick-search').fill('remote-only');
  await expect(options).toHaveCount(1);
  const remote = options.first();
  await expect(remote.getByTestId('conflict-pick-kind')).toHaveText('remote · origin');
  await expect(remote.getByTestId('conflict-pick-detail')).toHaveText(/^write PROJ-5-remote-only\.txt · /);
  await expect(remote.getByTestId('conflict-pick-note')).toHaveText('makes the local branch PROJ-5-remote-only tracking it');
  await remote.click();
  await expect(remote).toHaveAttribute('aria-selected', 'true');
  await expect(card.getByTestId('conflict-branch-note')).toHaveText('⎇ a new local PROJ-5-remote-only tracking origin/PROJ-5-remote-only');
  await card.getByTestId('conflict-confirm-move').click();

  // Moved: its worktree on the tracking branch; the other writer still in place, so the card stays with one button.
  await expect(card.getByTestId('conflict-move')).toHaveText(['Move first-writer to worktree'], { timeout: 15_000 });
  const target = path.join(path.dirname(alpha.repo), 'alpha-front-wt-second-writer');
  expect(await exists(target)).toBe(true);
  expect(await world.git(target, 'branch', '--show-current')).toBe('PROJ-5-remote-only');
  expect(await world.git(target, 'rev-parse', '--abbrev-ref', 'PROJ-5-remote-only@{upstream}')).toBe('origin/PROJ-5-remote-only');
  expect(await world.git(alpha.repo, 'symbolic-ref', '--short', 'HEAD')).toBe('master');
  expect(await world.git(alpha.repo, 'status', '--porcelain')).toBe(statusBefore);

  // The chat shows the move message: an existing branch, tracking the remote one.
  const sessions = (await page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as Session[])) as Session[];
  const moved = sessions.find((session) => session.name === 'second-writer');
  expect(moved).toBeDefined();
  await openWithHub(page, `${server.baseUrl}/sessions/${moved?.id ?? ''}`);
  const chat = page.getByTestId('session-chat');
  await expect(chat).toContainText(`make every change to alpha-front in ${target} (the existing branch PROJ-5-remote-only, made from origin/PROJ-5-remote-only and tracking it)`, { timeout: 15_000 });
  await expect(chat).toContainText("you are continuing that branch's work, not starting fresh");
});
