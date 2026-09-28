import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D36 subagent chats, on the real path (D13, no demo seed): `node
 * src/server/main.ts` with fake-claude as the CLI.
 *
 * D36 (`subagent-forward`: a foreground Agent call whose subagent Reads hello.txt
 * and answers "alpha line one"):
 * - the main chat's Agent step line is a link (same box and color, a pointer, the
 *   tooltip) that opens `/sessions/{id}/agents/{agentId}`: the top bar "← Main
 *   chat · general-purpose: Read hello.txt and return first line" with the status,
 *   the brief ("Brief from the main agent") as the first bubble, the subagent's
 *   text and its `✓ Read · hello.txt` step, the call's result ("Result") last, and
 *   in the composer's place the note "Subagents take no messages · reply in the
 *   main chat" (no field, no quick replies);
 * - Esc, the browser's Back and the bar's link return to the main chat at the
 *   scroll position it had; a reload on the subagent's address shows it; an
 *   unknown agent id shows "This subagent has no chat here" with the back link;
 * - the right panel's card and the overview's row of a subagent that still works
 *   (`subagent-perm`: waiting on a permission) open its chat too.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('subagent-chat');
});

test.afterAll(async () => {
  await world?.stop();
});

const DESCRIPTION = 'Read hello.txt and return first line';
const BRIEF = 'Read the file hello.txt in the current directory and reply with its first line only.';
const NOTE = 'Subagents take no messages · reply in the main chat';

/** A long plain reply, so the main chat scrolls. */
const LONG = Array.from({ length: 36 }, (_, i) => `Line ${i + 1} of a long answer that fills the chat.`).join('\n');

function say(reply: string): string {
  return `Report. [fake:say ${JSON.stringify(reply)}]`;
}

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return (await response.json()) as SessionDetail;
  }, id);
}

async function send(page: Page, id: string, text: string): Promise<void> {
  const status = await page.evaluate(
    async ({ sessionId, body }) => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      return response.status;
    },
    { sessionId: id, body: text },
  );
  expect(status).toBe(202);
}

async function results(page: Page, id: string): Promise<number> {
  return (await detail(page, id)).events.filter((event) => (event.payload as { type?: string } | null)?.type === 'result').length;
}

/** Sends a message and waits until its turn finished (one more result, the session done again). */
async function turn(page: Page, id: string, text: string): Promise<void> {
  const before = await results(page, id);
  await send(page, id, text);
  await expect.poll(() => results(page, id)).toBeGreaterThan(before);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
}

async function scrollTop(chat: Locator): Promise<number> {
  return chat.evaluate((el) => el.scrollTop);
}

async function expectMainChatAt(page: Page, id: string, top: number): Promise<void> {
  await expect(page).toHaveURL(`${world.baseUrl}/sessions/${id}`);
  const chat = page.getByTestId('session-chat');
  await expect(chat).toBeVisible();
  await expect(page.getByTestId('chat-composer')).toBeVisible();
  await expect.poll(async () => Math.abs((await scrollTop(chat)) - top)).toBeLessThanOrEqual(1);
}

