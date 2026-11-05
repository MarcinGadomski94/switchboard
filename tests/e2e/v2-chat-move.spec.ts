import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { makeTempDir } from '../helpers/net.ts';
import { type PeerNode, waitFor } from '../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, settle, takeoverWorld } from '../helpers/takeover.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV, useV2 } from './v2-world.ts';

/**
 * D155 · a chat moves to the other computer in v2, on two real Switchboards (fake claude,
 * temp folders): the chat's ⋯ → **Move to computer…** lists each folder it looks at with
 * what it becomes there; the developer leaves one out and maps the other to a folder
 * typed on the other computer; **Move** runs the steps and the dialog stays open with the
 * real outcome; the chat continues on the other computer looking at the mapped folder only.
 */

let tmp: string;
let world: TakeoverWorld | null = null;
let contexts: BrowserContext[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-v2-chat-move');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  world = null;
  await removeWorld(tmp);
});

async function v2Page(browser: Browser, node: PeerNode, route: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  contexts.push(context);
  const page = await context.newPage();
  await stubToolProbes(page);
  await useV2(page);
  await page.goto(`${node.baseUrl}${route}`);
  return page;
}

test('Move to computer… of a chat: one looked-at folder left out, the other mapped to a folder there; the chat continues there', async ({ browser }) => {
  test.setTimeout(180_000);
  const w = (world = await takeoverWorld(tmp, { env: { ...V2_SERVER_ENV } }));
  await mkdir(path.join(tmp, 'a', 'notes'), { recursive: true });
  const notes = await realpath(path.join(tmp, 'a', 'notes'));
  // On the mac, the notes live elsewhere (inside its saved folder's parent: a place the move may use).
  const notesOnMac = path.join(await realpath(path.dirname(w.paths.b.alpha)), 'notes-mac');
  await mkdir(notesOnMac, { recursive: true });
  const created = await w.a.call('POST', '/api/chats', { message: 'Remember the code word: zeppelin. Plan the billing split.', lookAt: [w.paths.a.alpha, notes] });
  expect(created.status).toBe(201);
  const chat = await settle(w.a, (created.body as Session).id);

  const page = await v2Page(browser, w.a, `/agents/${chat.id}`);
  await page.getByTestId('v2-agent-menu').click();
  await page.getByTestId('v2-agent-menu-list').getByRole('menuitem', { name: 'Move to computer…' }).click();
  const dialog = page.getByTestId('v2-chat-move-dialog');
  await expect(dialog.getByTestId('v2-chat-move-cli')).toContainText('still a chat (plan mode)');
  await expect(dialog.getByTestId('v2-chat-move-carries')).toContainText('The conversation is copied');
  const alpha = dialog.locator(`[data-testid="v2-chat-move-lookat"][data-source="${w.paths.a.alpha}"]`);
  const notesRow = dialog.locator(`[data-testid="v2-chat-move-lookat"][data-source="${notes}"]`);
  // alpha is found on the mac by its remote; notes has no match there (left out).
  await expect(alpha).toHaveAttribute('data-mode', 'suggested');
  await expect(alpha.getByTestId('v2-chat-move-lookat-line')).toHaveText(`Uses ${w.paths.b.alpha} on mac-laptop`);
  await expect(notesRow).toHaveAttribute('data-mode', 'left-out');
  const move = dialog.getByTestId('v2-chat-move-start');
  await expect(move).toBeEnabled();

  // Leave alpha out; map notes to a folder typed on the mac.
  await alpha.getByTestId('v2-chat-move-lookat-mode').selectOption('left-out');
  await expect(alpha).toHaveAttribute('data-mode', 'left-out');
  await notesRow.getByTestId('v2-chat-move-lookat-mode').selectOption('picked');
  await expect(dialog.getByTestId('v2-chat-move-reason')).toHaveText('Use the folder you typed, or close the folder picker.');
  await expect(move).toBeDisabled();
  await notesRow.getByTestId('v2-chat-move-lookat-path').fill(notesOnMac);
  await notesRow.getByTestId('v2-chat-move-lookat-use').click();
  await expect(notesRow).toHaveAttribute('data-mode', 'picked');
  await expect(notesRow.getByTestId('v2-chat-move-lookat-line')).toHaveText(`Uses ${notesOnMac} on mac-laptop`);
  await expect(move).toBeEnabled();

  await move.click();
  const headline = dialog.getByTestId('v2-chat-move-headline');
  await expect(headline).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await expect(headline).toContainText('Moved');
  await expect(dialog.locator('[data-testid="v2-chat-move-step"][data-status="done"]')).toHaveCount(5);
  // The dialog stays open with the outcome until it is closed.
  await expect(dialog.getByTestId('v2-chat-move-open')).toBeVisible();

  // The mac: the chat looks at the mapped folder only; the pc's chat is moved.
  const moved = await waitFor('the moved chat on the mac', async () => ((await w.b.call('GET', '/api/sessions')).body as Session[]).find((session) => session.movedFrom?.sessionId === chat.id));
  expect(moved).toMatchObject({ kind: 'chat', lookAt: [notesOnMac] });
  const old = (await w.a.call('GET', `/api/sessions/${chat.id}`)).body as Session;
  expect(old.movedTo).toMatchObject({ sessionId: moved.id });

  await dialog.getByTestId('v2-chat-move-open').click();
  await expect(page).toHaveURL(new RegExp(`/agents/${encodeURIComponent(`r~${w.bId}~${moved.id}`).replace(/[~]/g, '(?:~|%7E)')}`));
});
