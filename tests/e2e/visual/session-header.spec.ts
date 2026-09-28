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
 * Visual oracle for the session header and layout (M4.1, D10): the app (demo seed)
 * against the prototype with the same session open (its sidebar row), 1440×900,
 * `simulateIncoming` off, on two sessions: `calendar-func-fix` (every chip fits one
 * row on both pages, so every box is compared absolutely) and `free-talk-feature`
 * (the prototype's default; its hand-written chips wrap to a second row, so the
 * chip row, the header height and the tabs are compared relative to the chip row).
 * Gate: boxes ±2 px, exact copy and equal computed styles for the layout, the
 * header row, the first three chips and the tabs; SPEC tokens as computed styles;
 * the loop chip's blue compared on `button-rollout`. Chips the prototype
 * hand-writes without a data source (`bp 360`, `run workflow 7f3a · reconcile`,
 * the path-style scope `functions/calendar-func`) are known differences (D13,
 * `docs/derivations.md` → *Session chips*), reported but not gated. The pixel diff
 * is advisory (`docs/visual/session-header.md`).
 *
 * D33: the app's header actions start with **Close** (not in the prototype), so
 * Pause and "Continue in terminal" keep the prototype's boxes one place later in
 * the app, and the actions group is compared by its right edge, y and height, its
 * copy being the prototype's after "Close". Close itself is gated on the actions'
 * own rule: Pause's y, height and computed styles, 6 px left of Pause.
 */

interface PartSpec {
  readonly path: readonly number[];
  readonly geometry: Geometry;
  readonly copy: boolean;
}

const VIEW = [1, 0] as const;
const MAIN = [...VIEW, 0] as const;
const HEADER = [...MAIN, 0] as const;
const TOP = [...HEADER, 0] as const;
const CHIPS = [...HEADER, 1] as const;
const TABS = [...HEADER, 2] as const;

const PARTS: Readonly<Record<string, PartSpec>> = {
  view: { path: VIEW, geometry: 'box', copy: false },
  main: { path: MAIN, geometry: 'box', copy: false },
  panel: { path: [...VIEW, 1], geometry: 'box', copy: false },
  header: { path: HEADER, geometry: 'box', copy: false },
  top: { path: TOP, geometry: 'box', copy: false },
  dot: { path: [...TOP, 0], geometry: 'box', copy: false },
  name: { path: [...TOP, 1], geometry: 'box', copy: true },
  root: { path: [...TOP, 2], geometry: 'box', copy: true },
  actions: { path: [...TOP, 3], geometry: 'box', copy: true },
  pause: { path: [...TOP, 3, 0], geometry: 'box', copy: true },
  handoff: { path: [...TOP, 3, 1], geometry: 'box', copy: true },
  chips: { path: CHIPS, geometry: 'size', copy: false },
  chip0: { path: [...CHIPS, 0], geometry: 'box', copy: true },
  chip0Key: { path: [...CHIPS, 0, 0], geometry: 'box', copy: true },
  chip1: { path: [...CHIPS, 1], geometry: 'box', copy: true },
  chip2: { path: [...CHIPS, 2], geometry: 'box', copy: true },
  tabs: { path: TABS, geometry: 'box', copy: true },
  tab0: { path: [...TABS, 0], geometry: 'box', copy: true },
  tab1: { path: [...TABS, 1], geometry: 'box', copy: true },
  tab2: { path: [...TABS, 2], geometry: 'box', copy: true },
  tab3: { path: [...TABS, 3], geometry: 'box', copy: true },
};

/** D33: where the app's actions are (Close first; the prototype has Pause and "Continue in terminal" at 0 and 1). */
const APP_PATHS: Readonly<Record<string, readonly number[]>> = {
  pause: [...TOP, 3, 1],
  handoff: [...TOP, 3, 2],
  close: [...TOP, 3, 0],
};

/** D33: the Close action's label (src/core/session-close.ts `CLOSE_LABEL`). */
const CLOSE_LABEL = 'Close';

/** D33: the gap between two header actions (`.sb-sv-actions`). */
const ACTION_GAP_PX = 6;

/** Chips reported but not gated (data the prototype hand-writes). */
const REPORTED_CHIPS = [3, 4, 5];

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

/** Opens a session in the prototype through its sidebar row. */
async function openProtoSession(page: Page, name: string): Promise<void> {
  await page.getByText(name, { exact: true }).first().click();
  await page.getByText('Agents & solutions', { exact: true }).waitFor();
}

