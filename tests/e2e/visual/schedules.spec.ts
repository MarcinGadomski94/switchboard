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
 * Visual oracle for the Schedules & loops header and schedule table (M7.1, D10):
 * the app (demo seed: the prototype's four schedules with their 14 runs) against
 * the prototype at 1440×900. Gate: boxes ±2 px, exact copy (except the data the
 * clock decides: the Next column and the failed run's age), computed styles equal
 * to the prototype's and to the SPEC tokens. The loop cards below the table are
 * M7.2's. The pixel diff is advisory (`docs/visual/schedules.md`).
 */

interface PartSpec {
  readonly path: readonly number[];
  readonly geometry: Geometry;
  readonly copy: boolean;
}

const VIEW = [1, 0];
const HEAD = [...VIEW, 0];
const TABLE = [...VIEW, 1];
const ROWS = ['nightly-build-verify', 'codebase-memory-reindex', 'standup-digest', 'dependency-audit'] as const;

function parts(): Record<string, PartSpec> {
  const out: Record<string, PartSpec> = {
    head: { path: HEAD, geometry: 'box', copy: false },
    title: { path: [...HEAD, 0], geometry: 'box', copy: true },
    sub: { path: [...HEAD, 1], geometry: 'box', copy: true },
    newRun: { path: [...HEAD, 2], geometry: 'box', copy: true },
    tableHead: { path: [...TABLE, 0], geometry: 'box', copy: true },
  };
  for (let i = 1; i <= 4; i++) out[`label${i}`] = { path: [...TABLE, 0, i], geometry: 'box', copy: true };
  for (const [index, name] of ROWS.entries()) {
    const row = [...TABLE, index + 1];
    out[`${name}`] = { path: row, geometry: 'box', copy: false };
    out[`${name}:dot`] = { path: [...row, 0], geometry: 'box', copy: false };
    out[`${name}:names`] = { path: [...row, 1], geometry: 'box', copy: true };
    out[`${name}:name`] = { path: [...row, 1, 0], geometry: 'box', copy: true };
    out[`${name}:desc`] = { path: [...row, 1, 1], geometry: 'box', copy: true };
    out[`${name}:cron`] = { path: [...row, 2], geometry: 'box', copy: true };
    out[`${name}:runs`] = { path: [...row, 3], geometry: 'box', copy: false };
    out[`${name}:strip`] = { path: [...row, 3, 0], geometry: 'box', copy: false };
    out[`${name}:last`] = { path: [...row, 3, 1], geometry: 'box', copy: name !== 'nightly-build-verify' };
    // The Next column is computed from the real clock (the prototype's "in 23h 22m" is mock data).
    out[`${name}:next`] = { path: [...row, 4], geometry: 'box', copy: false };
    out[`${name}:actions`] = { path: [...row, 5], geometry: 'box', copy: true };
    out[`${name}:run`] = { path: [...row, 5, 0], geometry: 'box', copy: true };
    out[`${name}:pause`] = { path: [...row, 5, 1], geometry: 'box', copy: true };
    for (const cell of [0, 4, 12, 13]) out[`${name}:cell${cell}`] = { path: [...row, 3, 0, cell], geometry: 'box', copy: false };
  }
  return out;
}

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

let app: DemoApp;

test.beforeAll(async () => {
  app = await startDemoApp();
});

test.afterAll(async () => {
  await app?.stop();
});

async function openPrototypeSchedules(page: Page): Promise<void> {
  await openPrototype(page, { simulateIncoming: false });
  await page.getByText('Schedules & loops', { exact: true }).first().click();
  await page.getByText('scheduled Claude Code runs + long-running loops', { exact: true }).waitFor();
}

function fmtBox(part: Part): string {
  const { x, y, width, height } = part.box;
  return `${round(x)},${round(y)} ${round(width)}×${round(height)}`;
}

test('Schedules header and table match the prototype (tokens, boxes ±2 px, copy)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototypeSchedules(protoPage);
  await openApp(appPage, app.baseUrl, '/schedules');
  await expect(appPage.getByTestId('schedule-row')).toHaveCount(4);

  const spec = parts();
  const paths = Object.fromEntries(Object.entries(spec).map(([name, part]) => [name, part.path]));
  const proto = await measure(protoPage, paths);
  const shot = await measure(appPage, paths);
  const failures: string[] = [];
  const rows: string[] = [];
  for (const [name, part] of Object.entries(spec)) {
    const p = proto[name];
    const a = shot[name];
    if (!p || !a) {
      failures.push(`${name}: missing (${p ? 'app' : 'prototype'})`);
      continue;
    }
    const boxIssues = compareBoxes(name, p.box, a.box, part.geometry);
    const copyIssues = part.copy && p.text !== a.text ? [`${name}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`] : [];
    const styleIssues = COMPARED_STYLES.filter((prop) => p.style[prop] !== a.style[prop]).map(
      (prop) => `${name}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`,
    );
    failures.push(...boxIssues, ...copyIssues, ...styleIssues);
    const ok = boxIssues.length + copyIssues.length + styleIssues.length === 0;
    rows.push(`| ${name} | ${part.geometry} | ${fmtBox(p)} | ${fmtBox(a)} | ${ok ? 'ok' : 'FAIL'} | ${part.copy ? JSON.stringify(a.text).slice(0, 60) : ''} |`);
  }
  // The failed run's line: the prototype's copy with the age the seed gives it (the run ended 38 minutes before the seed).
  const failedLast = shot['nightly-build-verify:last']?.text ?? '';
  if (!/^Failed 3[89]m ago · Android XamlC$/.test(failedLast)) failures.push(`nightly-build-verify:last.text: ${JSON.stringify(failedLast)} (expected "Failed 38m ago · Android XamlC")`);
  const nextTexts = ROWS.map((name) => shot[`${name}:next`]?.text ?? '');
  for (const [index, text] of nextTexts.entries()) {
    if (!/^(in \d+h( \d+m)?|in \d+m|tomorrow \d\d:\d\d|[A-Z][a-z]{2} \d\d:\d\d|\d+ [A-Z][a-z]{2} \d\d:\d\d)$/.test(text)) failures.push(`${ROWS[index]}:next.text: ${JSON.stringify(text)} is not a Next value`);
  }

  // SPEC tokens as computed styles of the app.
  const computed = await appPage.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const row = style('.sb-sch-row:not(.sb-sch-row--head)');
    const head = style('.sb-sch-row--head');
    const cell = style('.sb-sch-cell');
    const title = style('.sb-sch-title');
    const action = style('.sb-sch-action');
    const view = style('.sb-schedules');
    const newRun = style('.sb-sch-new');
    return {
      rowBorder: `${row.borderBottomWidth} ${row.borderBottomColor}`,
      rowGap: row.columnGap,
      headFont: `${head.fontWeight} ${head.fontSize} ${head.fontFamily}`,
      headTransform: head.textTransform,
      headSpacing: head.letterSpacing,
      headColor: head.color,
      headBorder: `${head.borderBottomWidth} ${head.borderBottomColor}`,
      cellHeight: cell.height,
      cellRadius: cell.borderTopLeftRadius,
      titleFont: `${title.fontWeight} ${title.fontSize}`,
      actionBorder: `${action.borderTopWidth} ${action.borderTopColor}`,
      actionRadius: action.borderTopLeftRadius,
      viewPadding: `${view.paddingTop} ${view.paddingLeft}`,
      newRunBorder: `${newRun.borderTopStyle} ${newRun.borderTopColor}`,
    };
  });
  const protoColumns = await protoPage.evaluate(() => {
    const grid = [...document.querySelectorAll<HTMLElement>('div')].find((el) => getComputedStyle(el).gridTemplateColumns.startsWith('10px 220px 150px'));
    return grid ? getComputedStyle(grid).gridTemplateColumns : '';
  });
  const appColumns = await appPage.evaluate(() => getComputedStyle(document.querySelector('.sb-sch-row--head')!).gridTemplateColumns);
  const expected: Record<string, string> = {
    rowBorder: `1px ${hexToRgb('#1f2024')}`,
    rowGap: '14px',
    headFont: '500 10.5px "Geist Mono", monospace',
    headTransform: 'uppercase',
    headSpacing: '0.63px',
    headColor: hexToRgb('#6d6c67'),
    headBorder: `1px ${hexToRgb('#232428')}`,
    cellHeight: '14px',
    cellRadius: '2px',
    titleFont: '600 18px',
    actionBorder: `1px ${hexToRgb('#2c2d32')}`,
    actionRadius: '6px',
    viewPadding: '22px 28px',
    newRunBorder: `dashed ${hexToRgb('#3a3b41')}`,
  };
  const computedRows: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = computed[key as keyof typeof computed];
    if (got !== want) failures.push(`computed ${key}: expected ${want}, got ${got}`);
    computedRows.push(`| ${key} | ${want} | ${got} | ${got === want ? 'ok' : 'FAIL'} |`);
  }
  if (protoColumns === '' || protoColumns !== appColumns) failures.push(`grid columns: prototype ${protoColumns} vs app ${appColumns}`);
  computedRows.push(`| grid columns (10px 220px 150px 1fr 150px 180px) | ${protoColumns} | ${appColumns} | ${protoColumns !== '' && protoColumns === appColumns ? 'ok' : 'FAIL'} |`);

  // Status colors: dots and strip cells (prototype letters g/r/a/n → done/fail/need/none).
  const [done, fail, need] = await canonicalColors(appPage, ['oklch(0.74 0.13 150)', 'oklch(0.68 0.17 25)', 'oklch(0.8 0.14 70)']);
  const colors = await appPage.evaluate(() => {
    const bg = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor;
    const cells = (name: string) =>
      [...document.querySelectorAll(`[data-schedule="${name}"] [data-testid="schedule-cell"]`)].map((cell) => getComputedStyle(cell).backgroundColor);
    return {
      nightlyDot: bg('[data-schedule="nightly-build-verify"] [data-testid="schedule-dot"]'),
      reindexDot: bg('[data-schedule="codebase-memory-reindex"] [data-testid="schedule-dot"]'),
      standupDot: bg('[data-schedule="standup-digest"] [data-testid="schedule-dot"]'),
      nightlyCells: cells('nightly-build-verify'),
      standupLast: cells('standup-digest').at(-1) ?? '',
      auditCells: cells('dependency-audit'),
    };
  });
  const none = hexToRgb('#26272c');
  const colorChecks: Array<[string, unknown, unknown]> = [
    ['nightly dot (fail)', colors.nightlyDot, fail],
    ['reindex dot (done)', colors.reindexDot, done],
    ['standup dot (need)', colors.standupDot, need],
    ['nightly strip gggggggggggggr', colors.nightlyCells.join(','), [...Array(13).fill(done), fail].join(',')],
    ['standup last cell (a)', colors.standupLast, need],
    ['dependency-audit strip nnnnggggggnggg', colors.auditCells.join(','), [none, none, none, none, done, done, done, done, done, done, none, done, done, done].join(',')],
  ];
  for (const [label, got, want] of colorChecks) {
    if (got !== want) failures.push(`${label}: expected ${String(want)}, got ${String(got)}`);
    computedRows.push(`| ${label} | ${String(want).slice(0, 40)} | ${String(got).slice(0, 40)} | ${got === want ? 'ok' : 'FAIL'} |`);
  }

  // Advisory pixel diff + side-by-side captures: header + table, then the page.
  const tableBox = shot['dependency-audit']?.box;
  const clip = { x: 256, y: 0, width: 1184, height: Math.ceil((tableBox?.y ?? 400) + (tableBox?.height ?? 60) + 12) };
  const protoMain = await protoPage.screenshot({ clip });
  const appMain = await appPage.screenshot({ clip });
  const protoFull = await protoPage.screenshot();
  const appFull = await appPage.screenshot();
  const mainDiff = await pixelDiff(appPage, protoMain, appMain);
  const fullDiff = await pixelDiff(appPage, protoFull, appFull);
  await writeReport({
    'schedules.md': report({ rows, computedRows, failures, main: mainDiff.percent, full: fullDiff.percent, next: nextTexts, clipHeight: clip.height }),
    'schedules-side-by-side.png': await sideBySide(appPage, protoMain, appMain),
    'schedules-page-side-by-side.png': await sideBySide(appPage, protoFull, appFull),
  });

  expect(failures).toEqual([]);
});

