import { expect, test } from '@playwright/test';
import {
  type DemoApp,
  type Geometry,
  type Part,
  compareBoxes,
  hexToRgb,
  measure,
  newVisualPage,
  openApp,
  openPrototype,
  pixelDiff,
  round,
  sideBySide,
  startDemoApp,
  writeReport,
} from './harness.ts';

/**
 * Visual oracle for the Codebase Memory tool view (M8.1, D10), against the
 * prototype's `vTool` at 1440×900 (screenshot 09). Both show the tool unreachable:
 * the prototype's live probe of http://localhost:13000 is aborted offline, the
 * demo's probe provider answers `down` without touching the network. The strip
 * shows the prototype's dirty list and "16 projects indexed · full mode" from the
 * demo data.
 */

/** Child-index paths from the shell grid (harness.measure): `[1]` = main, `[1, 0]` = the tool view. */
const PARTS: Readonly<Record<string, { readonly path: readonly number[]; readonly geometry: Geometry; readonly copy: boolean }>> = {
  view: { path: [1, 0], geometry: 'box', copy: false },
  toolbar: { path: [1, 0, 0], geometry: 'box', copy: false },
  toolbarDot: { path: [1, 0, 0, 0], geometry: 'box', copy: false },
  toolbarName: { path: [1, 0, 0, 1], geometry: 'box', copy: true },
  toolbarDesc: { path: [1, 0, 0, 2], geometry: 'box', copy: true },
  urlField: { path: [1, 0, 0, 3], geometry: 'box', copy: false },
  urlText: { path: [1, 0, 0, 3, 0], geometry: 'box', copy: true },
  urlState: { path: [1, 0, 0, 3, 1], geometry: 'box', copy: true },
  actions: { path: [1, 0, 0, 4], geometry: 'box', copy: false },
  reload: { path: [1, 0, 0, 4, 0], geometry: 'box', copy: true },
  newTab: { path: [1, 0, 0, 4, 1], geometry: 'box', copy: true },
  edit: { path: [1, 0, 0, 4, 2], geometry: 'box', copy: true },
  frameArea: { path: [1, 0, 1], geometry: 'box', copy: false },
  overlay: { path: [1, 0, 1, 0], geometry: 'box', copy: false },
  overlayCard: { path: [1, 0, 1, 0, 0], geometry: 'box', copy: false },
  overlayTitle: { path: [1, 0, 1, 0, 0, 0], geometry: 'box', copy: true },
  overlayText: { path: [1, 0, 1, 0, 0, 1], geometry: 'box', copy: true },
  overlayAction: { path: [1, 0, 1, 0, 0, 2, 0], geometry: 'box', copy: true },
  strip: { path: [1, 0, 2], geometry: 'box', copy: false },
  stripFile: { path: [1, 0, 2, 0], geometry: 'box', copy: true },
  chip1: { path: [1, 0, 2, 1], geometry: 'box', copy: true },
  chip1Dot: { path: [1, 0, 2, 1, 0], geometry: 'box', copy: false },
  chip1Name: { path: [1, 0, 2, 1, 1], geometry: 'box', copy: true },
  chip1Time: { path: [1, 0, 2, 1, 2], geometry: 'box', copy: true },
  chip2: { path: [1, 0, 2, 2], geometry: 'box', copy: true },
  chip3: { path: [1, 0, 2, 3], geometry: 'box', copy: true },
  stripNote: { path: [1, 0, 2, 4], geometry: 'box', copy: true },
  reindex: { path: [1, 0, 2, 5], geometry: 'box', copy: true },
  // Sidebar TOOLS rows: dot colors from the probe state. Developer ruling 2026-09-28: the name stays whole
  // on the first line and a URL that does not fit moves to its own line, cut with … (the prototype wraps
  // "Codebase Memory" next to its host). The rows keep the prototype's boxes; the dot sits on the name's
  // line instead of the row's middle (x and size compared). The ruled layout is checked below (`sidebarRuling`).
  sideCm: { path: [0, 4, 0], geometry: 'box', copy: true },
  sideCmDot: { path: [0, 4, 0, 0], geometry: 'size', copy: false },
  sideSw: { path: [0, 4, 1], geometry: 'box', copy: true },
  sideSwDot: { path: [0, 4, 1, 0], geometry: 'box', copy: false },
};

/** Computed styles compared between the two pages for every part. */
const COMPARED_STYLES = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'border-radius',
  'border-top-color',
  'border-top-width',
  'padding-top',
  'padding-left',
] as const;

let app: DemoApp;

test.beforeAll(async () => {
  app = await startDemoApp();
});

test.afterAll(async () => {
  await app?.stop();
});

