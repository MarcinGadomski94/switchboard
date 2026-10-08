import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { Review } from '../../src/core/reviews.ts';
import { runCommand } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { type GitWorld, makeGitWorld } from '../helpers/git.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { openWithHub } from './question-world.ts';

/**
 * D79 · the review queue on the real code path (no demo seed): `node src/server/main.ts`
 * with fake-claude and fake gh over temp git repos. A worktree session's agent writes a
 * file; when its turn ends a Review card is raised: in the Inbox (desktop) and as the
 * session header's badge (phone). Merge is refused while the file is uncommitted, then
 * merges locally once it is committed; Clean up removes the worktree. A session working
 * in place gets Commit with a drafted, editable message. Screenshots go to
 * `/tmp/lane-b-shots/` (SWITCHBOARD_SHOTS overrides).
 */
const SHOTS = process.env['SWITCHBOARD_SHOTS'] ?? '/tmp/lane-b-shots';

let world: GitWorld;
let server: ServerProcess;

test.beforeAll(async () => {
  world = await makeGitWorld();
  await mkdir(SHOTS, { recursive: true });
  // The mobile repo's first commit predates the sessions (else it would count as the in-place session's commit).
  const old = { ...world.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  expect((await runCommand(['git'], ['commit', '-q', '--amend', '--no-edit', '--reset-author'], { cwd: world.mobile, env: old })).code).toBe(0);
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
    GIT_AUTHOR_NAME: 'Switchboard Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  await world?.cleanup();
});

async function startSession(page: Page, body: Record<string, unknown>): Promise<string> {
  const result = await page.evaluate(async (payload) => {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workType: 'feature', mode: 'single', phase: 'ui-first', coordination: 'none', qa: null, ultracode: false, ...payload }),
    });
    return { status: response.status, body: (await response.json()) as { id: string } };
  }, body);
  expect(result.status).toBe(201);
  return result.body.id;
}

async function reviewsOf(page: Page, sessionId: string): Promise<Review[]> {
  const all = await page.evaluate(async () => (await fetch('/api/reviews')).json() as Promise<Review[]>);
  return all.filter((review) => review.sessionId === sessionId);
}

test('a worktree session: the card in the Inbox, Merge refused while uncommitted, then merged locally and cleaned up', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${server.baseUrl}/inbox`);
  const worktree = path.join(world.workspace, 'microfrontends', 'web-front-wt-review-e2e');
  const id = await startSession(page, {
    name: 'review-e2e',
    title: 'Add the release notes',
    task: '[fake:write microfrontends/web-front-wt-review-e2e/notes/release.md]',
    solutions: ['web-front'],
    worktrees: true,
    branch: 'PROJ-79-release-notes',
  });
  await expect.poll(async () => (await reviewsOf(page, id)).length, { timeout: 30_000 }).toBe(1);

  await openWithHub(page, `${server.baseUrl}/inbox`);
  const item = page.locator('[data-testid="inbox-item"][data-kind="review"]');
  await expect(item).toHaveCount(1);
  await item.click();
  const card = page.getByTestId('review-card');
  await expect(card).toHaveAttribute('data-mode', 'branch');
  await expect(page.getByTestId('inbox-title')).toHaveText('1 file changed (+1 −0)');
  await expect(card.getByTestId('review-repo')).toContainText('web-front');
  await expect(card.getByTestId('review-repo')).toContainText('⎇ PROJ-79-release-notes → main');
  await expect(card.getByTestId('review-file')).toHaveText(['notes/release.md']);
  await expect(card.getByTestId('review-tests')).toHaveText('Tests not reported');
  await expect(card.getByTestId('review-action')).toHaveText(['Merge', 'Open PR', 'Send back', 'Discard', 'Dismiss']);
  await page.screenshot({ path: path.join(SHOTS, 'review-card-desktop.png') });

  // Merge is refused while the agent's file is uncommitted; the reason shows on the card.
  await card.locator('[data-action="merge"]').click();
  await expect(card.getByTestId('review-error')).toContainText('uncommitted changes in the worktree');

  // The file committed (as the agent would), the card follows; Merge merges into main locally.
  await world.git(worktree, 'add', '-A');
  await world.git(worktree, 'commit', '-q', '-m', 'Release notes');
  await page.reload();
  await page.locator('[data-testid="inbox-item"][data-kind="review"]').click();
  await expect(page.getByTestId('review-commits')).toContainText('Release notes', { timeout: 15_000 });
  await page.getByTestId('review-card').locator('[data-action="merge"]').click();
  await expect(page.getByTestId('review-card')).toHaveAttribute('data-state', 'cleanup');
  expect(await world.git(world.web, 'show', 'main:notes/release.md')).toBe('written by fake-claude');
  await expect(page.locator('[data-testid="inbox-item"][data-kind="review"]')).toContainText('Clean up');

  // Clean up asks first, then removes the worktree and its branch.
  await page.getByTestId('review-card').locator('[data-action="cleanup"]').click();
  await expect(page.getByTestId('review-cleanup-form')).toContainText('Clean up removes');
  await page.getByTestId('review-cleanup-confirm').click();
  await expect(page.locator('[data-testid="inbox-item"][data-kind="review"]')).toHaveCount(0);
  expect(await world.git(world.web, 'branch', '--list', 'PROJ-79-release-notes')).toBe('');
  const [resolved] = await reviewsOf(page, id);
  expect(resolved).toMatchObject({ state: 'resolved', outcome: 'merged' });
});

test('a session working in place: the header badge on a phone, Commit with the drafted message', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${server.baseUrl}/inbox`);
  const id = await startSession(page, {
    name: 'review-in-place',
    title: 'Tidy the mobile notes',
    task: '[fake:write mobile/docs/notes.md]',
    solutions: ['mobile'],
    worktrees: false,
  });
  await expect.poll(async () => (await reviewsOf(page, id)).length, { timeout: 30_000 }).toBe(1);
  const [review] = await reviewsOf(page, id);
  expect(review).toMatchObject({ mode: 'folder', actions: ['commit', 'send-back', 'discard', 'dismiss'] });

  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${server.baseUrl}/sessions/${id}`);
  const badge = page.getByTestId('session-review-badge');
  await expect(badge).toHaveText('Review');
  await badge.click();
  const card = page.getByTestId('session-review-panel').getByTestId('review-card');
  await expect(card).toHaveAttribute('data-mode', 'folder');
  await expect(card.getByTestId('review-file')).toHaveText(['docs/notes.md']);
  await page.screenshot({ path: path.join(SHOTS, 'review-card-phone.png') });

  // Commit: the message is drafted from the agent's summary and editable.
  await page.setViewportSize({ width: 1440, height: 900 });
  // The desktop header is another layout: its badge opens the card again.
  if ((await page.getByTestId('session-review-panel').count()) === 0) await page.getByTestId('session-review-badge').click();
  await card.locator('[data-action="commit"]').click();
  const message = card.getByTestId('review-commit-message');
  await expect(message).not.toHaveValue('');
  await message.fill('Add the mobile notes\n\nWritten by the session.');
  await page.screenshot({ path: path.join(SHOTS, 'review-commit-dialog.png') });
  await card.getByTestId('review-commit-confirm').click();
  await expect(page.getByTestId('session-review-badge')).toHaveCount(0);
  expect(await world.git(world.mobile, 'log', '-1', '--format=%B')).toBe('Add the mobile notes\n\nWritten by the session.');
  expect(await world.git(world.mobile, 'status', '--porcelain')).toBe('');
  const [resolved] = await reviewsOf(page, id);
  expect(resolved).toMatchObject({ state: 'resolved', outcome: 'committed' });
});
