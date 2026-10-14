import { type Page, expect, test } from '@playwright/test';
import {
  type DemoApp,
  canonicalColors,
  type Geometry,
  type Part,
  compareBoxes,
  hexToRgb,
  measure,
  newVisualPage,
  openApp,
  openPrototype,
  pixelDiff,
  rootTokens,
  round,
  sideBySide,
  specColorTokens,
  startDemoApp,
  writeReport,
} from './harness.ts';
import { APP_FOOTER_PATH, FOOTER_PATH, usageRowChecks } from './usage-rows.ts';

/**
 * Visual oracle for the empty shell (M1.4, D10): the app's sidebar chrome against
 * the prototype's at 1440×900. The app runs with the demo seed; until the lanes
 * implement the API routes (501 today) its data-driven parts (tool rows, session
 * rows, badges, footer values) are empty, so those parts are compared only where
 * their geometry does not depend on the data (`size` / `bottom` below).
 *
 * D17 / D66: the prototype's one "Max" row became the usage grid (a header and a
 * line per account), so the footer is taller (its bottom edge stays). The rows
 * above it are compared with y relative to the footer's top (`anchor`); the grid
 * is listed and checked on the footer's own rules (`usage-rows.ts`), not against
 * the prototype.
 *
 * D61: the nav has a sixth item, MCP, after Schedules & loops (the prototype has
 * five). The app's Artifacts / History items are its 5th / 6th (`appPath`), and they
 * and the parts under the nav are compared with y relative to the item above them
 * on each page (`anchor` / `appAnchor`), so the extra row is not a finding.
 *
 * D68: a seventh item, Todos, after History (the last one): the parts under the nav
 * are compared with y relative to it on the app (`appAnchor`), and the item is
 * gated against History (same x, width, height, label styles; directly below it).
 *
 * Fix: sidebar scrolling (`docs/sidebar.md` → *Layout and scrolling*): only the
 * SESSIONS list scrolls. The extra MCP row no longer makes the whole sidebar
 * scroll (by 24 px with the demo seed, as it did from D61 on): the sidebar itself
 * does not scroll, the footer is measured where it is, its bottom edge the
 * prototype's, and the SESSIONS list is the part that is shorter than its rows
 * (it scrolls, down only).
 *
 * D101 (developer request 2026-10-14, a deliberate deviation, `docs/visual/README.md`):
 * the nav is an icon grid (5 columns of 40 px cells under "+ New session") and TOOLS is
 * collapsible. The nav items are no longer compared with the prototype's rows: the grid
 * is gated on its own rules (`navGridChecks`: columns, cell boxes against "+ New session",
 * row gap, icons, the selected cell in the prototype's selected nav colours, the Inbox
 * badge, names as aria-label in the prototype's order plus MCP and Todos). The TOOLS
 * label keeps the prototype's x, width and height and sits right under the grid; "+ Add"
 * keeps its box relative to the label; the label's copy gains the toggle's chevron. The
 * parts from SESSIONS down were already compared by size or against the footer.
 */

/** Child-index paths from the shell grid (harness.measure). */
const PARTS: Readonly<
  Record<
    string,
    {
      readonly path: readonly number[];
      readonly geometry: Geometry;
      readonly copy: boolean;
      /** y relative to this part's top (both pages, unless {@link appAnchor}). */
      readonly anchor?: readonly number[];
      /** The app's path when it differs from the prototype's (D101: the TOOLS toggle comes before + Add). */
      readonly appPath?: readonly number[];
      /** D61: the app's anchor when it differs from the prototype's. */
      readonly appAnchor?: readonly number[];
      /** y relative to the footer's top (D17), for the report's wording. */
      readonly footerRelative?: boolean;
    }
  >
