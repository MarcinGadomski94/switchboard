import { randomUUID } from 'node:crypto';
import { mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Store } from '../../src/server/db/store.ts';
import type { WorktreeRecord } from '../../src/server/db/repos/worktrees.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { seedFolder } from '../helpers/folders.ts';
import { type GitWorld, makeGitWorld } from '../helpers/git.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { openTempStore } from '../helpers/store.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D84 · Settings → Clean-up on the real code path: the real server over a temp
 * data folder whose database holds closed sessions and Switchboard worktrees of
 * temp git repos with a local bare remote (the developer's own branch and
 * worktree next to them). The page lists the groups, the confirmation asks for
 * the extra confirmations, the run removes exactly the ticked items and shows
 * the result. Screenshots go to `SWITCHBOARD_SHOTS_DIR` when set.
 */
const DAY = 86_400_000;
const SHOTS = process.env['SWITCHBOARD_SHOTS_DIR'] ?? '';
let tmp: string;
let world: GitWorld;
let server: ServerProcess;
let merged: WorktreeRecord;
let dirty: WorktreeRecord;
let pushed: WorktreeRecord;
let ownWorktree: string;

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function closedSession(store: Store, name: string, daysAgo: number): Promise<string> {
  const session = await store.sessions.create({ name, title: name.replace(/-/g, ' '), claudeSessionId: randomUUID(), solutions: ['web-front'], worktrees: true, root: world.workspace, rootKind: 'workspace', cwd: world.workspace });
  await store.sessions.update(session.id, { closedAt: new Date(Date.now() - daysAgo * DAY).toISOString() });
  return session.id;
}

async function worktree(name: string, sessionId: string): Promise<WorktreeRecord> {
  const m = world.manager();
  const [record] = await m.createForSession(name, ['web-front'], world.folder);
  await m.assign([record as WorktreeRecord], sessionId);
  await world.commit((record as WorktreeRecord).path, `${name}.txt`, `${name}\n`);
  return record as WorktreeRecord;
}

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-cleanup');
  const dataDir = path.join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const store = await openTempStore(dataDir);
  world = await makeGitWorld({ root: tmp, store });
  await seedFolder(store, world.workspace);
  // Merged into main, its session closed: worktree + local branch.
  merged = await worktree('free-talk', await closedSession(store, 'free-talk', 3));
  await world.git(world.web, 'merge', '-q', '--ff-only', 'session/free-talk');
  // Merged too, but with an uncommitted change: needs the extra confirmation.
  dirty = await worktree('lesson-plan', await closedSession(store, 'lesson-plan', 3));
  await world.git(world.web, 'merge', '-q', '--ff-only', 'session/lesson-plan');
  await writeFile(path.join(dirty.path, 'notes.md'), 'draft\n');
  // Pushed and merged: a remote branch (never ticked for you).
  pushed = await worktree('pricing-page', await closedSession(store, 'pricing-page', 3));
  await world.git(pushed.path, 'push', '-q', '-u', 'origin', 'session/pricing-page');
  await world.git(world.web, 'merge', '-q', '--ff-only', 'session/pricing-page');
  await world.git(world.web, 'fetch', '-q', 'origin');
  // A closed session from long ago, and an old chat export.
  await closedSession(store, 'old-onboarding-flow', 45);
  const exportDir = path.join(dataDir, 'handovers', randomUUID());
  await mkdir(exportDir, { recursive: true });
  await writeFile(path.join(exportDir, 'chat.md'), '# exported chat\n');
  const longAgo = new Date(Date.now() - 40 * DAY);
  await utimes(path.join(exportDir, 'chat.md'), longAgo, longAgo);
  await utimes(exportDir, longAgo, longAgo);
  // The developer's own: never listed.
  await world.git(world.web, 'branch', 'feature/mine');
  ownWorktree = path.join(tmp, 'own-worktree');
  await world.git(world.web, 'worktree', 'add', '-q', '-b', 'dev/own', ownWorktree);
  await store.close();
  const gitEnv = Object.fromEntries(Object.entries(world.env).filter(([key]) => key.startsWith('GIT_') && key !== 'GIT_SPY_LOG')) as Record<string, string>;
  server = await startServer({
    ...gitEnv,
    SWITCHBOARD_DATA_DIR: dataDir,
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    FAKE_GH_PRS: world.prsFile,
    FAKE_GH_LOG: world.ghLog,
  });
});

test.afterAll(async () => {
  await server?.stop();
  if (tmp) await removeTempDir(tmp);
});

