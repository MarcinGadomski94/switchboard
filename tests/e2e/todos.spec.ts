import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D68 / D69 on the real path (D13, fake-claude): the session's todo strip above
 * the composer as cards (+ Todo while empty, + Add with title, description and
 * handover plan, open a card, the plan disclosure, Edit with Save / Cancel, the ⋯
 * menu's Move and Delete, tick, Done (n), Clear done), ▶ Start filling the composer
 * without sending (a draft is kept), a live update when the agent adds an item
 * (through the agent route its `switchboard` MCP tools call, with the session's
 * own token), the sidebar row's count and the Todos nav count, and the Todos page
 * (cards per session, Open session, ▶ Start opening the session with its composer filled).
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('todos');
});

test.afterAll(async () => {
  await world?.stop();
});

/** What the agent's MCP helper does: one call to `/agent/v1/todos` with the session's agent token (src/server/todos/agent-token.ts). */
async function agentAdds(sessionId: string, fields: Record<string, string>): Promise<number> {
  const secret = (await readFile(path.join(world.dataDir, 'sb_token'), 'utf8')).trim();
  const token = createHmac('sha256', secret).update(`switchboard-agent-todos:${sessionId}`).digest('base64url');
  const url = new URL(world.baseUrl);
  const body = JSON.stringify(fields);
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

test('the strip: + Todo, add with all three fields, open a card, the plan, edit, ⋯ move / delete, tick, Done (n), Clear done; the agent adds live; badges', async ({ page }) => {
  await page.goto(world.baseUrl);
  const { id } = await world.startSession(page, 'todo-strip', 'Reply with just OK.');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const strip = page.getByTestId('todo-strip');
  const items = strip.getByTestId('todo-item');
  const form = strip.getByTestId('todo-form');

  // Empty: no strip, a compact + Todo above the composer.
  await expect(strip).toHaveCount(0);
  await page.getByTestId('chat-todo-add').click();
  await expect(strip).toBeVisible();
  await expect(form).toHaveAttribute('data-mode', 'add');
  await expect(form.getByTestId('todo-form-title')).toBeFocused();
  // The plan's field is behind "Add handover plan" until asked for.
  await expect(form.getByTestId('todo-form-plan')).toHaveCount(0);
  await form.getByTestId('todo-form-title').fill('Fix the login test flake');
  await form.getByTestId('todo-form-description').fill('Retries hide a race in the **session cookie** refresh;\nhappens ~1 in 20 runs on CI.');
  await form.getByTestId('todo-form-plan-toggle').click();
  await expect(form.getByTestId('todo-form-plan')).toBeFocused();
  await form.getByTestId('todo-form-plan').fill('## Context\nThe flake is in `tests/login.spec.ts`.\n\n## Steps\n1. Remove the retry\n2. Await the refresh\n\n## Done when\n- 50 runs pass');
  await form.getByTestId('todo-form-save').click();
  await expect(form).toHaveCount(0);
  await expect(items).toHaveCount(1);
  const first = items.nth(0);
  await expect(first.getByTestId('todo-title')).toHaveText('Fix the login test flake');
  await expect(first.getByTestId('todo-meta')).toHaveText(/^you · (now|\d+m)$/);
  await expect(first.getByTestId('todo-description').locator('strong')).toHaveText('session cookie');
  await expect(first.getByTestId('todo-description')).toHaveAttribute('data-clamped', 'true');
  await expect(first.getByTestId('todo-plan')).toHaveCount(0);
  await expect(page.getByTestId('todo-count')).toHaveText('1 open · 0 done');
  await expect(page.getByTestId('chat-todo-add')).toHaveCount(0);

  // + Add in the header: a title only (⌘/Ctrl+Enter saves); Esc cancels another.
  await strip.getByTestId('todo-add').click();
  await form.getByTestId('todo-form-title').fill('Rename PROJ-12 settings keys');
  await form.getByTestId('todo-form-title').press('ControlOrMeta+Enter');
  await expect(items).toHaveCount(2);
  await strip.getByTestId('todo-add').click();
  await form.getByTestId('todo-form-title').fill('Never saved');
  await form.getByTestId('todo-form-title').press('Escape');
  await expect(form).toHaveCount(0);
  await expect(items.getByTestId('todo-title')).toHaveText(['Fix the login test flake', 'Rename PROJ-12 settings keys']);
  const second = items.nth(1);
  // No plan, no description: no disclosure, but ▶ Start.
  await expect(second.getByTestId('todo-plan-toggle')).toHaveCount(0);
  await expect(second.getByTestId('todo-description')).toHaveCount(0);
  await expect(second.getByTestId('todo-start')).toBeVisible();

  // The plan's disclosure (rendered Markdown), then the card opened by a click: full description + plan.
  const planToggle = first.getByTestId('todo-plan-toggle');
  await expect(planToggle).toHaveAttribute('aria-expanded', 'false');
  await planToggle.click();
  await expect(planToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(first.getByTestId('todo-plan').locator('h2')).toHaveText(['Context', 'Steps', 'Done when']);
  await expect(first.getByTestId('todo-plan').locator('ol > li')).toHaveText(['Remove the retry', 'Await the refresh']);
  await planToggle.click();
  await expect(first.getByTestId('todo-plan')).toHaveCount(0);
  await first.getByTestId('todo-title').click();
  await expect(first).toHaveAttribute('data-expanded', 'true');
  await expect(first.getByTestId('todo-description')).toHaveAttribute('data-clamped', 'false');
  await expect(first.getByTestId('todo-plan')).toBeVisible();
  await first.getByTestId('todo-title').press('Enter');
  await expect(first).toHaveAttribute('data-expanded', 'false');

  // Edit through ⋯: Cancel (and Esc) keep it; Save changes it; an emptied description is removed.
  const edit = async (card: typeof first): Promise<void> => {
    await card.getByTestId('todo-menu-button').click();
    await expect(card.getByTestId('todo-menu')).toBeVisible();
    await expect(card.getByTestId('todo-menu-edit')).toBeFocused();
    await card.getByTestId('todo-menu-edit').click();
  };
  await edit(second);
  await expect(second.getByTestId('todo-form')).toHaveAttribute('data-mode', 'edit');
  await second.getByTestId('todo-form-title').fill('Changed my mind');
  await second.getByTestId('todo-form-cancel').click();
  await expect(second.getByTestId('todo-title')).toHaveText('Rename PROJ-12 settings keys');
  await edit(first);
  await expect(first.getByTestId('todo-form-title')).toHaveValue('Fix the login test flake');
  await expect(first.getByTestId('todo-form-plan')).toHaveValue(/## Context/);
  await first.getByTestId('todo-form-description').press('Escape');
  await expect(first.getByTestId('todo-form')).toHaveCount(0);
  await edit(first);
  await first.getByTestId('todo-form-title').fill('Fix the login flake');
  await first.getByTestId('todo-form-description').fill('');
  await first.getByTestId('todo-form-description').press('ControlOrMeta+Enter');
  await expect(first.getByTestId('todo-title')).toHaveText('Fix the login flake');
  await expect(first.getByTestId('todo-description')).toHaveCount(0);
  await expect(first.getByTestId('todo-plan-toggle')).toBeVisible();

  // ⋯ Move down / up (keyboard: arrows and Enter in the menu).
  await first.getByTestId('todo-menu-button').click();
  await expect(first.getByTestId('todo-menu-up')).toBeDisabled();
  await first.getByTestId('todo-menu-down').click();
  await expect(items.getByTestId('todo-title')).toHaveText(['Rename PROJ-12 settings keys', 'Fix the login flake']);
  await items.nth(1).getByTestId('todo-menu-button').click();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1).getByTestId('todo-menu-up')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(items.getByTestId('todo-title')).toHaveText(['Fix the login flake', 'Rename PROJ-12 settings keys']);
  await items.nth(0).getByTestId('todo-menu-button').click();
  await page.keyboard.press('Escape');
  await expect(items.nth(0).getByTestId('todo-menu')).toHaveCount(0);
  await expect(items.nth(0).getByTestId('todo-menu-button')).toBeFocused();

  // The sidebar row's count and the Todos nav count.
  const row = page.locator(`.sb-session[data-session-id="${id}"]`);
  await expect(row.getByTestId('session-todo-count')).toHaveText('☐ 2');
  await expect(page.getByTestId('nav-todos').locator('.sb-badge')).toHaveText('2');

  // Tick: the item moves under a collapsed Done (1): struck through, no description, its countdown; the progress follows.
  await items.nth(1).getByTestId('todo-check').click();
  await expect(page.getByTestId('todo-count')).toHaveText('1 open · 1 done');
  await expect(page.getByTestId('todo-progress')).toHaveAttribute('aria-valuenow', '1');
  await expect(page.getByTestId('todo-done-toggle')).toHaveText('▸ Done (1)');
  await expect(items).toHaveCount(1);
  await page.getByTestId('todo-done-toggle').click();
  const done = strip.locator('[data-testid="todo-item"][data-state="done"]');
  await expect(done.getByTestId('todo-title')).toHaveText('Rename PROJ-12 settings keys');
  await expect(done.getByTestId('todo-title')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(done.getByTestId('todo-removal')).toHaveText(/^removed in (59|60)m$/);
  await expect(done.getByTestId('todo-start')).toHaveCount(0);
  await expect(row.getByTestId('session-todo-count')).toHaveText('☐ 1');

  // The agent adds an item with all three fields (its MCP tool's call): it shows at once, marked "agent".
  expect(await agentAdds(id, { title: 'Check the migration', description: 'Make sure 0027 keeps the rows.', plan: 'Run the migration test.' })).toBe(201);
  const agentItem = strip.locator('[data-testid="todo-item"][data-added-by="agent"]');
  await expect(agentItem.getByTestId('todo-title')).toHaveText('Check the migration');
  await expect(agentItem.getByTestId('todo-by')).toHaveText('agent');
  await expect(agentItem.getByTestId('todo-plan-toggle')).toBeVisible();
  // An agent on 1.7.0's tool shape (`text`) still adds.
  expect(await agentAdds(id, { text: 'Old-style item' })).toBe(201);
  await expect(page.getByTestId('todo-count')).toHaveText('3 open · 1 done');
  await expect(row.getByTestId('session-todo-count')).toHaveText('☐ 3');
  await expect(page.getByTestId('nav-todos').locator('.sb-badge')).toHaveText('3');

  // Clear done, then delete two through ⋯.
  await page.getByTestId('todo-clear-done').click();
  await expect(page.getByTestId('todo-done-toggle')).toHaveCount(0);
  for (const title of ['Check the migration', 'Old-style item']) {
    const card = items.filter({ has: page.getByTestId('todo-title').getByText(title, { exact: true }) });
    await card.getByTestId('todo-menu-button').click();
    await card.getByTestId('todo-menu-delete').click();
  }
  await expect(items.getByTestId('todo-title')).toHaveText(['Fix the login flake']);

  // Collapsed, the strip shows the counts and the next item's title.
  await page.getByTestId('todo-toggle').click();
  await expect(strip).toHaveAttribute('data-expanded', 'false');
  await expect(page.getByTestId('todo-next')).toHaveText('Fix the login flake');
  await page.getByTestId('todo-toggle').click();
});

test('▶ Start fills the composer without sending and keeps a draft; on the Todos page it opens the session', async ({ page }) => {
  await page.goto(world.baseUrl);
  const { id } = await world.startSession(page, 'todo-start', 'Reply with just OK.');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const messages = page.locator('[data-testid="chat-message"][data-role="user"]');
  await expect(messages).toHaveCount(1);
  const strip = page.getByTestId('todo-strip');
  const input = page.getByTestId('chat-input');
  await page.getByTestId('chat-todo-add').click();
  const form = strip.getByTestId('todo-form');
  await form.getByTestId('todo-form-title').fill('Fix the login test flake');
  await form.getByTestId('todo-form-description').fill('Retries hide a race.');
  await form.getByTestId('todo-form-plan-toggle').click();
  await form.getByTestId('todo-form-plan').fill('1. Remove the retry\n2. Await the refresh');
  await form.getByTestId('todo-form-save').click();
  await strip.getByTestId('todo-add').click();
  await form.getByTestId('todo-form-title').fill('Update the README');
  await form.getByTestId('todo-form-description').fill('The install section is stale.');
  await form.getByTestId('todo-form-save').click();
  const items = strip.getByTestId('todo-item');
  await expect(items).toHaveCount(2);
  const todoId = (await items.nth(0).getAttribute('data-todo-id')) as string;
  const readmeId = (await items.nth(1).getAttribute('data-todo-id')) as string;

  // Empty composer: the message is the id and title, a blank line, then the plan; focused, not sent.
  await items.nth(0).getByTestId('todo-start').click();
  await expect(input).toHaveValue(`Work on todo [${todoId}]: Fix the login test flake\n\n1. Remove the retry\n2. Await the refresh`);
  await expect(input).toBeFocused();
  await expect(messages).toHaveCount(1);

  // A draft is never replaced: the message goes after it. No plan: the description.
  await input.fill('My own draft');
  await items.nth(1).getByTestId('todo-start').click();
  await expect(input).toHaveValue(`My own draft\n\nWork on todo [${readmeId}]: Update the README\n\nThe install section is stale.`);
  await expect(messages).toHaveCount(1);
  await input.fill('');

  // The Todos page: the same cards under the session's header; ▶ Start opens the session with its composer filled.
  await page.getByTestId('nav-todos').click();
  const group = page.locator(`[data-testid="todos-group"][data-session-id="${id}"]`);
  await expect(group.getByTestId('todos-group-title')).toHaveText('todo-start');
  await expect(group.getByTestId('todos-group-count')).toHaveText('2 open');
  await expect(group.getByTestId('todos-open-session')).toBeVisible();
  const cards = group.getByTestId('todo-item');
  await expect(cards.getByTestId('todo-title')).toHaveText(['Fix the login test flake', 'Update the README']);
  await expect(cards.nth(0).getByTestId('todo-plan-toggle')).toBeVisible();
  await expect(cards.nth(1).getByTestId('todo-description')).toContainText('The install section is stale.');
  await cards.nth(1).getByTestId('todo-start').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${id}$`));
  await expect(input).toHaveValue(`Work on todo [${readmeId}]: Update the README\n\nThe install section is stale.`);
  await expect(input).toBeFocused();
  await expect(messages).toHaveCount(1);

  // Ticking on the page updates the counts; Show done brings the done card; Open session opens it.
  await page.getByTestId('nav-todos').click();
  await group.getByTestId('todo-item').nth(1).getByTestId('todo-check').click();
  await expect(group.getByTestId('todos-group-count')).toHaveText('1 open');
  await expect(page.getByTestId('todos-summary')).toHaveText('2 open in 2 sessions'); // this one's and the first test's session
  await page.getByTestId('todos-show-done').check();
  await expect(group.getByTestId('todos-group-done').getByTestId('todo-title')).toHaveText('Update the README');
  await group.getByTestId('todo-item').nth(0).getByTestId('todo-check').click();
  await expect(group.getByTestId('todos-group-count')).toHaveText('0 open');
  await page.getByTestId('todos-show-done').uncheck();
  await expect(group).toHaveCount(0);
  await page.getByTestId('todos-show-done').check();
  await group.getByTestId('todos-open-session').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${id}$`));
  await expect(page.getByTestId('todo-count')).toHaveText('0 open · 2 done');
});
