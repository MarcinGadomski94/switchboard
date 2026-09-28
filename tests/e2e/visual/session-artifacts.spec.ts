import { expect, type Page, test } from '@playwright/test';
import { type DemoApp, newVisualPage, openApp, openPrototype, pixelDiff, round, sideBySide, startDemoApp, writeReport } from './harness.ts';

/**
 * Visual check of the Artifacts tab (M4.6, D10 where it applies): the app (demo
 * seed) against the prototype at 1440×900, both on `free-talk-feature` →
 * Artifacts. The session grid (`1fr | 380px`) and the header are M4.1 in another
 * lane, so the app's tab container is pinned to the prototype container's box
 * and everything is measured **inside the container**: boxes relative to its
 * top-left within ±2 px, exact copy, computed styles (`docs/visual/session-artifacts.md`).
 */

const ROW_COUNT = 4;

interface PartSpec {
  readonly path: readonly number[];
  readonly copy: boolean;
}

function parts(): Record<string, PartSpec> {
  const out: Record<string, PartSpec> = {};
  for (let i = 0; i < ROW_COUNT; i++) {
    out[`row${i}`] = { path: [i], copy: true };
    out[`row${i}:tag`] = { path: [i, 0], copy: true };
    out[`row${i}:name`] = { path: [i, 1], copy: true };
    out[`row${i}:meta`] = { path: [i, 2], copy: true };
  }
  return out;
}

const STYLES = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'border-top-left-radius',
  'border-top-color',
  'border-top-width',
  'padding-top',
  'padding-left',
  'row-gap',
  'column-gap',
  'align-items',
  'flex-grow',
  'overflow-y',
] as const;

interface Measured {
  readonly box: { x: number; y: number; width: number; height: number };
  readonly text: string;
  readonly style: Record<string, string>;
}

interface Snapshot {
  readonly container: { x: number; y: number; width: number; height: number };
  readonly containerStyle: Record<string, string>;
  readonly rowCount: number;
  readonly parts: Record<string, Measured | null>;
}

/** Marks the prototype's tab container (the `padding:18px 22px` column holding the artifact rows) with `data-proto-arts`. */
async function markPrototype(page: Page): Promise<void> {
  const found = await page.evaluate(() => {
    const el = [...document.querySelectorAll<HTMLElement>('div')].find(
      (div) => div.style.padding === '18px 22px' && div.style.flexDirection === 'column' && div.textContent?.includes('contracts/free-talk.md'),
    );
    el?.setAttribute('data-proto-arts', '');
    return el !== undefined;
  });
  expect(found).toBe(true);
}

const CONTAINER = { app: '[data-testid="session-artifacts"]', prototype: '[data-proto-arts]' } as const;

async function snapshot(page: Page, which: 'app' | 'prototype'): Promise<Snapshot> {
  if (which === 'prototype') await markPrototype(page);
  const spec = parts();
  return page.evaluate(
    ({ sel, paths, props }) => {
      const container = document.querySelector(sel) as HTMLElement;
      const c = container.getBoundingClientRect();
      const read = (el: Element): Record<string, string> => {
        const computed = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const prop of props) style[prop] = computed.getPropertyValue(prop);
        return style;
      };
      const measured: Record<string, { box: { x: number; y: number; width: number; height: number }; text: string; style: Record<string, string> } | null> = {};
      for (const [name, path] of Object.entries(paths)) {
        let el: Element | undefined = container;
        for (const index of path) el = el?.children[index];
        if (!el) {
          measured[name] = null;
          continue;
        }
        const r = el.getBoundingClientRect();
        measured[name] = { box: { x: r.x - c.x, y: r.y - c.y, width: r.width, height: r.height }, text: el.textContent ?? '', style: read(el) };
      }
      return {
        container: { x: c.x, y: c.y, width: c.width, height: c.height },
        containerStyle: read(container),
        rowCount: container.children.length,
        parts: measured,
      };
    },
    { sel: CONTAINER[which], paths: Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v.path])), props: STYLES as readonly string[] },
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

