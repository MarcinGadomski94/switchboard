import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';
import { rememberNewSessionMode } from '../helpers/new-session-mode.ts';

/**
 * D13 final-verify walkthrough (docs/decisions.md → D13, check 1): the whole
 * product on the real path, no demo seed. The real server (`node src/server/main.ts`)
 * with fake-claude as the CLI, fake gh, and a temp workspace holding one real git
 * repo (`microfrontends/acme-app-front`). Everything is driven through the UI:
 *
 * New session (with a worktree) → streamed chat → a question batch reaches the
 * Inbox with a toast → answering it continues the process → Pause / Resume →
 * Continue in terminal (the resume command) → Attach here → a written file in the
 * Diff tab → a schedule's Run now starts a session → History lists both sessions.
 */

const NAME = 'walkthrough';
const WORKTREE = path.join('microfrontends', `acme-app-front-wt-${NAME}`);

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('walkthrough');
});

test.afterAll(async () => {
  await world?.stop();
});

async function sessionByName(page: Page, name: string): Promise<Session | undefined> {
  const sessions = await page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as Session[]);
  return sessions.find((session) => session.name === name);
}

async function status(page: Page, name: string): Promise<string | undefined> {
  return (await sessionByName(page, name))?.status;
}

function chip(modal: Locator, solution: string): Locator {
  return modal.locator(`[data-testid="ns-chip"][data-solution="${solution}"]`);
}

test('the whole product on the real path: session → question → answer → pause/resume → handoff → diff → schedule → history', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/inbox`);
  await expect(page.getByTestId('inbox-zero')).toBeVisible();

  // 1. New session from the modal, with a worktree (gap #1). D56: the Full form (Simple is the fresh-install default).
  await rememberNewSessionMode(page, 'full');
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal.getByTestId('ns-group').first()).toBeVisible();
  await modal.getByTestId('ns-name').fill(NAME);
  await modal.getByTestId('ns-task').fill('[fake:ask-2q] Ask me two questions.');
  await chip(modal, 'acme-app-front').click();
  // D32: the worktree's branch is named after its ticket.
  await modal.getByTestId('ns-branch').fill('PROJ-100-walkthrough');
  await expect(modal.getByTestId('ns-summary-line').filter({ hasText: `../acme-app-front-wt-${NAME}` })).toHaveCount(1);
  await modal.getByTestId('ns-start').click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('view-session')).toBeVisible();
  await expect(page.getByTestId('session-name')).toHaveText(NAME);
  const session = await sessionByName(page, NAME);
  expect(session).toMatchObject({ worktrees: true, solutions: ['acme-app-front'] });
  expect(await readFile(path.join(world.workspace, WORKTREE, 'README.md'), 'utf8')).toBe('hello\n');

  // 2. Streamed chat: the task the developer typed (without the appended answers block, M5.2).
  await expect(page.getByTestId('chat-message').first()).toHaveText('[fake:ask-2q] Ask me two questions.');

  // 3. The question batch: the card in the chat of the session on screen (no toast for it:
  // developer request 2026-09-28, docs/notifications.md), and the Inbox item.
  await expect(page.getByTestId('session-chat').getByTestId('question-card')).toHaveCount(1);
  await expect.poll(() => status(page, NAME)).toBe('need');
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await page.getByTestId('nav-inbox').click();
  await expect(page.getByTestId('inbox-item')).toHaveCount(1);
  await expect(page.getByTestId('inbox-title')).toHaveText('2 questions from acme-app-front');

  // 4. Answer both; Send stays disabled until every question is answered; the process continues.
  const questions = page.getByTestId('question');
  const send = page.getByTestId('question-send');
  await expect(send).toBeDisabled();
  await questions.nth(0).getByTestId('question-option').filter({ hasText: 'Green' }).click();
  await expect(send).toBeDisabled();
  await questions.nth(1).getByTestId('question-option').filter({ hasText: 'Small' }).click();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByTestId('inbox-zero')).toBeVisible();
  await expect.poll(() => status(page, NAME), { timeout: 15_000 }).toBe('done');

  // 5. A chat message writes a file into the session's worktree (for the Diff tab).
  await page.goto(`${world.baseUrl}/sessions/${session?.id}`);
  const composer = page.getByTestId('chat-input');
  await composer.fill(`Write the notes. [fake:write ${WORKTREE.split(path.sep).join('/')}/notes.md]`);
  await composer.press('Enter');
  // The status was already done before this turn (D80's checkpoint goes first): wait for the agent's write itself.
  await expect(page.getByTestId('chat-step').filter({ hasText: 'notes.md' }).first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => status(page, NAME), { timeout: 15_000 }).toBe('done');

  // 6. Pause / Resume (D7).
  const pause = page.getByTestId('session-pause');
  await expect(pause).toHaveText('Pause');
  await pause.click();
  await expect(pause).toHaveText('Resume');
  await pause.click();
  await expect(pause).toHaveText('Pause');
  await expect.poll(() => status(page, NAME), { timeout: 15_000 }).toMatch(/^(done|run)$/);

  // 7. Continue in terminal shows the resume command; Attach here (confirming the recent-transcript warning).
  const handoff = page.getByTestId('session-handoff');
  await handoff.click();
  await expect(handoff).toHaveText('⇄ Attach here');
  await expect(page.getByTestId('handoff-command')).toHaveText(`claude --resume ${session?.claudeSessionId}`);
  await handoff.click();
  // The transcript changed seconds ago (the session just ran), so Attach warns first (gap #5).
  await expect(page.getByTestId('attach-warning')).toBeVisible();
  await page.getByTestId('attach-confirm').click();
  await expect(handoff).toHaveText('⇄ Continue in terminal');

  // 8. The Diff tab shows the worktree change, not committed.
  await page.getByTestId('session-tab-diff').click();
  const notes = page.getByTestId('diff-file').filter({ hasText: 'notes.md' });
  await expect(notes).toHaveCount(1);
  await notes.click();
  await expect(page.getByTestId('diff-note')).toHaveText('Not committed. Commit only when you approve.');
  await expect(page.getByTestId('diff-line').first()).toContainText('+');

  // 9. A schedule's Run now starts a real session.
  await page.getByTestId('nav-schedules').click();
  await page.getByTestId('schedule-new').click();
  const scheduleModal = page.getByTestId('modal-new-session');
  await expect(scheduleModal.getByTestId('ns-group').first()).toBeVisible();
  await scheduleModal.getByTestId('ns-name').fill('nightly-walk');
  await scheduleModal.getByTestId('ns-task').fill('Check the build and report.');
  await chip(scheduleModal, 'acme-app-front').click();
  await scheduleModal.getByTestId('ns-cron').fill('0 2 * * *');
  await scheduleModal.getByTestId('ns-save-schedule').click();
  await expect(scheduleModal).toHaveCount(0);
  const nightly = page.locator('[data-testid="schedule-row"]').filter({ hasText: 'nightly-walk' });
  await nightly.getByTestId('schedule-run').click();
  await expect.poll(async () => (await page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as Session[])).length, { timeout: 15_000 }).toBe(2);

  // 10. History lists both sessions.
  await page.getByTestId('nav-history').click();
  const rows = page.getByTestId('history-row');
  await expect(rows.filter({ hasText: NAME })).toHaveCount(1);
  await expect.poll(async () => rows.count(), { timeout: 15_000 }).toBe(2);
});
