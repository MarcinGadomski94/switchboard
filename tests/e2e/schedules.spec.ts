import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { InboxItem, Schedule, Session } from '../../src/core/api.ts';
import { nextRuns, parseCron } from '../../src/core/cron.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { formatRunTime } from '../../src/web/modals/schedule-form.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * M7.1 oracle (E2E): schedules on the real code path (no demo seed, D13):
 * `node src/server/main.ts` with fake-claude as the CLI, fake gh, a temp data
 * folder and a fixture workspace (git repos `microfrontends/web-front`, `mobile`;
 * read-only `deprecated/microfrontends/old-front`). No schedule exists at first
 * (gap #6).
 * 1. "+ New scheduled run" opens the New-session modal with section 7 · Schedule
 *    (cron field, readable preview, next 3 runs) and "Save schedule" (D8); saving
 *    shows the row; Run now starts a real session that ends ok (strip, last line,
 *    the session in the sidebar); Pause / Resume; Edit reopens the form prefilled
 *    and saves the change.
 * 2. A failing run: the row turns red live (`/hub` scheduleRun), the sidebar's
 *    "1 failed" badge, the "Scheduled run failed" Inbox item (M3.3).
 * 3. The real cron timer: a `* * * * *` schedule fires within a minute.
 */

let tmp: string;
let workspace: string;
let server: ServerProcess;
let gitEnv: Record<string, string>;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...gitEnv } });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
}

async function makeRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'init');
}

async function api<T>(page: Page, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const response = await fetch(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
    },
    { method, url, body },
  );
}

function row(page: Page, name: string): Locator {
  return page.locator(`[data-testid="schedule-row"][data-schedule="${name}"]`);
}

