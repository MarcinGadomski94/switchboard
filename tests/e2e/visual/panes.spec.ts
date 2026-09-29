import { type Browser, type Page, expect, test } from '@playwright/test';
import { type Box, type DemoApp, BOX_TOLERANCE_PX, VIEWPORT, compareBoxes, hexToRgb, measure, newVisualPage, openApp, openPrototype, round, startDemoApp, writeReport } from './harness.ts';

/**
 * D41 (an addition, checked on its own like D18's Name row): the prototype always
 * shows the sidebar and the session's right panel, so the collapsible panes'
 * controls and hidden states have no frame to compare with.
 *
 * - **Both shown (the default)** must be the prototype exactly: the brand row's
 *   mark, name and ⌘K key keep the prototype's boxes with the sidebar's hide
 *   button in the row (between the name and the key, overlapping neither, 20×20,
 *   centred on the row, a muted glyph with no text); the right panel's hide button
 *   sits out of the flow at the right of its first row (the overview's label),
 *   which keeps its height, clear of the label's text; the grids keep `256px |
 *   1fr` and `1fr | 380px`. The full-size comparisons of those parts stay in
 *   `shell.spec.ts`, `session-panel.spec.ts` and the full pass.
 * - **Sidebar hidden:** the shell's columns are the 6 px rail and the rest; the
 *   main area starts at x = 6 (after the rail) and spans to the right edge; the
 *   sidebar is out of the window and not painted; the rail is the sidebar's
 *   background with its divider line; its small button shows on hover only, 20×20
 *   just inside the main area, halfway down (bg-card, border-control).
 * - **Panel hidden:** the session view's columns are the rest and the 6 px rail;
 *   the chat (header and tab) spans to the rail at x = 1434; the header's actions
 *   end 22 px before it (the header's padding); the rail is the main background
 *   with the panel's divider line; its small button mirrors the sidebar's.
 * - **Both hidden**, and `prefers-reduced-motion` (no slide: every transition 0 s).
 *
 * Report: `panes.md` (+ PNGs of the hidden states).
 */

/** The slim rail of a hidden pane (shell.css `--pane-rail`). */
const RAIL = 6;

interface Measured {
  readonly box: Box;
  readonly style: Readonly<Record<string, string>>;
  readonly text: string;
}

const STYLES = [
  'color',
  'background-color',
  'border-top-left-radius',
  'border-right-width',
  'border-right-color',
  'border-left-width',
  'border-left-color',
  'border-top-width',
  'border-top-color',
  'opacity',
  'position',
  'visibility',
  'transition-duration',
] as const;

/** Box, computed styles and text of the first element matching each selector (`null` when none). */
async function pick(page: Page, selectors: Readonly<Record<string, string>>): Promise<Record<string, Measured | null>> {
  return page.evaluate(
    ({ wanted, props }) => {
      const out: Record<string, { box: { x: number; y: number; width: number; height: number }; style: Record<string, string>; text: string } | null> = {};
      for (const [name, selector] of Object.entries(wanted)) {
        const el = document.querySelector(selector);
        if (!el) {
          out[name] = null;
          continue;
        }
        const rect = el.getBoundingClientRect();
        const computed = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const prop of props) style[prop] = computed.getPropertyValue(prop);
        out[name] = { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, style, text: (el.textContent ?? '').trim() };
      }
      return out;
    },
    { wanted: selectors, props: [...STYLES] as string[] },
  );
}

/** Waits for the slide to end (no running transition on the panes). */
async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.sb-sidebar, .sb-sv-panel')].every((el) => el.getAnimations().length === 0))).toBe(true);
}

async function columns(page: Page): Promise<{ shell: string; view: string }> {
  return page.evaluate(() => ({
    shell: getComputedStyle(document.querySelector('.sb-shell')!).gridTemplateColumns,
    view: getComputedStyle(document.querySelector('.sb-sv')!).gridTemplateColumns,
  }));
}

const fmt = (m: Measured | null | undefined): string => (m ? `${round(m.box.x)},${round(m.box.y)} ${round(m.box.width)}×${round(m.box.height)}` : 'missing');
const near = (a: number | undefined, b: number | undefined, tolerance = BOX_TOLERANCE_PX): boolean => a !== undefined && b !== undefined && Math.abs(a - b) <= tolerance;
const right = (m: Measured | null | undefined): number | undefined => (m ? m.box.x + m.box.width : undefined);
const middle = (m: Measured | null | undefined): number | undefined => (m ? m.box.y + m.box.height / 2 : undefined);

