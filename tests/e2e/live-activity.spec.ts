import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { THINKING_VERBS } from '../../src/web/activity/activity.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D19 live activity on the real path (D13, no demo seed): `node src/server/main.ts`
 * with fake-claude as the CLI. D30: a session whose turn ended while background work
 * it started still runs (a `gh run view` wait, `[fake:background-gh]`) shows that wait
 * the same way until the CLI reports its end and runs its own turn. A turn that
 * stays running shows, live over `/hub`:
 * - the chat line above the composer (`● Bash: <command>  0:0n` for the recorded
 *   slow Bash call, `interrupt-tool`; the rotating verb, the turn's time and the
 *   thinking tokens for a turn that keeps thinking, `hang`);
 * - the sidebar row's action + time in place of the mode line, with a pulsing dot;
 * - the main agent card's action + time in its status slot;
 * each with a time that grows, and all of them gone (idle views as before) once the
 * turn ends (Pause interrupts it).
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('live-activity');
});

test.afterAll(async () => {
  await world?.stop();
});

const SLOW_COMMAND = 'node -e "setTimeout(()=>console.log(1),20000)"';

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

/** Seconds of a `0:42` / `1:02:03` clock or a `12s` / `1m 23s` elapsed time. */
function seconds(text: string): number {
  const clock = /^(?:(\d+):)?(\d+):(\d{2})$/.exec(text.trim());
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const elapsed = /^(?:(\d+)m )?(\d+)s$/.exec(text.trim());
  if (elapsed) return Number(elapsed[1] ?? 0) * 60 + Number(elapsed[2]);
  throw new Error(`not a time: ${text}`);
}

/** Waits until the time shown in `locator` grew past `from` seconds. */
async function expectGrowing(locator: Locator, what: string): Promise<void> {
  const first = seconds(await locator.innerText());
  await expect.poll(async () => seconds(await locator.innerText()), { message: `${what} grows`, timeout: 5_000 }).toBeGreaterThan(first);
}

