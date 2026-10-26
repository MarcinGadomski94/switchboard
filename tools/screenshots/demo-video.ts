/**
 * `npm run demo-video`: records the README's demo animation (`docs/screenshots/demo.gif`) and
 * the social preview image (`docs/social-preview.png`) from the real app in demo mode, in the
 * v2 theme, the same world as `npm run screenshots` (`docs/demo.md` → *README demo animation*).
 *
 * The story, at 1280×800 in light: Home with "5 things need you" and agents working; one click
 * answers a question card, which leaves the queue while the counts drop to 4; an agent's chat
 * with its live activity; Agents as a Board; a project as a Graph.
 *
 * How: a headless bundled Chromium is driven through the story while a loop takes a screenshot
 * whenever the previous one is done (about 8 a second), each stamped with its time. A drawn
 * pointer follows the mouse, since headless screenshots have none. The frames become a looping
 * GIF with `gifenc` (dev dependency): one palette for the whole film, and each frame stores only
 * the pixels that changed (the rest transparent), so the still parts cost almost nothing.
 * Frames that change nothing are merged into the one before. Any console error fails the run.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type Locator, type Page, chromium } from '@playwright/test';
import gifenc from 'gifenc';
import globalSetup from '../../tests/e2e/global-setup.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../../tests/helpers/net.ts';
import { decodePng } from './png.ts';
import { README_SHOTS_DIR, noTour, startWorld } from './readme.ts';

export const DEMO_GIF = path.join(README_SHOTS_DIR, 'demo.gif');
export const SOCIAL_PREVIEW = path.join(REPO_ROOT, 'docs', 'social-preview.png');

const VIEWPORT = { width: 1280, height: 800 } as const;
/** The README's one-liner, also on the social preview. */
const ONE_LINER = 'Run many Claude Code, Codex and OpenCode agents at once. See what each one is doing and answer them from anywhere, even your phone.';

/** At most one screenshot this often (about 12 a second). */
const FRAME_MS = 80;

interface Frame {
  readonly at: number;
  readonly png: Buffer;
}

/** A pointer drawn into the page (headless screenshots have none), with a ring on each press. */
const POINTER_SCRIPT = `
(() => {
  const install = () => {
    if (document.getElementById('demo-pointer')) return;
    const pointer = document.createElement('div');
    pointer.id = 'demo-pointer';
    pointer.innerHTML = '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2 L2 21 L7 16.5 L10.5 24 L14 22.5 L10.5 15 L17.5 15 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(pointer.style, { position: 'fixed', left: '-40px', top: '-40px', zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(-2px,-2px)' });
    const ring = document.createElement('div');
    Object.assign(ring.style, { position: 'fixed', width: '34px', height: '34px', margin: '-17px 0 0 -17px', borderRadius: '50%', border: '3px solid rgba(79,70,229,.75)', zIndex: 2147483646, pointerEvents: 'none', opacity: '0', transition: 'opacity .35s, transform .35s', transform: 'scale(.4)' });
    document.body.append(ring, pointer);
    addEventListener('mousemove', (e) => { pointer.style.left = e.clientX + 'px'; pointer.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      ring.style.transition = 'none'; ring.style.left = e.clientX + 'px'; ring.style.top = e.clientY + 'px';
      ring.style.opacity = '1'; ring.style.transform = 'scale(.4)';
      requestAnimationFrame(() => { ring.style.transition = 'opacity .45s, transform .45s'; ring.style.opacity = '0'; ring.style.transform = 'scale(1.3)'; });
    }, true);
  };
  if (document.body) install(); else addEventListener('DOMContentLoaded', install);
})();
`;

/** Takes screenshots back to back until stopped. */
function startRecording(page: Page): { stop(): Promise<Frame[]> } {
  const frames: Frame[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const at = Date.now();
      const since = at - (frames.at(-1)?.at ?? 0);
      if (since < FRAME_MS) {
        await new Promise((resolve) => setTimeout(resolve, FRAME_MS - since));
        continue;
      }
      try {
        frames.push({ at, png: await page.screenshot({ type: 'png', animations: 'allow', caret: 'initial' }) });
      } catch {
        // A navigation mid-shot: skip this frame.
      }
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return frames;
    },
  };
}

let mouse = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };

/** Glides the pointer to `(x, y)` over `ms`, eased. */
async function glide(page: Page, x: number, y: number, ms = 600): Promise<void> {
  const from = mouse;
  const steps = Math.max(2, Math.round(ms / 30));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await page.waitForTimeout(ms / steps);
  }
  mouse = { x, y };
}

/** Glides to the middle of `target` and clicks it. */
async function clickOn(page: Page, target: Locator, ms = 600): Promise<void> {
  await target.waitFor();
  const box = await target.boundingBox();
  if (!box) throw new Error('nothing to click');
  await glide(page, box.x + box.width / 2, box.y + box.height / 2, ms);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
}

