import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import type { SessionDraft } from '../../src/core/drafts.ts';
import type { Review } from '../../src/core/reviews.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D88 oracle, real path (no demo seed): `node src/server/main.ts` with fake-claude.
 * What is typed and not sent stays with the session on the server: the composer
 * survives switching sessions, a reload and another device (a second browser
 * context); the focus rule keeps a field being typed in from being overwritten;
 * sending clears it; a question's "Other…" answer and picked option, a review
 * card's Send-back comment and the todo + Add form come back too.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('drafts');
});

test.afterAll(async () => {
  await world?.stop();
});

async function drafts(page: Page, id: string): Promise<SessionDraft[]> {
  return page.evaluate(async (sid) => (await (await fetch(`/api/sessions/${encodeURIComponent(sid)}/drafts`)).json()) as SessionDraft[], id);
}

async function draftValue(page: Page, id: string, field: string): Promise<unknown> {
  return (await drafts(page, id)).find((draft) => draft.field === field)?.value ?? null;
}

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sid) => (await (await fetch(`/api/sessions/${encodeURIComponent(sid)}`)).json()) as SessionDetail, id);
}

async function settled(page: Page, id: string): Promise<void> {
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 20_000 }).not.toBe('run');
}

function row(page: Page, id: string) {
  return page.locator(`a.sb-session[data-session-id="${id}"]`);
}