function chip(modal: Locator, solution: string): Locator {
  return modal.locator(`[data-testid="ns-chip"][data-solution="${solution}"]`);
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-schedules'));
  workspace = path.join(tmp, 'work space');
  const gitConfig = path.join(tmp, 'gitconfig');
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
  await makeRepo(path.join(workspace, 'microfrontends', 'web-front'));
  await makeRepo(path.join(workspace, 'mobile'));
  await makeRepo(path.join(workspace, 'deprecated', 'microfrontends', 'old-front'));
  server = await startServer({
    ...gitEnv,
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_WORKSPACE_ROOT: workspace,
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    FAKE_GH_PRS: path.join(tmp, 'fake-gh-prs.json'),
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  if (tmp) await removeTempDir(tmp);
});

test('New scheduled run → Save schedule → the row; Run now → a real session → ok; Pause / Resume; Edit prefilled', async ({ page }) => {
  await page.goto(`${server.baseUrl}/schedules`);
  const view = page.getByTestId('view-schedules');
  await expect(view.locator('.sb-sch-title')).toHaveText('Schedules & loops');
  await expect(view.locator('.sb-sch-sub')).toHaveText('scheduled Claude Code runs + long-running loops');
  await expect(view.locator('.sb-sch-row--head > span')).toHaveText(['', 'Run', 'Schedule', 'Last 14 runs', 'Next', '']);
  // No default schedules (gap #6).
  await expect(page.getByTestId('schedule-row')).toHaveCount(0);
  await expect(page.getByTestId('schedule-empty')).toBeVisible();

  // D8: the New-session modal with a 7th section.
  await page.getByTestId('schedule-new').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute('data-schedule', 'new');
  await expect(modal.getByTestId('ns-title')).toHaveText('New scheduled run');
  await expect(modal.getByTestId('ns-group').first()).toBeVisible();
  await expect(modal.locator('.sb-ns-form .sb-ns-label').last()).toHaveText('7 · Schedule');
  await expect(modal.getByTestId('ns-start')).toHaveCount(0);
  const save = modal.getByTestId('ns-save-schedule');
  await expect(save).toHaveText('Save schedule');
  await expect(save).toBeDisabled();
  await expect(modal.getByTestId('ns-cron')).toHaveAttribute('placeholder', '0 2 * * *');
  await expect(modal.getByTestId('ns-cron-preview')).toHaveAttribute('data-state', 'empty');

  await modal.getByTestId('ns-name').fill('nightly-check');
  await modal.getByTestId('ns-task').fill('Check the build and report.');
  await chip(modal, 'mobile').click();
  // An invalid expression: explained, Save stays disabled.
  await modal.getByTestId('ns-cron').fill('0 25 * * *');
  await expect(modal.getByTestId('ns-cron-preview')).toHaveAttribute('data-state', 'invalid');
  await expect(modal.getByTestId('ns-cron-preview')).toContainText('not a valid hour');
  await expect(modal.getByTestId('ns-summary-line').filter({ hasText: '⚠ enter a valid cron expression' })).toHaveCount(1);
  await expect(save).toBeDisabled();
  // A valid one: the readable preview and the next 3 runs (local time).
  await modal.getByTestId('ns-cron').fill('0 2 * * *');
  await expect(modal.getByTestId('ns-cron-preview')).toHaveText('02:00 daily');
  const parsed = parseCron('0 2 * * *');
  if (!parsed.ok) throw new Error(parsed.error);
  await expect(modal.getByTestId('ns-cron-run')).toHaveText(nextRuns(parsed.cron, new Date(), 3).map(formatRunTime));
  await expect(modal.getByTestId('ns-summary-line').filter({ hasText: 'schedule  02:00 daily' })).toHaveCount(1);
  await expect(modal.getByTestId('ns-summary-line').filter({ hasText: /^\.\.\/mobile-wt-nightly-check-\d{4}-0200$/ })).toHaveCount(1);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(modal).toHaveCount(0);

  // The row: prototype layout, the readable cron, an empty strip, no runs, the next run.
  const nightly = row(page, 'nightly-check');
  await expect(nightly).toBeVisible();
  await expect(page.getByTestId('schedule-empty')).toHaveCount(0);
  await expect(nightly.getByTestId('schedule-desc')).toHaveText('Check the build and report.');
  await expect(nightly.getByTestId('schedule-cron')).toHaveText('02:00 daily');
  await expect(nightly.getByTestId('schedule-cron')).toHaveAttribute('title', '0 2 * * *');
  await expect(nightly.getByTestId('schedule-cell')).toHaveCount(14);
  await expect(nightly.getByTestId('schedule-cell').last()).toHaveAttribute('data-tone', 'none');
  await expect(nightly.getByTestId('schedule-last')).toHaveText('No runs yet');
  await expect(nightly.getByTestId('schedule-next')).toHaveText(/^in (\d+h)?( ?\d+m)?$/);
  await expect(nightly.getByTestId('schedule-dot')).toHaveAttribute('data-tone', 'idle');
  await expect(nightly.getByTestId('schedule-run')).toHaveText('Run now');
  await expect(nightly.getByTestId('schedule-pause')).toHaveText('Pause');
  const stored = (await api<Schedule[]>(page, 'GET', '/api/schedules')).body;
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ name: 'nightly-check', cron: '0 2 * * *', paused: false, runs: [] });
  expect(stored[0]?.template).toMatchObject({ name: 'nightly-check', task: 'Check the build and report.', solutions: ['mobile'], workType: 'feature', mode: 'single', phase: 'ui-first', worktrees: true });

  // Run now: a real session (fake-claude) with its own worktree; the run ends ok.
  await nightly.getByTestId('schedule-run').click();
  await expect(nightly.getByTestId('schedule-last')).toHaveText('OK · OK', { timeout: 15_000 });
  await expect(nightly.getByTestId('schedule-cell').last()).toHaveAttribute('data-tone', 'done');
  await expect(nightly.getByTestId('schedule-dot')).toHaveAttribute('data-tone', 'done');
  await expect(nightly.getByTestId('schedule-run')).toHaveText('Run now');
  const sessions = (await api<Session[]>(page, 'GET', '/api/sessions')).body;
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.name).toMatch(/^nightly-check-\d{4}-\d{4}$/);
  expect(sessions[0]?.status).toBe('done');
  await expect(page.getByTestId('sidebar-sessions').locator('a')).toHaveCount(1);
  const runs = (await api<Schedule[]>(page, 'GET', '/api/schedules')).body[0]?.runs ?? [];
  expect(runs.map((r) => [r.result, r.triggeredBy, r.sessionId])).toEqual([['ok', 'manual', sessions[0]?.id]]);

  // Pause / Resume.
  await nightly.getByTestId('schedule-pause').click();
  await expect(nightly.getByTestId('schedule-pause')).toHaveText('Resume');
  await expect(nightly.getByTestId('schedule-next')).toHaveText('paused');
  await expect(nightly.getByTestId('schedule-dot')).toHaveAttribute('data-tone', 'idle');
  await nightly.getByTestId('schedule-pause').click();
  await expect(nightly.getByTestId('schedule-pause')).toHaveText('Pause');
  await expect(nightly.getByTestId('schedule-next')).toHaveText(/^in /);

  // Edit: the same modal, prefilled from the stored template and cron.
  await nightly.getByTestId('schedule-edit').click();
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId('ns-title')).toHaveText('Edit scheduled run');
  await expect(modal).toHaveAttribute('data-schedule', stored[0]!.id);
  await expect(modal.getByTestId('ns-name')).toHaveValue('nightly-check');
  await expect(modal.getByTestId('ns-task')).toHaveValue('Check the build and report.');
  await expect(modal.getByTestId('ns-cron')).toHaveValue('0 2 * * *');
  await expect(chip(modal, 'mobile')).toHaveAttribute('data-selected', 'true');
  await expect(modal.getByTestId('ns-switch-worktrees')).toHaveAttribute('data-on', 'true');
  await expect(modal.getByTestId('ns-save-schedule')).toBeEnabled();
  await modal.getByTestId('ns-cron').fill('30 8 * * 1-5');
  await expect(modal.getByTestId('ns-cron-preview')).toHaveText('08:30 weekdays');
  await modal.getByTestId('ns-task').fill('Morning digest of the build.');
  await modal.getByTestId('ns-save-schedule').click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('schedule-row')).toHaveCount(1);
  await expect(nightly.getByTestId('schedule-cron')).toHaveText('08:30 weekdays');
  await expect(nightly.getByTestId('schedule-desc')).toHaveText('Morning digest of the build.');
  await expect(nightly.getByTestId('schedule-last')).toHaveText('OK · OK');

  // The server stays the authority: a read-only solution or a second schedule with the same name is refused (422).
  const refused = await api<{ errors: Array<{ field: string }> }>(page, 'POST', '/api/schedules', {
    cron: '0 3 * * *',
    template: { name: 'nightly-check', task: 'x', workType: 'feature', mode: 'single', solutions: ['deprecated/microfrontends/old-front'], phase: 'ui-first', coordination: null, qa: null, worktrees: false, ultracode: false },
  });
  expect(refused.status).toBe(422);
  expect(refused.body.errors.map((e) => e.field)).toEqual(['template.solutions']);
  const duplicate = await api<{ errors: Array<{ field: string; message: string }> }>(page, 'POST', '/api/schedules', {
    cron: '0 3 * * *',
    template: { name: 'nightly-check', task: 'x', workType: 'feature', mode: 'single', solutions: ['mobile'], phase: 'ui-first', coordination: null, qa: null, worktrees: false, ultracode: false },
  });
  expect(duplicate.body.errors).toEqual([{ field: 'template.name', message: 'a schedule named "nightly-check" already exists' }]);
});

