import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, installNotificationMocks, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D41 collapsible panes on the real path (D13, no demo seed): `node src/server/main.ts`
 * with fake-claude as the CLI and a temp workspace. The sidebar and the session's
 * right panel slide out with their hide buttons and come back with their reveal
 * handles; ⌘B / Ctrl+B and ⌥⌘B / Ctrl+Alt+B toggle them, but not while typing in
 * the composer; the choice is stored by the service (`ui.sidebarHidden`,
 * `ui.rightPanelHidden` in `GET /api/settings`), so a reload paints it at once
 * (never open first); the right panel's state applies to every session; nothing
 * scrolls sideways in any state; the toast stays top-right and the Remote / "as
 * printed" popovers keep their places with a pane hidden. Layout: `docs/panes.md`.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('panes');
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

/** The slim rail a hidden pane leaves (shell.css `--pane-rail`). */
const RAIL = 6;
const VIEWPORT_WIDTH = 1440;

/** A wide box status table (as an orchestrator prints it), for D27's "as printed" popover. */
const BOX = [
  '┌───────────┬──────────────────────────────────────────────────────────────┬────────────┐',
  '│ Agent     │ Description                                                  │ Status     │',
  '├───────────┼──────────────────────────────────────────────────────────────┼────────────┤',
  '│ 1. web    │ Free talk at 360: layout, tokens and the empty state (Figma) │ 🟢 running │',
  '└───────────┴──────────────────────────────────────────────────────────────┴────────────┘',
];

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return (await response.json()) as SessionDetail;
  }, id);
}

/** The stored pane state (`GET /api/settings`). */
async function stored(page: Page): Promise<{ sidebar: unknown; panel: unknown }> {
  const settings = await page.evaluate(async () => (await (await fetch('/api/settings')).json()) as Record<string, unknown>);
  return { sidebar: settings['ui.sidebarHidden'], panel: settings['ui.rightPanelHidden'] };
}

/** Puts both panes back (the service's state), for the next test. */
async function showBoth(page: Page): Promise<void> {
  const status = await page.evaluate(async () => {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'ui.sidebarHidden': false, 'ui.rightPanelHidden': false }),
    });
    return response.status;
  });
  expect(status).toBe(200);
}

/** Records, before any script of the page runs, the pane attributes the shell and the session view had when they first appeared. */
async function recordFirstPaint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const first: Record<string, string | null> = {};
    (window as unknown as { __sbFirst: typeof first }).__sbFirst = first;
    const look = (): void => {
      const shell = document.querySelector('.sb-shell');
      if (shell && !('sidebar' in first)) first['sidebar'] = shell.getAttribute('data-sidebar');
      const view = document.querySelector('.sb-sv');
      if (view && !('panel' in first)) first['panel'] = view.getAttribute('data-panel');
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
  });
}

async function firstPaint(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate(() => (window as unknown as { __sbFirst: Record<string, string | null> }).__sbFirst);
}

/** Boxes of the shell's parts, once the slide is over (the sidebar's and panel's transforms settle). */
async function boxes(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), visibility: getComputedStyle(el).visibility };
    };
    return {
      sidebar: box('.sb-sidebar'),
      main: box('.sb-main'),
      chat: box('.sb-sv-main'),
      panel: box('.sb-sv-panel'),
      sidebarHandle: box('[data-pane-handle="sidebar"]'),
      panelHandle: box('[data-pane-handle="rightPanel"]'),
    };
  });
}

/** Waits for the slide (180 ms) to end: the pane's transform is where its state says. */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll('.sb-sidebar, .sb-sv-panel')].every((el) => el.getAnimations().length === 0),
      ),
    )
    .toBe(true);
}

