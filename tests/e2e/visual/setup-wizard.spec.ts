import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import {
  type DemoApp,
  type Geometry,
  type Part,
  STYLE_PROPS,
  compareBoxes,
  hexToRgb,
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
 * Visual oracle for the setup wizard (M5.3, D10): the app (demo seed, the wizard
 * opening by itself on a first run) against the prototype's `mWizard`
 * (`showSetupOnLoad`) at 1440×900, on each of the five steps, reached with
 * Continue on both pages. Gate: boxes ±2 px, exact copy, equal computed styles,
 * SPEC tokens; the pixel diff is advisory (`docs/visual/setup-wizard.md`).
 *
 * Known data differences, not findings: step 1's login row (the prototype's
 * "Signed in · Max plan / subscription auth · no API key"; Switchboard reads
 * only the exit code of `claude auth status`, so it names no plan); step 2's
 * path (the prototype's `D:\acme` against a temp folder with a 640-line
 * router AGENTS.md, typed into the app's field); step 3's rows (the demo's
 * workspace scan, i.e. the Solutions view's rows, against the prototype's
 * hard-coded `scan`), compared on the first row only.
 */

interface PartSpec {
  readonly path: readonly number[];
  readonly geometry: Geometry;
  readonly copy: boolean;
}

const RAIL = [0];
const MAIN = [1];

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
  'opacity',
  'cursor',
  'white-space',
] as const;

/** The rail and the fixed parts of the main column; `actions` is the index of the Back / Skip / Continue row. */
function frameParts(actions: number): Record<string, PartSpec> {
  const out: Record<string, PartSpec> = {
    panel: { path: [], geometry: 'box', copy: false },
    rail: { path: RAIL, geometry: 'box', copy: false },
    brand: { path: [...RAIL, 0], geometry: 'box', copy: false },
    logo: { path: [...RAIL, 0, 0], geometry: 'box', copy: true },
    brandName: { path: [...RAIL, 0, 1], geometry: 'box', copy: true },
    note: { path: [...RAIL, 6], geometry: 'box', copy: true },
    main: { path: MAIN, geometry: 'box', copy: false },
    pos: { path: [...MAIN, 0], geometry: 'box', copy: true },
    title: { path: [...MAIN, 1], geometry: 'box', copy: true },
    text: { path: [...MAIN, 2], geometry: 'box', copy: true },
    actions: { path: [...MAIN, actions], geometry: 'box', copy: false },
    back: { path: [...MAIN, actions, 0], geometry: 'box', copy: true },
    skip: { path: [...MAIN, actions, 1], geometry: 'box', copy: true },
    next: { path: [...MAIN, actions, 2], geometry: 'box', copy: true },
  };
  for (let i = 1; i <= 5; i++) {
    out[`step${i}`] = { path: [...RAIL, i], geometry: 'box', copy: true };
    out[`step${i}Dot`] = { path: [...RAIL, i, 0], geometry: 'box', copy: true };
    out[`step${i}Label`] = { path: [...RAIL, i, 1], geometry: 'box', copy: true };
  }
  return out;
}

function checksParts(): Record<string, PartSpec> {
  const out: Record<string, PartSpec> = { checks: { path: [...MAIN, 3], geometry: 'box', copy: false } };
  for (let i = 0; i < 3; i++) {
    // Row 2 (the login) differs in copy (see the header): its box and styles still match.
    const copy = i !== 1;
    out[`check${i + 1}`] = { path: [...MAIN, 3, i], geometry: 'box', copy: false };
    out[`check${i + 1}Mark`] = { path: [...MAIN, 3, i, 0], geometry: 'box', copy: true };
    out[`check${i + 1}Label`] = { path: [...MAIN, 3, i, 1, 0], geometry: copy ? 'box' : 'size', copy };
    out[`check${i + 1}Detail`] = { path: [...MAIN, 3, i, 1, 1], geometry: copy ? 'box' : 'size', copy };
  }
  return out;
}

function rootParts(): Record<string, PartSpec> {
  return {
    rootRow: { path: [...MAIN, 3], geometry: 'box', copy: false },
    rootField: { path: [...MAIN, 3, 0], geometry: 'box', copy: false },
    browse: { path: [...MAIN, 3, 1], geometry: 'box', copy: true },
    rootLine: { path: [...MAIN, 4], geometry: 'box', copy: true },
  };
}