async function openAppSession(page: Page, name: string): Promise<void> {
  await openApp(page, app.baseUrl, `/sessions/${name}`);
  await expect(page.getByTestId('session-name')).toHaveText(name);
  await expect(page.getByTestId('session-chip').first()).toBeVisible();
}

function chipTexts(parts: Record<string, Part | null>, count: number): string[] {
  return Array.from({ length: count }, (_, i) => parts[`chip${i}`]?.text ?? '');
}

/** One compared session: its table rows, the reported (not gated) chips and the chip lists. */
interface Compared {
  readonly rows: string[];
  readonly knownRows: string[];
  readonly protoChips: string[];
  readonly appChips: string[];
  readonly app: Record<string, Part | null>;
}

/**
 * Measures both pages on the open session and gates every part. `wrapped`: the
 * prototype's chip row holds hand-written chips the app does not have, so its
 * height (and what sits below it) depends on data: the chip row, the header and
 * the tabs are then compared relative to the chip row (same gap below it, same
 * header height without it) instead of by absolute height / y.
 */
async function compareSession(protoPage: Page, appPage: Page, name: string, wrapped: boolean, failures: string[]): Promise<Compared> {
  const paths = Object.fromEntries(Object.entries(PARTS).map(([part, spec]) => [part, spec.path]));
  const extraChips = Object.fromEntries(REPORTED_CHIPS.map((i) => [`chip${i}`, [...CHIPS, i]]));
  const proto = await measure(protoPage, { ...paths, ...extraChips });
  const shot = await measure(appPage, { ...paths, ...APP_PATHS, ...extraChips });
  const rows: string[] = [];
  const DATA_DEPENDENT: Readonly<Record<string, Geometry>> = wrapped
    ? { header: 'none', chips: 'none', tabs: 'size', tab0: 'size', tab1: 'size', tab2: 'size', tab3: 'size' }
    : {};
  for (const [part, spec] of Object.entries(PARTS)) {
    const p = proto[part];
    const a = shot[part];
    if (!p || !a) {
      failures.push(`${name} ${part}: missing (${p ? 'app' : 'prototype'})`);
      continue;
    }
    const geometry = DATA_DEPENDENT[part] ?? spec.geometry;
    // D33: the actions group grows to the left by Close: its right edge, y and height stay; its copy is Close + the prototype's.
    const isActions = part === 'actions';
    const boxIssues = isActions ? actionsBoxIssues(`${name} ${part}`, p.box, a.box) : compareBoxes(`${name} ${part}`, p.box, a.box, geometry);
    const wantText = isActions ? `${CLOSE_LABEL}${p.text}` : p.text;
    const copyIssues = spec.copy && wantText !== a.text ? [`${name} ${part}.text: prototype ${JSON.stringify(wantText)} vs app ${JSON.stringify(a.text)}`] : [];
    const styleIssues = COMPARED_STYLES.filter((prop) => p.style[prop] !== a.style[prop]).map(
      (prop) => `${name} ${part}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`,
    );
    failures.push(...boxIssues, ...copyIssues, ...styleIssues);
    const ok = boxIssues.length + copyIssues.length + styleIssues.length === 0;
    rows.push(`| ${name} | ${part} | ${isActions ? 'right, y, height (D33)' : geometry} | ${fmtBox(p)} | ${fmtBox(a)} | ${ok ? 'ok' : 'FAIL'} | ${spec.copy ? JSON.stringify(a.text).slice(0, 80) : ''} |`);
  }
  // D33: Close, the first action (not in the prototype): Pause's row, height and styles, one gap left of Pause.
  const close = shot['close'];
  const pause = shot['pause'];
  if (!close || !pause) {
    failures.push(`${name} close: missing in the app`);
  } else {
    const closeIssues: string[] = [];
    if (close.text !== CLOSE_LABEL) closeIssues.push(`${name} close.text: ${JSON.stringify(close.text)}, expected ${JSON.stringify(CLOSE_LABEL)}`);
    for (const [edge, want, got] of [
      ['y', pause.box.y, close.box.y],
      ['height', pause.box.height, close.box.height],
      ['right', pause.box.x - ACTION_GAP_PX, close.box.x + close.box.width],
    ] as const) {
      if (Math.abs(want - got) > 2) closeIssues.push(`${name} close.${edge}: expected ${round(want)} (Pause's), app ${round(got)}`);
    }
    for (const prop of COMPARED_STYLES) {
      if (close.style[prop] !== pause.style[prop]) closeIssues.push(`${name} close.${prop}: Pause ${pause.style[prop]} vs Close ${close.style[prop]}`);
    }
    failures.push(...closeIssues);
    rows.push(`| ${name} | close (D33) | Pause's y, height, styles; ${ACTION_GAP_PX} px left of Pause | – | ${fmtBox(close)} | ${closeIssues.length === 0 ? 'ok' : 'FAIL'} | ${JSON.stringify(close.text)} |`);
  }
  if (wrapped) {
    // Relative to the chip row: the same x / y / width, the same gap to the tabs, the same header height without it.
    const relative = (parts: Record<string, Part | null>) => {
      const chips = parts['chips']?.box;
      const header = parts['header']?.box;
      const tabs = parts['tabs']?.box;
      if (!chips || !header || !tabs) return null;
      return { chipsX: chips.x, chipsY: chips.y, chipsWidth: chips.width, tabsGap: tabs.y - (chips.y + chips.height), headerRest: header.height - chips.height };
    };
    const p = relative(proto);
    const a = relative(shot);
    for (const key of ['chipsX', 'chipsY', 'chipsWidth', 'tabsGap', 'headerRest'] as const) {
      const pv = p?.[key] ?? Number.NaN;
      const av = a?.[key] ?? Number.NaN;
      const ok = Math.abs(pv - av) <= 2;
      if (!ok) failures.push(`${name} ${key}: prototype ${round(pv)} vs app ${round(av)}`);
      rows.push(`| ${name} | ${key} | relative | ${round(pv)} | ${round(av)} | ${ok ? 'ok' : 'FAIL'} | |`);
    }
  }
  return {
    rows,
    knownRows: REPORTED_CHIPS.map((i) => `| ${name} | chip${i} | ${JSON.stringify(proto[`chip${i}`]?.text ?? null)} | ${JSON.stringify(shot[`chip${i}`]?.text ?? null)} |`),
    protoChips: chipTexts(proto, 6),
    appChips: chipTexts(shot, 6),
    app: shot,
  };
}