/** D29 + D41: nothing scrolls sideways (the window, the shell, the main area, the panes, the session view). */
async function expectNoSidewaysScroll(page: Page, state: string): Promise<void> {
  const findings = await page.evaluate(() => {
    const out: string[] = [];
    window.scrollTo(10_000, window.scrollY);
    if (window.scrollX !== 0) out.push(`the window scrolled to x=${window.scrollX}`);
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) out.push(`the page is ${root.scrollWidth} px wide in a ${root.clientWidth} px window`);
    for (const selector of ['.sb-shell', '.sb-main', '.sb-sidebar', '.sb-sv', '.sb-sv-main', '.sb-sv-panel']) {
      const el = document.querySelector(selector);
      if (!el) continue;
      el.scrollLeft = 10_000;
      if (el.scrollLeft !== 0) out.push(`${selector} scrolled to x=${el.scrollLeft}`);
      el.scrollLeft = 0;
    }
    window.scrollTo(0, window.scrollY);
    return out;
  });
  expect(findings, state).toEqual([]);
}

/** Starts a session that finished its first turn, so its process is live and idle. */
async function doneSession(page: Page, name: string): Promise<string> {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, name, 'Reply with just OK.');
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('done');
  return id;
}

/** The sessions of this world (made once per world: a failed test restarts the worker, and with it the world). */
let sessionA = '';
let sessionB = '';

async function sessions(page: Page): Promise<void> {
  if (!sessionA) sessionA = await doneSession(page, 'panes-a');
  if (!sessionB) sessionB = await doneSession(page, 'panes-b');
}

test('the sidebar: the hide button slides it out, a reload keeps it hidden, the handle brings it back', async ({ page }) => {
  await recordFirstPaint(page);
  await page.goto(`${world.baseUrl}/`);
  const shell = page.getByTestId('shell');
  const sidebar = page.getByTestId('sidebar');
  const hide = page.getByTestId('sidebar-hide');
  await expect(shell).not.toHaveAttribute('data-sidebar');
  await expect(hide).toBeVisible();
  await expect(hide).toHaveAttribute('aria-label', 'Hide sidebar');
  await expect(hide).toHaveAttribute('title', /^Hide sidebar \((⌘B|Ctrl\+B)\)$/);
  await expect(hide).toHaveText('');
  expect(await stored(page)).toEqual({ sidebar: false, panel: false });

  await hide.click();
  await expect(shell).toHaveAttribute('data-sidebar', 'hidden');
  await expect(sidebar).toHaveAttribute('inert', '');
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
  await settled(page);
  let b = await boxes(page);
  // The sidebar is out of the window and not painted; the main area starts after the slim rail and takes the width.
  expect(b.sidebar?.right).toBeLessThanOrEqual(0);
  expect(b.sidebar?.visibility).toBe('hidden');
  expect(b.main).toMatchObject({ x: RAIL, width: VIEWPORT_WIDTH - RAIL });
  expect(b.sidebarHandle).toMatchObject({ x: 0, y: 0, width: RAIL, height: 900 });
  // Focus followed the control to the handle; nothing in the sidebar can take it.
  const handle = page.getByTestId('sidebar-show');
  await expect(handle).toBeFocused();
  await expect(handle).toHaveAttribute('aria-label', 'Show sidebar');
  await expect(handle).toHaveAttribute('title', /^Show sidebar \((⌘B|Ctrl\+B)\)$/);
  await expect(page.getByTestId('new-session')).not.toBeVisible();
  await expectNoSidewaysScroll(page, 'sidebar hidden');
  await expect.poll(() => stored(page)).toEqual({ sidebar: true, panel: false });

  // A reload paints it hidden at once (the stored state is read before the first paint).
  await page.reload();
  await expect(shell).toHaveAttribute('data-sidebar', 'hidden');
  expect(await firstPaint(page)).toMatchObject({ sidebar: 'hidden' });
  b = await boxes(page);
  expect(b.main).toMatchObject({ x: RAIL, width: VIEWPORT_WIDTH - RAIL });

  // The handle's small button shows on hover; a click brings the sidebar back and gives focus to its hide button.
  const chip = page.getByTestId('sidebar-show-chip');
  await expect(chip).toHaveCSS('opacity', '0');
  await handle.hover();
  await expect(chip).toHaveCSS('opacity', '1');
  await chip.click();
  await expect(shell).not.toHaveAttribute('data-sidebar');
  await expect(sidebar).not.toHaveAttribute('inert');
  await expect(sidebar).not.toHaveAttribute('aria-hidden');
  await expect(handle).toHaveCount(0);
  await expect(hide).toBeFocused();
  await settled(page);
  b = await boxes(page);
  expect(b.sidebar).toMatchObject({ x: 0, width: 256, visibility: 'visible' });
  expect(b.main).toMatchObject({ x: 256, width: VIEWPORT_WIDTH - 256 });
  await expect.poll(() => stored(page)).toEqual({ sidebar: false, panel: false });

  await page.reload();
  await expect(page.getByTestId('sidebar-hide')).toBeVisible();
  expect(await firstPaint(page)).toMatchObject({ sidebar: null });
});

