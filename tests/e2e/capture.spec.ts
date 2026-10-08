import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D81 on the real path (fake-claude): quick capture. ⌘K `todo <text>` adds a bare item to the
 * current session (and, outside a session, to a session picked in the palette, recent first);
 * the card says "✎ waiting for the agent to fill in"; the idle agent gets ONE message asking it to
 * fill the item in, and its todo_update clears the mark. A selection in the chat offers
 * "Add to todo" (a popover with the generated title and the quoted selection, editable). The
 * share page (`/share?…`) asks which session at phone size. Screenshots go to
 * `test-results/shots/` (`SWITCHBOARD_SHOTS` moves them).
 */
let world: QuestionWorld;
const SHOTS = process.env['SWITCHBOARD_SHOTS'] ?? path.join('test-results', 'shots');

test.beforeAll(async () => {
  world = await startQuestionWorld('capture');
});

test.afterAll(async () => {
  await world?.stop();
});

/** What the agent's `todo_update` does: one PUT to `/agent/v1/todos/{id}` with the session's agent token. */
async function agentUpdates(sessionId: string, todoId: string, fields: Record<string, string | number>): Promise<number> {
  const secret = (await readFile(path.join(world.dataDir, 'sb_token'), 'utf8')).trim();
  const token = createHmac('sha256', secret).update(`switchboard-agent-todos:${sessionId}`).digest('base64url');
  const url = new URL(world.baseUrl);
  const body = JSON.stringify(fields);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(url.port),
        path: `/agent/v1/todos/${todoId}`,
        method: 'PUT',
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

/** Waits until the session's first turn ended (its agent is idle). */
async function idle(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => (await page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${sessionId}`)).json()).status as string, id)), { timeout: 15_000 })
    .toMatch(/^(idle|done)$/);
}

/** Opens the session's todo strip (collapsed by default; remembered in this browser). */
async function expandStrip(page: Page): Promise<void> {
  const strip = page.getByTestId('todo-strip');
  await expect(strip).toBeVisible();
  if ((await strip.getAttribute('data-expanded')) === 'false') await page.getByTestId('todo-toggle').click();
  await expect(strip).toHaveAttribute('data-expanded', 'true');
}

const rows = (page: Page) =>
  page.getByTestId('palette-row').evaluateAll((list) => list.map((row) => [...row.querySelectorAll('span')].map((span) => span.textContent ?? '').join(' | ')));

test('⌘K `todo <text>`: a bare item in this session, "waiting for the agent"; the idle agent is asked once; its todo_update clears it; outside a session: pick one', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(world.baseUrl);
  const other = await world.startSession(page, 'capture-other', 'Reply with just OK.');
  const { id } = await world.startSession(page, 'capture-palette', 'Reply with just OK.');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const messages = page.locator('[data-testid="chat-message"][data-role="user"]');
  await expect(messages).toHaveCount(1);
  await idle(page, id);

  // "Add todo…" types `todo ` for the title.
  await page.keyboard.press('Control+k');
  const input = page.getByTestId('palette-input');
  await input.fill('add todo');
  await expect.poll(() => rows(page)).toEqual(['action | Add todo… | todo <title>']);
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('todo ');
  await expect.poll(() => rows(page)).toEqual(['todo | Add todo… | type the title']);
  await page.keyboard.press('Enter'); // nothing to pick yet
  await expect(page.getByTestId('modal-palette')).toBeVisible();
  await input.pressSequentially('Check the flaky login test');
  await expect.poll(() => rows(page)).toEqual(['todo | Add “Check the flaky login test” | to capture-palette', 'todo | Add to capture-other | ']);
  await page.screenshot({ path: path.join(SHOTS, 'palette-todo.png') });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('modal-palette')).toHaveCount(0);

  // The card: bare (Medium, no estimate, No plan) and waiting for the agent.
  const strip = page.getByTestId('todo-strip');
  await expandStrip(page);
  const item = strip.getByTestId('todo-item');
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId('todo-title')).toHaveText('Check the flaky login test');
  await expect(item.getByTestId('todo-priority')).toHaveText('Medium');
  await expect(item.getByTestId('todo-estimate')).toHaveCount(0);
  await expect(item.getByTestId('todo-enrich-waiting')).toHaveText('✎ waiting for the agent to fill in');
  const todoId = (await item.getAttribute('data-todo-id')) as string;
  await strip.screenshot({ path: path.join(SHOTS, 'card-waiting.png') });

  // The idle agent gets ONE message.
  await expect(messages).toHaveCount(2, { timeout: 15_000 });
  await expect(messages.nth(1)).toHaveText(
    `The developer added todo [${todoId}] 'Check the flaky login test'. Fill in its description, handover plan, priority and estimate with todo_update — don't start it.`,
  );
  // It fills it in (todo_update): the mark goes, the card shows what it wrote.
  expect(await agentUpdates(id, todoId, { description: 'The login test fails ~1 in 20 runs.', plan: '1. Find the race\n2. Fix it', priority: 'high', estimate_minutes: 30, estimateMinutes: 30 })).toBe(200);
  await expect(item.getByTestId('todo-enrich-waiting')).toHaveCount(0);
  await expect(item.getByTestId('todo-priority')).toHaveText('High');
  await expect(item.getByTestId('todo-estimate')).toHaveText('~30m');
  await idle(page, id);
  await expect(messages).toHaveCount(2);

  // Outside a session: the palette lists the sessions to pick (recent first); the toast opens it.
  await page.goto(`${world.baseUrl}/inbox`);
  await page.keyboard.press('Control+k');
  await input.fill('todo Rename the settings keys');
  await expect.poll(() => rows(page)).toEqual(['todo | capture-palette | add “Rename the settings keys”', 'todo | capture-other | add “Rename the settings keys”']);
  await page.getByTestId('palette-row').filter({ hasText: 'capture-other' }).click();
  await expect(page.getByTestId('modal-palette')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toContainText('Added to todos');
  await page.getByTestId('toast-jump').click();
  await expect(page).toHaveURL(`${world.baseUrl}/sessions/${other.id}`);
  await expandStrip(page);
  await expect(page.getByTestId('todo-strip').getByTestId('todo-title')).toHaveText(['Rename the settings keys']);
});

test('a selection in the chat → Add to todo: generated title and the quoted selection, editable, saved bare and waiting', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(world.baseUrl);
  const task = 'The checkout page flickers when the cart updates.\nIt only happens on Safari with two tabs open.';
  const { id } = await world.startSession(page, 'capture-selection', task);
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const bubble = page.locator('[data-testid="chat-message"][data-role="user"]').first();
  await expect(bubble).toContainText('flickers');
  await idle(page, id);
  // Select the bubble's text (what a drag or a touch long-press does).
  await bubble.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el.querySelector('.sb-md, p, div') ?? el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  const action = page.getByTestId('selection-todo');
  await expect(action).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'selection-action.png') });
  await action.click();
  const popover = page.getByTestId('selection-todo-popover');
  await expect(popover).toBeVisible();
  await expect(popover.getByTestId('selection-todo-title')).toHaveValue('The checkout page flickers when the cart updates.');
  await expect(popover.getByTestId('selection-todo-note')).toHaveValue(/^> The checkout page flickers when the cart updates\.\n> It only happens on Safari with two tabs open\.$/);
  await page.screenshot({ path: path.join(SHOTS, 'selection-popover.png') });
  await popover.getByTestId('selection-todo-title').fill('Fix the checkout flicker on Safari');
  await popover.getByTestId('selection-todo-save').click();
  await expect(popover).toHaveCount(0);
  await expandStrip(page);
  const item = page.getByTestId('todo-strip').getByTestId('todo-item');
  await expect(item.getByTestId('todo-title')).toHaveText('Fix the checkout flicker on Safari');
  await expect(item.getByTestId('todo-enrich-waiting')).toBeVisible();
  await expect(item.getByTestId('todo-description').locator('blockquote')).toContainText('The checkout page flickers');
  // Esc / Cancel close the popover without saving; a collapsed selection shows no action.
  await bubble.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  await page.getByTestId('selection-todo').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('selection-todo-popover')).toHaveCount(0);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(page.getByTestId('selection-todo')).toHaveCount(0);
  await expect(item).toHaveCount(1);
});

