import { type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D147 · a task's card says how long its agent **worked** on it, with its open time beside it:
 * finished in v2 Tasks, and live while in progress in both themes (`docs/todos.md` → *Actual vs. estimate (D78, D147)*). The real path
 * (fake-claude) records a working time for an item finished after D147; the card's two
 * shapes (working + open, open time only) are then checked on an answer whose times are set
 * (a real wait of hours is not something a test can sit through).
 */
let world: QuestionWorld;
let classic: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-working-time', { env: V2_SERVER_ENV });
  classic = await startQuestionWorld('e2e-classic-working-time');
});

test.afterAll(async () => {
  await world?.stop();
  await classic?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

interface TodoWire {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly workingMs?: number | null;
  readonly actualMs?: number | null;
}

async function call(page: Page, method: string, url: string, body?: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const response = await fetch(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return (await response.json()) as unknown;
    },
    { method, url, body },
  );
}

function card(page: Page, title: string) {
  return page.getByTestId('v2-tasks-card').filter({ has: page.getByTestId('v2-todo-title').getByText(title, { exact: true }) });
}

const MIN = 60_000;

test('a finished task: took = working time, open time beside it; open time only before D147', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/tasks`);
  const { id } = await world.startSession(page, 'worker', 'Reply with just OK.');
  const add = async (title: string): Promise<string> => {
    const list = (await call(page, 'POST', `/api/sessions/${id}/todos`, { title, plan: 'No plan: test.', priority: 'medium', estimateMinutes: 45 })) as { todos: TodoWire[] };
    const todo = list.todos.find((item) => item.title === title);
    if (!todo) throw new Error(`no todo ${title}`);
    return todo.id;
  };
  const measured = await add('Measured task');
  const older = await add('Older task');
  for (const todo of [measured, older]) await call(page, 'PUT', `/api/sessions/${id}/todos/${todo}`, { state: 'in_progress' });
  for (const todo of [measured, older]) await call(page, 'PUT', `/api/sessions/${id}/todos/${todo}`, { state: 'done' });
  // The real server recorded a working time (the work clock is wired), next to the open time.
  const real = ((await call(page, 'GET', `/api/sessions/${id}/todos`)) as { todos: TodoWire[] }).todos.find((todo) => todo.id === measured);
  expect(typeof real?.workingMs).toBe('number');
  expect(typeof real?.actualMs).toBe('number');
  await expect(card(page, 'Measured task').getByTestId('v2-todo-estimate')).toHaveText(/^est 45m · took (<1m|\d+m)/);

  // The same answer with a long wait in it, and the older task as one finished before D147.
  await page.route('**/api/todos', async (route) => {
    const response = await route.fetch();
    const groups = (await response.json()) as Array<{ todos: TodoWire[] }>;
    for (const group of groups) {
      group.todos = group.todos.map((todo) =>
        todo.id === measured ? { ...todo, workingMs: 12 * MIN, actualMs: (51 * 60 + 3) * MIN } : todo.id === older ? { ...todo, workingMs: null, actualMs: 100 * 60 * MIN } : todo,
      );
    }
    await route.fulfill({ response, json: groups });
  });
  await page.reload();
  await expect(card(page, 'Measured task').getByTestId('v2-todo-estimate')).toHaveText('est 45m · took 12m (open 51h 3m)');
  await expect(card(page, 'Measured task').getByTestId('v2-todo-estimate')).not.toHaveAttribute('data-over', 'true');
  await expect(card(page, 'Older task').getByTestId('v2-todo-estimate')).toHaveText('est 45m · open 100h');
});

/** Two tasks of a fresh agent: one finished, one in progress whose clock runs, shared with another item (the times are set on the answer). */
async function liveWorld(page: Page, target: QuestionWorld, url: string, listUrl: string): Promise<string> {
  await openWithHub(page, url);
  const { id } = await target.startSession(page, 'live-worker', 'Reply with just OK.');
  const list = (await call(page, 'POST', `/api/sessions/${id}/todos`, { title: 'Live task', plan: 'No plan: test.', priority: 'medium', estimateMinutes: 15 })) as { todos: TodoWire[] };
  const live = list.todos.find((todo) => todo.title === 'Live task');
  if (!live) throw new Error('no live task');
  await call(page, 'PUT', `/api/sessions/${id}/todos/${live.id}`, { state: 'in_progress' });
  // Running: 8 min closed + 4 min since its span began, shared by two = 10 min; open 3 h.
  const set = (todo: TodoWire & { startedAt?: string | null }) =>
    todo.id === live.id ? { ...todo, workingMs: 8 * MIN, workingSince: new Date(Date.now() - 4 * MIN).toISOString(), workingShare: 2, actualMs: 0, startedAt: new Date(Date.now() - 3 * 60 * MIN).toISOString() } : todo;
  await page.route(listUrl, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { todos?: TodoWire[] } | Array<{ todos: TodoWire[] }>;
    const json = Array.isArray(body) ? body.map((group) => ({ ...group, todos: group.todos.map(set) })) : { ...body, todos: (body.todos ?? []).map(set) };
    await route.fulfill({ response, json });
  });
  return live.id;
}

test('v2: an item in progress shows its live working time, the open time beside it, not amber under its estimate', async ({ page }) => {
  test.setTimeout(90_000);
  await liveWorld(page, world, `${world.baseUrl}/tasks`, '**/api/todos');
  await page.reload();
  const estimate = card(page, 'Live task').getByTestId('v2-todo-estimate');
  await expect(estimate).toHaveText(/^est 15m · 1[01]m so far \(open 3h\)/);
  await expect(estimate).not.toHaveAttribute('data-over', 'true');
});

test('classic: an item in progress shows its live working time on its card', async ({ page }) => {
  test.setTimeout(90_000);
  await liveWorld(page, classic, classic.baseUrl, '**/api/todos');
  await page.goto(`${classic.baseUrl}/todos`);
  const item = page.locator(`[data-testid="todos-group"]`).getByTestId('todo-item').filter({ hasText: 'Live task' });
  await expect(item).toHaveAttribute('data-state', 'in_progress');
  await expect(item.getByTestId('todo-working')).toHaveText(/^1[01]m so far \(open 3h\)$/);
});
