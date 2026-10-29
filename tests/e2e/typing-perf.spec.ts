import { type Browser, type CDPSession, type Page, expect, test } from '@playwright/test';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { appendHistory } from '../../tools/bench/world.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { armTypingProbe, installTypingProbe, percentile, readTypingProbe } from './typing-probe.ts';
import { useV2 } from './v2-world.ts';

/**
 * Typing lag in a long chat (developer report 2026-10-29: "for some chats, it feels
 * like there is a lag when I'm writing in a text box"; `docs/performance.md` →
 * *Typing in a long chat*). A real fake-claude session grown to ≈3,000 events (the
 * benchmark's history: Markdown, code blocks, tables, tool calls, subagents), in the
 * v2 agent view (desktop and phone) and the classic session view. The probe
 * (`typing-probe.ts`) counts React's work through a stub of its DevTools hook.
 *
 * Always on (counts, no timings):
 * 1. **Typing renders nothing in the conversation.** 30 keys: fewer than 20
 *    components rendered inside it (the chat pane's own shell may render on the
 *    shell's 5 s tick; one whole-window render is ≈1,000).
 * 2. **Idle, the conversation stays still.** 6 s with the view open (the shell's
 *    `system` tick every 5 s): fewer than 20 (it rendered the whole window on every
 *    tick: ≈1,050 a tick in v2).
 * 3. **A received message renders its own rows**, not the window: fewer than 300
 *    components in the conversation for one `[fake:say]` turn (≈8,500 in v2 and
 *    ≈7,000 in classic before: every row, for each of its `/hub` events).
 * 4. v2: **typing one line never writes the field's style** (the autosize collapsed
 *    the field and set its height again on every key).
 *
 * Opt-in timings (`SWITCHBOARD_PERF=1`, CPU throttled 4×): keystroke → next frame
 * p95 under 50 ms idle and under 100 ms while the agent streams turns; at most one
 * draft save per half second of typing.
 */
test.use({ trace: 'off' });

const PERF = process.env['SWITCHBOARD_PERF'] === '1';
const EVENTS = 3_000;

let world: QuestionWorld;
let sessionId = '';

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  world = await startQuestionWorld('typing-perf');
  const page = await browser.newPage();
  await page.goto(world.baseUrl);
  const { id } = await world.startSession(page, 'typing-perf', 'Say hello.');
  sessionId = id;
  await settled(page);
  await page.close();
  const store = await openStore(storeFile(world.dataDir));
  try {
    const main = (await store.agents.listBySession(id)).find((agent) => agent.kind === 'main');
    if (!main) throw new Error('no main agent');
    const now = Date.now();
    appendHistory(store, id, main.id, EVENTS, { seed: 7, startMs: now - 3 * 86_400_000, endMs: now - 10 * 60_000, liveCron: false });
  } finally {
    await store.close();
  }
});

test.afterAll(async () => {
  await world?.stop();
});

async function settled(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate(async (sid) => ((await (await fetch(`/api/sessions/${sid}`)).json()) as { status: string }).status, sessionId), { timeout: 30_000 }).toBe('done');
}

interface View {
  readonly name: string;
  readonly v2: boolean;
  readonly phone: boolean;
  readonly input: string;
  readonly chat: string;
  readonly message: string;
}

const VIEWS: readonly View[] = [
  { name: 'v2 desktop', v2: true, phone: false, input: 'v2-agent-input', chat: '[data-testid="v2-agent-chat"]', message: '[data-testid="v2-agent-chat"] .v2-ag-msg' },
  { name: 'v2 phone', v2: true, phone: true, input: 'v2-agent-input', chat: '[data-testid="v2-agent-chat"]', message: '[data-testid="v2-agent-chat"] .v2-ag-msg' },
  { name: 'classic desktop', v2: false, phone: false, input: 'chat-input', chat: '[data-testid="session-chat"]', message: '[data-testid="session-chat"] [data-testid="chat-message"]' },
];

async function open(browser: Browser, view: View): Promise<{ page: Page; cdp: CDPSession }> {
  const context = await browser.newContext(view.phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  if (view.v2) await useV2(page);
  await installTypingProbe(page);
  const cdp = await context.newCDPSession(page);
  await openWithHub(page, `${world.baseUrl}${view.v2 ? `/agents/${sessionId}` : `/sessions/${sessionId}`}`);
  await expect(page.locator(view.message).first()).toBeVisible({ timeout: 30_000 });
  // The window of the long history is there (not only the fake's own turn).
  await expect.poll(async () => page.locator(view.message).count(), { timeout: 30_000 }).toBeGreaterThan(100);
  const input = page.getByTestId(view.input);
  await input.click();
  await input.fill('');
  await quiet(page);
  return { page, cdp };
}

/** Until a second passes with at most two small React commits (v2's composer ticks once a second); the view's own late loads are not typing. */
async function quiet(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        await armTypingProbe(page, '');
        await page.waitForTimeout(1_000);
        const reading = await readTypingProbe(page);
        return reading.commits <= 2 && reading.rendered < 60;
      },
      { intervals: [0], timeout: 30_000 },
    )
    .toBe(true);
}

