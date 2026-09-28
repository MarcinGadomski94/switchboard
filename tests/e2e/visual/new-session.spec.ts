import { type Page, expect, test } from '@playwright/test';
import {
  type DemoApp,
  type Geometry,
  type Part,
  STYLE_PROPS,
  canonicalColors,
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
 * Visual oracle for the New-session modal (M5.1, D10): the app (demo seed) against
 * the prototype's `mNew` at 1440×900. The prototype opens with its draft (`ns`:
 * `free-talk-640`, orchestrator, acme-app-front + mobile); the app's form is filled
 * to the same values through the UI (its own defaults are the router's
 * recommended answers, `docs/new-session.md`). Four states are compared: the
 * draft, single-solution (section 6 · Mobile coordination), test-authoring with
 * stack Both (section 6 · QA contract) and no solutions (Start at 45%). Gate:
 * boxes ±2 px, exact copy, equal computed styles, SPEC tokens; the pixel diff is
 * advisory (`docs/visual/new-session.md`).
 *
 * Known data differences, not findings: the chips come from the demo's workspace
 * scan (the Solutions view's rows), which lists fewer nugets / microservices /
 * functions than the prototype's hard-coded `G` and no `other/` row, so the
 * solutions section is shorter and everything below it sits higher (those parts
 * are compared with geometry `size`: x, width, height).
 */

interface PartSpec {
  /** Child indexes from the modal panel (the 1080px box with the 14px radius). */
  readonly path: readonly number[];
  readonly geometry: Geometry;
  readonly copy: boolean;
}

const FORM = [0];
const SIDE = [1];
const SOLUTIONS = [...FORM, 4];
const PHASE = [...FORM, 5];

/** Parts of the draft state. */
function draftParts(): Record<string, PartSpec> {
  const out: Record<string, PartSpec> = {
    panel: { path: [], geometry: 'box', copy: false },
    form: { path: FORM, geometry: 'box', copy: false },
    side: { path: SIDE, geometry: 'box', copy: false },
    head: { path: [...FORM, 0], geometry: 'box', copy: false },
    title: { path: [...FORM, 0, 0], geometry: 'box', copy: true },
    sub: { path: [...FORM, 0, 1], geometry: 'box', copy: true },
    recommended: { path: [...FORM, 0, 2], geometry: 'box', copy: true },
    taskSection: { path: [...FORM, 1], geometry: 'box', copy: false },
    taskLabel: { path: [...FORM, 1, 0], geometry: 'box', copy: true },
    nameInput: { path: [...FORM, 1, 1, 0], geometry: 'box', copy: false },
    taskInput: { path: [...FORM, 1, 1, 1], geometry: 'box', copy: false },
    workLabel: { path: [...FORM, 2, 0], geometry: 'box', copy: true },
    workFeature: { path: [...FORM, 2, 1, 0], geometry: 'box', copy: true },
    workQa: { path: [...FORM, 2, 1, 1], geometry: 'box', copy: true },
    modeLabel: { path: [...FORM, 3, 0], geometry: 'box', copy: true },
    modeSingle: { path: [...FORM, 3, 1, 0], geometry: 'box', copy: true },
    modeOrch: { path: [...FORM, 3, 1, 1], geometry: 'box', copy: true },
    solutionsLabel: { path: [...SOLUTIONS, 0], geometry: 'box', copy: true },
    solutionsHint: { path: [...SOLUTIONS, 0, 0], geometry: 'box', copy: true },
    microfrontendsFolder: { path: [...SOLUTIONS, 1, 0], geometry: 'box', copy: true },
    mobileFolder: { path: [...SOLUTIONS, 2, 0], geometry: 'box', copy: true },
    mobileChip: { path: [...SOLUTIONS, 2, 1, 0], geometry: 'box', copy: true },
    nugetsFolder: { path: [...SOLUTIONS, 3, 0], geometry: 'box', copy: true },
    nugetsChip1: { path: [...SOLUTIONS, 3, 1, 0], geometry: 'box', copy: true },
    nugetsChip2: { path: [...SOLUTIONS, 3, 1, 1], geometry: 'box', copy: true },
    phaseSection: { path: PHASE, geometry: 'size', copy: false },
    phaseLabel: { path: [...PHASE, 0], geometry: 'size', copy: true },
    phaseUi: { path: [...PHASE, 1, 0], geometry: 'size', copy: true },
    phaseIntegration: { path: [...PHASE, 1, 1], geometry: 'size', copy: true },
    launchLabel: { path: [...SIDE, 0], geometry: 'box', copy: true },
    toggles: { path: [...SIDE, 1], geometry: 'box', copy: false },
    summaryLabel: { path: [...SIDE, 2], geometry: 'box', copy: true },
    summary: { path: [...SIDE, 3], geometry: 'box', copy: false },
    actions: { path: [...SIDE, 4], geometry: 'box', copy: false },
    cancel: { path: [...SIDE, 4, 0], geometry: 'box', copy: true },
    start: { path: [...SIDE, 4, 1], geometry: 'box', copy: true },
  };
  for (let i = 0; i < 4; i++) out[`microfrontendsChip${i + 1}`] = { path: [...SOLUTIONS, 1, 1, i], geometry: 'box', copy: true };
  for (const [index, name] of [
    [0, 'worktree'],
    [1, 'ultracode'],
  ] as const) {
    out[`${name}Row`] = { path: [...SIDE, 1, index], geometry: 'box', copy: false };
    out[`${name}Title`] = { path: [...SIDE, 1, index, 0, 0], geometry: 'box', copy: true };
    out[`${name}Desc`] = { path: [...SIDE, 1, index, 0, 1], geometry: 'box', copy: true };
    out[`${name}Switch`] = { path: [...SIDE, 1, index, 1], geometry: 'box', copy: false };
    out[`${name}Knob`] = { path: [...SIDE, 1, index, 1, 0], geometry: 'box', copy: false };
  }
  for (let i = 0; i < 12; i++) out[`summaryLine${i}`] = { path: [...SIDE, 3, i], geometry: 'box', copy: true };
  return out;
}

/** The read-only row: last group of section 4 in both pages (`size`: it sits higher in the app, see above). */
function readOnlyParts(protoIndex: number, appIndex: number): Record<string, { readonly proto: readonly number[]; readonly app: readonly number[]; readonly geometry: Geometry; readonly copy: boolean }> {
  return {
    readOnlyFolder: { proto: [...SOLUTIONS, protoIndex, 0], app: [...SOLUTIONS, appIndex, 0], geometry: 'size', copy: true },
    readOnlyChip1: { proto: [...SOLUTIONS, protoIndex, 1, 0], app: [...SOLUTIONS, appIndex, 1, 0], geometry: 'size', copy: true },
    readOnlyChip2: { proto: [...SOLUTIONS, protoIndex, 1, 1], app: [...SOLUTIONS, appIndex, 1, 1], geometry: 'size', copy: true },
  };
}

/** Section 6 parts (below the solutions section: `size`). */
function sectionSixParts(pills: number): Record<string, PartSpec> {
  const out: Record<string, PartSpec> = {
    six: { path: [...FORM, 6], geometry: 'size', copy: false },
    sixLabel: { path: [...FORM, 6, 0], geometry: 'size', copy: true },
    sixPills: { path: [...FORM, 6, 1], geometry: 'size', copy: false },
  };
  for (let i = 0; i < pills; i++) out[`sixPill${i + 1}`] = { path: [...FORM, 6, 1, i], geometry: 'size', copy: true };
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
  'opacity',
  'cursor',
  'white-space',
] as const;

/** Set in the page by {@link installPanelFinder}: the modal panel (the 1080px grid box with the 14px radius). */
declare function findPanelIn(doc: Document): HTMLElement | undefined;

/** Defines `findPanelIn` in the page, for the `page.evaluate` callbacks below. */
async function installPanelFinder(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { findPanelIn: (doc: Document) => HTMLElement | undefined }).findPanelIn = (doc) =>
      [...doc.querySelectorAll<HTMLElement>('body *')].find((el) => {
        const style = getComputedStyle(el);
        return style.width === '1080px' && style.borderTopLeftRadius === '14px' && style.display === 'grid';
      });
  });
}

