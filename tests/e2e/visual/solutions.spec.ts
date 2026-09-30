import { expect, type Page, test } from '@playwright/test';
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
 * Visual oracle for the Solutions view (M6.2, D10): the app (demo seed) against
 * the prototype at 1440×900, both with `acme-app-front` selected (the prototype
 * opens on `mobile`, whose conflict card is M6.3). Gate: boxes ±2 px, exact copy,
 * computed styles equal to the prototype's and to the SPEC tokens. The pixel
 * diff is advisory (`docs/visual/solutions.md`).
 */

/** A measured part: child-index path from the shell grid (harness.measure). */
interface PartSpec {
  readonly path: readonly number[];
  readonly geometry: Geometry;
  readonly copy: boolean;
}

const VIEW = [1, 0];
const LIST = [...VIEW, 0];
const HEAD = [...LIST, 0];
const SCROLL = [...LIST, 1];
const DETAIL = [...VIEW, 1];

/** Children of the scroll list: group headers and rows, as the demo data orders them. */
const GROUP_HEADERS: Readonly<Record<string, number>> = { microfrontends: 0, mobile: 5, nugets: 7, microservices: 10, functions: 13, readOnly: 15 };
const ROWS: Readonly<Record<string, number>> = {
  'acme-app-front': 1,
  'workspace-front': 2,
  'auth-front': 3,
  'learning-material-front': 4,
  mobile: 6,
  'components-library-nuget': 8,
  'typography-nuget': 9,
  'notifications-microservice': 11,
  'auth-microservice': 12,
  'calendar-func': 14,
  infrastructure: 16,
  'old-chat-front': 17,
};

