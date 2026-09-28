import { type Browser, type Page, expect, test } from '@playwright/test';
import {
  BOX_TOLERANCE_PX,
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
 *
 * D14 addition (not a finding): the handoff card ends with the folder to run the
 * command in (`cwd <Session.cwd>`), which the prototype does not have. The card
 * is compared by x, y and width (geometry `top`) with its prototype copy (the
 * text before that line); the line is checked on its own ({@link D14_CWD}).
 *
 * D21 addition (not a finding): the agent overview is the app panel's first child
 * (the prototype has none), so every prototype part is the app's next sibling
 * ({@link appPath}) and sits lower by the overview's height. The prototype's parts
 * are compared at their boxes with that one vertical offset taken out
 * ({@link overviewOffset}: x, width and height as they are, y relative to the
 * panel's parts under the overview), exactly as before otherwise; the overview is
 * checked on its own ({@link checkOverview}).
 *
 * D27 addition (not a finding): the demo's chat prints no status table, so the
 * prototype comparisons are unchanged. The reported table is checked on its own
 * ({@link checkReported}) on a separate page of the same demo session whose
 * `GET /api/sessions/free-talk-feature` answer carries a `reportedTable` (the box
 * table an orchestrator printed): drawn as a table under the derived one, with its
 * tokens, the columns' shares, the Status colors and dots, and nothing in the
 * panel wider than the panel, also with the "as printed" popover open.
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

/** D21: the agent overview, the app panel's first child (the app only). */
const OVERVIEW = [...PANEL, 0] as const;

/** D21: the app path of a prototype path: under the panel, one sibling further (after the overview). */
function appPath(path: readonly number[]): number[] {
  const out = [...path];
  const at = PANEL.length;
  if (out.length > at && PANEL.every((index, i) => out[i] === index)) out[at] = (out[at] ?? 0) + 1;
  return out;
}

/** D21: how much lower the prototype's parts sit in the app (the overview's height: it starts at the panel's top). */
async function overviewOffset(appPage: Page): Promise<number> {
  const parts = await measure(appPage, { panel: [...PANEL], overview: [...OVERVIEW] });
  const panel = parts['panel'];
  const overview = parts['overview'];
  if (!panel || !overview) throw new Error('the app panel or its agent overview is missing');
  return overview.box.y + overview.box.height - panel.box.y;
}

/** An app part's box with the overview's offset taken out (the panel itself is not moved). */
function unshifted(box: Box, dy: number): Box {
  return { ...box, y: box.y - dy };
}

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
  handoff: { path: HANDOFF, geometry: 'top', copy: false },
  handoffHead: { path: [...HANDOFF, 0], geometry: 'box', copy: true },
  handoffState: { path: [...HANDOFF, 0, 0], geometry: 'box', copy: true },
  handoffText: { path: [...HANDOFF, 1], geometry: 'box', copy: true },
  handoffCommand: { path: [...HANDOFF, 2], geometry: 'box', copy: true },
};

/** D14: the handoff card's cwd line (the app only): its path and its copy (`cwd <the demo's folder>`). */
const D14_CWD = { path: [...HANDOFF, 3], text: 'cwd D:\\acme' } as const;

/**
 * The handoff card's own copy (D14): the prototype's card text against the app's
 * without the cwd line, and the cwd line itself, recorded as a D14 addition.
 */
async function compareHandoffCopy(protoPage: Page, appPage: Page, label: string, failures: string[]): Promise<string[]> {
  const p = (await measure(protoPage, { card: [...HANDOFF] }))['card'];
  const a = await measure(appPage, { card: appPath(HANDOFF), cwd: appPath(D14_CWD.path) });
  const card = a['card'];
  const cwd = a['cwd'];
  const rows: string[] = [];
  const appCard = card && cwd ? card.text.slice(0, card.text.length - cwd.text.length).trim() : (card?.text ?? '');
  const copyOk = p !== null && p !== undefined && p.text === appCard;
  if (!copyOk) failures.push(`${label} handoff.text (without the D14 cwd line): prototype ${JSON.stringify(p?.text)} vs app ${JSON.stringify(appCard)}`);
  rows.push(`| ${label} | handoff (copy without the D14 cwd line) | none | — | — | ${copyOk ? 'ok' : 'FAIL'} | ${JSON.stringify(appCard).slice(0, 70)} |`);
  const cwdOk = cwd?.text === D14_CWD.text && cwd.box.height > 0 && card !== null && card !== undefined && cwd.box.y + cwd.box.height <= card.box.y + card.box.height;
  if (!cwdOk) failures.push(`${label} handoff cwd line (D14): expected ${JSON.stringify(D14_CWD.text)} inside the card, got ${JSON.stringify(cwd?.text ?? null)}`);
  rows.push(`| ${label} | handoff cwd line (D14 addition, not in the prototype) | — | — | ${cwd ? fmtBox(cwd.box) : 'missing'} | ${cwdOk ? 'ok' : 'FAIL'} | ${JSON.stringify(cwd?.text ?? '')} |`);
  return rows;
}

/**
 * The copy control, second child of the command row on both pages: the prototype's
 * runtime wraps the interpolated id (`claude --resume {{ ss.rid }}`) in an element
 * before the copy span; the app has the command text span before the copy button.
 */
const COPY_PROTO = [...HANDOFF, 2, 1] as const;
const COPY_APP = appPath([...HANDOFF, 2, 1]);

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

/**
 * Measures `parts` on both pages and gates them (boxes, copy, computed styles);
 * D21: the app's parts at their {@link appPath}, their y without the overview's offset.
 */
async function compare(protoPage: Page, appPage: Page, label: string, parts: Readonly<Record<string, PartSpec>>, failures: string[]): Promise<string[]> {
  const paths = Object.fromEntries(Object.entries(parts).map(([name, spec]) => [name, spec.path]));
  const proto = await measure(protoPage, paths);
  const dy = await overviewOffset(appPage);
  const measured = await measure(appPage, Object.fromEntries(Object.entries(parts).map(([name, spec]) => [name, appPath(spec.path)])));
  const shot = Object.fromEntries(
    Object.entries(measured).map(([name, part]) => [name, part && name !== 'panel' ? { ...part, box: unshifted(part.box, dy) } : part]),
  );
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
    const measured = (await measure(appPage, { copy: [...COPY_APP] }))['copy'];
    const a = measured ? { ...measured, box: unshifted(measured.box, await overviewOffset(appPage)) } : measured;
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

/** The computed color of the terminal line with `text` in the right panel (`term`: the terminal box's path on that page). */
async function lineColor(page: Page, text: string, term: readonly number[]): Promise<string | null> {
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
    { p: [...term], t: text },
  );
}

/** D21: the label styles the overview shares with the prototype's "Agents & solutions" label. */
const LABEL_STYLES = ['color', 'font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-transform'] as const;

/**
 * D21: the agent overview on its own (the prototype has none): its place (the
 * panel's first child, at the panel's top), its label (copy, and the prototype
 * panel label's type and x), one row per agent card in the same order, the
 * columns, the table inside the panel's width with nothing overflowing, the SPEC
 * tokens of the table, each Status cell in its agent's status color, and no printed
 * table (the demo agents print none).
 */
async function checkOverview(protoPage: Page, appPage: Page, label: string, failures: string[]): Promise<string[]> {
  const proto = (await measure(protoPage, { label: [...HEAD, 0] }))['label'];
  const app = await appPage.evaluate(
    ({ panelPath, props }) => {
      const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
        const style = getComputedStyle(el);
        return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
      });
      let panel: Element | undefined = grid;
      for (const i of panelPath) panel = panel?.children[i];
      const overview = panel?.children[0];
      const labelEl = overview?.querySelector<HTMLElement>('.sb-overview-label');
      const table = overview?.querySelector<HTMLElement>('[data-testid="overview-table"]');
      if (!(panel instanceof HTMLElement) || !(overview instanceof HTMLElement) || !labelEl || !table) return null;
      const texts = (selector: string) => [...overview.querySelectorAll(selector)].map((el) => (el.textContent ?? '').trim());
      const css = (el: Element | null | undefined, prop: string) => (el ? getComputedStyle(el).getPropertyValue(prop) : '');
      const panelBox = panel.getBoundingClientRect();
      const tableBox = table.getBoundingClientRect();
      const labelStyle = getComputedStyle(labelEl);
      const cards = [...panel.querySelectorAll('[data-testid="agent-card"]')];
      const rows = [...overview.querySelectorAll('[data-testid="overview-row"]')];
      const cell = (row: Element | undefined, id: string) => row?.querySelector(`[data-testid="${id}"]`) ?? null;
      const first = rows[0];
      return {
        testId: overview.getAttribute('data-testid'),
        top: overview.getBoundingClientRect().y - panelBox.y,
        label: (labelEl.textContent ?? '').trim(),
        labelTextX: labelEl.getBoundingClientRect().x + Number.parseFloat(labelStyle.paddingLeft),
        labelStyle: Object.fromEntries(props.map((prop) => [prop, labelStyle.getPropertyValue(prop)])),
        columns: texts('[data-testid="overview-column"]'),
        names: texts('[data-testid="overview-agent"]'),
        cardNames: cards.map((card) => (card.querySelector('[data-testid="agent-name"]')?.textContent ?? '').trim()),
        statusColors: rows.map((row) => css(cell(row, 'overview-status'), 'color')),
        cardStatusColors: cards.map((card) => css(card.querySelector('[data-testid="agent-status"]'), 'color')),
        fits: tableBox.x >= panelBox.x && tableBox.x + tableBox.width <= panelBox.x + panel.clientWidth + 0.5,
        overflow: table.scrollWidth > table.clientWidth + 0.5 || panel.scrollWidth > panel.clientWidth + 0.5,
        reported: overview.querySelectorAll('[data-testid="overview-reported"]').length,
        table: `${css(table, 'font-family')} ${css(table, 'font-size')} ${css(table, 'border-collapse')} ${css(table, 'table-layout')}`,
        header: `${css(overview.querySelector('th'), 'background-color')} ${css(overview.querySelector('th'), 'color')} ${css(overview.querySelector('th'), 'border-top-width')} ${css(overview.querySelector('th'), 'border-top-color')}`,
        cellLine: `${css(cell(first, 'overview-agent'), 'border-bottom-width')} ${css(cell(first, 'overview-agent'), 'border-bottom-color')}`,
        name: `${css(cell(first, 'overview-agent'), 'color')} ${css(cell(first, 'overview-agent'), 'text-overflow')} ${css(cell(first, 'overview-agent'), 'white-space')}`,
        desc: `${css(cell(first, 'overview-description'), 'color')} ${css(cell(first, 'overview-description'), 'text-overflow')} ${css(cell(first, 'overview-description'), 'white-space')}`,
        solution: `${css(cell(first, 'overview-solution'), 'color')} ${css(cell(first, 'overview-solution'), 'text-overflow')} ${css(cell(first, 'overview-solution'), 'white-space')}`,
      };
    },
    { panelPath: [...PANEL], props: [...LABEL_STYLES] },
  );
  if (!proto || !app) {
    failures.push(`${label} overview (D21): missing (${proto ? 'app' : 'prototype label'})`);
    return [`| ${label} | agent overview (D21) | missing | FAIL |`];
  }
  const checks: Array<[string, string, string]> = [
    ['place: the panel\'s first child, at its top', 'agent-overview 0', `${app.testId} ${round(app.top)}`],
    ['label copy', 'Agents overview', app.label],
    ['label x (the prototype label\'s)', String(round(proto.box.x)), String(round(app.labelTextX))],
    ...LABEL_STYLES.map((prop): [string, string, string] => [`label ${prop} (the prototype label\'s)`, proto.style[prop] ?? '', app.labelStyle[prop] ?? '']),
    ['columns', 'Agent,Description,Solution,Status', app.columns.join(',')],
    ['rows = the agent cards, in order', app.cardNames.join(','), app.names.join(',')],
    ['Status colors = the cards\' status colors', app.cardStatusColors.join(' / '), app.statusColors.join(' / ')],
    ['fits the panel, nothing overflows', 'true false', `${app.fits} ${app.overflow}`],
    ['no printed table (the demo prints none)', '0', String(app.reported)],
    ['table: Geist Mono 11px, collapsed, fixed', '"Geist Mono", monospace 11px collapse fixed', app.table],
    ['header: bg-card, text-2, 1px border-control', `${hexToRgb('#17181b')} ${hexToRgb('#c9c8c3')} 1px ${hexToRgb('#2c2d32')}`, app.header],
    ['cell lines: 1px border-control', `1px ${hexToRgb('#2c2d32')}`, app.cellLine],
    ['name cell: text, ellipsis', `${hexToRgb('#e8e7e3')} ellipsis nowrap`, app.name],
    ['description cell: muted, ellipsis', `${hexToRgb('#8d8c87')} ellipsis nowrap`, app.desc],
    ['solution cell: muted, ellipsis', `${hexToRgb('#8d8c87')} ellipsis nowrap`, app.solution],
  ];
  const rows: string[] = [];
  for (const [check, want, got] of checks) {
    const ok = check.startsWith('label x') ? Math.abs(Number(want) - Number(got)) <= BOX_TOLERANCE_PX : want === got;
    if (!ok) failures.push(`${label} overview (D21) ${check}: expected ${want}, got ${got}`);
    rows.push(`| ${label} | ${check} | ${want} | ${got} | ${ok ? 'ok' : 'FAIL'} |`);
  }
  return rows;
}

