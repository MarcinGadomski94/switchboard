/**
 * `npm run screenshots`: retakes the README screenshots (`docs/screenshots/*.png`)
 * from the real app in demo mode, in the **v2 theme** (D131), so they can be
 * refreshed after UI changes (`docs/demo.md` → *README screenshots*).
 *
 * What runs (on a loopback test port, `SWITCHBOARD_TEST_PORTS` or 4871–4879, with a
 * throwaway data folder; never the real app's port or data):
 * - the UI is built into `.e2e-dist/web` first (the E2E global setup; skip with
 *   `--no-build`);
 * - the app with the demo seed and its v2 layer (`SWITCHBOARD_DEMO=1`,
 *   `SWITCHBOARD_UI_THEME_DEFAULT=v2`, `SWITCHBOARD_DEMO_V2=1`; `docs/demo.md` → *The v2
 *   layer*), fake CLIs, the setup wizard and the tours off and the in-memory secret store,
 *   as every test server (`tests/helpers/server-process.ts`). Every name is Acme demo data;
 *   the machine is named `studio-mac` in the throwaway database before the start (its default
 *   is this computer's host name). Projects, Crews and Notes are always on since 2.0 (D132),
 *   so nothing is switched.
 *
 * The browser is Playwright's bundled Chromium, headless. Each page is checked for the welcome
 * tour (ended with Esc if it shows) and its console errors are collected; any error fails the
 * run. Desktop shots are 1440×900, phone shots 390×844 (touch), all at device scale 2, in
 * light unless the name ends in `-dark`. A `full` shot is the page's whole scrolling content
 * (the v2 shell scrolls `main`, so the window grows to fit it).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, type Page, chromium } from '@playwright/test';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { SELF_SETTING } from '../../src/server/peers/service.ts';
import { newMachineId } from '../../src/server/peers/tokens.ts';
import globalSetup from '../../tests/e2e/global-setup.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../../tests/helpers/net.ts';
import { type PeerNode, startPeerNode } from '../../tests/helpers/peers.ts';

/** Where the screenshots go. */
export const README_SHOTS_DIR = path.join(REPO_ROOT, 'docs', 'screenshots');

const DESKTOP = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
const DEVICE_SCALE = 2;

/** One screenshot: its file stem, its window and how to bring the page there. */
interface Shot {
  readonly name: string;
  readonly phone?: true;
  readonly dark?: true;
  /** The whole scrolling content, not just the first screen. */
  readonly full?: true;
  go(page: Page, baseUrl: string): Promise<void>;
}

