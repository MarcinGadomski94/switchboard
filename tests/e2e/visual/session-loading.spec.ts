import { type Browser, type Page, type Route, expect, test } from '@playwright/test';
import { LOADING_SESSION } from '../../../src/web/views/session/session-loading.ts';
import { type DemoApp, BOX_TOLERANCE_PX, VIEWPORT, hexToRgb, openApp, round, sideBySide, startDemoApp, writeReport } from './harness.ts';

/**
 * D45 (an addition, checked on its own like D18's Name row): the session view's
 * loading placeholders are not in the prototype, and the loaded views are
 * unchanged (every other visual spec and the full pass gate them as before).
 *
 * The demo app at 1440×900: `calendar-func-fix` is open, then `free-talk-feature`
 * is opened from the sidebar with its detail and events held back in the browser
 * (`page.route`), so its placeholders show; the same view loaded is the template.
 * Gated here:
 * - the frame stays: the main column, the right panel and the composer keep the
 *   loaded view's boxes (±2 px);
 * - the header's title bar sits where the title starts, vertically centred in the
 *   top row, the root line block one row gap after it;
 * - the chat's 3–4 bubbles alternate sides like messages, inside the conversation's
 *   padding (the developer's right edge and the agent's left edge of the loaded
 *   messages), one message gap apart;
 * - the right panel's overview block has the overview table's x and width, the two
 *   card blocks the agent cards' x, width and one-line height, starting where the
 *   loaded cards start;
 * - SPEC tokens as computed styles: `--bg-card` fill, 1 px `--border-row` line,
 *   the shimmer band in `--bg-selected-nav`, radii 4 px (bars), 12 px (bubbles,
 *   SPEC's chat bubble), 8 px (overview and cards); the shimmer animates, and is
 *   static with `prefers-reduced-motion` (no animation, no band);
 * - `aria-busy` on the view and the visually hidden "Loading session…".
 * Report: `session-loading.md` + `session-loading-side-by-side.png` (placeholders
 * left, loaded right).
 */

const FROM = 'calendar-func-fix';
const TARGET = 'free-talk-feature';

const BG_CARD = hexToRgb('#17181b');
const BORDER_ROW = hexToRgb('#1f2024');
const BG_SELECTED_NAV = hexToRgb('#212227');

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Measured {
  readonly box: Box;
  readonly style: Readonly<Record<string, string>>;
  readonly side?: string | null;
}

const STYLES = [
  'background-color',
  'background-image',
  'border-top-width',
  'border-top-style',
  'border-top-color',
  'border-bottom-color',
  'border-radius',
  'animation-name',
  'animation-duration',
  'animation-iteration-count',
] as const;

/** Every element matching `selector`: box, computed styles, `data-side`. */
async function all(page: Page, selector: string): Promise<Measured[]> {
  return page.evaluate(
    ({ sel, props }) =>
      [...document.querySelectorAll<HTMLElement>(sel)].map((el) => {
        const rect = el.getBoundingClientRect();
        const computed = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const prop of props) style[prop] = computed.getPropertyValue(prop);
        return { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, style, side: el.getAttribute('data-side') };
      }),
    { sel: selector, props: [...STYLES] as string[] },
  );
}

async function one(page: Page, selector: string): Promise<Measured | null> {
  return (await all(page, selector))[0] ?? null;
}

/** Opens {@link FROM}, then {@link TARGET} from the sidebar with its data held back until `release()`. */
async function openLate(browser: Browser, app: DemoApp, reducedMotion: 'reduce' | 'no-preference'): Promise<{ page: Page; release: () => void }> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion });
  const page = await context.newPage();
  await openApp(page, app.baseUrl, `/sessions/${FROM}`);
  await expect(page.getByTestId('session-name')).toHaveText(FROM);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = (url: URL): boolean => url.pathname === `/api/sessions/${TARGET}` || url.pathname === `/api/sessions/${TARGET}/events`;
  await page.route(held, async (route: Route) => {
    await gate;
    await route.continue();
  });
  await page.getByTestId('sidebar-sessions').getByText(TARGET, { exact: true }).click();
  await expect(page.getByTestId('skeleton-panel')).toBeVisible();
  await page.mouse.move(0, 0);
  return { page, release };
}

const fmt = (m: Measured | Box | null | undefined): string => {
  const box = m && 'box' in m ? m.box : (m as Box | null | undefined);
  return box ? `${round(box.x)},${round(box.y)} ${round(box.width)}×${round(box.height)}` : 'missing';
};

