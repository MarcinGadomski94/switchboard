import { expect, type Page, test } from '@playwright/test';
import { type DemoApp, newVisualPage, openApp, openPrototype, round, sideBySide, startDemoApp, writeReport } from './harness.ts';

/**
 * Visual check of the Timeline tab (M4.4, D10 where it applies): the app (demo
 * seed) against the prototype at 1440×900, both on `free-talk-feature` → Timeline
 * with the playhead at the end. The session grid (`1fr | 380px`) and the header
 * belong to M4.1, built in another lane, so the tab is compared **inside its own
 * container**: positions relative to the container's top-left, fixed sizes, block
 * positions as fractions of the lane, exact copy and computed styles
 * (`docs/visual/timeline.md`). Known differences are listed in KNOWN and reported,
 * not failed.
 */

/** Child-index paths inside the tab container (the prototype's markup and the app's share the structure). */
const AXIS = [0];
const LANE_ROWS = [1, 2, 3, 4];
const CONTROLS = [5];
const BOTTOM = [6];

interface PartSpec {
  readonly path: readonly number[];
  /**
   * `rel` = x, y, width, height relative to the container; `xyh` = the same without the
   * width (it follows the container's width: the log is one of two `1fr` columns);
   * `yh` = y + height only; `none` = no box check.
   */
  readonly geometry: 'rel' | 'xyh' | 'yh' | 'none';
  readonly copy: boolean;
}

function parts(): Record<string, PartSpec> {
  const out: Record<string, PartSpec> = {
    axis: { path: AXIS, geometry: 'yh', copy: true },
    range: { path: [...AXIS, 0], geometry: 'rel', copy: true },
    ticks: { path: [...AXIS, 1], geometry: 'yh', copy: true },
    controls: { path: CONTROLS, geometry: 'yh', copy: true },
    play: { path: [...CONTROLS, 0, 0], geometry: 'rel', copy: true },
    now: { path: [...CONTROLS, 0, 1], geometry: 'rel', copy: true },
    scrubber: { path: [...CONTROLS, 1], geometry: 'yh', copy: false },
    bottom: { path: BOTTOM, geometry: 'none', copy: false },
    log: { path: [...BOTTOM, 0], geometry: 'none', copy: true },
    logHead: { path: [...BOTTOM, 0, 0], geometry: 'xyh', copy: true },
    terminal: { path: [...BOTTOM, 1], geometry: 'none', copy: false },
  };
  LANE_ROWS.forEach((row, i) => {
    out[`lane${i}`] = { path: [row], geometry: 'yh', copy: false };
    out[`lane${i}:label`] = { path: [row, 0], geometry: 'rel', copy: false };
    out[`lane${i}:name`] = { path: [row, 0, 0], geometry: 'rel', copy: true };
    out[`lane${i}:sub`] = { path: [row, 0, 1], geometry: 'yh', copy: true };
    out[`lane${i}:track`] = { path: [row, 1], geometry: 'yh', copy: false };
  });
  for (let i = 1; i <= 8; i++) {
    out[`log${i}`] = { path: [...BOTTOM, 0, i], geometry: 'xyh', copy: true };
    out[`log${i}:time`] = { path: [...BOTTOM, 0, i, 0], geometry: 'rel', copy: true };
    out[`log${i}:dot`] = { path: [...BOTTOM, 0, i, 1], geometry: 'rel', copy: false };
  }
  return out;
}

/**
 * Differences that are data or other lanes, not this tab (reported, not failed):
 * - the web lane's second line: the prototype's timeline says `acme-app-front`, its
 *   own agent card (the demo agent's solution path) `microfrontends/acme-app-front`;
 * - the terminal: the demo seed still stores its terminal lines as provisional
 *   `channel: "terminal"` payloads, which the real-path terminal tail does not
 *   render (M2.1 note; the merge step / M4.3 maps them).
 */
const KNOWN = new Set(['lane2:sub.text']);

const STYLES = [
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
  'padding-top',
  'padding-left',
  'opacity',
] as const;

interface Measured {
  readonly box: { x: number; y: number; width: number; height: number };
  readonly text: string;
  readonly style: Record<string, string>;
}

interface Snapshot {
  readonly container: { x: number; y: number; width: number; height: number };
  readonly parts: Record<string, Measured | null>;
  /** Per lane: its blocks (fractions of the track's inner box) + the playhead offset from the track's right edge. */
  readonly lanes: Array<{
    blocks: Array<{ left: number; width: number; height: number; top: number; text: string; title: string; style: Record<string, string> }>;
    head: { fromRight: number; width: number; top: number; height: number; background: string };
  }>;
  readonly terminalLines: number;
  readonly terminalStyle: Record<string, string>;
}

