import { type Page, expect, test } from '@playwright/test';
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
 * Visual oracle for the global Artifacts view (M7.3, D10), against the
 * prototype's `vArtifacts` at 1440×900 (screenshot 07). D89 (developer request
 * 2026-10-09; `docs/visual/README.md` → *Deliberate deviations*): the page lists
 * the artifacts saved on purpose, with its own kind filters and columns, so the
 * filter pills, the column labels and widths and the row copy are no longer the
 * prototype's. What D89 keeps is still compared: the header (title, "13 of 13"
 * with the demo's 13 saved artifacts, search), the filter row's and the column
 * header's boxes, the rows' area and the 13 row boxes (by index, equal heights),
 * the styles of the head, search, pills, column header, rows and kind tag, and
 * the new grid. Documented in `docs/visual/artifacts.md`.
 */

/** Child-index paths from the shell grid (harness.measure): `[1]` = main, `[1, 0]` = the view. */
const PARTS: Readonly<Record<string, { readonly path: readonly number[]; readonly geometry: Geometry; readonly copy: boolean }>> = {
  view: { path: [1, 0], geometry: 'box', copy: false },
  head: { path: [1, 0, 0], geometry: 'box', copy: false },
  titleRow: { path: [1, 0, 0, 0], geometry: 'box', copy: false },
  title: { path: [1, 0, 0, 0, 0], geometry: 'box', copy: true },
  count: { path: [1, 0, 0, 0, 1], geometry: 'box', copy: true },
  search: { path: [1, 0, 0, 0, 2], geometry: 'box', copy: false },
  filters: { path: [1, 0, 0, 1], geometry: 'box', copy: false },
  // D89: the column labels changed (kind · title · session · versions · saved by · age): the box only.
  cols: { path: [1, 0, 1], geometry: 'box', copy: false },
  rows: { path: [1, 0, 2], geometry: 'box', copy: false },
  row0: { path: [1, 0, 2, 0], geometry: 'box', copy: false },
  ...Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`row${i}Box`, { path: [1, 0, 2, i], geometry: 'box' as Geometry, copy: false }])),
  // D61: the app's nav has MCP after Schedules & loops: this item is one further on and one row lower (compared by size).
  sideArtifacts: { path: [0, 2, 3], geometry: 'size', copy: false },
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
  'text-transform',
  'border-radius',
  'border-top-color',
  'border-top-width',
  'padding-top',
  'padding-left',
] as const;

/** Parts whose styles are not compared (the row name cell inherits a link's color in neither page; see findings). */
const STYLE_EXEMPT = new Set(['sideArtifacts']);

let app: DemoApp;

test.beforeAll(async () => {
  app = await startDemoApp();
});

test.afterAll(async () => {
  await app?.stop();
});