test('a running turn: chat line, sidebar action and agent card action with a growing time; gone when the turn ends', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'live-e2e', '[fake:interrupt-tool] Run the slow command.');
  await expect.poll(async () => (await detail(page, id)).activity?.state).toBe('tool');
  const started = await detail(page, id);
  expect(started.status).toBe('run');
  expect(started.activity).toMatchObject({ state: 'tool', tool: 'Bash', summary: SLOW_COMMAND });

  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);

  // Chat: `● Bash: <command>` and the time since the tool started, above the composer.
  const line = page.getByTestId('chat-activity');
  await expect(line).toHaveAttribute('data-state', 'tool');
  await expect(page.getByTestId('chat-activity-glyph')).toHaveText('●');
  await expect(page.getByTestId('chat-activity-text')).toHaveText(`Bash: ${SLOW_COMMAND}`);
  await expect(page.getByTestId('chat-activity-time')).toHaveText(/^0:\d{2}$/);
  await expect(page.getByTestId('chat-activity-tokens')).toHaveCount(0);
  await expectGrowing(page.getByTestId('chat-activity-time'), 'the tool clock');
  // It sits between the conversation and the composer; mono meta, muted, the running blue glyph that blinks.
  const order = await page.locator('.sb-sv-main > *').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(order.indexOf('chat-activity')).toBe(order.indexOf('session-chat') + 1);
  expect(order.indexOf('chat-composer')).toBe(order.indexOf('chat-activity') + 1);
  await expect(line).toHaveCSS('font-family', /Geist Mono/);
  await expect(line).toHaveCSS('font-size', '12px');
  await expect(line).toHaveCSS('color', 'rgb(141, 140, 135)');
  await expect(page.getByTestId('chat-activity-glyph')).toHaveCSS('animation-name', 'sb-activity-blink');

  // Sidebar: the action and its time in place of the mode line; the dot pulses.
  const row = page.getByTestId('sidebar-sessions').locator('a').filter({ hasText: 'live-e2e' });
  await expect(row.getByTestId('session-activity')).toHaveAttribute('data-state', 'tool');
  await expect(row.getByTestId('session-activity')).toContainText(`Bash: ${SLOW_COMMAND}`);
  await expect(row.locator('.sb-session-mode')).not.toContainText('single · feature · UI-first');
  await expectGrowing(row.getByTestId('session-activity-time'), 'the sidebar time');
  const dot = row.locator('.sb-session-dot');
  await expect(dot).toHaveAttribute('data-activity', 'tool');
  await expect(dot).toHaveCSS('animation-name', 'sb-activity-pulse');

  // Right panel: the main agent's card shows the same action and time in its status slot.
  const card = page.getByTestId('session-right-panel').getByTestId('agent-card').first();
  await expect(card.getByTestId('agent-activity')).toHaveAttribute('data-state', 'tool');
  await expect(card.getByTestId('agent-activity')).toContainText(`Bash: ${SLOW_COMMAND}`);
  await expectGrowing(card.getByTestId('agent-activity-time'), 'the agent card time');

  // Pause interrupts the turn: every activity view goes, the idle views are back.
  await page.getByTestId('session-pause').click();
  await expect.poll(async () => (await detail(page, id)).status).toBe('paused');
  await expect(line).toHaveCount(0);
  await expect(row.getByTestId('session-activity')).toHaveCount(0);
  await expect(row.locator('.sb-session-mode')).toHaveText('single · feature · UI-first');
  await expect(dot).not.toHaveAttribute('data-activity');
  await expect(dot).toHaveCSS('animation-name', 'none');
  await expect(card.getByTestId('agent-activity')).toHaveCount(0);
  await expect(card.getByTestId('agent-status')).toHaveText('paused');
  expect((await detail(page, id)).activity).toBeNull();

  // A turn that keeps thinking: a verb of Switchboard's list, the turn's time (`Ns`) and the thinking tokens.
  await send(page, id, '[fake:hang] Keep thinking.');
  await expect(line).toHaveAttribute('data-state', 'thinking');
  await expect(page.getByTestId('chat-activity-glyph')).toHaveText('');
  const verb = await page.getByTestId('chat-activity-text').innerText();
  expect(THINKING_VERBS).toContain(verb);
  await expect(page.getByTestId('chat-activity-time')).toHaveText(/^\d+s$/);
  await expect(page.getByTestId('chat-activity-tokens')).toHaveText(/^· ↓ \d+(\.\d)?k? tokens$/);
  await expectGrowing(page.getByTestId('chat-activity-time'), 'the turn time');
  // The spinner is a glyph that changes in place.
  const spinner = await page.getByTestId('chat-activity-glyph').evaluate((el) => getComputedStyle(el, '::before').animationName);
  expect(spinner).toBe('sb-activity-spin');
  await expect(row.getByTestId('session-activity')).toHaveAttribute('data-state', 'thinking');
  await expect(row.getByTestId('session-activity')).toContainText('Thinking…');
  // D21 ruling: the main agent's card thinks with the chat line's rotating verb.
  await expect(card.getByTestId('agent-activity')).toHaveAttribute('data-state', 'thinking');
  expect(THINKING_VERBS).toContain(await card.getByTestId('agent-activity').locator('.sb-activity-label-text').innerText());

  await page.getByTestId('session-pause').click();
  await expect.poll(async () => (await detail(page, id)).status).toBe('paused');
  await expect(line).toHaveCount(0);
  await expect(row.getByTestId('session-activity')).toHaveCount(0);
  await expect(card.getByTestId('agent-activity')).toHaveCount(0);
});

/** The computed value of a CSS color token in the page (e.g. `--status-run`). */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