function scanParts(): Record<string, PartSpec> {
  return {
    // The table's height is data (the demo scan has 7 rows, the prototype's mock 8): its first row gives x, y and width.
    scan: { path: [...MAIN, 3], geometry: 'none', copy: false },
    scanRow1: { path: [...MAIN, 3, 0], geometry: 'box', copy: false },
    scanFolder1: { path: [...MAIN, 3, 0, 0], geometry: 'box', copy: true },
    scanCount1: { path: [...MAIN, 3, 0, 1], geometry: 'box', copy: false },
    scanExamples1: { path: [...MAIN, 3, 0, 2], geometry: 'box', copy: false },
    scanRule1: { path: [...MAIN, 3, 0, 3], geometry: 'box', copy: true },
  };
}

function notifyParts(): Record<string, PartSpec> {
  return {
    notify: { path: [...MAIN, 3], geometry: 'box', copy: false },
    allow: { path: [...MAIN, 3, 0], geometry: 'box', copy: true },
    permission: { path: [...MAIN, 3, 1], geometry: 'box', copy: true },
  };
}

function usageParts(): Record<string, PartSpec> {
  return {
    usage: { path: [...MAIN, 3], geometry: 'box', copy: false },
    usageRow: { path: [...MAIN, 3, 0], geometry: 'box', copy: true },
    usageValue: { path: [...MAIN, 3, 0, 0], geometry: 'box', copy: true },
    usageTrack: { path: [...MAIN, 3, 1], geometry: 'box', copy: false },
    usageFill: { path: [...MAIN, 3, 1, 0], geometry: 'box', copy: false },
    usageNote: { path: [...MAIN, 3, 2], geometry: 'box', copy: true },
  };
}

/** Set in the page by {@link installPanelFinder}: the wizard panel (the 960px grid box with the 14px radius). */
declare function findWizardIn(doc: Document): HTMLElement | undefined;

async function installPanelFinder(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { findWizardIn: (doc: Document) => HTMLElement | undefined }).findWizardIn = (doc) =>
      [...doc.querySelectorAll<HTMLElement>('body *')].find((el) => {
        const style = getComputedStyle(el);
        return style.width === '960px' && style.borderTopLeftRadius === '14px' && style.display === 'grid';
      });
  });
}

async function measurePanel(page: Page, paths: Readonly<Record<string, readonly number[]>>): Promise<Record<string, Part | null>> {
  return page.evaluate(
    ({ wanted, props }) => {
      const panel = findWizardIn(document);
      const out: Record<string, { box: { x: number; y: number; width: number; height: number }; text: string; style: Record<string, string> } | null> = {};
      for (const [name, indexes] of Object.entries(wanted)) {
        let el: Element | undefined = panel;
        for (const index of indexes) el = el?.children[index];
        if (!el) {
          out[name] = null;
          continue;
        }
        const rect = el.getBoundingClientRect();
        const computed = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const prop of props) style[prop] = computed.getPropertyValue(prop);
        out[name] = { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, text: (el.textContent ?? '').trim(), style };
      }
      return out;
    },
    { wanted: paths, props: [...new Set<string>([...STYLE_PROPS, ...COMPARED_STYLES])] },
  );
}

function fmtBox(part: Part): string {
  const { x, y, width, height } = part.box;
  return `${round(x)},${round(y)} ${round(width)}×${round(height)}`;
}

async function measureAndCompare(state: string, protoPage: Page, appPage: Page, specs: Record<string, PartSpec>, rows: string[], failures: string[]): Promise<void> {
  const paths = Object.fromEntries(Object.entries(specs).map(([name, part]) => [name, part.path]));
  const proto = await measurePanel(protoPage, paths);
  const app = await measurePanel(appPage, paths);
  for (const [name, spec] of Object.entries(specs)) {
    const label = `${state} · ${name}`;
    const p = proto[name];
    const a = app[name];
    if (!p || !a) {
      failures.push(`${label}: missing (${p ? 'app' : 'prototype'})`);
      continue;
    }
    // The app's field is an <input>: its text cursor is the input's own (the prototype's static box has none), and
    // its Browse… works (a pointer), where the prototype's is inert (no handler, so no pointer).
    const accepted = (name === 'rootField' && a.style['cursor'] === 'text') || (name === 'browse' && a.style['cursor'] === 'pointer');
    const appStyle = accepted ? { ...a.style, cursor: p.style['cursor'] ?? '' } : a.style;
    const boxIssues = compareBoxes(label, p.box, a.box, spec.geometry);
    const copyIssues = spec.copy && p.text !== a.text ? [`${label}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`] : [];
    const styleIssues = COMPARED_STYLES.filter((prop) => p.style[prop] !== appStyle[prop]).map((prop) => `${label}.${prop}: prototype ${p.style[prop]} vs app ${appStyle[prop]}`);
    failures.push(...boxIssues, ...copyIssues, ...styleIssues);
    const ok = boxIssues.length + copyIssues.length + styleIssues.length === 0;
    rows.push(`| ${label} | ${spec.geometry} | ${fmtBox(p)} | ${fmtBox(a)} | ${ok ? 'ok' : 'FAIL'} | ${spec.copy ? JSON.stringify(a.text).slice(0, 70) : ''} |`);
  }
}

