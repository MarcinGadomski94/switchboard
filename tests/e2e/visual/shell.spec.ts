import { expect, test } from '@playwright/test';
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
import { FOOTER_PATH, usageRowChecks } from './usage-rows.ts';

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
      /** D61: the app's path when it differs from the prototype's (the MCP nav item shifts the later items). */
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
  navInbox: { path: [0, 2, 0], geometry: 'box', copy: false },
  navInboxLabel: { path: [0, 2, 0, 0], geometry: 'box', copy: true },
  navSolutions: { path: [0, 2, 1], geometry: 'box', copy: false },
  navSolutionsLabel: { path: [0, 2, 1, 0], geometry: 'box', copy: true },
  navSchedules: { path: [0, 2, 2], geometry: 'box', copy: false },
  navSchedulesLabel: { path: [0, 2, 2, 0], geometry: 'box', copy: true },
  navArtifacts: { path: [0, 2, 3], geometry: 'box', copy: false, appPath: [0, 2, 4], anchor: [0, 2, 2], appAnchor: [0, 2, 3] },
  navArtifactsLabel: { path: [0, 2, 3, 0], geometry: 'box', copy: true, appPath: [0, 2, 4, 0], anchor: [0, 2, 2], appAnchor: [0, 2, 3] },
  navHistory: { path: [0, 2, 4], geometry: 'box', copy: false, appPath: [0, 2, 5], anchor: [0, 2, 3], appAnchor: [0, 2, 4] },
  navHistoryLabel: { path: [0, 2, 4, 0], geometry: 'box', copy: true, appPath: [0, 2, 5, 0], anchor: [0, 2, 3], appAnchor: [0, 2, 4] },
  // D68: the app's last nav item is Todos (after History): the TOOLS label is compared with y relative to it.
  toolsLabel: { path: [0, 3], geometry: 'box', copy: true, anchor: [0, 2, 4], appAnchor: [0, 2, 6] },
  toolsAdd: { path: [0, 3, 0], geometry: 'box', copy: true, anchor: [0, 2, 4], appAnchor: [0, 2, 6] },
  sessionsLabel: { path: [0, 5], geometry: 'size', copy: false },
  settings: { path: [0, 7], geometry: 'size', copy: true },
  footer: { path: [0, 8], geometry: 'bottom', copy: false },
  // "claude code" wraps in the prototype only because its row also holds "9 bg processes".
  footerLabel: { path: [0, 8, 0, 1], geometry: 'none', copy: true },
  // D17: the footer grows upward by the Week row, so its rows are compared relative to its top.
  cpuLabel: { path: [0, 8, 1, 0], geometry: 'box', copy: true, anchor: FOOTER_PATH, footerRelative: true },
  cpuTrack: { path: [0, 8, 1, 1], geometry: 'box', copy: false, anchor: FOOTER_PATH, footerRelative: true },
  ramLabel: { path: [0, 8, 2, 0], geometry: 'box', copy: true, anchor: FOOTER_PATH, footerRelative: true },
  ramTrack: { path: [0, 8, 2, 1], geometry: 'box', copy: false, anchor: FOOTER_PATH, footerRelative: true },
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
    // The demo seed's rows are taller than the room the MCP nav item leaves them: the list scrolls (by that row's height).
    ['SESSIONS list scrolls (scroll height − client height)', '> 0', String(scrolling.listOverflow), scrolling.listOverflow > 0],
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
    const boxIssues = compareBoxes(name, relative(p, proto).box, relative(a, shell).box, spec.geometry).map((m) => (anchorName ? `${m} (y relative to ${spec.footerRelative ? "the footer's top, D17" : 'the item above, D61'})` : m));
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
      `| ${name} | ${spec.geometry}${anchorName ? (spec.footerRelative ? ' (y rel. footer)' : ' (y rel. item above)') : ''} | ${fmtBox(p)} | ${fmtBox(a)} | ${boxIssues.length || styleIssues.length ? 'FAIL' : 'ok'} | ${copyNote} |`,
    );
  }

  // D68: the Todos nav item (not in the prototype) against History, the item above it.
  const todosIssues = await appPage.evaluate(() => {
    const todos = document.querySelector<HTMLElement>('[data-testid="nav-todos"]');
    const history = document.querySelector<HTMLElement>('[data-testid="nav-history"]');
    if (!todos || !history) return ['nav:Todos: missing'];
    const issues: string[] = [];
    const a = todos.getBoundingClientRect();
    const b = history.getBoundingClientRect();
    for (const edge of ['x', 'width', 'height'] as const) if (Math.abs(a[edge] - b[edge]) > 0.5) issues.push(`nav:Todos.${edge}: ${a[edge]} vs History ${b[edge]}`);
    if (Math.abs(a.y - (b.y + b.height)) > 3) issues.push(`nav:Todos.y: ${a.y}, not under History (${b.y + b.height})`);
    const la = todos.children[0];
    const lb = history.children[0];
    if (la?.textContent !== 'Todos') issues.push(`nav:Todos.text: ${JSON.stringify(la?.textContent)}`);
    if (la && lb) for (const prop of ['color', 'font-family', 'font-size', 'font-weight', 'letter-spacing']) if (getComputedStyle(la).getPropertyValue(prop) !== getComputedStyle(lb).getPropertyValue(prop)) issues.push(`nav:Todos:label.${prop}`);
    return issues;
  });
  failures.push(...todosIssues);
  rows.push(`| navTodos (D68) | vs navHistory | — | — | ${todosIssues.length ? 'FAIL' : 'ok'} | "Todos" |`);

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
    'shell.md': report({ rows, usageRows, scrollRows, tokenRows, computedRows, failures, full: full.percent, sidebar: side.percent }),
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
Geometry: \`box\` = x, y, width, height · \`size\` = x, width, height (y depends on the data above) · \`bottom\` = x, width, bottom edge · \`none\` = copy and styles only (the box depends on data in the same row) · \`(y rel. footer)\` = y measured from the footer's top on both pages (D17 / D66: the footer is taller by the usage grid, its bottom edge stays).

| Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${input.rows.join('\n')}

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
