import { type Page, expect, test } from '@playwright/test';
import {
  type DemoApp,
  type Geometry,
  type Part,
  canonicalColors,
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
 * Visual oracle for History (M7.4, D10), against the prototype's `vHistory` at
 * 1440×900 (screenshot 08): the header (title, subtitle, search), the eight
 * `HIST` rows of the demo seed (date, name + mode, summary + solutions/branches,
 * outcome in its status color) and one searched state ("speaking"). The demo
 * rows keep the prototype's order (newest first), so rows compare by index.
 */

type PartSpec = { readonly path: readonly number[]; readonly geometry: Geometry; readonly copy: boolean };

/** Child-index paths from the shell grid (harness.measure): `[1]` = main, `[1, 0]` = the view. */
const HEAD: Readonly<Record<string, PartSpec>> = {
  view: { path: [1, 0], geometry: 'box', copy: false },
  head: { path: [1, 0, 0], geometry: 'box', copy: false },
  title: { path: [1, 0, 0, 0], geometry: 'box', copy: true },
  subtitle: { path: [1, 0, 0, 1], geometry: 'box', copy: true },
  search: { path: [1, 0, 0, 2], geometry: 'box', copy: false },
  rows: { path: [1, 0, 1], geometry: 'box', copy: false },
  sideHistory: { path: [0, 2, 4], geometry: 'box', copy: false },
};

/** The parts of row `i`. */
function rowParts(i: number): Record<string, PartSpec> {
  const row = [1, 0, 1, i];
  return {
    [`row${i}`]: { path: row, geometry: 'box', copy: false },
    [`row${i}Date`]: { path: [...row, 0], geometry: 'box', copy: true },
    [`row${i}NameCol`]: { path: [...row, 1], geometry: 'box', copy: false },
    [`row${i}Name`]: { path: [...row, 1, 0], geometry: 'box', copy: true },
    [`row${i}Mode`]: { path: [...row, 1, 1], geometry: 'box', copy: true },
    [`row${i}SumCol`]: { path: [...row, 2], geometry: 'box', copy: false },
    [`row${i}Summary`]: { path: [...row, 2, 0], geometry: 'box', copy: true },
    [`row${i}Sols`]: { path: [...row, 2, 1], geometry: 'box', copy: true },
    [`row${i}Outcome`]: { path: [...row, 3], geometry: 'box', copy: true },
  };
}

const ALL_PARTS: Readonly<Record<string, PartSpec>> = { ...HEAD, ...Object.assign({}, ...Array.from({ length: 8 }, (_, i) => rowParts(i))) };

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

/** The sidebar nav item: compared by box only (its selected style is the shell's, checked in shell.spec). */
const STYLE_EXEMPT = new Set(['sideHistory']);

let app: DemoApp;

test.beforeAll(async () => {
  app = await startDemoApp();
});

test.afterAll(async () => {
  await app?.stop();
});

async function compare(protoPage: Page, appPage: Page, parts: Readonly<Record<string, PartSpec>>, failures: string[], rows: string[]): Promise<void> {
  const paths = Object.fromEntries(Object.entries(parts).map(([name, part]) => [name, part.path]));
  const proto = await measure(protoPage, paths);
  const view = await measure(appPage, paths);
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

test('History matches the prototype (tokens, boxes ±2 px, copy)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototype(protoPage, { simulateIncoming: false });
  await protoPage.getByText('History', { exact: true }).first().click();
  await protoPage.getByText('past sessions · searchable transcripts', { exact: true }).waitFor();
  await openApp(appPage, app.baseUrl, '/history');
  await expect(appPage.getByTestId('view-history')).toHaveAttribute('aria-busy', 'false');
  await expect(appPage.getByTestId('history-row')).toHaveCount(8);

  const failures: string[] = [];
  const rows: string[] = [];
  await compare(protoPage, appPage, ALL_PARTS, failures, rows);

  // SPEC token checks on the app.
  const computed = await appPage.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    return {
      headBorder: style('.sb-hist-head').borderBottomColor,
      searchBg: style('.sb-hist-search').backgroundColor,
      searchBorder: style('.sb-hist-search').borderTopColor,
      searchRadius: style('.sb-hist-search').borderRadius,
      searchWidth: style('.sb-hist-search').width,
      rowGrid: style('.sb-hist-row').gridTemplateColumns,
      rowBorder: style('.sb-hist-row').borderBottomColor,
      date: `${style('.sb-hist-date').fontSize} ${style('.sb-hist-date').fontFamily} ${style('.sb-hist-date').color}`,
      mode: `${style('.sb-hist-mode').fontSize} ${style('.sb-hist-mode').color}`,
      summary: `${style('.sb-hist-summary').fontSize} ${style('.sb-hist-summary').color}`,
      sols: `${style('.sb-hist-sols').fontSize} ${style('.sb-hist-sols').textOverflow} ${style('.sb-hist-sols').whiteSpace}`,
      outcomes: [...document.querySelectorAll('.sb-hist-outcome')].map((el) => getComputedStyle(el).color).join(' '),
    };
  });
  const [need, run, done, fail, idle] = await canonicalColors(appPage, [
    'oklch(0.8 0.14 70)',
    'oklch(0.72 0.12 250)',
    'oklch(0.74 0.13 150)',
    'oklch(0.68 0.17 25)',
    '#5a5955',
  ]);
  void need;
  const expected: Record<string, string> = {
    headBorder: hexToRgb('#232428'),
    searchBg: hexToRgb('#111214'),
    searchBorder: hexToRgb('#2c2d32'),
    searchRadius: '7px',
    searchWidth: '320px',
    rowGrid: '110px 220px 562px 200px',
    rowBorder: hexToRgb('#1f2024'),
    date: `11.5px "Geist Mono", monospace ${hexToRgb('#76756f')}`,
    mode: `11px ${hexToRgb('#6d6c67')}`,
    summary: `13px ${hexToRgb('#d9d8d3')}`,
    sols: '11px ellipsis nowrap',
    // HIST statuses: done, done, done, run, done, fail, done, idle.
    outcomes: [done, done, done, run, done, fail, done, idle].join(' '),
  };
  const computedRows: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = computed[key as keyof typeof computed];
    if (got !== want) failures.push(`computed ${key}: expected ${want}, got ${got}`);
    computedRows.push(`| ${key} | ${want} | ${got} | ${got === want ? 'ok' : 'FAIL'} |`);
  }

  const clip = { x: 256, y: 0, width: 1184, height: 900 };
  const protoShot = await protoPage.screenshot();
  const appShot = await appPage.screenshot();
  const protoMain = await protoPage.screenshot({ clip });
  const appMain = await appPage.screenshot({ clip });
  const full = await pixelDiff(appPage, protoShot, appShot);
  const main = await pixelDiff(appPage, protoMain, appMain);

  // One searched state: "speaking" keeps two rows in both.
  await protoPage.locator('input[placeholder="Search conversations, solutions, branches…"]').fill('speaking');
  await appPage.getByTestId('history-search').fill('speaking');
  await expect(appPage.getByTestId('history-row')).toHaveCount(2);
  await expect(appPage.getByTestId('view-history')).toHaveAttribute('aria-busy', 'false');
  const searchedRows: string[] = [];
  await compare(protoPage, appPage, { ...rowParts(0), ...rowParts(1) }, failures, searchedRows);
  const protoSearched = await protoPage.screenshot({ clip });
  const appSearched = await appPage.screenshot({ clip });
  const searched = await pixelDiff(appPage, protoSearched, appSearched);

  // No match: the prototype's "No sessions match."
  await protoPage.locator('input[placeholder="Search conversations, solutions, branches…"]').fill('zzz nothing');
  await appPage.getByTestId('history-search').fill('zzz nothing');
  await expect(appPage.getByTestId('history-empty')).toBeVisible();
  const emptyRows: string[] = [];
  await compare(protoPage, appPage, { empty: { path: [1, 0, 1, 0], geometry: 'box', copy: true } }, failures, emptyRows);

  await writeReport({
    'history.md': report({ rows, computedRows, searchedRows, emptyRows, failures, full: full.percent, main: main.percent, searched: searched.percent }),
    'history-side-by-side.png': await sideBySide(appPage, protoShot, appShot),
    'history-main-side-by-side.png': await sideBySide(appPage, protoMain, appMain),
    'history-search-side-by-side.png': await sideBySide(appPage, protoSearched, appSearched),
  });

  expect(failures).toEqual([]);
});