/** D27: the status table injected into the demo session's detail (as this session's orchestrator printed it). */
const REPORTED_BOX = [
  '┌──────────────────┬──────────────────────────────────────────────────────┬───────────────────────────────────────┬────────────┐',
  '│ Agent            │ Description                                          │ Solution                              │ Status     │',
  '├──────────────────┼──────────────────────────────────────────────────────┼───────────────────────────────────────┼────────────┤',
  '│ 1. D24 Remote    │ Remote Control toggle, link + QR, reattach on resume │ switchboard/.worktrees/remote-control │ 🟢 running │',
  '├──────────────────┼──────────────────────────────────────────────────────┼───────────────────────────────────────┼────────────┤',
  '│ 2. D25 Teleport  │ "From a remote session" → local copy in a worktree   │ switchboard/.worktrees/teleport       │ ✅ merged  │',
  '└──────────────────┴──────────────────────────────────────────────────────┴───────────────────────────────────────┴────────────┘',
].join('\n');

/** D27: the column shares of `Agent · Description · Solution · Status` (`reportedColumnWidths`). */
const REPORTED_SHARES = [18.18, 36.36, 18.18, 27.27] as const;

/**
 * D27: the reported table on its own (the prototype has none, and the demo's chat
 * prints none): a separate page of the demo's free-talk-feature whose session
 * detail carries {@link REPORTED_BOX} as its `reportedTable`. Checks its place
 * (under the derived table), the heading and toggle copy and type, the columns in
 * order and their shares, the rows' cells (the Status without its emoji), the
 * derived table's tokens, the Status colors and dots, that nothing in the panel is
 * wider than the panel, and, with "as printed" open, the popover left of the panel
 * with the whole table unwrapped and the panel still not scrolling sideways.
 */
