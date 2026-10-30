import { type Locator, type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { openWithHub } from './question-world.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.4.12 · v2 answer tooltips on a busy Switchboard. A native `title`
 * tooltip shows only after the pointer rests on the same element for about a
 * second, so an open option must stay the same DOM node, keep `:hover` and keep
 * its `title` while unrelated updates stream in. Five other agents work at once
 * (a message every 150 ms: `sessionUpdated`, `activity`, `event`, `notice`; a todo
 * every 750 ms: `todosChanged`) while the pointer rests on an open option for 6 s
 * in every place v2 shows an answer card: Needs you, Home, the agent's chat, the
 * peek, a crew page and the Board's quick answer. Sampled every 100 ms.
 *
 * Not covered on purpose: a new item arriving moves the lists (newest first), Home
 * shows only the newest cards, and a narrow card's head may wrap when its "just now"
 * turns "1 min ago"; each moves the card under a still pointer once.
 */

test.describe.configure({ mode: 'serial' });

let world: TeamWorld;
let busy: string[] = [];
let crewQuestion = '';
let boardQuestion = '';

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-v2-answer-tooltips-load', { env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory' } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
  // Counts the hub's events by name, so the test knows the stream really flowed.
  await page.addInitScript(() => {
    const w = window as unknown as { __hubEvents: Record<string, number> };
    w.__hubEvents = {};
    const add = EventSource.prototype.addEventListener as (this: EventSource, type: string, listener: (event: Event) => void, options?: boolean | AddEventListenerOptions) => void;
    (EventSource.prototype as unknown as { addEventListener: typeof add }).addEventListener = function (this: EventSource, type, listener, options) {
      add.call(this, type, (event: Event) => {
        w.__hubEvents[type] = (w.__hubEvents[type] ?? 0) + 1;
        listener.call(this, event);
      }, options);
    };
  });
});

const Q = [{ question: 'Which Acme plan?', header: 'Plan', multiSelect: false, options: [{ label: 'Basic', description: 'One seat' }, { label: 'Team', description: 'Up to 10 seats' }] }];
const ask = (questions: unknown): string => `[fake:ask-2q] Ask me. [fake:questions ${JSON.stringify(questions)}]`;

async function inboxCount(page: Page, sessionId: string): Promise<number> {
  const items = await page.evaluate(async () => (await (await fetch('/api/inbox')).json()) as Array<{ sessionId: string }>);
  return items.filter((item) => item.sessionId === sessionId).length;
}

interface Rest {
  readonly samples: number;
  readonly replaced: number;
  readonly hoverLost: number;
  readonly titleLost: number;
  readonly notUnderPointer: number;
  readonly events: Record<string, number>;
}

/** Rests the pointer on `option` for `ms` while the other agents work; what changed under it. */
async function rest(page: Page, option: Locator, ms: number): Promise<Rest> {
  await option.scrollIntoViewIfNeeded();
  await option.hover();
  await page.evaluate((ids) => {
    const w = window as unknown as { __drive: ReturnType<typeof setInterval>; __hubEvents: Record<string, number> };
    w.__hubEvents = {};
    let n = 0;
    const post = (url: string, body: unknown): void => {
      void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    };
    w.__drive = setInterval(() => {
      n += 1;
      const id = ids[n % ids.length] as string;
      post(`/api/sessions/${id}/messages`, { text: `[fake:say "tick ${n}"] tick` });
      if (n % 5 === 0) post(`/api/sessions/${id}/todos`, { text: `todo ${n}` });
    }, 150);
  }, busy);
  const handle = await option.elementHandle();
  await page.evaluate((el) => {
    const w = window as unknown as { __rest: { el: Element; x: number; y: number; title: string | null; timer: ReturnType<typeof setInterval>; samples: number; replaced: number; hoverLost: number; titleLost: number; notUnderPointer: number } };
    const box = (el as Element).getBoundingClientRect();
    const state = { el: el as Element, x: box.left + box.width / 2, y: box.top + box.height / 2, title: (el as Element).getAttribute('title'), samples: 0, replaced: 0, hoverLost: 0, titleLost: 0, notUnderPointer: 0, timer: 0 as unknown as ReturnType<typeof setInterval> };
    state.timer = setInterval(() => {
      state.samples += 1;
      if (!state.el.isConnected) state.replaced += 1;
      if (!state.el.matches(':hover')) state.hoverLost += 1;
      if (state.el.getAttribute('title') !== state.title) state.titleLost += 1;
      const hit = document.elementFromPoint(state.x, state.y);
      if (!hit || !(hit === state.el || state.el.contains(hit))) state.notUnderPointer += 1;
    }, 100);
    w.__rest = state;
  }, handle);
  await page.waitForTimeout(ms);
  const result = await page.evaluate(() => {
    const w = window as unknown as { __drive: ReturnType<typeof setInterval>; __hubEvents: Record<string, number>; __rest: { timer: ReturnType<typeof setInterval>; samples: number; replaced: number; hoverLost: number; titleLost: number; notUnderPointer: number } };
    clearInterval(w.__drive);
    clearInterval(w.__rest.timer);
    const { samples, replaced, hoverLost, titleLost, notUnderPointer } = w.__rest;
    return { samples, replaced, hoverLost, titleLost, notUnderPointer, events: { ...w.__hubEvents } };
  });
  // The option the pointer rests on is still the one the locator finds (not a twin rendered in its place).
  expect(await option.evaluate((el, original) => el === original, handle)).toBe(true);
  await handle?.dispose();
  return result;
}

