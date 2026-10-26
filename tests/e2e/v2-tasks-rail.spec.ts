import { type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.0 · Tasks in the v2 rail (`docs/design/v2-decisions.md` → *Tasks in the
 * rail*): the rail's Tasks item between Results and Settings, its badge counting the
 * tasks not done yet across every agent (live from `todosChanged`), opening the board,
 * fitting the tablet and short desktop rails, and staying in the phone's More.
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-tasks-rail', { env: V2_SERVER_ENV });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function addTodo(page: Page, sessionId: string, title: string): Promise<string> {
  return page.evaluate(
    async ({ id, title }) => {
      const response = await fetch(`/api/sessions/${id}/todos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, text: title }) });
      const list = (await response.json()) as { todos: { id: string; title: string }[] };
      return list.todos.find((todo) => todo.title === title)?.id ?? '';
    },
    { id: sessionId, title },
  );
}

async function setState(page: Page, sessionId: string, todoId: string, state: string): Promise<void> {
  await page.evaluate(
    async ({ id, todoId, state }) => {
      await fetch(`/api/sessions/${id}/todos/${todoId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state }) });
    },
    { id: sessionId, todoId, state },
  );
}

test('the rail shows Tasks with the count of unfinished tasks across agents, live, and opens the board', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWithHub(page, `${world.baseUrl}/`);
  const rail = page.getByTestId('v2-rail');
  await expect(rail.locator('.v2-nav-item .v2-nav-label')).toHaveText(['Home', 'Agents', 'Projects', 'Crews', 'Results', 'Tasks', 'Settings']);
  // No tasks yet: no badge.
  await expect(page.getByTestId('v2-nav-tasks')).toHaveAttribute('aria-label', 'Tasks');
  await expect(page.getByTestId('v2-nav-badge-tasks')).toHaveCount(0);

  const a = await world.startSession(page, 'alpha', 'Reply with just OK.');
  const b = await world.startSession(page, 'beta', 'Reply with just OK.');
  const a1 = await addTodo(page, a.id, 'Alpha one');
  await addTodo(page, a.id, 'Alpha two');
  const b1 = await addTodo(page, b.id, 'Beta one');
  const b2 = await addTodo(page, b.id, 'Beta two');
  await expect(page.getByTestId('v2-nav-badge-tasks')).toHaveText('4');

  // In progress still counts; done does not (live, from todosChanged).
  await setState(page, a.id, a1, 'in_progress');
  await setState(page, b.id, b1, 'done');
  await expect(page.getByTestId('v2-nav-badge-tasks')).toHaveText('3');
  await expect(page.getByTestId('v2-nav-tasks')).toHaveAttribute('aria-label', 'Tasks, 3 not done');

  // Click: the board opens, with Tasks the current rail item (no longer Agents).
  await page.getByTestId('v2-nav-tasks').click();
  await expect(page).toHaveURL(`${world.baseUrl}/tasks`);
  await expect(page.getByTestId('v2-page-tasks')).toBeVisible();
  await expect(page.getByTestId('v2-nav-tasks')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('v2-nav-agents')).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('v2-tasks-col-done').getByTestId('v2-tasks-card')).toHaveCount(1);

  // Every task done: the badge hides.
  for (const [session, todo] of [
    [a.id, a1],
    [b.id, b2],
  ] as const)
    await setState(page, session, todo, 'done');
  const rest = await page.evaluate(async (id) => ((await (await fetch(`/api/sessions/${id}/todos`)).json()) as { todos: { id: string; state: string }[] }).todos, a.id);
  for (const todo of rest) if (todo.state !== 'done') await setState(page, a.id, todo.id, 'done');
  await expect(page.getByTestId('v2-nav-badge-tasks')).toHaveCount(0);
});

test('the seven rail items fit the tablet and short desktop rails; the phone keeps Tasks in More', async ({ page }) => {
  for (const size of [
    { width: 1280, height: 720 },
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(size);
    await openWithHub(page, `${world.baseUrl}/`);
    const items = page.getByTestId('v2-rail').locator('.v2-nav-item');
    await expect(items).toHaveCount(7);
    // Settings, the last item, sits inside the window without scrolling the rail.
    const box = await page.getByTestId('v2-nav-settings').boundingBox();
    expect(box, `${size.width}×${size.height}`).not.toBeNull();
    expect(box!.y + box!.height, `${size.width}×${size.height}`).toBeLessThanOrEqual(size.height);
    expect(await page.getByTestId('v2-rail').evaluate((el) => el.scrollTop)).toBe(0);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/more`);
  await expect(page.getByTestId('v2-rail')).toHaveCount(0);
  const tasks = page.getByTestId('v2-page-more').locator('a[href="/tasks"]');
  await expect(tasks).toHaveText(/Tasks/);
  await tasks.click();
  await expect(page.getByTestId('v2-page-tasks')).toBeVisible();
});

test('⌘K opens Tasks', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWithHub(page, `${world.baseUrl}/`);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('tasks');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${world.baseUrl}/tasks`);
  await expect(page.getByTestId('v2-page-tasks')).toBeVisible();
});
