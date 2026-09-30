/**
 * `npm run screenshots`: retakes the README screenshots (`docs/screenshots/*.png`)
 * from the real app in demo mode, so they can be refreshed after UI changes.
 *
 * What runs (on a loopback test port, `SWITCHBOARD_TEST_PORTS` or 4871–4879, with
 * a throwaway data folder; never the real app's port or data):
 * - the UI is built into `.e2e-dist/web` first (the E2E global setup; skip with
 *   `--no-build`);
 * - the app with the demo seed (`SWITCHBOARD_DEMO=1`, `docs/demo.md`), fake CLIs and
 *   the setup wizard off, as every test server (`tests/helpers/server-process.ts`);
 * - through its API: two pinned sessions and a "Maintenance" folder in the sidebar
 *   (D54) and the machine name `studio-mac` (its default is this computer's host name).
 * Not shown, because demo mode cannot: a paired machine (the demo starts no peers,
 * so Settings → Machines shows its empty state) and a live activity line (the demo
 * runs no processes). The app has one (dark) theme, so every view is shot once, as
 * `<nn>-<name>-dark.png`, at 1440×900 and device scale 2 (each file < 600 KB).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page, chromium } from '@playwright/test';
import globalSetup from '../../tests/e2e/global-setup.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../../tests/helpers/net.ts';
import { type PeerNode, startPeerNode } from '../../tests/helpers/peers.ts';

/** Where the screenshots go. */
export const README_SHOTS_DIR = path.join(REPO_ROOT, 'docs', 'screenshots');

/** Viewport and device scale of every screenshot. */
const VIEWPORT = { width: 1440, height: 900 } as const;
const DEVICE_SCALE = 2;

/** One screenshot: its file stem and how to bring the page there. */
interface Shot {
  readonly name: string;
  go(page: Page, baseUrl: string): Promise<void>;
}

async function open(page: Page, baseUrl: string, route: string): Promise<void> {
  await page.goto(`${baseUrl}${route}`);
  await page.getByTestId('shell').waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

const SHOTS: readonly Shot[] = [
  {
    name: '01-session',
    go: (page, base) => open(page, base, '/sessions/free-talk-feature/chat'),
  },
  {
    name: '02-new-session',
    async go(page, base) {
      await open(page, base, '/inbox');
      await page.getByTestId('new-session').click();
      const modal = page.getByTestId('modal-new-session');
      await modal.waitFor();
      // D56: the shot shows the Full form (Simple is the fresh-install default).
      await modal.getByTestId('ns-mode-full').click();
      await page.getByTestId('ns-name').fill('free-talk-640');
      await modal.getByPlaceholder('What should be implemented?').fill('Free talk screen at 640, web and mobile. Figma frame is in the AI handoff page.');
      await page.getByTestId('ns-branch').fill('PROJ-3021-free-talk-640');
      await page.getByTestId('ns-pill').filter({ hasText: /^Workspace orchestrator$/ }).click();
      for (const chip of ['acme-app-front', 'mobile']) await page.getByTestId('ns-chip').filter({ hasText: new RegExp(`^${chip}$`) }).click();
      await page.getByTestId('br-epic-key').fill('PROJ-3010');
      await page.getByTestId('br-epic-summary').fill('Free talk');
      await page.getByTestId('br-parent').fill('PROJ-3020');
      await page.getByTestId('ns-branching').scrollIntoViewIfNeeded();
      // The preflight runs 800 ms after the inputs settle.
      await page.waitForTimeout(2_000);
    },
  },
  {
    name: '03-inbox',
    go: (page, base) => open(page, base, '/inbox'),
  },
  {
    name: '04-schedules',
    go: (page, base) => open(page, base, '/schedules'),
  },
  {
    name: '05-machines',
    async go(page, base) {
      await open(page, base, '/settings/machines');
    },
  },
  {
    name: '06-sidebar',
    go: (page, base) => open(page, base, '/solutions'),
  },
];

/** The demo instance with its sidebar pinned and foldered (D54) and a neutral machine name. */
async function startWorld(root: string): Promise<PeerNode> {
  const main = await startPeerNode(root, 'main', { env: { SWITCHBOARD_DEMO: '1' } });
  try {
    // The default is this computer's host name.
    await main.call('PUT', '/api/machines/self', { name: 'studio-mac' });
    const place = async (sessionId: string, where: Record<string, unknown>) => {
      const answer = await main.call('POST', '/api/sidebar/place', { sessionId, ...where });
      if (answer.status !== 200) throw new Error(`place ${sessionId}: HTTP ${answer.status} ${JSON.stringify(answer.body)}`);
    };
    await place('free-talk-feature', { place: 'pinned' });
    await place('notifications-integration', { place: 'pinned' });
    const folder = await main.call('POST', '/api/sidebar/folders', { name: 'Maintenance' });
    if (folder.status !== 201) throw new Error(`folder: HTTP ${folder.status}`);
    const folderId = (folder.body.folders as Array<{ id: string; name: string }>).find((f) => f.name === 'Maintenance')?.id;
    await place('calendar-func-fix', { place: 'folder', folderId });
    await place('prod-monitoring', { place: 'folder', folderId });
    return main;
  } catch (error) {
    await main.server.stop();
    throw error;
  }
}

async function shoot(browser: Browser, baseUrl: string): Promise<void> {
  await mkdir(README_SHOTS_DIR, { recursive: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    for (const shot of SHOTS) {
      await shot.go(page, baseUrl);
      // Lets the live rows tick and late API answers settle.
      await page.waitForTimeout(1_500);
      const file = path.join(README_SHOTS_DIR, `${shot.name}-dark.png`);
      await writeFile(file, await page.screenshot({ type: 'png' }));
      console.log(path.relative(REPO_ROOT, file));
    }
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes('--no-build')) await globalSetup();
  const root = await makeTempDir('readme-shots');
  try {
    const main = await startWorld(root);
    const browser = await chromium.launch();
    try {
      await shoot(browser, main.baseUrl);
    } finally {
      await browser.close();
      await main.server.stop();
    }
  } finally {
    await removeTempDir(root);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
