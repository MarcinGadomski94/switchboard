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
 * Visual oracle for the Solutions conflict card (M6.3, D10): the app (demo seed)
 * against the prototype at 1440×900, both with `mobile` selected (the prototype's
 * default selection, whose detail panel opens with the conflict card
 * `sd.warn` + "Move button-rollout to worktree"), plus the row flag and the
 * sidebar's "1 conflict" badge. Gate: boxes ±2 px, exact copy, computed styles
 * equal to the prototype's and to the SPEC tokens. The pixel diff is advisory
 * (`docs/visual/solutions-conflict.md`).
 */

interface PartSpec {
  readonly path: readonly number[];
  readonly geometry: Geometry;
  readonly copy: boolean;
}

const VIEW = [1, 0];
const SCROLL = [...VIEW, 0, 1];
const DETAIL = [...VIEW, 1];
const MOBILE_ROW = [...SCROLL, 6];

function parts(): Record<string, PartSpec> {
  const out: Record<string, PartSpec> = {
    // Sidebar: the Solutions nav item and its badge ("1 conflict").
    navSolutions: { path: [0, 2, 1], geometry: 'box', copy: true },
    navSolutionsBadge: { path: [0, 2, 1, 1], geometry: 'box', copy: true },
    // The mobile row and its flag.
    mobileRow: { path: MOBILE_ROW, geometry: 'box', copy: true },
    mobileName: { path: [...MOBILE_ROW, 0, 1, 0], geometry: 'box', copy: true },
    mobileFlag: { path: [...MOBILE_ROW, 0, 1, 1], geometry: 'box', copy: true },
    // Detail panel of mobile: header, conflict card, then the M6.2 sections pushed down by it.
    detail: { path: DETAIL, geometry: 'box', copy: false },
    detailPath: { path: [...DETAIL, 0, 0], geometry: 'box', copy: true },
    detailName: { path: [...DETAIL, 0, 1], geometry: 'box', copy: true },
    card: { path: [...DETAIL, 1], geometry: 'box', copy: true },
    cardText: { path: [...DETAIL, 1, 0], geometry: 'box', copy: true },
    cardActions: { path: [...DETAIL, 1, 1], geometry: 'box', copy: true },
    cardButton: { path: [...DETAIL, 1, 1, 0], geometry: 'box', copy: true },
    branchesSection: { path: [...DETAIL, 2], geometry: 'box', copy: true },
    branchesLabel: { path: [...DETAIL, 2, 0], geometry: 'box', copy: true },
    ledgerSection: { path: [...DETAIL, 3], geometry: 'box', copy: true },
    artifactsSection: { path: [...DETAIL, 4], geometry: 'box', copy: true },
    freshness: { path: [...DETAIL, 5], geometry: 'box', copy: true },
  };
  for (let i = 1; i <= 3; i++) {
    out[`card${i}`] = { path: [...DETAIL, 2, i], geometry: 'box', copy: true };
    out[`card${i}:worktree`] = { path: [...DETAIL, 2, i, 1], geometry: 'box', copy: true };
    out[`card${i}:owner`] = { path: [...DETAIL, 2, i, 2], geometry: 'box', copy: true };
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

test('Solutions conflict card, row flag and nav badge match the prototype (tokens, boxes ±2 px, copy)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototype(protoPage, { simulateIncoming: false });
  await protoPage.getByText('Solutions', { exact: true }).first().click();
  await protoPage.getByText('Branches & worktrees', { exact: true }).waitFor();
  await openApp(appPage, app.baseUrl, '/solutions');
  await appPage.getByTestId('solution-row').first().waitFor();
  await selectRow(protoPage, 'mobile');
  await selectRow(appPage, 'mobile');
  await expect(appPage.getByTestId('conflict-card')).toBeVisible();
  await expect(appPage.getByTestId('nav-solutions').locator('.sb-badge')).toHaveText('1 conflict');
  await expect(protoPage.getByText('Move button-rollout to worktree', { exact: true })).toBeVisible();

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
    rows.push(`| ${name} | ${part.geometry} | ${fmtBox(p)} | ${fmtBox(a)} | ${ok ? 'ok' : 'FAIL'} | ${part.copy ? JSON.stringify(a.text).slice(0, 90) : ''} |`);
  }

  // SPEC tokens as computed styles of the app: question-card colors, card radius, primary button, strong text.
  const computed = await appPage.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const card = style('.sb-sol-conflict');
    const text = style('.sb-sol-conflict-text');
    const button = style('.sb-sol-move');
    const badge = style('[data-testid="nav-solutions"] .sb-badge');
    const flag = style('.sb-sol-row[data-solution="mobile"] .sb-sol-flag');
    return {
      cardBorder: `${card.borderTopWidth} ${card.borderTopStyle} ${card.borderTopColor}`,
      cardBg: card.backgroundColor,
      cardRadius: card.borderTopLeftRadius,
      cardPadding: `${card.paddingTop} ${card.paddingLeft}`,
      cardGap: card.rowGap,
      textFont: `${text.fontSize} ${text.lineHeight}`,
      textColor: text.color,
      buttonBg: button.backgroundColor,
      buttonFg: button.color,
      buttonRadius: button.borderTopLeftRadius,
      buttonFont: `${button.fontWeight} ${button.fontSize}`,
      buttonPadding: `${button.paddingTop} ${button.paddingLeft}`,
      buttonCursor: button.cursor,
      badgeColor: badge.color,
      badgeBg: badge.backgroundColor,
      flagColor: flag.color,
      flagFont: `${flag.fontSize} ${flag.fontFamily}`,
    };
  });
  const [questionBorder, questionBg, needColor] = await canonicalColors(appPage, ['oklch(0.5 0.09 70)', 'oklch(0.2 0.025 70)', 'oklch(0.8 0.14 70)']);
  const expected: Record<string, string> = {
    cardBorder: `1px solid ${questionBorder ?? ''}`,
    cardBg: questionBg ?? '',
    cardRadius: '10px',
    cardPadding: '12px 14px',
    cardGap: '9px',
    textFont: '13px 18.85px',
    textColor: hexToRgb('#f0efeb'),
    buttonBg: hexToRgb('#e8e7e3'),
    buttonFg: hexToRgb('#111214'),
    buttonRadius: '6px',
    buttonFont: '500 12px',
    buttonPadding: '5px 10px',
    buttonCursor: 'pointer',
    badgeColor: needColor ?? '',
    badgeBg: 'rgba(0, 0, 0, 0)',
    flagColor: needColor ?? '',
    flagFont: '10.5px "Geist Mono", monospace',
  };
  const computedRows: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = computed[key as keyof typeof computed];
    if (got !== want) failures.push(`computed ${key}: expected ${want}, got ${got}`);
    computedRows.push(`| ${key} | ${want} | ${got} | ${got === want ? 'ok' : 'FAIL'} |`);
  }

  // Advisory pixel diff + side-by-side captures (the Solutions view, then the whole page).
  const clip = { x: 256, y: 0, width: 1184, height: 900 };
  const protoMain = await protoPage.screenshot({ clip });
  const appMain = await appPage.screenshot({ clip });
  const protoFull = await protoPage.screenshot();
  const appFull = await appPage.screenshot();
  const mainDiff = await pixelDiff(appPage, protoMain, appMain);
  const fullDiff = await pixelDiff(appPage, protoFull, appFull);
  await writeReport({
    'solutions-conflict.md': report({ rows, computedRows, failures, main: mainDiff.percent, full: fullDiff.percent }),
    'solutions-conflict-side-by-side.png': await sideBySide(appPage, protoMain, appMain),
    'solutions-conflict-page-side-by-side.png': await sideBySide(appPage, protoFull, appFull),
  });

  expect(failures).toEqual([]);
});