/** Clicks the prototype's control with exactly this text. */
async function protoClick(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).first().click();
}

let app: DemoApp;
let tmp: string;
let root: string;

test.beforeAll(async () => {
  tmp = await makeTempDir('visual-setup');
  root = path.join(tmp, 'acme');
  await mkdir(root, { recursive: true });
  // A router AGENTS.md with the prototype's title and line count ("… found · 640 lines").
  const body = Array.from({ length: 639 }, (_, i) => `line ${i + 2}`);
  await writeFile(path.join(root, 'AGENTS.md'), `# AGENTS.md (Workspace Router)\n${body.join('\n')}\n`);
  app = await startDemoApp({ SWITCHBOARD_SETUP_WIZARD: 'auto' });
});

test.afterAll(async () => {
  await app?.stop();
  if (tmp) await removeTempDir(tmp);
});

test('Setup wizard matches the prototype on all five steps (tokens, boxes ±2 px, copy, styles)', async ({ browser }) => {
  test.setTimeout(90_000);
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototype(protoPage, { simulateIncoming: false, showSetupOnLoad: true });
  await protoPage.getByText('Set up Switchboard', { exact: true }).waitFor();
  await installPanelFinder(protoPage);

  await openApp(appPage, app.baseUrl, '/');
  const wizard = appPage.getByTestId('modal-setup-wizard');
  await wizard.getByTestId('wz-check').first().waitFor();
  await installPanelFinder(appPage);

  const rows: string[] = [];
  const failures: string[] = [];

  // Step 1: the checks.
  await measureAndCompare('step 1', protoPage, appPage, { ...frameParts(4), ...checksParts() }, rows, failures);
  const clip = { x: 239, y: 139, width: 962, height: 622 };
  const protoStep1 = await protoPage.screenshot({ clip });
  const appStep1 = await appPage.screenshot({ clip });
  const protoFull = await protoPage.screenshot();
  const appFull = await appPage.screenshot();
  const panelDiff = await pixelDiff(appPage, protoStep1, appStep1);
  const fullDiff = await pixelDiff(appPage, protoFull, appFull);

  // Step 2: the root (typed into the app's field; the prototype shows its own path).
  await protoClick(protoPage, 'Continue');
  await wizard.getByTestId('wz-next').click();
  await wizard.getByTestId('wz-root-input').fill(root);
  await expect(wizard.getByTestId('wz-root-line')).toHaveText('✓ AGENTS.md (Workspace Router) found · 640 lines');
  await measureAndCompare('step 2', protoPage, appPage, { ...frameParts(5), ...rootParts() }, rows, failures);
  const protoStep2 = await protoPage.screenshot({ clip });
  const appStep2 = await appPage.screenshot({ clip });

  // Step 3: the scan (first row compared; the rows are data).
  await protoClick(protoPage, 'Continue');
  await wizard.getByTestId('wz-next').click();
  await wizard.getByTestId('wz-scan-row').first().waitFor();
  await measureAndCompare('step 3', protoPage, appPage, { ...frameParts(4), ...scanParts() }, rows, failures);
  const protoStep3 = await protoPage.screenshot({ clip });
  const appStep3 = await appPage.screenshot({ clip });

  // Step 4: notifications (both pages: permission not asked yet).
  await protoClick(protoPage, 'Continue');
  await wizard.getByTestId('wz-next').click();
  await wizard.getByTestId('wz-permission').waitFor();
  await measureAndCompare('step 4', protoPage, appPage, { ...frameParts(4), ...notifyParts() }, rows, failures);

  // Step 5: usage warning; the rail shows ✓ ✓ ✓ ✓ 5.
  await protoClick(protoPage, 'Continue');
  await wizard.getByTestId('wz-next').click();
  await wizard.getByTestId('wz-usage').waitFor();
  await measureAndCompare('step 5', protoPage, appPage, { ...frameParts(4), ...usageParts() }, rows, failures);
  const protoStep5 = await protoPage.screenshot({ clip });
  const appStep5 = await appPage.screenshot({ clip });

  // SPEC tokens as computed styles of the app (Setup wizard: 960×620, steps rail, modal radius + shadow).
  const computed = await appPage.evaluate(() => {
    const one = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const panel = one('.sb-modal-wizard');
    const overlay = one('.sb-overlay[data-modal="setup-wizard"]');
    const done = one('.sb-wz-step[data-state="done"] .sb-wz-dot');
    const current = one('.sb-wz-step[data-state="current"] .sb-wz-dot');
    const currentStep = one('.sb-wz-step[data-state="current"]');
    const next = one('[data-testid="wz-next"]');
    return {
      panelSize: `${panel.width}×${panel.height}`,
      panelColumns: panel.gridTemplateColumns,
      panelRadius: panel.borderTopLeftRadius,
      panelShadow: panel.boxShadow,
      panelBg: panel.backgroundColor,
      overlayBg: overlay.backgroundColor,
      doneDotBg: done.backgroundColor,
      doneDotFg: done.color,
      currentDotBg: current.backgroundColor,
      currentStepBg: currentStep.backgroundColor,
      nextBg: next.backgroundColor,
      nextFg: next.color,
    };
  });
  const expected: Record<string, string> = {
    panelSize: '960px×620px',
    panelColumns: '250px 710px',
    panelRadius: '14px',
    panelShadow: 'rgba(0, 0, 0, 0.6) 0px 30px 80px 0px',
    panelBg: hexToRgb('#111214'),
    overlayBg: 'rgba(0, 0, 0, 0.7)',
    doneDotBg: 'oklch(0.3 0.06 150)',
    doneDotFg: 'oklch(0.85 0.1 150)',
    currentDotBg: hexToRgb('#e8e7e3'),
    currentStepBg: hexToRgb('#1f2024'),
    nextBg: hexToRgb('#e8e7e3'),
    nextFg: hexToRgb('#111214'),
  };
  const computedRows: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = computed[key as keyof typeof computed];
    if (got !== want) failures.push(`computed ${key}: expected ${want}, got ${got}`);
    computedRows.push(`| ${key} | ${want} | ${got} | ${got === want ? 'ok' : 'FAIL'} |`);
  }

  await writeReport({
    'setup-wizard.md': report({ rows, computedRows, failures, panel: panelDiff.percent, full: fullDiff.percent }),
    'setup-wizard-side-by-side.png': await sideBySide(appPage, protoStep1, appStep1),
    'setup-wizard-root-side-by-side.png': await sideBySide(appPage, protoStep2, appStep2),
    'setup-wizard-scan-side-by-side.png': await sideBySide(appPage, protoStep3, appStep3),
    'setup-wizard-usage-side-by-side.png': await sideBySide(appPage, protoStep5, appStep5),
    'setup-wizard-page-side-by-side.png': await sideBySide(appPage, protoFull, appFull),
  });

  expect(failures).toEqual([]);
});