async function open(page: Page, baseUrl: string, route: string): Promise<void> {
  await page.goto(`${baseUrl}${route}`);
  await page.locator('main').first().waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

const SHOTS: readonly Shot[] = [
  // The hero: Home with the start box and the Needs-you queue.
  { name: 'home', go: (page, base) => open(page, base, '/') },
  // Home in full: Needs you, Working now and Done today.
  { name: 'home-full', full: true, go: (page, base) => open(page, base, '/') },
  // The agent view: three questions as one answer card in the chat, the side panel open.
  { name: 'agent', go: (page, base) => open(page, base, '/agents/checkout-redesign') },
  {
    name: 'agents-board',
    async go(page, base) {
      await open(page, base, '/agents');
      await page.getByTestId('v2-agents-view').getByRole('button', { name: 'Board' }).click();
    },
  },
  {
    name: 'agents-list',
    async go(page, base) {
      await open(page, base, '/agents');
      await page.getByTestId('v2-agents-view').getByRole('button', { name: 'List' }).click();
      await page.getByTestId('v2-tree-folder-name').filter({ hasText: 'Acme web' }).waitFor();
    },
  },
  {
    name: 'project',
    async go(page, base) {
      await open(page, base, '/projects/demo-v2-checkout');
      await page.getByTestId('v2-project-views').getByRole('button', { name: 'Graph' }).click();
      await page.getByTestId('v2-project-view').waitFor();
    },
  },
  {
    name: 'crews',
    async go(page, base) {
      await open(page, base, '/crews');
      await page.getByTestId('v2-crew-card').first().click();
      await page.getByTestId('v2-crew-back').waitFor();
    },
  },
  { name: 'needs-you', go: (page, base) => open(page, base, '/needs-you') },
  { name: 'phone-home', phone: true, go: (page, base) => open(page, base, '/') },
  { name: 'phone-agent', phone: true, go: (page, base) => open(page, base, '/agents/acme-orders-integration') },
  { name: 'agent-dark', dark: true, go: (page, base) => open(page, base, '/agents/acme-orders-integration') },
];

/** The machine's name in every shot (its default is this computer's host name). */
const MACHINE_NAME = 'studio-mac';

/**
 * Names this machine before the start: the v2 layer adopts its teammates through the API before
 * the port opens, and each one keeps the machine name it was adopted on.
 */
async function nameMachine(dataDir: string): Promise<void> {
  const store = await openStore(storeFile(dataDir));
  try {
    await store.settings.set(SELF_SETTING, { id: newMachineId(), name: MACHINE_NAME });
  } finally {
    await store.close();
  }
}

/** The demo instance in v2, with a neutral machine name. */
export async function startWorld(root: string): Promise<PeerNode> {
  return startPeerNode(root, 'main', {
    env: { SWITCHBOARD_DEMO: '1', SWITCHBOARD_DEMO_V2: '1', SWITCHBOARD_UI_THEME_DEFAULT: 'v2' },
    prepare: ({ dataDir }) => nameMachine(dataDir),
  });
}

async function newContext(browser: Browser, shot: Shot): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: shot.phone ? PHONE : DESKTOP,
    deviceScaleFactor: DEVICE_SCALE,
    colorScheme: shot.dark ? 'dark' : 'light',
    ...(shot.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  // The shell probes embedded tools; the demo's default URL is never fetched (tests/e2e/probes.ts).
  await context.route(/\/api\/tools\/[^/]+\/probe$/, (route) => route.fulfill({ status: 200, json: { state: 'down' } }));
  return context;
}

/** Ends the welcome tour if it opened (test servers start with tours off, so it should not). */
export async function noTour(page: Page): Promise<void> {
  const card = page.getByTestId('v2-tour-card');
  if (await card.isVisible()) {
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'hidden' });
  }
}

async function shoot(browser: Browser, main: PeerNode): Promise<void> {
  await mkdir(README_SHOTS_DIR, { recursive: true });
  const errors: string[] = [];
  for (const shot of SHOTS) {
    const context = await newContext(browser, shot);
    try {
      const page = await context.newPage();
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`${shot.name}: ${message.text()} (${message.location().url})`);
      });
      page.on('pageerror', (error) => errors.push(`${shot.name}: ${error.message}`));
      await shot.go(page, main.baseUrl);
      // Lets the live rows tick and late API answers settle.
      await page.waitForTimeout(1_500);
      await noTour(page);
      if (shot.full) {
        const height = await page.evaluate(() => {
          const scroller = document.querySelector('main');
          return scroller ? scroller.scrollHeight + scroller.getBoundingClientRect().top : document.documentElement.scrollHeight;
        });
        await page.setViewportSize({ width: DESKTOP.width, height: Math.ceil(height) });
        await page.waitForTimeout(800);
      }
      await page.mouse.move(0, 0);
      const file = path.join(README_SHOTS_DIR, `${shot.name}.png`);
      await writeFile(file, await page.screenshot({ type: 'png' }));
      console.log(path.relative(REPO_ROOT, file));
    } finally {
      await context.close();
    }
  }
  if (errors.length > 0) throw new Error(`console errors while shooting:\n${errors.join('\n')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--no-build')) await globalSetup();
  const root = await makeTempDir('readme-shots');
  try {
    const main = await startWorld(root);
    const browser = await chromium.launch({ headless: true });
    try {
      await shoot(browser, main);
    } finally {
      await browser.close();
      await main.server.stop();
    }
  } finally {
    await removeTempDir(root);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
