import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * D109 oracle (E2E, `docs/ci.md`): `node src/server/main.ts` with fake-claude, tools/fake-gh
 * (its PRs, run logs, merge and issue list; never GitHub) and a real git repo.
 * 1. A session works on a branch whose PR is open: the header chip reads CI running; a red
 *    check sends the failing job's log to the session (chip: CI failed); green + approved
 *    raises "PR #7 ready to merge" with Merge PR; the click merges it (gh pr merge), the item
 *    closes, the chip reads merged and D30's "PR merged" item offers the clean-up.
 * 2. Import issues…: GitHub issues previewed with checkboxes, the ticked ones become todos with a
 *    link back, and a second preview shows them imported (disabled); Jira without a connection
 *    explains where to connect it.
 */

const BRANCH = 'PROJ-7-checkout';
const PR_URL = 'https://github.com/acme/web-front/pull/7';

let tmp: string;
let server: ServerProcess | undefined;
let prsFile: string;
let logs: string;
let sessionId: string;

const gitEnv: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Switchboard Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Switchboard Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...gitEnv } });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
  return result.stdout.trim();
}

async function setPr(fields: Record<string, unknown>): Promise<void> {
  const current = JSON.parse(await readFile(prsFile, 'utf8').catch(() => '{}')) as Record<string, Record<string, unknown>>;
  const base = current[BRANCH] ?? { number: 7, state: 'OPEN', url: PR_URL, headRefName: BRANCH, baseRefName: 'main', headRefOid: 'aaaaaaa1', mergeable: 'MERGEABLE', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [] };
  await writeFile(prsFile, JSON.stringify({ [BRANCH]: { ...base, ...fields } }));
}

const check = (conclusion: string, status = 'COMPLETED') => ({ __typename: 'CheckRun', name: 'build', status, conclusion, detailsUrl: 'https://github.com/acme/web-front/actions/runs/501/job/601' });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-ci-loop'));
  const workspace = path.join(tmp, 'work space');
  const repo = path.join(workspace, 'microfrontends', 'web-front');
  const bare = path.join(tmp, 'remotes', 'web-front.git');
  const gitConfig = path.join(tmp, 'gitconfig');
  prsFile = path.join(tmp, 'fake-gh-prs.json');
  logs = path.join(tmp, 'run-logs');
  const issues = path.join(tmp, 'issues.json');
  await mkdir(repo, { recursive: true });
  await mkdir(bare, { recursive: true });
  await mkdir(logs, { recursive: true });
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  await writeFile(gitConfig, '');
  gitEnv['GIT_CONFIG_GLOBAL'] = gitConfig;
  await writeFile(prsFile, '{}');
  await writeFile(
    issues,
    JSON.stringify({
      'acme/web-front': [
        { number: 21, title: 'Checkout button overlaps the footer', body: 'On 360 px the button sits on the footer.', url: 'https://github.com/acme/web-front/issues/21', labels: [{ name: 'bug' }], assignees: [], state: 'OPEN' },
        { number: 22, title: 'Add dark mode', body: '', url: 'https://github.com/acme/web-front/issues/22', labels: [{ name: 'feature' }], assignees: [], state: 'OPEN' },
      ],
    }),
  );
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'README.md'), 'hello\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'init');
  await git(bare, 'init', '-q', '--bare', '-b', 'main');
  await git(repo, 'remote', 'add', 'origin', bare);
  await git(repo, 'push', '-q', '-u', 'origin', 'main');
  await seedFolderInDataDir(path.join(tmp, 'data'), workspace);
  // The PR is open before the session's first turn ends (the agent "opened" it): the turn's end finds it.
  await setPr({ statusCheckRollup: [check('', 'IN_PROGRESS')] });
  server = await startServer({
    ...gitEnv,
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    FAKE_GH_PRS: prsFile,
    FAKE_GH_RUN_LOGS: logs,
    FAKE_GH_ISSUES: issues,
    // Test-only: the watcher reads every 500 ms (docs/configuration.md).
    SWITCHBOARD_CI_TICK_MS: '500',
    SWITCHBOARD_CI_POLL_MS: '500',
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  await removeTempDir(tmp);
});

async function startSession(page: Page): Promise<string> {
  const started = await page.evaluate(async (branch) => {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'checkout', task: 'Build the checkout.', workType: 'feature', mode: 'single', solutions: ['web-front'], phase: 'ui-first', coordination: 'none', qa: null, worktrees: true, ultracode: false, branch }),
    });
    return { status: response.status, body: (await response.json()) as { id: string } };
  }, BRANCH);
  expect(started.status).toBe(201);
  return started.body.id;
}