function parts(): Record<string, PartSpec> {
  const out: Record<string, PartSpec> = {
    view: { path: VIEW, geometry: 'box', copy: false },
    list: { path: LIST, geometry: 'box', copy: false },
    head: { path: HEAD, geometry: 'box', copy: false },
    title: { path: [...HEAD, 0, 0], geometry: 'box', copy: true },
    // "D:\acme · 18 solutions · 7 active": the prototype hard-codes counts its own 12 rows do not add up to.
    headerMeta: { path: [...HEAD, 0, 1], geometry: 'none', copy: false },
    pills: { path: [...HEAD, 1], geometry: 'box', copy: true },
    scroll: { path: SCROLL, geometry: 'box', copy: false },
    detail: { path: DETAIL, geometry: 'box', copy: false },
    detailPath: { path: [...DETAIL, 0, 0], geometry: 'box', copy: true },
    detailName: { path: [...DETAIL, 0, 1], geometry: 'box', copy: true },
    branchesSection: { path: [...DETAIL, 1], geometry: 'box', copy: true },
    branchesLabel: { path: [...DETAIL, 1, 0], geometry: 'box', copy: true },
    ledgerSection: { path: [...DETAIL, 2], geometry: 'box', copy: true },
    ledgerLabel: { path: [...DETAIL, 2, 0], geometry: 'box', copy: true },
    artifactsSection: { path: [...DETAIL, 3], geometry: 'box', copy: true },
    artifactsLabel: { path: [...DETAIL, 3, 0], geometry: 'box', copy: true },
    freshness: { path: [...DETAIL, 4], geometry: 'box', copy: true },
    freshnessDot: { path: [...DETAIL, 4, 0], geometry: 'box', copy: false },
    freshnessText: { path: [...DETAIL, 4, 1], geometry: 'box', copy: true },
    freshnessLink: { path: [...DETAIL, 4, 2], geometry: 'box', copy: true },
  };
  for (let i = 0; i < 6; i++) out[`pill${i}`] = { path: [...HEAD, 1, i], geometry: 'box', copy: true };
  for (const [name, index] of Object.entries(GROUP_HEADERS)) {
    out[`group:${name}`] = { path: [...SCROLL, index], geometry: 'box', copy: true };
    out[`group:${name}:note`] = { path: [...SCROLL, index, 1], geometry: 'box', copy: true };
  }
  for (const [name, index] of Object.entries(ROWS)) {
    const row = [...SCROLL, index];
    out[`row:${name}`] = { path: row, geometry: 'box', copy: true };
    out[`row:${name}:dot`] = { path: [...row, 0, 0], geometry: 'box', copy: false };
    out[`row:${name}:name`] = { path: [...row, 0, 1, 0], geometry: 'box', copy: true };
    out[`row:${name}:chips`] = { path: [...row, 1], geometry: 'box', copy: true };
    out[`row:${name}:chip0`] = { path: [...row, 1, 0], geometry: 'box', copy: true };
    out[`row:${name}:chip0:branch`] = { path: [...row, 1, 0, 0], geometry: 'box', copy: true };
    out[`row:${name}:chip0:who`] = { path: [...row, 1, 0, 3], geometry: 'box', copy: true };
    out[`row:${name}:phase`] = { path: [...row, 2], geometry: 'box', copy: true };
    out[`row:${name}:changes`] = { path: [...row, 3], geometry: 'box', copy: true };
  }
  out['row:mobile:flag'] = { path: [...SCROLL, ROWS['mobile'] as number, 0, 1, 1], geometry: 'box', copy: true };
  out['row:notifications-microservice:flag'] = { path: [...SCROLL, ROWS['notifications-microservice'] as number, 0, 1, 1], geometry: 'box', copy: true };
  for (let i = 1; i <= 3; i++) {
    out[`card${i}`] = { path: [...DETAIL, 1, i], geometry: 'box', copy: true };
    out[`card${i}:branch`] = { path: [...DETAIL, 1, i, 0], geometry: 'box', copy: true };
    out[`card${i}:worktree`] = { path: [...DETAIL, 1, i, 1], geometry: 'box', copy: true };
    out[`card${i}:owner`] = { path: [...DETAIL, 1, i, 2], geometry: 'box', copy: true };
  }
  for (let i = 1; i <= 2; i++) {
    out[`ledger${i}`] = { path: [...DETAIL, 2, i], geometry: 'box', copy: true };
    out[`ledger${i}:interface`] = { path: [...DETAIL, 2, i, 0], geometry: 'box', copy: true };
    out[`ledger${i}:phase`] = { path: [...DETAIL, 2, i, 1], geometry: 'box', copy: true };
    out[`ledger${i}:seam`] = { path: [...DETAIL, 2, i, 2], geometry: 'box', copy: true };
    out[`artifact${i}`] = { path: [...DETAIL, 3, i], geometry: 'box', copy: true };
    out[`artifact${i}:tag`] = { path: [...DETAIL, 3, i, 0], geometry: 'box', copy: true };
    out[`artifact${i}:name`] = { path: [...DETAIL, 3, i, 1], geometry: 'box', copy: true };
    out[`artifact${i}:meta`] = { path: [...DETAIL, 3, i, 2], geometry: 'box', copy: true };
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
  'border-right-color',
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

/** Selects a solution row by its name (both pages render the name in the row). */
async function selectRow(page: Page, name: string): Promise<void> {
  const grid = page.locator('div[style*="minmax(130px, 190px)"], .sb-sol-row');
  await grid.filter({ hasText: new RegExp(`^${name}`) }).first().click();
}

/** The scroll list's entries (group folder or row name), read through the shared child-index path. */
async function listNames(page: Page): Promise<string[]> {
  return page.evaluate((scrollPath) => {
    const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
      const style = getComputedStyle(el);
      return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
    });
    let scroll: Element | undefined = grid;
    for (const index of scrollPath) scroll = scroll?.children[index];
    return [...(scroll?.children ?? [])].map((child) =>
      child.children.length === 4
        ? (child.children[0]?.children[1]?.children[0]?.textContent ?? '').trim()
        : (child.children[0]?.textContent ?? '').trim(),
    );
  }, SCROLL);
}

async function openPrototypeSolutions(page: Page): Promise<void> {
  await openPrototype(page, { simulateIncoming: false });
  await page.getByText('Solutions', { exact: true }).first().click();
  await page.getByText('Branches & worktrees', { exact: true }).waitFor();
}

