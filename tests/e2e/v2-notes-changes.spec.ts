import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { agentMemory, approvedEntry, settledSession } from './memory-agent.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D135 · v2: an agent's proposals to change approved notes (real path, fake-claude). The Notes page
 * shows an edit as the note now vs as proposed (removed words struck, added ones marked) with
 * Approve / Edit first / Reject, and a removal with the note and the reason; the Needs-you queue
 * shows the same as "Note edit" / "Note removal" cards. Approve and reject from both; the phone width.
 */
let world: QuestionWorld;
let agentId = '';

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-notes-changes', { env: { ...V2_SERVER_ENV } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function notes(page: Page): Promise<Array<{ id: string; title: string; text: string; status: string }>> {
  return page.evaluate(async () => (await (await fetch('/api/memory/entries')).json()) as Array<{ id: string; title: string; text: string; status: string }>);
}

test('Notes: an edit side by side (Approve keeps the id, Edit first), a removal (Reject keeps it)', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/notes`);
  const agent = await world.startSession(page, 'notes-changer', 'Reply with just OK.');
  agentId = agent.id;
  await settledSession(page, agent.id);
  const buttonsId = await approvedEntry(world, page, agent.id, 'Acme buttons', 'Use the shared acme-ui buttons.');
  const currencyId = await approvedEntry(world, page, agent.id, 'Acme currency', 'Prices are shown in EUR.');
  expect((await agentMemory(world, agent.id, '/edit', { entry: buttonsId, text: 'Use the shared acme-ui buttons and icons.', reason: 'Icons moved into acme-ui.' })).status).toBe(201);
  expect((await agentMemory(world, agent.id, '/retract', { entry: currencyId, reason: 'Prices follow the visitor’s locale now.' })).status).toBe(201);

  const proposed = page.getByTestId('v2-notes-proposed').getByTestId('v2-notes-row');
  await expect(proposed).toHaveCount(2);
  const edit = proposed.and(page.locator('[data-change="edit"]'));
  await expect(edit.getByTestId('v2-notes-title')).toHaveText('Change “Acme buttons”');
  await expect(edit.getByTestId('v2-notes-change')).toHaveText('Edit');
  await expect(edit.getByTestId('v2-note-change-now-text')).toHaveText('Use the shared acme-ui buttons.');
  await expect(edit.getByTestId('v2-note-change-proposed-text')).toHaveText('Use the shared acme-ui buttons and icons.');
  await expect(edit.getByTestId('v2-note-change-now-text').locator('del')).toHaveText('buttons.');
  await expect(edit.getByTestId('v2-note-change-proposed-text').locator('ins')).toHaveText('buttons and icons.');
  await expect(edit.getByTestId('v2-note-change-reason')).toContainText('Icons moved into acme-ui.');
  await expect(edit.getByTestId('v2-notes-edit')).toHaveText(/Edit first/);
  const removal = proposed.and(page.locator('[data-change="retract"]'));
  await expect(removal.getByTestId('v2-notes-title')).toHaveText('Remove “Acme currency”');
  await expect(removal.getByTestId('v2-note-change-removed')).toContainText('Prices are shown in EUR.');
  await expect(removal.getByTestId('v2-notes-approve')).toHaveText(/Approve removal/);
  await expect(removal.getByTestId('v2-notes-edit')).toHaveCount(0);
  await page.screenshot({ path: path.join('test-results', 'v2-notes-changes.png') });

  // Edit first, then approve: the developer's text replaces the note; same id.
  await edit.getByTestId('v2-notes-edit').click();
  const dialog = page.getByTestId('v2-notes-edit-dialog');
  await expect(dialog.getByTestId('v2-notes-edit-text').locator('textarea').or(dialog.locator('textarea'))).toHaveValue('Use the shared acme-ui buttons and icons.');
  await dialog.locator('textarea').fill('Use the shared acme-ui buttons and icons everywhere.');
  await dialog.getByTestId('v2-notes-edit-save').click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'The note now reads as proposed.' })).toHaveCount(1);
  await expect.poll(async () => (await notes(page)).find((n) => n.id === buttonsId)?.text).toBe('Use the shared acme-ui buttons and icons everywhere.');

  // Reject the removal: the note stays.
  await removal.getByTestId('v2-notes-reject').click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'The note stays as it was.' })).toHaveCount(1);
  await expect(page.getByTestId('v2-notes-proposed')).toHaveCount(0);
  expect((await notes(page)).filter((n) => n.status === 'approved').map((n) => n.id).sort()).toEqual([buttonsId, currencyId].sort());
});

test('Needs you: "Note edit" and "Note removal" cards with the comparison; Approve and Reject', async ({ page }) => {
  test.skip(agentId === '', 'needs the first test’s agent');
  const all = await (async () => {
    await page.goto(`${world.baseUrl}/notes`);
    return notes(page);
  })();
  const buttons = all.find((n) => n.title === 'Acme buttons' && n.status === 'approved');
  const currency = all.find((n) => n.title === 'Acme currency' && n.status === 'approved');
  if (!buttons || !currency) throw new Error('the first test’s notes are missing');
  const second = await world.startSession(page, 'notes-changer-2', 'Reply with just OK.');
  await settledSession(page, second.id);
  expect((await agentMemory(world, second.id, '/edit', { entry: buttons.id, title: 'Acme buttons and icons', reason: 'Clearer title.' })).status).toBe(201);
  expect((await agentMemory(world, second.id, '/retract', { entry: currency.id, reason: 'Prices follow the locale.' })).status).toBe(201);

  await openWithHub(page, `${world.baseUrl}/needs-you`);
  const cards = page.getByTestId('v2-needs-list').getByTestId('v2-answer-card');
  const editCard = cards.and(page.locator('[data-kind="note-edit"]'));
  const removalCard = cards.and(page.locator('[data-kind="note-removal"]'));
  await expect(editCard).toHaveCount(1);
  await expect(removalCard).toHaveCount(1);
  await expect(editCard.locator('.v2-qi-head')).toContainText('Note edit');
  await expect(removalCard.locator('.v2-qi-head')).toContainText('Note removal');
  await expect(editCard.getByTestId('v2-note-change-now-title')).toHaveText('Acme buttons');
  await expect(editCard.getByTestId('v2-note-change-proposed-title').locator('ins')).toHaveText('and icons');
  await expect(editCard.locator('[data-action="note-edit"]')).toHaveText(/Edit first/);
  await expect(removalCard.getByTestId('v2-note-change-removed')).toContainText('Prices are shown in EUR.');
  await expect(removalCard.getByTestId('v2-note-change-reason')).toContainText('Prices follow the locale.');
  await expect(removalCard.locator('[data-action="note-approve"]')).toHaveText(/Approve removal/);
  await page.screenshot({ path: path.join('test-results', 'v2-needs-note-changes.png') });

  // Reject the edit (the note keeps its title), approve the removal (the note is gone); each is sent once the toast's Undo window is over.
  await editCard.locator('[data-action="note-reject"]').click();
  await expect.poll(async () => (await notes(page)).filter((n) => n.status === 'rejected' && n.title === 'Acme buttons and icons').length, { timeout: 15_000 }).toBe(1);
  expect((await notes(page)).find((n) => n.id === buttons.id)?.title).toBe('Acme buttons');
  await removalCard.locator('[data-action="note-approve"]').click();
  await expect.poll(async () => (await notes(page)).some((n) => n.id === currency.id), { timeout: 15_000 }).toBe(false);
  await expect(cards.and(page.locator('[data-kind^="note-"]'))).toHaveCount(0, { timeout: 15_000 });
});

test('phone width (390 × 844): the Needs-you card stacks the comparison and fits', async ({ page }) => {
  test.skip(agentId === '', 'needs the first test’s agent');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/notes`);
  const buttons = (await notes(page)).find((n) => n.title === 'Acme buttons' && n.status === 'approved');
  if (!buttons) throw new Error('the first test’s note is missing');
  const third = await world.startSession(page, 'notes-changer-3', 'Reply with just OK.');
  await settledSession(page, third.id);
  expect((await agentMemory(world, third.id, '/edit', { entry: buttons.id, text: 'Use acme-ui for every control.', reason: 'Broader.' })).status).toBe(201);
  await openWithHub(page, `${world.baseUrl}/needs-you`);
  const card = page.getByTestId('v2-answer-card').and(page.locator('[data-kind="note-edit"]')).first();
  await expect(card).toBeVisible();
  const now = await card.getByTestId('v2-note-change-now').boundingBox();
  const proposed = await card.getByTestId('v2-note-change-proposed').boundingBox();
  expect((proposed?.y ?? 0) >= (now?.y ?? 0) + (now?.height ?? 0) - 1).toBe(true);
  const approve = card.locator('[data-action="note-approve"]');
  const box = await approve.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join('test-results', 'v2-needs-note-edit-phone-dark.png'), fullPage: true });
  await approve.click();
  await expect.poll(async () => (await notes(page)).find((n) => n.id === buttons.id)?.text, { timeout: 15_000 }).toBe('Use acme-ui for every control.');
});
