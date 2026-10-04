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
 * D70: priorities sort the open cards (tinted, labelled), estimates and their totals,
 * the priority changed in the edit form re-sorts, Move stays within a level, and the
 * add form is prefilled (No plan, medium).
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('todos');
});

test.afterAll(async () => {
  await world?.stop();
});

/** What the agent's MCP helper does: one call to `/agent/v1/todos` with the session's agent token (src/server/todos/agent-token.ts). */
async function agentAdds(sessionId: string, fields: Record<string, string | number>): Promise<number> {
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
  // D70: the plan is required: prefilled "No plan", medium, no estimate, so adding stays quick.
  await expect(form.getByTestId('todo-form-plan')).toHaveValue('No plan');
  await expect(form.getByTestId('todo-form-priority')).toHaveValue('medium');
  await expect(form.getByTestId('todo-form-estimate')).toHaveValue('');
  await form.getByTestId('todo-form-title').fill('Fix the login test flake');
  await form.getByTestId('todo-form-description').fill('Retries hide a race in the **session cookie** refresh;\nhappens ~1 in 20 runs on CI.');
  await form.getByTestId('todo-form-plan').fill('## Context\nThe flake is in `tests/login.spec.ts`.\n\n## Steps\n1. Remove the retry\n2. Await the refresh\n\n## Done when\n- 50 runs pass');
  await form.getByTestId('todo-form-save').click();
  await expect(items).toHaveCount(1);
  // D69 ruling: the add form stays open for the next item, cleared (D70: the plan back to "No plan"), the title focused.
  await expect(form).toHaveAttribute('data-mode', 'add');
  await expect(form.getByTestId('todo-form-title')).toHaveValue('');
  await expect(form.getByTestId('todo-form-description')).toHaveValue('');
  await expect(form.getByTestId('todo-form-plan')).toHaveValue('No plan');
  await expect(form.getByTestId('todo-form-title')).toBeFocused();
  const first = items.nth(0);
  await expect(first.getByTestId('todo-title')).toHaveText('Fix the login test flake');
  await expect(first.getByTestId('todo-meta')).toHaveText(/^you · (now|\d+m)$/);
  await expect(first.getByTestId('todo-priority')).toHaveText('Medium');
  await expect(first.getByTestId('todo-estimate')).toHaveCount(0);
  await expect(first.getByTestId('todo-description').locator('strong')).toHaveText('session cookie');
  await expect(first.getByTestId('todo-description')).toHaveAttribute('data-clamped', 'true');
  await expect(first.getByTestId('todo-plan')).toHaveCount(0);
  await expect(page.getByTestId('todo-count')).toHaveText('1 open · 0 done');
  await expect(page.getByTestId('chat-todo-add')).toHaveCount(0);

  // The next one in the still-open form: a title only (⌘/Ctrl+Enter saves); then Esc closes it without saving.
  await form.getByTestId('todo-form-title').fill('Rename PROJ-12 settings keys');
  await form.getByTestId('todo-form-title').press('ControlOrMeta+Enter');
  await expect(items).toHaveCount(2);
  await expect(form.getByTestId('todo-form-title')).toHaveValue('');
  await form.getByTestId('todo-form-title').fill('Never saved');
  await form.getByTestId('todo-form-title').press('Escape');
  await expect(form).toHaveCount(0);
  await expect(items.getByTestId('todo-title')).toHaveText(['Fix the login test flake', 'Rename PROJ-12 settings keys']);
  const second = items.nth(1);
  // "No plan", no description: no disclosure, no body row; ▶ Start sits on the title row (D69 review, D70).
  await expect(second.getByTestId('todo-plan-toggle')).toHaveCount(0);
  await expect(second.getByTestId('todo-description')).toHaveCount(0);
  await expect(second.locator('.sb-todo-card-row').getByTestId('todo-start')).toBeVisible();
  await expect(second.locator('.sb-todo-card-body')).toHaveCount(0);
  // With a plan, ▶ Start stays with the Handover plan toggle, under the description.
  await expect(first.locator('.sb-todo-card-row').getByTestId('todo-start')).toHaveCount(0);
  await expect(first.locator('.sb-todo-card-foot').getByTestId('todo-start')).toBeVisible();
  // + Add in the header opens the form again; Cancel closes it.
  await strip.getByTestId('todo-add').click();
  await expect(form.getByTestId('todo-form-title')).toBeFocused();
  await form.getByTestId('todo-form-cancel').click();
  await expect(form).toHaveCount(0);

  // The plan's disclosure (rendered Markdown), then the card opened by a click: full description + plan.
  const planToggle = first.getByTestId('todo-plan-toggle');
  await expect(planToggle).toHaveAttribute('aria-expanded', 'false');
  await planToggle.click();
  await expect(planToggle).toHaveAttribute('aria-expanded', 'true');
  // D69 review: the toggle sits above the plan, and the card's title row stays in view.
  const toggleBox = await planToggle.boundingBox();
  const planBox = await first.getByTestId('todo-plan').boundingBox();
  expect(toggleBox!.y).toBeLessThan(planBox!.y);
  await expect(first.getByTestId('todo-title')).toBeInViewport();
  await expect(first.getByTestId('todo-plan').locator('h2')).toHaveText(['Context', 'Steps', 'Done when']);
  await expect(first.getByTestId('todo-plan').locator('ol > li')).toHaveText(['Remove the retry', 'Await the refresh']);
  await planToggle.click();
  await expect(first.getByTestId('todo-plan')).toHaveCount(0);
  await first.getByTestId('todo-title').click();
  await expect(first).toHaveAttribute('data-expanded', 'true');
  await expect(first.getByTestId('todo-title')).toBeInViewport();
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
  // Save / Cancel stay in view however tall the form is (D69 review).
  await expect(first.getByTestId('todo-form-save')).toBeInViewport();
  await expect(first.getByTestId('todo-form-cancel')).toBeInViewport();
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
  await form.getByTestId('todo-form-plan').fill('1. Remove the retry\n2. Await the refresh');
  await form.getByTestId('todo-form-save').click();
  await expect(strip.getByTestId('todo-item')).toHaveCount(1);
  await form.getByTestId('todo-form-title').fill('Update the README');
  await form.getByTestId('todo-form-description').fill('The install section is stale.');
  await form.getByTestId('todo-form-save').click();
  await form.getByTestId('todo-form-cancel').click();
  const items = strip.getByTestId('todo-item');
  await expect(items).toHaveCount(2);
  const todoId = (await items.nth(0).getAttribute('data-todo-id')) as string;
  const readmeId = (await items.nth(1).getAttribute('data-todo-id')) as string;

  // Empty composer: the message is the id and title, a blank line, then the plan; focused, not sent.
  await items.nth(0).getByTestId('todo-start').click();
  await expect(input).toHaveValue(`Work on todo [${todoId}]: Fix the login test flake\n\n1. Remove the retry\n2. Await the refresh`);
  await expect(input).toBeFocused();
  await expect(messages).toHaveCount(1);

  // A draft is never replaced: the message goes after it. "No plan" (D70): the description.
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

test('D70 · priorities sort and tint the cards, estimates and totals show; the form changes them; moves stay within a level; the Todos page totals', async ({ page }) => {
  await page.goto(world.baseUrl);
  const { id } = await world.startSession(page, 'todo-priority', 'Reply with just OK.');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const strip = page.getByTestId('todo-strip');
  const items = strip.locator('[data-testid="todo-item"][data-state="open"]');
  const titles = items.getByTestId('todo-title');

  // The agent adds four items with different priorities (one without an estimate: an older tool shape).
  expect(await agentAdds(id, { title: 'Tidy the README', plan: 'No plan: wording only', priority: 'low', estimateMinutes: 15 })).toBe(201);
  expect(await agentAdds(id, { title: 'Write the changelog', plan: 'List the D70 changes.', priority: 'medium' })).toBe(201);
  expect(await agentAdds(id, { title: 'Restore the login page', description: 'Production login is down.', plan: '1. Roll back PROJ-7\n2. Check the logs', priority: 'urgent', estimateMinutes: 30 })).toBe(201);
  expect(await agentAdds(id, { title: 'Fix the flaky upload test', plan: 'Await the upload before asserting.', priority: 'high', estimateMinutes: 90 })).toBe(201);
  if ((await strip.getAttribute('data-expanded')) !== 'true') await page.getByTestId('todo-toggle').click();

  // Sorted urgent → low; each card labelled and tinted by its priority; the estimates and the header total (+: one is unknown).
  await expect(titles).toHaveText(['Restore the login page', 'Fix the flaky upload test', 'Write the changelog', 'Tidy the README']);
  await expect(items.getByTestId('todo-priority')).toHaveText(['Urgent', 'High', 'Medium', 'Low']);
  await expect(items.nth(0).getByTestId('todo-estimate')).toHaveText('~30m');
  await expect(items.nth(1).getByTestId('todo-estimate')).toHaveText('~1h 30m');
  await expect(items.nth(2).getByTestId('todo-estimate')).toHaveCount(0);
  await expect(items.nth(3).getByTestId('todo-estimate')).toHaveText('~15m');
  await expect(page.getByTestId('todo-count')).toHaveText('4 open · ~2h 15m+ · 0 done');
  const edge = (index: number) => items.nth(index).evaluate((el) => ({ width: getComputedStyle(el).borderLeftWidth, color: getComputedStyle(el).borderLeftColor, background: getComputedStyle(el).backgroundColor }));
  const [urgent, high, medium, low] = [await edge(0), await edge(1), await edge(2), await edge(3)];
  for (const card of [urgent, high, medium, low]) expect(card.width).toBe('3px');
  expect(new Set([urgent.color, high.color, medium.color, low.color]).size).toBe(4);
  // The tint is faint: urgent / high / low differ from the plain medium card, but only slightly.
  expect(urgent.background).not.toBe(medium.background);
  expect(low.background).not.toBe(medium.background);
  // "No plan: <reason>" is not offered as a plan; a real plan is.
  await expect(items.nth(3).getByTestId('todo-plan-toggle')).toHaveCount(0);
  await expect(items.nth(2).getByTestId('todo-plan-toggle')).toBeVisible();

  // Collapsed, the next item is the top one by priority.
  await page.getByTestId('todo-toggle').click();
  await expect(page.getByTestId('todo-next')).toHaveText('Restore the login page');
  await page.getByTestId('todo-toggle').click();

  // + Add: prefilled No plan / medium / no estimate; the developer picks High and 1h 30m; a bad estimate blocks Save.
  await strip.getByTestId('todo-add').click();
  const form = strip.getByTestId('todo-form');
  await expect(form.getByTestId('todo-form-plan')).toHaveValue('No plan');
  await expect(form.getByTestId('todo-form-priority')).toHaveValue('medium');
  await expect(form.getByTestId('todo-form-estimate')).toHaveValue('');
  await form.getByTestId('todo-form-title').fill('Review the upload fix');
  await form.getByTestId('todo-form-priority').selectOption('high');
  await form.getByTestId('todo-form-estimate').fill('soon');
  await expect(form.getByTestId('todo-form-estimate-error')).toBeVisible();
  await expect(form.getByTestId('todo-form-save')).toBeDisabled();
  await form.getByTestId('todo-form-estimate').fill('1h 30m');
  await expect(form.getByTestId('todo-form-estimate-error')).toHaveCount(0);
  // An emptied plan blocks Save too (write "No plan" instead).
  await form.getByTestId('todo-form-plan').fill('');
  await expect(form.getByTestId('todo-form-save')).toBeDisabled();
  await form.getByTestId('todo-form-plan').fill('No plan');
  await form.getByTestId('todo-form-save').click();
  await expect(titles).toHaveText(['Restore the login page', 'Fix the flaky upload test', 'Review the upload fix', 'Write the changelog', 'Tidy the README']);
  await expect(form.getByTestId('todo-form-priority')).toHaveValue('medium');
  await expect(form.getByTestId('todo-form-estimate')).toHaveValue('');
  await form.getByTestId('todo-form-cancel').click();
  const review = items.nth(2);
  await expect(review.getByTestId('todo-priority')).toHaveText('High');
  await expect(review.getByTestId('todo-estimate')).toHaveText('~1h 30m');
  await expect(review.getByTestId('todo-by')).toHaveText('you');
  await expect(page.getByTestId('todo-count')).toHaveText('5 open · ~3h 45m+ · 0 done');

  // ⋯ Move stays within the level: the only urgent item cannot move; the last high one moves up, not down into medium.
  await items.nth(0).getByTestId('todo-menu-button').click();
  await expect(items.nth(0).getByTestId('todo-menu-up')).toBeDisabled();
  await expect(items.nth(0).getByTestId('todo-menu-down')).toBeDisabled();
  await page.keyboard.press('Escape');
  await review.getByTestId('todo-menu-button').click();
  await expect(review.getByTestId('todo-menu-down')).toBeDisabled();
  await review.getByTestId('todo-menu-up').click();
  await expect(titles).toHaveText(['Restore the login page', 'Review the upload fix', 'Fix the flaky upload test', 'Write the changelog', 'Tidy the README']);

  // Edit: the low item becomes urgent (it re-sorts into the urgent level by its own place: it was added first); the changelog gets an estimate.
  const editCard = async (title: string): Promise<void> => {
    const card = items.filter({ has: page.getByTestId('todo-title').getByText(title, { exact: true }) });
    await card.getByTestId('todo-menu-button').click();
    await card.getByTestId('todo-menu-edit').click();
  };
  await editCard('Tidy the README');
  const edit = strip.locator('[data-testid="todo-form"][data-mode="edit"]');
  await expect(edit.getByTestId('todo-form-priority')).toHaveValue('low');
  await expect(edit.getByTestId('todo-form-estimate')).toHaveValue('15m');
  await expect(edit.getByTestId('todo-form-plan')).toHaveValue('No plan: wording only');
  await edit.getByTestId('todo-form-priority').selectOption('urgent');
  await edit.getByTestId('todo-form-save').click();
  await expect(titles).toHaveText(['Tidy the README', 'Restore the login page', 'Review the upload fix', 'Fix the flaky upload test', 'Write the changelog']);
  await expect(items.nth(0).getByTestId('todo-priority')).toHaveText('Urgent');
  await editCard('Write the changelog');
  await expect(edit.getByTestId('todo-form-estimate')).toHaveValue('');
  await edit.getByTestId('todo-form-estimate').fill('45');
  await edit.getByTestId('todo-form-estimate').press('ControlOrMeta+Enter');
  await expect(items.nth(4).getByTestId('todo-estimate')).toHaveText('~45m');
  // Every estimate known now: no +.
  await expect(page.getByTestId('todo-count')).toHaveText('5 open · ~4h 30m · 0 done');
  // Removing an estimate in the form brings the + back.
  await editCard('Write the changelog');
  await edit.getByTestId('todo-form-estimate').fill('');
  await edit.getByTestId('todo-form-save').click();
  await expect(page.getByTestId('todo-count')).toHaveText('5 open · ~3h 45m+ · 0 done');

  // A done card: no tint, no label, no estimate (muted as before); the total counts open items only.
  await items.nth(0).getByTestId('todo-check').click();
  await expect(page.getByTestId('todo-count')).toHaveText('4 open · ~3h 30m+ · 1 done');
  await page.getByTestId('todo-done-toggle').click();
  const done = strip.locator('[data-testid="todo-item"][data-state="done"]');
  await expect(done.getByTestId('todo-priority')).toHaveCount(0);
  await expect(done.getByTestId('todo-estimate')).toHaveCount(0);
  expect(await done.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('1px');

  // The Todos page: the same order and labels, and the session's estimate total.
  await page.getByTestId('nav-todos').click();
  const group = page.locator(`[data-testid="todos-group"][data-session-id="${id}"]`);
  await expect(group.getByTestId('todos-group-count')).toHaveText('4 open');
  await expect(group.getByTestId('todos-group-estimate')).toHaveText('~3h 30m+');
  await expect(group.locator('[data-testid="todo-item"][data-state="open"]').getByTestId('todo-title')).toHaveText(['Restore the login page', 'Review the upload fix', 'Fix the flaky upload test', 'Write the changelog']);
  await expect(group.locator('[data-testid="todo-item"][data-state="open"]').getByTestId('todo-priority')).toHaveText(['Urgent', 'High', 'High', 'Medium']);
});