test.describe('visual: session loading placeholders (D45 addition)', () => {
  let app: DemoApp;

  test.beforeAll(async () => {
    app = await startDemoApp();
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test('the placeholders keep the loaded frame, sit where the loaded parts sit, on SPEC tokens', async ({ browser }) => {
    const { page, release } = await openLate(browser, app, 'no-preference');
    const view = page.getByTestId('view-session');
    const busy = await view.getAttribute('aria-busy');
    const noteText = await view.getByTestId('session-loading').textContent();
    const noteBox = await view.getByTestId('session-loading').boundingBox();
    const skel = {
      main: await one(page, '.sb-sv-main'),
      panel: await one(page, '[data-testid="session-right-panel"]'),
      composer: await one(page, '[data-testid="chat-composer"]'),
      chat: await one(page, '[data-testid="session-chat"]'),
      top: await one(page, '.sb-sv-top'),
      title: await one(page, '[data-testid="skeleton-title"]'),
      chips: await all(page, '[data-testid="skeleton-chip"]'),
      chipRow: await one(page, '[data-testid="session-chips"]'),
      tabs: await one(page, '.sb-sv-tabs'),
      header: await one(page, '[data-testid="session-header"]'),
      root: await one(page, '[data-testid="skeleton-root"]'),
      bubbles: await all(page, '[data-testid="skeleton-bubble"]'),
      overviewBlock: await one(page, '[data-testid="skeleton-overview"]'),
      cards: await all(page, '[data-testid="skeleton-card"]'),
      shapes: await all(page, '.sb-skel'),
    };
    // The shimmer moves: the band's position changes over time.
    const positionAt = (): Promise<string> => page.locator('[data-testid="skeleton-overview"]').evaluate((el) => getComputedStyle(el).backgroundPosition);
    const firstPosition = await positionAt();
    await page.waitForTimeout(300);
    const laterPosition = await positionAt();
    const shot = await page.screenshot();

    release();
    await expect(page.getByTestId('session-name')).toHaveText(TARGET);
    await expect(page.locator('.sb-skel')).toHaveCount(0);
    await expect(page.getByTestId('agent-card').first()).toBeVisible();
    await page.mouse.move(0, 0);
    const loaded = {
      main: await one(page, '.sb-sv-main'),
      panel: await one(page, '[data-testid="session-right-panel"]'),
      composer: await one(page, '[data-testid="chat-composer"]'),
      chat: await one(page, '[data-testid="session-chat"]'),
      name: await one(page, '[data-testid="session-name"]'),
      chip: await one(page, '[data-testid="session-chip"]'),
      chipRow: await one(page, '[data-testid="session-chips"]'),
      tabs: await one(page, '.sb-sv-tabs'),
      header: await one(page, '[data-testid="session-header"]'),
      userMessage: await one(page, '.sb-chat-message[data-role="user"]'),
      agentMessage: await one(page, '.sb-chat-message[data-role="agent"]'),
      overview: await one(page, '[data-testid="agent-overview"]'),
      overviewTable: await one(page, '[data-testid="overview-table"]'),
      cards: await all(page, '[data-testid="agent-card"]'),
    };
    const loadedShot = await page.screenshot();
    const busyAfter = await view.getAttribute('aria-busy');
    const noteAfter = await view.getByTestId('session-loading').count();

    const reduced = await openLate(browser, app, 'reduce');
    const still = await all(reduced.page, '.sb-skel');
    reduced.release();
    await reduced.page.context().close();

    const rows: string[] = [];
    const failures: string[] = [];
    const check = (what: string, ok: boolean, note: string): void => {
      rows.push(`| ${what} | ${note.replaceAll('|', '\\|')} | ${ok ? 'ok' : 'FAIL'} |`);
      if (!ok) failures.push(`${what}: ${note}`);
    };
    const near = (a: number | undefined, b: number | undefined, tolerance = BOX_TOLERANCE_PX): boolean =>
      a !== undefined && b !== undefined && Math.abs(a - b) <= tolerance;
    const sameBox = (what: string, a: Measured | null, b: Measured | null): void => {
      const ok = !!a && !!b && near(a.box.x, b.box.x) && near(a.box.y, b.box.y) && near(a.box.width, b.box.width) && near(a.box.height, b.box.height);
      check(what, ok, `${fmt(a)} vs loaded ${fmt(b)}`);
    };
    const right = (m: Measured | null | undefined): number | undefined => (m ? m.box.x + m.box.width : undefined);
    const bottom = (m: Measured | null | undefined): number | undefined => (m ? m.box.y + m.box.height : undefined);
    const centerY = (m: Measured | null | undefined): number | undefined => (m ? m.box.y + m.box.height / 2 : undefined);

    // The frame stays.
    sameBox('frame: main column', skel.main, loaded.main);
    sameBox('frame: right panel', skel.panel, loaded.panel);
    sameBox('frame: composer', skel.composer, loaded.composer);
    sameBox('frame: header (the chip row is held)', skel.header, loaded.header);
    sameBox('frame: tabs (no jump when the session arrives)', skel.tabs, loaded.tabs);
    sameBox('frame: chat', skel.chat, loaded.chat);

    // Header.
    check('header: the title bar starts where the title does', near(skel.title?.box.x, loaded.name?.box.x), `${fmt(skel.title)} vs title ${fmt(loaded.name)}`);
    check('header: the title bar is centred in the top row', near(centerY(skel.title), centerY(skel.top)), `${round(centerY(skel.title) ?? 0)} vs row ${round(centerY(skel.top) ?? 0)}`);
    check('header: the title bar is 16 px high, the root line 11 px', near(skel.title?.box.height, 16, 0.5) && near(skel.root?.box.height, 11, 0.5), `${fmt(skel.title)} · ${fmt(skel.root)}`);
    check('header: the root line one row gap (10 px) after the title bar, centred', near(skel.root?.box.x, (right(skel.title) ?? 0) + 10) && near(centerY(skel.root), centerY(skel.top)), fmt(skel.root));

    check('header: chip blocks in the chip row, the loaded chip\'s height, at the row\'s x', skel.chips.length === 3 && skel.chips.every((c) => near(c.box.height, loaded.chip?.box.height) && near(c.box.y, skel.chipRow?.box.y)) && near(skel.chips[0]?.box.x, loaded.chip?.box.x), `${skel.chips.map(fmt).join(' · ')} vs chip ${fmt(loaded.chip)}`);
    check('header: the chip row keeps its height', near(skel.chipRow?.box.height, loaded.chipRow?.box.height), `${fmt(skel.chipRow)} vs loaded ${fmt(loaded.chipRow)}`);
    const chipGaps = skel.chips.slice(1).map((c, i) => c.box.x - (right(skel.chips[i]) ?? 0));
    check('header: one chip gap (6 px) between chip blocks', chipGaps.every((gap) => near(gap, 6, 0.5)), chipGaps.map(round).join(', '));

    // Chat.
    const bubbles = skel.bubbles;
    check('chat: 4 bubbles alternating sides, the developer first', bubbles.map((b) => b.side).join(',') === 'user,agent,user,agent', bubbles.map((b) => b.side).join(','));
    check('chat: the first bubble at the conversation\'s top padding (20 px)', near(bubbles[0]?.box.y, (skel.chat?.box.y ?? 0) + 20), `${fmt(bubbles[0])} in ${fmt(skel.chat)}`);
    const gaps = bubbles.slice(1).map((b, i) => b.box.y - (bottom(bubbles[i]) ?? 0));
    check('chat: one message gap (16 px) between bubbles', gaps.length === 3 && gaps.every((gap) => near(gap, 16, 1)), gaps.map(round).join(', '));
    const users = bubbles.filter((b) => b.side === 'user');
    const agents = bubbles.filter((b) => b.side === 'agent');
    check('chat: the developer\'s bubbles end at the loaded user bubble\'s right edge', users.length === 2 && users.every((b) => near(right(b), right(loaded.userMessage))), `${users.map((b) => round(right(b) ?? 0)).join(', ')} vs ${round(right(loaded.userMessage) ?? 0)}`);
    check('chat: the agent\'s bubbles start at the loaded agent message\'s left edge', agents.length === 2 && agents.every((b) => near(b.box.x, loaded.agentMessage?.box.x)), `${agents.map((b) => round(b.box.x)).join(', ')} vs ${round(loaded.agentMessage?.box.x ?? 0)}`);
    check('chat: bubbles stay inside the conversation', bubbles.every((b) => b.box.x >= (skel.chat?.box.x ?? 0) + 26 - 0.5 && (right(b) ?? 0) <= (right(skel.chat) ?? 0) - 26 + 0.5), bubbles.map(fmt).join(' · '));

    // Right panel.
    check('panel: the overview block has the overview table\'s x and width', near(skel.overviewBlock?.box.x, loaded.overviewTable?.box.x) && near(skel.overviewBlock?.box.width, loaded.overviewTable?.box.width), `${fmt(skel.overviewBlock)} vs table ${fmt(loaded.overviewTable)}`);
    check('panel: the overview block at the overview\'s top padding (14 px)', near(skel.overviewBlock?.box.y, (loaded.overview?.box.y ?? 0) + 14), fmt(skel.overviewBlock));
    check('panel: two card blocks', skel.cards.length === 2, String(skel.cards.length));
    const card = loaded.cards[0] ?? null;
    check('panel: card blocks have the agent cards\' x, width and one-line height', skel.cards.every((c) => near(c.box.x, card?.box.x) && near(c.box.width, card?.box.width) && near(c.box.height, card?.box.height)), `${skel.cards.map(fmt).join(' · ')} vs card ${fmt(card)}`);
    const loadedStart = (card?.box.y ?? 0) - (bottom(loaded.overview) ?? 0);
    const skelStart = (skel.cards[0]?.box.y ?? 0) - (bottom(skel.overviewBlock) ?? 0);
    check('panel: the first card block starts as far below the overview as the loaded cards do', near(skelStart, loadedStart), `${round(skelStart)} vs ${round(loadedStart)}`);
    const cardGap = (skel.cards[1]?.box.y ?? 0) - (bottom(skel.cards[0]) ?? 0);
    const loadedGap = (loaded.cards[1]?.box.y ?? 0) - (bottom(loaded.cards[0]) ?? 0);
    check('panel: the card list\'s gap (4 px)', near(cardGap, loadedGap, 1) && near(cardGap, 4, 0.5), `${round(cardGap)} vs ${round(loadedGap)}`);

    // SPEC tokens.
    const shapes = skel.shapes;
    check('tokens: every shape is --bg-card with a 1 px solid --border-row line', shapes.length === 12 && shapes.every((s) => s.style['background-color'] === BG_CARD && s.style['border-top-width'] === '1px' && s.style['border-top-style'] === 'solid' && s.style['border-top-color'] === BORDER_ROW && s.style['border-bottom-color'] === BORDER_ROW), `${shapes.length} shapes · ${shapes[0]?.style['background-color']} / ${shapes[0]?.style['border-top-width']} ${shapes[0]?.style['border-top-color']}`);
    check('tokens: the shimmer band is --bg-selected-nav', shapes.every((s) => (s.style['background-image'] ?? '').includes(BG_SELECTED_NAV)), shapes[0]?.style['background-image'] ?? '');
    check('tokens: radii 4 px (bars), 5 px (chips), 12 px (bubbles), 8 px (overview, cards)', skel.title?.style['border-radius'] === '4px' && skel.root?.style['border-radius'] === '4px' && skel.chips.every((c) => c.style['border-radius'] === '5px') && bubbles.every((b) => b.style['border-radius'] === '12px') && skel.overviewBlock?.style['border-radius'] === '8px' && skel.cards.every((c) => c.style['border-radius'] === '8px'), `${skel.title?.style['border-radius']} · ${bubbles[0]?.style['border-radius']} · ${skel.overviewBlock?.style['border-radius']}`);
    check('motion: the shimmer runs (1.6 s, infinite) and moves', shapes.every((s) => s.style['animation-name'] === 'sb-skel-shimmer' && s.style['animation-duration'] === '1.6s' && s.style['animation-iteration-count'] === 'infinite') && firstPosition !== laterPosition, `${shapes[0]?.style['animation-name']} ${shapes[0]?.style['animation-duration']} · ${firstPosition} → ${laterPosition}`);
    check('motion: static with prefers-reduced-motion (no animation, no band, --bg-card)', still.length === 12 && still.every((s) => s.style['animation-name'] === 'none' && s.style['background-image'] === 'none' && s.style['background-color'] === BG_CARD), `${still.length} shapes · ${still[0]?.style['animation-name']} · ${still[0]?.style['background-image']}`);

    // Accessibility.
    check('a11y: the view is aria-busy while loading, not once loaded', busy === 'true' && busyAfter === null, `${busy} → ${busyAfter}`);
    check('a11y: the visually hidden "Loading session…" (1 px, clipped), gone once loaded', noteText === LOADING_SESSION && !!noteBox && noteBox.width <= 1 && noteBox.height <= 1 && noteAfter === 0, `${JSON.stringify(noteText)} ${noteBox ? `${noteBox.width}×${noteBox.height}` : 'missing'} → ${noteAfter}`);

    const pair = await sideBySide(page, shot, loadedShot);
    const report = [
      '# Visual check · Session loading placeholders (D45 addition)',
      '',
      `Generated by \`tests/e2e/visual/session-loading.spec.ts\`. The placeholders are not in the prototype: they are checked on their own (like D18's Name row) against the same view loaded. App: demo seed, 1440×900, \`/sessions/${FROM}\`, then \`${TARGET}\` opened from the sidebar with its \`GET /api/sessions/${TARGET}\` and \`/events\` held back in the browser (\`page.route\`) until measured; the reduced-motion row in a context with \`prefers-reduced-motion: reduce\`.`,
      '',
      `**Gate:** ${failures.length === 0 ? 'green' : 'red'}`,
      '',
      '| Check | Measured | Result |',
      '|---|---|---|',
      ...rows,
      '',
      'Every other visual spec and the full pass measure the loaded views, which D45 leaves unchanged. Developer ruling (D45-chips): chip blocks hold the header\'s chip row while loading, so the header, the tabs and the conversation keep their boxes when the session arrives. Screenshot: `session-loading-side-by-side.png` (placeholders left, loaded right).',
      '',
    ].join('\n');
    await writeReport({ 'session-loading.md': report, 'session-loading-side-by-side.png': pair });
    await page.context().close();
    expect(failures).toEqual([]);
  });
});