function fmtBox(part: Part): string {
  const { x, y, width, height } = part.box;
  return `${round(x)},${round(y)} ${round(width)}×${round(height)}`;
}

function report(input: { rows: string[]; computedRows: string[]; failures: string[]; main: number; full: number }): string {
  return `# Visual oracle · Solutions conflict card (M6.3)

Generated by \`tests/e2e/visual/solutions-conflict.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`), 1440×900, \`/solutions\`, \`mobile\` selected.
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, Solutions view, \`mobile\` selected (its default), conflict not fixed.

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff (advisory, channel threshold 24): Solutions view (256,0 1184×900) **${input.main.toFixed(2)}%**, full page **${input.full.toFixed(2)}%**.
Known data differences: the header meta (see \`solutions.md\`) and the sidebar's other badges, rows and footer (other lanes' routes still answer 501 in this lane).

Side by side (prototype left, app right): \`solutions-conflict-side-by-side.png\` (view), \`solutions-conflict-page-side-by-side.png\` (page).

## Boxes (±2 px), copy and computed styles
Geometry: \`box\` = x, y, width, height. Styles compared: ${COMPARED_STYLES.join(', ')}.

| Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${input.rows.join('\n')}

## SPEC tokens (computed)
| Check | Expected | App | Result |
|---|---|---|---|
${input.computedRows.join('\n')}

## Findings
${input.failures.length ? input.failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}
