import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';
import { useV2 } from './v2-world.ts';

/**
 * D145 · the automatic clean-up of merged worktrees on the real code path: the real server
 * (fake-claude, fake gh) over a temp repo `acme-app` (a saved repo folder, `dev` checked out)
 * with a local bare "origin". The settings switch in both themes; then an agent's turn that
 * uses Claude Code's `EnterWorktree` (`[fake:tool EnterWorktree …]`) on `.claude/worktrees/x`,
 * already merged into dev: after the turn the worktree, its local branch and origin's copy are
 * gone and the v2 chat shows the divider. Screenshots go to `SWITCHBOARD_SHOTS_DIR` when set.
 */
const SHOTS = process.env['SWITCHBOARD_SHOTS_DIR'] ?? '';
let tmp: string;
let repo: string;
let bare: string;
let server: ServerProcess;
let gitEnv: Record<string, string>;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...gitEnv } });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
  return result.stdout.trim();
}

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const response = await fetch(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: (text === '' ? null : JSON.parse(text)) as T };
    },
    { method, url, body },
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-auto-clean'));
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
  repo = path.join(tmp, 'acme-app');
  bare = path.join(tmp, 'origin', 'acme-app.git');
  await mkdir(repo, { recursive: true });
  await mkdir(bare, { recursive: true });
  await git(bare, 'init', '-q', '--bare', '-b', 'main');
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'README.md'), 'hello\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'init');
  await git(repo, 'remote', 'add', 'origin', bare);
  await git(repo, 'push', '-q', '-u', 'origin', 'main');
  await git(repo, 'switch', '-q', '-c', 'dev');
  await git(repo, 'push', '-q', '-u', 'origin', 'dev');
  const prs = path.join(tmp, 'fake-gh-prs.json');
  await writeFile(prs, '{}');
  await seedFolderInDataDir(path.join(tmp, 'data'), repo, { kind: 'repo' });
  server = await startServer({
    ...gitEnv,
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    FAKE_GH_PRS: prs,
  });
});

test.afterAll(async () => {
  await server?.stop();
  if (tmp) await removeTempDir(tmp);
});

test('classic: Settings → Sessions & worktrees has the clean-up switch and its remote option', async ({ page }) => {
  await stubToolProbes(page);
  await page.goto(`${server.baseUrl}/settings/sessions`);
  const row = page.locator('[data-row="auto-clean"]');
  await expect(row).toContainText('Clean up merged worktrees automatically');
  await expect(row).toHaveAttribute('data-tour', 'setting-auto-clean');
  const toggle = row.getByRole('switch', { name: 'Clean up merged worktrees automatically' });
  const remote = page.locator('[data-row="auto-clean-remote"]').getByRole('switch', { name: 'Also delete the branch on the remote' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(remote).toHaveAttribute('aria-checked', 'true');
  await shot(page, 'auto-clean-classic-setting');
  // Off: the remote option reads off and cannot be changed.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(remote).toBeDisabled();
  await expect.poll(async () => (await api<Record<string, unknown>>(page, 'GET', '/api/settings')).body['worktrees.autoClean']).toBe(false);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await remote.click();
  await expect.poll(async () => (await api<Record<string, unknown>>(page, 'GET', '/api/settings')).body['worktrees.autoCleanRemote']).toBe(false);
  await remote.click();
  await expect.poll(async () => (await api<Record<string, unknown>>(page, 'GET', '/api/settings')).body['worktrees.autoCleanRemote']).toBe(true);
});

test.describe('v2', () => {
  test.beforeEach(async ({ page }) => {
    await useV2(page);
    await stubToolProbes(page);
  });

  test('Advanced › Agents & separate copies has the switch in v2 words', async ({ page }) => {
    await page.goto(`${server.baseUrl}/settings/advanced/sessions`);
    const row = page.locator('[data-row="auto-clean"]');
    await expect(row).toContainText('Clean up merged worktrees automatically');
    await expect(row).toContainText('separate copy of the code');
    await expect(row.getByRole('switch', { name: 'Clean up merged worktrees automatically' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-row="auto-clean-remote"]').getByRole('switch', { name: 'Also delete the branch on the remote' })).toHaveAttribute('aria-checked', 'true');
    await shot(page, 'auto-clean-v2-setting');
  });

  test("an agent's merged .claude/worktrees/x is cleaned up after its turn; the chat shows the divider", async ({ page }) => {
    await page.goto(`${server.baseUrl}/`);
    const started = await api<{ id: string }>(page, 'POST', '/api/sessions', {
      name: 'auto-clean-e2e',
      task: 'Reply OK.',
      workType: 'feature',
      mode: 'single',
      solutions: ['acme-app'],
      phase: 'ui-first',
      coordination: 'none',
      qa: null,
      worktrees: false,
      ultracode: false,
    });
    expect(started.status).toBe(201);
    const id = started.body.id;
    await expect.poll(async () => (await api<{ status: string }>(page, 'GET', `/api/sessions/${id}`)).body.status, { timeout: 20_000 }).toBe('done');
    // What Claude Code's EnterWorktree does, then the agent's work merged into dev and pushed.
    const dir = path.join(repo, '.claude', 'worktrees', 'x');
    await git(repo, 'worktree', 'add', '-q', '-b', 'worktree-x', dir);
    await writeFile(path.join(dir, 'x.txt'), 'x\n');
    await git(dir, 'add', 'x.txt');
    await git(dir, 'commit', '-q', '-m', 'x');
    await git(dir, 'push', '-q', '-u', 'origin', 'worktree-x');
    await git(repo, 'merge', '-q', '--no-ff', '-m', 'merge worktree-x', 'worktree-x');
    await git(repo, 'push', '-q', 'origin', 'dev');

    expect((await api(page, 'POST', `/api/sessions/${id}/messages`, { text: 'Work in a worktree. [fake:tool EnterWorktree {"name":"x"}]' })).status).toBe(202);
    await page.goto(`${server.baseUrl}/agents/${id}`);
    const divider = page.getByTestId('v2-agent-divider').filter({ hasText: 'Cleaned up worktree x' });
    await expect(divider).toHaveText('Cleaned up worktree x: merged into dev; removed the folder, the local branch and origin/worktree-x', { timeout: 30_000 });
    await shot(page, 'auto-clean-v2-divider');
    expect(await exists(dir)).toBe(false);
    expect(await git(repo, 'branch', '--list', 'worktree-x')).toBe('');
    expect(await git(bare, 'branch', '--list', 'worktree-x')).toBe('');
    // The record under the setting.
    await page.goto(`${server.baseUrl}/settings/advanced/sessions`);
    await expect(page.getByTestId('auto-clean-last')).toContainText('Cleaned up 1 worktree so far, the last today');
  });
});