/** Scrolls Home's scrolling `main` smoothly by `dy` pixels. */
async function scrollMain(page: Page, dy: number, ms = 500): Promise<void> {
  await page.evaluate(
    ([delta, duration]) =>
      new Promise<void>((resolve) => {
        const main = document.querySelector('main');
        if (!main) return resolve();
        const start = main.scrollTop;
        const begin = performance.now();
        const step = (now: number): void => {
          const t = Math.min(1, (now - begin) / duration);
          main.scrollTop = start + delta * (1 - (1 - t) ** 3);
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
    [dy, ms] as const,
  );
}

/** Scrolls `main` so `target` sits `top` pixels from the window's top. */
async function scrollTo(page: Page, target: Locator, top: number, ms = 500): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('nothing to scroll to');
  await scrollMain(page, box.y - top, ms);
}

/** The story. The page is already on Home, settled. */
async function story(page: Page): Promise<void> {
  const hold = (ms: number) => page.waitForTimeout(ms);
  // 1. Home: what needs you, what is working.
  await hold(1_800);
  // 2. One click answers a question; the card leaves and the counts drop.
  const answer = page.getByRole('button', { name: /Authorize Tier B/ });
  await scrollTo(page, page.getByText('Tier A is green on web').first(), 200, 600);
  await hold(300);
  await clickOn(page, answer, 700);
  await hold(1_500);
  await scrollMain(page, -5_000, 500);
  await glide(page, 500, 160, 500);
  await hold(1_300);
  // 3. An agent at work: its chat and live activity.
  await scrollTo(page, page.locator('#v2-home-working'), 90, 600);
  await hold(300);
  await clickOn(page, page.getByTestId('v2-working-card').filter({ hasText: 'qa-checkout' }).getByText('Open'), 600);
  await page.getByTestId('v2-agent-activity-toggle').first().waitFor();
  await hold(600);
  await clickOn(page, page.getByTestId('v2-agent-activity-toggle').first(), 500);
  await hold(1_800);
  // 4. Agents as a board.
  await clickOn(page, page.getByRole('link', { name: /^Agents/ }).first(), 500);
  await clickOn(page, page.getByTestId('v2-agents-view').getByRole('button', { name: 'Board' }), 500);
  await hold(2_000);
  // 5. A project as a graph.
  await clickOn(page, page.getByRole('link', { name: /^Projects/ }).first(), 500);
  await clickOn(page, page.getByTestId('v2-project-card').filter({ hasText: 'PROJ-123' }), 500);
  await clickOn(page, page.getByTestId('v2-project-views').getByRole('button', { name: 'Graph' }), 500);
  await page.getByTestId('v2-project-view').waitFor();
  await glide(page, 1_220, 760, 500);
  await hold(2_000);
}

/** Frames → a looping GIF: one palette, unchanged pixels transparent, still frames merged. */
export function encodeGif(frames: readonly Frame[], endHoldMs: number): Uint8Array {
  const { GIFEncoder, quantize, applyPalette } = gifenc;
  const first = frames[0];
  if (!first) throw new Error('no frames');
  const { width, height } = decodePng(first.png);
  // The palette from an even sample of frames (every 4th pixel row of each).
  const sampleFrames = frames.filter((_, i) => i % Math.max(1, Math.floor(frames.length / 24)) === 0);
  const rowBytes = width * 4;
  const sample = new Uint8Array(sampleFrames.length * Math.ceil(height / 4) * rowBytes);
  let filled = 0;
  for (const frame of sampleFrames) {
    const { rgba } = decodePng(frame.png);
    for (let y = 0; y < height; y += 4) {
      sample.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), filled);
      filled += rowBytes;
    }
  }
  // 255 colors; index 255 is "unchanged" (transparent).
  const palette = quantize(sample.subarray(0, filled), 255);
  while (palette.length < 255) palette.push([0, 0, 0]);
  const TRANSPARENT = 255;
  palette.push([255, 0, 255]);

  const gif = GIFEncoder();
  let shown: Uint8Array | null = null;
  let pending: { index: Uint8Array; at: number } | null = null;
  let writtenFirst = false;
  const flush = (until: number): void => {
    if (!pending) return;
    const delay = Math.max(20, until - pending.at);
    gif.writeFrame(pending.index, width, height, writtenFirst
      ? { delay, transparent: true, transparentIndex: TRANSPARENT, dispose: 1 }
      : { palette, delay, repeat: 0, transparent: true, transparentIndex: TRANSPARENT, dispose: 1 });
    writtenFirst = true;
    pending = null;
  };
  for (const frame of frames) {
    const decoded = decodePng(frame.png);
    if (decoded.width !== width || decoded.height !== height) throw new Error('frame size changed');
    const index = applyPalette(decoded.rgba, palette);
    if (shown === null) {
      shown = index;
      pending = { index, at: frame.at };
      continue;
    }
    let changed = false;
    const delta = new Uint8Array(index.length);
    for (let i = 0; i < index.length; i++) {
      if (index[i] === shown[i]) delta[i] = TRANSPARENT;
      else {
        delta[i] = index[i] ?? 0;
        changed = true;
      }
    }
    if (!changed) continue;
    flush(frame.at);
    shown = index;
    pending = { index: delta, at: frame.at };
  }
  const last = frames.at(-1);
  flush((last?.at ?? 0) + endHoldMs);
  gif.finish();
  return gif.bytes();
}