test('Solutions view matches the prototype (tokens, boxes ±2 px, copy)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototypeSolutions(protoPage);
  await openApp(appPage, app.baseUrl, '/solutions');
  await appPage.getByTestId('solution-row').first().waitFor();
  await selectRow(protoPage, 'acme-app-front');
  await selectRow(appPage, 'acme-app-front');
  await expect(appPage.getByTestId('solution-detail')).toHaveAttribute('data-solution', 'acme-app-front');
  await expect(protoPage.getByText('D:\\acme\\microfrontends\\acme-app-front', { exact: true })).toBeVisible();

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
    rows.push(`| ${name} | ${part.geometry} | ${fmtBox(p)} | ${fmtBox(a)} | ${ok ? 'ok' : 'FAIL'} | ${part.copy ? JSON.stringify(a.text).slice(0, 70) : ''} |`);
  }

  // SPEC tokens as computed styles of the app.
  const computed = await appPage.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const row = style('.sb-sol-row[data-selected]');
    const readOnly = style('.sb-sol-row[data-readonly]');
    const chipBranch = style('.sb-sol-chip-branch');
    const chip = style('.sb-sol-chip');
    const label = style('.sb-sol-label');
    const card = style('.sb-sol-card');
    const pill = style('.sb-sol-pill[aria-pressed="true"]');
    const pillOff = style('.sb-sol-pill[aria-pressed="false"]');
    const title = style('.sb-sol-title');
    const path = style('.sb-sol-detail-path');
    const view = style('.sb-solutions');
    const list = style('.sb-sol-list');
    return {
      viewColumns: view.gridTemplateColumns,
      listBorder: `${list.borderRightWidth} ${list.borderRightColor}`,
      selectedRowBg: row.backgroundColor,
      readOnlyOpacity: readOnly.opacity,
      chipBranchColor: chipBranch.color,
      chipFont: `${chip.fontSize} ${chip.fontFamily}`,
      chipBorder: chip.borderTopColor,
      labelFont: `${label.fontWeight} ${label.fontSize} ${label.fontFamily}`,
      labelTransform: label.textTransform,
      labelSpacing: label.letterSpacing,
      labelColor: label.color,
      cardBg: card.backgroundColor,
      cardBorder: card.borderTopColor,
      cardRadius: card.borderTopLeftRadius,
      pillOnBg: pill.backgroundColor,
      pillOnFg: pill.color,
      pillOffBg: pillOff.backgroundColor,
      titleFont: `${title.fontWeight} ${title.fontSize}`,
      pathFont: `${path.fontSize} ${path.fontFamily}`,
    };
  });
  const [branchChip, needColor, doneColor, runColor] = await canonicalColors(appPage, [
    'oklch(0.78 0.1 250)',
    'oklch(0.8 0.14 70)',
    'oklch(0.74 0.13 150)',
    'oklch(0.72 0.12 250)',
  ]);
  const protoColumns = await protoPage.evaluate(() => {
    const grid = [...document.querySelectorAll<HTMLElement>('div')].find((el) => getComputedStyle(el).gridTemplateColumns.endsWith(' 340px'));
    return grid ? getComputedStyle(grid).gridTemplateColumns : '';
  });
  const expected: Record<string, string> = {
    viewColumns: protoColumns,
    listBorder: `1px ${hexToRgb('#232428')}`,
    selectedRowBg: hexToRgb('#1f2024'),
    readOnlyOpacity: '0.6',
    chipBranchColor: branchChip ?? '',
    chipFont: '11px "Geist Mono", monospace',
    chipBorder: hexToRgb('#26272c'),
    labelFont: '500 10.5px "Geist Mono", monospace',
    labelTransform: 'uppercase',
    labelSpacing: '0.63px',
    labelColor: hexToRgb('#8d8c87'),
    cardBg: hexToRgb('#17181b'),
    cardBorder: hexToRgb('#26272c'),
    cardRadius: '8px',
    pillOnBg: hexToRgb('#e8e7e3'),
    pillOnFg: hexToRgb('#111214'),
    pillOffBg: hexToRgb('#1f2024'),
    titleFont: '600 18px',
    pathFont: '11.5px "Geist Mono", monospace',
  };
  const computedRows: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = computed[key as keyof typeof computed];
    if (got !== want) failures.push(`computed ${key}: expected ${want}, got ${got}`);
    computedRows.push(`| ${key} | ${want} | ${got} | ${got === want ? 'ok' : 'FAIL'} |`);
  }
  const dots = await appPage.evaluate(() => ({
    acme: getComputedStyle(document.querySelector('.sb-sol-row[data-solution="acme-app-front"] .sb-sol-dot')!).backgroundColor,
    notifications: getComputedStyle(document.querySelector('.sb-sol-row[data-solution="notifications-microservice"] .sb-sol-dot')!).backgroundColor,
    calendar: getComputedStyle(document.querySelector('.sb-sol-row[data-solution="calendar-func"] .sb-sol-dot')!).backgroundColor,
    mobileFlag: getComputedStyle(document.querySelector('.sb-sol-row[data-solution="mobile"] .sb-sol-flag')!).color,
    ledgerUiFirst: getComputedStyle(document.querySelector('[data-testid="ledger-row"] span:nth-child(2)')!).color,
  }));
  const dotExpect: Record<string, string> = {
    acme: needColor ?? '',
    notifications: doneColor ?? '',
    calendar: runColor ?? '',
    mobileFlag: needColor ?? '',
    ledgerUiFirst: needColor ?? '',
  };
  for (const [key, want] of Object.entries(dotExpect)) {
    const got = dots[key as keyof typeof dots];
    if (got !== want) failures.push(`status color ${key}: expected ${want}, got ${got}`);
    computedRows.push(`| status color ${key} | ${want} | ${got} | ${got === want ? 'ok' : 'FAIL'} |`);
  }

  // Filter pills: the same rows under each pill on both pages.
  const filterRows: string[] = [];
  for (const pill of ['Web', 'Mobile', 'NuGet', 'Backend', 'Read-only', 'All']) {
    await protoPage.locator('span', { hasText: new RegExp(`^${pill}$`) }).first().click();
    await appPage.getByTestId(`solutions-filter-${pill}`).click();
    const protoNames = await listNames(protoPage);
    const appNames = await listNames(appPage);
    if (JSON.stringify(protoNames) !== JSON.stringify(appNames)) failures.push(`filter ${pill}: prototype ${protoNames.join(',')} vs app ${appNames.join(',')}`);
    filterRows.push(`| ${pill} | ${appNames.join(', ')} | ${JSON.stringify(protoNames) === JSON.stringify(appNames) ? 'ok' : 'FAIL'} |`);
  }

  // Advisory pixel diff + side-by-side captures (the Solutions view, then the whole page).
  await selectRow(protoPage, 'acme-app-front');
  const clip = { x: 256, y: 0, width: 1184, height: 900 };
  const protoMain = await protoPage.screenshot({ clip });
  const appMain = await appPage.screenshot({ clip });
  const protoFull = await protoPage.screenshot();
  const appFull = await appPage.screenshot();
  const mainDiff = await pixelDiff(appPage, protoMain, appMain);
  const fullDiff = await pixelDiff(appPage, protoFull, appFull);
  await writeReport({
    'solutions.md': report({ rows, computedRows, filterRows, failures, main: mainDiff.percent, full: fullDiff.percent }),
    'solutions-side-by-side.png': await sideBySide(appPage, protoMain, appMain),
    'solutions-page-side-by-side.png': await sideBySide(appPage, protoFull, appFull),
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
  filterRows: string[];
  failures: string[];
  main: number;
  full: number;
}): string {
  return `# Visual oracle · Solutions (M6.2)

Generated by \`tests/e2e/visual/solutions.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`), 1440×900, \`/solutions\`, \`acme-app-front\` selected.
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, Solutions view, \`acme-app-front\` selected (it opens on \`mobile\`, whose conflict card is M6.3).

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff (advisory, channel threshold 24): Solutions view (256,0 1184×900) **${input.main.toFixed(2)}%**, full page **${input.full.toFixed(2)}%**.
Known data differences: the header meta (the prototype hard-codes "18 solutions · 7 active" while its own list has 12 rows, 6 of them not idle; the app counts its rows: "12 solutions · 6 active"), and the sidebar (other lanes' routes still answer 501 in this lane).

Side by side (prototype left, app right): \`solutions-side-by-side.png\` (view), \`solutions-page-side-by-side.png\` (page).

## Boxes (±2 px), copy and computed styles
Geometry: \`box\` = x, y, width, height · \`none\` = styles only (the text is data). Styles compared: ${COMPARED_STYLES.join(', ')}.

| Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${input.rows.join('\n')}

## SPEC tokens (computed)
| Check | Expected | App | Result |
|---|---|---|---|
${input.computedRows.join('\n')}

## Filter pills (rows shown, same on both pages)
| Pill | Rows | Result |
|---|---|---|
${input.filterRows.join('\n')}

## Findings
${input.failures.length ? input.failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}