function expectStill(name: string, result: Rest): void {
  expect(result.samples, name).toBeGreaterThanOrEqual(50);
  expect(result.events.sessionUpdated ?? 0, `${name}: the other agents' updates reached the page`).toBeGreaterThanOrEqual(20);
  expect(result.events.todosChanged ?? 0, `${name}: todos changed`).toBeGreaterThanOrEqual(3);
  expect({ replaced: result.replaced, hoverLost: result.hoverLost, titleLost: result.titleLost, notUnderPointer: result.notUnderPointer }, name).toEqual({ replaced: 0, hoverLost: 0, titleLost: 0, notUnderPointer: 0 });
}

test('a resting pointer keeps the same option node, its hover and its title while other agents stream updates', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`${world.baseUrl}/`);
  // A teammate asks (its card also shows on its crew page); a plain agent asks (its Board card has Answer).
  crewQuestion = (await world.startSession(page, 'acme-mate', 'Reply with just OK.')).id;
  await world.settle(page, crewQuestion);
  await world.adopt(page, crewQuestion, 'Developer');
  const sent = await world.call(page, 'POST', `/api/sessions/${crewQuestion}/messages`, { text: ask(Q) });
  expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
  boardQuestion = (await world.startSession(page, 'acme-board', ask(Q))).id;
  for (const id of [crewQuestion, boardQuestion]) await expect.poll(() => inboxCount(page, id), { timeout: 20_000 }).toBe(1);
  busy = [];
  for (let i = 0; i < 5; i++) busy.push((await world.startSession(page, `acme-busy-${i}`, `Work ${i}.`)).id);
  for (const id of busy) await world.settle(page, id);

  // The crew page first: its narrow card's head wraps to another line when "just now" turns "1 min ago",
  // which moves the options once (a minute after the question; not what this test is about).
  await openWithHub(page, `${world.baseUrl}/crews/team`);
  const crew = page.getByTestId('v2-teammate').getByTestId('v2-answer-card');
  await expect(crew).toHaveCount(1);
  expectStill('crew', await rest(page, crew.locator('.v2-opt', { hasText: 'Team' }), 6_000));

  const mate = (scope: Locator): Locator => scope.locator('[data-testid="v2-answer-card"][aria-label^="Question from Developer:"]').locator('.v2-opt', { hasText: 'Team' });

  await openWithHub(page, `${world.baseUrl}/needs-you`);
  expectStill('Needs you', await rest(page, mate(page.getByTestId('v2-needs-list')), 6_000));

  await openWithHub(page, `${world.baseUrl}/`);
  expectStill('Home', await rest(page, mate(page.getByTestId('v2-root')), 6_000));

  await openWithHub(page, `${world.baseUrl}/agents/${crewQuestion}`);
  const chat = page.getByTestId('v2-agent-chat').getByTestId('v2-answer-card');
  await expect(chat).toHaveCount(1);
  expectStill('chat', await rest(page, chat.locator('.v2-opt', { hasText: 'Team' }), 6_000));

  await openWithHub(page, `${world.baseUrl}/`);
  await page.evaluate((sessionId) => (window as unknown as { __sbV2Peek: (id: string) => void }).__sbV2Peek(sessionId), crewQuestion);
  const peek = page.getByTestId('v2-agent-peek').getByTestId('v2-answer-card');
  await expect(peek).toHaveCount(1);
  expectStill('peek', await rest(page, peek.locator('.v2-opt', { hasText: 'Team' }), 6_000));

  await openWithHub(page, `${world.baseUrl}/agents`);
  await page.getByTestId('v2-agents-view').locator('[data-value="board"]').click();
  await page.locator(`[data-testid="v2-bcard"][data-session="${boardQuestion}"]`).getByTestId('v2-bcard-answer').click();
  const popover = page.getByTestId('v2-qpop').getByTestId('v2-answer-card');
  await expect(popover).toHaveCount(1);
  expectStill('Board', await rest(page, popover.locator('.v2-opt', { hasText: 'Team' }), 6_000));
});