test('composer: kept across a session switch, a reload and a second device; the focus rule; sending clears it', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/`);
  const { id: a } = await world.startSession(page, 'drafts-a', 'Say hi.');
  const { id: b } = await world.startSession(page, 'drafts-b', 'Say hello.');
  await settled(page, a);
  await settled(page, b);
  await openWithHub(page, `${world.baseUrl}/sessions/${a}`);
  const input = page.getByTestId('chat-input');
  await input.click();
  await input.pressSequentially('half a thought');
  // Saved ~400 ms after the last key.
  await expect.poll(() => draftValue(page, a, 'composer')).toEqual({ text: 'half a thought', attachments: [] });

  // Switch to B (in the app) and back: restored; B's own composer is empty.
  await row(page, b).click();
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-session-id', b);
  await expect(input).toHaveValue('');
  await row(page, a).click();
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-session-id', a);
  await expect(input).toHaveValue('half a thought');

  // Typed and switched away at once (before the pause): saved on the way out.
  await input.click();
  await input.press('End');
  await input.pressSequentially(', more');
  await row(page, b).click();
  await expect.poll(() => draftValue(page, a, 'composer')).toEqual({ text: 'half a thought, more', attachments: [] });

  // A reload restores it.
  await openWithHub(page, `${world.baseUrl}/sessions/${a}`);
  await expect(input).toHaveValue('half a thought, more');

  // Another device (a second browser context) sees it, and follows live while its field has no focus.
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const phone = await other.newPage();
    await phone.goto(`${world.baseUrl}/`);
    await openWithHub(phone, `${world.baseUrl}/sessions/${a}`);
    const phoneInput = phone.getByTestId('chat-input');
    await expect(phoneInput).toHaveValue('half a thought, more');
    await input.fill('edited on the desktop');
    await input.blur();
    await expect(phoneInput).toHaveValue('edited on the desktop');

    // The focus rule: the phone is typing; the desktop's change does not overwrite it.
    await phoneInput.click();
    await phoneInput.press('End');
    await phoneInput.pressSequentially(' + phone');
    await expect.poll(() => draftValue(page, a, 'composer')).toEqual({ text: 'edited on the desktop + phone', attachments: [] });
    await expect(input).toHaveValue('edited on the desktop + phone');
    await input.fill('desktop again');
    await input.blur();
    await expect.poll(() => draftValue(page, a, 'composer')).toEqual({ text: 'desktop again', attachments: [] });
    await phone.waitForTimeout(700);
    await expect(phoneInput).toHaveValue('edited on the desktop + phone');
    // Typing on: the phone's text is saved (last write wins) and the desktop follows.
    await phoneInput.pressSequentially('!');
    await expect.poll(() => draftValue(page, a, 'composer')).toEqual({ text: 'edited on the desktop + phone!', attachments: [] });
    await expect(input).toHaveValue('edited on the desktop + phone!');
    await phoneInput.blur();
    await expect(phoneInput).toHaveValue('edited on the desktop + phone!');

    // Sending clears the draft, here and on the other device.
    await input.click();
    await input.press('Enter');
    await expect(page.getByTestId('chat-message').filter({ hasText: 'edited on the desktop + phone!' })).toHaveCount(1);
    await expect(input).toHaveValue('');
    await expect.poll(() => drafts(page, a)).toEqual([]);
    await expect(phoneInput).toHaveValue('');
    await openWithHub(page, `${world.baseUrl}/sessions/${a}`);
    await expect(input).toHaveValue('');
  } finally {
    await other.close();
  }
});

test('a question card\'s "Other…" answer and picked option come back after a switch and a reload', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'drafts-ask', '[fake:ask-2q] Ask me about the button.');
  const { id: elsewhere } = await world.startSession(page, 'drafts-elsewhere', 'Say hi.');
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 20_000 }).toBe('need');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const card = page.getByTestId('session-chat').getByTestId('question-card');
  const [first, second] = [card.getByTestId('question').nth(0), card.getByTestId('question').nth(1)];
  await first.getByTestId('question-option').nth(1).click();
  await second.getByTestId('question-other').click();
  await second.getByTestId('question-own-input').pressSequentially('Medium, rounded');
  const batch = (await detail(page, id)).questions[0]?.batchId ?? '';
  await expect.poll(async () => JSON.stringify(await draftValue(page, id, `question:${batch}`))).toContain('Medium, rounded');

  await row(page, elsewhere).click();
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-session-id', elsewhere);
  await row(page, id).click();
  await expect(first.getByTestId('question-option').nth(1)).toHaveAttribute('data-selected', 'true');
  await expect(second.getByTestId('question-own-answer')).toHaveText('Medium, rounded');

  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(first.getByTestId('question-option').nth(1)).toHaveAttribute('data-selected', 'true');
  await expect(second.getByTestId('question-own-answer')).toHaveText('Medium, rounded');

  // Sending the answers clears the draft.
  await card.getByTestId('question-send').click();
  await expect.poll(() => drafts(page, id)).toEqual([]);
});

test('the review card\'s Send-back comment and the todo + Add form come back after a reload; Cancel clears them', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'drafts-review', '[fake:write microfrontends/acme-app-front/notes.md]');
  await expect
    .poll(async () => (await page.evaluate(async () => (await fetch('/api/reviews')).json() as Promise<Review[]>)).filter((r) => r.sessionId === id && r.state === 'pending').length, { timeout: 30_000 })
    .toBe(1);
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);

  // + Add (the composer's "+ Todo" while the list is empty): a title and an estimate.
  await page.getByTestId('chat-todo-add').click();
  await page.getByTestId('todo-form-title').pressSequentially('Write the release notes');
  await page.getByTestId('todo-form-estimate').fill('45m');
  await expect.poll(() => draftValue(page, id, 'todo-add')).toMatchObject({ title: 'Write the release notes', estimate: '45m', plan: 'No plan', priority: 'medium' });

  // Send back: a comment.
  await page.getByTestId('session-review-badge').click();
  const card = page.getByTestId('session-review-panel').getByTestId('review-card');
  await card.locator('[data-action="send-back"]').click();
  await card.getByTestId('review-comment').pressSequentially('Please add a changelog line');
  const reviewId = (await card.getAttribute('data-review-id')) ?? '';
  await expect.poll(() => draftValue(page, id, `review:${reviewId}`)).toEqual({ comment: 'Please add a changelog line' });

  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('todo-form')).toBeVisible();
  await expect(page.getByTestId('todo-form-title')).toHaveValue('Write the release notes');
  await expect(page.getByTestId('todo-form-estimate')).toHaveValue('45m');
  await page.getByTestId('session-review-badge').click();
  await expect(card.getByTestId('review-send-back-form')).toBeVisible();
  await expect(card.getByTestId('review-comment')).toHaveValue('Please add a changelog line');

  // Cancel drops each draft.
  await card.getByTestId('review-form-cancel').click();
  await expect.poll(() => draftValue(page, id, `review:${reviewId}`)).toBeNull();
  await page.getByTestId('todo-form-cancel').click();
  await expect.poll(() => drafts(page, id)).toEqual([]);
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('todo-form')).toHaveCount(0);
});

async function machineDraft(page: Page): Promise<unknown> {
  return page.evaluate(async () => ((await (await fetch('/api/drafts')).json()) as SessionDraft[]).find((draft) => draft.field === 'new-session')?.value ?? null);
}

test('ruling 2026-10-09: the New-session form is kept per machine; Cancel keeps it, another device sees it, Clear and Start clear it', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/`);
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal).toHaveAttribute('data-mode', 'simple');
  const message = modal.getByTestId('ns-message');
  await message.click();
  await message.pressSequentially('Half a plan for the onboarding screen');
  await expect.poll(() => machineDraft(page)).toMatchObject({ form: { task: 'Half a plan for the onboarding screen' }, simpleBranch: null });
  await expect(modal.getByTestId('ns-clear-draft')).toBeVisible();

  // Cancel keeps it (a mail draft); the dialog opens with it again, also after a reload.
  await modal.getByTestId('ns-cancel').click();
  await expect(modal).toHaveCount(0);
  await page.getByTestId('new-session').click();
  await expect(message).toHaveValue('Half a plan for the onboarding screen');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByTestId('new-session').click();
  await expect(message).toHaveValue('Half a plan for the onboarding screen');
  // Full shares the form state (and so the draft).
  await modal.getByTestId('ns-mode-full').click();
  await expect(modal.getByTestId('ns-task')).toHaveValue('Half a plan for the onboarding screen');
  await expect(modal.getByTestId('ns-clear-draft')).toHaveText('Clear draft');
  await page.screenshot({ path: 'test-results/d88-new-session-clear-draft.png' });
  await modal.getByTestId('ns-mode-simple').click();

  // Another device opens the dialog with it.
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const phone = await other.newPage();
    await phone.goto(`${world.baseUrl}/`);
    await phone.getByTestId('new-session').click();
    const phoneMessage = phone.getByTestId('modal-new-session').getByTestId('ns-message');
    await expect(phoneMessage).toHaveValue('Half a plan for the onboarding screen');

    // Clear: the text and the draft go here; the other device, its field focused, keeps its text until it leaves it (the focus rule).
    await phoneMessage.focus();
    await modal.getByTestId('ns-clear-draft').click();
    await expect(message).toHaveValue('');
    await expect(modal.getByTestId('ns-clear-draft')).toHaveCount(0);
    await expect.poll(() => machineDraft(page)).toBeNull();
    await phone.waitForTimeout(700);
    await expect(phoneMessage).toHaveValue('Half a plan for the onboarding screen');
    await phoneMessage.blur();
    await expect(phoneMessage).toHaveValue('');
  } finally {
    await other.close();
  }

  // Typed again, then started: the draft is done with.
  await message.click();
  await message.pressSequentially('Say hi.');
  await expect.poll(() => machineDraft(page)).toMatchObject({ form: { task: 'Say hi.' } });
  await modal.getByTestId('ns-start').click();
  await expect(page.getByTestId('view-session')).toBeVisible();
  await expect.poll(() => machineDraft(page)).toBeNull();
  await page.getByTestId('new-session').click();
  await expect(message).toHaveValue('');
});

