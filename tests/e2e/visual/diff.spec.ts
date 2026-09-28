import { expect, type Page, test } from '@playwright/test';
import { type DemoApp, newVisualPage, openApp, openPrototype, pixelDiff, round, sideBySide, startDemoApp, writeReport } from './harness.ts';

/**
 * Visual check of the Diff tab (M4.5, D10 where it applies): the app (demo seed)
 * against the prototype at 1440×900, both on `free-talk-feature` → Diff, for three
 * selections (the first file, `TopicChips.razor` with a removed line, the
 * workspace-root `contracts/free-talk.md` without a branch). The session grid
 * (`1fr | 380px`) and the header are M4.1 in another lane, so the app's tab
 * container is pinned to the prototype container's box (its width decides where
 * the header wraps) and everything is measured **inside the container**: boxes
 * relative to its top-left within ±2 px, exact copy, computed styles
 * (`docs/visual/diff.md`).
 */

const FILE_COUNT = 5;
const LINE_LIMIT = 12;

interface PartSpec {
  readonly path: readonly number[];
  readonly copy: boolean;
}

function parts(lineCount: number): Record<string, PartSpec> {
  const out: Record<string, PartSpec> = {
    files: { path: [0], copy: false },
    pane: { path: [1], copy: false },
    head: { path: [1, 0], copy: true },
    'head:name': { path: [1, 0, 0], copy: true },
    'head:branch': { path: [1, 0, 1], copy: true },
    'head:note': { path: [1, 0, 2], copy: true },
    body: { path: [1, 1], copy: false },
  };
  for (let i = 0; i < FILE_COUNT; i++) {
    out[`file${i}`] = { path: [0, i], copy: true };
    out[`file${i}:name`] = { path: [0, i, 0, 0], copy: true };
    out[`file${i}:delta`] = { path: [0, i, 0, 1], copy: true };
    out[`file${i}:sub`] = { path: [0, i, 1], copy: true };
  }
  for (let i = 0; i < Math.min(lineCount, LINE_LIMIT); i++) out[`line${i}`] = { path: [1, 1, i], copy: true };
  return out;
}

const STYLES = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'white-space',
  'border-radius',
  'border-right-color',
  'border-right-width',
  'border-bottom-color',
  'border-bottom-width',
  'padding-top',
  'padding-left',
  'gap',
  'overflow-x',
  'cursor',
] as const;

interface Measured {
  readonly box: { x: number; y: number; width: number; height: number };
  readonly text: string;
  readonly style: Record<string, string>;
}

interface Snapshot {
  readonly container: { x: number; y: number; width: number; height: number };
  readonly lineCount: number;
  readonly parts: Record<string, Measured | null>;
}

/** Marks the prototype's tab container (the grid `300px minmax(0,1fr)` under the tabs) with `data-proto-diff`. */
async function markPrototype(page: Page): Promise<void> {
  const found = await page.evaluate(() => {
    const el = [...document.querySelectorAll<HTMLElement>('div')].find((div) => div.style.gridTemplateColumns === '300px minmax(0px, 1fr)');
    el?.setAttribute('data-proto-diff', '');
    return el !== undefined;
  });
  expect(found).toBe(true);
}

const CONTAINER = { app: '[data-testid="session-diff"]', prototype: '[data-proto-diff]' } as const;

async function snapshot(page: Page, which: 'app' | 'prototype'): Promise<Snapshot> {
  if (which === 'prototype') await markPrototype(page);
  const selector = CONTAINER[which];
  const lineCount = await page.evaluate((sel) => document.querySelector(sel)?.children[1]?.children[1]?.children.length ?? 0, selector);
  const spec = parts(lineCount);
  return page.evaluate(
    ({ sel, paths, props, lines }) => {
      const container = document.querySelector(sel) as HTMLElement;
      const c = container.getBoundingClientRect();
      const measured: Record<string, { box: { x: number; y: number; width: number; height: number }; text: string; style: Record<string, string> } | null> = {};
      for (const [name, path] of Object.entries(paths)) {
        let el: Element | undefined = container;
        for (const index of path) el = el?.children[index];
        if (!el) {
          measured[name] = null;
          continue;
        }
        const r = el.getBoundingClientRect();
        const computed = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const prop of props) style[prop] = computed.getPropertyValue(prop);
        measured[name] = { box: { x: r.x - c.x, y: r.y - c.y, width: r.width, height: r.height }, text: el.textContent ?? '', style };
      }
      return { container: { x: c.x, y: c.y, width: c.width, height: c.height }, lineCount: lines, parts: measured };
    },
    { sel: selector, paths: Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v.path])), props: STYLES as readonly string[], lines: lineCount },
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

/** Selects file `index` on both pages (the prototype's row div, the app's `diff-file`). */
async function select(protoPage: Page, appPage: Page, index: number): Promise<void> {
  await markPrototype(protoPage);
  await protoPage.evaluate((i) => (document.querySelector('[data-proto-diff]')?.children[0]?.children[i] as HTMLElement | undefined)?.click(), index);
  await appPage.getByTestId('diff-file').nth(index).click();
  await expect(appPage.getByTestId('diff-file').nth(index)).toHaveAttribute('data-selected', 'true');
}

