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
 * - through its API: two pinned sessions, a "Maintenance" folder with a "Releases"
 *   subfolder in the sidebar (D54, D58) and the machine name `studio-mac` (its default is
 *   this computer's host name);
 * - through the throwaway Claude config folder (demo mode has no data for them): two example
 *   MCP servers (`acme-docs`, `example-http`) for the MCP page, and demo sign-ins
 *   (`dev@example.com`, plus a second profile `team@example.com`) for Settings → Accounts.
 * Not shown, because demo mode cannot: a paired machine (the demo starts no peers,
 * so Settings → Machines shows its empty state) and a live activity line (the demo
 * runs no processes). The app has one (dark) theme, so every view is shot once, as
 * `<nn>-<name>-dark.png`, at 1440×900 and device scale 2 (each file < 600 KB).
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page, chromium } from '@playwright/test';
import globalSetup from '../../tests/e2e/global-setup.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../../tests/helpers/net.ts';
import { type PeerNode, startPeerNode } from '../../tests/helpers/peers.ts';

/** Where the screenshots go. */
export const README_SHOTS_DIR = path.join(REPO_ROOT, 'docs', 'screenshots');

/** Demo e-mail addresses of the two Claude Code accounts (reserved example domain). */
const DEMO_EMAIL = 'dev@example.com';
const DEMO_EMAIL_2 = 'team@example.com';

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
      // D56: the shot shows the Simple form (the default): folder, message, title, model, CLI and worktree.
      await page.getByTestId('ns-simple-title').fill('Fix the login redirect');
      await page.getByTestId('ns-message').fill('Users land on a blank page after signing in from the pricing page. Find the cause and fix it.');
      // D57: one attached screenshot (a 1×1 PNG with a demo name).
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const chooser = page.waitForEvent('filechooser');
      await modal.getByTestId('attach-button').click();
      await (await chooser).setFiles({ name: 'blank-page.png', mimeType: 'image/png', buffer: png });
      await page.waitForTimeout(1_000);
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
  {
    name: '07-mcp',
    async go(page, base) {
      await open(page, base, '/mcp');
      await page.getByTestId('view-mcp').getByTestId('mcp-server').first().waitFor();
      // The Codex / OpenCode section runs their CLIs in the demo folder (not on this computer), so it
      // would print this computer's paths and an error. It is left out of the shot.
      await page.getByTestId('mcp-cli-section').waitFor();
      await page.getByTestId('mcp-cli-section').evaluate((node) => node.remove());
    },
  },
  {
    name: '08-accounts',
    async go(page, base) {
      await open(page, base, '/settings/accounts');
      await page.getByTestId('account-profile').first().waitFor();
    },
  },
];

/** The demo instance with its sidebar pinned and foldered (D54) and a neutral machine name. */
async function startWorld(root: string): Promise<PeerNode> {
  // Demo mode has no MCP or account data of its own, so the throwaway Claude config folder
  // holds two harmless example MCP servers and the fake CLI's signed-in marker (a demo email).
  const configDir = path.join(root, 'main', 'claude-config');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        'acme-docs': { type: 'stdio', command: 'npx', args: ['-y', '@acme/docs-mcp'], env: { ACME_DOCS_TOKEN: 'demo' } },
        'example-http': { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer demo' } },
      },
    }),
  );
  await writeFile(path.join(configDir, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email: DEMO_EMAIL }));
  const main = await startPeerNode(root, 'main', { env: { SWITCHBOARD_DEMO: '1', FAKE_CLAUDE_AUTH_REQUIRED: '1' } });
  try {
    const profile = await main.call('POST', '/api/accounts/profiles', { cli: 'claude', name: 'Second account' });
    if (profile.status !== 201) throw new Error(`profile: HTTP ${profile.status}`);
    const profileDir = path.join(main.dataDir, 'profiles', 'claude');
    for (const id of await readdir(profileDir)) await writeFile(path.join(profileDir, id, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email: DEMO_EMAIL_2 }));
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
    // D58: a subfolder of Maintenance.
    const sub = await main.call('POST', '/api/sidebar/folders', { name: 'Releases', parentId: folderId });
    if (sub.status !== 201) throw new Error(`subfolder: HTTP ${sub.status}`);
    const subId = (sub.body.folders as Array<{ id: string; name: string }>).find((f) => f.name === 'Releases')?.id;
    await place('button-rollout', { place: 'folder', folderId: subId });
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
