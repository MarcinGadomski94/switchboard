import { type Page, expect, test } from '@playwright/test';
import {
  type Box,
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
 * Visual oracle for the session view's right panel (M4.3, D10): the app (demo
 * seed) against the prototype with the same session open (its sidebar row),
 * 1440×900, `simulateIncoming` off, on `free-talk-feature` (the prototype's
 * default: 4 agent cards, 6 terminal lines with ✓ / ⚠ / ⏸ tones) and
 * `calendar-func-fix` (1 card, `$` / output lines and the running cursor `▍`).
 * The panel does not depend on the header's height, so every box is absolute.
 * Gate: boxes ±2 px, exact copy and equal computed styles for the header, every
 * card (dot, name, description, status, path, ⎇ branch), the "Terminal" label,
 * the terminal box and each line, and the handoff card (state, text, command,
 * copy → "copied"); SPEC tokens as computed styles; the ✕ tone on
 * `button-rollout`. The pixel diff is advisory (`docs/visual/session-panel.md`).
 */

interface PartSpec {
  readonly path: readonly number[];
  readonly geometry: Geometry;
  readonly copy: boolean;
}

const PANEL = [1, 0, 1] as const;
const HEAD = [...PANEL, 0] as const;
const CARDS = [...PANEL, 1] as const;
const TERM = [...PANEL, 3] as const;
const HANDOFF = [...PANEL, 4] as const;

function cardParts(index: number, branch: boolean): Record<string, PartSpec> {
  const base = [...CARDS, index];
  return {
    [`card${index}`]: { path: base, geometry: 'box', copy: true },
    [`card${index}Top`]: { path: [...base, 0], geometry: 'box', copy: true },
    [`card${index}Dot`]: { path: [...base, 0, 0], geometry: 'box', copy: false },
    [`card${index}Name`]: { path: [...base, 0, 1], geometry: 'box', copy: true },
    [`card${index}Desc`]: { path: [...base, 0, 2], geometry: 'box', copy: true },
    [`card${index}Status`]: { path: [...base, 0, 3], geometry: 'box', copy: true },
    [`card${index}Where`]: { path: [...base, 1], geometry: 'box', copy: true },
    [`card${index}Path`]: { path: [...base, 1, 0], geometry: 'box', copy: true },
    ...(branch ? { [`card${index}Branch`]: { path: [...base, 1, 1], geometry: 'box', copy: true } as PartSpec } : {}),
  };
}

function lineParts(count: number): Record<string, PartSpec> {
  const out: Record<string, PartSpec> = {};
  for (let i = 0; i < count; i += 1) out[`line${i}`] = { path: [...TERM, i], geometry: 'box', copy: true };
  return out;
}

/** Everything but the cards and lines (both sessions). */
const FRAME_PARTS: Readonly<Record<string, PartSpec>> = {
  panel: { path: PANEL, geometry: 'box', copy: false },
  head: { path: HEAD, geometry: 'box', copy: false },
  label: { path: [...HEAD, 0], geometry: 'box', copy: true },
  summary: { path: [...HEAD, 1], geometry: 'box', copy: true },
  cards: { path: CARDS, geometry: 'box', copy: false },
  termLabel: { path: [...PANEL, 2], geometry: 'box', copy: true },
  term: { path: TERM, geometry: 'box', copy: true },
  handoff: { path: HANDOFF, geometry: 'box', copy: true },
  handoffHead: { path: [...HANDOFF, 0], geometry: 'box', copy: true },
  handoffState: { path: [...HANDOFF, 0, 0], geometry: 'box', copy: true },
  handoffText: { path: [...HANDOFF, 1], geometry: 'box', copy: true },
  handoffCommand: { path: [...HANDOFF, 2], geometry: 'box', copy: true },
};

/**
 * The copy control, second child of the command row on both pages: the prototype's
 * runtime wraps the interpolated id (`claude --resume {{ ss.rid }}`) in an element
 * before the copy span; the app has the command text span before the copy button.
 */
const COPY_PROTO = [...HANDOFF, 2, 1] as const;
const COPY_APP = [...HANDOFF, 2, 1] as const;

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
  'padding-right',
  'padding-bottom',
  'padding-left',
] as const;

let app: DemoApp;

test.beforeAll(async () => {
  app = await startDemoApp();
});

test.afterAll(async () => {
  await app?.stop();
});

async function openProtoSession(page: Page, name: string): Promise<void> {
  await page.getByText(name, { exact: true }).first().click();
  await page.getByText('Agents & solutions', { exact: true }).waitFor();
  await page.getByText('Terminal', { exact: true }).waitFor();
}

async function openAppSession(page: Page, name: string, cards: number): Promise<void> {
  await openApp(page, app.baseUrl, `/sessions/${name}`);
  await expect(page.getByTestId('session-name')).toHaveText(name);
  await expect(page.getByTestId('agent-card')).toHaveCount(cards);
}