test('Diff tab matches the prototype inside its container (copy, styles, geometry)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototype(protoPage, { simulateIncoming: false });
  await protoPage.getByText('free-talk-feature', { exact: true }).first().click();
  await protoPage.getByText('Diff · 5', { exact: true }).first().click();
  await protoPage.getByText('Not committed. Commit only when you approve.').waitFor();
  await openApp(appPage, app.baseUrl, '/sessions/free-talk-feature/diff');
  await expect(appPage.getByTestId('diff-file')).toHaveCount(FILE_COUNT);

  // Pin the app's container to the prototype's box (the 1fr | 380px grid around it is M4.1).
  await markPrototype(protoPage);
  const protoBox = await protoPage.evaluate(() => {
    const r = document.querySelector('[data-proto-diff]')!.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
  await appPage.getByTestId('session-diff').evaluate((el, box) => {
    // `flex: none`: inside the merged session view the tab is a growing flex child, which would ignore the height.
    (el as HTMLElement).style.flex = 'none';
    (el as HTMLElement).style.width = `${box.width}px`;
    (el as HTMLElement).style.height = `${box.height}px`;
  }, protoBox);

  const failures: string[] = [];
  const rows: string[] = [];
  const shots: Record<string, Buffer> = {};
  const diffs: string[] = [];
  let compared = 0;

  for (const [label, index] of [
    ['first file', 0],
    ['TopicChips.razor', 1],
    ['root contract', 4],
  ] as const) {
    if (index !== 0) await select(protoPage, appPage, index);
    const proto = await snapshot(protoPage, 'prototype');
    const shot = await snapshot(appPage, 'app');
    if (proto.lineCount !== shot.lineCount) failures.push(`${label}: ${proto.lineCount} diff lines vs ${shot.lineCount}`);
    for (const [name, part] of Object.entries(parts(proto.lineCount))) {
      const p = proto.parts[name];
      const a = shot.parts[name];
      if (!p || !a) {
        failures.push(`${label} · ${name}: missing (${p ? 'app' : 'prototype'})`);
        continue;
      }
      compared += 1;
      let ok = true;
      for (const edge of ['x', 'y', 'width', 'height'] as const) {
        if (Math.abs(p.box[edge] - a.box[edge]) > TOL) {
          ok = false;
          failures.push(`${label} · ${name}.${edge}: prototype ${round(p.box[edge])} vs app ${round(a.box[edge])}`);
        }
      }
      if (part.copy && p.text !== a.text) {
        ok = false;
        failures.push(`${label} · ${name}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`);
      }
      for (const prop of STYLES) {
        if (p.style[prop] !== a.style[prop]) {
          ok = false;
          failures.push(`${label} · ${name}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
        }
      }
      if (index === 0 || name.startsWith('head') || name.startsWith('line')) {
        rows.push(
          `| ${label} | ${name} | ${round(p.box.x)},${round(p.box.y)} ${round(p.box.width)}×${round(p.box.height)} | ${round(a.box.x)},${round(a.box.y)} ${round(a.box.width)}×${round(a.box.height)} | ${ok ? 'ok' : 'FAIL'} | ${part.copy ? JSON.stringify(a.text).slice(0, 60) : ''} |`,
        );
      }
    }
    const crop = async (page: Page, snap: Snapshot): Promise<Buffer> =>
      page.screenshot({ clip: { x: snap.container.x, y: snap.container.y, width: snap.container.width, height: Math.min(snap.container.height, 900 - snap.container.y) } });
    const protoPng = await crop(protoPage, proto);
    const appPng = await crop(appPage, shot);
    const pd = await pixelDiff(appPage, protoPng, appPng);
    diffs.push(`${label}: ${round(pd.percent)} %`);
    shots[`diff-${index}-side-by-side.png`] = await sideBySide(appPage, protoPng, appPng);
  }

  await writeReport({
    ...shots,
    'diff.md': [
      '# Visual check: Diff tab (M4.5)',
      '',
      `Generated by \`tests/e2e/visual/diff.spec.ts\`: app (demo seed, \`/sessions/free-talk-feature/diff\`) vs prototype (free-talk-feature → Diff · 5), 1440×900, measured inside the tab container for three selections; ${compared} parts compared (boxes ±${TOL} px relative to the container, copy, ${STYLES.length} computed styles).`,
      '',
      `Result: ${failures.length === 0 ? 'green' : 'FAIL'}.`,
      '',
      'The app container is pinned to the prototype container\'s box before measuring: the `1fr | 380px` session grid and the header around the tab are M4.1 (another lane), and the container width decides where the header wraps.',
      '',
      `Advisory pixel diff (not a gate): ${diffs.join(' · ')}. Side-by-side crops (prototype left, app right): \`diff-0-side-by-side.png\`, \`diff-1-side-by-side.png\`, \`diff-4-side-by-side.png\`.`,
      '',
      '| Selection | Part | Prototype (rel) | App (rel) | Result | Copy |',
      '|---|---|---|---|---|---|',
      ...rows,
      '',
      '## Failures',
      ...(failures.length ? failures.map((line) => `- ${line}`) : ['- (none)']),
      '',
    ].join('\n'),
  });
  expect(failures).toEqual([]);
});
