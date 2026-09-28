import { type Page, expect, test } from '@playwright/test';
import type { InboxItem } from '../../src/core/api.ts';
import { type QuestionWorld, clickNotification, installNotificationMocks, openWithHub, readMocks, startQuestionWorld } from './question-world.ts';

/**
 * M3.4 oracle (E2E with a mocked Notification and AudioContext) on the real code
 * path (no demo seed, D13): fake-claude sessions ask through the question pipeline,
 * the server publishes `/hub` `questionBatch`, and the page shows the toast
 * (SPEC → Modals → Toast), plays the two-tone chime and sends an OS notification
 * when allowed. "Jump to session", "Later", ✕ and a click on the OS notification.
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-notify');
});

test.afterAll(async () => {
  await world?.stop();
});

/** The waiting batch of a session, from `GET /api/inbox`. */
async function batchOf(page: Page, sessionId: string): Promise<InboxItem> {
  const items = await page.evaluate(async () => (await (await fetch('/api/inbox')).json()) as InboxItem[]);
  const item = items.find((entry) => entry.kind === 'questions' && entry.sessionId === sessionId);
  if (!item) throw new Error(`no batch for ${sessionId}`);
  return item;
}

const CHIME_TONES = [
  { hz: 784, start: 0, stop: 0.25, toDestination: true },
  { hz: 1046, start: 0.14, stop: 0.39, toDestination: true },
];
const CHIME_GAINS = ['set 0.0001 @0', 'ramp 0.12 @0.02', 'ramp 0.0001 @0.22', 'set 0.0001 @0.14', 'ramp 0.12 @0.16', 'ramp 0.0001 @0.36'];

test('a question batch: toast + chime + OS notification (granted) together; Jump to session opens the session', async ({ page }) => {
  await installNotificationMocks(page, 'granted');
  await openWithHub(page, `${world.baseUrl}/inbox`);
  const toast = page.getByTestId('toast');
  await expect(toast).toHaveCount(0);

  const session = await world.startSession(page, 'qa-free-talk', '[fake:ask-delay] Ask me where to deploy.', true);

  // The toast (SPEC → Modals → Toast): dot, title, sub, branch line, the question verbatim; Jump to session / Later.
  await expect(toast).toBeVisible();
  await expect(toast.locator('.sb-toast-title')).toHaveText('qa-free-talk');
  await expect(toast.locator('.sb-toast-sub')).toHaveText('question · now');
  await expect(toast.locator('.sb-toast-branch')).toHaveText('acme-app-front ⎇ PROJ-1-qa-free-talk');
  await expect(toast.locator('.sb-toast-text')).toHaveText('Which environment should I target?');
  await expect(toast.getByRole('button')).toHaveText(['✕', 'Jump to session', 'Later']);
  // Top-right, 16 px in (prototype); `width: 360px` + padding + border like the prototype's inline style.
  await expect(toast).toHaveCSS('width', '360px');
  const box = await toast.boundingBox();
  expect(box && { right: box.x + box.width, y: box.y }).toEqual({ right: 1440 - 16, y: 16 });

  // The chime (784 Hz → 1046 Hz, prototype envelope) and the OS notification, once.
  const batch = await batchOf(page, session.id);
  const mocks = await readMocks(page);
  expect(mocks.contexts).toBe(1);
  expect(mocks.tones).toEqual(CHIME_TONES);
  expect(mocks.gains).toEqual(CHIME_GAINS);
  expect(mocks.notifications).toEqual([
    { title: 'qa-free-talk needs you', body: 'Which environment should I target?', tag: `switchboard-batch-${batch.id}`, closed: false },
  ]);
  expect(mocks.permissionRequests).toBe(0);
  // The chime's context is closed once the tones have stopped.
  await expect.poll(async () => (await readMocks(page)).closed).toBe(1);

  // The same batch is in the Inbox list behind the toast.
  await expect(page.getByTestId('inbox-item')).toHaveCount(1);
  await expect(page.getByTestId('inbox-title')).toHaveText('Which environment should I target?');

  // Jump to session: the session view (chat tab), the toast is gone.
  await toast.getByRole('button', { name: 'Jump to session' }).click();
  await expect(toast).toHaveCount(0);
  await expect(page).toHaveURL(`${world.baseUrl}/sessions/${session.id}`);
  const view = page.getByTestId('view-session');
  await expect(view).toHaveAttribute('data-session-id', session.id);
  await expect(view).toHaveAttribute('data-tab', 'chat');
  const after = await readMocks(page);
  expect(after.contexts).toBe(1);
  expect(after.notifications).toHaveLength(1);
  expect(after.focus).toBe(0);
});

test('without the OS permission: toast + chime only, never a permission prompt; Later and ✕ dismiss without leaving the view', async ({ page }) => {
  await installNotificationMocks(page, 'default');
  await openWithHub(page, `${world.baseUrl}/history`);
  const toast = page.getByTestId('toast');

  await world.startSession(page, 'asker', '[fake:ask-2q] Ask me two questions.');
  await expect(toast).toBeVisible();
  await expect(toast.locator('.sb-toast-title')).toHaveText('asker');
  await expect(toast.locator('.sb-toast-sub')).toHaveText('2 questions · now');
  // No worktree, no agent branch: no branch line.
  await expect(toast.locator('.sb-toast-branch')).toHaveCount(0);
  await expect(toast.locator('.sb-toast-text')).toHaveText('Which color should the button be?');
  let mocks = await readMocks(page);
  expect(mocks.contexts).toBe(1);
  expect(mocks.tones).toEqual(CHIME_TONES);
  expect(mocks.notifications).toEqual([]);
  expect(mocks.permissionRequests).toBe(0);

  // Later: gone, the view stays.
  await toast.getByRole('button', { name: 'Later' }).click();
  await expect(toast).toHaveCount(0);
  await expect(page).toHaveURL(`${world.baseUrl}/history`);

  // Another batch: a new toast and a new chime; ✕ closes it.
  await world.startSession(page, 'second-asker', '[fake:ask-delay] Ask me where to deploy.');
  await expect(toast).toBeVisible();
  await expect(toast.locator('.sb-toast-title')).toHaveText('second-asker');
  await expect(toast.locator('.sb-toast-sub')).toHaveText('question · now');
  mocks = await readMocks(page);
  expect(mocks.contexts).toBe(2);
  expect(mocks.notifications).toEqual([]);
  await toast.getByRole('button', { name: 'Close' }).click();
  await expect(toast).toHaveCount(0);
  await expect(page).toHaveURL(`${world.baseUrl}/history`);
});

test('a click on the OS notification focuses the page and jumps to the session', async ({ page }) => {
  await installNotificationMocks(page, 'granted');
  await openWithHub(page, `${world.baseUrl}/settings`);
  const toast = page.getByTestId('toast');

  const session = await world.startSession(page, 'jumper', '[fake:ask-delay] Ask me where to deploy.');
  await expect(toast).toBeVisible();
  await expect.poll(async () => (await readMocks(page)).notifications.length).toBe(1);
  expect((await readMocks(page)).notifications[0]?.title).toBe('jumper needs you');

  await clickNotification(page, 0);
  await expect(page).toHaveURL(`${world.baseUrl}/sessions/${session.id}`);
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-session-id', session.id);
  await expect(toast).toHaveCount(0);
  const mocks = await readMocks(page);
  expect(mocks.focus).toBe(1);
  expect(mocks.notifications[0]?.closed).toBe(true);
});