test('Clean-up lists Switchboard’s leftovers, confirms, removes exactly the ticked items and reports', async ({ page }) => {
  await stubToolProbes(page);
  await page.goto(`${server.baseUrl}/settings/cleanup`);
  await expect(page.getByTestId('settings-title')).toHaveText('Clean-up');
  const group = (name: string) => page.locator(`[data-testid="cleanup-group"][data-group="${name}"]`);
  await expect(group('worktrees').getByTestId('cleanup-item')).toHaveCount(3);
  await expect(group('localBranches').getByTestId('cleanup-item')).toHaveCount(3);
  await expect(group('remoteBranches').getByTestId('cleanup-item')).toHaveCount(1);
  await expect(group('sessions').getByTestId('cleanup-item')).toHaveCount(1);
  await expect(group('data').getByTestId('cleanup-item')).toHaveCount(1);
  const text = await page.locator('[data-view="settings"]').innerText();
  for (const foreign of ['feature/mine', 'dev/own', ownWorktree]) expect(text).not.toContain(foreign);
  // Defaults: the dirty worktree and the remote branch are not ticked.
  const item = (title: string) => page.locator('[data-testid="cleanup-item"]', { has: page.locator('.sb-cleanup-item-title', { hasText: title }) }).first();
  await expect(item(dirty.path).getByTestId('cleanup-item-check')).not.toBeChecked();
  await expect(item('origin/session/pricing-page').getByTestId('cleanup-item-check')).not.toBeChecked();
  await expect(item(merged.path).getByTestId('cleanup-item-check')).toBeChecked();
  await expect(item(dirty.path).getByTestId('cleanup-warning')).toContainText('notes.md');
  // The group checkbox never ticks remote branches.
  await group('remoteBranches').getByTestId('cleanup-group-toggle').check().catch(() => undefined);
  await expect(item('origin/session/pricing-page').getByTestId('cleanup-item-check')).not.toBeChecked();
  for (const details of await page.locator('.sb-cleanup-what').all()) await details.evaluate((element) => element.setAttribute('open', ''));
  if (SHOTS) {
    // The whole section: a window as tall as Settings' scrolling column.
    const height = await page.getByTestId('settings-content').evaluate((element) => element.scrollHeight);
    await page.setViewportSize({ width: 1440, height: Math.max(900, height + 40) });
    await page.screenshot({ path: path.join(SHOTS, 'cleanup-page.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
  }

  // A merged branch goes with its worktree; the dirty worktree's branch waits for its worktree.
  await expect(item('session/free-talk').getByTestId('cleanup-item-check')).toBeChecked();
  await expect(item('session/lesson-plan').getByTestId('cleanup-item-check')).not.toBeChecked();
  // Tick the dirty worktree (and its branch) and the remote branch by hand: the worktree and the remote branch need their confirmation.
  await item(dirty.path).getByTestId('cleanup-item-check').check();
  await item('session/lesson-plan').getByTestId('cleanup-item-check').check();
  await item('origin/session/pricing-page').getByTestId('cleanup-item-check').check();
  await page.getByTestId('cleanup-start').click();
  const dialog = page.getByTestId('cleanup-dialog');
  await expect(dialog).toHaveAttribute('data-state', 'confirm');
  await expect(dialog.getByTestId('cleanup-confirm')).toHaveCount(2);
  await expect(dialog.getByTestId('cleanup-preview')).toContainText(merged.path);
  await expect(dialog.getByTestId('cleanup-confirm-go')).toBeDisabled();
  for (const check of await dialog.getByTestId('cleanup-confirm-check').all()) await check.check();
  await expect(dialog.getByTestId('cleanup-confirm-go')).toBeEnabled();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'cleanup-confirm.png') });
  await dialog.getByTestId('cleanup-confirm-go').click();
  await expect(dialog).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await expect(dialog.getByTestId('cleanup-dialog-sub')).toContainText('Removed 9');
  await expect(dialog.locator('[data-testid="cleanup-step"][data-status="failed"]')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'cleanup-result.png') });

  // Exactly what was ticked is gone; the developer's things stay.
  for (const record of [merged, dirty, pushed]) expect(await exists(record.path)).toBe(false);
  expect(await exists(ownWorktree)).toBe(true);
  const heads = (await world.git(world.web, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).split('\n').sort();
  expect(heads).toEqual(['dev/own', 'feature/mine', 'main']);
  expect(await world.git(path.join(tmp, 'remotes', 'web-front.git'), 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).toBe('main');
  await dialog.getByTestId('cleanup-done').click();
  await expect(page.getByTestId('cleanup-item')).toHaveCount(0);
});
