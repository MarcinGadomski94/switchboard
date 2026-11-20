import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D180 · the agent view's side panel on the real path (fake-claude, a temp workspace with a git
 * repo): Files as one view (Touched by this agent, the tree's signals, the filter), the reader
 * (info line, View changes, back / forward, the breadcrumb), the list popover at 560 px and the
 * docked list at 820 px (⟷), and For review from the To review strip's Open changes.
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-side-panel', { env: { ...V2_SERVER_ENV } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
  // Room for the 820 px panel beside the chat.
  await page.setViewportSize({ width: 1440, height: 900 });
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as SessionDetail, id);
}

async function settled(page: Page, id: string): Promise<void> {
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 20_000 }).toMatch(/^(done|idle)$/);
}

async function post(page: Page, id: string, text: string): Promise<void> {
  const status = await page.evaluate(
    async ({ sessionId, body }) => (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: body }) })).status,
    { sessionId: id, body: text },
  );
  expect(status).toBe(202);
}

/** An agent that wrote two files, one turn each (`notes<suffix>.txt`, `plan<suffix>.md`: the tests share one workspace). */
async function writer(page: Page, name: string, suffix = ''): Promise<string> {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, name, 'Say hello.');
  await settled(page, id);
  await post(page, id, `[fake:write microfrontends/acme-web-front/notes${suffix}.txt] Write the notes.`);
  await settled(page, id);
  await post(page, id, `[fake:write microfrontends/acme-web-front/plan${suffix}.md] Write the plan.`);
  await settled(page, id);
  return id;
}

test('Files: Touched by this agent, the reader with its info line, back / forward, the breadcrumb opening the list as a popover (560 px), then docked (820 px); View changes', async ({ page }) => {
  test.setTimeout(120_000);
  const id = await writer(page, 'files-panel');
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  const side = page.getByTestId('v2-agent-side');
  await side.getByTestId('v2-agent-side-tabs').getByRole('tab', { name: 'Files' }).click();

  // Touched by this agent: newest first, what it did and when.
  const touched = side.getByTestId('v2-files-touched');
  await expect(touched).toContainText('Touched by this agent · 2');
  const rows = touched.getByTestId('v2-files-row');
  await expect(rows.first()).toContainText('plan.md');
  await expect(rows.first()).toHaveAttribute('data-what', 'wrote');
  await expect(rows.first()).toContainText(/wrote \d/);
  // The filter filters it.
  await side.getByTestId('v2-files-filter').fill('notes');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('notes.txt');
  await side.getByTestId('v2-files-filter').fill('');

  // Narrow (560 px): a file fills the panel; the info line says what the agent did, with its change.
  await rows.filter({ hasText: 'notes.txt' }).click();
  const reader = side.getByTestId('v2-file-viewer');
  await expect(reader).toBeVisible();
  await expect(side.getByTestId('v2-side-files-split')).toHaveAttribute('data-mode', 'content');
  await expect(reader.getByTestId('v2-file-info')).toContainText('Written by the agent');
  await expect(reader.getByTestId('v2-file-view-changes')).toBeVisible();
  await expect(reader.getByTestId('v2-file-added').first()).toBeVisible();
  // Back / forward through the files opened here.
  await expect(reader.getByTestId('v2-file-back')).toBeDisabled();
  await reader.getByTestId('v2-side-files-list-button').click();
  await expect(side.getByTestId('v2-side-files-split')).toHaveAttribute('data-mode', 'popover');
  await side.getByTestId('v2-files-touched').getByTestId('v2-files-row').filter({ hasText: 'plan.md' }).click();
  await expect(side.getByTestId('v2-side-files-split')).toHaveAttribute('data-mode', 'content');
  await expect(reader.getByTestId('v2-file-crumbs')).toContainText('plan.md');
  await reader.getByTestId('v2-file-back').click();
  await expect(reader.getByTestId('v2-file-crumbs')).toContainText('notes.txt');
  await reader.getByTestId('v2-file-forward').click();
  await expect(reader.getByTestId('v2-file-crumbs')).toContainText('plan.md');

  // The breadcrumb: a folder opens the list (a popover here), unfolded down to it, with the file's signal.
  await reader.getByTestId('v2-file-crumb').last().click();
  await expect(side.getByTestId('v2-side-files-split')).toHaveAttribute('data-mode', 'popover');
  const treeRow = side.getByTestId('v2-files-tree').locator('[data-testid="v2-tree-file"]').filter({ hasText: 'plan.md' });
  await expect(treeRow).toBeVisible({ timeout: 10_000 });
  await expect(treeRow.getByTestId('v2-file-signal')).toHaveText('new');
  // Esc closes the popover; a second Esc goes back to the list (narrow).
  await page.keyboard.press('Escape');
  await expect(side.getByTestId('v2-side-files-split')).toHaveAttribute('data-mode', 'content');
  await page.keyboard.press('Escape');
  await expect(side.getByTestId('v2-side-files-split')).toHaveAttribute('data-mode', 'list');

  // ⟷: 820 px, the list docked on the right and the file beside it; nothing opened shows the file touched last.
  await page.getByTestId('v2-agent-side-width').click();
  await expect(side.getByTestId('v2-side-files-split')).toHaveAttribute('data-mode', 'docked');
  await expect(reader.getByTestId('v2-file-crumbs')).toContainText('plan.md');
  // The list button hides and shows the docked list.
  await reader.getByTestId('v2-side-files-list-button').click();
  await expect(side.getByTestId('v2-side-files-split')).toHaveAttribute('data-mode', 'content');
  await reader.getByTestId('v2-side-files-list-button').click();
  await expect(side.getByTestId('v2-side-files-split')).toHaveAttribute('data-mode', 'docked');

  // View changes: Changes on that file.
  await reader.getByTestId('v2-file-view-changes').click();
  await expect(side).toHaveAttribute('data-side-tab', 'changes');
  await expect(side.getByTestId('v2-side-diff-path')).toContainText('plan.md');
  // Back to 560 px for the next test (the width is remembered per browser).
  await page.getByTestId('v2-agent-side-width').click();
});

