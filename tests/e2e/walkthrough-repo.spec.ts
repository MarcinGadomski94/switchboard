import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { Folder, HistoryItem, Session } from '../../src/core/api.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D14 walkthrough for a **repo folder** on the real path (no demo seed), next to
 * the workspace walkthrough (`walkthrough.spec.ts`): `node src/server/main.ts`
 * with fake-claude, fake gh and one standalone git repo in a temp folder, nothing
 * saved at the start. Driven through the UI:
 *
 * Settings → Folders → Add… the repo (the first folder: the default) → New
 * session: the repo form (Task, Worktree, Ultracode) → the session runs in the
 * repo's worktree and the chat streams the agent's Write → Diff shows the
 * worktree change (not the main checkout's) → Pause / Resume resumes in the
 * worktree → Continue in terminal shows the command and the worktree to run it
 * in → History lists the session.
 */

const NAME = 'repo-walk';

let tmp: string;
let repo: string;
let server: ServerProcess;
let gitEnv: Record<string, string>;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...gitEnv } });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
  return result.stdout.trim();
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function sessionByName(page: Page, name: string): Promise<Session | undefined> {
  const sessions = await page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as Session[]);
  return sessions.find((session) => session.name === name);
}

/** The cwd and argv of every fake-claude process started for a session. */
async function fakeRuns(): Promise<Array<{ cwd: string; resume: boolean }>> {
  const text = await readFile(path.join(tmp, 'fake.log'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind?: string; cwd?: string; argv?: string[] })
    .filter((entry) => entry.kind === 'argv' && (entry.argv?.includes('--session-id') || entry.argv?.includes('--resume')))
    .map((entry) => ({ cwd: entry.cwd ?? '', resume: entry.argv?.includes('--resume') ?? false }));
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-walk-repo'));
  repo = path.join(tmp, 'app-repo');
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
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'README.md'), 'hello\n');
  // A repo may carry its own AGENTS.md: it stays a repo (D14).
  await writeFile(path.join(repo, 'AGENTS.md'), '# AGENTS.md (app-repo)\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'init');
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  await writeFile(path.join(tmp, 'fake-gh-prs.json'), '{}');
  server = await startServer({
    ...gitEnv,
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    FAKE_GH_PRS: path.join(tmp, 'fake-gh-prs.json'),
    FAKE_CLAUDE_LOG: path.join(tmp, 'fake.log'),
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  if (tmp) await removeTempDir(tmp);
});

test('a repo-folder session on the real path: add the repo → start in its worktree → chat → Diff → pause/resume → handoff → history', async ({ page }) => {
  test.setTimeout(120_000);
  await stubToolProbes(page);

  // 1. Settings → Folders: nothing saved; Add… the repo, the first folder (the default).
  await page.goto(`${server.baseUrl}/settings/folders`);
  await expect(page.getByTestId('settings-folders-empty')).toHaveText('No folder is saved yet. Add a workspace or a git repository.');
  await page.getByTestId('settings-folder-add').click();
  await page.getByTestId('settings-folder-add-input').fill(repo);
  await expect(page.getByTestId('settings-folder-add-line')).toHaveText('✓ git repo · single solution');
  await page.getByTestId('settings-folder-add-add').click();
  const row = page.getByTestId('settings-folder');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('settings-folder-kind')).toHaveText('git repo');
  await expect(row.getByTestId('settings-folder-default')).toHaveText('default');

  // 2. New session: the repo form.
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal.getByTestId('ns-folder').locator('option')).toHaveText(['app-repo (default)']);
  await expect(modal.getByTestId('ns-section')).toHaveCount(3);
  await expect(modal.getByTestId('ns-chip')).toHaveText(['✓ app-repo']);
  await modal.getByTestId('ns-name').fill(NAME);
  await modal.getByTestId('ns-task').fill('Write the notes. [fake:write notes.md]');
  const worktree = path.join(tmp, `app-repo-wt-${NAME}`);
  await expect(modal.getByTestId('ns-summary-line').nth(2)).toHaveText(`cwd       ${worktree}`);
  await modal.getByTestId('ns-start').click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('session-name')).toHaveText(NAME);
  await expect(page.getByTestId('session-root')).toHaveText(`${worktree} · worktree of app-repo`);
  const folder = (await page.evaluate(async () => (await (await fetch('/api/folders')).json()) as Folder[]))[0];
  expect(await sessionByName(page, NAME)).toMatchObject({ folder: folder?.id, folderKind: 'repo', folderPath: repo, cwd: worktree, solutions: ['app-repo'], worktrees: true });

  // 3. The chat: the task as typed (the worktree note is hidden like the answers block), then the agent's Write.
  await expect(page.getByTestId('chat-message').first()).toHaveText('Write the notes. [fake:write notes.md]');
  await expect(page.getByTestId('chat-step').filter({ hasText: 'notes.md' }).first()).toBeVisible();
  await expect.poll(async () => (await sessionByName(page, NAME))?.status, { timeout: 15_000 }).toBe('done');
  // The agent wrote into its worktree; the main checkout is untouched.
  expect(await readFile(path.join(worktree, 'notes.md'), 'utf8')).toBe('written by fake-claude\n');
  expect(await exists(path.join(repo, 'notes.md'))).toBe(false);
  // The right panel: the one agent works in the repo (its name, not "workspace root").
  await expect(page.getByTestId('agent-path').first()).toHaveText('app-repo');

  // 4. The Diff tab shows the worktree change, not committed.
  await page.getByTestId('session-tab-diff').click();
  const notes = page.getByTestId('diff-file').filter({ hasText: 'notes.md' });
  await expect(notes).toHaveCount(1);
  await notes.click();
  await expect(page.getByTestId('diff-note')).toHaveText('Not committed. Commit only when you approve.');
  await expect(page.getByTestId('diff-branch')).toContainText(`session/${NAME}`);
  await expect(page.getByTestId('diff-line').filter({ hasText: 'written by fake-claude' })).toHaveCount(1);

  // 5. Pause / Resume: the process comes back in the worktree (the session's stored cwd).
  await page.getByTestId('session-tab-chat').click();
  const pause = page.getByTestId('session-pause');
  await expect(pause).toHaveText('Pause');
  await pause.click();
  await expect(pause).toHaveText('Resume');
  await pause.click();
  await expect(pause).toHaveText('Pause');
  await expect.poll(async () => (await fakeRuns()).some((run) => run.resume)).toBe(true);
  expect((await fakeRuns()).map((run) => run.cwd)).toEqual((await fakeRuns()).map(() => worktree));
  await expect.poll(async () => (await sessionByName(page, NAME))?.status, { timeout: 15_000 }).toMatch(/^(done|run)$/);

  // 6. Continue in terminal: the command, and the worktree to run it in.
  const session = await sessionByName(page, NAME);
  await page.getByTestId('session-handoff').click();
  await expect(page.getByTestId('session-handoff')).toHaveText('⇄ Attach here');
  await expect(page.getByTestId('handoff-command')).toHaveText(`claude --resume ${session?.claudeSessionId}`);
  await expect(page.getByTestId('handoff-cwd')).toHaveText(`cwd ${worktree}`);

  // 7. History lists it (the default folder's session: no folder tag).
  await page.getByTestId('nav-history').click();
  const history = page.getByTestId('history-row').filter({ hasText: NAME });
  await expect(history).toHaveCount(1);
  await expect(history.getByTestId('folder-tag')).toHaveCount(0);
  const items = await page.evaluate(async () => (await (await fetch('/api/history')).json()) as HistoryItem[]);
  expect(items.find((item) => item.name === NAME)).toMatchObject({ folder: folder?.id, folderPath: repo });
});
