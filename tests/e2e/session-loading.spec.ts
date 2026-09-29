import { type Locator, type Page, type Route, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { LOADING_SESSION, PLACEHOLDER_DELAY_MS } from '../../src/web/views/session/session-loading.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D45, real path (D13, no demo seed): `node src/server/main.ts` with fake-claude
 * as the CLI and two finished sessions, A and B. The browser's requests for a
 * session's detail and events are held back with `page.route` (on the browser
 * side only; the service answers as usual), so the loading state can be watched:
 * - switching A → B with B late: nothing of A ever shows under B (an in-page
 *   MutationObserver checks every DOM change of the view), the placeholders
 *   (header, chat, right panel) appear only after the ~150 ms delay, with
 *   `aria-busy` and the visually hidden "Loading session…", then B renders;
 * - back to A with A's requests held for seconds: A renders at once from the
 *   in-memory cache (its first render already holds its conversation), with no
 *   placeholder and no `aria-busy`, including a reply that arrived over `/hub`
 *   while B was shown; the background refresh then lands;
 * - a failed load (500) shows the header's error line, a 404 the missing state,
 *   failed events the chat without placeholders: never a stuck placeholder;
 * - a first page load of a late session shows the placeholders, then the session.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('session-loading');
});

test.afterAll(async () => {
  await world?.stop();
});

const A = { name: 'load-a', task: 'Task A: say alpha.', reply: 'Alpha reply from session A.' } as const;
const B = { name: 'load-b', task: 'Task B: say bravo.', reply: 'Bravo reply from session B.' } as const;
const A_AGAIN = 'Alpha again, while you were away.';

/**
 * A `[fake:say]` token whose reply is `text`: the JSON string writes its spaces as
 * `\u0020`, so the reply's text is not also inside the developer's bubble.
 */