function fmtBox(part: Part): string {
  const { x, y, width, height } = part.box;
  return `${round(x)},${round(y)} ${round(width)}×${round(height)}`;
}

function report(input: {
  rows: string[];
  computedRows: string[];
  searchedRows: string[];
  emptyRows: string[];
  failures: string[];
  full: number;
  main: number;
  searched: number;
}): string {
  return `# Visual oracle · History (M7.4)

Generated by \`tests/e2e/visual/history.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`), 1440×900, \`/history\`.
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, sidebar → History.

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff (advisory, channel threshold 24): full page **${input.full.toFixed(2)}%**, main area (256,0 1184×900) **${input.main.toFixed(2)}%**, main area searched ("speaking") **${input.searched.toFixed(2)}%**.

Side by side (prototype left, app right): \`history-side-by-side.png\`, \`history-main-side-by-side.png\`, \`history-search-side-by-side.png\`.

The demo rows are the prototype's \`HIST\` in its order (newest first, the API's order too), so rows are compared by index: box, copy and style of every cell. The date column is formatted from each row's start time in local time (\`MM-DD HH:mm\`); the demo builds those times in local time, so the copy matches in any time zone.

## Boxes (±2 px), styles and copy
| Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${input.rows.join('\n')}

## Searched ("speaking")
| Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${input.searchedRows.join('\n')}

## No match
| Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${input.emptyRows.join('\n')}

## Computed styles (SPEC tokens)
| Check | Expected | App | Result |
|---|---|---|---|
${input.computedRows.join('\n')}

## Findings
${input.failures.length ? input.failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}
