/**
 * `npm run icons` (D34, `docs/install-app.md`): rasterises the app icons from
 * their SVG sources in `src/web/public/icons/` with Playwright's bundled Chromium
 * (the test browser; no other tool, no new dependency) and writes the PNGs next
 * to them. The SVGs and the PNGs are both committed; run this again only after
 * changing an SVG. Vite copies `src/web/public/` into the build as-is.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

/** One PNG made from one SVG. */
export interface IconRender {
  /** SVG source, relative to {@link ICONS_DIR}. */
  readonly source: string;
  /** PNG written, relative to {@link ICONS_DIR}. */
  readonly output: string;
  /** Width and height in pixels. */
  readonly size: number;
}

/** The icon folder, relative to the repo root (Vite's public folder for `src/web`). */
export const ICONS_DIR = path.join('src', 'web', 'public', 'icons');

/**
 * Every PNG the app serves: the manifest's `any` icons (192, 512) and its
 * maskable one (512), the 180 px `apple-touch-icon` (Safari's Add to Dock) and a
 * 32 px favicon for browsers without SVG favicons.
 */
export const ICON_RENDERS: readonly IconRender[] = [
  { source: 'icon.svg', output: 'icon-192.png', size: 192 },
  { source: 'icon.svg', output: 'icon-512.png', size: 512 },
  { source: 'icon-maskable.svg', output: 'icon-maskable-512.png', size: 512 },
  { source: 'icon.svg', output: 'apple-touch-icon.png', size: 180 },
  { source: 'favicon.svg', output: 'favicon-32.png', size: 32 },
];

/** A page that shows only `svg` at `size` × `size` CSS pixels. */
function pageFor(svg: string, size: number): string {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  return `<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block}</style></head><body><img src="${src}" width="${size}" height="${size}" alt=""></body></html>`;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const dir = path.join(repoRoot, ICONS_DIR);
  const browser = await chromium.launch();
  try {
    for (const render of ICON_RENDERS) {
      const svg = await readFile(path.join(dir, render.source), 'utf8');
      const context = await browser.newContext({ viewport: { width: render.size, height: render.size }, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage();
        // `load` waits for the image; the check also refuses an SVG the browser could not draw.
        await page.setContent(pageFor(svg, render.size), { waitUntil: 'load' });
        await page.waitForFunction('document.images[0].complete && document.images[0].naturalWidth > 0', undefined, { timeout: 5_000 });
        // Transparent outside the drawing (the favicon's rounded corners).
        const png = await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: render.size, height: render.size } });
        await writeFile(path.join(dir, render.output), png);
        console.log(`${path.join(ICONS_DIR, render.output)}  ${render.size}×${render.size}  from ${render.source}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
