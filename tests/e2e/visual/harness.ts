import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type ServerProcess, startServer } from '../../helpers/server-process.ts';
import { openPrototype } from './offline.ts';

/**
 * Visual-oracle harness (D10, LOOP.md → Visual oracle). It opens the real app
 * (demo seed) and the prototype side by side at 1440×900 and offers the gate's
 * checks: computed-style token assertions, box size/position within ±2 px, exact
 * copy, plus the advisory pixel diff and side-by-side PNGs.
 *
 * Reports go to `test-results/visual/` on every run, and to `docs/visual/` (the
 * committed record) only with `SWITCHBOARD_VISUAL_REPORT=1`, so ordinary test runs
 * never dirty the working tree.
 */

/** The viewport every visual check uses. */
export const VIEWPORT = { width: 1440, height: 900 } as const;

/** Box tolerance of the gate (D10). */
export const BOX_TOLERANCE_PX = 2;

/** A started app with the demo seed in a temp data folder. */
export interface DemoApp {
  readonly server: ServerProcess;
  readonly baseUrl: string;
  stop(): Promise<void>;
}

/**
 * Starts the app with `SWITCHBOARD_DEMO=1` and a temp data folder. The port is
 * `SWITCHBOARD_E2E_PORT` when set (4871–4879), else the first free test port.
 */
export async function startDemoApp(extraEnv: Record<string, string> = {}): Promise<DemoApp> {
  const tmp = await makeTempDir('visual');
  let server: ServerProcess;
  try {
    server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), SWITCHBOARD_DEMO: '1', ...extraEnv });
  } catch (error) {
    await removeTempDir(tmp);
    throw error;
  }
  return {
    server,
    baseUrl: server.baseUrl,
    async stop() {
      await server.stop();
      await removeTempDir(tmp);
    },
  };
}

/** A page at the visual-oracle viewport (device scale 1). */
export async function newVisualPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  return context.newPage();
}

/** Opens `route` of the app and waits for the shell and the fonts. */
export async function openApp(page: Page, baseUrl: string, route = '/'): Promise<void> {
  await page.goto(`${baseUrl}${route}`);
  await page.getByTestId('shell').waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

export { openPrototype };

/** A box in CSS pixels. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A measured element: box, text and the computed styles the gate reads. */
export interface Part {
  readonly box: Box;
  readonly text: string;
  readonly style: Readonly<Record<string, string>>;
}

/** Computed-style properties captured for every part. */
export const STYLE_PROPS = [
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
  'border-right-width',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
] as const;

/**
 * Measures named parts of a page. `paths` maps a part name to a path of child
 * indexes from the shell grid (the prototype's root grid, the app's `.sb-shell`):
 * `[0]` is the sidebar, `[0, 2, 1]` its nav's second item, and so on. Both pages
 * share the structure, so the same paths address the same parts.
 */
export async function measure(page: Page, paths: Readonly<Record<string, readonly number[]>>): Promise<Record<string, Part | null>> {
  return page.evaluate(
    ({ paths: wanted, props }) => {
      const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
        const style = getComputedStyle(el);
        return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
      });
      const out: Record<string, { box: { x: number; y: number; width: number; height: number }; text: string; style: Record<string, string> } | null> =
        {};
      for (const [name, indexes] of Object.entries(wanted)) {
        let el: Element | undefined = grid;
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
    { paths, props: STYLE_PROPS as readonly string[] },
  );
}

/** Which box edges a comparison checks. */
export type Geometry =
  /** no box check (copy and styles only; the box depends on data in the same row) */
  | 'none'
  /** x, y, width, height */
  | 'box'
  /** x, width, height (the y position depends on data above it) */
  | 'size'
  /** x, width and the bottom edge (anchored to the viewport bottom) */
  | 'bottom';

/** Differences of `app` from `proto` beyond {@link BOX_TOLERANCE_PX}, as messages. */
export function compareBoxes(name: string, proto: Box, app: Box, geometry: Geometry): string[] {
  if (geometry === 'none') return [];
  const checks: Array<[string, number, number]> = [
    ['x', proto.x, app.x],
    ['width', proto.width, app.width],
  ];
  if (geometry === 'box' || geometry === 'size') checks.push(['height', proto.height, app.height]);
  if (geometry === 'box') checks.push(['y', proto.y, app.y]);
  if (geometry === 'bottom') checks.push(['bottom', proto.y + proto.height, app.y + app.height]);
  return checks
    .filter(([, a, b]) => Math.abs(a - b) > BOX_TOLERANCE_PX)
    .map(([edge, a, b]) => `${name}.${edge}: prototype ${round(a)} vs app ${round(b)}`);
}

/** One decimal. */
export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `#0b0c0d` → `rgb(11, 12, 13)` (computed-style form). */
export function hexToRgb(hex: string): string {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

/** The custom properties defined on `:root` of a page, name → trimmed value. */
export async function rootTokens(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    const styles = getComputedStyle(document.documentElement);
    for (const sheet of [...document.styleSheets]) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of [...rules]) {
        if (rule instanceof CSSStyleRule && rule.selectorText === ':root') {
          for (const name of [...rule.style]) if (name.startsWith('--')) out[name] = styles.getPropertyValue(name).trim();
        }
      }
    }
    return out;
  });
}