test('D30: a background GitHub Actions wait after the turn: chat line, sidebar row, agent card and overview with a growing time; gone once its notification\'s turn ran', async ({ page }) => {
  const GH = 'gh run view 4242 --json status --jq .status';
  const WAIT = `Waiting for GitHub Actions: ${GH}`;
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'background-e2e', 'Wait for the CI run. [fake:background-gh 20]');
  await expect.poll(async () => (await detail(page, id)).activity?.state).toBe('background');
  const waiting = await detail(page, id);
  // The turn is over (its status is the turn's), the wait is the activity.
  expect(waiting.status).toBe('done');
  expect(waiting.activity).toMatchObject({ state: 'background', tool: 'Bash', summary: GH, thinkingTokens: null });
  expect(waiting.activity?.background).toMatchObject([{ kind: 'bash', github: true, summary: GH }]);

  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('session-chat')).toContainText('STARTED');

  // Chat: ⏳ (amber, still), the wait's words and the time since it started, above the composer.
  const line = page.getByTestId('chat-activity');
  await expect(line).toHaveAttribute('data-state', 'background');
  const glyph = page.getByTestId('chat-activity-glyph');
  await expect(glyph).toHaveText('⏳');
  await expect(glyph).toHaveAttribute('data-glyph', '⏳');
  await expect(glyph).toHaveCSS('color', await tokenColor(page, '--status-need'));
  await expect(glyph).toHaveCSS('animation-name', 'none');
  await expect(page.getByTestId('chat-activity-text')).toHaveText(WAIT);
  await expect(page.getByTestId('chat-activity-time')).toHaveText(/^0:\d{2}$/);
  await expect(page.getByTestId('chat-activity-more')).toHaveCount(0);
  await expect(page.getByTestId('chat-activity-tokens')).toHaveCount(0);
  await expectGrowing(page.getByTestId('chat-activity-time'), 'the wait clock');
  const order = await page.locator('.sb-sv-main > *').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(order.indexOf('chat-composer')).toBe(order.indexOf('chat-activity') + 1);

  // Sidebar: the wait and its time in place of the mode line; the dot pulses in the running color.
  const row = page.getByTestId('sidebar-sessions').locator('a').filter({ hasText: 'background-e2e' });
  await expect(row.getByTestId('session-activity')).toHaveAttribute('data-state', 'background');
  await expect(row.getByTestId('session-activity')).toContainText(WAIT);
  await expect(row.locator('.sb-session-mode')).not.toContainText('single · feature · UI-first');
  await expectGrowing(row.getByTestId('session-activity-time'), 'the sidebar time');
  const dot = row.locator('.sb-session-dot');
  await expect(dot).toHaveAttribute('data-activity', 'background');
  await expect(dot).toHaveCSS('animation-name', 'sb-activity-pulse');
  await expect(dot).toHaveCSS('background-color', await tokenColor(page, '--status-run'));

  // Right panel: the main agent's card and its overview row show the same wait (the overview with ⏳).
  const card = page.getByTestId('session-right-panel').getByTestId('agent-card').first();
  await expect(card.getByTestId('agent-activity')).toHaveAttribute('data-state', 'background');
  await expect(card.getByTestId('agent-activity')).toContainText(WAIT);
  await expectGrowing(card.getByTestId('agent-activity-time'), 'the agent card time');
  const overview = page.getByTestId('overview-row').first().getByTestId('overview-activity');
  await expect(overview).toHaveAttribute('data-state', 'background');
  await expect(overview).toContainText(`⏳ ${WAIT}`);

  // The task ends: the CLI's own turn runs (its reply lands in the chat) and every indicator goes.
  await expect(page.getByTestId('session-chat')).toContainText('FINISHED', { timeout: 40_000 });
  await expect(line).toHaveCount(0);
  await expect(row.getByTestId('session-activity')).toHaveCount(0);
  await expect(row.locator('.sb-session-mode')).toHaveText('single · feature · UI-first');
  await expect(dot).not.toHaveAttribute('data-activity');
  await expect(dot).toHaveCSS('animation-name', 'none');
  await expect(card.getByTestId('agent-activity')).toHaveCount(0);
  await expect(card.getByTestId('agent-status')).toHaveText('done');
  const after = await detail(page, id);
  expect(after.activity).toBeNull();
  expect(after.status).toBe('done');
  expect(after.events.some((event) => (event.payload as { taskNotification?: boolean }).taskNotification === true)).toBe(true);
});

test('an idle session: no activity line, the mode line and a still dot, as before', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'idle-e2e', 'Remember the code word: zeppelin. Reply with just OK.');
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('chat-composer')).toBeVisible();
  await expect(page.getByTestId('chat-activity')).toHaveCount(0);
  const row = page.getByTestId('sidebar-sessions').locator('a').filter({ hasText: 'idle-e2e' });
  await expect(row.locator('.sb-session-mode')).toHaveText('single · feature · UI-first');
  await expect(row.locator('.sb-session-dot')).toHaveCSS('animation-name', 'none');
  await expect(page.getByTestId('session-right-panel').getByTestId('agent-status').first()).toHaveText('done');
  expect((await detail(page, id)).activity).toBeNull();
});