test('D36: the Agent step opens the subagent chat; Esc, Back and the bar return to the main chat at its scroll; reload; unknown id', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'subagent-e2e', say(LONG));
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  await turn(page, id, '[fake:subagent-forward] Ask a subagent for the first line.');
  await turn(page, id, say(LONG));
  const agents = (await detail(page, id)).agents;
  const sub = agents.find((agent) => agent.kind === 'subagent');
  expect(sub?.name).toBe('general-purpose');
  expect(sub?.toolUseId).toMatch(/^toolu_/);
  const subUrl = `${world.baseUrl}/sessions/${id}/agents/${sub?.id ?? ''}`;

  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const chat = page.getByTestId('session-chat');
  const step = chat.locator('[data-testid="chat-step"][data-subagent-id]');
  await expect(step).toHaveCount(1);
  await expect(step).toHaveText(`✓ Agent · general-purpose · ${DESCRIPTION}`);
  // A link in the step line's own style: same color, box and type as the other lines, a pointer, the tooltip.
  await expect(step).toHaveAttribute('href', `/sessions/${id}/agents/${sub?.id ?? ''}`);
  await expect(step).toHaveAttribute('title', "Open this subagent's chat");
  await expect(step).toHaveCSS('cursor', 'pointer');
  await expect(step).toHaveCSS('color', 'rgb(141, 140, 135)');
  await expect(step).toHaveCSS('text-decoration-line', 'none');
  await expect(step).toHaveCSS('font-size', '12px');
  await expect(step).toHaveCSS('display', 'block');
  // Keyboard-focusable (an <a href>).
  await step.focus();
  await expect(step).toBeFocused();
  // The other step lines stay plain.
  await expect(chat.locator('[data-testid="chat-step"]:not([data-subagent-id])')).toHaveCount(0);

  // The chat scrolls: bring the Agent step into view, away from the bottom, and remember where.
  await step.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const top = await scrollTop(chat);
  expect(top).toBeGreaterThan(0);
  expect(await chat.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(100);

  // The step opens the subagent's chat.
  await step.click();
  await expect(page).toHaveURL(subUrl);
  const bar = page.getByTestId('subagent-bar');
  await expect(bar.getByTestId('subagent-back')).toHaveText('← Main chat');
  await expect(bar.getByTestId('subagent-title')).toHaveText(`general-purpose: ${DESCRIPTION}`);
  await expect(bar).toHaveAttribute('data-status', 'done');
  await expect(bar.getByTestId('subagent-status')).toHaveText('done');
  const doneColor = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--status-done)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(bar.getByTestId('subagent-dot')).toHaveCSS('background-color', doneColor);
  await expect(bar).toContainText(`← Main chat·general-purpose: ${DESCRIPTION}`);
  const subChat = page.getByTestId('subagent-chat');
  // The brief first, then its messages and steps, then the result.
  const brief = subChat.getByTestId('subagent-brief');
  await expect(brief.getByTestId('subagent-brief-label')).toHaveText('Brief from the main agent');
  await expect(brief.getByTestId('chat-text')).toHaveText(BRIEF);
  await expect(subChat.locator('[data-testid="chat-message"][data-role="agent"] [data-testid="chat-text"]')).toHaveText([
    "I'll read the hello.txt file from the current directory.",
    'alpha line one',
  ]);
  await expect(subChat.getByTestId('chat-step')).toHaveText(['✓ Read · hello.txt']);
  const result = subChat.getByTestId('subagent-result');
  await expect(result.getByTestId('subagent-result-label')).toHaveText('Result');
  await expect(result.getByTestId('chat-text')).toContainText('alpha line one');
  await expect(result).toHaveAttribute('data-error', 'false');
  expect(await subChat.evaluate((el) => [...el.children].map((child) => child.getAttribute('data-testid')))).toEqual([
    'subagent-brief',
    'chat-message',
    'chat-message',
    'subagent-result',
  ]);
  // No composer: the note in its place, no quick replies.
  await expect(page.getByTestId('chat-composer')).toHaveCount(0);
  await expect(page.getByTestId('chat-input')).toHaveCount(0);
  await expect(page.getByTestId('chat-quick-reply')).toHaveCount(0);
  await expect(page.getByTestId('subagent-note')).toHaveText(NOTE);
  // The session header's Chat tab stays the current tab.
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-tab', 'chat');

  // Esc returns to the main chat at the same scroll.
  await page.keyboard.press('Escape');
  await expectMainChatAt(page, id, top);

  // So does the browser's Back.
  await step.click();
  await expect(page).toHaveURL(subUrl);
  await page.goBack();
  await expectMainChatAt(page, id, top);

  // And the bar's link.
  await step.click();
  await expect(page).toHaveURL(subUrl);
  await page.getByTestId('subagent-back').click();
  await expectMainChatAt(page, id, top);

  // Esc while a popover is open closes only the popover.
  await step.click();
  await expect(page).toHaveURL(subUrl);
  await page.getByTestId('session-model-button').click();
  await expect(page.getByTestId('model-popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('model-popover')).toHaveCount(0);
  await expect(page).toHaveURL(subUrl);
  await expect(page.getByTestId('subagent-bar')).toBeVisible();

  // A reload on the subagent's address shows it.
  await page.reload();
  await expect(page.getByTestId('subagent-title')).toHaveText(`general-purpose: ${DESCRIPTION}`);
  await expect(page.getByTestId('subagent-brief').getByTestId('chat-text')).toHaveText(BRIEF);
  await expect(page.getByTestId('subagent-result')).toContainText('alpha line one');
  // After the reload, Esc still goes one step back to the main chat (the entry it was opened from).
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(`${world.baseUrl}/sessions/${id}`);

  // An unknown agent id: the note and the back link.
  await page.goto(`${world.baseUrl}/sessions/${id}/agents/no-such-agent`);
  await expect(page.getByTestId('subagent-missing')).toHaveText('This subagent has no chat here');
  await expect(page.getByTestId('chat-composer')).toHaveCount(0);
  await page.getByTestId('subagent-back').click();
  await expect(page).toHaveURL(`${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('chat-composer')).toBeVisible();
});

test('D36: the card and the overview row of a subagent that still works open its chat', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'subagent-run-e2e', 'Reply with just OK.');
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  // The subagent runs in the background and waits on a permission for its Bash call (fake-claude blocks there).
  await send(page, id, '[fake:subagent-perm] Run it in a subagent.');
  await expect.poll(async () => (await detail(page, id)).agents.filter((agent) => agent.kind === 'subagent').length).toBe(1);
  const sub = (await detail(page, id)).agents.find((agent) => agent.kind === 'subagent');
  expect(sub?.status).not.toBe('done');
  const subUrl = `${world.baseUrl}/sessions/${id}/agents/${sub?.id ?? ''}`;

  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const panel = page.getByTestId('session-right-panel');
  const row = panel.locator(`[data-testid="overview-row"][data-agent-id="${sub?.id ?? ''}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveCSS('cursor', 'pointer');
  const open = row.getByTestId('overview-open');
  await expect(open).toHaveText('general-purpose');
  await expect(open).toHaveAttribute('title', "Open this subagent's chat");
  // The main agent's row does not link.
  await expect(panel.getByTestId('overview-open')).toHaveCount(1);
  await expect(panel.getByTestId('agents-finished')).toHaveCount(0);

  // The row opens the chat: the brief, its Bash call and the open permission request; no result yet (it runs in the background).
  await row.getByTestId('overview-description').click();
  await expect(page).toHaveURL(subUrl);
  await expect(page.getByTestId('subagent-title')).toHaveText('general-purpose: Run a Node command and report the output');
  await expect(page.getByTestId('subagent-brief').getByTestId('chat-text')).toHaveText(
    'Run the shell command node -e "console.log(6*7)" with the Bash tool (exactly that command) and report what it printed.',
  );
  await expect(page.getByTestId('subagent-chat').getByTestId('chat-step')).toHaveText([
    '● Bash · node -e "console.log(6*7)"',
    '⏸ Permission · Bash · node -e "console.log(6*7)"',
  ]);
  await expect(page.getByTestId('subagent-result')).toHaveCount(0);
  await expect(page.getByTestId('subagent-note')).toHaveText(NOTE);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(`${world.baseUrl}/sessions/${id}`);

  // The row's name link (keyboard: focus + Enter).
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(subUrl);
  await page.goBack();
  await expect(page).toHaveURL(`${world.baseUrl}/sessions/${id}`);

  // The agent card opens it too; the main agent's card stays a plain card.
  const card = panel.locator(`[data-testid="agent-card"][data-agent-id="${sub?.id ?? ''}"]`);
  await expect(card).toHaveAttribute('href', `/sessions/${id}/agents/${sub?.id ?? ''}`);
  await expect(panel.locator('a[data-testid="agent-card"]')).toHaveCount(1);
  await card.click();
  await expect(page).toHaveURL(subUrl);
  await expect(page.getByTestId('subagent-bar')).toBeVisible();
});