test('the header chip, a red check back to the session, then Merge PR from the Inbox and the clean-up offer', async ({ page }) => {
  test.setTimeout(120_000);
  if (!server) throw new Error('no server');
  await page.goto(`${server.baseUrl}/inbox`);
  sessionId = await startSession(page);
  await page.goto(`${server.baseUrl}/sessions/${sessionId}`);
  const chip = page.getByTestId('session-ci-chip');
  await expect(chip).toHaveText('PR #7 · CI running', { timeout: 30_000 });
  await expect(chip).toHaveAttribute('data-state', 'running');
  await expect(chip).toHaveAttribute('href', PR_URL);

  // A red check: the end of its log goes to the session as a normal message.
  await writeFile(path.join(logs, '501-601.log'), 'build\tRun tests\t2026-10-14T10:00:00.0000000Z FAIL src/checkout.test.ts\nbuild\tRun tests\t2026-10-14T10:00:01.0000000Z expected 4 to be 5\n');
  await setPr({ headRefOid: 'aaaaaaa2', statusCheckRollup: [check('FAILURE')] });
  await expect(chip).toHaveText('PR #7 · CI failed', { timeout: 30_000 });
  await expect(page.getByText(/CI failed: build — on PR #7/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('expected 4 to be 5').first()).toBeVisible();

  // Green and approved: "ready to merge" in the Inbox, with Merge PR.
  await setPr({ headRefOid: 'aaaaaaa3', statusCheckRollup: [check('SUCCESS')], reviewDecision: 'APPROVED' });
  await expect(chip).toHaveText('PR #7 · ready to merge', { timeout: 30_000 });
  await page.goto(`${server.baseUrl}/inbox`);
  const ready = page.getByTestId('inbox-item').filter({ hasText: 'PR #7 ready to merge' });
  await expect(ready).toHaveCount(1, { timeout: 30_000 });
  await ready.click();
  await expect(page.getByTestId('inbox-title')).toHaveText('PR #7 ready to merge');
  const actions = page.getByTestId('inbox-action');
  await expect(actions).toHaveText(['Merge PR', 'Open PR', 'Dismiss']);
  await expect(actions.nth(0)).toHaveAttribute('data-primary', 'true');
  await expect(page.getByTestId('inbox-branch')).toHaveText([`web-front⎇ ${BRANCH}`]);

  // Merge PR: gh pr merge (the fake records the method); the item closes; D30's clean-up item follows.
  await actions.filter({ hasText: 'Merge PR' }).click();
  await expect(page.getByTestId('inbox-item').filter({ hasText: 'ready to merge' })).toHaveCount(0);
  const merged = JSON.parse(await readFile(prsFile, 'utf8')) as Record<string, Record<string, unknown>>;
  expect(merged[BRANCH]).toMatchObject({ state: 'MERGED', mergedWith: 'merge' });
  const cleanup = page.getByTestId('inbox-item').filter({ hasText: 'PR #7 merged, so the worktree can be removed' });
  await expect(cleanup).toHaveCount(1, { timeout: 30_000 });
  await cleanup.click();
  await expect(page.getByTestId('inbox-action')).toHaveText(['Remove worktree', 'Keep']);

  await page.goto(`${server.baseUrl}/sessions/${sessionId}`);
  await expect(page.getByTestId('session-ci-chip')).toHaveText('PR #7 · merged');
});

test('Import issues…: preview with checkboxes, the ticked issues become todos with a link back, never twice; Jira explains', async ({ page }) => {
  test.setTimeout(90_000);
  if (!server) throw new Error('no server');
  await page.goto(`${server.baseUrl}/todos`);
  await page.getByTestId('todos-import').click();
  const dialog = page.getByTestId('modal-import-issues');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('ii-session')).toHaveValue(sessionId);
  // The session's repository as gh names it (fake: fake/web-front) is pre-filled; this test's issues live in acme/web-front.
  await expect(dialog.getByTestId('ii-repo')).toHaveValue('fake/web-front');
  await dialog.getByTestId('ii-repo').fill('acme/web-front');
  await dialog.getByTestId('ii-preview').click();
  const rows = dialog.getByTestId('ii-issue');
  await expect(rows).toHaveCount(2);
  await expect(rows.locator('.sb-ii-title')).toHaveText(['Checkout button overlaps the footer', 'Add dark mode']);
  // Both ticked; untick #22.
  await rows.filter({ hasText: 'Add dark mode' }).getByTestId('ii-issue-check').uncheck();
  await expect(dialog.getByTestId('ii-import')).toHaveText('Import 1 issue');
  await dialog.getByTestId('ii-import').click();
  await expect(dialog).toHaveCount(0);
  const toast = page.getByTestId('toast').filter({ hasText: 'Issues imported' });
  await expect(toast).toContainText('1 issue added to the todos of');
  await toast.getByRole('button', { name: 'Close' }).click();
  const group = page.getByTestId('todos-group').filter({ hasText: 'checkout' });
  await expect(group.getByText('#21 Checkout button overlaps the footer')).toBeVisible();
  const list = await page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}/todos`)).json()) as { todos: Array<{ title: string; description: string }> }, sessionId);
  expect(list.todos.find((todo) => todo.title.startsWith('#21'))?.description).toBe('On 360 px the button sits on the footer.\n\nGitHub: https://github.com/acme/web-front/issues/21');

  // Again: #21 shows imported and cannot be ticked.
  await page.getByTestId('todos-import').click();
  await dialog.getByTestId('ii-repo').fill('acme/web-front');
  await dialog.getByTestId('ii-preview').click();
  const imported = dialog.getByTestId('ii-issue').filter({ hasText: 'Checkout button overlaps the footer' });
  await expect(imported).toHaveAttribute('data-imported', 'true');
  await expect(imported.getByTestId('ii-issue-check')).toBeDisabled();
  await expect(dialog.getByTestId('ii-import')).toHaveText('Import 1 issue');

  // Jira without a connection: the dialog says where to connect it.
  await dialog.getByTestId('ii-source-jira').click();
  await expect(dialog.getByTestId('ii-jira-note')).toContainText('Settings → Experimental');
  await expect(dialog.getByTestId('ii-preview')).toBeDisabled();
  await dialog.getByTestId('ii-cancel').click();
  await expect(dialog).toHaveCount(0);
});
