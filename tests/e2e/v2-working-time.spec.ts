import { type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D147 · a finished task's card in v2 Tasks says how long its agent **worked** on it, with its
 * open time beside it (`docs/todos.md` → *Actual vs. estimate (D78, D147)*). The real path
 * (fake-claude) records a working time for an item finished after D147; the card's two
 * shapes (working + open, open time only) are then checked on an answer whose times are set
 * (a real wait of hours is not something a test can sit through).
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-working-time', { env: V2_SERVER_ENV });
});

test.afterAll(async () => {
  await world?.stop();
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
