import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.0 · classic's todo cards in v2 (`shared/TodoCard.tsx`): the agent view's
 * "Tasks n/m" opens a strip of cards above the box (collapsed by default, remembered per
 * browser), ▶ Start and ▸ Run from a card, Edit and done / reopen, delete with Undo, the
 * details in place, the side panel's cards, the Tasks page's cards, the peek and a phone;
 * the chat keeps its room with the strip collapsed (`v2-agent-space.spec.ts`'s measures).
 */
let world: QuestionWorld;
let sessionId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-todo-cards', { env: { ...V2_SERVER_ENV } });
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
  readonly priority: string;
  readonly estimateMinutes: number | null;
}

async function todosOf(page: Page, id: string): Promise<readonly TodoWire[]> {
  return page.evaluate(async (sid) => ((await (await fetch(`/api/sessions/${sid}/todos`)).json()) as { todos: TodoWire[] }).todos, id);
}

async function addTodo(page: Page, id: string, body: Record<string, unknown>): Promise<void> {
  const status = await page.evaluate(
    async ({ sid, fields }) => (await fetch(`/api/sessions/${sid}/todos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, text: fields['title'] }) })).status,
    { sid: id, fields: body },
  );
  expect(status).toBeLessThan(300);
}

async function settled(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => page.evaluate(async (sid) => ((await (await fetch(`/api/sessions/${encodeURIComponent(sid)}`)).json()) as SessionDetail).status, id), { timeout: 20_000 })
    .toMatch(/^(done|idle)$/);
}

function stripCard(page: Page, title: string) {
  return page.getByTestId('v2-agent-taskstrip').getByTestId('v2-todo-card').filter({ has: page.getByTestId('v2-todo-title').getByText(title, { exact: true }) });
}

test('setup: an agent with three tasks', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'acme-cards', 'Reply with just OK.');
  sessionId = id;
  await settled(page, id);
  await addTodo(page, id, { title: 'Acme checkout copy', description: 'Plain words for the **checkout** page.', plan: 'Edit `checkout.md`; keep it under 80 words.', priority: 'high', estimateMinutes: 45 });
  await addTodo(page, id, { title: 'Acme footer overlap', description: null, plan: 'No plan', priority: 'urgent', estimateMinutes: null });
  await addTodo(page, id, { title: 'Acme docs pass', description: null, plan: 'No plan', priority: 'low', estimateMinutes: 20 });
  expect(await todosOf(page, id)).toHaveLength(3);
});

test('the status row opens the strip of cards; collapsed by default and remembered per browser', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/agents/${sessionId}`);
  const tasks = page.getByTestId('v2-agent-tasks');
  await expect(tasks).toContainText('Tasks 0/3');
  // Collapsed by default: only the one-line status row.
  await expect(tasks).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('v2-agent-taskstrip')).toHaveCount(0);
  await tasks.click();
  await expect(tasks).toHaveAttribute('aria-expanded', 'true');
  const cards = page.getByTestId('v2-agent-taskstrip').getByTestId('v2-todo-card');
  await expect(cards).toHaveCount(3);
  // Classic's order (urgent first) and its density: priority, estimate, plan mark, status in words.
  await expect(cards.first().getByTestId('v2-todo-title')).toHaveText('Acme footer overlap');
  const copy = stripCard(page, 'Acme checkout copy');
  await expect(copy.getByTestId('v2-todo-priority')).toHaveText('High');
  await expect(copy.getByTestId('v2-todo-estimate')).toHaveText('est 45m');
  await expect(copy.getByTestId('v2-todo-plan-mark')).toBeVisible();
  await expect(copy.getByTestId('v2-todo-status')).toHaveText('Open');
  // Side by side, one horizontal strip.
  const first = await cards.nth(0).boundingBox();
  const second = await cards.nth(1).boundingBox();
  expect(Math.abs((first?.y ?? 0) - (second?.y ?? 99))).toBeLessThan(2);
  expect(second?.x ?? 0).toBeGreaterThan((first?.x ?? 0) + (first?.width ?? 0) - 1);
  // The details open in place: the description and the handover plan.
  await copy.getByTestId('v2-todo-title').click();
  await expect(copy.getByTestId('v2-todo-description')).toContainText('Plain words for the checkout page.');
  await expect(copy.getByTestId('v2-todo-plan')).toContainText('keep it under 80 words');
  // Remembered: a reload keeps it open; closing it is remembered too.
  await page.reload();
  await expect(page.getByTestId('v2-agent-taskstrip').getByTestId('v2-todo-card')).toHaveCount(3);
  await page.getByTestId('v2-agent-tasks').click();
  await expect(page.getByTestId('v2-agent-taskstrip')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('v2-agent-tasks')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('v2-agent-taskstrip')).toHaveCount(0);
});