function report(input: { rows: string[]; computedRows: string[]; failures: string[]; panel: number; full: number }): string {
  return `# Visual oracle · Setup wizard (M5.3)

Generated by \`tests/e2e/visual/setup-wizard.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`) with \`SWITCHBOARD_SETUP_WIZARD=auto\`, 1440×900: the wizard opens by itself (first run); each step reached with Continue. On step 2 the app's field gets a temp folder holding a 640-line router \`AGENTS.md\` titled "AGENTS.md (Workspace Router)".
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, \`showSetupOnLoad\` on; each step reached with Continue.

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff of step 1 (advisory, channel threshold 24): wizard panel (239,139 962×622) **${input.panel.toFixed(2)}%**, full page **${input.full.toFixed(2)}%**.
Known data differences: step 1's login row ("Signed in · claude auth status · the login stays with Claude Code" vs the prototype's "Signed in · Max plan · subscription auth · no API key": only the exit code of \`claude auth status\` is read, so no plan is named; compared by size); step 2's path (a temp folder vs \`D:\\acme\`); step 3's rows (the demo's workspace scan, 7 rows, vs the prototype's hard-coded \`scan\`, 8 rows; the first row is compared, the table's height is not). Behind the overlay the page differs (the app's Inbox under the demo seed, the prototype's Inbox).

Side by side (prototype left, app right): \`setup-wizard-side-by-side.png\` (step 1), \`setup-wizard-root-side-by-side.png\` (step 2), \`setup-wizard-scan-side-by-side.png\` (step 3), \`setup-wizard-usage-side-by-side.png\` (step 5), \`setup-wizard-page-side-by-side.png\` (page, step 1).

## Boxes (±2 px), copy and computed styles
Geometry: \`box\` = x, y, width, height; \`size\` = x, width, height. Styles compared: ${COMPARED_STYLES.join(', ')} (the app's root field is an \`<input>\`: its text cursor is accepted; its Browse… works, so its pointer cursor is accepted where the prototype's inert one has none).

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
