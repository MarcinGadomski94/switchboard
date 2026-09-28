import { expect, type Page, test } from '@playwright/test';
import { type DemoApp, newVisualPage, openApp, openPrototype, pixelDiff, round, sideBySide, startDemoApp, writeReport } from './harness.ts';

/**
 * Visual check of the loop cards (M7.2, D10): the app (demo seed, `/schedules`)
 * against the prototype's Schedules & loops view at 1440×900. The view's header
 * and schedule table are M7.1 (another lane), so everything is measured **inside
 * the loop-card grid**: boxes relative to its top-left within ±2 px, exact copy
 * (name, kind, Open session, note), computed styles. The three facts are D9's
 * (Iteration / cap · Next / expires · Breaker from observed data, "—" when
 * unknown) instead of the prototype's hand-written ones, so their copy and
 * widths are listed, not gated (`docs/visual/loops.md`).
 */

const CARDS = 2;

interface PartSpec {
  readonly path: readonly number[];
  /** Compare the text exactly. */
  readonly copy: boolean;
  /** Compare the width (off for the D9 facts, whose copy differs by design). */
  readonly width: boolean;
}

function parts(): Record<string, PartSpec> {
  const out: Record<string, PartSpec> = {};
  for (let i = 0; i < CARDS; i++) {
    out[`card${i}`] = { path: [i], copy: false, width: true };
    out[`card${i}:head`] = { path: [i, 0], copy: false, width: true };
    out[`card${i}:dot`] = { path: [i, 0, 0], copy: false, width: true };
    out[`card${i}:name`] = { path: [i, 0, 1], copy: true, width: true };
    out[`card${i}:kind`] = { path: [i, 0, 2], copy: true, width: true };
    out[`card${i}:open`] = { path: [i, 0, 3], copy: true, width: true };
    out[`card${i}:strip`] = { path: [i, 1], copy: false, width: true };
    out[`card${i}:cell0`] = { path: [i, 1, 0], copy: false, width: true };
    out[`card${i}:facts`] = { path: [i, 2], copy: false, width: true };
    for (let j = 0; j < 3; j++) {
      out[`card${i}:fact${j}`] = { path: [i, 2, j], copy: false, width: true };
      out[`card${i}:fact${j}:k`] = { path: [i, 2, j, 0], copy: false, width: false };
      out[`card${i}:fact${j}:v`] = { path: [i, 2, j, 1], copy: false, width: false };
    }
    out[`card${i}:note`] = { path: [i, 3], copy: true, width: true };
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
  'text-transform',
  'border-top-left-radius',
  'border-top-color',
  'border-top-width',
  'padding-top',
  'padding-left',
  'row-gap',
  'column-gap',
  'align-items',
  'flex-direction',
  'grid-template-columns',
] as const;

interface Measured {
  readonly box: { x: number; y: number; width: number; height: number };
  readonly text: string;
  readonly style: Record<string, string>;
}

interface Snapshot {
  readonly container: { x: number; y: number; width: number; height: number };
  readonly containerStyle: Record<string, string>;
  readonly cardCount: number;
  readonly cellCounts: number[];
  readonly parts: Record<string, Measured | null>;
}

/** Marks the prototype's loop-card grid (`repeat(2, minmax(0,1fr))` holding the cards) with `data-proto-loops`. */
async function markPrototype(page: Page): Promise<void> {
  const found = await page.evaluate(() => {
    const el = [...document.querySelectorAll<HTMLElement>('div')].find(
      (div) => div.style.display === 'grid' && div.style.gridTemplateColumns.startsWith('repeat(2') && div.textContent?.includes('Open session'),
    );
    el?.setAttribute('data-proto-loops', '');
    return el !== undefined;
  });
  expect(found).toBe(true);
}

const CONTAINER = { app: '[data-testid="loop-cards"]', prototype: '[data-proto-loops]' } as const;

async function snapshot(page: Page, which: 'app' | 'prototype'): Promise<Snapshot> {
  if (which === 'prototype') await markPrototype(page);
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
        cardCount: container.children.length,
        cellCounts: [...container.children].map((card) => card.children[1]?.children.length ?? 0),
        parts: measured,
      };
    },
    { sel: CONTAINER[which], paths: Object.fromEntries(Object.entries(parts()).map(([k, v]) => [k, v.path])), props: STYLES as readonly string[] },
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

