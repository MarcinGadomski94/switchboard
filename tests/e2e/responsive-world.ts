import { type Browser, type BrowserContext, type Locator, type Page, expect } from '@playwright/test';
import { SETTINGS_SECTIONS } from '../../src/web/views/settings/model.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D74 · helpers of the responsive specs (`docs/responsive.md`): the four
 * compact viewports, a touch context for them, and the "no horizontal overflow"
 * check every page and dialog must pass.
 */

/** A viewport the responsive specs visit. */
export interface Size {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

/** Phone portrait / landscape, tablet portrait / landscape (the desktop ≥ 1280 px is the visual oracle's). */
export const SIZES: readonly Size[] = [
  { name: 'phone portrait', width: 360, height: 740 },
  { name: 'phone landscape', width: 640, height: 360 },
  { name: 'tablet portrait', width: 768, height: 1024 },
  { name: 'tablet landscape', width: 1024, height: 768 },
];

/** The demo seed's session the specs open. */
export const DEMO_SESSION = 'free-talk-feature';

/** Every page of the demo seed: the nav's views, a tool, a session's tabs, each Settings section (and the phone's section list). */
export const ROUTES: readonly string[] = [
  '/inbox',
  '/solutions',
  '/schedules',
  '/mcp',
  '/artifacts',
  '/history',
  '/todos',
  '/tools/cm',
  `/sessions/${DEMO_SESSION}`,
  `/sessions/${DEMO_SESSION}/timeline`,
  `/sessions/${DEMO_SESSION}/diff`,
  `/sessions/${DEMO_SESSION}/artifacts`,
  '/settings',
  ...SETTINGS_SECTIONS.map((section) => `/settings/${section.key}`),
];

/** The phone sizes (the WebKit pass). */
export const PHONE_SIZES: readonly Size[] = SIZES.slice(0, 2);

/**
 * A touch device context at `size`: a coarse pointer, touch events and (Chromium)
 * the mobile viewport behavior, so the page's `width=device-width` meta applies.
 */
export async function touchContext(browser: Browser, size: Size, options: { readonly isMobile?: boolean } = {}): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: options.isMobile ?? browser.browserType().name() === 'chromium',
  });
  return context;
}

/** A new page of `context` whose tool probes are answered in the browser (tests/e2e/probes.ts). */
export async function newTouchPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await stubToolProbes(page);
  return page;
}

/** What {@link overflowOf} found. */
export interface Overflow {
  /** The page's scroll width (must not exceed the viewport's width). */
  readonly scrollWidth: number;
  /** Elements that reach past the window's left or right edge outside any sideways-scrolling box (a description each). */
  readonly offenders: readonly string[];
}

/**
 * Measures horizontal overflow at a window `width`: the page's scroll width, and
 * every visible element that sticks out of the window (outermost only) unless a
 * sideways-scrolling box inside the window holds it (a tab bar, a code block, a
 * diff, quick replies: those scroll inside themselves, which is allowed).
 */
export async function overflowOf(page: Page, width: number): Promise<Overflow> {
  return page.evaluate((W) => {
    const scrollWidth = document.scrollingElement?.scrollWidth ?? 0;
    const offenders: string[] = [];
    // A deliberately cut line (`text-overflow: ellipsis`, e.g. the session's root path cut from the left) is fine.
    const truncated = (el: Element): boolean => {
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).textOverflow === 'ellipsis' && parent.getBoundingClientRect().right <= W + 1) return true;
      }
      return false;
    };
    const scrolledInside = (el: Element): boolean => {
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent).overflowX;
        if (overflow === 'auto' || overflow === 'scroll') return parent.getBoundingClientRect().right <= W + 1 && parent.getBoundingClientRect().left >= -1;
      }
      return false;
    };
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right <= W + 1 && box.left >= -1) continue;
      const parent = el.parentElement?.getBoundingClientRect();
      if (parent && (parent.right > W + 1 || parent.left < -1)) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.position === 'fixed' || el.closest('[inert]')) continue;
      if (scrolledInside(el) || truncated(el)) continue;
      offenders.push(`${el.tagName.toLowerCase()}.${String(el.className)} [${el.dataset['testid'] ?? ''}] ${Math.round(box.left)}…${Math.round(box.right)}`);
    }
    return { scrollWidth, offenders: offenders.slice(0, 10) };
  }, width);
}

/** No horizontal page overflow and nothing sticking out of the window at `width`. */
export async function expectNoOverflow(page: Page, width: number, label: string): Promise<void> {
  const found = await overflowOf(page, width);
  expect(found.scrollWidth, `${label}: document scroll width`).toBeLessThanOrEqual(width);
  expect(found.offenders, `${label}: elements past the window's edge`).toEqual([]);
}

/** The element's box lies inside the window (1 px of rounding). */
export async function expectInsideWindow(locator: Locator, size: Size, label: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label}: has a box`).not.toBeNull();
  if (!box) return;
  expect(box.x, `${label}: left edge`).toBeGreaterThanOrEqual(-1);
  expect(box.y, `${label}: top edge`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${label}: right edge`).toBeLessThanOrEqual(size.width + 1);
  expect(box.y + box.height, `${label}: bottom edge`).toBeLessThanOrEqual(size.height + 1);
}

/** Opens `route` and waits for the shell and the fonts. */
export async function openPage(page: Page, baseUrl: string, route: string): Promise<void> {
  await page.goto(`${baseUrl}${route}`);
  await page.getByTestId('shell').waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/** Opens the sidebar drawer from the app bar or the session header and waits for its slide. */
export async function openDrawer(page: Page): Promise<void> {
  await page.getByTestId('drawer-open').click();
  await expect(page.getByTestId('shell')).toHaveAttribute('data-drawer', 'open');
  await expect(page.getByTestId('sidebar')).not.toHaveAttribute('inert');
  // The 180 ms slide.
  await page.waitForTimeout(250);
}