test('the share page at phone size: what was shared, "Add to which session?", recent first; a tap saves it there', async ({ page }) => {
  await page.goto(world.baseUrl);
  const { id } = await world.startSession(page, 'capture-share', 'Reply with just OK.');
  await page.setViewportSize({ width: 360, height: 780 });
  const query = new URLSearchParams({ title: 'Read: flaky tests at scale', text: 'Worth a look before the retry work.', url: 'https://example.com/flaky' });
  await page.goto(`${world.baseUrl}/share?${query.toString()}`);
  await expect(page.getByTestId('view-share')).toBeVisible();
  await expect(page.getByTestId('share-title')).toHaveValue('Read: flaky tests at scale');
  await expect(page.getByTestId('share-note')).toHaveText('Worth a look before the retry work.\n\nhttps://example.com/flaky');
  const sessions = page.getByTestId('share-session');
  await expect(sessions.first()).toHaveAttribute('data-session-id', id);
  await page.screenshot({ path: path.join(SHOTS, 'share-picker-360.png') });
  await sessions.first().click();
  await expect(page.getByTestId('share-saved')).toContainText('Added to capture-share');
  await expect(page).toHaveURL(`${world.baseUrl}/share`);
  const list = await page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${sessionId}/todos`)).json()) as { todos: Array<Record<string, unknown>> }, id);
  expect(list.todos[0]).toMatchObject({ title: 'Read: flaky tests at scale', description: 'Worth a look before the retry work.\n\nhttps://example.com/flaky', capturedFrom: 'share', needsEnrichment: true });
  await page.getByTestId('share-open').click();
  await expect(page).toHaveURL(`${world.baseUrl}/sessions/${id}`);
});