function report(input: {
  rows: string[];
  computedRows: string[];
  failures: string[];
  main: number;
  full: number;
  next: readonly string[];
  clipHeight: number;
}): string {
  return `# Visual oracle · Schedules & loops: header and schedule table (M7.1)

Generated by \`tests/e2e/visual/schedules.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`: the prototype's four schedules and their 14 runs), 1440×900, \`/schedules\`.
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, Schedules & loops view.

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff (advisory, channel threshold 24): header + table (256,0 1184×${input.clipHeight}) **${input.main.toFixed(2)}%**, full page **${input.full.toFixed(2)}%**.
Known data differences, not findings: the Next column is computed from the real clock and the cron (app: ${input.next.map((n) => `"${n}"`).join(', ')}; the prototype's "in 23h 22m", "in 1h 12m", "tomorrow 08:30", "Mon 07:00" are mock values), the failed run's age follows the seed time (checked as "Failed 38m ago · Android XamlC" ± a minute), the loop cards below the table are M7.2's (another lane), and the sidebar shows other lanes' data where their routes still answer 501 in this lane.

Side by side (prototype left, app right): \`schedules-side-by-side.png\` (header + table), \`schedules-page-side-by-side.png\` (page).

## Boxes (±2 px), copy and computed styles
Geometry: \`box\` = x, y, width, height. Styles compared: ${COMPARED_STYLES.join(', ')}.

| Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${input.rows.join('\n')}

## SPEC tokens and status colors (computed)
| Check | Expected | App | Result |
|---|---|---|---|
${input.computedRows.join('\n')}

## Findings
${input.failures.length ? input.failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}
