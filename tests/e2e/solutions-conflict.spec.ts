import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../helpers/git.ts';
import { REPO_ROOT } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';

/**
 * Conflict detection + "Move … to worktree" (M6.3) on the real code path (D13,
 * no demo seed): `node src/server/main.ts` with fake-claude as the CLI, a fake
 * gh, and a temp workspace of real git repos. Two sessions started through the
 * API write `mobile/` in place: the sidebar badge, the row flag and the conflict
 * card appear through `/hub`; each "Move … to worktree" click creates the
 * session's worktree (gap #2) until every writer has its own and the warning is
 * gone. The developer's checkout is never touched. D22: a titled writer is named
 * by its title in the card and its button; its worktree and branch keep the short name.
 */
let world: GitWorld;
let server: ServerProcess;

const WARNING_TAIL = "in one working tree. Your AGENTS.md requires isolation: 'worktree' for parallel writers in the same repo.";

test.beforeAll(async () => {
  world = await makeGitWorld();
  await writeFile(path.join(world.workspace, 'AGENTS.md'), await readFile(path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md'), 'utf8'));
  const claudeConfig = path.join(world.root, 'claude-config');
  await mkdir(claudeConfig, { recursive: true });
  // D14: the workspace is a saved folder (the default) in the server's database.
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

/** Starts a session through the API from the page (same origin, the sb_token cookie). */
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

function row(page: Page, name: string) {
  return page.locator(`[data-testid="solution-row"][data-solution="${name}"]`);
}

test('two sessions in one checkout: badge, flag and card; "Move … to worktree" isolates each until the warning is gone', async ({ page }) => {
  const mobileWt = (name: string) => path.join(world.workspace, `mobile-wt-${name}`);
  await page.goto(`${server.baseUrl}/solutions`);
  await expect(page.getByTestId('view-solutions')).toBeVisible();
  const badge = page.getByTestId('nav-solutions').locator('.sb-badge');
  await expect(badge).toHaveText('');
  await expect(row(page, 'mobile')).toBeVisible();
  await expect(row(page, 'mobile').locator('.sb-sol-flag')).toHaveCount(0);

  // Two sessions write mobile/ in place (no worktrees). D22: the first has a title, which the card names it by.
  expect(await startSession(page, { name: 'first-writer', title: 'First writer', task: 'Reply with OK.', solutions: ['mobile'], worktrees: false })).toBe(201);
  expect(await startSession(page, { name: 'second-writer', task: 'Reply with OK.', solutions: ['mobile'], worktrees: false })).toBe(201);
  const statusBefore = await world.git(world.mobile, 'status', '--porcelain');

  // The sidebar badge and the row flag follow through /hub (sessionUpdated), without a reload.
  await expect(badge).toHaveText('1 conflict', { timeout: 15_000 });
  await expect(badge).toHaveAttribute('data-kind', 'warn');
  const flag = row(page, 'mobile').locator('.sb-sol-flag');
  await expect(flag).toHaveText('⚠ shared working tree', { timeout: 15_000 });
  await expect(flag).toHaveAttribute('data-kind', 'warn');
  await expect(row(page, 'web-front').locator('.sb-sol-flag')).toHaveCount(0);

  // The first row (web-front) has no card; mobile's detail shows the warning and one action per writer.
  await expect(page.getByTestId('solution-detail')).toHaveAttribute('data-solution', 'web-front');
  await expect(page.getByTestId('conflict-card')).toHaveCount(0);
  await row(page, 'mobile').click();
  const card = page.getByTestId('conflict-card');
  await expect(page.getByTestId('conflict-text')).toHaveText(`First writer and second-writer both write to mobile/ ${WARNING_TAIL}`);
  await expect(card.getByTestId('conflict-move')).toHaveText(['Move First writer to worktree', 'Move second-writer to worktree']);

  // Move second-writer: its worktree appears; first-writer is still in the main checkout, so the warning stays.
  await card.getByRole('button', { name: 'Move second-writer to worktree' }).click();
  await expect(card.getByTestId('conflict-move')).toHaveText(['Move First writer to worktree'], { timeout: 15_000 });
  await expect(page.getByTestId('conflict-text')).toHaveText(`First writer and second-writer both write to mobile/ ${WARNING_TAIL}`);
  await expect(page.getByTestId('solution-detail').getByTestId('branch-card').filter({ hasText: 'second-writer' })).toHaveText(
    '⎇ session/second-writer../mobile-wt-second-writersecond-writer',
    { timeout: 15_000 },
  );
  expect(await exists(mobileWt('second-writer'))).toBe(true);
  await expect(badge).toHaveText('1 conflict');

  // Move first-writer (by its title): every writer has its own worktree → no card, no flag, no badge; its worktree and branch keep the short name.
  await card.getByRole('button', { name: 'Move First writer to worktree' }).click();
  await expect(page.getByTestId('conflict-card')).toHaveCount(0, { timeout: 15_000 });
  await expect(row(page, 'mobile').locator('.sb-sol-flag')).toHaveCount(0);
  await expect(badge).toHaveText('', { timeout: 15_000 });
  await expect(row(page, 'mobile').getByTestId('branch-chip')).toHaveText(
    ['⎇ session/second-writermobile-wt-second-writersecond-writer', '⎇ session/first-writermobile-wt-first-writerfirst-writer'],
    { timeout: 15_000 },
  );
  expect(await exists(mobileWt('first-writer'))).toBe(true);
  expect(await world.git(mobileWt('first-writer'), 'symbolic-ref', '--short', 'HEAD')).toBe('session/first-writer');

  // The developer's checkout was only read: same branch, same changes, nothing stashed.
  expect(await world.git(world.mobile, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  expect(await world.git(world.mobile, 'status', '--porcelain')).toBe(statusBefore);
  expect(await world.git(world.mobile, 'stash', 'list')).toBe('');
});