test('the right panel: hidden in every session, kept across a reload, back with its handle', async ({ page }) => {
  await sessions(page);
  await recordFirstPaint(page);
  await openWithHub(page, `${world.baseUrl}/sessions/${sessionA}`);
  const view = page.getByTestId('view-session');
  const panel = page.getByTestId('session-right-panel');
  const hide = panel.getByTestId('right-panel-hide');
  await expect(hide).toBeVisible();
  await expect(hide).toHaveAttribute('aria-label', 'Hide panel');
  await expect(hide).toHaveAttribute('title', /^Hide panel \((⌥⌘B|Ctrl\+Alt\+B)\)$/);
  // In the panel's first row (the overview's label row), which keeps its copy.
  await expect(panel.locator('.sb-overview-label')).toHaveText('Agents overview');
  expect(await hide.evaluate((el) => el.parentElement?.classList.contains('sb-overview-label'))).toBe(true);
  let b = await boxes(page);
  expect(b.chat).toMatchObject({ x: 256, width: VIEWPORT_WIDTH - 256 - 380 });
  expect(b.panel).toMatchObject({ x: VIEWPORT_WIDTH - 380, width: 380 });

  await hide.click();
  await expect(view).toHaveAttribute('data-panel', 'hidden');
  await expect(panel).toHaveAttribute('inert', '');
  await expect(panel).toHaveAttribute('aria-hidden', 'true');
  await settled(page);
  b = await boxes(page);
  // The chat spans to the window's right edge, up to the slim rail; the panel is past the edge, not painted.
  expect(b.chat).toMatchObject({ x: 256, width: VIEWPORT_WIDTH - 256 - RAIL });
  expect(b.panel?.x).toBeGreaterThanOrEqual(VIEWPORT_WIDTH);
  expect(b.panel?.visibility).toBe('hidden');
  expect(b.panelHandle).toMatchObject({ x: VIEWPORT_WIDTH - RAIL, y: 0, width: RAIL, height: 900 });
  const handle = page.getByTestId('right-panel-show');
  await expect(handle).toBeFocused();
  await expect(handle).toHaveAttribute('title', /^Show panel \((⌥⌘B|Ctrl\+Alt\+B)\)$/);
  // The sidebar is not touched.
  await expect(page.getByTestId('shell')).not.toHaveAttribute('data-sidebar');
  await expectNoSidewaysScroll(page, 'panel hidden');
  await expect.poll(() => stored(page)).toEqual({ sidebar: false, panel: true });

  // Its state applies to every session.
  await page.getByTestId('sidebar-sessions').locator('a').filter({ hasText: 'panes-b' }).click();
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-session-id', sessionB);
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-panel', 'hidden');
  await expect(page.getByTestId('right-panel-show')).toBeVisible();

  // A reload paints it hidden at once.
  await page.reload();
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-panel', 'hidden');
  expect(await firstPaint(page)).toMatchObject({ panel: 'hidden' });

  // The handle brings it back (focus to its hide button, once the session's panel content is there), in this session and the others.
  await expect(page.getByTestId('agent-overview')).toBeAttached();
  await page.getByTestId('right-panel-show').click();
  await expect(page.getByTestId('view-session')).not.toHaveAttribute('data-panel');
  await expect(page.getByTestId('session-right-panel')).not.toHaveAttribute('inert');
  await expect(page.getByTestId('right-panel-hide')).toBeFocused();
  await settled(page);
  b = await boxes(page);
  expect(b.chat).toMatchObject({ x: 256, width: VIEWPORT_WIDTH - 256 - 380 });
  expect(b.panel).toMatchObject({ x: VIEWPORT_WIDTH - 380, width: 380, visibility: 'visible' });
  await expect.poll(() => stored(page)).toEqual({ sidebar: false, panel: false });
  await page.reload();
  await expect(page.getByTestId('right-panel-hide')).toBeVisible();
  expect(await firstPaint(page)).toMatchObject({ panel: null });
});

