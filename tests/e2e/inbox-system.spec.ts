import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ScheduleRunResult } from '../../src/core/model.ts';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';

/**
 * M3.3 oracle (E2E): system Inbox items on the real code path (no demo seed, D13):
 * `node src/server/main.ts` with fake-claude as the CLI, fake gh, a temp workspace
 * with a real git repo and a temp data folder.
 * 1. Failed scheduled runs recorded in the schedule tables (inserted before start)
 *    become "Scheduled run failed" items: Retry run starts a new run through the
 *    M7.1 scheduler (here it fails again at once and raises a new item), Dismiss
 *    closes one, Open fix session closes the other and opens the New-session modal
 *    with the prefill.
 * 2. A session started with a worktree; gh reports its PR merged → a "PR merged"
 *    item arrives live; Remove worktree is refused while the worktree holds an
 *    uncommitted file (gap #3), then removes the folder and keeps the branch.
 */

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Inserts a schedule and its runs (oldest first, one hour apart, the last one ended 10 minutes ago) into the data folder's database. */
async function insertSchedule(
  dataDir: string,
  name: string,
  template: unknown,
  results: readonly ScheduleRunResult[],
  lastSummary: string | null,
): Promise<void> {
  const store = await openStore(storeFile(dataDir));
  try {
    const schedule = await store.schedules.create({ name, description: '', cron: '0 2 * * *', template });
    const end = Date.now() - 10 * 60_000;
    for (const [index, result] of results.entries()) {
      const finished = end - (results.length - 1 - index) * 3_600_000;
      await store.schedules.addRun({
        scheduleId: schedule.id,
        ts: new Date(finished - 5 * 60_000).toISOString(),
        finishedAt: new Date(finished).toISOString(),
        result,
        summary: index === results.length - 1 ? lastSummary : 'OK',
        triggeredBy: 'cron',
      });
    }
  } finally {
    await store.close();
  }
}