test('▶ Start from a card sends it to this agent; ▸ Run starts its own agent', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/agents/${sessionId}`);
  await page.getByTestId('v2-agent-tasks').click();
  const footer = stripCard(page, 'Acme footer overlap');
  await footer.getByTestId('v2-todo-start').click();
  await expect.poll(async () => (await todosOf(page, sessionId)).find((t) => t.title === 'Acme footer overlap')?.state).toBe('in_progress');
  await expect(footer).toHaveAttribute('data-state', 'in_progress');
  await expect(footer.getByTestId('v2-todo-status')).toHaveText(/In progress|Review/);
  await expect
    .poll(async () => JSON.stringify(await page.evaluate(async (sid) => (await (await fetch(`/api/sessions/${sid}/events`)).json()) as unknown, sessionId)), { timeout: 15_000 })
    .toContain('Acme footer overlap');
  await settled(page, sessionId);

  const before = await page.evaluate(async () => ((await (await fetch('/api/sessions')).json()) as unknown[]).length);
  await stripCard(page, 'Acme docs pass').getByTestId('v2-todo-run').click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Started a new agent for “Acme docs pass”' })).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => ((await (await fetch('/api/sessions')).json()) as unknown[]).length)).toBe(before + 1);
  // The card links its own agent and offers no second Run.
  await expect(stripCard(page, 'Acme docs pass').getByTestId('v2-todo-run-link')).toBeVisible();
  await expect(stripCard(page, 'Acme docs pass').getByTestId('v2-todo-run')).toBeDisabled();
});

test('Edit (title, priority, estimate, plan), mark done and reopen, delete with Undo', async ({ page }) => {
  test.setTimeout(60_000);
  await openWithHub(page, `${world.baseUrl}/agents/${sessionId}`);
  await page.getByTestId('v2-agent-tasks').click();
  const copy = stripCard(page, 'Acme checkout copy');
  await copy.getByTestId('v2-todo-menu').click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const dialog = page.getByTestId('v2-todo-edit');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('v2-todo-edit-title').fill('Acme checkout wording');
  await dialog.getByTestId('v2-todo-edit-priority').selectOption('urgent');
  await dialog.getByTestId('v2-todo-edit-estimate').fill('2h');
  await dialog.getByTestId('v2-todo-edit-plan').fill('Edit `checkout.md` only.');
  await dialog.getByTestId('v2-todo-edit-save').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await todosOf(page, sessionId)).find((t) => t.title === 'Acme checkout wording')).toMatchObject({ priority: 'urgent', estimateMinutes: 120 });
  const wording = stripCard(page, 'Acme checkout wording');
  await expect(wording.getByTestId('v2-todo-priority')).toHaveText('Urgent');

  // Mark done: Done in words, struck through, no Start; then reopen.
  await wording.getByTestId('v2-todo-check').click();
  await expect.poll(async () => (await todosOf(page, sessionId)).find((t) => t.title === 'Acme checkout wording')?.state).toBe('done');
  await expect(wording.getByTestId('v2-todo-status')).toHaveText('Done');
  await expect(wording.getByTestId('v2-todo-check')).toHaveAttribute('aria-checked', 'true');
  await expect(wording.getByTestId('v2-todo-start')).toHaveCount(0);
  await expect(page.getByTestId('v2-agent-tasks')).toContainText('Tasks 1/3');
  await wording.getByTestId('v2-todo-check').click();
  await expect.poll(async () => (await todosOf(page, sessionId)).find((t) => t.title === 'Acme checkout wording')?.state).toBe('open');

  // Delete with Undo: the card goes at once and comes back; nothing was deleted.
  await wording.getByTestId('v2-todo-menu').click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(wording).toHaveCount(0);
  await page.getByTestId('v2-toast').filter({ hasText: 'Deleted “Acme checkout wording”' }).getByTestId('v2-toast-undo').click();
  await expect(wording).toHaveCount(1);
  expect((await todosOf(page, sessionId)).some((t) => t.title === 'Acme checkout wording')).toBe(true);
});

test('the side panel shows the same cards, one under another', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/agents/${sessionId}`);
  const group = page.getByTestId('v2-agent-group-tasks');
  await group.locator('summary').click();
  const cards = group.getByTestId('v2-todo-card');
  await expect(cards).toHaveCount(3);
  const a = await cards.nth(0).boundingBox();
  const b = await cards.nth(1).boundingBox();
  expect(b?.y ?? 0).toBeGreaterThan((a?.y ?? 0) + (a?.height ?? 0) - 1);
  const wording = cards.filter({ hasText: 'Acme checkout wording' });
  await expect(wording.getByTestId('v2-todo-start')).toBeVisible();
  await expect(wording.getByTestId('v2-todo-run')).toBeVisible();
  // A check in the panel shows in the strip's count too.
  await wording.getByTestId('v2-todo-check').click();
  await expect(page.getByTestId('v2-agent-tasks')).toContainText('Tasks 1/3');
  await wording.getByTestId('v2-todo-check').click();
  await expect(page.getByTestId('v2-agent-tasks')).toContainText('Tasks 0/3');
});