function fmtBox(box: Box): string {
  return `${round(box.x)},${round(box.y)} ${round(box.width)}×${round(box.height)}`;
}

function styleIssues(label: string, p: Part, a: Part): string[] {
  return COMPARED_STYLES.filter((prop) => p.style[prop] !== a.style[prop]).map((prop) => `${label}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
}

/** Measures `parts` on both pages and gates them (boxes, copy, computed styles). */
async function compare(protoPage: Page, appPage: Page, label: string, parts: Readonly<Record<string, PartSpec>>, failures: string[]): Promise<string[]> {
  const paths = Object.fromEntries(Object.entries(parts).map(([name, spec]) => [name, spec.path]));
  const proto = await measure(protoPage, paths);
  const shot = await measure(appPage, paths);
  const rows: string[] = [];
  for (const [name, spec] of Object.entries(parts)) {
    const p = proto[name];
    const a = shot[name];
    if (!p || !a) {
      failures.push(`${label} ${name}: missing (${p ? 'app' : 'prototype'})`);
      rows.push(`| ${label} | ${name} | ${spec.geometry} | ${p ? fmtBox(p.box) : 'missing'} | ${a ? fmtBox(a.box) : 'missing'} | FAIL | |`);
      continue;
    }
    const issues = [
      ...compareBoxes(`${label} ${name}`, p.box, a.box, spec.geometry),
      ...(spec.copy && p.text !== a.text ? [`${label} ${name}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`] : []),
      ...styleIssues(`${label} ${name}`, p, a),
    ];
    failures.push(...issues);
    rows.push(`| ${label} | ${name} | ${spec.geometry} | ${fmtBox(p.box)} | ${fmtBox(a.box)} | ${issues.length ? 'FAIL' : 'ok'} | ${spec.copy ? JSON.stringify(a.text).slice(0, 70) : ''} |`);
  }
  return rows;
}

/** The copy control on both pages: box, copy and styles, before and after a click ("copied"). */
async function compareCopy(protoPage: Page, appPage: Page, label: string, failures: string[]): Promise<string[]> {
  const rows: string[] = [];
  for (const state of ['copy', 'copied'] as const) {
    if (state === 'copied') {
      await clickAt(protoPage, COPY_PROTO);
      await clickAt(appPage, COPY_APP);
      await expect(appPage.getByTestId('handoff-copy')).toHaveText('copied');
      await protoPage.getByText('copied', { exact: true }).waitFor();
    }
    const p = (await measure(protoPage, { copy: [...COPY_PROTO] }))['copy'];
    const a = (await measure(appPage, { copy: [...COPY_APP] }))['copy'];
    if (!p || !a) {
      failures.push(`${label} copy (${state}): missing`);
      rows.push(`| ${label} | copy (${state}) | box | missing | missing | FAIL | |`);
      continue;
    }
    const issues = [
      ...compareBoxes(`${label} copy (${state})`, p.box, a.box, 'box'),
      ...(p.text !== a.text || a.text !== state ? [`${label} copy (${state}).text: prototype ${p.text} vs app ${a.text}`] : []),
      ...styleIssues(`${label} copy (${state})`, p, a),
    ];
    failures.push(...issues);
    rows.push(`| ${label} | copy (${state}) | box | ${fmtBox(p.box)} | ${fmtBox(a.box)} | ${issues.length ? 'FAIL' : 'ok'} | ${JSON.stringify(a.text)} |`);
  }
  // Both go back to "copy" after 1.5 s.
  await expect(appPage.getByTestId('handoff-copy')).toHaveText('copy');
  await protoPage.getByText('copy', { exact: true }).waitFor();
  return rows;
}

async function clickAt(page: Page, path: readonly number[]): Promise<void> {
  await page.evaluate((p) => {
    const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
      const style = getComputedStyle(el);
      return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
    });
    let el: Element | undefined = grid;
    for (const i of p) el = el?.children[i];
    if (!(el instanceof HTMLElement)) throw new Error(`nothing at ${p.join(',')}`);
    el.click();
  }, [...path]);
}

/** The computed color of the terminal line with `text` in the right panel. */
async function lineColor(page: Page, text: string): Promise<string | null> {
  return page.evaluate(
    ({ p, t }) => {
      const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
        const style = getComputedStyle(el);
        return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
      });
      let el: Element | undefined = grid;
      for (const i of p) el = el?.children[i];
      const line = [...(el?.children ?? [])].find((child) => (child.textContent ?? '').trim() === t);
      return line ? getComputedStyle(line).color : null;
    },
    { p: [...TERM], t: text },
  );
}

test('Right panel matches the prototype (agent cards, summary, terminal tail, handoff card + copy)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  const failures: string[] = [];
  const rows: string[] = [];
  await openPrototype(protoPage, { simulateIncoming: false });
  const panelClip = { x: 1060, y: 0, width: 380, height: 900 };

  // 1. free-talk-feature: 4 cards (2 with a branch), 6 lines (✓ / ⚠ / ⏸ tones).
  await openProtoSession(protoPage, 'free-talk-feature');
  await openAppSession(appPage, 'free-talk-feature', 4);
  await expect(appPage.getByTestId('terminal-line')).toHaveCount(6);
  rows.push(
    ...(await compare(
      protoPage,
      appPage,
      'free-talk-feature',
      { ...FRAME_PARTS, ...cardParts(0, false), ...cardParts(1, true), ...cardParts(2, true), ...cardParts(3, false), ...lineParts(6) },
      failures,
    )),
  );
  rows.push(...(await compareCopy(protoPage, appPage, 'free-talk-feature', failures)));
  const protoFree = await protoPage.screenshot({ clip: panelClip });
  const appFree = await appPage.screenshot({ clip: panelClip });
  const freeDiff = await pixelDiff(appPage, protoFree, appFree);

  // 2. calendar-func-fix: 1 card with a branch, `$` / output lines and the cursor (status run).
  await openProtoSession(protoPage, 'calendar-func-fix');
  await openAppSession(appPage, 'calendar-func-fix', 1);
  await expect(appPage.getByTestId('terminal-line')).toHaveText(['$ dotnet build', 'CS0103 TimeZoneInfo not found → add using System', '$ dotnet build', '▍']);
  rows.push(...(await compare(protoPage, appPage, 'calendar-func-fix', { ...FRAME_PARTS, ...cardParts(0, true), ...lineParts(4) }, failures)));
  const protoCalendar = await protoPage.screenshot({ clip: panelClip });
  const appCalendar = await appPage.screenshot({ clip: panelClip });
  const calendarDiff = await pixelDiff(appPage, protoCalendar, appCalendar);

  // 3. button-rollout: the ✕ tone (prototype lineColor) on the same line text.
  await openProtoSession(protoPage, 'button-rollout');
  await openAppSession(appPage, 'button-rollout', 3);
  const failLine = '✕ figma: no variant State=Loading';
  const [protoFail, appFail] = [await lineColor(protoPage, failLine), await lineColor(appPage, failLine)];
  const [failRed] = await canonicalColors(appPage, ['oklch(0.72 0.16 25)']);
  if (protoFail !== appFail || appFail !== failRed) failures.push(`button-rollout ✕ tone: prototype ${protoFail}, app ${appFail}, expected ${failRed}`);
  rows.push(`| button-rollout | ✕ line color | none | ${protoFail} | ${appFail} | ${protoFail === appFail && appFail === failRed ? 'ok' : 'FAIL'} | ${JSON.stringify(failLine)} |`);
  const appRollout = await appPage.getByTestId('terminal-line').allTextContents();
  const protoRollout = await protoPage.evaluate((p) => {
    const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
      const style = getComputedStyle(el);
      return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
    });
    let el: Element | undefined = grid;
    for (const i of p) el = el?.children[i];
    return [...(el?.children ?? [])].map((child) => (child.textContent ?? '').trim());
  }, [...TERM]);

  // SPEC tokens as computed styles on the app (free-talk-feature panel).
  await openAppSession(appPage, 'free-talk-feature', 4);
  const computed = await appPage.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const panel = style('.sb-sv-panel');
    const label = style('.sb-sv-panel-label');
    const summary = style('.sb-sv-panel-summary');
    const card = style('.sb-agent');
    const name = style('.sb-agent-name');
    const desc = style('.sb-agent-desc');
    const status = style('.sb-agent-status');
    const where = style('.sb-agent-where');
    const branch = style('.sb-agent-branch');
    const term = style('.sb-sv-term');
    const tone = (t: string) => getComputedStyle(document.querySelector(`.sb-term-line[data-tone="${t}"]`) ?? document.body).color;
    const handoff = style('.sb-handoff');
    return {
      panelBorder: `${panel.borderLeftWidth} ${panel.borderLeftStyle} ${panel.borderLeftColor}`,
      label: `${label.fontFamily} ${label.fontSize} ${label.fontWeight} ${label.letterSpacing} ${label.textTransform} ${label.color}`,
      summary: `${summary.fontFamily} ${summary.fontSize} ${summary.color}`,
      card: `${card.backgroundColor} ${card.borderTopWidth} ${card.borderTopColor} ${card.borderTopLeftRadius} ${card.paddingTop} ${card.paddingLeft} ${card.rowGap}`,
      name: `${name.fontSize} ${name.fontWeight}`,
      desc: `${desc.fontSize} ${desc.color} ${desc.textOverflow} ${desc.whiteSpace}`,
      status: `${status.fontFamily} ${status.fontSize} ${status.whiteSpace}`,
      where: `${where.fontFamily} ${where.fontSize} ${where.color} ${where.paddingLeft}`,
      branch: `${branch.color} ${branch.backgroundColor} ${branch.borderTopLeftRadius} ${branch.paddingTop} ${branch.paddingLeft}`,
      term: `${term.backgroundColor} ${term.borderTopWidth} ${term.borderTopColor} ${term.borderTopLeftRadius} ${term.paddingTop} ${term.paddingLeft} ${term.fontFamily} ${term.fontSize} ${term.lineHeight} ${term.minHeight}`,
      toneOk: tone('ok'),
      toneWait: tone('wait'),
      handoff: `${handoff.backgroundColor} ${handoff.borderTopColor} ${handoff.borderTopLeftRadius}`,
    };
  });
  const [branchFg, branchBg, okGreen, waitAmber] = await canonicalColors(appPage, ['oklch(0.78 0.1 250)', 'oklch(0.24 0.03 250)', 'oklch(0.78 0.12 150)', 'oklch(0.8 0.13 70)']);
  const expected: Record<string, string> = {
    panelBorder: `1px solid ${hexToRgb('#232428')}`,
    label: `"Geist Mono", monospace 10.5px 500 0.63px uppercase ${hexToRgb('#8d8c87')}`,
    summary: `"Geist Mono", monospace 11px ${hexToRgb('#6d6c67')}`,
    card: `${hexToRgb('#17181b')} 1px ${hexToRgb('#1f2024')} 8px 9px 10px 4px`,
    name: '13px 500',
    desc: `12px ${hexToRgb('#8d8c87')} ellipsis nowrap`,
    status: '"Geist Mono", monospace 11px nowrap',
    where: `"Geist Mono", monospace 11.5px ${hexToRgb('#76756f')} 15px`,
    branch: `${branchFg} ${branchBg} 4px 1px 6px`,
    term: `${hexToRgb('#0c0d0f')} 1px ${hexToRgb('#1f2024')} 8px 10px 12px "Geist Mono", monospace 11px 18.7px 150px`,
    toneOk: okGreen ?? '',
    toneWait: waitAmber ?? '',
    handoff: `${hexToRgb('#0c0d0f')} ${hexToRgb('#26272c')} 10px`,
  };
  const computedRows: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = computed[key as keyof typeof computed];
    if (got !== want) failures.push(`computed ${key}: expected ${want}, got ${got}`);
    computedRows.push(`| ${key} | ${want} | ${got} | ${got === want ? 'ok' : 'FAIL'} |`);
  }

  await writeReport({
    'session-panel.md': report({ rows, computedRows, failures, diffs: { free: freeDiff.percent, calendar: calendarDiff.percent }, rollout: { proto: protoRollout, app: appRollout } }),
    'session-panel-free-talk-side-by-side.png': await sideBySide(appPage, protoFree, appFree),
    'session-panel-calendar-side-by-side.png': await sideBySide(appPage, protoCalendar, appCalendar),
  });

  expect(failures).toEqual([]);
});

function report(input: {
  rows: string[];
  computedRows: string[];
  failures: string[];
  diffs: { free: number; calendar: number };
  rollout: { proto: string[]; app: string[] };
}): string {
  return `# Visual oracle · Session right panel (M4.3)

Generated by \`tests/e2e/visual/session-panel.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`), 1440×900, \`/sessions/free-talk-feature\` and \`/sessions/calendar-func-fix\` (and \`button-rollout\` for the ✕ tone).
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, the same sessions opened from their sidebar rows.

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff (advisory, channel threshold 24) of the right panel (1060,0 380×900): free-talk-feature **${input.diffs.free.toFixed(2)}%**, calendar-func-fix **${input.diffs.calendar.toFixed(2)}%**.

Side by side (prototype left, app right): \`session-panel-free-talk-side-by-side.png\`, \`session-panel-calendar-side-by-side.png\`.

## Boxes (±2 px), copy and computed styles
Geometry \`box\` = x, y, width, height (every part is absolute: the panel does not depend on the header's height). Styles compared: ${COMPARED_STYLES.join(', ')}.

| Session | Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|---|
${input.rows.join('\n')}

## SPEC tokens (computed)
| Check | Expected | App | Result |
|---|---|---|---|
${input.computedRows.join('\n')}

## Known differences (not findings)
- button-rollout's tail starts with the chat's open request step (the demo seed makes the prototype's \`⏸ breaker: …\` chat line an open permission request, M4.2, which the tail shows like every open request): prototype ${JSON.stringify(input.rollout.proto)}, app ${JSON.stringify(input.rollout.app)}.
- The prototype's cursor \`▍\` is mock data; the app adds it while the session's status is \`run\` (both compared sessions agree).

## Findings
${input.failures.length ? input.failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}