test.describe('failed scheduled runs', () => {
  let tmp: string;
  let server: ServerProcess;

  test.beforeAll(async () => {
    tmp = await makeTempDir('e2e-system-runs');
    const workspace = path.join(tmp, 'work space');
    const dataDir = path.join(tmp, 'data');
    await mkdir(workspace, { recursive: true });
    await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
    const ok: ScheduleRunResult[] = Array.from({ length: 13 }, () => 'ok');
    await insertSchedule(
      dataDir,
      'nightly-build-verify',
      { name: 'nightly-build-verify', task: 'Build and verify.', workType: 'feature', mode: 'single', solutions: ['mobile'], phase: 'ui-first', coordination: 'none', worktrees: false, ultracode: false },
      [...ok, 'fail'],
      'Android build failed at XamlC',
    );
    await insertSchedule(dataDir, 'dependency-audit', { task: 'Audit dependencies.' }, ['ok', 'fail'], null);
    // D14: the workspace is a saved folder (the default) in the server's database.
    await seedFolderInDataDir(dataDir, workspace);
    server = await startServer({
      SWITCHBOARD_DATA_DIR: dataDir,
      SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
      SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    });
  });

  test.afterAll(async () => {
    if (server) expect(await server.stop()).toBe(0);
    await removeTempDir(tmp);
  });

  test('the items, Retry run (M7.1: a new run, which fails again here), Dismiss, Open fix session → the New-session modal with the prefill', async ({ page }) => {
    await page.goto(`${server.baseUrl}/inbox`);
    const cards = page.getByTestId('inbox-item');
    await expect(cards).toHaveCount(2);
    await expect(page.getByTestId('inbox-count')).toHaveText('2 waiting on you');
    await expect(page.getByTestId('nav-inbox').locator('.sb-badge')).toHaveText('2');
    // Oldest first (the order the runs ended; nightly-build-verify's was inserted first).
    await expect(cards.locator('.sb-inbox__card-source')).toHaveText(['nightly-build-verify', 'dependency-audit']);
    await expect(cards.locator('.sb-inbox__card-title')).toHaveText(['Android build failed at XamlC', 'dependency-audit failed']);
    await expect(cards.locator('.sb-inbox__card-kind')).toHaveText(['Scheduled run failed', 'Scheduled run failed']);
    await expect(cards.locator('.sb-inbox__card-age')).toHaveText(['10m', '10m']);
    await expect(cards.nth(0).locator('.sb-inbox__dot')).toHaveAttribute('style', /var\(--status-fail\)/);

    // The nightly one (selected first): meta (no session link), title, the green streak, the prototype's actions.
    await expect(cards.nth(0)).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('inbox-meta')).toHaveText('nightly-build-verify·Scheduled run failed·10m');
    await expect(page.getByTestId('inbox-open-session')).toHaveCount(0);
    await expect(page.getByTestId('inbox-title')).toHaveText('Android build failed at XamlC');
    await expect(page.getByTestId('inbox-text')).toHaveText('The previous 13 runs were green.');
    const actions = page.getByTestId('inbox-action');
    await expect(actions).toHaveText(['Open fix session', 'Retry run', 'Dismiss']);
    await expect(actions.nth(0)).toHaveAttribute('data-primary', 'true');
    await expect(actions.nth(0)).toHaveCSS('background-color', 'rgb(232, 231, 227)');
    await expect(actions.nth(1)).toHaveCSS('border-top-color', 'rgb(44, 45, 50)');

    // Retry run goes through the scheduler (M7.1): dependency-audit's stored template cannot start a session
    // (it has only a task), so the retried run fails at once and raises a new item for the new run.
    await cards.nth(1).click();
    await expect(page.getByTestId('inbox-title')).toHaveText('dependency-audit failed');
    await expect(page.getByTestId('inbox-text')).toHaveText('The previous run was green.');
    await page.getByTestId('inbox-action').filter({ hasText: 'Retry run' }).click();
    await expect(cards.locator('.sb-inbox__card-title')).toHaveText(['Android build failed at XamlC', /^Not started: /]);
    await expect(cards.locator('.sb-inbox__card-age')).toHaveText(['10m', 'now']);
    await expect(page.getByTestId('inbox-error')).toHaveCount(0);

    // Dismiss the new one (no green streak: the run before it failed).
    await cards.nth(1).click();
    await expect(page.getByTestId('inbox-title')).toHaveText(/^Not started: .*choose at least one solution/);
    await expect(page.getByTestId('inbox-text')).toHaveCount(0);
    await page.getByTestId('inbox-action').filter({ hasText: 'Dismiss' }).click();
    await expect(cards).toHaveCount(1);
    await expect(page.getByTestId('inbox-count')).toHaveText('1 waiting on you');
    await expect(page.getByTestId('inbox-title')).toHaveText('Android build failed at XamlC');
    await expect(page.getByTestId('modal-new-session')).toHaveCount(0);

    // Open fix session: the item closes and the New-session modal opens with the prefill (form: M5.1).
    await page.getByTestId('inbox-action').filter({ hasText: 'Open fix session' }).click();
    const modal = page.getByTestId('modal-new-session');
    await expect(modal).toBeVisible();
    const prefill = JSON.parse((await modal.getAttribute('data-prefill')) ?? 'null') as unknown;
    expect(prefill).toEqual({
      name: 'fix-nightly-build-verify',
      task: 'nightly-build-verify: Android build failed at XamlC.',
      workType: 'feature',
      mode: 'single',
      solutions: ['mobile'],
      phase: 'ui-first',
      coordination: 'none',
      worktrees: false,
      ultracode: false,
    });
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId('inbox-zero')).toBeVisible();
    await expect(page.getByTestId('nav-inbox').locator('.sb-badge')).toHaveText('');

    // "+ New session" still opens the modal without a prefill.
    await page.getByTestId('new-session').click();
    await expect(modal).toBeVisible();
    expect(await modal.getAttribute('data-prefill')).toBeNull();

    // Closed items stay closed after a reload (the service does not raise them again).
    await page.reload();
    await expect(page.getByTestId('inbox-zero')).toBeVisible();
  });
});

