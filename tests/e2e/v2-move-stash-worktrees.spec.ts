import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import { makeTempDir } from '../helpers/net.ts';
import type { PeerNode } from '../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, settle, startWorkspaceSession, takeoverWorld } from '../helpers/takeover.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV, useV2 } from './v2-world.ts';

/**
 * D153 · a complete move in v2 (two real Switchboards, fake claude, temp repos, local bare
 * remotes): the agent's three worktrees of one repo show as one repo with them nested (the
 * pushed, unmerged one carried; the unpushed one and the merged one skipped with their
 * reasons, a warning for the unpushed one's uncommitted file); the target checkout's
 * uncommitted changes are listed and block the move until **Stash them on <PC>** is ticked;
 * then the move stashes them there, succeeds and says how to restore the kept stash.
 */

let tmp: string;
let world: TakeoverWorld | null = null;
let contexts: BrowserContext[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-v2-move-stash');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  world = null;
  await removeWorld(tmp);
});

async function v2Page(browser: Browser, node: PeerNode, route: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  contexts.push(context);
  const page = await context.newPage();
  await stubToolProbes(page);
  await useV2(page);
  await page.goto(`${node.baseUrl}${route}`);
  return page;
}

test('one repo with its worktrees nested and skipped ones explained; the target changes stashed after confirming', async ({ browser }) => {
  test.setTimeout(180_000);
  const w = (world = await takeoverWorld(tmp, { aRepos: { workspace: true }, bRepos: { workspace: true }, env: { ...V2_SERVER_ENV } }));
  const front = await realpath(w.paths.a.front);
  const onMac = w.paths.b.front;
  // Three worktrees of front on the pc, where Claude Code makes them.
  await writeFile(path.join(front, '.git', 'info', 'exclude'), '.claude/\n');
  await mkdir(path.join(front, '.claude', 'worktrees'), { recursive: true });
  const wt = (name: string): string => path.join(front, '.claude', 'worktrees', name);
  await w.git(front, 'worktree', 'add', '-q', '-b', 'feat/live', wt('live'));
  await writeFile(path.join(wt('live'), 'live.txt'), 'pushed work\n');
  await w.git(wt('live'), 'add', 'live.txt');
  await w.git(wt('live'), 'commit', '-q', '-m', 'live work');
  await w.git(wt('live'), 'push', '-q', '-u', 'origin', 'feat/live');
  await w.git(front, 'worktree', 'add', '-q', '-b', 'feat/local', wt('local'));
  await writeFile(path.join(wt('local'), 'draft.txt'), 'never pushed\n');
  await w.git(front, 'worktree', 'add', '-q', '-b', 'feat/done', wt('done'));
  await w.git(wt('done'), 'push', '-q', '-u', 'origin', 'feat/done');
  // The mac's checkout has work of its own.
  await writeFile(path.join(onMac, 'tracked.txt'), 'one\ntwo\nchanged on the mac\n');
  await writeFile(path.join(onMac, 'scratch.txt'), 'the mac has its own work\n');

  const session = await startWorkspaceSession(w.a, w.folders.a.workspace as string, 'ws-worktrees', ['front']);
  for (const file of [path.join(wt('live'), 'live.txt'), path.join(wt('local'), 'draft.txt'), path.join(wt('done'), 'README.md')]) {
    const sent = await w.a.call('POST', `/api/sessions/${session.id}/messages`, { text: `Look. [fake:tool Read ${JSON.stringify({ file_path: file })}]` });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    await settle(w.a, session.id);
  }

  const page = await v2Page(browser, w.a, `/agents/${session.id}`);
  // The side panel: one repo, its worktrees nested under it.
  const worksIn = page.getByTestId('v2-agent-works-in');
  await expect(worksIn.locator('[data-testid="v2-agent-works-in-group"][data-name="front"]')).toHaveAttribute('data-worktrees', '3', { timeout: 20_000 });
  await expect(worksIn).toContainText('Works in · front');
  await expect(worksIn.locator('[data-testid="v2-agent-works-in-repo"]')).toHaveCount(1);

  await page.getByTestId('v2-agent-menu').click();
  await page.getByTestId('v2-agent-menu-list').getByRole('menuitem', { name: 'Move to computer…' }).click();
  const dialog = page.getByTestId('v2-move-dialog');
  await expect(dialog.getByTestId('v2-move-works-in')).toContainText(`front (${front}; read; 1 worktree carried; 2 skipped)`, { timeout: 30_000 });

  // Repos to carry: one entry for front, the live worktree nested and ticked, the other two skipped with their reasons.
  const group = dialog.locator('[data-testid="v2-move-carry-group"][data-name="front"]');
  await expect(dialog.locator('[data-testid="v2-move-carry-group"]')).toHaveCount(1);
  await expect(group).toHaveAttribute('data-worktrees', '1');
  await expect(group).toHaveAttribute('data-skipped', '2');
  await expect(group.locator('[data-testid="v2-move-carry-worktree"][data-name="live"]')).toHaveAttribute('data-carried', 'true');
  const local = group.locator('[data-testid="v2-move-carry-skipped"][data-name="local"]');
  await expect(local).toHaveAttribute('data-reason', 'no-remote-branch');
  await expect(local).toContainText('not carried, no remote branch');
  await expect(local.getByTestId('v2-move-carry-skipped-warning')).toHaveText(/Its 1 uncommitted file stays on pc-office\./);
  const done = group.locator('[data-testid="v2-move-carry-skipped"][data-name="done"]');
  await expect(done).toHaveAttribute('data-reason', 'merged');
  await expect(done).toContainText('not carried, merged into origin/main');
  await expect(done.getByTestId('v2-move-carry-skipped-warning')).toHaveCount(0);

  // The mac's front has uncommitted changes: listed, and the move waits for the stash to be confirmed.
  const move = dialog.getByTestId('v2-move-start');
  const stash = dialog.locator('[data-testid="v2-move-stash-row"]');
  await expect(stash).toHaveCount(1);
  await expect(stash).toHaveAttribute('data-path', onMac);
  await expect(stash).toContainText('has 2 uncommitted files on mac-laptop');
  await expect(stash.getByTestId('v2-move-stash-files')).toContainText('scratch.txt');
  await expect(stash.getByTestId('v2-move-stash-files')).toContainText('tracked.txt');
  await expect(dialog.getByTestId('v2-move-reason')).toContainText('has uncommitted changes on the target');
  await expect(move).toBeDisabled();
  await stash.getByTestId('v2-move-stash-confirm').check();
  await expect(stash).toHaveAttribute('data-confirmed', 'true');
  await expect(move).toBeEnabled({ timeout: 30_000 });
  await expect(dialog.locator('[data-testid="v2-move-repo"]').first().getByTestId('v2-move-repo-summary')).toContainText('stash 2 uncommitted files there on mac-laptop first');
  await move.click();
  await expect(dialog.getByTestId('v2-move-headline')).toContainText('Moved', { timeout: 90_000 });
  await expect(dialog.getByTestId('v2-move-stash-note')).toContainText(`Stashed 2 uncommitted files in ${onMac} on mac-laptop as "switchboard: before moving ws-worktrees from pc-office (`);
  await expect(dialog.getByTestId('v2-move-stash-note')).toContainText('git stash list');
  // The stash stays on the mac; the live worktree is there at its place, the skipped ones are not.
  expect(await w.git(onMac, 'stash', 'list')).toContain('switchboard: before moving ws-worktrees from pc-office');
  expect(await w.git(path.join(onMac, '.claude', 'worktrees', 'live'), 'branch', '--show-current')).toBe('feat/live');
  expect(await w.git(onMac, 'worktree', 'list', '--porcelain')).not.toContain('feat/local');
  await w.git(onMac, 'stash', 'drop', '-q');
});