/** Measures parts addressed by child-index paths from the modal panel. */
async function measurePanel(page: Page, paths: Readonly<Record<string, readonly number[]>>): Promise<Record<string, Part | null>> {
  return page.evaluate(
    ({ wanted, props }) => {
      const panel = findPanelIn(document);
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

/** Compares measured parts; appends report rows and findings. */
function compareParts(
  state: string,
  specs: Record<string, { readonly geometry: Geometry; readonly copy: boolean }>,
  proto: Record<string, Part | null>,
  app: Record<string, Part | null>,
  rows: string[],
  failures: string[],
): void {
  for (const [name, spec] of Object.entries(specs)) {
    const label = `${state} · ${name}`;
    const p = proto[name];
    const a = app[name];
    if (!p || !a) {
      failures.push(`${label}: missing (${p ? 'app' : 'prototype'})`);
      continue;
    }
    const boxIssues = compareBoxes(label, p.box, a.box, spec.geometry);
    const copyIssues = spec.copy && p.text !== a.text ? [`${label}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`] : [];
    const styleIssues = COMPARED_STYLES.filter((prop) => p.style[prop] !== a.style[prop]).map((prop) => `${label}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
    failures.push(...boxIssues, ...copyIssues, ...styleIssues);
    const ok = boxIssues.length + copyIssues.length + styleIssues.length === 0;
    rows.push(`| ${label} | ${spec.geometry} | ${fmtBox(p)} | ${fmtBox(a)} | ${ok ? 'ok' : 'FAIL'} | ${spec.copy ? JSON.stringify(a.text).slice(0, 70) : ''} |`);
  }
}

async function measureAndCompare(
  state: string,
  protoPage: Page,
  appPage: Page,
  specs: Record<string, PartSpec>,
  rows: string[],
  failures: string[],
): Promise<void> {
  const paths = Object.fromEntries(Object.entries(specs).map(([name, part]) => [name, part.path]));
  compareParts(state, specs, await measurePanel(protoPage, paths), await measurePanel(appPage, paths), rows, failures);
}

/** Clicks the prototype's pill or chip with exactly this text (its onClick sits on the text's parent span). */
async function protoClick(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).first().click();
}

let app: DemoApp;

test.beforeAll(async () => {
  app = await startDemoApp();
});

test.afterAll(async () => {
  await app?.stop();
});

test('New-session modal matches the prototype (tokens, boxes ±2 px, copy, four states)', async ({ browser }) => {
  test.setTimeout(90_000);
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototype(protoPage, { simulateIncoming: false });
  await protoClick(protoPage, '+ New session');
  await protoPage.getByText('Start session', { exact: true }).waitFor();
  await installPanelFinder(protoPage);

  await openApp(appPage, app.baseUrl, '/');
  await appPage.getByTestId('new-session').click();
  const modal = appPage.getByTestId('modal-new-session');
  await modal.getByTestId('ns-group').first().waitFor();
  await installPanelFinder(appPage);
  // The prototype's draft (`ns`), entered through the form.
  await modal.getByTestId('ns-name').fill('free-talk-640');
  await modal.getByTestId('ns-task').fill('Free talk screen at 640, web and mobile. Figma node 2231:902.');
  await modal.locator('[data-group="mode"][data-value="orchestrator"]').click();
  await modal.locator('[data-testid="ns-chip"][data-solution="acme-app-front"]').click();
  await modal.locator('[data-testid="ns-chip"][data-solution="mobile"]').click();

  const rows: string[] = [];
  const failures: string[] = [];

  // State 1: the draft.
  await measureAndCompare('draft', protoPage, appPage, draftParts(), rows, failures);
  const inputs = async (page: Page) =>
    page.evaluate(() =>
      [...(findPanelIn(document)?.querySelectorAll('input') ?? [])].map((input) => ({ value: input.value, placeholder: input.placeholder })),
    );
  const protoInputs = await inputs(protoPage);
  const appInputs = await inputs(appPage);
  if (JSON.stringify(protoInputs) !== JSON.stringify(appInputs)) failures.push(`draft · inputs: prototype ${JSON.stringify(protoInputs)} vs app ${JSON.stringify(appInputs)}`);
  rows.push(`| draft · inputs (value, placeholder) | — | ${JSON.stringify(protoInputs).slice(0, 60)}… | same | ${JSON.stringify(protoInputs) === JSON.stringify(appInputs) ? 'ok' : 'FAIL'} | |`);
  // Section 4's last child is the read-only row (label + one row per group).
  const lastGroup = (page: Page) => page.evaluate((path) => {
    let el: Element | undefined | null = findPanelIn(document);
    for (const index of path) el = el?.children[index];
    return (el?.children.length ?? 0) - 1;
  }, SOLUTIONS);
  const protoGroups = await lastGroup(protoPage);
  const appGroups = await lastGroup(appPage);
  const readOnly = readOnlyParts(protoGroups, appGroups);
  const protoRo = await measurePanel(protoPage, Object.fromEntries(Object.entries(readOnly).map(([n, s]) => [n, s.proto])));
  const appRo = await measurePanel(appPage, Object.fromEntries(Object.entries(readOnly).map(([n, s]) => [n, s.app])));
  compareParts('draft', readOnly, protoRo, appRo, rows, failures);

  // SPEC tokens as computed styles of the app (New session: 1080px, `1fr | 360px`, pills, chips, toggles, summary).
  const computed = await appPage.evaluate(() => {
    const one = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const panel = one('.sb-modal-new');
    const pillOn = one('[data-group="mode"][data-selected="true"]');
    const chipOn = one('[data-testid="ns-chip"][data-selected="true"]');
    const locked = one('[data-testid="ns-chip"][data-locked="true"]');
    const switchOn = one('[data-testid="ns-switch-worktrees"]');
    const switchOff = one('[data-testid="ns-switch-ultracode"]');
    const summary = one('.sb-ns-summary');
    const start = one('[data-testid="ns-start"]');
    const label = one('.sb-ns-label');
    const switchBox = document.querySelector('[data-testid="ns-switch-worktrees"]')!.getBoundingClientRect();
    return {
      panelWidth: panel.width,
      panelColumns: panel.gridTemplateColumns,
      panelRadius: panel.borderTopLeftRadius,
      panelShadow: panel.boxShadow,
      panelBg: panel.backgroundColor,
      pillOnBg: pillOn.backgroundColor,
      pillOnBorder: pillOn.borderTopColor,
      chipOnBg: chipOn.backgroundColor,
      chipOnBorder: chipOn.borderTopColor,
      lockedOpacity: locked.opacity,
      lockedCursor: locked.cursor,
      switchSize: `${switchBox.width}×${switchBox.height}`,
      switchOnBg: switchOn.backgroundColor,
      switchOffBg: switchOff.backgroundColor,
      summaryFont: `${summary.fontSize} ${summary.fontFamily}`,
      summaryBg: summary.backgroundColor,
      startBg: start.backgroundColor,
      startFg: start.color,
      startOpacity: start.opacity,
      labelFont: `${label.fontWeight} ${label.fontSize} ${label.fontFamily}`,
      labelSpacing: `${label.letterSpacing} ${label.textTransform}`,
      labelColor: label.color,
    };
  });
  const [blueBg, blueBorder] = await canonicalColors(appPage, ['oklch(0.25 0.04 250)', 'oklch(0.55 0.09 250)']);
  const expected: Record<string, string> = {
    panelWidth: '1080px',
    panelColumns: '720px 360px',
    panelRadius: '14px',
    panelShadow: 'rgba(0, 0, 0, 0.6) 0px 30px 80px 0px',
    panelBg: hexToRgb('#141518'),
    pillOnBg: hexToRgb('#26272c'),
    pillOnBorder: hexToRgb('#8d8c87'),
    chipOnBg: blueBg ?? '',
    chipOnBorder: blueBorder ?? '',
    lockedOpacity: '0.4',
    lockedCursor: 'not-allowed',
    switchSize: '32×18',
    switchOnBg: hexToRgb('#e8e7e3'),
    switchOffBg: hexToRgb('#33343a'),
    summaryFont: '11.5px "Geist Mono", monospace',
    summaryBg: hexToRgb('#0c0d0f'),
    startBg: hexToRgb('#e8e7e3'),
    startFg: hexToRgb('#111214'),
    startOpacity: '1',
    labelFont: '500 10.5px "Geist Mono", monospace',
    labelSpacing: '0.63px uppercase',
    labelColor: hexToRgb('#8d8c87'),
  };
  const computedRows: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = computed[key as keyof typeof computed];
    if (got !== want) failures.push(`computed ${key}: expected ${want}, got ${got}`);
    computedRows.push(`| ${key} | ${want} | ${got} | ${got === want ? 'ok' : 'FAIL'} |`);
  }

  // Captures of the draft (the panel, then the page).
  const clip = { x: 179, y: 49, width: 1082, height: 802 };
  const protoPanel = await protoPage.screenshot({ clip });
  const appPanel = await appPage.screenshot({ clip });
  const protoFull = await protoPage.screenshot();
  const appFull = await appPage.screenshot();
  const panelDiff = await pixelDiff(appPage, protoPanel, appPanel);
  const fullDiff = await pixelDiff(appPage, protoFull, appFull);

  // State 2: single-solution → section 6 · Mobile coordination (a *-front is in scope).
  await protoClick(protoPage, 'Single-solution');
  await modal.locator('[data-group="mode"][data-value="single"]').click();
  await expect(modal.locator('[data-section="coordination"]')).toBeVisible();
  const coordination = { ...sectionSixParts(3), summaryLine5: { path: [...SIDE, 3, 5], geometry: 'box', copy: true } } satisfies Record<string, PartSpec>;
  await measureAndCompare('single', protoPage, appPage, coordination, rows, failures);

  // State 3: test-authoring, stack Both → section 6 · QA contract (the prototype's stack default).
  await protoClick(protoPage, 'Test-authoring (QA)');
  await modal.locator('[data-group="work-type"][data-value="qa"]').click();
  await modal.locator('[data-group="stack"][data-value="both"]').click();
  const qa: Record<string, PartSpec> = {
    ...sectionSixParts(3),
    qaFields: { path: [...FORM, 6, 2], geometry: 'size', copy: false },
    qaConfluence: { path: [...FORM, 6, 2, 0], geometry: 'size', copy: false },
    qaFigma: { path: [...FORM, 6, 2, 1], geometry: 'size', copy: false },
    summaryLine2: { path: [...SIDE, 3, 2], geometry: 'box', copy: true },
    summaryLine5: { path: [...SIDE, 3, 5], geometry: 'box', copy: true },
  };
  const qaPaths = Object.fromEntries(Object.entries(qa).map(([name, part]) => [name, part.path]));
  const protoQa = await measurePanel(protoPage, qaPaths);
  const appQa = await measurePanel(appPage, qaPaths);
  // The prototype draws the two sources as static boxes; the app's are inputs whose placeholder is that copy (muted, #76756f).
  const placeholderCopy = await appPage.evaluate(() => [
    (document.querySelector('[data-testid="ns-confluence"]') as HTMLInputElement).placeholder,
    (document.querySelector('[data-testid="ns-figma"]') as HTMLInputElement).placeholder,
    getComputedStyle(document.querySelector('[data-testid="ns-confluence"]')!, '::placeholder').color,
  ]);
  for (const [index, name] of [
    [0, 'qaConfluence'],
    [1, 'qaFigma'],
  ] as const) {
    if (protoQa[name]?.text !== placeholderCopy[index]) failures.push(`qa · ${name} copy: prototype ${protoQa[name]?.text} vs app placeholder ${placeholderCopy[index]}`);
    // Known difference: the prototype's static box vs a real input. Its color is compared with the placeholder's
    // (the input's own text is the entered URL) and its text cursor is the input's (the static box has none).
    const a = appQa[name];
    if (a) appQa[name] = { ...a, style: { ...a.style, color: placeholderCopy[2] ?? '', cursor: a.style['cursor'] === 'text' ? 'auto' : (a.style['cursor'] ?? '') } };
  }
  compareParts('qa', qa, protoQa, appQa, rows, failures);

  // State 4: back to the draft's work type, no solutions → "⚠ pick at least one solution", Start at 45%.
  await protoClick(protoPage, 'Feature-building');
  await protoClick(protoPage, '✓ acme-app-front');
  await protoClick(protoPage, '✓ mobile');
  await modal.locator('[data-group="work-type"][data-value="feature"]').click();
  await modal.locator('[data-testid="ns-chip"][data-solution="acme-app-front"]').click();
  await modal.locator('[data-testid="ns-chip"][data-solution="mobile"]').click();
  const empty: Record<string, PartSpec> = {
    solutionsHint: { path: [...SOLUTIONS, 0, 0], geometry: 'box', copy: true },
    start: { path: [...SIDE, 4, 1], geometry: 'box', copy: true },
  };
  for (let i = 0; i < 10; i++) empty[`summaryLine${i}`] = { path: [...SIDE, 3, i], geometry: 'box', copy: true };
  await measureAndCompare('empty', protoPage, appPage, empty, rows, failures);

  await writeReport({
    'new-session.md': report({ rows, computedRows, failures, panel: panelDiff.percent, full: fullDiff.percent }),
    'new-session-side-by-side.png': await sideBySide(appPage, protoPanel, appPanel),
    'new-session-page-side-by-side.png': await sideBySide(appPage, protoFull, appFull),
  });

  expect(failures).toEqual([]);
});

function report(input: { rows: string[]; computedRows: string[]; failures: string[]; panel: number; full: number }): string {
  return `# Visual oracle · New-session modal (M5.1)

Generated by \`tests/e2e/visual/new-session.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`), 1440×900, "+ New session" with the form filled to the prototype's draft through the UI (name \`free-talk-640\`, its task, Workspace orchestrator, acme-app-front + mobile).
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, "+ New session" (its draft \`ns\`).

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff of the draft (advisory, channel threshold 24): modal panel (179,49 1082×802) **${input.panel.toFixed(2)}%**, full page **${input.full.toFixed(2)}%**.
Known data differences: the solution chips come from the demo's workspace scan (the Solutions view's rows): nugets/ has 2 chips instead of 4, microservices/ lists notifications before auth, functions/ has 1, and there is no other/ row, so the solutions section is 66 px shorter and everything below it (read-only row, phase, section 6) is compared by size only. Behind the overlay the sidebar differs where other lanes' routes still answer 501 in this lane.

Side by side (prototype left, app right): \`new-session-side-by-side.png\` (the panel), \`new-session-page-side-by-side.png\` (page).

## Boxes (±2 px), copy and computed styles
Geometry: \`box\` = x, y, width, height; \`size\` = x, width, height. States: \`draft\` (the prototype's draft), \`single\` (Single-solution: section 6 · Mobile coordination), \`qa\` (Test-authoring, stack Both: section 6 · QA contract; the prototype's static source boxes against the app's inputs, copy = placeholder, color = placeholder color), \`empty\` (no solutions: the warning line, Start at 45%). Styles compared: ${COMPARED_STYLES.join(', ')}.

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
