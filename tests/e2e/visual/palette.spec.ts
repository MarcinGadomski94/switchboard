import { expect, type Page, test } from '@playwright/test';
import { type DemoApp, newVisualPage, openApp, openPrototype, pixelDiff, round, sideBySide, startDemoApp, writeReport } from './harness.ts';

/**
 * Visual check of the ⌘K palette (M8.3, D10): the app (demo seed) against the
 * prototype's palette at 1440×900, both opened with Ctrl+K on the Inbox. Measured
 * inside the overlay (which covers the shell on both pages): the overlay, the
 * 620px panel, the input and every result row with its kind / label / hint, as
 * boxes within ±2 px, exact copy and computed styles, in three states: the empty
 * query (10 results), the query "free" and the same after ↓ (second row
 * highlighted). Known data differences: `GET /api/tools` is M8.1 (another lane)
 * and answers 501 here, so the app's empty-query rows 8–10 are sessions where
 * the prototype lists its two tools; and a session hint is the real mode line,
 * not the prototype's mock status copy. Those parts are compared by box height
 * and styles and their copy is listed (`docs/visual/palette.md`).
 */

const STYLES = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-transform',
  'border-top-left-radius',
  'border-top-width',
  'border-top-color',
  'border-bottom-width',
  'border-bottom-color',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-left',
  'column-gap',
  'align-items',
  'display',
  'justify-content',
  'max-height',
  'overflow-y',
  'box-shadow',
  'box-sizing',
  'cursor',
  'z-index',
] as const;

interface Measured {
  readonly box: { x: number; y: number; width: number; height: number };
  readonly text: string;
  readonly style: Record<string, string>;
}

interface Snapshot {
  readonly placeholder: string | null;
  readonly focused: boolean;
  readonly rowCount: number;
  readonly parts: Record<string, Measured | null>;
}

/** Part name → child-index path from the overlay. */
function parts(rowCount: number): Record<string, readonly number[]> {
  const out: Record<string, readonly number[]> = { overlay: [], panel: [0], input: [0, 0], list: [0, 1] };
  for (let i = 0; i < rowCount; i++) {
    out[`row${i}`] = [0, 1, i];
    out[`row${i}:kind`] = [0, 1, i, 0];
    out[`row${i}:label`] = [0, 1, i, 1];
    out[`row${i}:hint`] = [0, 1, i, 2];
  }
  return out;
}

const OVERLAY = { app: '[data-modal="palette"]', prototype: '[data-proto-palette]' } as const;

/** Marks the prototype's palette overlay (the parent of the panel holding the palette input). */
async function markPrototype(page: Page): Promise<void> {
  const found = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[placeholder^="Jump to a session"]');
    const overlay = input?.parentElement?.parentElement;
    overlay?.setAttribute('data-proto-palette', '');
    return overlay !== undefined && overlay !== null;
  });
  expect(found).toBe(true);
}

async function snapshot(page: Page, which: 'app' | 'prototype', rowCount: number): Promise<Snapshot> {
  if (which === 'prototype') await markPrototype(page);
  return page.evaluate(
    ({ sel, paths, props }) => {
      const overlay = document.querySelector(sel) as HTMLElement;
      const read = (el: Element): Record<string, string> => {
        const computed = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const prop of props) style[prop] = computed.getPropertyValue(prop);
        return style;
      };
      const measured: Record<string, { box: { x: number; y: number; width: number; height: number }; text: string; style: Record<string, string> } | null> = {};
      for (const [name, path] of Object.entries(paths)) {
        let el: Element | undefined = overlay;
        for (const index of path) el = el?.children[index];
        if (!el) {
          measured[name] = null;
          continue;
        }
        const r = el.getBoundingClientRect();
        measured[name] = { box: { x: r.x, y: r.y, width: r.width, height: r.height }, text: el.textContent ?? '', style: read(el) };
      }
      const input = overlay.querySelector('input');
      return {
        placeholder: input?.getAttribute('placeholder') ?? null,
        focused: document.activeElement === input,
        rowCount: overlay.children[0]?.children[1]?.children.length ?? 0,
        parts: measured,
      };
    },
    { sel: OVERLAY[which], paths: parts(rowCount), props: STYLES as readonly string[] },
  );
}

let app: DemoApp;

test.beforeAll(async () => {
  app = await startDemoApp();
});

test.afterAll(async () => {
  await app?.stop();
});

const TOL = 2;