test('Session header and layout match the prototype (tokens, boxes ±2 px, copy)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  const failures: string[] = [];
  await openPrototype(protoPage, { simulateIncoming: false });

  // calendar-func-fix: every chip the prototype shows fits one row in both pages, so every box is absolute.
  await openProtoSession(protoPage, 'calendar-func-fix');
  await openAppSession(appPage, 'calendar-func-fix');
  const calendar = await compareSession(protoPage, appPage, 'calendar-func-fix', false, failures);

  // free-talk-feature (the prototype's default session): its extra mock chips wrap to a second row.
  await openProtoSession(protoPage, 'free-talk-feature');
  await openAppSession(appPage, 'free-talk-feature');
  await expect(appPage.getByTestId('session-tab-artifacts')).toHaveText('Artifacts · 4');
  const freeTalk = await compareSession(protoPage, appPage, 'free-talk-feature', true, failures);
  const shot = freeTalk.app;
  const rows = [...calendar.rows, ...freeTalk.rows];
  const knownRows = [...calendar.knownRows, ...freeTalk.knownRows];

  // The loop chip's blue (SPEC: loop / workflow chips are blue), on button-rollout in both pages.
  const loopProto = await openLoopChip(protoPage, 'proto');
  const loopApp = await openLoopChip(appPage, 'app');
  const loopRows: string[] = [];
  for (const prop of ['color', 'border-top-color', 'border-radius', 'padding-top', 'padding-left', 'font-size', 'font-family'] as const) {
    const ok = loopProto.style[prop] === loopApp.style[prop];
    if (!ok) failures.push(`loopChip.${prop}: prototype ${loopProto.style[prop]} vs app ${loopApp.style[prop]}`);
    loopRows.push(`| ${prop} | ${loopProto.style[prop]} | ${loopApp.style[prop]} | ${ok ? 'ok' : 'FAIL'} |`);
  }
  if (loopProto.text !== loopApp.text) failures.push(`loopChip.text: prototype ${JSON.stringify(loopProto.text)} vs app ${JSON.stringify(loopApp.text)}`);

  // Back on free-talk-feature for the SPEC token checks and the captures.
  await openProtoSession(protoPage, 'free-talk-feature');
  await openAppSession(appPage, 'free-talk-feature');
  const computed = await appPage.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const header = style('.sb-sv-header');
    const name = style('.sb-sv-name');
    const root = style('.sb-sv-root');
    const action = style('.sb-sv-action');
    const chip = style('.sb-sv-chip');
    const chipKey = style('.sb-sv-chip-k');
    const selected = style('.sb-sv-tab[aria-selected="true"]');
    const tab = style('.sb-sv-tab[aria-selected="false"]');
    const dot = style('.sb-sv-dot');
    const view = style('.sb-sv');
    return {
      grid: view.gridTemplateColumns,
      headerBorder: `${header.borderBottomWidth} ${header.borderBottomStyle} ${header.borderBottomColor}`,
      headerPadding: `${header.paddingTop} ${header.paddingRight} ${header.paddingBottom} ${header.paddingLeft}`,
      headerGap: header.rowGap,
      nameFont: `${name.fontWeight} ${name.fontSize}`,
      rootFont: `${root.fontSize} ${root.fontFamily}`,
      rootColor: root.color,
      actionBorder: `${action.borderTopWidth} ${action.borderTopStyle} ${action.borderTopColor}`,
      actionRadius: action.borderTopLeftRadius,
      actionPadding: `${action.paddingTop} ${action.paddingLeft}`,
      actionFont: `${action.fontSize} ${action.color}`,
      chipBorder: `${chip.borderTopWidth} ${chip.borderTopStyle} ${chip.borderTopColor}`,
      chipRadius: chip.borderTopLeftRadius,
      chipPadding: `${chip.paddingTop} ${chip.paddingLeft}`,
      chipFont: `${chip.fontSize} ${chip.fontFamily}`,
      chipKeyColor: chipKey.color,
      tabSelected: `${selected.borderBottomWidth} ${selected.borderBottomColor} ${selected.color}`,
      tabOther: `${tab.borderBottomColor} ${tab.color}`,
      tabFont: tab.fontSize,
      dot: `${dot.width} ${dot.height} ${dot.borderTopLeftRadius}`,
    };
  });
  const [needColor] = await canonicalColors(appPage, ['oklch(0.8 0.14 70)']);
  const dotColor = await appPage.evaluate(() => getComputedStyle(document.querySelector('.sb-sv-dot')!).backgroundColor);
  if (dotColor !== needColor) failures.push(`dot color: expected ${needColor} (need), got ${dotColor}`);
  const expected: Record<string, string> = {
    grid: '804px 380px',
    headerBorder: `1px solid ${hexToRgb('#232428')}`,
    headerPadding: '13px 22px 0px 22px',
    headerGap: '9px',
    nameFont: '600 15px',
    rootFont: '11.5px "Geist Mono", monospace',
    rootColor: hexToRgb('#8d8c87'),
    actionBorder: `1px solid ${hexToRgb('#2c2d32')}`,
    actionRadius: '6px',
    actionPadding: '5px 10px',
    actionFont: `12px ${hexToRgb('#c9c8c3')}`,
    chipBorder: `1px solid ${hexToRgb('#2c2d32')}`,
    chipRadius: '5px',
    chipPadding: '2px 8px',
    chipFont: '11.5px "Geist Mono", monospace',
    chipKeyColor: hexToRgb('#76756f'),
    tabSelected: `2px ${hexToRgb('#e8e7e3')} ${hexToRgb('#f0efeb')}`,
    tabOther: `rgba(0, 0, 0, 0) ${hexToRgb('#8d8c87')}`,
    tabFont: '13px',
    dot: '8px 8px 50%',
  };
  const computedRows: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = computed[key as keyof typeof computed];
    if (got !== want) failures.push(`computed ${key}: expected ${want}, got ${got}`);
    computedRows.push(`| ${key} | ${want} | ${got} | ${got === want ? 'ok' : 'FAIL'} |`);
  }

  // Advisory pixel diff + side-by-side captures: the header strip, the view, the page.
  const headerClip = { x: 256, y: 0, width: 804, height: Math.ceil((shot['header']?.box.height ?? 110) + 1) };
  const viewClip = { x: 256, y: 0, width: 1184, height: 900 };
  const protoHeader = await protoPage.screenshot({ clip: headerClip });
  const appHeader = await appPage.screenshot({ clip: headerClip });
  const protoView = await protoPage.screenshot({ clip: viewClip });
  const appView = await appPage.screenshot({ clip: viewClip });
  const headerDiff = await pixelDiff(appPage, protoHeader, appHeader);
  const viewDiff = await pixelDiff(appPage, protoView, appView);
  await writeReport({
    'session-header.md': report({
      rows,
      knownRows,
      loopRows,
      computedRows,
      failures,
      header: headerDiff.percent,
      view: viewDiff.percent,
      chipLines: [
        `calendar-func-fix · prototype: ${calendar.protoChips.filter(Boolean).join(' · ')} · app: ${calendar.appChips.filter(Boolean).join(' · ')}`,
        `free-talk-feature · prototype: ${freeTalk.protoChips.filter(Boolean).join(' · ')} · app: ${freeTalk.appChips.filter(Boolean).join(' · ')}`,
      ],
    }),
    'session-header-side-by-side.png': await sideBySide(appPage, protoHeader, appHeader),
    'session-view-side-by-side.png': await sideBySide(appPage, protoView, appView),
  });

  expect(failures).toEqual([]);
});

