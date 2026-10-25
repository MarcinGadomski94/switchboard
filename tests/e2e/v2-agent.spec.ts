import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import type { Session, SessionDetail, SessionEvent } from '../../src/core/api.ts';
import { PNG_1X1 } from '../helpers/attachments.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, startPeerNode, waitFor } from '../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, takeoverWorld } from '../helpers/takeover.ts';
import { assistantTextLine, lastUuid, terminalUserLine, writeTranscript } from '../helpers/transcripts.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV, useV2 } from './v2-world.ts';

/**
 * D131 · lane S · the v2 agent view on the real path (fake-claude, a temp
 * workspace with one git repo): the live activity line, collapsed tool rows,
 * an in-chat question answered here (it leaves Needs you), send / queue / Stop
 * (Esc), Undo from here, an attached image, a draft kept across navigation, ⌘.
 * remembered, the Changes tab, a helper's thread and chat, the peek sheet, a deep
 * link to a message, and the phone chat at 390 × 844.
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-agent', { env: { ...V2_SERVER_ENV } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as SessionDetail, id);
}

async function events(page: Page, id: string): Promise<SessionEvent[]> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`)).json()) as SessionEvent[], id);
}

async function settled(page: Page, id: string): Promise<void> {
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 20_000 }).toMatch(/^(done|idle)$/);
}

async function post(page: Page, id: string, text: string): Promise<void> {
  const status = await page.evaluate(
    async ({ sessionId, body }) => (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: body }) })).status,
    { sessionId: id, body: text },
  );
  expect(status).toBe(202);
}

test('the chat: replies as text, collapsed tool rows expand, the live line ticks, a queued message, Stop with Esc', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-chat', '[fake:tool-use] Create out.txt and list the files.');
  await settled(page, id);
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  const view = page.getByTestId('v2-agent-view');
  await expect(view).toBeVisible();
  await expect(page.getByTestId('v2-agent-title')).toHaveText('v2-chat');
  // The task as the developer's pill, the reply as document text with its "Agent · reply 1" line.
  await expect(page.getByTestId('v2-agent-you').first()).toContainText('Create out.txt');
  const reply = page.getByTestId('v2-agent-reply').last();
  await expect(reply).toContainText('DONE');
  await expect(reply.locator('.v2-ag-who')).toContainText('Agent · reply 1');
  // Tool steps: one collapsed row that expands into its lines.
  const act = page.getByTestId('v2-agent-activity').first();
  await expect(act.locator('.v2-ag-act-sum')).toHaveText('Edited 1 file · ran 1 command');
  await expect(page.getByTestId('v2-agent-activity-lines')).toHaveCount(0);
  await act.getByTestId('v2-agent-activity-toggle').click();
  await expect(page.getByTestId('v2-agent-activity-lines').first()).toContainText('✓ Write · out.txt');
  await expect(page.getByTestId('v2-agent-activity-lines').first()).toContainText('✓ Bash · ls');

  // A long reply: the live line with its ticking timer and Stop.
  const input = page.getByTestId('v2-agent-input');
  await input.fill('[fake:hold 20] Think for a while.');
  await input.press('ControlOrMeta+Enter');
  await expect(input).toHaveValue('');
  const live = page.getByTestId('v2-agent-live');
  await expect(live).toHaveAttribute('data-kind', 'working', { timeout: 10_000 });
  await expect(page.getByTestId('v2-agent-stop')).toBeVisible();
  const first = await page.getByTestId('v2-agent-live-time').textContent();
  await expect.poll(async () => page.getByTestId('v2-agent-live-time').textContent(), { timeout: 5_000 }).not.toBe(first);

  // A follow-up while it works waits in the dock as queued (D114: at once).
  await input.fill('A queued follow-up');
  await input.press('Enter');
  const queued = page.getByTestId('v2-agent-queued');
  await expect(queued).toHaveCount(1);
  await expect(queued).toContainText('A queued follow-up');
  await expect(queued).toContainText('Queued');

  // Esc stops the reply; the queued message comes back into the box (nothing is lost).
  await input.focus();
  await page.keyboard.press('Escape');
  await expect(live).toHaveAttribute('data-kind', 'stopped', { timeout: 10_000 });
  await expect(live).toContainText('Stopped by you');
  await expect(queued).toHaveCount(0);
  await expect(input).toHaveValue('A queued follow-up');
  await settled(page, id);
});

test('an in-chat question answered here leaves Needs you everywhere', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-asker', '[fake:ask-delay] Ask me which environment.');
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  const card = page.getByTestId('v2-agent-view').getByTestId('v2-answer-card');
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId('v2-needs-button').locator('.v2-dot-badge')).toHaveText('1');
  await card.locator('.v2-opt', { hasText: 'Staging' }).click();
  // Compact once answered, kept in the chat; gone from Needs you at once.
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('v2-agent-view').getByTestId('v2-answered').first()).toContainText('Staging');
  await expect(page.getByTestId('v2-needs-button').locator('.v2-dot-badge')).toHaveCount(0);
  // After the Undo window the agent gets it, and the history still shows it answered.
  await expect.poll(async () => JSON.stringify(await events(page, id)), { timeout: 20_000 }).toContain('Staging');
  await settled(page, id);
  await expect(page.getByTestId('v2-agent-view').getByTestId('v2-answered').first()).toContainText('Staging');
  // Reloaded, the history says what was answered (the server's record).
  await page.reload();
  await expect(page.getByTestId('v2-agent-answered')).toContainText('Staging');
});

test('an attached image, and a draft kept across navigation', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-attach', 'Say hello.');
  await settled(page, id);
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  const input = page.getByTestId('v2-agent-input');
  await expect(input).toBeEnabled();
  // 📎 opens the picker; the image becomes a chip with its thumbnail.
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('v2-agent-attach').click();
  await (await chooser).setFiles({ name: 'mock.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1X1, 'base64') });
  const chip = page.getByTestId('v2-agent-draft-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute('data-state', 'ready');
  await expect(chip.locator('img')).toHaveCount(1);
  // A draft follows the agent: leave and come back.
  await input.fill('A draft about the mock');
  await expect(page.getByTestId('v2-agent-draft-note')).toBeVisible();
  await page.waitForTimeout(700);
  await page.getByTestId('v2-agent-back').click();
  await expect(page).toHaveURL(`${world.baseUrl}/agents`);
  await page.goBack();
  await expect(page.getByTestId('v2-agent-input')).toHaveValue('A draft about the mock');
  await expect(page.getByTestId('v2-agent-draft-chip')).toHaveCount(1);
  // Sent: the pill carries the image.
  await page.getByTestId('v2-agent-send').click();
  await expect(page.getByTestId('v2-agent-input')).toHaveValue('');
  const pill = page.getByTestId('v2-agent-you').filter({ hasText: 'A draft about the mock' });
  await expect(pill.getByTestId('v2-agent-message-image')).toHaveCount(1, { timeout: 10_000 });
  await settled(page, id);
});

test('⌘. hides the details panel and it is remembered; the View menu changes the density', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-panel', 'Say hello.');
  await settled(page, id);
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  await expect(page.getByTestId('v2-agent-side')).toBeVisible();
  await expect(page.getByTestId('v2-agent-group-how')).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+.');
  await expect(page.getByTestId('v2-agent-side')).toHaveCount(0);
  await expect(page.getByTestId('v2-agent-view')).toHaveAttribute('data-side', 'hidden');
  await page.reload();
  await expect(page.getByTestId('v2-agent-view')).toHaveAttribute('data-side', 'hidden');
  await page.getByTestId('v2-agent-details').click();
  await expect(page.getByTestId('v2-agent-side')).toBeVisible();
  // View › Compact text: remembered too.
  await page.getByTestId('v2-agent-view-button').click();
  await page.getByTestId('v2-agent-view-menu').getByRole('menuitem', { name: 'Compact text' }).click();
  await expect(page.locator('[data-testid="v2-agent-view"][data-density="compact"]')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('[data-testid="v2-agent-view"][data-density="compact"]')).toHaveCount(1);
});

test('the Changes tab, and Undo from here restores the files', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-undo', 'Say hello.');
  await settled(page, id);
  await post(page, id, '[fake:write microfrontends/acme-app-front/notes.txt] Write the notes file.');
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 20_000 }).toBe('done');
  const file = path.join(world.workspace, 'microfrontends', 'acme-app-front', 'notes.txt');
  const exists = async (): Promise<boolean> => readFile(file).then(() => true, () => false);
  await expect.poll(exists).toBe(true);

  await openWithHub(page, `${world.baseUrl}/agents/${id}/changes`);
  const changes = page.getByTestId('v2-agent-changes');
  await expect(changes).toBeVisible();
  await expect(changes.getByTestId('v2-agent-changes-scope')).toContainText('Since last save point');

  // Undo from here, on the reply that wrote the file.
  await page.getByTestId('v2-agent-tabs').getByRole('tab', { name: 'Chat' }).click();
  await expect(page).toHaveURL(`${world.baseUrl}/agents/${id}`);
  const reply = page.getByTestId('v2-agent-reply').last();
  await reply.hover();
  await reply.getByTestId('v2-agent-reply-menu').click();
  const menu = page.getByTestId('v2-agent-reply-menu-list');
  await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Copy code' })).toHaveAttribute('aria-disabled', 'true');
  const undo = menu.getByRole('menuitem', { name: 'Undo from here' });
  await expect(undo).not.toHaveAttribute('aria-disabled', 'true', { timeout: 10_000 });
  await undo.click();
  const dialog = page.getByTestId('v2-agent-revert');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('notes.txt');
  await dialog.getByTestId('v2-agent-revert-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(exists).toBe(false);
  await expect(page.getByTestId('v2-agent-divider').last()).toContainText('Reverted', { timeout: 10_000 });
  await expect(page.getByTestId('v2-agent-redo')).toBeVisible();
});

test('the reply ⋯ menu: Save as result shows it as an attachment that opens its drawer; Add to tasks fills the tasks strip', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-results', '[fake:say "## Plan\\n\\nShip the summary card first. Then the prices."] Plan it.');
  await settled(page, id);
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  const reply = page.getByTestId('v2-agent-reply').last();
  await expect(reply).toContainText('Ship the summary card first.');
  await reply.hover();
  await reply.getByTestId('v2-agent-reply-menu').click();
  await page.getByTestId('v2-agent-reply-menu-list').getByRole('menuitem', { name: 'Save as result' }).click();
  const dialog = page.getByTestId('v2-agent-save-result');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('v2-agent-save-result-save').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('v2-toast')).toContainText('Saved “Plan”');
  const attachment = page.getByTestId('v2-agent-result-attachment');
  await expect(attachment).toHaveCount(1, { timeout: 10_000 });
  await expect(attachment).toContainText('Plan');
  await attachment.click();
  await expect(page).toHaveURL(new RegExp(`/agents/${id}/results/`));
  // Lane X: lane R's result drawer (the Results page's), without its Open agent here.
  const drawer = page.getByTestId('v2-result-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId('v2-result-markdown')).toContainText('Ship the summary card first.');
  await expect(drawer.getByTestId('v2-result-version')).toHaveCount(1);
  await expect(drawer.getByTestId('v2-result-open-agent')).toHaveCount(0);
  await drawer.getByTestId('v2-result-source').click();
  await expect(drawer.getByTestId('v2-result-source-text')).toContainText('Ship the summary card first.');
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL(`${world.baseUrl}/agents/${id}/results`);
  // Delete from the drawer hides the card, and Undo brings it back (nothing was deleted).
  const card = page.getByTestId('v2-agent-result-card');
  await expect(card).toHaveCount(1);
  await card.click();
  await drawer.getByTestId('v2-result-delete').click();
  await expect(drawer).toHaveCount(0);
  await expect(card).toHaveCount(0);
  await page.getByTestId('v2-toast').filter({ hasText: 'Deleted 1 result' }).getByTestId('v2-toast-undo').click();
  await expect(card).toHaveCount(1);
  // A link to a result the agent does not have says so and drops it.
  await openWithHub(page, `${world.baseUrl}/agents/${id}/results/no-such-result`);
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'That result is gone.' })).toHaveCount(1);
  await expect(page).toHaveURL(`${world.baseUrl}/agents/${id}/results`);

  // Add to tasks (the reply's first sentence): the tasks strip above the box shows it.
  await page.getByTestId('v2-agent-tabs').getByRole('tab', { name: 'Chat' }).click();
  const again = page.getByTestId('v2-agent-reply').last();
  await again.hover();
  await again.getByTestId('v2-agent-reply-menu').click();
  await page.getByTestId('v2-agent-reply-menu-list').getByRole('menuitem', { name: 'Add to tasks' }).click();
  await expect(page.getByTestId('v2-agent-tasks')).toContainText('Tasks · 0 of 1 done', { timeout: 10_000 });
});

test('a helper thread expands inline and opens its own chat', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-helpers', 'Say hello.');
  await settled(page, id);
  await post(page, id, '[fake:subagent-forward] Ask a subagent for the first line.');
  await expect.poll(async () => (await detail(page, id)).agents.some((agent) => agent.kind === 'subagent'), { timeout: 20_000 }).toBe(true);
  await settled(page, id);
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  const thread = page.getByTestId('v2-agent-helpers').first();
  await expect(thread).toContainText('1 helper finished');
  await thread.getByTestId('v2-agent-helpers-toggle').click();
  await expect(thread.getByTestId('v2-agent-helper')).toHaveCount(1);
  await thread.getByTestId('v2-agent-helper-open').click();
  await expect(page).toHaveURL(new RegExp(`/agents/${id}/helpers/`));
  const chat = page.getByTestId('v2-agent-helper-chat');
  await expect(chat).toBeVisible();
  await expect(chat.getByTestId('v2-agent-helper-brief')).toBeVisible();
  await page.getByTestId('v2-agent-helper-back').click();
  await expect(page).toHaveURL(`${world.baseUrl}/agents/${id}`);
  // The Helpers tab lists it too.
  await page.getByTestId('v2-agent-tabs').getByRole('tab', { name: /Helpers/ }).click();
  await expect(page.getByTestId('v2-agent-helper-card')).toHaveCount(1);
});

test('the peek sheet: the chat with its composer, the tabs, Open full view', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-peek', '[fake:tool-use] Create out.txt and list the files.');
  await settled(page, id);
  await openWithHub(page, `${world.baseUrl}/`);
  await page.evaluate((sessionId) => (window as unknown as { __sbV2Peek: (id: string) => void }).__sbV2Peek(sessionId), id);
  const sheet = page.getByTestId('v2-agent-peek');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('v2-agent-reply').last()).toContainText('DONE');
  await expect(sheet.getByTestId('v2-agent-input')).toBeVisible();
  await sheet.getByTestId('v2-agent-peek-tabs').getByRole('tab', { name: 'Changes' }).click();
  await expect(sheet.getByTestId('v2-agent-changes')).toBeVisible();
  await sheet.getByTestId('v2-agent-peek-full').click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(`${world.baseUrl}/agents/${id}/changes`);
});

test('a deep link to a message scrolls to it and highlights it', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-deeplink', 'Say hello.');
  await settled(page, id);
  const target = (await events(page, id)).find((event) => (event.payload as { type?: string } | null)?.type === 'assistant');
  expect(target).toBeTruthy();
  await openWithHub(page, `${world.baseUrl}/agents/${id}/events/${target?.id ?? 0}`);
  await expect(page.locator(`[data-testid="v2-agent-reply"][data-event-id="${target?.id ?? 0}"]`)).toHaveAttribute('data-search-hit', 'true');
});

test('phone (390 × 844): the full-screen chat, the bottom composer sends, Details as a bottom sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-phone', 'Say hello.');
  await settled(page, id);
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  await expect(page.getByTestId('v2-agent-view')).toHaveAttribute('data-layout', 'phone');
  await expect(page.getByTestId('v2-agent-side')).toHaveCount(0);
  const input = page.getByTestId('v2-agent-input');
  const send = page.getByTestId('v2-agent-send');
  // The composer sits at the bottom of the screen, above the phone tabs; Send is a 44 px target.
  const box = await page.getByTestId('v2-agent-dock').boundingBox();
  expect(box && box.y + box.height).toBeGreaterThan(700);
  await input.fill('Hello from the phone');
  const sendBox = await send.boundingBox();
  expect(sendBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await send.click();
  await expect(page.getByTestId('v2-agent-you').filter({ hasText: 'Hello from the phone' })).toHaveCount(1);
  // The text reaches the screen's edges (no side panel, no line cap wider than the screen).
  const reply = await page.getByTestId('v2-agent-reply').last().boundingBox();
  expect(reply?.width ?? 0).toBeGreaterThan(330);
  await page.getByTestId('v2-agent-details').click();
  await expect(page.getByTestId('v2-agent-side-sheet')).toBeVisible();
  await expect(page.getByTestId('v2-agent-side-sheet').getByTestId('v2-agent-group-how')).toBeVisible();
  await settled(page, id);
});

/**
 * Lane X · the v2 Move to computer dialog (D65 / D110) on two real Switchboards
 * (`tests/helpers/takeover.ts`): a local agent moves to the paired computer; a
 * missing code project asks where to clone it, the Move button says why it waits.
 */