test('the Tasks page uses the same cards (check box, status, details in place)', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/tasks`);
  const card = page.getByTestId('v2-tasks-card').filter({ has: page.getByTestId('v2-todo-title').getByText('Acme checkout wording', { exact: true }) });
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('v2-todo-status')).toHaveText('Open');
  await expect(card.getByTestId('v2-todo-priority')).toHaveText('Urgent');
  await expect(card.getByTestId('v2-tasks-agent')).toHaveText('acme-cards');
  await card.getByTestId('v2-todo-title').click();
  await expect(card.getByTestId('v2-todo-plan')).toContainText('Edit checkout.md only.');
  await card.getByTestId('v2-todo-check').click();
  await expect(page.getByTestId('v2-tasks-col-done').getByTestId('v2-tasks-card').filter({ hasText: 'Acme checkout wording' })).toHaveCount(1);
  await page.getByTestId('v2-tasks-col-done').getByTestId('v2-tasks-card').filter({ hasText: 'Acme checkout wording' }).getByTestId('v2-todo-check').click();
  await expect(page.getByTestId('v2-tasks-col-open').getByTestId('v2-tasks-card').filter({ hasText: 'Acme checkout wording' })).toHaveCount(1);
});

test('the peek has the status row and the strip too', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  await page.evaluate((id) => (window as unknown as { __sbV2Peek: (id: string) => void }).__sbV2Peek(id), sessionId);
  const peek = page.getByTestId('v2-agent-peek');
  await expect(peek).toBeVisible();
  await expect(peek.getByTestId('v2-agent-tasks')).toContainText('Tasks 0/3');
  await expect(peek.getByTestId('v2-agent-taskstrip')).toHaveCount(0);
  await peek.getByTestId('v2-agent-tasks').click();
  await expect(peek.getByTestId('v2-agent-taskstrip').getByTestId('v2-todo-card')).toHaveCount(3);
});

test('phone (390 × 844): collapsed by default, the strip of cards with 44 px targets, no page scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/agents/${sessionId}`);
  const tasks = page.getByTestId('v2-agent-tasks');
  await expect(tasks).toContainText('Tasks 0/3');
  await expect(page.getByTestId('v2-agent-taskstrip')).toHaveCount(0);
  expect((await tasks.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await tasks.click();
  const card = stripCard(page, 'Acme checkout wording');
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  expect(box?.width ?? 999).toBeLessThanOrEqual(390);
  for (const id of ['v2-todo-check', 'v2-todo-start', 'v2-todo-run', 'v2-todo-menu']) {
    expect((await card.getByTestId(id).boundingBox())?.height ?? 0, id).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Start works from the phone too.
  await card.getByTestId('v2-todo-start').click();
  await expect.poll(async () => (await todosOf(page, sessionId)).find((t) => t.title === 'Acme checkout wording')?.state).toBe('in_progress');
  await settled(page, sessionId);
});

test('the chat keeps its room with tasks present and the strip collapsed', async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await openWithHub(page, `${world.baseUrl}/agents/${sessionId}`);
    await expect(page.getByTestId('v2-agent-tasks')).toBeVisible();
    await expect(page.getByTestId('v2-agent-taskstrip')).toHaveCount(0);
    const dock = await page.getByTestId('v2-agent-dock').boundingBox();
    const chat = await page.getByTestId('v2-agent-chat').boundingBox();
    console.log(`[tasks collapsed ${viewport.width}x${viewport.height}] dock=${Math.round(dock?.height ?? -1)} chat=${Math.round(chat?.height ?? -1)}`);
    expect(dock?.height ?? 999).toBeLessThanOrEqual(viewport.height * 0.2);
    expect(chat?.height ?? 0).toBeGreaterThanOrEqual(viewport.height * 0.55);
  }
});