function say(text: string): string {
  return `[fake:say ${JSON.stringify(text).replaceAll(' ', '\\u0020')}]`;
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

function sidebarRow(page: Page, id: string): Locator {
  return page.getByTestId('sidebar-sessions').locator(`a[href$="/sessions/${id}"]`);
}

/** `GET /api/sessions/{id}` and `GET /api/sessions/{id}/events` (not the other tabs' routes). */
function sessionRoutes(id: string): (url: URL) => boolean {
  const detailPath = `/api/sessions/${encodeURIComponent(id)}`;
  return (url) => url.pathname === detailPath || url.pathname === `${detailPath}/events`;
}

/** Holds the session's detail and events requests back by `ms`, then lets them through (or answers with `fulfill`). */
async function holdBack(page: Page, id: string, ms: number, fulfill?: { status: number; body: unknown }): Promise<{ hits: () => number; unroute: () => Promise<void> }> {
  let hits = 0;
  const matcher = sessionRoutes(id);
  const handler = async (route: Route): Promise<void> => {
    hits += 1;
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (fulfill) await route.fulfill({ status: fulfill.status, contentType: 'application/json', body: JSON.stringify(fulfill.body) });
    else await route.continue();
  };
  await page.route(matcher, handler);
  return { hits: () => hits, unroute: () => page.unroute(matcher, handler) };
}

/** What the in-page watcher saw of one switch (times in ms from the click). */
interface Watched {
  readonly clicked: boolean;
  /** The target view's first render: its name, its chat text, how many placeholder shapes. */
  readonly first: { readonly name: string; readonly chat: string; readonly skeletons: number } | null;
  readonly firstSkeletonMs: number | null;
  readonly renderedMs: number | null;
  readonly busySeen: boolean;
  /** Another session's markers found in the target's view (`marker @ms`). */
  readonly stale: readonly string[];
}

/**
 * Watches every DOM change of the session view for session `target` from the next
 * click on: its first render, when the first placeholder showed, when its name
 * showed, whether it was ever `aria-busy`, and any of `staleMarkers` inside it.
 */
async function watchSwitch(page: Page, target: string, name: string, staleMarkers: readonly string[]): Promise<void> {
  await page.evaluate(
    ({ target: id, name: shownName, markers }) => {
      const state = { clickAt: -1, first: null as null | { name: string; chat: string; skeletons: number }, firstSkeletonAt: -1, renderedAt: -1, busySeen: false, stale: [] as string[] };
      const win = window as unknown as { __d45?: { observer: MutationObserver; state: typeof state } };
      win.__d45?.observer.disconnect();
      document.addEventListener(
        'click',
        () => {
          if (state.clickAt < 0) state.clickAt = performance.now();
        },
        { capture: true, once: true },
      );
      const check = (): void => {
        const view = document.querySelector<HTMLElement>('[data-testid="view-session"]');
        if (state.clickAt < 0 || !view || view.dataset['sessionId'] !== id) return;
        const now = performance.now() - state.clickAt;
        const skeletons = view.querySelectorAll('.sb-skel').length;
        const nameText = view.querySelector('[data-testid="session-name"]')?.textContent ?? '';
        if (!state.first) state.first = { name: nameText, chat: view.querySelector('[data-testid="session-chat"]')?.textContent ?? '', skeletons };
        if (skeletons > 0 && state.firstSkeletonAt < 0) state.firstSkeletonAt = now;
        if (nameText === shownName && state.renderedAt < 0) state.renderedAt = now;
        if (view.getAttribute('aria-busy') === 'true') state.busySeen = true;
        const text = view.textContent ?? '';
        for (const marker of markers) if (text.includes(marker)) state.stale.push(`${marker} @${Math.round(now)}ms`);
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      win.__d45 = { observer, state };
    },
    { target, name, markers: [...staleMarkers] },
  );
}

async function watched(page: Page): Promise<Watched> {
  return page.evaluate(() => {
    const { state } = (window as unknown as { __d45: { state: { clickAt: number; first: Watched['first']; firstSkeletonAt: number; renderedAt: number; busySeen: boolean; stale: string[] } } }).__d45;
    return {
      clicked: state.clickAt >= 0,
      first: state.first,
      firstSkeletonMs: state.firstSkeletonAt < 0 ? null : state.firstSkeletonAt,
      renderedMs: state.renderedAt < 0 ? null : state.renderedAt,
      busySeen: state.busySeen,
      stale: state.stale.slice(0, 10),
    };
  });
}

/** The loading state's parts: every placeholder, the busy mark and the hidden text. */
async function expectPlaceholders(page: Page): Promise<void> {
  const view = page.getByTestId('view-session');
  await expect(view.getByTestId('skeleton-title')).toBeVisible();
  await expect(view.getByTestId('skeleton-root')).toBeVisible();
  await expect(view.getByTestId('skeleton-chat').getByTestId('skeleton-bubble')).toHaveCount(4);
  expect(await view.getByTestId('skeleton-bubble').evaluateAll((els) => els.map((el) => el.getAttribute('data-side')))).toEqual(['user', 'agent', 'user', 'agent']);
  await expect(view.getByTestId('skeleton-panel').getByTestId('skeleton-overview')).toHaveCount(1);
  await expect(view.getByTestId('skeleton-panel').getByTestId('skeleton-card')).toHaveCount(2);
  await expect(view).toHaveAttribute('aria-busy', 'true');
  const note = view.getByTestId('session-loading');
  await expect(note).toHaveText(LOADING_SESSION);
  await expect(note).toHaveAttribute('role', 'status');
  // Visually hidden: a clipped 1px box.
  const box = await note.boundingBox();
  expect(box && box.width <= 1 && box.height <= 1).toBe(true);
  await expect(note).toHaveCSS('clip-path', 'inset(50%)');
}

/** The loaded state: no placeholder, no busy mark, no hidden text. */
async function expectLoaded(page: Page): Promise<void> {
  const view = page.getByTestId('view-session');
  await expect(view.locator('.sb-skel')).toHaveCount(0);
  await expect(view).not.toHaveAttribute('aria-busy', /.*/);
  await expect(view.getByTestId('session-loading')).toHaveCount(0);
}

test('switching sessions: never the old content, placeholders only after the delay, an instant revisit from the cache', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const a = await world.startSession(page, A.name, `${A.task} ${say(A.reply)}`);
  const b = await world.startSession(page, B.name, `${B.task} ${say(B.reply)}`);
  await expect.poll(async () => (await detail(page, a.id)).status, { timeout: 15_000 }).toBe('done');
  await expect.poll(async () => (await detail(page, b.id)).status, { timeout: 15_000 }).toBe('done');

  await openWithHub(page, `${world.baseUrl}/sessions/${a.id}`);
  const name = page.getByTestId('session-name');
  const chat = page.getByTestId('session-chat');
  await expect(name).toHaveText(A.name);
  await expect(chat).toContainText(A.reply);
  await expectLoaded(page);

  // A → B, B's detail and events held back 1.5 s.
  const late = await holdBack(page, b.id, 1_500);
  await watchSwitch(page, b.id, B.name, [A.name, A.task, A.reply]);
  await sidebarRow(page, b.id).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${b.id}$`));
  await expectPlaceholders(page);
  await expect(name).toHaveText(B.name, { timeout: 10_000 });
  await expect(chat).toContainText(B.reply);
  await expectLoaded(page);
  expect(late.hits()).toBeGreaterThanOrEqual(2);
  const toB = await watched(page);
  expect(toB.clicked).toBe(true);
  // Nothing of A under B's view, at any DOM change.
  expect(toB.stale).toEqual([]);
  expect(toB.first?.name).toBe('');
  expect(toB.first?.chat).toBe('');
  expect(toB.first?.skeletons).toBe(0);
  // No flicker: the first placeholder came after the delay, and before B.
  expect(toB.firstSkeletonMs).not.toBeNull();
  expect(toB.firstSkeletonMs ?? 0).toBeGreaterThanOrEqual(PLACEHOLDER_DELAY_MS - 5);
  expect(toB.firstSkeletonMs ?? 0).toBeLessThan(toB.renderedMs ?? 0);
  expect(toB.busySeen).toBe(true);
  await late.unroute();

  // While B shows, A gets a new reply over /hub (A is not on screen): its cached events follow.
  const heard = page.evaluate(
    (text) =>
      new Promise<boolean>((resolve) => {
        const source = new EventSource('/hub', { withCredentials: true });
        const timer = setTimeout(() => {
          source.close();
          resolve(false);
        }, 20_000);
        source.addEventListener('event', (message) => {
          if (!(message as MessageEvent<string>).data.includes(text)) return;
          clearTimeout(timer);
          source.close();
          resolve(true);
        });
      }),
    A_AGAIN,
  );
  await page.waitForTimeout(300);
  await send(page, a.id, `Another one for A. ${say(A_AGAIN)}`);
  expect(await heard).toBe(true);
  await expect.poll(async () => (await detail(page, a.id)).status, { timeout: 15_000 }).toBe('done');
  // The app's own stream got the same events (the extra stream above only tells when they were sent).
  await page.waitForTimeout(300);

  // B → A with A's requests held back 4 s: A renders at once from the cache.
  const refresh = await holdBack(page, a.id, 4_000);
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sessions/${a.id}/events`, { timeout: 15_000 });
  await watchSwitch(page, a.id, A.name, [B.name, B.task, B.reply]);
  await sidebarRow(page, a.id).click();
  await expect(name).toHaveText(A.name, { timeout: 1_000 });
  await expect(chat).toContainText(A_AGAIN, { timeout: 1_000 });
  const toA = await watched(page);
  expect(toA.first?.name).toBe(A.name);
  expect(toA.first?.chat).toContain(A.reply);
  expect(toA.first?.chat).toContain(A_AGAIN);
  expect(toA.first?.skeletons).toBe(0);
  expect(toA.renderedMs).not.toBeNull();
  // Still no placeholder and never busy, well past the delay, while the refresh is still held back.
  await page.waitForTimeout(PLACEHOLDER_DELAY_MS * 4);
  expect(refresh.hits()).toBeGreaterThanOrEqual(2);
  await expectLoaded(page);
  // The background refresh lands; A stays as it was, nothing of B ever showed.
  expect((await refreshed).status()).toBe(200);
  await expect(chat).toContainText(A_AGAIN);
  await expect(chat).toContainText(A.reply);
  const afterRefresh = await watched(page);
  expect(afterRefresh.firstSkeletonMs).toBeNull();
  expect(afterRefresh.busySeen).toBe(false);
  expect(afterRefresh.stale).toEqual([]);
  // The reply is there once, not twice (the refresh merges by id).
  await expect(chat.getByText(A_AGAIN, { exact: true })).toHaveCount(1);
  await refresh.unroute();
});