test('a failing run turns the row red live, badges the sidebar and raises "Scheduled run failed"', async ({ page }) => {
  await page.goto(`${server.baseUrl}/schedules`);
  const created = await api<Schedule>(page, 'POST', '/api/schedules', {
    cron: '0 4 * * 1',
    template: { name: 'crashing-build', task: '[fake:crash] Build everything.', workType: 'feature', mode: 'single', solutions: ['mobile'], phase: 'ui-first', coordination: null, qa: null, worktrees: false, ultracode: false },
  });
  expect(created.status).toBe(201);
  await page.reload();
  const crashing = row(page, 'crashing-build');
  await expect(crashing.getByTestId('schedule-cron')).toHaveText('Mon 04:00');
  await crashing.getByTestId('schedule-run').click();
  // Live through /hub scheduleRun (no reload).
  await expect(crashing.getByTestId('schedule-last')).toHaveText(/^Failed just now · claude/, { timeout: 15_000 });
  await expect(crashing.getByTestId('schedule-dot')).toHaveAttribute('data-tone', 'fail');
  await expect(crashing.getByTestId('schedule-cell').last()).toHaveAttribute('data-tone', 'fail');
  await expect(page.getByTestId('nav-schedules').locator('.sb-badge')).toHaveText('1 failed');

  const inbox = (await api<InboxItem[]>(page, 'GET', '/api/inbox')).body;
  const item = inbox.find((i) => i.kind === 'system' && i.source === 'crashing-build');
  expect(item).toMatchObject({ label: 'Scheduled run failed', status: 'fail' });
  await page.getByTestId('nav-inbox').click();
  await expect(page.getByTestId('inbox-item').filter({ hasText: 'crashing-build' })).toHaveCount(1);
});

test('the cron timer fires a * * * * * schedule within a minute (real clock)', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${server.baseUrl}/schedules`);
  const created = await api<Schedule>(page, 'POST', '/api/schedules', {
    cron: '* * * * *',
    template: { name: 'every-minute', task: 'Say OK.', workType: 'feature', mode: 'single', solutions: ['mobile'], phase: 'ui-first', coordination: null, qa: null, worktrees: false, ultracode: false },
  });
  expect(created.status).toBe(201);
  expect(created.body.nextRunAt).not.toBeNull();
  await page.reload();
  const minute = row(page, 'every-minute');
  await expect(minute.getByTestId('schedule-cron')).toHaveText('every minute');
  await expect(minute.getByTestId('schedule-last')).toHaveText('OK · OK', { timeout: 75_000 });
  const schedule = (await api<Schedule[]>(page, 'GET', '/api/schedules')).body.find((s) => s.name === 'every-minute');
  expect(schedule?.runs[0]).toMatchObject({ triggeredBy: 'cron', result: 'ok' });
  expect(new Date(schedule!.runs[0]!.ts).getSeconds()).toBe(0);
  // Stop it before it fires again.
  await minute.getByTestId('schedule-pause').click();
  await expect(minute.getByTestId('schedule-next')).toHaveText('paused');
});