for (const view of VIEWS) {
  test(`${view.name}: typing, idling and a received message render (almost) nothing of a 3k-event conversation`, async ({ browser }) => {
    test.setTimeout(120_000);
    const { page } = await open(browser, view);
    const input = page.getByTestId(view.input);

    // 4. (v2) No write to the field's style while one line is typed.
    if (view.v2) {
      await page.evaluate((testId) => {
        (window as unknown as { __sbStyleWrites: number }).__sbStyleWrites = 0;
        new MutationObserver((records) => {
          (window as unknown as { __sbStyleWrites: number }).__sbStyleWrites += records.length;
        }).observe(document.querySelector(`[data-testid="${testId}"]`)!, { attributes: true, attributeFilter: ['style'] });
      }, view.input);
    }

    // 1. Typing.
    await armTypingProbe(page, view.chat);
    await page.keyboard.type('fix the upload flow please now', { delay: 30 });
    await expect(input).toHaveValue('fix the upload flow please now');
    await page.waitForTimeout(300);
    const typing = await readTypingProbe(page);
    expect(typing.commits, 'the probe saw the typing').toBeGreaterThanOrEqual(30);
    expect(typing.renderedInChat, `components rendered in the conversation while typing: ${typing.chatLog.join(' | ')}`).toBeLessThan(20);
    if (view.v2) expect(await page.evaluate(() => (window as unknown as { __sbStyleWrites: number }).__sbStyleWrites), "writes to the field's style while typing one line").toBe(0);

    // 2. Idle: at least one of the shell's 5 s ticks.
    await armTypingProbe(page, view.chat);
    await page.waitForTimeout(6_000);
    const idle = await readTypingProbe(page);
    expect(idle.renderedInChat, `components rendered in the conversation while idle: ${idle.chatLog.join(' | ')}`).toBeLessThan(20);

    // 3. A message received while the view is open (the composer keeps its text).
    await armTypingProbe(page, view.chat);
    const said = `Received while typing ${view.name}.`;
    expect(await page.evaluate(async ({ sid, text }) => (await fetch(`/api/sessions/${sid}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })).status, { sid: sessionId, text: `[fake:say ${JSON.stringify(said)}]` })).toBe(202);
    await expect(page.locator(view.chat).getByText(said)).toBeVisible({ timeout: 30_000 });
    await settled(page);
    await page.waitForTimeout(1_000);
    const received = await readTypingProbe(page);
    expect(received.renderedInChat, `components rendered in the conversation for one received turn: ${received.chatLog.join(' | ')}`).toBeLessThan(300);
    await expect(input).toHaveValue('fix the upload flow please now');
    await input.fill('');
    await page.waitForTimeout(600);
    await page.context().close();
  });
}

const TEXT = 'fix the upload flow so the retries back off, then run the tests again please';

test.describe('timings (SWITCHBOARD_PERF=1)', () => {
  test.skip(!PERF, 'opt-in: SWITCHBOARD_PERF=1');

  for (const view of VIEWS) {
    test(`${view.name}: keystroke → next frame at 4× CPU, idle and while the agent streams`, async ({ browser }) => {
      test.setTimeout(180_000);
      const { page, cdp } = await open(browser, view);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      const puts: number[] = [];
      page.on('request', (request) => {
        if (request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/drafts/composer')) puts.push(Date.now());
      });

      await armTypingProbe(page, view.chat);
      const start = Date.now();
      await page.keyboard.type(TEXT, { delay: 50 });
      const typingMs = Date.now() - start;
      await page.waitForTimeout(1_500);
      const idle = await readTypingProbe(page);
      const p95 = percentile(idle.latencies, 95);
      console.log(`[typing ${view.name}] p50 ${percentile(idle.latencies, 50).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${percentile(idle.latencies, 100).toFixed(1)} ms; ${puts.length} draft PUT(s) in ${typingMs} ms`);
      expect(idle.latencies.length).toBe(TEXT.length);
      expect(p95).toBeLessThan(50);
      expect(puts.length).toBeLessThanOrEqual(Math.ceil(typingMs / 500));

      // While the agent works: it fires short turns of its own.
      await page.getByTestId(view.input).fill('');
      await page.evaluate(async (sid) => fetch(`/api/sessions/${sid}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '[fake:fire 40 120] keep going' }) }), sessionId);
      await page.waitForTimeout(600);
      await armTypingProbe(page, view.chat);
      await page.keyboard.type(TEXT, { delay: 50 });
      const streaming = await readTypingProbe(page);
      const p95s = percentile(streaming.latencies, 95);
      console.log(`[typing while streaming ${view.name}] p50 ${percentile(streaming.latencies, 50).toFixed(1)} ms, p95 ${p95s.toFixed(1)} ms; ${streaming.renderedInChat} components in the conversation`);
      expect(p95s).toBeLessThan(100);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await settled(page);
      await page.getByTestId(view.input).fill('');
      await page.waitForTimeout(600);
      await page.context().close();
    });
  }
});
