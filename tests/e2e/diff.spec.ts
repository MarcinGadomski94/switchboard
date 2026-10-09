import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../helpers/git.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { openWithHub } from './question-world.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';

/**
 * The Diff tab (M4.5) on the real code path (D13, no demo seed) over temp git
 * repos: `node src/server/main.ts` with fake-claude as the CLI and a fake gh. A
 * session started through the API gets a worktree of `web-front` (gap #1) and
 * fake-claude writes a real file into it; the test stands in for the developer
 * and the agent with a committed change (approved) and an uncommitted one. The
 * tab lists the files (file, +/−, solution · path), shows the selected file's
 * unified diff (gap #10: vs the merge-base, committed + uncommitted + untracked)
 * with the "Not committed" note only while the file has uncommitted changes,
 * follows new writes through `/hub` without a reload, diffs an in-place session
 * against HEAD, and shows "No changes yet." for a clean one.
 *
 * D90: the tab opens on "Since last commit" (uncommitted only; in place only the
 * files the session touched), Whole branch shows the commits too, All uncommitted
 * changes in this repo shows someone else's edit; the pick is remembered per
 * session; hunks are separated by their `@@` row.
 */
const SHOTS = '/tmp/d90-shots';
let world: GitWorld;
let server: ServerProcess;