> = {
  sidebar: { path: [0], geometry: 'box', copy: false },
  main: { path: [1], geometry: 'box', copy: false },
  brand: { path: [0, 0], geometry: 'box', copy: false },
  brandMark: { path: [0, 0, 0], geometry: 'box', copy: true },
  brandName: { path: [0, 0, 1], geometry: 'box', copy: true },
  paletteKey: { path: [0, 0, 2], geometry: 'box', copy: true },
  newSession: { path: [0, 1, 0], geometry: 'box', copy: true },
  // D101: the nav items (the prototype's rows) are not compared: the grid is gated by `navGridChecks`.
  // The TOOLS label keeps the prototype's x, width and height (its y follows the grid); + Add its box relative to it.
  toolsLabel: { path: [0, 3], geometry: 'size', copy: false },
  toolsAdd: { path: [0, 3, 0], geometry: 'box', copy: true, appPath: [0, 3, 1], anchor: [0, 3] },
  // D106: the app has the CHATS section (always shown) right before the SESSIONS label: every later part is one child further.
  sessionsLabel: { path: [0, 5], geometry: 'size', copy: false, appPath: [0, 6] },
  settings: { path: [0, 7], geometry: 'size', copy: true, appPath: [0, 8] },
  footer: { path: [0, 8], geometry: 'bottom', copy: false, appPath: APP_FOOTER_PATH },
  // "claude code" wraps in the prototype only because its row also holds "9 bg processes".
  footerLabel: { path: [0, 8, 0, 1], geometry: 'none', copy: true, appPath: [...APP_FOOTER_PATH, 0, 1] },
  // D17: the footer grows upward by the Week row, so its rows are compared relative to its top.
  cpuLabel: { path: [0, 8, 1, 0], geometry: 'box', copy: true, anchor: FOOTER_PATH, appAnchor: APP_FOOTER_PATH, appPath: [...APP_FOOTER_PATH, 1, 0], footerRelative: true },
  cpuTrack: { path: [0, 8, 1, 1], geometry: 'box', copy: false, anchor: FOOTER_PATH, appAnchor: APP_FOOTER_PATH, appPath: [...APP_FOOTER_PATH, 1, 1], footerRelative: true },
  ramLabel: { path: [0, 8, 2, 0], geometry: 'box', copy: true, anchor: FOOTER_PATH, appAnchor: APP_FOOTER_PATH, appPath: [...APP_FOOTER_PATH, 2, 0], footerRelative: true },
  ramTrack: { path: [0, 8, 2, 1], geometry: 'box', copy: false, anchor: FOOTER_PATH, appAnchor: APP_FOOTER_PATH, appPath: [...APP_FOOTER_PATH, 2, 1], footerRelative: true },
  // The prototype's Max row (maxLabel / maxTrack) has no counterpart: D17's Session + Week rows, see usage-rows.ts.
};

/** Computed styles compared between the two pages for every part. */
const COMPARED_STYLES = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'letter-spacing',
  'text-transform',
  'border-radius',
  'border-right-color',
  'border-top-color',
] as const;

/** Parts whose computed styles depend on data or state and are left out of the style diff. */
const STYLE_EXEMPT = new Set(['footer']);

let app: DemoApp;

test.beforeAll(async () => {
  app = await startDemoApp();
});

test.afterAll(async () => {
  await app?.stop();
});

