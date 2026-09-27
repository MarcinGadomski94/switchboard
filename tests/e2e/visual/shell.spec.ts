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

/**
 * Visual oracle for the empty shell (M1.4, D10): the app's sidebar chrome against
 * the prototype's at 1440×900. The app runs with the demo seed; until the lanes
 * implement the API routes (501 today) its data-driven parts (tool rows, session
 * rows, badges, footer values) are empty, so those parts are compared only where
 * their geometry does not depend on the data (`size` / `bottom` below).
 */

/** Child-index paths from the shell grid (harness.measure). */
const PARTS: Readonly<Record<string, { readonly path: readonly number[]; readonly geometry: Geometry; readonly copy: boolean }>> = {
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
  navArtifacts: { path: [0, 2, 3], geometry: 'box', copy: false },
  navArtifactsLabel: { path: [0, 2, 3, 0], geometry: 'box', copy: true },
  navHistory: { path: [0, 2, 4], geometry: 'box', copy: false },
  navHistoryLabel: { path: [0, 2, 4, 0], geometry: 'box', copy: true },
  toolsLabel: { path: [0, 3], geometry: 'box', copy: true },
  toolsAdd: { path: [0, 3, 0], geometry: 'box', copy: true },
  sessionsLabel: { path: [0, 5], geometry: 'size', copy: false },
  settings: { path: [0, 7], geometry: 'size', copy: true },
  footer: { path: [0, 8], geometry: 'bottom', copy: false },
  // "claude code" wraps in the prototype only because its row also holds "9 bg processes".
  footerLabel: { path: [0, 8, 0, 1], geometry: 'none', copy: true },
  cpuLabel: { path: [0, 8, 1, 0], geometry: 'box', copy: true },
  cpuTrack: { path: [0, 8, 1, 1], geometry: 'box', copy: false },
  ramLabel: { path: [0, 8, 2, 0], geometry: 'box', copy: true },
  ramTrack: { path: [0, 8, 2, 1], geometry: 'box', copy: false },
  maxLabel: { path: [0, 8, 3, 0], geometry: 'box', copy: true },
  maxTrack: { path: [0, 8, 3, 1], geometry: 'box', copy: false },
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
  const proto = await measure(protoPage, paths);
  const shell = await measure(appPage, paths);
  const failures: string[] = [];
  const rows: string[] = [];

  // Boxes (±2 px) and exact copy.
  for (const [name, spec] of Object.entries(PARTS)) {
    const p = proto[name];
    const a = shell[name];
    if (!p || !a) {
      failures.push(`${name}: missing (${p ? 'app' : 'prototype'})`);
      continue;
    }
    const boxIssues = compareBoxes(name, p.box, a.box, spec.geometry);
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
      `| ${name} | ${spec.geometry} | ${fmtBox(p)} | ${fmtBox(a)} | ${boxIssues.length || styleIssues.length ? 'FAIL' : 'ok'} | ${copyNote} |`,
    );
  }

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
    'shell.md': report({ rows, tokenRows, computedRows, failures, full: full.percent, sidebar: side.percent }),
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
Geometry: \`box\` = x, y, width, height · \`size\` = x, width, height (y depends on the data above) · \`bottom\` = x, width, bottom edge · \`none\` = copy and styles only (the box depends on data in the same row).

| Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${input.rows.join('\n')}

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