/** Opens button-rollout and measures its loop chip (prototype: 3rd chip; app: the chip marked loop). */
async function openLoopChip(page: Page, which: 'proto' | 'app'): Promise<Part> {
  if (which === 'proto') {
    await openProtoSession(page, 'button-rollout');
    const measured = await measure(page, { loop: [...CHIPS, 2] });
    return measured['loop'] as Part;
  }
  await openAppSession(page, 'button-rollout');
  const index = await page.getByTestId('session-chip').evaluateAll((chips) => chips.findIndex((chip) => chip.getAttribute('data-loop') === 'true'));
  const measured = await measure(page, { loop: [...CHIPS, index] });
  return measured['loop'] as Part;
}

/** D33: the actions group keeps the prototype's right edge, y and height (it grows to the left by Close). */
function actionsBoxIssues(name: string, proto: Part['box'], app: Part['box']): string[] {
  const checks: Array<[string, number, number]> = [
    ['right', proto.x + proto.width, app.x + app.width],
    ['y', proto.y, app.y],
    ['height', proto.height, app.height],
  ];
  return checks.filter(([, a, b]) => Math.abs(a - b) > 2).map(([edge, a, b]) => `${name}.${edge}: prototype ${round(a)} vs app ${round(b)}`);
}

function fmtBox(part: Part): string {
  const { x, y, width, height } = part.box;
  return `${round(x)},${round(y)} ${round(width)}×${round(height)}`;
}