async function compare(protoPage: Page, appPage: Page, parts: typeof PARTS, failures: string[], rows: string[]): Promise<void> {
  const paths = Object.fromEntries(Object.entries(parts).map(([name, part]) => [name, part.path]));
  const proto = await measure(protoPage, paths);
  const view = await measure(appPage, { ...paths, sideArtifacts: [0, 2, 4] });
  for (const [name, spec] of Object.entries(parts)) {
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
    if (!STYLE_EXEMPT.has(name)) {
      for (const prop of COMPARED_STYLES) {
        if (p.style[prop] !== a.style[prop]) styleIssues.push(`${name}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
      }
    }
    failures.push(...styleIssues);
    rows.push(`| ${name} | ${spec.geometry} | ${fmtBox(p)} | ${fmtBox(a)} | ${boxIssues.length || styleIssues.length ? 'FAIL' : 'ok'} | ${copyNote} |`);
  }
}

test('Artifacts view matches the prototype (tokens, boxes ±2 px, copy)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototype(protoPage, { simulateIncoming: false });
  await protoPage.getByText('Artifacts', { exact: true }).first().click();
  await protoPage.getByText('13 of 13', { exact: true }).waitFor();
  await openApp(appPage, app.baseUrl, '/artifacts');
  await appPage.getByText('13 of 13', { exact: true }).waitFor();

  const failures: string[] = [];
  const rows: string[] = [];
  await compare(protoPage, appPage, PARTS, failures, rows);

  // SPEC token checks on the app.
  const computed = await appPage.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    return {
      headBorder: style('.sb-art-head').borderBottomColor,
      searchBg: style('.sb-art-search').backgroundColor,
      searchBorder: style('.sb-art-search').borderTopColor,
      searchRadius: style('.sb-art-search').borderRadius,
      pillSelected: `${style('.sb-art-filter[aria-pressed="true"]').backgroundColor} ${style('.sb-art-filter[aria-pressed="true"]').color}`,
      pill: `${style('.sb-art-filter[aria-pressed="false"]').backgroundColor} ${style('.sb-art-filter[aria-pressed="false"]').color}`,
      colsLabel: `${style('.sb-art-cols').fontWeight} ${style('.sb-art-cols').fontSize} ${style('.sb-art-cols').fontFamily} ${style('.sb-art-cols').textTransform} ${style('.sb-art-cols').color}`,
      colsGrid: style('.sb-art-cols').gridTemplateColumns,
      rowGrid: style('.sb-art-row').gridTemplateColumns,
      rowBorder: style('.sb-art-row').borderBottomColor,
      typeTag: `${style('.sb-art-type').backgroundColor} ${style('.sb-art-type').color} ${style('.sb-art-type').borderRadius}`,
      rowIsLink: document.querySelector('.sb-art-row')?.tagName === 'A',
    };
  });
  const expected: Record<string, string | boolean> = {
    headBorder: hexToRgb('#232428'),
    searchBg: hexToRgb('#111214'),
    searchBorder: hexToRgb('#2c2d32'),
    searchRadius: '7px',
    pillSelected: `${hexToRgb('#e8e7e3')} ${hexToRgb('#111214')}`,
    pill: `${hexToRgb('#1f2024')} ${hexToRgb('#c9c8c3')}`,
    colsLabel: `500 10.5px "Geist Mono", monospace uppercase ${hexToRgb('#6d6c67')}`,
    // D89: kind · title · session · versions · saved by · age.
    colsGrid: '110px 480px 280px 70px 80px 50px',
    rowGrid: '110px 480px 280px 70px 80px 50px',
    rowBorder: hexToRgb('#1f2024'),
    typeTag: `${hexToRgb('#26272c')} ${hexToRgb('#c9c8c3')} 4px`,
    rowIsLink: true,
  };
  const computedRows: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = computed[key as keyof typeof computed];
    if (got !== want) failures.push(`computed ${key}: expected ${String(want)}, got ${String(got)}`);
    computedRows.push(`| ${key} | ${String(want)} | ${String(got)} | ${got === want ? 'ok' : 'FAIL'} |`);
  }

  const clip = { x: 256, y: 0, width: 1184, height: 900 };
  const protoShot = await protoPage.screenshot();
  const appShot = await appPage.screenshot();
  const protoMain = await protoPage.screenshot({ clip });
  const appMain = await appPage.screenshot({ clip });
  const full = await pixelDiff(appPage, protoShot, appShot);
  const main = await pixelDiff(appPage, protoMain, appMain);

  await writeReport({
    'artifacts.md': report({ rows, computedRows, failures, full: full.percent, main: main.percent }),
    'artifacts-side-by-side.png': await sideBySide(appPage, protoShot, appShot),
    'artifacts-main-side-by-side.png': await sideBySide(appPage, protoMain, appMain),
  });

  expect(failures).toEqual([]);
});

function fmtBox(part: Part): string {
  const { x, y, width, height } = part.box;
  return `${round(x)},${round(y)} ${round(width)}×${round(height)}`;
}

function report(input: { rows: string[]; computedRows: string[]; failures: string[]; full: number; main: number }): string {
  return `# Visual oracle · Artifacts (M7.3; D89)

Generated by \`tests/e2e/visual/artifacts.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`), 1440×900, \`/artifacts\`.
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, sidebar → Artifacts.

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff (advisory, channel threshold 24): full page **${input.full.toFixed(2)}%**, main area (256,0 1184×900) **${input.main.toFixed(2)}%**.

Side by side (prototype left, app right): \`artifacts-side-by-side.png\`, \`artifacts-main-side-by-side.png\`.

D89 (developer request 2026-10-09, \`docs/visual/README.md\` → *Deliberate deviations*): the page lists the artifacts saved on purpose (the demo seeds 13, as many per session as the prototype's tabs count). Its kind filters (All · Docs · Code · HTML · Diagrams · Images · Tables + a session filter), its columns (kind · title · session · versions · saved by · age, \`110px 1fr 280px 70px 80px 50px\`) and its rows' copy are its own and are not compared; the header, the filter row's and the column header's boxes, the rows' area and the 13 row boxes, and the styles of the chrome are. The sidebar's Artifacts badge counts the API's rows (13; the prototype hard-codes "14" while showing 13 rows), so its box is compared and its copy is not.

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