test('Artifacts tab matches the prototype inside its container (copy, styles, geometry)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototype(protoPage, { simulateIncoming: false });
  await protoPage.getByText('free-talk-feature', { exact: true }).first().click();
  await protoPage.getByText(`Artifacts · ${ROW_COUNT}`, { exact: true }).first().click();
  await protoPage.getByText('mobile-followups/from-acme-app-front.md', { exact: true }).first().waitFor();
  await openApp(appPage, app.baseUrl, '/sessions/free-talk-feature/artifacts');
  await expect(appPage.getByTestId('artifact-row')).toHaveCount(ROW_COUNT);

  // Pin the app's container to the prototype's box (the 1fr | 380px grid around it is M4.1).
  await markPrototype(protoPage);
  const protoBox = await protoPage.evaluate(() => {
    const r = document.querySelector('[data-proto-arts]')!.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
  await appPage.getByTestId('session-artifacts').evaluate((el, box) => {
    (el as HTMLElement).style.width = `${box.width}px`;
    (el as HTMLElement).style.height = `${box.height}px`;
    (el as HTMLElement).style.flex = 'none';
    // The measured box includes the 18/22 px padding: pin it as the border box.
    (el as HTMLElement).style.boxSizing = 'border-box';
  }, protoBox);

  const failures: string[] = [];
  const rows: string[] = [];
  const proto = await snapshot(protoPage, 'prototype');
  const shot = await snapshot(appPage, 'app');
  if (proto.rowCount !== shot.rowCount) failures.push(`${proto.rowCount} rows vs ${shot.rowCount}`);
  for (const prop of STYLES) {
    if (prop === 'flex-grow') continue; // the app's container is pinned (flex: none) above
    if (proto.containerStyle[prop] !== shot.containerStyle[prop]) failures.push(`container.${prop}: prototype ${proto.containerStyle[prop]} vs app ${shot.containerStyle[prop]}`);
  }
  let compared = 0;
  for (const [name, part] of Object.entries(parts())) {
    const p = proto.parts[name];
    const a = shot.parts[name];
    if (!p || !a) {
      failures.push(`${name}: missing (${p ? 'app' : 'prototype'})`);
      continue;
    }
    compared += 1;
    let ok = true;
    for (const edge of ['x', 'y', 'width', 'height'] as const) {
      if (Math.abs(p.box[edge] - a.box[edge]) > TOL) {
        ok = false;
        failures.push(`${name}.${edge}: prototype ${round(p.box[edge])} vs app ${round(a.box[edge])}`);
      }
    }
    if (part.copy && p.text !== a.text) {
      ok = false;
      failures.push(`${name}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`);
    }
    for (const prop of STYLES) {
      if (p.style[prop] !== a.style[prop]) {
        ok = false;
        failures.push(`${name}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
      }
    }
    rows.push(
      `| ${name} | ${round(p.box.x)},${round(p.box.y)} ${round(p.box.width)}×${round(p.box.height)} | ${round(a.box.x)},${round(a.box.y)} ${round(a.box.width)}×${round(a.box.height)} | ${ok ? 'ok' : 'FAIL'} | ${part.copy ? JSON.stringify(a.text).slice(0, 60) : ''} |`,
    );
  }

  const crop = async (page: Page, snap: Snapshot): Promise<Buffer> =>
    page.screenshot({ clip: { x: snap.container.x, y: snap.container.y, width: snap.container.width, height: Math.min(snap.container.height, 900 - snap.container.y) } });
  const protoPng = await crop(protoPage, proto);
  const appPng = await crop(appPage, shot);
  const pd = await pixelDiff(appPage, protoPng, appPng);

  await writeReport({
    'session-artifacts-side-by-side.png': await sideBySide(appPage, protoPng, appPng),
    'session-artifacts.md': [
      '# Visual check: Artifacts tab (M4.6)',
      '',
      `Generated by \`tests/e2e/visual/artifacts.spec.ts\`: app (demo seed, \`/sessions/free-talk-feature/artifacts\`) vs prototype (free-talk-feature → Artifacts · ${ROW_COUNT}), 1440×900, measured inside the tab container; ${compared} parts compared (boxes ±${TOL} px relative to the container, copy, ${STYLES.length} computed styles) plus the container's own styles.`,
      '',
      `Result: ${failures.length === 0 ? 'green' : 'FAIL'}.`,
      '',
      'The app container is pinned to the prototype container\'s box before measuring: the `1fr | 380px` session grid and the header around the tab are M4.1 (another lane).',
      '',
      `Advisory pixel diff (not a gate): ${round(pd.percent)} %. Side-by-side crop (prototype left, app right): \`session-artifacts-side-by-side.png\`.`,
      '',
      '| Part | Prototype (rel) | App (rel) | Result | Copy |',
      '|---|---|---|---|---|',
      ...rows,
      '',
      '## Failures',
      ...(failures.length ? failures.map((line) => `- ${line}`) : ['- (none)']),
      '',
    ].join('\n'),
  });
  expect(failures).toEqual([]);
});
