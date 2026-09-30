import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SessionDetail, SessionEvent } from '../../src/core/api.ts';
import { PNG_1X1 } from '../helpers/attachments.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D57 oracle, real path (D13, no demo seed): `node src/server/main.ts` with
 * fake-claude as the CLI (it answers image / document blocks with what it got).
 * - An image pasted into the composer (a clipboard `paste` with a file) and a
 *   text file from the 📎 picker show as chips above the field (a thumbnail; the
 *   file's icon, name and size), a dropped file joins them and × removes it;
 *   Send posts the text with both: the bubble shows the thumbnail and the file
 *   chip, the agent got 1 image inline and 1 file path, the image opens larger
 *   and Esc closes it; after a reload both are still there.
 * - Stop gives a queued message's image back to the composer as a chip.
 * - The Simple New-session form's message carries an image to the first message.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('attachments');
});

test.afterAll(async () => {
  await world?.stop();
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as SessionDetail, id);
}

async function events(page: Page, id: string): Promise<SessionEvent[]> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`)).json()) as SessionEvent[], id);
}

function userMessage(page: Page, text: string): Locator {
  return page.getByTestId('session-chat').locator('[data-testid="chat-message"][data-role="user"]').filter({ hasText: text });
}

/** Pastes a PNG (the clipboard carries it as a file, like a screenshot) into `selector`. */
async function pasteImage(page: Page, selector: string, name = 'image.png'): Promise<void> {
  await page.evaluate(
    ({ selector, base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type: 'image/png' }));
      const target = document.querySelector(selector) as HTMLElement;
      target.focus();
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { selector, base64: PNG_1X1, name },
  );
}

/** Drops a file on `selector` (dragenter, dragover, drop with a DataTransfer). */
async function dropFile(page: Page, selector: string, name: string, text: string): Promise<void> {
  await page.evaluate(
    ({ selector, name, text }) => {
      const data = new DataTransfer();
      data.items.add(new File([text], name, { type: 'text/csv' }));
      const target = document.querySelector(selector) as HTMLElement;
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    },
    { selector, name, text },
  );
}

async function naturalWidth(image: Locator): Promise<number> {
  return image.evaluate((node) => (node as HTMLImageElement).naturalWidth);
}

test('paste an image, attach a text file, drop and remove one; the bubble shows both; the agent got them; a reload keeps them', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'attach-chat', 'Hello.');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('done');

  const composer = page.getByTestId('chat-composer');
  await expect(composer.getByTestId('attach-button')).toBeVisible();
  await pasteImage(page, '[data-testid="chat-input"]');
  // The paste attached the image and typed nothing.
  await expect(page.getByTestId('chat-input')).toHaveValue('');
  // 📎 opens the file picker (several files).
  const chooser = page.waitForEvent('filechooser');
  await composer.getByTestId('attach-button').click();
  const picker = await chooser;
  expect(picker.isMultiple()).toBe(true);
  await picker.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('first line\nsecond line\n') });
  const chips = composer.getByTestId('attachment-chip');
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveAttribute('data-kind', 'image');
  await expect(chips.nth(0)).toHaveAttribute('data-state', 'ready');
  await expect(chips.nth(0).getByTestId('attachment-thumb')).toBeVisible();
  expect(await naturalWidth(chips.nth(0).getByTestId('attachment-thumb'))).toBe(1);
  await expect(chips.nth(1)).toHaveAttribute('data-kind', 'file');
  await expect(chips.nth(1)).toHaveAttribute('data-state', 'ready');
  await expect(chips.nth(1).getByTestId('attachment-name')).toHaveText('notes.txt');
  await expect(chips.nth(1).getByTestId('attachment-size')).toHaveText('23 B');

  // A file dropped on the chat joins them; × removes it again.
  await dropFile(page, '[data-testid="session-chat"]', 'data.csv', 'a,b\n1,2\n');
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(2).getByTestId('attachment-name')).toHaveText('data.csv');
  await chips.nth(2).getByTestId('attachment-remove').click();
  await expect(chips).toHaveCount(2);

  await page.getByTestId('chat-input').fill('What do you see?');
  await page.getByTestId('chat-input').press('Enter');
  await expect(chips).toHaveCount(0);
  const message = userMessage(page, 'What do you see?');
  const image = message.getByTestId('message-image').locator('img');
  await expect(image).toBeVisible();
  await expect.poll(() => naturalWidth(image)).toBe(1);
  await expect(message.getByTestId('message-file-name')).toHaveText('notes.txt');
  await expect(message.getByTestId('message-file-size')).toHaveText('23 B');
  await expect(message.getByTestId('message-file')).toHaveAttribute('data-delivery', 'file');
  await expect(message.getByTestId('message-file')).toHaveAttribute('href', /\/attachments\/[^/]+\?download$/);
  // The agent got the image inline and the file as a path.
  await expect(page.getByTestId('session-chat').getByTestId('chat-text').last()).toHaveText('[fake: 1 image, 0 documents, 1 file path]', { timeout: 15_000 });
  const sent = (await events(page, id)).find((event) => (event.payload as { text?: string }).text === 'What do you see?')?.payload as { sentText?: string };
  expect(sent.sentText).toMatch(/^What do you see\?\n\nAttached files:\n- .*\/attachments\/.*-notes\.txt \(23 B\)$/);

  // The image opens larger; Esc closes it (and stops nothing).
  await message.getByTestId('message-image').click();
  await expect(page.getByTestId('attachment-lightbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('attachment-lightbox')).toHaveCount(0);

  await page.reload();
  const again = userMessage(page, 'What do you see?');
  await expect(again.getByTestId('message-image').locator('img')).toBeVisible();
  await expect.poll(() => naturalWidth(again.getByTestId('message-image').locator('img'))).toBe(1);
  await expect(again.getByTestId('message-file-name')).toHaveText('notes.txt');
});

test('Stop gives a queued message back with its image', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'attach-stop', '[fake:hold 30] Think it through.');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('chat-activity')).toHaveAttribute('data-state', 'thinking', { timeout: 15_000 });

  await pasteImage(page, '[data-testid="chat-input"]', 'shot.png');
  const chips = page.getByTestId('chat-composer').getByTestId('attachment-chip');
  await expect(chips).toHaveAttribute('data-state', 'ready');
  await page.getByTestId('chat-input').fill('Queued with an image.');
  await page.getByTestId('chat-input').press('Enter');
  const queued = userMessage(page, 'Queued with an image.');
  await expect(queued).toHaveAttribute('data-queued', 'turn');
  await expect(queued.getByTestId('message-image')).toBeVisible();
  await expect(chips).toHaveCount(0);

  await page.getByTestId('chat-stop').click();
  await expect(queued).toHaveCount(0);
  await expect(page.getByTestId('chat-input')).toHaveValue('Queued with an image.');
  await expect(chips).toHaveCount(1);
  await expect(chips).toHaveAttribute('data-state', 'ready');
  await expect(chips).toHaveAttribute('data-kind', 'image');
  await expect.poll(() => naturalWidth(chips.getByTestId('attachment-thumb'))).toBe(1);
  await expect.poll(async () => (await detail(page, id)).status).toBe('idle');

  // Sending it again carries the same (still uploaded) image.
  await page.getByTestId('chat-input').press('Enter');
  await expect(page.getByTestId('session-chat').getByTestId('chat-text').last()).toHaveText('[fake: 1 image, 0 documents]', { timeout: 15_000 });
});

test('a Simple New-session start carries an image in its first message', async ({ page }) => {
  await page.goto(`${world.baseUrl}/inbox`);
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal).not.toHaveAttribute('data-mode', 'loading');
  if ((await modal.getAttribute('data-mode')) !== 'simple') await modal.getByTestId('ns-mode-simple').click();
  await expect(modal).toHaveAttribute('data-mode', 'simple');

  await modal.getByTestId('ns-message').fill('Build this screen.');
  await pasteImage(page, '[data-testid="ns-message"]', 'mock.png');
  const chip = modal.getByTestId('attachment-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute('data-kind', 'image');
  await expect(modal.getByTestId('ns-message')).toHaveValue('Build this screen.');
  await expect(modal.getByTestId('ns-start')).toBeEnabled();
  await modal.getByTestId('ns-start').click();

  await expect(modal).toHaveCount(0);
  const task = userMessage(page, 'Build this screen.');
  await expect(task.getByTestId('message-image').locator('img')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => naturalWidth(task.getByTestId('message-image').locator('img'))).toBe(1);
  await expect(page.getByTestId('session-chat').getByTestId('chat-text').last()).toHaveText('[fake: 1 image, 0 documents]', { timeout: 15_000 });
});
