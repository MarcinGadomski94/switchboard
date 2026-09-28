import { type Locator, type Page, expect, test } from '@playwright/test';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * The Timeline tab (M4.4) on the real code path (D13, no demo seed): the server
 * runs fake-claude as the CLI in a temp workspace; a session started through the
 * API replays recorded turns (`tool-use`: Write + Bash, `subagent`: an Agent call
 * whose subagent Reads, `ask-2q`: an AskUserQuestion that stays open). The tab
 * shows one lane per agent with blocks colored by kind, the white playhead, the
 * scrubber with ▶ / ❚❚, the "Events up to" log and the terminal tail, and follows
 * new events through `/hub` without a reload.
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('timeline');
});

test.afterAll(async () => {
  await world?.stop();
});

/** The color `value` computes to in this page (Chromium keeps oklch as `oklch(…)`). */
async function computed(page: Page, value: string): Promise<string> {
  return page.evaluate((v) => {
    const probe = document.createElement('div');
    probe.style.color = v;
    document.body.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, value);
}

async function style(locator: Locator, prop: string): Promise<string> {
  return locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
}

async function sessionStatus(page: Page, id: string): Promise<string> {
  return page.evaluate(async (sid) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}`);
    return ((await response.json()) as { status: string }).status;
  }, id);
}

async function sendMessage(page: Page, id: string, text: string): Promise<void> {
  const status = await page.evaluate(
    async ({ sid, body }) => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      return response.status;
    },
    { sid: id, body: text },
  );
  expect(status).toBe(202);
}

test('Timeline: lanes per agent, kind colors, playhead, scrub / play, log, terminal and live events', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  const { id } = await world.startSession(page, 'timeline-e2e', 'Write a file and list the folder [fake:tool-use]');
  await expect.poll(() => sessionStatus(page, id), { timeout: 15_000 }).toBe('done');

  await openWithHub(page, `${world.baseUrl}/sessions/${id}/timeline`);
  const tab = page.getByTestId('session-timeline');
  await expect(tab).toHaveAttribute('data-session-id', id);

  // One lane: the main agent (single-solution → the solution's name), in the workspace root.
  const lanes = page.getByTestId('timeline-lane');
  await expect(lanes).toHaveCount(1);
  await expect(lanes.first()).toHaveAttribute('data-agent', 'acme-app-front');
  await expect(lanes.first().locator('.sb-timeline__name')).toHaveText('acme-app-front');
  await expect(lanes.first().locator('.sb-timeline__sub')).toHaveText('workspace root');

  // Blocks: Write + Bash (impl), the turn's result (ok); the task message is chat text, not a block.
  const blocks = page.getByTestId('timeline-block');
  await expect(blocks).toHaveText(['Write · out.txt', 'Bash · ls', 'DONE']);
  await expect(blocks.nth(0)).toHaveAttribute('data-kind', 'impl');
  await expect(blocks.nth(1)).toHaveAttribute('data-kind', 'impl');
  await expect(blocks.nth(2)).toHaveAttribute('data-kind', 'ok');
  expect(await style(blocks.nth(0), 'background-color')).toBe(await computed(page, 'oklch(0.3 0.06 250)'));
  expect(await style(blocks.nth(0), 'border-top-color')).toBe(await computed(page, 'oklch(0.45 0.09 250)'));
  expect(await style(blocks.nth(0), 'color')).toBe(await computed(page, '#e8e7e3'));
  expect(await style(blocks.nth(2), 'background-color')).toBe(await computed(page, 'oklch(0.3 0.06 150)'));
  expect(await style(blocks.nth(2), 'border-top-color')).toBe(await computed(page, 'oklch(0.45 0.09 150)'));
  expect(await style(blocks.nth(0), 'font-family')).toContain('Geist Mono');
  await expect(blocks.nth(0)).toHaveAttribute('title', 'Write · out.txt');

  // Geometry: 150px label column, 34px lanes (+1px border), white 2px playhead at the end.
  const label = lanes.first().locator('.sb-timeline__label');
  const track = lanes.first().getByTestId('timeline-track');
  expect((await label.boundingBox())?.width).toBe(150);
  expect((await track.boundingBox())?.height).toBe(36);
  expect(await style(track, 'height')).toBe('34px');
  const head = track.getByTestId('timeline-playhead');
  expect(await style(head, 'background-color')).toBe(await computed(page, '#e8e7e3'));
  expect(await style(head, 'width')).toBe('2px');
  const trackBox = (await track.boundingBox())!;
  const headBox = (await head.boundingBox())!;
  expect(Math.abs(headBox.x - (trackBox.x + trackBox.width - 1))).toBeLessThanOrEqual(1.5);
  for (const block of await blocks.all()) {
    const box = (await block.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(trackBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(trackBox.x + trackBox.width + 0.5);
  }

  // Axis: a short session shows seconds; 7 ticks; the clock at the playhead is the end.
  const range = page.getByTestId('timeline-range');
  await expect(range).toHaveText(/^\d{1,2}:\d{2}:\d{2} – \d{1,2}:\d{2}:\d{2}$/);
  await expect(page.getByTestId('timeline-ticks').locator('span')).toHaveCount(7);
  const [startClock, endClock] = (await range.innerText()).split(' – ');
  const now = page.getByTestId('timeline-now');
  await expect(now).toHaveText(endClock!);
  await expect(page.getByTestId('timeline-log-head')).toHaveText(`Events up to ${endClock}`);
  await expect(page.getByTestId('timeline-play')).toHaveText('▶');

  // The log: every block up to the playhead, "who · label", dot colored by kind.
  const log = page.getByTestId('timeline-log-entry');
  await expect(log).toHaveCount(3);
  await expect(log.nth(0)).toContainText('acme-app-front · Write · out.txt');
  await expect(log.nth(2)).toContainText('acme-app-front · DONE');
  expect(await style(log.nth(0).locator('.sb-timeline__log-dot'), 'background-color')).toBe(await computed(page, 'oklch(0.72 0.12 250)'));
  expect(await style(log.nth(2).locator('.sb-timeline__log-dot'), 'background-color')).toBe(await computed(page, 'oklch(0.74 0.13 150)'));

  // Terminal tail: the process start, the finished tools, the Bash command and its last output line, the result.
  const term = page.getByTestId('timeline-terminal-line');
  await expect(term).toHaveText(['Started', '✓ Write · out.txt', '$ ls', 'out.txt', '✓ DONE']);
  expect(await style(term.nth(0), 'color')).toBe(await computed(page, '#bfbeb8'));
  expect(await style(term.nth(2), 'color')).toBe(await computed(page, '#6d6c67'));
  expect(await style(term.nth(4), 'color')).toBe(await computed(page, 'oklch(0.78 0.12 150)'));
  expect(await style(page.getByTestId('timeline-terminal'), 'background-color')).toBe(await computed(page, '#0c0d0f'));

  // Scrub to the start: the playhead moves left, every block dims, the log empties.
  const scrubber = page.getByTestId('timeline-scrubber');
  await scrubber.fill('0');
  await expect(now).toHaveText(startClock!);
  await expect(page.getByTestId('timeline-log-head')).toHaveText(`Events up to ${startClock}`);
  await expect(log).toHaveCount(0);
  await expect(page.locator('[data-testid="timeline-block"][data-dim="true"]')).toHaveCount(3);
  expect(await style(blocks.nth(0), 'opacity')).toBe('0.35');
  const headAtStart = (await head.boundingBox())!;
  expect(Math.abs(headAtStart.x - (trackBox.x + 1))).toBeLessThanOrEqual(1.5);

  // ▶ plays from the scrubber position to the end (❚❚ while playing), then shows ▶ again.
  const play = page.getByTestId('timeline-play');
  await play.click();
  await expect(play).toHaveText('❚❚');
  await expect.poll(async () => Number(await scrubber.inputValue())).toBeGreaterThan(0);
  await play.click();
  await expect(play).toHaveText('▶');
  const paused = Number(await scrubber.inputValue());
  expect(paused).toBeGreaterThan(0);
  expect(paused).toBeLessThan(1000);
  await page.waitForTimeout(200);
  expect(Number(await scrubber.inputValue())).toBe(paused);
  await play.click();
  await expect(play).toHaveText('▶', { timeout: 10_000 });
  expect(Number(await scrubber.inputValue())).toBe(1000);
  await expect(now).toHaveText(endClock!);
  await expect(page.locator('[data-testid="timeline-block"][data-dim="true"]')).toHaveCount(0);
  await expect(log).toHaveCount(3);

  // Live: a subagent turn arrives through /hub: its own lane with a plan block, tagged terminal lines.
  await sendMessage(page, id, 'Read hello.txt with a subagent [fake:subagent]');
  await expect(lanes).toHaveCount(2, { timeout: 15_000 });
  await expect(lanes.nth(1)).toHaveAttribute('data-agent', 'general-purpose');
  const subBlocks = lanes.nth(1).getByTestId('timeline-block');
  await expect(subBlocks).toHaveText(['Read · hello.txt']);
  await expect(subBlocks.first()).toHaveAttribute('data-kind', 'plan');
  expect(await style(subBlocks.first(), 'background-color')).toBe(await computed(page, 'oklch(0.26 0.02 250)'));
  expect(await style(subBlocks.first(), 'color')).toBe(await computed(page, '#c9c8c3'));
  // The Agent call itself is a `tool` event: no block on the main lane.
  await expect(lanes.nth(0).getByTestId('timeline-block')).toHaveText(['Write · out.txt', 'Bash · ls', 'DONE', 'alpha line one'], { timeout: 15_000 });
  await expect(page.getByTestId('timeline-log-entry').last()).toContainText('acme-app-front · alpha line one');
  await expect(page.getByTestId('timeline-log-entry')).toContainText(['general-purpose · Read · hello.txt']);
  await expect(term).toContainText(['[general-purpose] ✓ Read · hello.txt']);
  await expect(term.last()).toHaveText('✓ alpha line one');

  // Live: an open question is an ask block that runs until now; the axis moves with the clock.
  await sendMessage(page, id, 'Ask me two things [fake:ask-2q]');
  const ask = page.locator('[data-testid="timeline-block"][data-kind="ask"]');
  await expect(ask).toHaveCount(1, { timeout: 15_000 });
  await expect(ask).toHaveText('2 questions · Which color should the button be?');
  await expect(ask).toHaveAttribute('data-open', 'true');
  expect(await style(ask, 'background-color')).toBe(await computed(page, 'oklch(0.32 0.07 70)'));
  expect(await style(ask, 'color')).toBe(await computed(page, '#f5f4f0'));
  await expect(term.last()).toHaveText('⏸ 2 questions · Which color should the button be?');
  expect(await style(term.last(), 'color')).toBe(await computed(page, 'oklch(0.8 0.13 70)'));
  const before = await range.innerText();
  await expect.poll(() => range.innerText(), { timeout: 5_000 }).not.toBe(before);
  const askBox = (await ask.boundingBox())!;
  const track0 = (await lanes.nth(0).getByTestId('timeline-track').boundingBox())!;
  expect(Math.abs(askBox.x + askBox.width - (track0.x + track0.width - 1))).toBeLessThanOrEqual(2);
});