function report(input: {
  rows: string[];
  knownRows: string[];
  loopRows: string[];
  computedRows: string[];
  failures: string[];
  header: number;
  view: number;
  chipLines: string[];
}): string {
  return `# Visual oracle · Session header (M4.1)

Generated by \`tests/e2e/visual/session-header.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`), 1440×900, \`/sessions/calendar-func-fix\` and \`/sessions/free-talk-feature\` (Chat tab).
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, the same sessions opened from their sidebar rows.

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff (advisory, channel threshold 24): header strip (256,0 804×header) **${input.header.toFixed(2)}%**, session view (256,0 1184×900) **${input.view.toFixed(2)}%**.
The view below the header differs by design in this item: the Chat tab (M4.2) and the right panel's agent cards and terminal tail (M4.3) are later items; M4.1's handoff card sits at the top of the panel until then.

Side by side (prototype left, app right): \`session-header-side-by-side.png\` (header strip), \`session-view-side-by-side.png\` (view).

## Boxes (±2 px), copy and computed styles
Geometry: \`box\` = x, y, width, height; \`size\` = x, width, height. Styles compared: ${COMPARED_STYLES.join(', ')}.

| Session | Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|---|
${input.rows.join('\n')}

D33: the app's actions start with **Close** (not in the prototype). Pause and "⇄ Continue in terminal" are compared with the prototype's (they are one place later in the app); the actions group by its right edge, y and height, its copy being "Close" + the prototype's; Close itself with Pause's y, height and computed styles, 6 px left of Pause.

On free-talk-feature the prototype's chip row wraps to two lines (its hand-written chips), so the chip row, the header and the tabs are compared relative to the chip row there (\`relative\` rows: same position and width, same gap to the tabs, same header height without the chip row); on calendar-func-fix every box is compared absolutely.

## Chips
${input.chipLines.map((line) => `- ${line}`).join('\n')}

Chips 0–2 are gated above. Known differences, not findings (D13, no data source; \`docs/derivations.md\` → *Session chips*): free-talk-feature's \`bp 360\` and \`run workflow 7f3a · reconcile\` are hand-written mock chips (the app shows the chips it can derive, so \`scope\` moves up to the 4th place); calendar-func-fix's scope is the hand-written path \`functions/calendar-func\` where the app shows the solution name.

| Session | Chip | Prototype | App |
|---|---|---|---|
${input.knownRows.join('\n')}

## Loop chip (button-rollout)
| Style | Prototype | App | Result |
|---|---|---|---|
${input.loopRows.join('\n')}

## SPEC tokens (computed)
| Check | Expected | App | Result |
|---|---|---|---|
${input.computedRows.join('\n')}

## Findings
${input.failures.length ? input.failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}