test('⌘B / Ctrl+B and ⌥⌘B / Ctrl+Alt+B toggle the panes, but not while typing in the composer', async ({ page }) => {
  await sessions(page);
  await openWithHub(page, `${world.baseUrl}/sessions/${sessionA}`);
  const shell = page.getByTestId('shell');
  const view = page.getByTestId('view-session');
  await expect(page.getByTestId('right-panel-hide')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+b');
  await expect(shell).toHaveAttribute('data-sidebar', 'hidden');
  await expect.poll(() => stored(page)).toEqual({ sidebar: true, panel: false });
  await page.keyboard.press('ControlOrMeta+b');
  await expect(shell).not.toHaveAttribute('data-sidebar');

  await page.keyboard.press('ControlOrMeta+Alt+b');
  await expect(view).toHaveAttribute('data-panel', 'hidden');
  await expect.poll(() => stored(page)).toEqual({ sidebar: false, panel: true });
  await page.keyboard.press('ControlOrMeta+Alt+b');
  await expect(view).not.toHaveAttribute('data-panel');
  await expect.poll(() => stored(page)).toEqual({ sidebar: false, panel: false });

  // Typing in the composer: the keys stay the field's.
  const input = page.getByTestId('chat-input');
  await input.click();
  await input.pressSequentially('hello');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.press('ControlOrMeta+Alt+b');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('hello');
  await expect(shell).not.toHaveAttribute('data-sidebar');
  await expect(view).not.toHaveAttribute('data-panel');
  await input.fill('');

  // Outside the session view there is no right panel: ⌥⌘B does nothing there.
  await page.getByTestId('nav-inbox').click();
  await expect(page.getByTestId('view-inbox')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Alt+b');
  await page.keyboard.press('ControlOrMeta+b');
  await expect(shell).toHaveAttribute('data-sidebar', 'hidden');
  await expect.poll(() => stored(page)).toEqual({ sidebar: true, panel: false });
  await showBoth(page);
});

test('nothing scrolls sideways in any state, and the toast stays top-right with the sidebar hidden', async ({ page }) => {
  await installNotificationMocks(page, 'granted');
  await sessions(page);
  await openWithHub(page, `${world.baseUrl}/sessions/${sessionA}`);
  await expect(page.getByTestId('right-panel-hide')).toBeVisible();
  await expectNoSidewaysScroll(page, 'both shown');
  await page.getByTestId('sidebar-hide').click();
  await settled(page);
  await expectNoSidewaysScroll(page, 'sidebar hidden');
  await page.getByTestId('right-panel-hide').click();
  await settled(page);
  await expectNoSidewaysScroll(page, 'both hidden');
  await page.getByTestId('sidebar-show').click();
  await settled(page);
  await expectNoSidewaysScroll(page, 'panel hidden');
  await page.getByTestId('right-panel-show').click();
  await settled(page);

  // The toast (Settings → Notifications → Send test) stays at the window's top-right corner with the sidebar hidden.
  await page.goto(`${world.baseUrl}/settings/notify`);
  const toast = page.getByTestId('toast');
  const sendTest = async (): Promise<{ x: number; y: number; width: number; height: number }> => {
    await page.getByTestId('settings-send-test').click();
    await expect(toast.locator('.sb-toast-title')).toHaveText('Test notification');
    const box = (await toast.boundingBox())!;
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  };
  const shown = await sendTest();
  expect(shown.x + shown.width).toBe(VIEWPORT_WIDTH - 16);
  expect(shown.y).toBe(16);
  await toast.getByText('Later').click();
  await expect(toast).toHaveCount(0);
  await page.getByTestId('sidebar-hide').click();
  await settled(page);
  expect(await sendTest()).toEqual(shown);
  await expectNoSidewaysScroll(page, 'sidebar hidden, toast shown');
  await toast.getByText('Later').click();
  await showBoth(page);
});

test('popovers with a pane hidden: Remote under its toggle; "as printed" left of the panel, closed when the panel slides out', async ({ page }) => {
  await sessions(page);
  await openWithHub(page, `${world.baseUrl}/sessions/${sessionA}`);
  const send = await page.evaluate(
    async ({ id, text }) => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      return response.status;
    },
    { id: sessionA, text: `Report the status. [fake:say ${JSON.stringify(['Status:', '```', ...BOX, '```'].join('\n'))}]` },
  );
  expect(send).toBe(202);
  const panel = page.getByTestId('session-right-panel');
  await expect(panel.getByTestId('overview-reported')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await detail(page, sessionA)).status).toBe('done');

  // Sidebar hidden: "as printed" opens left of the panel (8 px gap), inside the window.
  await page.getByTestId('sidebar-hide').click();
  await settled(page);
  const toggle = panel.getByTestId('overview-printed-toggle');
  await toggle.click();
  const printed = page.getByTestId('overview-printed-popover');
  await expect(printed).toBeVisible();
  const panelBox = (await panel.boundingBox())!;
  const printedBox = (await printed.boundingBox())!;
  expect(Math.round(printedBox.x + printedBox.width)).toBe(Math.round(panelBox.x - 8));
  expect(printedBox.x).toBeGreaterThanOrEqual(16 - 0.5);
  expect(printedBox.y).toBeGreaterThanOrEqual(16 - 0.5);
  // The panel slides out (⌥⌘B, focus on the toggle, not a text field): the popover goes with it and stays closed after.
  await page.keyboard.press('ControlOrMeta+Alt+b');
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-panel', 'hidden');
  await expect(printed).toHaveCount(0);
  await page.getByTestId('right-panel-show').click();
  await settled(page);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(printed).toHaveCount(0);

  // Panel hidden: the Remote popover opens under its toggle, right-aligned with it, inside the window.
  await page.getByTestId('right-panel-hide').click();
  await settled(page);
  const remote = page.getByTestId('session-remote-toggle');
  await expect(remote).toBeEnabled();
  await remote.click();
  const popover = page.getByTestId('remote-popover');
  await expect(popover).toBeVisible();
  const wrap = (await page.getByTestId('session-remote').boundingBox())!;
  const pop = (await popover.boundingBox())!;
  expect(Math.abs(pop.x + pop.width - (wrap.x + wrap.width))).toBeLessThanOrEqual(1);
  expect(pop.y).toBeGreaterThanOrEqual(wrap.y + wrap.height);
  expect(pop.x).toBeGreaterThanOrEqual(RAIL);
  expect(pop.x + pop.width).toBeLessThanOrEqual(VIEWPORT_WIDTH - RAIL);
  await expectNoSidewaysScroll(page, 'both hidden, Remote popover open');
  // Remote off again (the stored link stays), both panes back.
  await remote.click();
  await expect(remote).toHaveAttribute('aria-checked', 'false');
  await showBoth(page);
});