test('ruling 2026-10-09: the Commit message as edited comes back; a review resolved elsewhere and a deleted todo take their drafts with them', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'drafts-commit', '[fake:write microfrontends/acme-app-front/commit-notes.md]');
  await expect
    .poll(async () => (await page.evaluate(async () => (await fetch('/api/reviews')).json() as Promise<Review[]>)).filter((r) => r.sessionId === id && r.state === 'pending').length, { timeout: 30_000 })
    .toBe(1);
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await page.getByTestId('session-review-badge').click();
  const card = page.getByTestId('session-review-panel').getByTestId('review-card');
  const reviewId = (await card.getAttribute('data-review-id')) ?? '';
  await card.locator('[data-action="commit"]').click();
  const box = card.getByTestId('review-commit-message');
  const drafted = await box.inputValue();
  await box.fill('docs: commit notes, reworded');
  await expect.poll(() => draftValue(page, id, `commit:${reviewId}`)).toEqual({ message: 'docs: commit notes, reworded' });

  // A reload: the Commit form opens with the edited message.
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await page.getByTestId('session-review-badge').click();
  await expect(card.getByTestId('review-commit-form')).toBeVisible();
  await expect(box).toHaveValue('docs: commit notes, reworded');
  // Back to the drafted message: no draft.
  await box.fill(drafted);
  await expect.poll(() => draftValue(page, id, `commit:${reviewId}`)).toBeNull();
  await box.fill('docs: reworded again');
  await expect.poll(() => draftValue(page, id, `commit:${reviewId}`)).toEqual({ message: 'docs: reworded again' });
  await box.blur();

  // A todo with an open Edit form, then deleted from another device (a direct API call).
  const added = await page.evaluate(async (sid) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/todos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Edit me', text: 'Edit me' }) });
    return (await response.json()) as { todos: Array<{ id: string }> };
  }, id);
  const todoId = added.todos[0]?.id ?? '';
  await page.evaluate(
    async ({ sid, field }) =>
      fetch(`/api/sessions/${encodeURIComponent(sid)}/drafts/${encodeURIComponent(field)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: { title: 'Edit me more', description: '', plan: 'No plan', priority: 'medium', estimate: '' } }) }),
    { sid: id, field: `todo-edit:${todoId}` },
  );
  await expect.poll(() => draftValue(page, id, `todo-edit:${todoId}`)).not.toBeNull();
  await page.evaluate(async ({ sid, tid }) => fetch(`/api/sessions/${encodeURIComponent(sid)}/todos/${encodeURIComponent(tid)}`, { method: 'DELETE' }), { sid: id, tid: todoId });
  await expect.poll(() => draftValue(page, id, `todo-edit:${todoId}`)).toBeNull();

  // The review is resolved elsewhere (Dismiss from another device): its drafts go at once, and the card's text with them.
  await page.evaluate(async (rid) => fetch(`/api/reviews/${encodeURIComponent(rid)}/dismiss`, { method: 'POST' }), reviewId);
  await expect.poll(() => draftValue(page, id, `commit:${reviewId}`)).toBeNull();
  await expect.poll(() => drafts(page, id)).toEqual([]);
});