/** Measures the tab container: the app's `session-timeline`, the prototype's `padding:18px 22px` column holding the log. */
async function snapshot(page: Page, which: 'app' | 'prototype'): Promise<Snapshot> {
  const spec = parts();
  return page.evaluate(
    ({ which: side, paths, props, lanes }) => {
      const container =
        side === 'app'
          ? (document.querySelector('[data-testid="session-timeline"]') as HTMLElement)
          : ([...document.querySelectorAll<HTMLElement>('div')].find(
              (el) => el.style.padding === '18px 22px' && (el.textContent ?? '').includes('Events up to'),
            ) as HTMLElement);
      const c = container.getBoundingClientRect();
      const styleOf = (el: Element): Record<string, string> => {
        const computed = getComputedStyle(el);
        const out: Record<string, string> = {};
        for (const prop of props) out[prop] = computed.getPropertyValue(prop);
        return out;
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
        measured[name] = { box: { x: r.x - c.x, y: r.y - c.y, width: r.width, height: r.height }, text: (el.textContent ?? '').trim(), style: styleOf(el) };
      }
      const laneOut = lanes.map((row) => {
        const track = container.children[row]?.children[1] as HTMLElement;
        const t = track.getBoundingClientRect();
        const inner = { x: t.x + track.clientLeft, width: track.clientWidth };
        const children = [...track.children] as HTMLElement[];
        const head = children.at(-1) as HTMLElement;
        const h = head.getBoundingClientRect();
        return {
          blocks: children.slice(0, -1).map((b) => {
            const r = b.getBoundingClientRect();
            return {
              left: (r.x - inner.x) / inner.width,
              width: r.width / inner.width,
              height: r.height,
              top: r.y - t.y,
              text: (b.textContent ?? '').trim(),
              title: b.getAttribute('title') ?? '',
              style: styleOf(b),
            };
          }),
          head: { fromRight: t.x + t.width - h.x, width: h.width, top: h.y - t.y, height: h.height, background: getComputedStyle(head).backgroundColor },
        };
      });
      const terminal = container.children[6]?.children[1] as HTMLElement;
      return {
        container: { x: c.x, y: c.y, width: c.width, height: c.height },
        parts: measured,
        lanes: laneOut,
        terminalLines: terminal.children.length,
        terminalStyle: styleOf(terminal),
      };
    },
    { which, paths: Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v.path])), props: STYLES as readonly string[], lanes: LANE_ROWS },
  );
}

let app: DemoApp;

test.beforeAll(async () => {
  app = await startDemoApp();
});

test.afterAll(async () => {
  await app?.stop();
});

async function openPrototypeTimeline(page: Page): Promise<void> {
  await openPrototype(page, { simulateIncoming: false });
  await page.getByText('free-talk-feature', { exact: true }).first().click();
  await page.getByText('Timeline', { exact: true }).first().click();
  await page.getByText(/^Events up to/).waitFor();
}

const TOL = 2;