async function checkReported(browser: Browser, failures: string[]): Promise<string[]> {
  const page = await newVisualPage(browser);
  const at = new Date(Date.now() - 3 * 60_000).toISOString();
  await page.route('**/api/sessions/free-talk-feature', async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...json, reportedTable: { text: REPORTED_BOX, format: 'box', at } } });
  });
  await openAppSession(page, 'free-talk-feature', 4);
  await expect(page.getByTestId('overview-reported-table')).toBeVisible();
  const [runColor, doneColor] = await canonicalColors(page, ['oklch(0.72 0.12 250)', 'oklch(0.74 0.13 150)']);
  const read = () =>
    page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="session-right-panel"]');
      const overview = panel?.querySelector<HTMLElement>('[data-testid="agent-overview"]');
      const reported = overview?.querySelector<HTMLElement>('[data-testid="overview-reported"]');
      const table = reported?.querySelector<HTMLElement>('[data-testid="overview-reported-table"]');
      if (!panel || !overview || !reported || !table) return null;
      const css = (el: Element | null | undefined, prop: string) => (el ? getComputedStyle(el).getPropertyValue(prop) : '');
      const texts = (root: Element, selector: string) => [...root.querySelectorAll(selector)].map((el) => (el.textContent ?? '').trim());
      const panelBox = panel.getBoundingClientRect();
      const tableBox = table.getBoundingClientRect();
      const rows = [...table.querySelectorAll('[data-testid="overview-reported-row"]')];
      const statuses = [...table.querySelectorAll<HTMLElement>('[data-kind="status"]')];
      const dots = [...table.querySelectorAll<HTMLElement>('[data-testid="overview-reported-dot"]')];
      const first = rows[0];
      const cell = (kind: string) => first?.querySelector(`[data-kind="${kind}"]`) ?? null;
      const toggle = reported.querySelector('[data-testid="overview-printed-toggle"]');
      const head = reported.querySelector('[data-testid="overview-reported-head"]');
      const popover = document.querySelector<HTMLElement>('[data-testid="overview-printed-popover"]');
      const popBox = popover?.getBoundingClientRect() ?? null;
      const pre = popover?.querySelector('pre') ?? null;
      return {
        place: [...overview.children].indexOf(reported),
        afterDerived: overview.children[reported ? [...overview.children].indexOf(reported) - 1 : 0]?.getAttribute('data-testid') ?? '',
        head: (head?.textContent ?? '').trim(),
        toggle: `${(toggle?.textContent ?? '').trim()} ${css(toggle, 'font-family')} ${css(toggle, 'font-size')} ${css(toggle, 'color')}`,
        columns: texts(table, '[data-testid="overview-reported-column"]'),
        shares: [...table.querySelectorAll('th')].map((th) => (th.getBoundingClientRect().width / tableBox.width) * 100),
        cells: rows.map((row) => texts(row, '[data-testid="overview-reported-cell"]')),
        fits: tableBox.x >= panelBox.x && tableBox.x + tableBox.width <= panelBox.x + panel.clientWidth + 0.5,
        overflow: table.scrollWidth > table.clientWidth + 0.5 || panel.scrollWidth > panel.clientWidth + 0.5,
        tableType: `${css(table, 'font-family')} ${css(table, 'font-size')} ${css(table, 'border-collapse')} ${css(table, 'table-layout')}`,
        header: `${css(table.querySelector('th'), 'background-color')} ${css(table.querySelector('th'), 'color')} ${css(table.querySelector('th'), 'border-top-width')} ${css(table.querySelector('th'), 'border-top-color')}`,
        cellLine: `${css(cell('agent'), 'border-bottom-width')} ${css(cell('agent'), 'border-bottom-color')}`,
        agent: `${css(cell('agent'), 'color')} ${css(cell('agent'), 'text-overflow')} ${css(cell('agent'), 'white-space')}`,
        text: `${css(cell('text'), 'color')} ${css(cell('text'), 'text-overflow')} ${css(cell('text'), 'white-space')}`,
        statusColors: statuses.map((el) => css(el, 'color')),
        dotColors: dots.map((el) => css(el, 'background-color')),
        dot: `${css(dots[0], 'width')} ${css(dots[0], 'height')} ${css(dots[0], 'border-top-left-radius')}`,
        popover: popBox
          ? {
              left: popBox.x >= 0 && popBox.y >= 0 && popBox.x + popBox.width <= panelBox.x && popBox.y + popBox.height <= window.innerHeight,
              unwrapped: pre ? `${css(pre, 'white-space')} ${pre.scrollWidth <= pre.clientWidth}` : 'none',
              text: (pre?.textContent ?? '').replace(/\n$/, ''),
              look: `${css(popover, 'background-color')} ${css(popover, 'border-top-color')} ${css(popover, 'border-top-left-radius')}`,
            }
          : null,
      };
    });
  const closed = await read();
  await page.getByTestId('overview-printed-toggle').click();
  await expect(page.getByTestId('overview-printed-popover')).toBeVisible();
  const open = await read();
  await page.context().close();
  if (!closed || !open) {
    failures.push('free-talk-feature reported table (D27): missing');
    return ['| free-talk-feature | reported table (D27) | present | missing | FAIL |'];
  }
  const shareOk = closed.shares.length === REPORTED_SHARES.length && closed.shares.every((share, i) => Math.abs(share - (REPORTED_SHARES[i] ?? 0)) <= 0.5);
  const checks: Array<[string, string, string, boolean?]> = [
    ['place: under the derived table, in the overview', '2 overview-table', `${closed.place} ${closed.afterDerived}`],
    ['heading copy', 'As reported by the agent · 3m', closed.head],
    ['toggle: copy, mono 11px muted', `as printed "Geist Mono", monospace 11px ${hexToRgb('#8d8c87')}`, closed.toggle],
    ['columns: every printed one, in order', 'Agent,Description,Solution,Status', closed.columns.join(',')],
    ['column shares % (±0.5)', REPORTED_SHARES.join(' / '), closed.shares.map((share) => share.toFixed(2)).join(' / '), shareOk],
    [
      'cells (the Status without its emoji)',
      '1. D24 Remote ¦ Remote Control toggle, link + QR, reattach on resume ¦ switchboard/.worktrees/remote-control ¦ running ; 2. D25 Teleport ¦ "From a remote session" → local copy in a worktree ¦ switchboard/.worktrees/teleport ¦ merged',
      closed.cells.map((row) => row.join(' ¦ ')).join(' ; '),
    ],
    ['fits the panel, nothing overflows', 'true false', `${closed.fits} ${closed.overflow}`],
    ['table: Geist Mono 11px, collapsed, fixed (the derived table\'s)', '"Geist Mono", monospace 11px collapse fixed', closed.tableType],
    ['header: bg-card, text-2, 1px border-control', `${hexToRgb('#17181b')} ${hexToRgb('#c9c8c3')} 1px ${hexToRgb('#2c2d32')}`, closed.header],
    ['cell lines: 1px border-control', `1px ${hexToRgb('#2c2d32')}`, closed.cellLine],
    ['Agent cells: text, ellipsis', `${hexToRgb('#e8e7e3')} ellipsis nowrap`, closed.agent],
    ['other cells: muted, ellipsis', `${hexToRgb('#8d8c87')} ellipsis nowrap`, closed.text],
    ['Status colors: run, done', `${runColor} / ${doneColor}`, closed.statusColors.join(' / ')],
    ['Status dots: run, done', `${runColor} / ${doneColor}`, closed.dotColors.join(' / ')],
    ['Status dot: 7px circle (the agent card\'s)', '7px 7px 50%', closed.dot],
    ['"as printed": popover left of the panel, inside the window', 'true', String(open.popover?.left ?? false)],
    ['"as printed": the whole table unwrapped (no scrolling at 1440)', 'pre true', open.popover?.unwrapped ?? 'none'],
    ['"as printed": the text as printed', 'equal', open.popover?.text === REPORTED_BOX ? 'equal' : JSON.stringify(open.popover?.text ?? '').slice(0, 60)],
    ['"as printed": bg-card, border-card, 10px radius', `${hexToRgb('#17181b')} ${hexToRgb('#26272c')} 10px`, open.popover?.look ?? 'none'],
    ['"as printed" open: nothing in the panel overflows', 'true false', `${open.fits} ${open.overflow}`],
  ];
  const rows: string[] = [];
  for (const [check, want, got, verdict] of checks) {
    const ok = verdict ?? want === got;
    if (!ok) failures.push(`free-talk-feature reported table (D27) ${check}: expected ${want}, got ${got}`);
    rows.push(`| free-talk-feature | ${check} | ${want} | ${got} | ${ok ? 'ok' : 'FAIL'} |`);
  }
  return rows;
}