test('empty shell: sidebar chrome matches the prototype (tokens, boxes ±2 px, copy)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototype(protoPage, { simulateIncoming: false });
  await openApp(appPage, app.baseUrl, '/');

  const paths = Object.fromEntries(Object.entries(PARTS).map(([name, part]) => [name, part.path]));
  const appPaths = Object.fromEntries(Object.entries(PARTS).map(([name, part]) => [name, part.appPath ?? part.path]));
  // An anchor is measured under its prototype name on both pages (D61: from the app's own path there).
  const anchors = (app: boolean) =>
    Object.fromEntries(Object.entries(PARTS).flatMap(([, part]) => (part.anchor ? [[`@${part.anchor.join('.')}`, app ? (part.appAnchor ?? part.anchor) : part.anchor]] : [])));
  const proto = await measure(protoPage, { ...paths, ...anchors(false) });
  const shell = await measure(appPage, { ...appPaths, ...anchors(true) });
  const failures: string[] = [];

  // Fix: sidebar scrolling: at 1440×900 with the demo seed the sidebar itself does not scroll (the footer shows without
  // scrolling); the SESSIONS list takes the room left and is the part that scrolls when its rows do not fit, down only.
  const scrolling = await appPage.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>('.sb-sidebar')!;
    const list = document.querySelector<HTMLElement>('[data-testid="sidebar-sessions"]')!;
    const footer = document.querySelector<HTMLElement>('[data-testid="machine-footer"]')!.getBoundingClientRect();
    const style = getComputedStyle(list);
    return {
      sidebarOverflow: sidebar.scrollHeight - sidebar.clientHeight,
      footerBottom: footer.bottom,
      listOverflow: list.scrollHeight - list.clientHeight,
      listSideways: list.scrollWidth - list.clientWidth,
      listOverflowY: style.overflowY,
      listOverflowX: style.overflowX,
    };
  });
  const scrollChecks: Array<[string, string, string, boolean]> = [
    ['sidebar scroll height − client height', '0', String(scrolling.sidebarOverflow), scrolling.sidebarOverflow <= 0],
    ['footer bottom (no scrolling)', '≤ 900', String(round(scrolling.footerBottom)), scrolling.footerBottom <= 900.5],
    ['SESSIONS list overflow-y / overflow-x', 'auto / hidden', `${scrolling.listOverflowY} / ${scrolling.listOverflowX}`, scrolling.listOverflowY === 'auto' && scrolling.listOverflowX === 'hidden'],
    // D101: the grid's two rows leave the demo seed's six rows room: the list scrolls only when its rows do not fit.
    ['SESSIONS list overflow (scroll height − client height)', '≥ 0', String(scrolling.listOverflow), scrolling.listOverflow >= 0],
    ['SESSIONS list sideways (scroll width − client width)', '0', String(scrolling.listSideways), scrolling.listSideways <= 0],
  ];
  for (const [check, want, got, ok] of scrollChecks) if (!ok) failures.push(`scrolling · ${check}: expected ${want}, got ${got}`);
  const scrollRows = scrollChecks.map(([check, want, got, ok]) => `| ${check} | ${want} | ${got} | ${ok ? 'ok' : 'FAIL'} |`);
  const rows: string[] = [];

  // Boxes (±2 px) and exact copy.
  for (const [name, spec] of Object.entries(PARTS)) {
    const p = proto[name];
    const a = shell[name];
    if (!p || !a) {
      failures.push(`${name}: missing (${p ? 'app' : 'prototype'})`);
      continue;
    }
    const anchorName = spec.anchor ? `@${spec.anchor.join('.')}` : null;
    const relative = (part: Part, side: Record<string, Part | null>): Part =>
      anchorName ? { ...part, box: { ...part.box, y: part.box.y - (side[anchorName]?.box.y ?? Number.NaN) } } : part;
    const boxIssues = compareBoxes(name, relative(p, proto).box, relative(a, shell).box, spec.geometry).map((m) => (anchorName ? `${m} (y relative to ${spec.footerRelative ? "the footer's top, D17" : 'the TOOLS label, D101'})` : m));
    failures.push(...boxIssues);
    let copyNote = '';
    if (spec.copy) {
      if (p.text !== a.text) failures.push(`${name}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`);
      copyNote = JSON.stringify(a.text);
    }
    const styleIssues: string[] = [];
    if (!STYLE_EXEMPT.has(name)) {
      for (const prop of COMPARED_STYLES) {
        if (p.style[prop] !== a.style[prop]) styleIssues.push(`${name}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
      }
    }
    failures.push(...styleIssues);
    rows.push(
      `| ${name} | ${spec.geometry}${anchorName ? (spec.footerRelative ? ' (y rel. footer)' : ' (y rel. TOOLS label)') : ''} | ${fmtBox(p)} | ${fmtBox(a)} | ${boxIssues.length || styleIssues.length ? 'FAIL' : 'ok'} | ${copyNote} |`,
    );
  }

  // D101: the nav grid and the TOOLS header on their own rules.
  const grid = await navGridChecks(protoPage, appPage);
  failures.push(...grid.failures);
  const gridRows = grid.checks.map(([check, want, got, ok]) => `| ${check} | ${want.replaceAll('|', '\\|')} | ${got.replaceAll('|', '\\|')} | ${ok ? 'ok' : 'FAIL'} |`);

  // D66: the usage grid, listed next to the prototype's Max row and gated on the footer's own rules.
  const usage = await usageRowChecks(protoPage, appPage, 'D66');
  failures.push(...usage.failures);
  const usageRows = usage.checks.map((c) => `| ${c.part} | ${c.proto.replaceAll('|', '\\|')} | ${c.app.replaceAll('|', '\\|')} | ${c.result} | ${c.note.replaceAll('|', '\\|')} |`);

  // SPEC tokens: every color of SPEC → Design tokens is defined on :root.
  const tokens = await rootTokens(appPage);
  const defined = new Set((await canonicalColors(appPage, Object.values(tokens))).filter((c): c is string => c !== null));
  const spec = await specColorTokens();
  const tokenRows: string[] = [];
  for (const [token, values] of Object.entries(spec)) {
    const canonical = await canonicalColors(appPage, values);
    const missing = values.filter((_, i) => canonical[i] === null || !defined.has(canonical[i]!));
    if (missing.length) failures.push(`token ${token}: ${missing.join(', ')} not defined as a CSS variable`);
    tokenRows.push(`| ${token} | ${values.join(' · ')} | ${missing.length ? `missing ${missing.join(', ')}` : 'ok'} |`);
  }

  // Computed-style token assertions against SPEC values.
  const computed = await appPage.evaluate(() => {
    const body = getComputedStyle(document.body);
    const shell = getComputedStyle(document.querySelector('.sb-shell')!);
    const main = getComputedStyle(document.querySelector('.sb-main')!);
    const sidebar = getComputedStyle(document.querySelector('.sb-sidebar')!);
    const label = getComputedStyle(document.querySelector('.sb-section-label')!);
    const selected = getComputedStyle(document.querySelector('.sb-nav-item[aria-current="page"]')!);
    const primary = getComputedStyle(document.querySelector('.sb-new')!);
    return {
      bodyBg: body.backgroundColor,
      bodyFont: body.fontFamily,
      shellBg: shell.backgroundColor,
      shellColumns: shell.gridTemplateColumns,
      mainBg: main.backgroundColor,
      sidebarBorder: sidebar.borderRightColor,
      labelFont: `${label.fontWeight} ${label.fontSize} ${label.fontFamily}`,
      labelTransform: label.textTransform,
      labelSpacing: label.letterSpacing,
      labelColor: label.color,
      selectedBg: selected.backgroundColor,
      selectedFg: selected.color,
      primaryBg: primary.backgroundColor,
      primaryFg: primary.color,
      geist: document.fonts.check('13px Geist'),
      geistMono: document.fonts.check('11px "Geist Mono"'),
    };
  });
  const expected: Record<string, string | boolean> = {
    bodyBg: hexToRgb('#0b0c0d'),
    bodyFont: 'Geist, system-ui, sans-serif',
    shellBg: hexToRgb('#111214'),
    shellColumns: '256px 1184px',
    mainBg: hexToRgb('#141518'),
    sidebarBorder: hexToRgb('#232428'),
    labelFont: '500 10.5px "Geist Mono", monospace',
    labelTransform: 'uppercase',
    labelSpacing: '0.63px',
    labelColor: hexToRgb('#8d8c87'),
    selectedBg: hexToRgb('#212227'),
    selectedFg: hexToRgb('#f0efeb'),
    primaryBg: hexToRgb('#e8e7e3'),
    primaryFg: hexToRgb('#111214'),
    geist: true,
    geistMono: true,
  };
  const computedRows: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = computed[key as keyof typeof computed];
    if (got !== want) failures.push(`computed ${key}: expected ${String(want)}, got ${String(got)}`);
    computedRows.push(`| ${key} | ${String(want)} | ${String(got)} | ${got === want ? 'ok' : 'FAIL'} |`);
  }

  // Advisory pixel diff + side-by-side captures.
  const protoShot = await protoPage.screenshot();
  const appShot = await appPage.screenshot();
  const clip = { x: 0, y: 0, width: 256, height: 900 };
  const protoSidebar = await protoPage.screenshot({ clip });
  const appSidebar = await appPage.screenshot({ clip });
  const full = await pixelDiff(appPage, protoShot, appShot);
  const side = await pixelDiff(appPage, protoSidebar, appSidebar);
  const pairFull = await sideBySide(appPage, protoShot, appShot);
  const pairSidebar = await sideBySide(appPage, protoSidebar, appSidebar);

  await writeReport({
    'shell.md': report({ rows, gridRows, usageRows, scrollRows, tokenRows, computedRows, failures, full: full.percent, sidebar: side.percent }),
    'shell-side-by-side.png': pairFull,
    'shell-sidebar-side-by-side.png': pairSidebar,
  });

  expect(failures).toEqual([]);
});

function fmtBox(part: Part): string {
  const { x, y, width, height } = part.box;
  return `${round(x)},${round(y)} ${round(width)}×${round(height)}`;
}

function report(input: {
  rows: string[];
  gridRows: string[];
  usageRows: string[];
  scrollRows: string[];
  tokenRows: string[];
  computedRows: string[];
  failures: string[];
  full: number;
  sidebar: number;
}): string {
  return `# Visual oracle · empty shell (M1.4)

Generated by \`tests/e2e/visual/shell.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`), 1440×900, \`/\` (Inbox).
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, same viewport.

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff (advisory, channel threshold 24): full page **${input.full.toFixed(2)}%**, sidebar (0,0 256×900) **${input.sidebar.toFixed(2)}%**.
The app's routes answer 501 until the lanes land, so the prototype's data (badges, tool and session rows, footer values, the Inbox view) is missing from the app; that is most of the difference.

Side by side (prototype left, app right): \`shell-side-by-side.png\`, \`shell-sidebar-side-by-side.png\`.

## Boxes (±2 px) and copy
D101: the nav rows are not listed here (see *D101 nav grid* below). Geometry: \`box\` = x, y, width, height · \`size\` = x, width, height (y depends on the data above) · \`bottom\` = x, width, bottom edge · \`none\` = copy and styles only (the box depends on data in the same row) · \`(y rel. footer)\` = y measured from the footer's top on both pages (D17 / D66: the footer is taller by the usage grid, its bottom edge stays).

| Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${input.rows.join('\n')}

## D101 nav grid and TOOLS header (the app's own rules)
The prototype lists the views as text rows; D101 makes them an icon grid and TOOLS collapsible (\`docs/visual/README.md\` → *Deliberate deviations*). The rows below gate the grid against "+ New session" (the prototype's own box), the prototype's selected nav colours and the order of its nav labels.

| Check | Expected | App | Result |
|---|---|---|---|
${input.gridRows.join('\n')}

## D66 usage grid (listed, not compared with the prototype)
The prototype's footer has one "Max" row; D66 shows the usage grid in its place: a **5h** / **Week** header and one line per account (the demo: one, Claude). \`listed\` rows record the grid next to the prototype's Max row. The gated rows check the footer's own rules: the header, one fixed line height, label and % text styles equal to the RAM row, the prototype Max bar's height / radius / colors (D23 / D46: a bar with a pace, the demo's 5h, fills with status done / need and carries the allowance marker), the header 7 px below the RAM row and 6 px between grid rows, the Week % ending where the RAM value ends, the bars lined up, and the footer's bottom edge kept while it grows by exactly the grid less the Max row.

| Part | Prototype | App | Result | Notes |
|---|---|---|---|---|
${input.usageRows.join('\n')}

## Sidebar scrolling (Fix: sidebar scrolling)
Only the SESSIONS list scrolls (\`docs/sidebar.md\` → *Layout and scrolling*). The prototype has five nav items and its sidebar fits; D61's sixth (MCP) made the app's whole sidebar scroll by 24 px with the demo seed. Now the sidebar itself does not scroll, the footer is measured where it is (its bottom edge the prototype's, above), and the SESSIONS list is shorter than its rows and scrolls.

| Check | Expected | App | Result |
|---|---|---|---|
${input.scrollRows.join('\n')}

## SPEC color tokens defined as CSS variables
| Token | SPEC values | Result |
|---|---|---|
${input.tokenRows.join('\n')}

## Computed styles
| Check | Expected (SPEC) | App | Result |
|---|---|---|---|
${input.computedRows.join('\n')}

## Findings
${input.failures.length ? input.failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}

/** The prototype's nav labels, in its order (D101: the app's cells carry them as `aria-label`, MCP and Todos added; D108: Insights last). */
const PROTO_NAV_LABELS = ['Inbox', 'Solutions', 'Schedules & loops', 'Artifacts', 'History'] as const;
const APP_NAV_LABELS = ['Inbox', 'Solutions', 'Schedules & loops', 'MCP', 'Artifacts', 'History', 'Todos', 'Insights'] as const;

/**
 * D101: the nav grid and the TOOLS header on their own rules, at 1440×900 with the demo seed
 * on the Inbox: [check, expected, app, ok] rows.
 */
export async function navGridChecks(protoPage: Page, appPage: Page): Promise<{ checks: Array<[string, string, string, boolean]>; failures: string[] }> {
  // The prototype's selected nav item (Inbox) and its label order.
  const proto = await protoPage.evaluate(() => {
    // The prototype's shell grid (as harness.measure finds it): [0] the sidebar, [0, 2] its nav.
    const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
      const style = getComputedStyle(el);
      return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
    });
    const nav = grid?.children[0]?.children[2] as HTMLElement | undefined;
    const items = nav ? [...nav.children] : [];
    const selected = items[0] as HTMLElement | undefined;
    const style = selected ? getComputedStyle(selected) : null;
    return { labels: items.map((item) => item.children[0]?.textContent ?? ''), bg: style?.backgroundColor ?? '', fg: style?.color ?? '' };
  });
  const app = await appPage.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('[data-testid="nav-grid"]')!;
    const button = document.querySelector<HTMLElement>('[data-testid="new-session"]')!.getBoundingClientRect();
    const wrap = document.querySelector<HTMLElement>('.sb-new-wrap')!.getBoundingClientRect();
    const label = document.querySelector<HTMLElement>('[data-testid="tools-head"]')!.getBoundingClientRect();
    const toggle = document.querySelector<HTMLElement>('[data-testid="tools-toggle"]')!;
    const cells = [...nav.querySelectorAll<HTMLElement>('.sb-nav-item')].map((cell) => {
      const r = cell.getBoundingClientRect();
      const icon = cell.querySelector('svg')!.getBoundingClientRect();
      const cs = getComputedStyle(cell);
      return {
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        iconW: icon.width,
        iconH: icon.height,
        iconDx: icon.x + icon.width / 2 - (r.x + r.width / 2),
        iconDy: icon.y + icon.height / 2 - (r.y + r.height / 2),
        label: cell.getAttribute('aria-label') ?? '',
        title: cell.getAttribute('title') ?? '',
        selected: cell.getAttribute('aria-current') === 'page',
        bg: cs.backgroundColor,
        fg: cs.color,
        radius: cs.borderTopLeftRadius,
      };
    });
    const inbox = document.querySelector<HTMLElement>('[data-testid="nav-inbox"]')!;
    const badge = inbox.querySelector<HTMLElement>('.sb-badge')!;
    const b = badge.getBoundingClientRect();
    const c = inbox.getBoundingClientRect();
    const bs = getComputedStyle(badge);
    const navRect = nav.getBoundingClientRect();
    return {
      columns: getComputedStyle(nav).gridTemplateColumns,
      nav: { top: navRect.top, bottom: navRect.bottom },
      button: { left: button.left, right: button.right },
      wrapBottom: wrap.bottom,
      labelTop: label.top,
      toggle: { text: toggle.textContent ?? '', expanded: toggle.getAttribute('aria-expanded'), font: getComputedStyle(toggle).fontFamily, transform: getComputedStyle(toggle).textTransform },
      cells,
      badge: { text: badge.textContent ?? '', top: b.top - c.top, right: c.right - b.right, h: b.height, bg: bs.backgroundColor, fg: bs.color, font: `${bs.fontWeight} ${bs.fontSize}` },
      need: getComputedStyle(document.documentElement).getPropertyValue('--status-need').trim(),
    };
  });
  const near = (a: number, b: number, tol = 0.5): boolean => Math.abs(a - b) <= tol;
  const r = (n: number): string => String(Math.round(n * 10) / 10);
  const rows: Array<[string, string, string, boolean]> = [];
  rows.push(['grid columns', '40px × 5', app.columns, app.columns === '40px 40px 40px 40px 40px']);
  // D108 (a deliberate change, `docs/visual/README.md` → D108): Insights is the eighth cell, still two rows.
  rows.push(['cells (8 views; Team / Plans off)', '8', String(app.cells.length), app.cells.length === 8]);
  rows.push(['cell size', '40 × 40 each', app.cells.map((c) => `${r(c.w)}×${r(c.h)}`).join(' '), app.cells.every((c) => near(c.w, 40) && near(c.h, 40))]);
  rows.push(['grid top = "+ New session" row bottom (its 8 px padding)', r(app.wrapBottom), r(app.nav.top), near(app.nav.top, app.wrapBottom)]);
  const first = app.cells[0]!;
  const fifth = app.cells[4]!;
  rows.push(['first column left = "+ New session" left', r(app.button.left), r(first.x), near(first.x, app.button.left)]);
  rows.push(['fifth column right = "+ New session" right', r(app.button.right), r(fifth.x + fifth.w), near(fifth.x + fifth.w, app.button.right)]);
  const rowTops = [...new Set(app.cells.map((c) => Math.round(c.y)))];
  rows.push(['rows (5 + 3), 6 px apart', `2 · gap 6`, `${rowTops.length} · gap ${rowTops.length > 1 ? r(rowTops[1]! - rowTops[0]! - 40) : '—'}`, rowTops.length === 2 && near(rowTops[1]! - rowTops[0]! - 40, 6, 1)]);
  rows.push(['second row starts in the first column', r(first.x), r(app.cells[5]!.x), near(app.cells[5]!.x, first.x)]);
  rows.push(['icons 18 × 18, centred', '18×18, ±0.5', app.cells.map((c) => `${r(c.iconW)}×${r(c.iconH)}`).join(' '), app.cells.every((c) => near(c.iconW, 18) && near(c.iconH, 18) && near(c.iconDx, 0) && near(c.iconDy, 0))]);
  rows.push(['names (aria-label): the prototype\'s labels in order, MCP, Todos and Insights added', [...proto.labels].join(' · ') + ' (+ MCP, Todos, Insights)', app.cells.map((c) => c.label).join(' · '), proto.labels.join('|') === PROTO_NAV_LABELS.join('|') && app.cells.map((c) => c.label).join('|') === APP_NAV_LABELS.join('|')]);
  rows.push(['tooltips start with the name', 'name[ · badge]', app.cells.map((c) => c.title).join(' · '), app.cells.every((c) => c.title === c.label || c.title.startsWith(`${c.label} · `))]);
  const selected = app.cells.filter((c) => c.selected);
  rows.push(['selected cell (Inbox) in the prototype\'s selected nav colours', `${proto.bg} / ${proto.fg}`, selected.map((c) => `${c.label}: ${c.bg} / ${c.fg}`).join(), selected.length === 1 && selected[0]!.label === 'Inbox' && selected[0]!.bg === proto.bg && selected[0]!.fg === proto.fg]);
  const rest = app.cells.filter((c) => !c.selected);
  rows.push(['other cells: transparent, muted-1 icon, radius 8px', 'rgba(0, 0, 0, 0) / rgb(169, 168, 163) / 8px', [...new Set(rest.map((c) => `${c.bg} / ${c.fg} / ${c.radius}`))].join(), rest.every((c) => c.bg === 'rgba(0, 0, 0, 0)' && c.fg === 'rgb(169, 168, 163)' && c.radius === '8px')]);
  rows.push(['Inbox badge: "5", amber, on the top-right corner (3 px out), 16 px high', '5 · 3 / 3 out · 16', `${app.badge.text} · ${r(-app.badge.top)} / ${r(-app.badge.right)} out · ${r(app.badge.h)} · ${app.badge.bg} / ${app.badge.fg} · ${app.badge.font}`, app.badge.text === '5' && near(app.badge.top, -3) && near(app.badge.right, -3) && near(app.badge.h, 16) && app.badge.fg === 'rgb(17, 18, 20)']);
  rows.push(['TOOLS label top = grid bottom', r(app.nav.bottom), r(app.labelTop), near(app.labelTop, app.nav.bottom)]);
  rows.push(['TOOLS toggle: ▾ Tools, expanded, the label\'s mono uppercase', '▾Tools · true · uppercase', `${app.toggle.text} · ${app.toggle.expanded} · ${app.toggle.transform}`, app.toggle.text === '▾Tools' && app.toggle.expanded === 'true' && app.toggle.transform === 'uppercase' && app.toggle.font.includes('Geist Mono')]);
  return { checks: rows, failures: rows.filter(([, , , ok]) => !ok).map(([check, want, got]) => `D101 nav grid · ${check}: expected ${want}, got ${got}`) };
}

test('D106: the CHATS header is the SESSIONS label\'s twin (styles, height, x and width), right above it; no chats in the demo seed', async ({ browser }) => {
  const appPage = await newVisualPage(browser);
  await openApp(appPage, app.baseUrl, '/');
  const facts = await appPage.evaluate(() => {
    const chats = document.querySelector<HTMLElement>('[data-testid="sidebar-chats-head"]')!;
    const sessions = document.querySelector<HTMLElement>('[data-testid="sessions-head"]')!;
    const style = (el: HTMLElement) => {
      const s = getComputedStyle(el);
      return [s.color, s.fontFamily, s.fontSize, s.fontWeight, s.letterSpacing, s.textTransform].join(' | ');
    };
    const a = chats.getBoundingClientRect();
    const b = sessions.getBoundingClientRect();
    return {
      styles: [style(chats), style(sessions)],
      boxes: [
        [a.x, a.width, a.height],
        [b.x, b.width, b.height],
      ],
      gap: b.top - a.bottom,
      rows: document.querySelectorAll('[data-testid="sidebar-chat"]').length,
      text: chats.textContent,
    };
  });
  expect(facts.styles[0]).toBe(facts.styles[1]);
  for (let i = 0; i < 3; i++) expect(Math.abs((facts.boxes[0]?.[i] ?? 0) - (facts.boxes[1]?.[i] ?? 0))).toBeLessThanOrEqual(2);
  // The empty list adds nothing between the two headers.
  expect(facts.gap).toBeGreaterThanOrEqual(0);
  expect(facts.gap).toBeLessThanOrEqual(2);
  expect(facts.rows).toBe(0);
  expect(facts.text).toBe('▾Chats0+ New chat');
  await appPage.close();
});