test('Timeline tab matches the prototype inside its container (copy, styles, geometry)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototypeTimeline(protoPage);
  await openApp(appPage, app.baseUrl, '/sessions/free-talk-feature/timeline');
  await expect(appPage.getByTestId('timeline-log-entry')).toHaveCount(8);

  const proto = await snapshot(protoPage, 'prototype');
  const shot = await snapshot(appPage, 'app');
  const failures: string[] = [];
  const known: string[] = [];
  const rows: string[] = [];
  const note = (key: string, message: string): void => {
    (KNOWN.has(key) ? known : failures).push(message);
  };

  for (const [name, part] of Object.entries(parts())) {
    const p = proto.parts[name];
    const a = shot.parts[name];
    if (!p || !a) {
      failures.push(`${name}: missing (${p ? 'app' : 'prototype'})`);
      continue;
    }
    const edges: Array<[string, number, number]> = [];
    if (part.geometry === 'rel' || part.geometry === 'xyh') edges.push(['x', p.box.x, a.box.x]);
    if (part.geometry === 'rel') edges.push(['width', p.box.width, a.box.width]);
    if (part.geometry !== 'none') edges.push(['y', p.box.y, a.box.y], ['height', p.box.height, a.box.height]);
    let ok = true;
    for (const [edge, pv, av] of edges) {
      if (Math.abs(pv - av) > TOL) {
        ok = false;
        note(`${name}.${edge}`, `${name}.${edge}: prototype ${round(pv)} vs app ${round(av)}`);
      }
    }
    if (part.copy && p.text !== a.text) {
      ok = false;
      note(`${name}.text`, `${name}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`);
    }
    for (const prop of STYLES) {
      if (p.style[prop] !== a.style[prop]) {
        ok = false;
        note(`${name}.${prop}`, `${name}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
      }
    }
    rows.push(`| ${name} | ${part.geometry} | ${round(p.box.x)},${round(p.box.y)} ${round(p.box.width)}×${round(p.box.height)} | ${round(a.box.x)},${round(a.box.y)} ${round(a.box.width)}×${round(a.box.height)} | ${ok ? 'ok' : KNOWN.has(`${name}.text`) ? 'known' : 'FAIL'} | ${part.copy ? JSON.stringify(a.text).slice(0, 60) : ''} |`);
  }

  // Blocks: same labels, kinds (colors), heights and positions as fractions of the lane; the playhead at the end.
  let blockCount = 0;
  proto.lanes.forEach((lane, i) => {
    const appLane = shot.lanes[i];
    if (!appLane) {
      failures.push(`lane${i}: missing in the app`);
      return;
    }
    if (lane.blocks.length !== appLane.blocks.length) failures.push(`lane${i}: ${lane.blocks.length} blocks vs ${appLane.blocks.length}`);
    lane.blocks.forEach((pb, j) => {
      const ab = appLane.blocks[j];
      if (!ab) return;
      blockCount += 1;
      const id = `lane${i}:block${j}`;
      if (pb.text !== ab.text) failures.push(`${id}.text: ${JSON.stringify(pb.text)} vs ${JSON.stringify(ab.text)}`);
      if (pb.title !== ab.title) failures.push(`${id}.title: ${JSON.stringify(pb.title)} vs ${JSON.stringify(ab.title)}`);
      if (Math.abs(pb.left - ab.left) > 0.005) failures.push(`${id}.left: ${round(pb.left * 100)}% vs ${round(ab.left * 100)}%`);
      // A share of the lane (a block is never narrower than its padding + border, 14 px, on either page).
      if (Math.abs(pb.width - ab.width) > 0.005) failures.push(`${id}.width: ${round(pb.width * 100)}% vs ${round(ab.width * 100)}%`);
      if (Math.abs(pb.height - ab.height) > TOL || Math.abs(pb.top - ab.top) > TOL) failures.push(`${id}.box: top/height ${pb.top}/${pb.height} vs ${ab.top}/${ab.height}`);
      for (const prop of STYLES) if (pb.style[prop] !== ab.style[prop]) failures.push(`${id}.${prop}: ${pb.style[prop]} vs ${ab.style[prop]}`);
    });
    for (const key of ['fromRight', 'width', 'top', 'height'] as const) {
      if (Math.abs(lane.head[key] - appLane.head[key]) > TOL) failures.push(`lane${i}:playhead.${key}: ${lane.head[key]} vs ${appLane.head[key]}`);
    }
    if (lane.head.background !== appLane.head.background) failures.push(`lane${i}:playhead.background: ${lane.head.background} vs ${appLane.head.background}`);
  });
  for (const prop of STYLES) {
    if (proto.terminalStyle[prop] !== shot.terminalStyle[prop]) failures.push(`terminal.${prop}: ${proto.terminalStyle[prop]} vs ${shot.terminalStyle[prop]}`);
  }
  known.push(`terminal lines: prototype ${proto.terminalLines} vs app ${shot.terminalLines} (demo terminal payloads are provisional)`);
  known.push(`container width: prototype ${round(proto.container.width)} vs app ${round(shot.container.width)} (the 1fr | 380px session grid is M4.1)`);

  // Side-by-side of the two containers for the agent review (advisory).
  const crop = async (page: Page, snap: Snapshot): Promise<Buffer> =>
    page.screenshot({ clip: { x: snap.container.x, y: snap.container.y, width: snap.container.width, height: Math.min(snap.container.height, 900 - snap.container.y) } });
  const pair = await sideBySide(appPage, await crop(protoPage, proto), await crop(appPage, shot));
  await writeReport({
    'timeline-side-by-side.png': pair,
    'timeline.md': [
      '# Visual check: Timeline tab (M4.4)',
      '',
      `Generated by \`tests/e2e/visual/timeline.spec.ts\`: app (demo seed, \`/sessions/free-talk-feature/timeline\`) vs prototype (free-talk-feature → Timeline), 1440×900, measured inside the tab container. ${blockCount} blocks compared as fractions of their lane.`,
      '',
      `Result: ${failures.length === 0 ? 'green' : 'FAIL'}; known differences: ${known.length}.`,
      '',
      '| Part | Geometry | Prototype (rel) | App (rel) | Result | Copy |',
      '|---|---|---|---|---|---|',
      ...rows,
      '',
      '## Known differences (not findings of this tab)',
      ...known.map((line) => `- ${line}`),
      '',
      '## Failures',
      ...(failures.length ? failures.map((line) => `- ${line}`) : ['- (none)']),
      '',
    ].join('\n'),
  });
  expect(failures).toEqual([]);
});
