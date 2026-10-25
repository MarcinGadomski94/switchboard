import { expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · lane R · the v2 + New sheet on the real code path (a server with fake
 * claude and one saved workspace folder): start an agent, add a task to an agent,
 * make a routine, Save as draft (the sheet reopens with it), and the phone's
 * full-screen sheet.
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-new', { env: { ...V2_SERVER_ENV } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

interface TodoWire {
  readonly todos: ReadonlyArray<{ readonly title: string; readonly priority: string; readonly estimateMinutes: number | null }>;
}

test('+ New starts an agent in the chosen folder and opens it', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  await page.getByTestId('v2-new').click();
  const sheet = page.getByTestId('v2-new-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('v2-new-kind-agent')).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.locator('.v2-new-type b')).toHaveText(['Agent', 'Conversation', 'Task', 'Project', 'Routine', 'Teammate', 'Crew']);
  await expect(sheet.getByTestId('v2-new-folder')).toHaveCount(1);
  await expect(sheet.getByTestId('v2-new-folder')).toHaveAttribute('aria-pressed', 'true');

  // Start without a message: it says why, inline.
  await sheet.getByTestId('v2-new-go').click();
  await expect(sheet.getByTestId('v2-new-problems')).toHaveText('Say what it should do.');

  await sheet.getByTestId('v2-new-message').fill('Summarise the README for me');
  await sheet.getByTestId('v2-new-speed').getByRole('button', { name: 'Fast · cheaper' }).click();
  await sheet.getByTestId('v2-new-go').click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/agents\/[^/]+$/);
  const id = decodeURIComponent(new URL(page.url()).pathname.split('/')[2] ?? '');
  const session = await page.evaluate(async (sid) => (await (await fetch(`/api/sessions/${sid}`)).json()) as { task: string | null; model?: { current: string | null } | null }, id);
  expect(JSON.stringify(session)).toContain('Summarise the README for me');
});

test('+ New adds a task to an agent and makes a routine for it', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  const owner = await world.startSession(page, 'owner', 'Hello');

  // A task (⌘↩ submits).
  await page.getByTestId('v2-new').click();
  const sheet = page.getByTestId('v2-new-sheet');
  await sheet.getByTestId('v2-new-kind-task').click();
  await sheet.getByTestId('v2-new-task-title').fill('Empty-cart state on phones');
  await sheet.getByTestId('v2-new-task-description').fill('Below 400 px it uses the old layout.');
  await sheet.getByTestId('v2-new-task-agent').selectOption(owner.id);
  await sheet.getByTestId('v2-new-task-title').press('ControlOrMeta+Enter');
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('v2-toast')).toContainText('Task added to owner');
  const todos = await page.evaluate(async (sid) => (await (await fetch(`/api/sessions/${sid}/todos`)).json()) as TodoWire, owner.id);
  expect(todos.todos.map((item) => item.title)).toContain('Empty-cart state on phones');
  expect(todos.todos.find((item) => item.title === 'Empty-cart state on phones')).toMatchObject({ priority: 'medium', estimateMinutes: 30 });

  // A routine on a plain-words schedule.
  await page.getByTestId('v2-new').click();
  await sheet.getByTestId('v2-new-kind-routine').click();
  await sheet.getByTestId('v2-new-routine-prompt').fill('Check the checkout page loads');
  await sheet.getByTestId('v2-new-routine-how').selectOption('weekdays');
  await sheet.getByTestId('v2-new-routine-agent').selectOption(owner.id);
  await expect(sheet.getByTestId('v2-new-go')).toHaveText('Create routine');
  await sheet.getByTestId('v2-new-go').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Routine added to owner' })).toBeVisible();
  const loops = await page.evaluate(async (sid) => (await (await fetch(`/api/sessions/${sid}/loops`)).json()) as Array<{ prompt: string; schedule: { kind: string; cron?: string } }>, owner.id);
  expect(loops).toHaveLength(1);
  expect(loops[0]).toMatchObject({ prompt: 'Check the checkout page loads', schedule: { kind: 'cron', cron: '0 8 * * 1-5' } });
});

test('Save as draft keeps what is typed; the sheet reopens with it', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  await page.getByTestId('v2-new').click();
  const sheet = page.getByTestId('v2-new-sheet');
  await sheet.getByTestId('v2-new-kind-task').click();
  await sheet.getByTestId('v2-new-task-title').fill('Draft task title');
  await sheet.getByTestId('v2-new-draft').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('v2-toast')).toContainText('Draft saved');

  await page.reload();
  await page.getByTestId('v2-new').click();
  await expect(sheet.getByTestId('v2-new-restored')).toBeVisible();
  await expect(sheet.getByTestId('v2-new-kind-task')).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.getByTestId('v2-new-task-title')).toHaveValue('Draft task title');
  // Clear draft: the defaults again, and the server forgets it.
  await sheet.getByTestId('v2-new-clear-draft').click();
  await expect(sheet.getByTestId('v2-new-task-title')).toHaveValue('');
  await expect.poll(async () => page.evaluate(async () => ((await (await fetch('/api/drafts')).json()) as unknown[]).length)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

test('phone (390 × 844): + New fills the screen; a crew is made from it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/`);
  await page.getByTestId('v2-new').click();
  const sheet = page.getByTestId('v2-new-sheet');
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(388);
  expect(box?.height).toBeGreaterThanOrEqual(800);
  // The kinds scroll sideways; every one is a 44 px+ target.
  const kind = sheet.getByTestId('v2-new-kind-crew');
  await kind.scrollIntoViewIfNeeded();
  expect((await kind.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await kind.click();
  // Crew is the Crews page's New crew dialog (lane X: one New crew), which takes over from the sheet.
  const dialog = page.getByTestId('v2-new-crew');
  await expect(dialog).toBeVisible();
  await expect(sheet).toHaveCount(0);
  await dialog.getByTestId('v2-new-crew-name').fill('Acme Growth');
  await dialog.getByTestId('v2-new-crew-go').click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/crews\/[^/]+$/);
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Acme Growth' })).toBeVisible();
});

test('Teammate opens the Crews page’s New teammate dialog; Project › Import from Jira opens the v2 import dialog', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  await page.getByTestId('v2-new').click();
  const sheet = page.getByTestId('v2-new-sheet');
  await sheet.getByTestId('v2-new-kind-teammate').click();
  const mate = page.getByTestId('v2-new-teammate');
  await expect(mate).toBeVisible();
  await expect(sheet).toHaveCount(0);
  // Its richer form: role templates, adopting an existing agent, the crew it joins.
  await expect(mate.getByTestId('v2-new-teammate-role').first()).toBeVisible();
  await expect(mate.getByTestId('v2-new-teammate-adopt')).toBeVisible();
  await expect(mate.getByTestId('v2-new-teammate-crew')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(mate).toHaveCount(0);
  // + New › Project › Import from Jira: the Projects page's v2 dialog (lane X: one Jira import), over the sheet.
  await page.getByTestId('v2-new').click();
  await page.getByTestId('v2-new-sheet').getByTestId('v2-new-kind-project').click();
  await page.getByTestId('v2-new-jira').click();
  const jira = page.getByTestId('v2-jira-import');
  await expect(jira).toBeVisible();
  await expect(jira.getByTestId('v2-jira-import-epic')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(jira).toHaveCount(0);
});