test('Loop cards match the prototype inside the card grid (geometry, copy, styles; D9 facts listed)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototype(protoPage, { simulateIncoming: false });
  await protoPage.getByText('Schedules & loops', { exact: true }).first().click();
  await protoPage.getByText('Ralph · loop-until-dry', { exact: true }).first().waitFor();
  await openApp(appPage, app.baseUrl, '/schedules');
  await expect(appPage.getByTestId('loop-card')).toHaveCount(CARDS);

  const failures: string[] = [];
  const rows: string[] = [];
  const proto = await snapshot(protoPage, 'prototype');
  const shot = await snapshot(appPage, 'app');
  if (proto.cardCount !== shot.cardCount) failures.push(`${proto.cardCount} cards vs ${shot.cardCount}`);
  if (JSON.stringify(proto.cellCounts) !== JSON.stringify(shot.cellCounts)) failures.push(`strip cells ${proto.cellCounts} vs ${shot.cellCounts}`);
  for (const edge of ['width', 'height'] as const) {
    if (Math.abs(proto.container[edge] - shot.container[edge]) > TOL) failures.push(`container.${edge}: prototype ${round(proto.container[edge])} vs app ${round(shot.container[edge])}`);
  }
  for (const prop of STYLES) {
    if (proto.containerStyle[prop] !== shot.containerStyle[prop]) failures.push(`container.${prop}: prototype ${proto.containerStyle[prop]} vs app ${shot.containerStyle[prop]}`);
  }
  const facts: string[] = [];
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
      if (edge === 'width' && !part.width) continue;
      if (edge === 'x' && !part.width && name.endsWith(':v')) continue;
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
      // The dot and the border follow the session status; both demo sessions have the prototype's status.
      if (p.style[prop] !== a.style[prop]) {
        ok = false;
        failures.push(`${name}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
      }
    }
    if (/:fact\d$/.test(name)) facts.push(`| ${name} | ${JSON.stringify(p.text)} | ${JSON.stringify(a.text)} |`);
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
    'loops-side-by-side.png': await sideBySide(appPage, protoPng, appPng),
    'loops.md': [
      '# Visual check: loop cards (M7.2)',
      '',
      `Generated by \`tests/e2e/visual/loops.spec.ts\`: app (demo seed, \`/schedules\`) vs prototype (Schedules & loops), 1440×900, measured inside the loop-card grid; ${compared} parts compared (boxes ±${TOL} px relative to the grid, copy of name / kind / Open session / note, ${STYLES.length} computed styles) plus the grid's own size and styles.`,
      '',
      `Result: ${failures.length === 0 ? 'green' : 'FAIL'}.`,
      '',
      'The grid is compared on its own: the view header ("Schedules & loops", "+ New scheduled run") and the schedule table above it are M7.1 (another lane), so the grid sits higher in the app until the wave merge.',
      '',
      'Known difference (by design, D9 + D13): the three facts are Iteration / cap · Next / expires · Breaker from observed data ("—" when unknown), not the prototype\'s hand-written facts, so their copy and the widths of their label / value lines are listed below and not gated. The demo loops have no next firing stored (the prototype\'s "15:00" is mock copy), so Next shows "—".',
      '',
      `Advisory pixel diff (not a gate): ${round(pd.percent)} %. Side-by-side crop (prototype left, app right): \`loops-side-by-side.png\`.`,
      '',
      '| Part | Prototype (rel) | App (rel) | Result | Copy |',
      '|---|---|---|---|---|',
      ...rows,
      '',
      '## Facts (listed, not gated)',
      '',
      '| Fact | Prototype | App |',
      '|---|---|---|',
      ...facts,
      '',
      '## Failures',
      ...(failures.length ? failures.map((line) => `- ${line}`) : ['- (none)']),
      '',
    ].join('\n'),
  });
  expect(failures).toEqual([]);
});