test('For review from the To review strip: Changes in the panel on For review; clicking the tab again goes back to its list', async ({ page }) => {
  test.setTimeout(120_000);
  const id = await writer(page, 'review-panel', '-2');
  await expect.poll(async () => (await detail(page, id)).review ?? null, { timeout: 20_000 }).not.toBeNull();
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  const side = page.getByTestId('v2-agent-side');
  // Another view first, so Open changes has something to switch back from.
  await side.getByTestId('v2-agent-side-tabs').getByRole('tab', { name: 'Files' }).click();
  await page.getByTestId('v2-agent-review-changes').click();
  await expect(side).toHaveAttribute('data-side-tab', 'changes');
  const changes = side.getByTestId('v2-side-changes');
  await expect(changes).toHaveAttribute('data-scope', 'review');
  await expect(changes.getByTestId('v2-side-changes-reviewed')).toBeVisible();
  // D166: the second message reviewed the first turn: For review holds what the last turn wrote.
  await expect(changes.getByTestId('v2-side-change-file')).toHaveCount(1, { timeout: 15_000 });
  await expect(changes.getByTestId('v2-side-change-file')).toContainText('plan-2.md');
  // Narrow: a file fills the panel; the Changes tab clicked again goes back to the list.
  await changes.getByTestId('v2-side-change-file').first().click();
  await expect(changes.getByTestId('v2-side-diff')).toBeVisible();
  await side.getByTestId('v2-agent-side-tabs').getByRole('tab', { name: /Changes/ }).click();
  await expect(changes.getByTestId('v2-side-changes-split')).toHaveAttribute('data-mode', 'list');
  // Mark reviewed: the review goes on the server, but the list stays (2026-11-20: it never disappears while shown), said so.
  await changes.getByTestId('v2-side-changes-reviewed').click();
  await expect(changes.getByTestId('v2-side-changes-reviewed')).toHaveCount(0, { timeout: 10_000 });
  await expect(changes.getByTestId('v2-side-changes-reviewed-note')).toBeVisible({ timeout: 10_000 });
  await expect(changes).toHaveAttribute('data-scope', 'review');
  await expect(changes.getByTestId('v2-side-change-file')).toHaveCount(1);
  await expect(changes.getByTestId('v2-side-change-file')).toContainText('plan-2.md');
  // Another view picked: the held list goes.
  await changes.getByTestId('v2-side-changes-scope').click();
  await page.getByTestId('v2-side-changes-scope-menu').getByRole('menuitem', { name: 'Since last save point' }).click();
  await expect(changes).toHaveAttribute('data-scope', 'head');
  await expect(changes.getByTestId('v2-side-changes-reviewed-note')).toHaveCount(0);
});

test('2026-11-20: a reply to the agent clears its review, and the For review list stays until another view is picked', async ({ page }) => {
  test.setTimeout(120_000);
  const id = await writer(page, 'review-reply', '-3');
  await expect.poll(async () => (await detail(page, id)).review ?? null, { timeout: 20_000 }).not.toBeNull();
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  const side = page.getByTestId('v2-agent-side');
  await page.getByTestId('v2-agent-review-changes').click();
  const changes = side.getByTestId('v2-side-changes');
  await expect(changes).toHaveAttribute('data-scope', 'review');
  await expect(changes.getByTestId('v2-side-change-file')).toContainText('plan-3.md', { timeout: 15_000 });
  // A reply (D166: it reviews the turns too): the agent works and finishes, the review is gone on the server.
  await post(page, id, 'Thanks, looks good.');
  await expect.poll(async () => (await detail(page, id)).review ?? null, { timeout: 20_000 }).toBeNull();
  await settled(page, id);
  await expect(changes.getByTestId('v2-side-changes-reviewed-note')).toBeVisible({ timeout: 10_000 });
  await expect(changes).toHaveAttribute('data-scope', 'review');
  await expect(changes.getByTestId('v2-side-change-file')).toHaveCount(1);
  await expect(changes.getByTestId('v2-side-change-file')).toContainText('plan-3.md');
  // The picker still names it, marked reviewed.
  await expect(changes.getByTestId('v2-side-changes-scope')).toContainText('For review · reviewed');
  await changes.getByTestId('v2-side-changes-scope').click();
  await page.getByTestId('v2-side-changes-scope-menu').getByRole('menuitem', { name: 'Since last save point' }).click();
  await expect(changes).toHaveAttribute('data-scope', 'head');
  await expect(changes.getByTestId('v2-side-changes-reviewed-note')).toHaveCount(0);
});