test('a failed load shows the error or missing state, never a stuck placeholder; a first load shows the placeholders', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const a = await world.startSession(page, 'fail-a', `Task: first. ${say('First reply.')}`);
  const c = await world.startSession(page, 'fail-c', `Task: third. ${say('Third reply.')}`);
  await expect.poll(async () => (await detail(page, a.id)).status, { timeout: 15_000 }).toBe('done');
  await expect.poll(async () => (await detail(page, c.id)).status, { timeout: 15_000 }).toBe('done');
  const name = page.getByTestId('session-name');
  const chat = page.getByTestId('session-chat');

  // A first page load of a late session: the placeholders, then the session.
  const first = await holdBack(page, a.id, 1_000);
  await openWithHub(page, `${world.baseUrl}/sessions/${a.id}`);
  await expectPlaceholders(page);
  await expect(name).toHaveText('fail-a', { timeout: 10_000 });
  await expect(chat).toContainText('First reply.');
  await expectLoaded(page);
  await first.unroute();

  // A → C, C's loads fail with a 500 after 600 ms: placeholders while waiting, then the header's error line.
  const failing = await holdBack(page, c.id, 600, { status: 500, body: { error: 'internal', message: 'The database is locked (test).' } });
  await watchSwitch(page, c.id, 'fail-c', ['fail-a', 'First reply.']);
  await sidebarRow(page, c.id).click();
  await expect(page.getByTestId('skeleton-chat')).toBeVisible();
  await expect(page.getByTestId('session-error')).toHaveText('The database is locked (test).');
  await expect(name).toHaveText(c.id);
  await expectLoaded(page);
  await expect(chat).toHaveText('');
  await page.waitForTimeout(PLACEHOLDER_DELAY_MS * 4);
  await expectLoaded(page);
  expect((await watched(page)).stale).toEqual([]);
  await failing.unroute();

  // Only the events fail: the header and the panel render, the chat shows no placeholder.
  const eventsPath = `/api/sessions/${c.id}/events`;
  const eventsOnly = (url: URL): boolean => url.pathname === eventsPath;
  await page.route(eventsOnly, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal', message: 'no events' }) }));
  await page.goto(`${world.baseUrl}/sessions/${c.id}`);
  await expect(name).toHaveText('fail-c');
  await expect(page.getByTestId('agent-card')).toHaveCount(1);
  await page.waitForTimeout(PLACEHOLDER_DELAY_MS * 4);
  await expectLoaded(page);
  await page.unroute(eventsOnly);

  // No such session (404 from the service): the missing state, no placeholder.
  await page.goto(`${world.baseUrl}/sessions/no-such-session`);
  await expect(page.getByTestId('session-root')).toHaveText('no such session');
  await expect(name).toHaveText('no-such-session');
  await page.waitForTimeout(PLACEHOLDER_DELAY_MS * 4);
  await expectLoaded(page);
  await expect(page.getByTestId('session-error')).toHaveCount(0);
});