test.describe('PR merged → worktree removable', () => {
  let tmp: string;
  let server: ServerProcess | undefined;

  test.afterAll(async () => {
    if (server) expect(await server.stop()).toBe(0);
    await removeTempDir(tmp);
  });

  test('a session worktree whose PR gh reports merged arrives live; Remove worktree is refused while uncommitted, then removes the folder and keeps the branch', async ({ page }) => {
    test.setTimeout(120_000);
    tmp = await realpath(await makeTempDir('e2e-system-wt'));
    const workspace = path.join(tmp, 'work space');
    const repo = path.join(workspace, 'microfrontends', 'web-front');
    const bare = path.join(tmp, 'remotes', 'web-front.git');
    const gitConfig = path.join(tmp, 'gitconfig');
    const prsFile = path.join(tmp, 'fake-gh-prs.json');
    await mkdir(repo, { recursive: true });
    await mkdir(bare, { recursive: true });
    await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
    await writeFile(gitConfig, '');
    await writeFile(prsFile, '{}');
    const gitEnv: Record<string, string> = {
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Switchboard Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Switchboard Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    const git = async (cwd: string, ...args: string[]): Promise<string> => {
      const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...gitEnv } });
      if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
      return result.stdout.trim();
    };
    await git(repo, 'init', '-q', '-b', 'main');
    await writeFile(path.join(repo, 'README.md'), 'hello\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'init');
    await git(bare, 'init', '-q', '--bare', '-b', 'main');
    await git(repo, 'remote', 'add', 'origin', bare);
    await git(repo, 'push', '-q', '-u', 'origin', 'main');

    // D14: the workspace is a saved folder (the default) in the server's database.
    await seedFolderInDataDir(path.join(tmp, 'data'), workspace);
    server = await startServer({
      ...gitEnv,
      SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
      SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
      SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
      FAKE_GH_PRS: prsFile,
    });
    await page.goto(`${server.baseUrl}/inbox`);
    await expect(page.getByTestId('inbox-zero')).toBeVisible();

    // A real session with a worktree (gap #1; D32: on its ticket branch): PROJ-231-speaking-page at ../web-front-wt-speaking-page.
    const started = await page.evaluate(async () => {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'speaking-page',
          task: 'Build the speaking page.',
          workType: 'feature',
          mode: 'single',
          solutions: ['web-front'],
          phase: 'ui-first',
          coordination: 'none',
          qa: null,
          worktrees: true,
          ultracode: false,
          branch: 'PROJ-231-speaking-page',
        }),
      });
      return { status: response.status, body: (await response.json()) as { id: string } };
    });
    expect(started.status).toBe(201);
    const worktree = path.join(workspace, 'microfrontends', 'web-front-wt-speaking-page');
    expect(await exists(worktree)).toBe(true);
    expect(await git(repo, 'branch', '--list', 'PROJ-231-speaking-page')).not.toBe('');

    // gh now reports the PR merged; the manager's check (15 s after start) flags the worktree removable → the item arrives live.
    await writeFile(prsFile, JSON.stringify({ 'PROJ-231-speaking-page': { number: 231, state: 'MERGED', url: 'https://github.com/acme/web-front/pull/231' } }));
    const cards = page.getByTestId('inbox-item');
    await expect(cards).toHaveCount(1, { timeout: 60_000 });
    await expect(cards.locator('.sb-inbox__card-source')).toHaveText('worktrees');
    await expect(cards.locator('.sb-inbox__card-kind')).toHaveText('PR merged');
    await expect(page.getByTestId('inbox-title')).toHaveText('PR #231 merged, so the worktree can be removed');
    await expect(page.getByTestId('inbox-meta')).toHaveText('worktrees·PR merged·now');
    await expect(page.getByTestId('inbox-text')).toHaveText(
      `${path.join('..', 'web-front-wt-speaking-page')} · branch PROJ-231-speaking-page was merged on GitHub (checked through gh). No uncommitted changes.`,
    );
    await expect(page.getByTestId('inbox-branch')).toHaveText(['web-front⎇ PROJ-231-speaking-page']);
    const actions = page.getByTestId('inbox-action');
    await expect(actions).toHaveText(['Remove worktree', 'Keep']);
    await expect(actions.nth(0)).toHaveAttribute('data-primary', 'true');

    // Gap #3: an uncommitted file → refused, nothing removed, the item stays.
    await writeFile(path.join(worktree, 'leftover.txt'), 'not committed\n');
    await actions.filter({ hasText: 'Remove worktree' }).click();
    await expect(page.getByTestId('inbox-error')).toHaveText(`Not sent: ${worktree} has 1 uncommitted change`);
    await expect(cards).toHaveCount(1);
    expect(await exists(worktree)).toBe(true);

    // Clean again → removed; the branch is kept.
    await rm(path.join(worktree, 'leftover.txt'));
    await actions.filter({ hasText: 'Remove worktree' }).click();
    await expect(page.getByTestId('inbox-zero')).toBeVisible();
    await expect(cards).toHaveCount(0);
    await expect.poll(() => exists(worktree)).toBe(false);
    expect(await git(repo, 'branch', '--list', 'PROJ-231-speaking-page')).not.toBe('');
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain('web-front-wt-speaking-page');
  });
});