interface StateResult {
  readonly name: string;
  readonly compared: number;
  readonly rows: string[];
  readonly listed: string[];
}

/**
 * How a row with known data differences is compared: `row` = its copy is data
 * (the kind label is still gated; the label and hint boxes follow the copy), `hint`
 * = only the hint's copy is data (the label is gated; the hint's x / width follow
 * the copy). The auto `margin-left` of a data hint follows the text widths too.
 */
type DataRow = 'row' | 'hint';

/** Compares both snapshots; data rows are listed instead of gated where their copy decides. */
function compare(state: string, proto: Snapshot, shot: Snapshot, failures: string[], data: ReadonlyMap<number, DataRow> = new Map()): StateResult {
  const rows: string[] = [];
  const listed: string[] = [];
  let compared = 0;
  if (proto.rowCount !== shot.rowCount) failures.push(`${state}: ${proto.rowCount} rows vs ${shot.rowCount}`);
  if (proto.placeholder !== shot.placeholder) failures.push(`${state}: placeholder ${JSON.stringify(proto.placeholder)} vs ${JSON.stringify(shot.placeholder)}`);
  if (!proto.focused || !shot.focused) failures.push(`${state}: input focused prototype ${proto.focused} / app ${shot.focused}`);
  for (const name of Object.keys(parts(proto.rowCount))) {
    const p = proto.parts[name];
    const a = shot.parts[name];
    if (!p || !a) {
      failures.push(`${state} ${name}: missing (${p ? 'app' : 'prototype'})`);
      continue;
    }
    compared += 1;
    const row = /^row(\d+)(?::(\w+))?$/.exec(name);
    const kind = row ? data.get(Number(row[1])) : undefined;
    const sub = row?.[2] ?? null;
    // Parts whose text is data: a data row's every part, a data hint's row and hint.
    const dataText = kind === 'row' || (kind === 'hint' && (sub === null || sub === 'hint'));
    // Boxes that follow that text: x / width of the label and hint; all of a data row's hint (empty = 0 high).
    const skipEdge = (edge: 'x' | 'y' | 'width' | 'height'): boolean =>
      dataText && ((sub === 'hint' && (kind === 'row' || edge === 'x' || edge === 'width')) || (sub === 'label' && (edge === 'x' || edge === 'width')));
    const whole = name === 'overlay' || name === 'panel' || name === 'list';
    let ok = true;
    for (const edge of ['x', 'y', 'width', 'height'] as const) {
      if (skipEdge(edge)) continue;
      if (Math.abs(p.box[edge] - a.box[edge]) > TOL) {
        ok = false;
        failures.push(`${state} ${name}.${edge}: prototype ${round(p.box[edge])} vs app ${round(a.box[edge])}`);
      }
    }
    if (!whole && !dataText && p.text !== a.text) {
      ok = false;
      failures.push(`${state} ${name}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`);
    }
    for (const prop of STYLES) {
      if (prop === 'margin-left' && dataText && sub === 'hint') continue;
      if (p.style[prop] !== a.style[prop]) {
        ok = false;
        failures.push(`${state} ${name}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
      }
    }
    if (dataText && sub !== null) listed.push(`| ${state} | ${name} | ${JSON.stringify(p.text)} | ${JSON.stringify(a.text)} |`);
    rows.push(
      `| ${state} | ${name} | ${round(p.box.x)},${round(p.box.y)} ${round(p.box.width)}×${round(p.box.height)} | ${round(a.box.x)},${round(a.box.y)} ${round(a.box.width)}×${round(a.box.height)} | ${ok ? 'ok' : 'FAIL'} | ${whole ? '' : dataText ? '(data)' : JSON.stringify(a.text).slice(0, 50)} |`,
    );
  }
  return { name: state, compared, rows, listed };
}

test('Palette matches the prototype (panel, input, rows; empty query, a filter, ↓)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototype(protoPage, { simulateIncoming: false });
  await openApp(appPage, app.baseUrl, '/');
  await expect(appPage.getByTestId('sidebar-sessions').locator('a')).toHaveCount(6);

  const failures: string[] = [];
  const results: StateResult[] = [];
  const shots: Array<[string, Buffer, Buffer]> = [];

  const panelShot = async (page: Page, snap: Snapshot): Promise<Buffer> => {
    const box = snap.parts['panel']?.box;
    if (!box) throw new Error('no panel');
    return page.screenshot({ clip: { x: box.x - 10, y: box.y - 10, width: box.width + 20, height: Math.min(box.height + 20, 900 - box.y + 10) } });
  };

  // 1. Empty query.
  for (const page of [protoPage, appPage]) {
    await page.keyboard.press('Control+k');
  }
  await expect(appPage.getByTestId('palette-row')).toHaveCount(10);
  // The prototype focuses its input 30 ms after opening (openPal's setTimeout).
  await expect(protoPage.locator('input[placeholder^="Jump to a session"]')).toBeFocused();
  await expect(appPage.getByTestId('palette-input')).toBeFocused();
  let proto = await snapshot(protoPage, 'prototype', 10);
  let shot = await snapshot(appPage, 'app', 10);
  results.push(compare('empty', proto, shot, failures, new Map([[7, 'row'], [8, 'row'], [9, 'row']])));
  shots.push(['empty', await panelShot(protoPage, proto), await panelShot(appPage, shot)]);

  // 2. The query "free": two sessions on both pages.
  await protoPage.keyboard.type('free');
  await appPage.keyboard.type('free');
  await expect(appPage.getByTestId('palette-row')).toHaveCount(2);
  proto = await snapshot(protoPage, 'prototype', 2);
  shot = await snapshot(appPage, 'app', 2);
  results.push(compare('free', proto, shot, failures, new Map([[1, 'hint']])));
  shots.push(['free', await panelShot(protoPage, proto), await panelShot(appPage, shot)]);

  // 3. ↓: the second row is highlighted.
  await protoPage.keyboard.press('ArrowDown');
  await appPage.keyboard.press('ArrowDown');
  await expect(appPage.locator('[data-testid="palette-row"][aria-selected="true"]')).toContainText('qa-free-talk');
  proto = await snapshot(protoPage, 'prototype', 2);
  shot = await snapshot(appPage, 'app', 2);
  results.push(compare('free ↓', proto, shot, failures, new Map([[1, 'hint']])));
  expect(shot.parts['row1']?.style['background-color']).toBe('rgb(42, 43, 48)');
  shots.push(['down', await panelShot(protoPage, proto), await panelShot(appPage, shot)]);

  const files: Record<string, string | Buffer> = {};
  const diffs: string[] = [];
  for (const [name, left, right] of shots) {
    files[`palette-${name}-side-by-side.png`] = await sideBySide(appPage, left, right);
    diffs.push(`${name} ${round((await pixelDiff(appPage, left, right)).percent)} %`);
  }
  const compared = results.reduce((sum, r) => sum + r.compared, 0);
  files['palette.md'] = [
    '# Visual check: ⌘K palette (M8.3)',
    '',
    `Generated by \`tests/e2e/visual/palette.spec.ts\`: app (demo seed, Inbox) vs prototype, both opened with Ctrl+K, 1440×900; ${compared} parts compared over three states (empty query, "free", "free" + ↓): boxes ±${TOL} px, exact copy, ${STYLES.length} computed styles each, the placeholder and the input focus.`,
    '',
    `Result: ${failures.length === 0 ? 'green' : 'FAIL'}.`,
    '',
    "Known data differences, not findings: (1) `GET /api/tools` is M8.1 (lane w1-tools, not merged into this lane), so the app lists no tools and its empty-query rows 8–10 are the next sessions where the prototype lists its two tools and the first session; those rows are compared by the row box, the kind label and all styles, their copy is listed below. (2) A session's hint is the sidebar's mode line built from the session's fields (`orch · QA · UI-first`), not the prototype's hand-written status copy (`orch · QA · 14/18 covered`, D13), so qa-free-talk's hint is listed, not gated.",
    '',
    `Advisory pixel diff (not a gate): ${diffs.join(' · ')}. Side-by-side crops of the panel (prototype left, app right): ${shots.map(([name]) => `\`palette-${name}-side-by-side.png\``).join(', ')}.`,
    '',
    '| State | Part | Prototype | App | Result | Copy |',
    '|---|---|---|---|---|---|',
    ...results.flatMap((r) => r.rows),
    '',
    '## Data rows (listed, not gated)',
    '',
    '| State | Row | Prototype | App |',
    '|---|---|---|---|',
    ...results.flatMap((r) => r.listed),
    '',
    '## Failures',
    ...(failures.length ? failures.map((line) => `- ${line}`) : ['- (none)']),
    '',
  ].join('\n');
  await writeReport(files);
  expect(failures).toEqual([]);
});
