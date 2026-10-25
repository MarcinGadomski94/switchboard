import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · the v2 Tasks page (`/tasks`, lane A) on the real path (fake-claude, fake-gh):
 * quick add into an agent (with Undo), Start here (the start message reaches the agent,
 * the card leaves Open), Move to Done, the detail dialog, delete with Undo, Run in its
 * own agent (a new agent), Import from Jira or GitHub (GitHub through fake-gh), and the
 * phone layout (390 × 844: one column at a time, 44 px targets).
 */
let world: QuestionWorld;
let tmp: string;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-v2-tasks-issues');
  const issues = path.join(tmp, 'issues.json');
  await writeFile(
    issues,
    JSON.stringify({
      'acme/web-front': [
        { number: 21, title: 'Checkout button overlaps the footer', body: 'On 360 px the button sits on the footer.', url: 'https://github.com/acme/web-front/issues/21', labels: [{ name: 'bug' }], assignees: [], state: 'OPEN' },
        { number: 22, title: 'Add dark mode', body: '', url: 'https://github.com/acme/web-front/issues/22', labels: [{ name: 'feature' }], assignees: [], state: 'OPEN' },
      ],
    }),
  );
  world = await startQuestionWorld('e2e-v2-tasks', { env: { ...V2_SERVER_ENV, FAKE_GH_ISSUES: issues } });
});