/** The social preview: the brand, the one-liner and Home from the demo, 1280×640. */
async function socialPreview(browser: Browser, baseUrl: string): Promise<Buffer> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 3, colorScheme: 'light' });
  try {
    await context.route(/\/api\/tools\/[^/]+\/probe$/, (route) => route.fulfill({ status: 200, json: { state: 'down' } }));
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await page.locator('main').first().waitFor();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.waitForTimeout(1_500);
    await noTour(page);
    const shot = (await page.screenshot({ type: 'png' })).toString('base64');
    // The v2 brand mark (the sparkle in the rail), not the app icon's classic "S".
    const mark = (await page.locator('.v2-brand-mark').first().screenshot({ type: 'png' })).toString('base64');
    return await compose(page, shot, mark);
  } finally {
    await context.close();
  }
}

async function compose(page: Page, shot: string, mark: string): Promise<Buffer> {
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.setContent(`<!doctype html><html><head><style>
    * { box-sizing: border-box; margin: 0; }
    body { width: 1280px; height: 640px; overflow: hidden; font-family: Geist, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: radial-gradient(circle at 15% 20%, #eef0ff 0, #f7f6f3 45%, #f3f1ec 100%); color: #17161c; }
    .text { position: absolute; left: 72px; top: 0; bottom: 0; width: 470px; display: flex; flex-direction: column; justify-content: center; gap: 26px; }
    .brand { display: flex; align-items: center; gap: 16px; font-size: 52px; font-weight: 700; letter-spacing: -1.5px; }
    .brand img { width: 64px; height: 64px; border-radius: 16px; }
    .line { font-size: 29px; line-height: 1.3; font-weight: 500; letter-spacing: -.3px; color: #2b2a33; }
    .tags { font-size: 19px; color: #5b5a66; }
    .shot { position: absolute; left: 590px; top: 70px; width: 960px; border-radius: 16px; overflow: hidden;
      box-shadow: 0 30px 80px rgba(40, 35, 90, .22), 0 0 0 1px rgba(0,0,0,.06); }
    .shot img { display: block; width: 100%; }
  </style></head><body>
    <div class="text">
      <div class="brand"><img src="data:image/png;base64,${mark}" alt="">Switchboard</div>
      <div class="line">${ONE_LINER}</div>
      <div class="tags">Local · open source · no telemetry</div>
    </div>
    <div class="shot"><img src="data:image/png;base64,${shot}" alt=""></div>
  </body></html>`);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return page.screenshot({ type: 'png', scale: 'css' });
}

async function main(): Promise<void> {
  if (!process.argv.includes('--no-build')) await globalSetup();
  const root = await makeTempDir('readme-demo');
  try {
    const world = await startWorld(root);
    const browser = await chromium.launch({ headless: true });
    const errors: string[] = [];
    try {
      // The preview first, while Home still shows the seed's five things that need you.
      await writeFile(SOCIAL_PREVIEW, await socialPreview(browser, world.baseUrl));
      console.log(path.relative(REPO_ROOT, SOCIAL_PREVIEW));

      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: 'light' });
      await context.route(/\/api\/tools\/[^/]+\/probe$/, (route) => route.fulfill({ status: 200, json: { state: 'down' } }));
      await context.addInitScript(POINTER_SCRIPT);
      const page = await context.newPage();
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`);
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${world.baseUrl}/`);
      await page.locator('main').first().waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await page.waitForTimeout(1_500);
      await noTour(page);
      await page.mouse.move(mouse.x, mouse.y);
      await glide(page, 700, 330, 200);

      const recording = startRecording(page);
      await story(page);
      const frames = await recording.stop();
      const dump = process.env.DEMO_FRAMES_DIR;
      if (dump) {
        await mkdir(dump, { recursive: true });
        for (const [i, frame] of frames.entries()) await writeFile(path.join(dump, `${String(i).padStart(4, '0')}-${frame.at - (frames[0]?.at ?? 0)}.png`), frame.png);
      }
      if (errors.length > 0) throw new Error(`console errors while recording:\n${errors.join('\n')}`);

      const bytes = encodeGif(frames, 1_200);
      await mkdir(path.dirname(DEMO_GIF), { recursive: true });
      await writeFile(DEMO_GIF, bytes);
      const seconds = ((frames.at(-1)?.at ?? 0) - (frames[0]?.at ?? 0) + 1_200) / 1000;
      console.log(`${path.relative(REPO_ROOT, DEMO_GIF)}: ${frames.length} screenshots, ${seconds.toFixed(1)} s, ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);

      if (errors.length > 0) throw new Error(`console errors:\n${errors.join('\n')}`);
    } finally {
      await browser.close();
      await world.server.stop();
    }
  } finally {
    await removeTempDir(root);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