test.describe('lane X · Move to computer in v2', () => {
  let tmp: string;
  let peers: TakeoverWorld | null = null;
  let contexts: BrowserContext[] = [];

  test.beforeEach(async () => {
    tmp = await makeTempDir('e2e-v2-move');
  });

  test.afterEach(async () => {
    await Promise.all(contexts.map((context) => context.close()));
    contexts = [];
    if (peers) await Promise.all([peers.a.server.stop(), peers.b.server.stop()]);
    peers = null;
    await removeWorld(tmp);
  });

  async function v2Page(browser: Browser, node: PeerNode, route: string, size = { width: 1440, height: 900 }): Promise<Page> {
    const context = await browser.newContext({ viewport: size });
    contexts.push(context);
    const page = await context.newPage();
    await stubToolProbes(page);
    await useV2(page);
    await page.goto(`${node.baseUrl}${route}`);
    return page;
  }

  test('the ⋯ menu opens the v2 dialog: the target picker, the clone folder, why Move waits, the steps, Open the agent', async ({ browser }) => {
    const w = (peers = await takeoverWorld(tmp, { aRepos: { alpha: true, gamma: true }, bRepos: { alpha: true } }));
    const started = await startRepoSession(w.a, w.folders.a.gamma as string, 'gamma-work');
    await writeFile(path.join(w.paths.a.gamma, 'tracked.txt'), 'gamma edit\n');
    const page = await v2Page(browser, w.a, `/agents/${started.id}`);
    await expect(page.getByTestId('v2-agent-title')).toHaveText('gamma-work');
    await page.getByTestId('v2-agent-menu').click();
    await page.getByTestId('v2-agent-menu-list').getByRole('menuitem', { name: 'Move to computer…' }).click();

    // The v2 dialog (no classic overlay), on the paired computer.
    const dialog = page.getByTestId('v2-move-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('takeover-dialog')).toHaveCount(0);
    await expect(dialog.getByRole('heading')).toHaveText('Move to mac-laptop');
    await expect(dialog.getByTestId('v2-move-target')).toHaveValue(await w.b.machineId());
    await expect(dialog.getByTestId('v2-move-cli')).toContainText('of mac-laptop');
    const repo = dialog.getByTestId('v2-move-repo');
    await expect(repo).toHaveAttribute('data-action', 'clone');
    await expect(repo).toContainText('Needs a look');
    const clonePath = repo.getByTestId('v2-move-clone-path');
    await expect(clonePath).toHaveValue(path.join(path.dirname(w.paths.b.alpha), 'gamma'));
    // An empty clone folder: Move is disabled and says why.
    await clonePath.fill('');
    const move = dialog.getByTestId('v2-move-start');
    await expect(move).toBeDisabled();
    await expect(dialog.getByTestId('v2-move-reason')).toHaveText('Fill in where to clone each missing code project.');
    const typed = path.join(tmp, 'b', 'typed', 'gamma');
    await clonePath.fill(typed);
    await clonePath.blur();
    await expect(repo.getByTestId('v2-move-repo-summary')).toContainText(`clone ${w.remotes.gamma} into ${typed}`);
    await expect(move).toBeEnabled();
    await move.click();
    // Escape does not close it while it runs; the steps end done.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('v2-move-headline')).toContainText('Moved', { timeout: 60_000 });
    await expect(dialog.getByTestId('v2-move-step')).toHaveCount(7);
    await expect(dialog.locator('[data-testid="v2-move-step"][data-status="done"]')).toHaveCount(7);
    await dialog.getByTestId('v2-move-log-toggle').click();
    await expect(dialog.getByTestId('v2-move-log')).toContainText('commit-tree');
    await dialog.getByTestId('v2-move-open').click();
    await expect(dialog).toHaveCount(0);
    // The moved agent lives on the mac: its v2 page here addresses it by its remote id.
    await expect(page).toHaveURL(new RegExp(`/agents/r~${await w.b.machineId()}~`));
    await expect(page.getByTestId('v2-agent-view')).toBeVisible();
    await waitFor('the clone', async () => (await w.git(typed, 'status', '--porcelain')).includes('tracked.txt'));
  });
});

/**
 * Lane X · Continue in Switchboard (D72) in v2, on a real Switchboard with a
 * hand-started terminal session faked by a stand-in process (as
 * `hooked-continue.spec.ts`): the header's note offers it, the dialog asks while
 * the terminal's claude runs, Cancel changes nothing, the confirmation stops it
 * and the agent runs under Switchboard.
 */
test.describe('lane X · Continue in Switchboard in v2', () => {
  const CS = '9a8b7c6d-bbbb-4bbb-8ccc-0123456789ab';
  let tmp: string;
  let node: PeerNode | null = null;
  let terminal: ChildProcess | null = null;
  let contexts: BrowserContext[] = [];

  test.beforeEach(async () => {
    tmp = await makeTempDir('e2e-v2-hooked');
    node = await startPeerNode(tmp, 'a', { repo: true });
  });

  test.afterEach(async () => {
    await Promise.all(contexts.map((context) => context.close()));
    contexts = [];
    if (terminal && terminal.exitCode === null && terminal.signalCode === null) terminal.kill('SIGKILL');
    terminal = null;
    await node?.server.stop();
    node = null;
    await removeTempDir(tmp);
  });

  test('the note and the ⋯ menu offer it; the v2 dialog asks, Cancel keeps the terminal, the confirmation continues here', async ({ browser }) => {
    const n = node as PeerNode;
    const cwd = n.repo as string;
    terminal = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', shell: false });
    const exited = new Promise<string>((resolve) => terminal?.once('exit', (code, signal) => resolve(signal ?? String(code))));
    await mkdir(path.join(n.configDir, 'sessions'), { recursive: true });
    await writeFile(
      path.join(n.configDir, 'sessions', `${terminal.pid}.json`),
      JSON.stringify({ pid: terminal.pid, sessionId: CS, cwd, kind: 'interactive', entrypoint: 'cli', startedAt: Date.now() - 60_000, name: 'pc-terminal', status: 'idle' }),
    );
    const lines = [terminalUserLine({ sessionId: CS, cwd, content: 'Refactor the parser.', parentUuid: null, timestamp: new Date(Date.now() - 50_000).toISOString() })];
    lines.push(assistantTextLine({ sessionId: CS, cwd, text: 'Parser split in two.', parentUuid: lastUuid(lines), timestamp: new Date(Date.now() - 40_000).toISOString() }));
    await writeTranscript(n.configDir, cwd, CS, lines);
    const hooked = await n.call('POST', `/api/terminal-sessions/${CS}/hook`);
    expect(hooked.status, JSON.stringify(hooked.body)).toBe(201);
    const session = hooked.body as Session;

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    const page = await context.newPage();
    await stubToolProbes(page);
    await useV2(page);
    await page.goto(`${n.baseUrl}/agents/${session.id}`);
    await expect(page.getByTestId('v2-agent-hooked')).toBeVisible();
    // The ⋯ menu has it too.
    await page.getByTestId('v2-agent-menu').click();
    await expect(page.getByTestId('v2-agent-menu-list').getByRole('menuitem', { name: 'Continue in Switchboard' })).toBeEnabled();
    await page.keyboard.press('Escape');

    const action = page.getByTestId('v2-agent-continue-hooked');
    await action.click();
    const dialog = page.getByTestId('v2-continue-hooked');
    await expect(dialog.getByTestId('v2-continue-hooked-body')).toHaveAttribute('data-state', 'confirm');
    await expect(dialog.getByTestId('v2-continue-hooked-warning')).toContainText("This session's claude is still running in its terminal.");
    await expect(page.getByTestId('continue-hooked-dialog')).toHaveCount(0);
    await dialog.getByTestId('v2-continue-hooked-close').click();
    await expect(dialog).toHaveCount(0);
    expect(terminal?.exitCode).toBeNull();

    await action.click();
    await page.getByTestId('v2-continue-hooked-confirm').click();
    await expect(page.getByTestId('v2-continue-hooked')).toHaveCount(0, { timeout: 30_000 });
    expect(await exited).toBe('SIGTERM');
    await expect(page.getByTestId('v2-toast').filter({ hasText: 'now runs in Switchboard' })).toHaveCount(1);
    await expect(page.getByTestId('v2-agent-hooked')).toHaveCount(0, { timeout: 15_000 });
  });
});