test('Right panel matches the prototype (agent cards, summary, terminal tail, handoff card + copy)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  const failures: string[] = [];
  const rows: string[] = [];
  const overviewRows: string[] = [];
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
  rows.push(...(await compareHandoffCopy(protoPage, appPage, 'free-talk-feature', failures)));
  rows.push(...(await compareCopy(protoPage, appPage, 'free-talk-feature', failures)));
  overviewRows.push(...(await checkOverview(protoPage, appPage, 'free-talk-feature', failures)));
  const protoFree = await protoPage.screenshot({ clip: panelClip });
  const appFree = await appPage.screenshot({ clip: panelClip });
  const freeDiff = await pixelDiff(appPage, protoFree, appFree);

  // 2. calendar-func-fix: 1 card with a branch, `$` / output lines and the cursor (status run).
  await openProtoSession(protoPage, 'calendar-func-fix');
  await openAppSession(appPage, 'calendar-func-fix', 1);
  await expect(appPage.getByTestId('terminal-line')).toHaveText(['$ dotnet build', 'CS0103 TimeZoneInfo not found → add using System', '$ dotnet build', '▍']);
  rows.push(...(await compare(protoPage, appPage, 'calendar-func-fix', { ...FRAME_PARTS, ...cardParts(0, true), ...lineParts(4) }, failures)));
  rows.push(...(await compareHandoffCopy(protoPage, appPage, 'calendar-func-fix', failures)));
  overviewRows.push(...(await checkOverview(protoPage, appPage, 'calendar-func-fix', failures)));
  const protoCalendar = await protoPage.screenshot({ clip: panelClip });
  const appCalendar = await appPage.screenshot({ clip: panelClip });
  const calendarDiff = await pixelDiff(appPage, protoCalendar, appCalendar);

  // 3. button-rollout: the ✕ tone (prototype lineColor) on the same line text.
  await openProtoSession(protoPage, 'button-rollout');
  await openAppSession(appPage, 'button-rollout', 3);
  const failLine = '✕ figma: no variant State=Loading';
  const [protoFail, appFail] = [await lineColor(protoPage, failLine, TERM), await lineColor(appPage, failLine, appPath(TERM))];
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
    const label = style('.sb-sv-panel-head .sb-sv-panel-label');
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

  // D27: the reported table on its own (a separate page; the demo prints none).
  const reportedRows = await checkReported(browser, failures);

  await writeReport({
    'session-panel.md': report({
      rows,
      computedRows,
      overviewRows,
      reportedRows,
      failures,
      diffs: { free: freeDiff.percent, calendar: calendarDiff.percent },
      rollout: { proto: protoRollout, app: appRollout },
    }),
    'session-panel-free-talk-side-by-side.png': await sideBySide(appPage, protoFree, appFree),
    'session-panel-calendar-side-by-side.png': await sideBySide(appPage, protoCalendar, appCalendar),
  });

  expect(failures).toEqual([]);
});