test.beforeAll(async () => {
  world = await makeGitWorld();
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

async function sessionStatus(page: Page, id: string): Promise<string> {
  return page.evaluate(async (sid) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}`);
    return ((await response.json()) as { status: string }).status;
  }, id);
}

async function sendMessage(page: Page, id: string, text: string): Promise<void> {
  const status = await page.evaluate(
    async ({ sid, body }) => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      return response.status;
    },
    { sid: id, body: text },
  );
  expect(status).toBe(202);
}

/** The color `value` computes to in this page (Chromium keeps oklch as `oklch(…)`). */
async function computed(page: Page, value: string): Promise<string> {
  return page.evaluate((v) => {
    const probe = document.createElement('div');
    probe.style.color = v;
    document.body.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, value);
}

async function style(locator: Locator, prop: string): Promise<string> {
  return locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
}

function fileRow(page: Page, name: string): Locator {
  return page.getByTestId('diff-file').filter({ has: page.locator('.sb-diff__file-name', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }) });
}

test('Diff: files per solution/branch, unified diff, "Not committed" until committed, live through /hub, in place, empty', async ({ page }) => {
  test.setTimeout(120_000);
  const ws = world.workspace;
  await page.goto(`${server.baseUrl}/inbox`);

  // A worktree session: fake-claude writes a new file into its worktree (cwd = the workspace root).
  const worktree = path.join(ws, 'microfrontends', 'web-front-wt-diff-e2e');
  const id = await startSession(page, {
    name: 'diff-e2e',
    task: '[fake:write microfrontends/web-front-wt-diff-e2e/notes/plan.md]',
    solutions: ['web-front'],
    worktrees: true,
    // D32: the worktree's branch is named after its ticket.
    branch: 'PROJ-42-diff-e2e',
  });
  await expect.poll(() => sessionStatus(page, id), { timeout: 20_000 }).toBe('done');
  // The approved change is committed on the session branch; the README edit is not.
  await world.commit(worktree, 'src/app.txt', 'one\nTWO\nthree\n', 'approved: TWO');
  await writeFile(path.join(worktree, 'README.md'), 'hello from the session\n');

  await openWithHub(page, `${server.baseUrl}/sessions/${id}/diff`);
  const tab = page.getByTestId('session-diff');
  await expect(tab).toHaveAttribute('data-session-id', id);
  await expect(tab).toHaveAttribute('data-state', 'ready');
  const rows = page.getByTestId('diff-file');
  const summary = page.getByTestId('diff-summary');

  // D90: the default view is since the last commit: the committed app.txt is not in it.
  await expect(page.getByTestId('diff-view')).toHaveAttribute('data-scope', 'head');
  await expect(rows.locator('.sb-diff__file-name')).toHaveText(['README.md', 'plan.md']);
  await expect(summary).toHaveText('Since last commit · 2 files · +2 −1');
  await expect(page.getByTestId('diff-scope-head')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('diff-scope-branch')).toHaveText('Whole branch');
  await expect(page.getByTestId('diff-scope-repo')).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, 'd90-1-worktree-since-last-commit.png') });

  // Whole branch: the behavior before D90 (vs the merge-base), remembered for this session.
  await page.getByTestId('diff-scope-branch').click();
  await expect(page.getByTestId('diff-view')).toHaveAttribute('data-scope', 'branch');
  await expect(summary).toHaveText('Whole branch vs origin/main · 3 files · +3 −2');
  await page.reload();
  await expect(page.getByTestId('diff-view')).toHaveAttribute('data-scope', 'branch');
  await expect(page.getByTestId('diff-scope-branch')).toHaveAttribute('aria-pressed', 'true');

  // The file list: file name + delta, "solution · path"; sorted by path; the first is selected.
  await expect(rows.locator('.sb-diff__file-name')).toHaveText(['README.md', 'plan.md', 'app.txt']);
  await expect(rows.locator('.sb-diff__file-delta')).toHaveText(['+1 −1', '+1', '+1 −1']);
  await expect(rows.locator('.sb-diff__file-sub')).toHaveText(['web-front · README.md', 'web-front · notes/plan.md', 'web-front · src/app.txt']);
  await expect(rows.nth(0)).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('diff-empty')).toHaveCount(0);

  // The selected file's header + unified diff; uncommitted → the note.
  const name = page.getByTestId('diff-name');
  const branch = page.getByTestId('diff-branch');
  const note = page.getByTestId('diff-note');
  const lines = page.getByTestId('diff-line');
  await expect(name).toHaveText('web-front / README.md');
  await expect(branch).toHaveText('⎇ PROJ-42-diff-e2e');
  await expect(note).toHaveText('Not committed. Commit only when you approve.');
  // D90: the hunk header is a subtle row of its own before the body.
  await expect(lines).toHaveText(['@@ -1 +1 @@', '-hello', '+hello from the session']);
  await expect(lines.nth(0)).toHaveAttribute('data-tone', 'hunk');
  await expect(lines.nth(1)).toHaveAttribute('data-tone', 'del');
  await expect(lines.nth(2)).toHaveAttribute('data-tone', 'add');
  expect(await style(lines.nth(0), 'color')).toBe(await computed(page, '#6d6c67'));
  expect(await style(lines.nth(0), 'background-color')).toBe(await computed(page, '#16171a'));

  // SPEC tokens + prototype styles.
  expect(await style(lines.nth(2), 'color')).toBe(await computed(page, 'oklch(0.82 0.1 150)'));
  expect(await style(lines.nth(2), 'background-color')).toBe(await computed(page, 'oklch(0.22 0.04 150)'));
  expect(await style(lines.nth(1), 'color')).toBe(await computed(page, 'oklch(0.76 0.13 25)'));
  expect(await style(lines.nth(1), 'background-color')).toBe(await computed(page, 'oklch(0.22 0.04 25)'));
  expect(await style(lines.nth(1), 'white-space')).toBe('pre');
  expect(await style(page.getByTestId('diff-body'), 'background-color')).toBe(await computed(page, '#0c0d0f'));
  expect(await style(page.getByTestId('diff-body'), 'font-family')).toContain('Geist Mono');
  expect(await style(note, 'color')).toBe(await computed(page, '#8d8c87'));
  expect(await style(branch, 'color')).toBe(await computed(page, 'oklch(0.78 0.1 250)'));
  expect(await style(rows.nth(0), 'background-color')).toBe(await computed(page, '#1f2024'));
  expect(await style(rows.nth(1), 'background-color')).toBe('rgba(0, 0, 0, 0)');
  expect(await style(rows.nth(0).locator('.sb-diff__file-delta'), 'color')).toBe(await computed(page, 'oklch(0.76 0.13 150)'));
  expect(await style(rows.nth(0).locator('.sb-diff__file-sub'), 'color')).toBe(await computed(page, '#6d6c67'));
  expect((await page.getByTestId('diff-files').boundingBox())?.width).toBe(300);
  const noteBox = (await note.boundingBox())!;
  const headBox = (await page.getByTestId('diff-head').boundingBox())!;
  expect(Math.abs(noteBox.x + noteBox.width - (headBox.x + headBox.width - 16))).toBeLessThanOrEqual(1);

  // The committed file (the developer approved it): in the diff (vs the merge-base), no note.
  await fileRow(page, 'app.txt').click();
  await expect(fileRow(page, 'app.txt')).toHaveAttribute('data-selected', 'true');
  await expect(rows.nth(0)).toHaveAttribute('data-selected', 'false');
  await expect(name).toHaveText('web-front / src/app.txt');
  await expect(lines).toHaveText(['@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three']);
  await expect(lines.nth(1)).toHaveAttribute('data-tone', 'ctx');
  expect(await style(lines.nth(1), 'color')).toBe(await computed(page, '#8d8c87'));
  await page.screenshot({ path: path.join(SHOTS, 'd90-2-worktree-whole-branch.png') });
  await expect(note).toHaveCount(0);

  // The agent's new file (untracked): every line added, not committed.
  await fileRow(page, 'plan.md').click();
  await expect(name).toHaveText('web-front / notes/plan.md');
  await expect(lines).toHaveText(['@@ -0,0 +1 @@', '+written by fake-claude']);
  await expect(note).toBeVisible();

  // Keyboard selection.
  await fileRow(page, 'README.md').focus();
  await page.keyboard.press('Enter');
  await expect(name).toHaveText('web-front / README.md');
  await fileRow(page, 'plan.md').click();

  // Live: the next write arrives through /hub (no reload); the selection stays on its file.
  await sendMessage(page, id, 'One more file [fake:write microfrontends/web-front-wt-diff-e2e/src/live.txt]');
  await expect(rows.locator('.sb-diff__file-name')).toHaveText(['README.md', 'plan.md', 'app.txt', 'live.txt'], { timeout: 20_000 });
  await expect(name).toHaveText('web-front / notes/plan.md');
  await fileRow(page, 'live.txt').click();
  await expect(lines).toHaveText(['@@ -0,0 +1 @@', '+written by fake-claude']);
  await expect(page.getByTestId('diff-file').filter({ hasText: 'live.txt' }).locator('.sb-diff__file-sub')).toHaveText('web-front · src/live.txt');

  // The same list over the contract route (`?scope=branch`), and ?file= narrows it.
  const listed = await page.evaluate(async (sid) => (await fetch(`/api/sessions/${sid}/diff?scope=branch`)).json(), id);
  expect((listed as Array<{ path: string; uncommitted: boolean }>).map((f) => [f.path, f.uncommitted])).toEqual([
    ['README.md', true],
    ['notes/plan.md', true],
    ['src/app.txt', false],
    ['src/live.txt', true],
  ]);
  const one = await page.evaluate(async (sid) => (await fetch(`/api/sessions/${sid}/diff?scope=branch&file=src%2Fapp.txt`)).json(), id);
  expect((one as Array<{ path: string }>).map((f) => f.path)).toEqual(['src/app.txt']);

  // The developer's main checkout was never touched.
  expect(await world.git(world.web, 'status', '--porcelain')).toBe('');
  expect(await world.git(world.web, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

  // In place (no worktree): against HEAD of the main checkout, its current branch, the note.
  // Someone else changed README.md in the same repo before the session ran (D90: not the session's).
  await writeFile(path.join(world.mobile, 'README.md'), 'edited by someone else\n');
  const inPlace = await startSession(page, {
    name: 'diff-in-place',
    task: '[fake:write mobile/docs/in-place.md]',
    solutions: ['mobile'],
    worktrees: false,
  });
  await expect.poll(() => sessionStatus(page, inPlace), { timeout: 20_000 }).toBe('done');
  await openWithHub(page, `${server.baseUrl}/sessions/${inPlace}/diff`);
  // Since last commit: only the file the session touched.
  await expect(page.getByTestId('diff-view')).toHaveAttribute('data-scope', 'head');
  await expect(rows.locator('.sb-diff__file-sub')).toHaveText(['mobile · docs/in-place.md']);
  await expect(summary).toHaveText('Since last commit · 1 file · +1');
  await expect(name).toHaveText('mobile / docs/in-place.md');
  await expect(branch).toHaveText('⎇ main');
  await expect(note).toBeVisible();
  await expect(lines).toHaveText(['@@ -0,0 +1 @@', '+written by fake-claude']);
  await expect(page.getByTestId('diff-scope-branch')).toHaveCount(0);
  await expect(page.getByTestId('diff-scope-note')).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, 'd90-3-in-place-touched-only.png') });
  // All uncommitted changes in this repo: someone else's edit too, with the note.
  await page.getByTestId('diff-scope-repo').click();
  await expect(rows.locator('.sb-diff__file-sub')).toHaveText(['mobile · README.md', 'mobile · docs/in-place.md']);
  await expect(summary).toHaveText('All uncommitted changes · 2 files · +2 −1');
  await expect(page.getByTestId('diff-scope-note')).toHaveText("Includes other people's and other sessions' edits in this repo.");
  await page.screenshot({ path: path.join(SHOTS, 'd90-4-in-place-all-uncommitted.png') });
  // Each session remembers its own view: the worktree session is still on Whole branch.
  await openWithHub(page, `${server.baseUrl}/sessions/${id}/diff`);
  await expect(page.getByTestId('diff-view')).toHaveAttribute('data-scope', 'branch');
  await openWithHub(page, `${server.baseUrl}/sessions/${inPlace}/diff`);
  await expect(page.getByTestId('diff-view')).toHaveAttribute('data-scope', 'repo');
  await page.getByTestId('diff-scope-head').click();
  await expect(rows).toHaveCount(1);

  // A session without changes: the empty state of each view.
  const clean = await startSession(page, { name: 'diff-clean', task: 'Nothing to write.', solutions: ['web-front'], worktrees: true, branch: 'PROJ-43-diff-clean' });
  await expect.poll(() => sessionStatus(page, clean), { timeout: 20_000 }).toBe('done');
  await openWithHub(page, `${server.baseUrl}/sessions/${clean}/diff`);
  await expect(page.getByTestId('session-diff')).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('diff-empty-text')).toHaveText('No uncommitted changes since the last commit.');
  await expect(page.getByTestId('diff-empty-hint')).toHaveCount(0);
  await expect(summary).toHaveText('Since last commit');
  await expect(rows).toHaveCount(0);
  await expect(lines).toHaveCount(0);
  expect(await style(page.getByTestId('diff-empty'), 'color')).toBe(await computed(page, '#76756f'));
  await page.getByTestId('diff-scope-branch').click();
  await expect(page.getByTestId('diff-empty')).toHaveText('No changes yet.');
  // The branch gets a commit and nothing is uncommitted: the hint points at Whole branch.
  await page.getByTestId('diff-scope-head').click();
  await world.commit(path.join(ws, 'microfrontends', 'web-front-wt-diff-clean'), 'src/clean.txt', 'committed\n', 'a commit');
  await page.reload();
  await expect(page.getByTestId('diff-empty-text')).toHaveText('No uncommitted changes since the last commit.');
  await expect(page.getByTestId('diff-empty-hint')).toHaveText('The branch has commits: switch to Whole branch to see them.');
});
