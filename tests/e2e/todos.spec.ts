import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D68 on the real path (D13, fake-claude): the session's todo strip above the
 * composer (+ Todo while empty, add, edit inline, reorder, tick, Done (n), Clear
 * done, delete), a live update when the agent adds an item (through the agent
 * route its `switchboard` MCP tools call, with the session's own token), the
 * sidebar row's count and the Todos nav count, and the Todos page.
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('todos');
});

test.afterAll(async () => {
  await world?.stop();
});

/** What the agent's MCP helper does: one call to `/agent/v1/todos` with the session's agent token (src/server/todos/agent-token.ts). */
async function agentAdds(sessionId: string, text: string): Promise<number> {
  const secret = (await readFile(path.join(world.dataDir, 'sb_token'), 'utf8')).trim();
  const token = createHmac('sha256', secret).update(`switchboard-agent-todos:${sessionId}`).digest('base64url');
  const url = new URL(world.baseUrl);
  const body = JSON.stringify({ text });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(url.port),
        path: '/agent/v1/todos',
        method: 'POST',
        headers: { host: url.host, authorization: `Bearer ${token}`, 'x-switchboard-session': sessionId, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('the strip: + Todo, add, edit, reorder, tick, Done (n), Clear done, delete; the agent adds live; badges; the Todos page', async ({ page }) => {
  await page.goto(world.baseUrl);
  const { id } = await world.startSession(page, 'todo-strip', 'Reply with just OK.');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const strip = page.getByTestId('todo-strip');
  const items = strip.getByTestId('todo-item');

  // Empty: no strip, a compact + Todo in the composer's quick row.
  await expect(strip).toHaveCount(0);
  await page.getByTestId('chat-todo-add').click();
  await expect(strip).toBeVisible();
  const input = page.getByTestId('todo-add-input');
  await expect(input).toBeFocused();
  await input.fill('Write the docs');
  await input.press('Enter');
  await expect(items).toHaveCount(1);
  await expect(input).toHaveValue('');
  await input.fill('Run the tests');
  await page.getByTestId('todo-add').click();
  await expect(items).toHaveText([/Write the docs\s*you/, /Run the tests\s*you/]);
  await expect(page.getByTestId('todo-count')).toHaveText('Todo (2)');
  await expect(page.getByTestId('chat-todo-add')).toHaveCount(0);

  // Edit inline (Enter saves), reorder (↓).
  await items.nth(0).getByTestId('todo-text').click();
  await page.getByTestId('todo-edit').fill('Write the API docs');
  await page.getByTestId('todo-edit').press('Enter');
  await expect(items.nth(0).getByTestId('todo-text')).toHaveText('Write the API docs');
  await items.nth(0).hover();
  await items.nth(0).getByTestId('todo-down').click();
  await expect(items.getByTestId('todo-text')).toHaveText(['Run the tests', 'Write the API docs']);

  // The sidebar row's count and the Todos nav count.
  const row = page.locator(`.sb-session[data-session-id="${id}"]`);
  await expect(row.getByTestId('session-todo-count')).toHaveText('☐ 2');
  await expect(page.getByTestId('nav-todos').locator('.sb-badge')).toHaveText('2');

  // Tick: the item moves under a collapsed Done (1), struck through once shown; the counts follow.
  await items.nth(0).getByTestId('todo-check').click();
  await expect(page.getByTestId('todo-count')).toHaveText('Todo (1)');
  await expect(page.getByTestId('todo-done-toggle')).toHaveText('▸ Done (1)');
  await expect(items).toHaveCount(1);
  await page.getByTestId('todo-done-toggle').click();
  const done = strip.locator('[data-testid="todo-item"][data-state="done"]');
  await expect(done.getByTestId('todo-text')).toHaveText('Run the tests');
  await expect(done.getByTestId('todo-text')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(row.getByTestId('session-todo-count')).toHaveText('☐ 1');

  // The agent adds an item (its MCP tool's call): it shows at once, marked "agent".
  expect(await agentAdds(id, 'Check the migration')).toBe(201);
  await expect(strip.locator('[data-added-by="agent"]').getByTestId('todo-text')).toHaveText('Check the migration');
  await expect(strip.locator('[data-added-by="agent"]').getByTestId('todo-by')).toHaveText('agent');
  await expect(page.getByTestId('todo-count')).toHaveText('Todo (2)');
  await expect(row.getByTestId('session-todo-count')).toHaveText('☐ 2');
  await expect(page.getByTestId('nav-todos').locator('.sb-badge')).toHaveText('2');

  // Clear done, then delete one.
  await page.getByTestId('todo-clear-done').click();
  await expect(page.getByTestId('todo-done-toggle')).toHaveCount(0);
  const agentItem = strip.locator('[data-added-by="agent"]');
  await agentItem.hover();
  await agentItem.getByTestId('todo-delete').click();
  await expect(items.getByTestId('todo-text')).toHaveText(['Write the API docs']);

  // Collapsed, the strip shows the count and the next item.
  await page.getByTestId('todo-toggle').click();
  await expect(strip).toHaveAttribute('data-expanded', 'false');
  await expect(strip).toContainText('Write the API docs');

  // The Todos page: the session's group; ticking there updates the session and the counts.
  await page.getByTestId('nav-todos').click();
  const group = page.locator(`[data-testid="todos-group"][data-session-id="${id}"]`);
  await expect(group.getByTestId('todos-group-title')).toHaveText('todo-strip');
  await expect(group.getByTestId('todos-item-text')).toHaveText(['Write the API docs']);
  await expect(page.getByTestId('todos-summary')).toHaveText('1 open in 1 session');
  await group.getByTestId('todos-check').click();
  await expect(page.getByTestId('todos-empty')).toBeVisible();
  await expect(page.getByTestId('nav-todos').locator('.sb-badge')).toHaveText('');
  await expect(row.getByTestId('session-todo-count')).toHaveCount(0);
  await page.getByTestId('todos-show-done').check();
  await expect(group.locator('[data-state="done"]').getByTestId('todos-item-text')).toHaveText('Write the API docs');
  await group.getByTestId('todos-group-title').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${id}$`));
  await expect(page.getByTestId('todo-count')).toHaveText('Todo (0)');
});