function report(input: {
  rows: string[];
  computedRows: string[];
  overviewRows: string[];
  reportedRows: string[];
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
Geometry \`box\` = x, y, width, height (every part is absolute: the panel does not depend on the header's height); \`top\` = x, y, width. Styles compared: ${COMPARED_STYLES.join(', ')}. D21: the app column shows each part's box with the agent overview's height taken out of y (the overview is the app panel's first child, above every prototype part; see *D21 additions*).

| Session | Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|---|
${input.rows.join('\n')}

## SPEC tokens (computed)
| Check | Expected | App | Result |
|---|---|---|---|
${input.computedRows.join('\n')}

## D21 additions (not findings)
- The panel starts with the **agent overview** (\`Agents overview\` label, the derived Agent · Description · Solution · Status table, and the newest printed status table when the agent printed one). The prototype has no overview, so every prototype part is the app panel's next sibling and sits lower by the overview's height; the parts are compared at the prototype's boxes with that one vertical offset taken out (x, width and height unchanged), the way D18 checked its added Name row. The overview is checked on its own:

| Session | Check | Expected | App | Result |
|---|---|---|---|---|
${input.overviewRows.join('\n')}

## D27 additions (not findings)
- The newest status table the agent printed is drawn as a table under "As reported by the agent · <age>", with an "as printed" toggle that opens the original in a popover over the main area; nothing in the right panel scrolls sideways. The demo's chat prints no status table, so nothing above changes. The table is checked on its own on a separate page of free-talk-feature whose session detail carries this session's orchestrator table (4 columns, \`├─┼─┤\` rows, 🟢 / ✅ statuses) as its \`reportedTable\`:

| Session | Check | Expected | App | Result |
|---|---|---|---|---|
${input.reportedRows.join('\n')}

## D14 additions (not findings)
- The handoff card ends with \`cwd <Session.cwd>\`: the folder to run \`claude --resume\` in (a repo session's worktree, D14). The card is compared by x, y and width (geometry \`top\`) and by its prototype copy without that line; the line is checked on its own.

## Known differences (not findings)
- button-rollout's tail starts with the chat's open request step (the demo seed makes the prototype's \`⏸ breaker: …\` chat line an open permission request, M4.2, which the tail shows like every open request): prototype ${JSON.stringify(input.rollout.proto)}, app ${JSON.stringify(input.rollout.app)}.
- The prototype's cursor \`▍\` is mock data; the app adds it while the session's status is \`run\` (both compared sessions agree).

## Findings
${input.failures.length ? input.failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}