async function openSession(browser: Browser, baseUrl: string, options: { readonly reducedMotion?: 'reduce' } = {}): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, ...(options.reducedMotion ? { reducedMotion: options.reducedMotion } : {}) });
  const page = await context.newPage();
  await openApp(page, baseUrl, '/sessions/free-talk-feature');
  await expect(page.getByTestId('agent-overview')).toBeVisible();
  await page.mouse.move(700, 450);
  return page;
}

test.describe('visual: collapsible panes (D41 addition)', () => {
  let app: DemoApp;

  test.beforeAll(async () => {
    app = await startDemoApp();
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test('the hide buttons move no prototype part; the hidden states are laid out as ruled', async ({ browser }) => {
    const rows: string[] = [];
    const failures: string[] = [];
    const check = (what: string, ok: boolean, note: string): void => {
      rows.push(`| ${what.replaceAll('|', '\\|')} | ${note.replaceAll('|', '\\|')} | ${ok ? 'ok' : 'FAIL'} |`);
      if (!ok) failures.push(`${what}: ${note}`);
    };
    const same = (what: string, want: string, got: string | undefined): void => check(what, want === got, `expected ${want}, got ${got ?? 'missing'}`);

    const proto = await newVisualPage(browser);
    await openPrototype(proto, { simulateIncoming: false });
    await proto.getByText('free-talk-feature', { exact: true }).first().click();
    await proto.getByText('Agents & solutions', { exact: true }).waitFor();
    const page = await openSession(browser, app.baseUrl);

    // 1. Both shown: the brand row's parts at the prototype's boxes, the hide button in its free space.
    const protoParts = await measure(proto, { brand: [0, 0], mark: [0, 0, 0], name: [0, 0, 1], key: [0, 0, 2] });
    const appParts = await measure(page, { brand: [0, 0], mark: [0, 0, 0], name: [0, 0, 1], key: [0, 0, 2] });
    for (const name of ['brand', 'mark', 'name', 'key'] as const) {
      const p = protoParts[name];
      const a = appParts[name];
      const issues = p && a ? compareBoxes(name, p.box, a.box, 'box') : [`${name} missing`];
      check(`shown · brand row: ${name} at the prototype's box`, issues.length === 0, issues.length ? issues.join('; ') : a ? `${round(a.box.x)},${round(a.box.y)} ${round(a.box.width)}×${round(a.box.height)}` : '');
    }
    const shown = await pick(page, {
      sidebarHide: '[data-testid="sidebar-hide"]',
      panelHide: '[data-testid="right-panel-hide"]',
      overviewLabel: '.sb-overview-label',
      panel: '.sb-sv-panel',
      overview: '.sb-overview',
    });
    const hide = shown['sidebarHide'];
    const name = appParts['name'];
    const key = appParts['key'];
    const brand = appParts['brand'];
    check(
      'shown · sidebar hide button: in the brand row, the row\'s last child (the prototype\'s children keep their paths)',
      await page.evaluate(() => {
        const button = document.querySelector('[data-testid="sidebar-hide"]');
        return !!button && button.parentElement?.classList.contains('sb-brand') === true && button.parentElement.lastElementChild === button && button.parentElement.children.length === 4;
      }),
      fmt(hide),
    );
    check(
      'shown · sidebar hide button: between the name and the ⌘K key, overlapping neither',
      !!hide && !!name && !!key && hide.box.x >= name.box.x + name.box.width && hide.box.x + hide.box.width <= key.box.x,
      `${fmt(hide)} · name ends ${round(name ? name.box.x + name.box.width : 0)} · key starts ${round(key?.box.x ?? 0)}`,
    );
    check('shown · sidebar hide button: 20×20, centred on the row', near(hide?.box.width, 20, 0.5) && near(hide?.box.height, 20, 0.5) && near(middle(hide), brand ? brand.box.y + 16 + 11 : undefined, 1), fmt(hide));
    same('shown · sidebar hide button: muted glyph (--muted-2), no fill', `${hexToRgb('#8d8c87')} rgba(0, 0, 0, 0)`, hide ? `${hide.style['color']} ${hide.style['background-color']}` : undefined);
    same('shown · sidebar hide button: no text (the row\'s copy is unchanged)', '', hide?.text);
    same('shown · sidebar hide button: label', 'Hide sidebar', (await page.getByTestId('sidebar-hide').getAttribute('aria-label')) ?? undefined);
    check('shown · sidebar hide button: tooltip', /^Hide sidebar \((⌘B|Ctrl\+B)\)$/.test((await page.getByTestId('sidebar-hide').getAttribute('title')) ?? ''), (await page.getByTestId('sidebar-hide').getAttribute('title')) ?? 'none');

    const panelHide = shown['panelHide'];
    const label = shown['overviewLabel'];
    const panel = shown['panel'];
    const panelInner = await page.evaluate(() => {
      const el = document.querySelector('.sb-sv-panel')!;
      return el.getBoundingClientRect().x + el.clientLeft + el.clientWidth;
    });
    const labelText = await page.evaluate(() => {
      const labelEl = document.querySelector('.sb-overview-label')!;
      const range = document.createRange();
      range.selectNodeContents(labelEl.firstChild!);
      return range.getBoundingClientRect().right;
    });
    same('shown · panel hide button: out of the flow in the overview\'s label row', 'absolute', panelHide?.style['position']);
    const withoutButton = await page.evaluate(() => {
      const labelEl = document.querySelector('.sb-overview-label')!;
      const clone = labelEl.cloneNode(true) as HTMLElement;
      clone.querySelector('button')?.remove();
      labelEl.after(clone);
      const height = clone.getBoundingClientRect().height;
      clone.remove();
      return height;
    });
    check('shown · panel hide button: the label row is as tall as without it', near(label?.box.height, withoutButton, 0.5), `${round(label?.box.height ?? 0)} vs ${round(withoutButton)} without it`);
    check('shown · panel hide button: at the row\'s right (the overview\'s 12 px padding)', near(right(panelHide), panelInner - 12, 1), `${fmt(panelHide)} · panel content ends ${round(panelInner)}`);
    check('shown · panel hide button: centred on the label line, inside the panel', near(middle(panelHide), middle(label), 1) && !!panel && !!panelHide && panelHide.box.y >= panel.box.y, fmt(panelHide));
    check('shown · panel hide button: clear of the label text', !!panelHide && labelText < panelHide.box.x, `text ends ${round(labelText)}, button starts ${round(panelHide?.box.x ?? 0)}`);
    check('shown · panel hide button: 20×20', near(panelHide?.box.width, 20, 0.5) && near(panelHide?.box.height, 20, 0.5), fmt(panelHide));
    same('shown · panel hide button: muted glyph, no text', `${hexToRgb('#8d8c87')} `, panelHide ? `${panelHide.style['color']} ${panelHide.text}` : undefined);
    check('shown · panel hide button: tooltip', /^Hide panel \((⌥⌘B|Ctrl\+Alt\+B)\)$/.test((await page.getByTestId('right-panel-hide').getAttribute('title')) ?? ''), (await page.getByTestId('right-panel-hide').getAttribute('title')) ?? 'none');
    same('shown · grids (the prototype\'s 256px | 1fr and 1fr | 380px)', '256px 1184px · 804px 380px', Object.values(await columns(page)).join(' · '));
    same('shown · no reveal handle', '0', String(await page.locator('[data-pane-handle]').count()));
    const motion = await pick(page, { shell: '.sb-shell', sidebar: '.sb-sidebar', view: '.sb-sv', panelEl: '.sb-sv-panel' });
    same('shown · the slide: 180 ms (shell columns, sidebar, view columns, panel)', '0.18s · 0.18s, 0s · 0.18s · 0.18s, 0s', ['shell', 'sidebar', 'view', 'panelEl'].map((k) => motion[k]?.style['transition-duration']).join(' · '));

    // 2. Sidebar hidden.
    await page.getByTestId('sidebar-hide').click();
    await settled(page);
    await page.mouse.move(700, 450);
    let parts = await pick(page, {
      sidebar: '.sb-sidebar',
      main: '.sb-main',
      chat: '.sb-sv-main',
      panelEl: '.sb-sv-panel',
      handle: '[data-pane-handle="sidebar"]',
      chip: '[data-testid="sidebar-show-chip"]',
    });
    same('sidebar hidden · shell columns: the rail and the rest', `${RAIL}px ${VIEWPORT.width - RAIL}px`, (await columns(page)).shell);
    check('sidebar hidden · the main area starts after the rail and spans to the right edge', near(parts['main']?.box.x, RAIL, 0.5) && near(right(parts['main']), VIEWPORT.width, 0.5), fmt(parts['main']));
    check('sidebar hidden · the sidebar is out of the window and not painted', (right(parts['sidebar']) ?? 1) <= 0.5 && parts['sidebar']?.style['visibility'] === 'hidden', `${fmt(parts['sidebar'])} ${parts['sidebar']?.style['visibility'] ?? ''}`);
    check('sidebar hidden · the rail: x 0, 6 px, full height', near(parts['handle']?.box.x, 0, 0.5) && near(parts['handle']?.box.width, RAIL, 0.5) && near(parts['handle']?.box.height, VIEWPORT.height, 0.5), fmt(parts['handle']));
    same('sidebar hidden · the rail: the sidebar\'s background and divider', `${hexToRgb('#111214')} 1px ${hexToRgb('#232428')}`, parts['handle'] ? `${parts['handle'].style['background-color']} ${parts['handle'].style['border-right-width']} ${parts['handle'].style['border-right-color']}` : undefined);
    check('sidebar hidden · the chat and the panel follow (chat from the rail, panel unchanged)', near(parts['chat']?.box.x, RAIL, 0.5) && near(parts['panelEl']?.box.x, VIEWPORT.width - 380, 0.5), `${fmt(parts['chat'])} · ${fmt(parts['panelEl'])}`);
    same('sidebar hidden · the handle\'s button at rest: hidden', '0', parts['chip']?.style['opacity']);
    await page.getByTestId('sidebar-show').hover();
    await expect(page.getByTestId('sidebar-show-chip')).toHaveCSS('opacity', '1');
    parts = { ...parts, ...(await pick(page, { chip: '[data-testid="sidebar-show-chip"]', handle: '[data-pane-handle="sidebar"]' })) };
    check('sidebar hidden · hover: the button, 20×20, 4 px inside the main area, halfway down', near(parts['chip']?.box.x, RAIL + 4, 0.5) && near(parts['chip']?.box.width, 20, 0.5) && near(middle(parts['chip']), VIEWPORT.height / 2, 1), fmt(parts['chip']));
    same('sidebar hidden · hover: bg-card button with a border-control line, rounded 5 px; the rail lights up (border-control)', `${hexToRgb('#17181b')} 1px ${hexToRgb('#2c2d32')} 5px ${hexToRgb('#2c2d32')}`, parts['chip'] && parts['handle'] ? `${parts['chip'].style['background-color']} ${parts['chip'].style['border-top-width']} ${parts['chip'].style['border-top-color']} ${parts['chip'].style['border-top-left-radius']} ${parts['handle'].style['background-color']}` : undefined);
    const sidebarHover = await page.screenshot();
    await page.mouse.move(700, 450);
    const sidebarShot = await page.screenshot();

    // 3. Both hidden.
    await page.getByTestId('right-panel-hide').click();
    await settled(page);
    await page.mouse.move(700, 450);
    parts = await pick(page, { main: '.sb-main', chat: '.sb-sv-main', handle: '[data-pane-handle="rightPanel"]' });
    check('both hidden · the chat spans from the left rail to the right rail', near(parts['chat']?.box.x, RAIL, 0.5) && near(right(parts['chat']), VIEWPORT.width - RAIL, 0.5), fmt(parts['chat']));
    const bothShot = await page.screenshot();

    // 4. Panel hidden (sidebar back).
    await page.getByTestId('sidebar-show').click();
    await settled(page);
    await page.mouse.move(700, 450);
    parts = await pick(page, {
      chat: '.sb-sv-main',
      panelEl: '.sb-sv-panel',
      actions: '.sb-sv-actions',
      handle: '[data-pane-handle="rightPanel"]',
      chip: '[data-testid="right-panel-show-chip"]',
    });
    same('panel hidden · view columns: the rest and the rail', `${VIEWPORT.width - 256 - RAIL}px ${RAIL}px`, (await columns(page)).view);
    check('panel hidden · the chat spans to the rail (x 1434)', near(parts['chat']?.box.x, 256, 0.5) && near(right(parts['chat']), VIEWPORT.width - RAIL, 0.5), fmt(parts['chat']));
    check('panel hidden · the header\'s actions end 22 px before the rail', near(right(parts['actions']), VIEWPORT.width - RAIL - 22, 1), fmt(parts['actions']));
    check('panel hidden · the panel is past the window\'s edge and not painted', (parts['panelEl']?.box.x ?? 0) >= VIEWPORT.width - 0.5 && parts['panelEl']?.style['visibility'] === 'hidden', `${fmt(parts['panelEl'])} ${parts['panelEl']?.style['visibility'] ?? ''}`);
    check('panel hidden · the rail: x 1434, 6 px, full height', near(parts['handle']?.box.x, VIEWPORT.width - RAIL, 0.5) && near(parts['handle']?.box.width, RAIL, 0.5) && near(parts['handle']?.box.height, VIEWPORT.height, 0.5), fmt(parts['handle']));
    same('panel hidden · the rail: the main background and the panel\'s divider', `${hexToRgb('#141518')} 1px ${hexToRgb('#232428')}`, parts['handle'] ? `${parts['handle'].style['background-color']} ${parts['handle'].style['border-left-width']} ${parts['handle'].style['border-left-color']}` : undefined);
    same('panel hidden · the handle\'s button at rest: hidden', '0', parts['chip']?.style['opacity']);
    await page.getByTestId('right-panel-show').hover();
    await expect(page.getByTestId('right-panel-show-chip')).toHaveCSS('opacity', '1');
    parts = { ...parts, ...(await pick(page, { chip: '[data-testid="right-panel-show-chip"]' })) };
    check('panel hidden · hover: the button, 20×20, 4 px inside the chat, halfway down', near(right(parts['chip']), VIEWPORT.width - RAIL - 4, 0.5) && near(parts['chip']?.box.width, 20, 0.5) && near(middle(parts['chip']), VIEWPORT.height / 2, 1), fmt(parts['chip']));
    const panelHover = await page.screenshot();
    await page.mouse.move(700, 450);
    const panelShot = await page.screenshot();
    await page.getByTestId('right-panel-show').click();
    await settled(page);
    same('shown again · grids back to the prototype\'s', '256px 1184px · 804px 380px', Object.values(await columns(page)).join(' · '));

    // 5. prefers-reduced-motion: no slide.
    const reduced = await openSession(browser, app.baseUrl, { reducedMotion: 'reduce' });
    const still = await pick(reduced, { shell: '.sb-shell', sidebar: '.sb-sidebar', view: '.sb-sv', panelEl: '.sb-sv-panel' });
    same('reduced motion · no slide (every transition 0 s)', '0s · 0s · 0s · 0s', ['shell', 'sidebar', 'view', 'panelEl'].map((k) => still[k]?.style['transition-duration']).join(' · '));
    await reduced.getByTestId('sidebar-hide').click();
    same('reduced motion · hidden at once (no running transition)', '0', String(await reduced.evaluate(() => document.querySelector('.sb-sidebar')!.getAnimations().length)));
    await reduced.getByTestId('sidebar-show').click();
    await reduced.context().close();

    const report = [
      '# Visual check · collapsible panes (D41 addition)',
      '',
      'Generated by `tests/e2e/visual/panes.spec.ts`. The prototype always shows the sidebar and the right panel, so the D41 controls and the hidden states are checked on their own (like D18\'s Name row). App: demo seed, 1440×900, `/sessions/free-talk-feature`; prototype: the same session. The full comparisons of the default layout stay in `shell.md`, `session-panel.md` and `full-pass.md` (the hide buttons are in them, moving nothing).',
      '',
      `**Gate:** ${failures.length === 0 ? 'green' : 'red'}`,
      '',
      '| Check | Measured | Result |',
      '|---|---|---|',
      ...rows,
      '',
      'Screenshots: `panes-sidebar-hidden.png`, `panes-sidebar-handle-hover.png`, `panes-panel-hidden.png`, `panes-panel-handle-hover.png`, `panes-both-hidden.png`.',
      '',
    ].join('\n');
    await writeReport({
      'panes.md': report,
      'panes-sidebar-hidden.png': sidebarShot,
      'panes-sidebar-handle-hover.png': sidebarHover,
      'panes-panel-hidden.png': panelShot,
      'panes-panel-handle-hover.png': panelHover,
      'panes-both-hidden.png': bothShot,
    });
    expect(failures).toEqual([]);
  });
});