test('Codebase Memory tool view matches the prototype (tokens, boxes ±2 px, copy)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototype(protoPage, { simulateIncoming: false });
  await protoPage.getByText('Codebase Memory', { exact: true }).first().click();
  await protoPage.getByText('localhost:13000 is not reachable', { exact: true }).waitFor();
  await openApp(appPage, app.baseUrl, '/tools/cm');
  await appPage.getByText('localhost:13000 is not reachable', { exact: true }).waitFor();
  await appPage.getByText('Reindex 3 now', { exact: true }).waitFor();

  const paths = Object.fromEntries(Object.entries(PARTS).map(([name, part]) => [name, part.path]));
  const proto = await measure(protoPage, paths);
  const view = await measure(appPage, paths);
  const failures: string[] = [];
  const rows: string[] = [];

  for (const [name, spec] of Object.entries(PARTS)) {
    const p = proto[name];
    const a = view[name];
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
    for (const prop of COMPARED_STYLES) {
      if (p.style[prop] !== a.style[prop]) styleIssues.push(`${name}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
    }
    failures.push(...styleIssues);
    rows.push(`| ${name} | ${spec.geometry} | ${fmtBox(p)} | ${fmtBox(a)} | ${boxIssues.length || styleIssues.length ? 'FAIL' : 'ok'} | ${copyNote} |`);
  }

  // SPEC token checks on the app: surfaces, borders, text, status colors.
  const computed = await appPage.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const statusFail = (() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--status-fail)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    })();
    return {
      frameBg: style('.sb-tool-frame').backgroundColor,
      urlBg: style('.sb-tool-url').backgroundColor,
      urlFont: `${style('.sb-tool-url').fontWeight} ${style('.sb-tool-url').fontSize} ${style('.sb-tool-url').fontFamily}`,
      toolbarBorder: style('.sb-tool-bar').borderBottomColor,
      cardBg: style('.sb-tool-overlay-card').backgroundColor,
      cardBorder: style('.sb-tool-overlay-card').borderTopColor,
      cardRadius: style('.sb-tool-overlay-card').borderRadius,
      primaryBg: style('.sb-tool-overlay-button').backgroundColor,
      primaryFg: style('.sb-tool-overlay-button').color,
      stripBorder: style('.sb-cm-strip').borderTopColor,
      offlineIsFail: style('.sb-tool-url-state').color === statusFail && style('.sb-tool-bar-dot').backgroundColor === statusFail,
      noIframeWhileDown: document.querySelector('.sb-tool-frame iframe') === null,
    };
  });
  const expected: Record<string, string | boolean> = {
    frameBg: hexToRgb('#0c0d0f'),
    urlBg: hexToRgb('#0c0d0f'),
    urlFont: '400 12px "Geist Mono", monospace',
    toolbarBorder: hexToRgb('#232428'),
    cardBg: hexToRgb('#16171a'),
    cardBorder: hexToRgb('#26272c'),
    cardRadius: '12px',
    primaryBg: hexToRgb('#e8e7e3'),
    primaryFg: hexToRgb('#111214'),
    stripBorder: hexToRgb('#232428'),
    offlineIsFail: true,
    noIframeWhileDown: true,
  };
  const computedRows: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = computed[key as keyof typeof computed];
    if (got !== want) failures.push(`computed ${key}: expected ${String(want)}, got ${String(got)}`);
    computedRows.push(`| ${key} | ${String(want)} | ${String(got)} | ${got === want ? 'ok' : 'FAIL'} |`);
  }

  // Developer ruling 2026-09-28 (sidebar TOOLS rows): each name on one line and never cut; the host cut
  // with … inside its row; the sidebar never scrolls sideways.
  const sidebarRuling = await appPage.evaluate(() =>
    [...document.querySelectorAll('.sb-tool')].map((row) => {
      const name = row.querySelector('.sb-tool-name')!;
      const host = row.querySelector('.sb-tool-host')!;
      const rowBox = row.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      return {
        nameOneLine: name.getClientRects().length === 1 && name.getBoundingClientRect().height < parseFloat(getComputedStyle(name).fontSize) * 1.6,
        nameWhole: name.scrollWidth <= name.clientWidth,
        hostEllipsis: getComputedStyle(host).textOverflow === 'ellipsis',
        hostInRow: hostBox.right <= rowBox.right + 0.5,
        sidebarNoSideScroll: document.querySelector('.sb-sidebar')!.scrollWidth <= document.querySelector('.sb-sidebar')!.clientWidth,
      };
    }),
  );
  for (const [index, row] of sidebarRuling.entries()) {
    for (const [check, ok] of Object.entries(row)) if (!ok) failures.push(`sidebar tool row ${index}: ${check}`);
  }

  // Advisory pixel diff + side-by-side captures (page, and the main area).
  const protoShot = await protoPage.screenshot();
  const appShot = await appPage.screenshot();
  const clip = { x: 256, y: 0, width: 1184, height: 900 };
  const protoMain = await protoPage.screenshot({ clip });
  const appMain = await appPage.screenshot({ clip });
  const full = await pixelDiff(appPage, protoShot, appShot);
  const main = await pixelDiff(appPage, protoMain, appMain);
  await writeReport({
    'tools.md': report({ rows, computedRows, failures, full: full.percent, main: main.percent }),
    'tools-side-by-side.png': await sideBySide(appPage, protoShot, appShot),
    'tools-main-side-by-side.png': await sideBySide(appPage, protoMain, appMain),
  });

  expect(failures).toEqual([]);
});

function fmtBox(part: Part): string {
  const { x, y, width, height } = part.box;
  return `${round(x)},${round(y)} ${round(width)}×${round(height)}`;
}

function report(input: { rows: string[]; computedRows: string[]; failures: string[]; full: number; main: number }): string {
  return `# Visual oracle · Codebase Memory tool (M8.1)

Generated by \`tests/e2e/visual/tools.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`), 1440×900, \`/tools/cm\`.
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, sidebar → Codebase Memory.
Both show the tool unreachable (prototype: its probe of localhost:13000 aborted; app: the demo probe provider answers \`down\`).

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff (advisory, channel threshold 24): full page **${input.full.toFixed(2)}%**, main area (256,0 1184×900) **${input.main.toFixed(2)}%**.

Side by side (prototype left, app right): \`tools-side-by-side.png\`, \`tools-main-side-by-side.png\`.

## Boxes (±2 px), styles and copy
| Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${input.rows.join('\n')}

## Computed styles (SPEC tokens)
| Check | Expected | App | Result |
|---|---|---|---|
${input.computedRows.join('\n')}

## Findings
${input.failures.length ? input.failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}