test.afterAll(async () => {
  await world?.stop();
  if (tmp) await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

interface TodoWire {
  readonly id: string;
  readonly title: string;
  readonly state: string;
}

async function todosOf(page: Page, sessionId: string): Promise<readonly TodoWire[]> {
  return page.evaluate(async (id) => ((await (await fetch(`/api/sessions/${id}/todos`)).json()) as { todos: TodoWire[] }).todos, sessionId);
}

async function quickAdd(page: Page, text: string): Promise<void> {
  const field = page.getByTestId('v2-tasks-quick');
  await field.fill(text);
  await field.press('Enter');
  await expect(field).toHaveValue('');
}

function card(page: Page, title: string) {
  return page.getByTestId('v2-tasks-card').filter({ has: page.getByTestId('v2-tasks-title').getByText(title, { exact: true }) });
}

test('the board: quick add with Undo, Start here, Move to Done, details, delete with Undo, Run in its own agent', async ({ page }) => {
  test.setTimeout(120_000);
  await openWithHub(page, `${world.baseUrl}/tasks`);
  await expect(page.getByTestId('v2-page-tasks')).toBeVisible();
  await expect(page.getByTestId('v2-tasks-empty')).toBeVisible();
  await expect(page.getByTestId('v2-tasks-noagent')).toBeVisible();
  await expect(page.getByTestId('v2-tasks-quick')).toBeDisabled();

  const { id } = await world.startSession(page, 'tasker', 'Reply with just OK.');
  // The agent appears live as the quick add's target.
  await expect(page.getByTestId('v2-tasks-quick')).toBeEnabled();
  await expect(page.getByTestId('v2-tasks-target')).toHaveValue(id);

  // Quick add ("task …" works too), then Undo removes it again.
  await quickAdd(page, 'task Throwaway PROJ-123 note');
  await expect(card(page, 'Throwaway PROJ-123 note')).toHaveCount(1);
  const added = page.getByTestId('v2-toast').filter({ hasText: 'Task added to tasker' });
  await expect(added).toBeVisible();
  await added.getByTestId('v2-toast-undo').click();
  await expect(card(page, 'Throwaway PROJ-123 note')).toHaveCount(0);
  await expect.poll(async () => (await todosOf(page, id)).length).toBe(0);

  await quickAdd(page, 'Empty-cart state');
  await quickAdd(page, 'Docs cleanup');
  await quickAdd(page, 'Update the PROJ-123 copy');
  const open = page.getByTestId('v2-tasks-col-open');
  await expect(open.getByTestId('v2-tasks-card')).toHaveCount(3);
  await expect(open.getByTestId('v2-tasks-count')).toHaveText('3');
  await expect(card(page, 'Docs cleanup').getByTestId('v2-tasks-priority')).toHaveText('Medium');
  await expect(card(page, 'Docs cleanup').getByTestId('v2-tasks-agent')).toHaveText('tasker');
  await expect(card(page, 'Docs cleanup').getByTestId('v2-tasks-agent')).toHaveAttribute('href', `/agents/${id}`);

  // Start here: the start message goes to the agent and the card leaves Open (In progress, then Review once the agent stops).
  await card(page, 'Empty-cart state').getByTestId('v2-tasks-start').click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: '“Empty-cart state”' })).toBeVisible();
  await expect(open.getByTestId('v2-tasks-card')).toHaveCount(2);
  await expect(card(page, 'Empty-cart state')).toHaveAttribute('data-column', /^(progress|review)$/);
  await expect.poll(async () => (await todosOf(page, id)).find((todo) => todo.title === 'Empty-cart state')?.state).toBe('in_progress');
  await expect
    .poll(async () => JSON.stringify(await page.evaluate(async (sid) => (await (await fetch(`/api/sessions/${sid}/events`)).json()) as unknown, id)), { timeout: 15_000 })
    .toContain('Empty-cart state');
  // Its agent finished the reply: Review.
  await expect(card(page, 'Empty-cart state')).toHaveAttribute('data-column', 'review', { timeout: 20_000 });

  // ⋯ → Move to Done. The agent may start filling in the captured tasks (D81) right after
  // its reply, which moves the card back to In progress and re-renders it: retry the menu.
  await expect(async () => {
    if ((await page.getByRole('menuitem', { name: 'Move to Done' }).count()) === 0) await card(page, 'Empty-cart state').getByTestId('v2-tasks-menu').click({ timeout: 2_000 });
    await page.getByRole('menuitem', { name: 'Move to Done' }).click({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  const done = page.getByTestId('v2-tasks-col-done');
  await expect(done.getByTestId('v2-tasks-card')).toHaveCount(1);
  await expect(card(page, 'Empty-cart state').getByTestId('v2-tasks-estimate')).toContainText('took');
  await expect(card(page, 'Empty-cart state').getByTestId('v2-tasks-start')).toHaveCount(0);

  // Details: the description and the handover plan.
  await card(page, 'Docs cleanup').getByTestId('v2-tasks-title').click();
  const detail = page.getByTestId('v2-tasks-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('v2-tasks-plan')).toContainText('No handover plan.');
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);

  // Delete with Undo, then for real (sent after the Undo window).
  await card(page, 'Docs cleanup').getByTestId('v2-tasks-menu').click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(card(page, 'Docs cleanup')).toHaveCount(0);
  await page.getByTestId('v2-toast').filter({ hasText: 'Deleted “Docs cleanup”' }).getByTestId('v2-toast-undo').click();
  await expect(card(page, 'Docs cleanup')).toHaveCount(1);
  await card(page, 'Docs cleanup').getByTestId('v2-tasks-menu').click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(card(page, 'Docs cleanup')).toHaveCount(0);
  expect((await todosOf(page, id)).some((todo) => todo.title === 'Docs cleanup')).toBe(true);
  await expect.poll(async () => (await todosOf(page, id)).some((todo) => todo.title === 'Docs cleanup'), { timeout: 15_000 }).toBe(false);
  await expect(card(page, 'Docs cleanup')).toHaveCount(0);

  // Run in its own agent: a new agent works on it, the toast offers Open.
  const before = await page.evaluate(async () => ((await (await fetch('/api/sessions')).json()) as unknown[]).length);
  await card(page, 'Update the PROJ-123 copy').getByTestId('v2-tasks-run').click();
  const ran = page.getByTestId('v2-toast').filter({ hasText: 'Started a new agent for “Update the PROJ-123 copy”' });
  await expect(ran).toBeVisible();
  await expect(open.getByTestId('v2-tasks-card')).toHaveCount(0);
  await expect.poll(async () => page.evaluate(async () => ((await (await fetch('/api/sessions')).json()) as unknown[]).length)).toBe(before + 1);
  await ran.getByTestId('v2-toast-undo').click();
  await expect(page).toHaveURL(/\/agents\/[^/]+$/);
});

test('Import from Jira or GitHub: preview, tick, import into an agent', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/tasks`);
  const { id } = await world.startSession(page, 'importer', 'Reply with just OK.');
  await expect(page.getByTestId('v2-tasks-quick')).toBeEnabled();
  await page.getByTestId('v2-tasks-import-open').click();
  const dialog = page.getByTestId('v2-tasks-import');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('v2-tasks-import-agent').selectOption(id);
  // Jira is not connected here: it says so and cannot preview.
  await expect(dialog.getByTestId('v2-tasks-import-jira')).toBeDisabled();
  await expect(dialog.getByTestId('v2-tasks-import-preview')).toBeDisabled();
  await dialog.getByTestId('v2-tasks-import-source').getByRole('button', { name: 'GitHub' }).click();
  await dialog.getByTestId('v2-tasks-import-repo').fill('acme/web-front');
  await dialog.getByTestId('v2-tasks-import-preview').click();
  const rows = dialog.getByTestId('v2-tasks-import-issue');
  await expect(rows).toHaveCount(2);
  await expect(dialog.getByTestId('v2-tasks-import-go')).toHaveText('Import 2 tasks');
  await dialog.getByTestId('v2-tasks-import-check').and(page.locator('[data-key$="#22"]')).uncheck();
  await expect(dialog.getByTestId('v2-tasks-import-go')).toHaveText('Import 1 task');
  await dialog.getByTestId('v2-tasks-import-go').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Imported 1 task from GitHub into importer' })).toBeVisible();
  await expect(page.getByTestId('v2-tasks-col-open').getByTestId('v2-tasks-title').filter({ hasText: 'Checkout button overlaps the footer' })).toHaveCount(1);

  // Again: #21 shows imported and cannot be ticked.
  await page.getByTestId('v2-tasks-import-open').click();
  await dialog.getByTestId('v2-tasks-import-agent').selectOption(id);
  await dialog.getByTestId('v2-tasks-import-source').getByRole('button', { name: 'GitHub' }).click();
  await dialog.getByTestId('v2-tasks-import-repo').fill('acme/web-front');
  await dialog.getByTestId('v2-tasks-import-preview').click();
  await expect(dialog.getByTestId('v2-tasks-import-check').and(page.locator('[data-key$="#21"]'))).toBeDisabled();
  await dialog.getByTestId('v2-tasks-import-cancel').click();
  await expect(dialog).toHaveCount(0);
});

test('phone (390 × 844): one column at a time with the switcher, 44 px targets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/tasks`);
  const { id } = await world.startSession(page, 'phoner', 'Reply with just OK.');
  await page.getByTestId('v2-tasks-target').selectOption(id);
  await quickAdd(page, 'Phone task');
  const switcher = page.getByTestId('v2-tasks-switch');
  await expect(switcher).toBeVisible();
  await expect(page.getByTestId('v2-tasks-col-open')).toBeVisible();
  await expect(page.getByTestId('v2-tasks-col-done')).toBeHidden();
  const start = card(page, 'Phone task').getByTestId('v2-tasks-start');
  await expect(start).toBeVisible();
  expect((await start.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect((await card(page, 'Phone task').getByTestId('v2-tasks-menu').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  // No horizontal scroll on the page.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await switcher.getByRole('button', { name: /Done/ }).click();
  await expect(page.getByTestId('v2-tasks-col-done')).toBeVisible();
  await expect(page.getByTestId('v2-tasks-col-open')).toBeHidden();
});