/**
 * Each color as the browser computes it (`oklch(80% .14 70)` from the minified CSS
 * and `oklch(0.8 0.14 70)` from SPEC both become `oklch(0.8 0.14 70)`); a value
 * that is not a color maps to `null`.
 */
export async function canonicalColors(page: Page, values: readonly string[]): Promise<Array<string | null>> {
  return page.evaluate((list) => {
    const probe = document.createElement('div');
    document.body.append(probe);
    try {
      return list.map((value) => {
        probe.style.color = '';
        probe.style.color = value;
        return probe.style.color === '' ? null : getComputedStyle(probe).color;
      });
    } finally {
      probe.remove();
    }
  }, values);
}

/** Colors listed in SPEC.md → Design tokens → Colors, per token name (`bg-card` → `#17181b`, `#16171a`). */
export async function specColorTokens(): Promise<Record<string, string[]>> {
  const spec = await readFile(path.join(REPO_ROOT, 'docs', 'handoff', 'SPEC.md'), 'utf8');
  const section = spec.slice(spec.indexOf('**Colors**'), spec.indexOf('**Type:**'));
  const out: Record<string, string[]> = {};
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const token = cells[1];
    const value = cells[2];
    if (!token || !value || token === 'Token' || token.startsWith('---')) continue;
    out[token] = value.match(/#[0-9a-f]{6}|oklch\([^)]*\)/gi) ?? [];
  }
  return out;
}

/** Result of {@link pixelDiff}. */
export interface PixelDiff {
  /** Share of pixels whose channels differ by more than the threshold, 0–100. */
  readonly percent: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Pixel difference of two PNG screenshots (advisory; D10), computed in the browser
 * with a canvas so the harness needs no image library. A pixel differs when any
 * channel differs by more than `threshold` (0–255).
 */
export async function pixelDiff(page: Page, a: Buffer, b: Buffer, threshold = 24): Promise<PixelDiff> {
  return page.evaluate(
    async ({ a: aUrl, b: bUrl, threshold: limit }) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('image load failed'));
          img.src = src;
        });
      const [imgA, imgB] = await Promise.all([load(aUrl), load(bUrl)]);
      const width = Math.min(imgA.width, imgB.width);
      const height = Math.min(imgA.height, imgB.height);
      const pixels = (img: HTMLImageElement) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, width, height).data;
      };
      const pa = pixels(imgA);
      const pb = pixels(imgB);
      let different = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (
          Math.abs(pa[i]! - pb[i]!) > limit ||
          Math.abs(pa[i + 1]! - pb[i + 1]!) > limit ||
          Math.abs(pa[i + 2]! - pb[i + 2]!) > limit
        ) {
          different += 1;
        }
      }
      return { percent: (different / (width * height)) * 100, width, height };
    },
    { a: toDataUrl(a), b: toDataUrl(b), threshold },
  );
}

/** Two PNGs next to each other (prototype left, app right) with a 16 px gap, as a PNG. */
export async function sideBySide(page: Page, left: Buffer, right: Buffer): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    async ({ left: leftUrl, right: rightUrl }) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('image load failed'));
          img.src = src;
        });
      const [a, b] = await Promise.all([load(leftUrl), load(rightUrl)]);
      const gap = 16;
      const canvas = document.createElement('canvas');
      canvas.width = a.width + gap + b.width;
      canvas.height = Math.max(a.height, b.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.fillStyle = '#ff00ff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(a, 0, 0);
      ctx.drawImage(b, a.width + gap, 0);
      return canvas.toDataURL('image/png');
    },
    { left: toDataUrl(left), right: toDataUrl(right) },
  );
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

function toDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** Folders the reports are written to (see the module comment). */
export function reportDirs(): string[] {
  const dirs = [path.join(REPO_ROOT, 'test-results', 'visual')];
  if (process.env['SWITCHBOARD_VISUAL_REPORT'] === '1') dirs.push(path.join(REPO_ROOT, 'docs', 'visual'));
  return dirs;
}

/** Writes `files` (name → content) into every report folder. */
export async function writeReport(files: Readonly<Record<string, string | Buffer>>): Promise<void> {
  for (const dir of reportDirs()) {
    await mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
  }
}
