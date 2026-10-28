import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { type APIRequestContext, type Locator, type Page, expect, request as playwrightRequest, test } from '@playwright/test';
import { type TutorialState, V2_WELCOME_ID, WHATS_NEW } from '../../src/core/tutorial.ts';
import { loadMigrations } from '../../src/server/db/migrate.ts';
import { seedFolder } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { openTempStore } from '../helpers/store.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · lane X · "Welcome to Switchboard 2" on the real code path (a server
 * whose default theme is v2, SWITCHBOARD_TUTORIAL back on): it opens once by
 * itself on the first v2 load and spotlights each v2 page's anchor (a centred
 * card for the agent view without an agent), Done stores it and returns to the
 * page; a reload opens nothing; Settings › Advanced › What's new tours replays it
 * (recording nothing); an existing install sees only the welcome in v2 and its
 * Skip also settles the classic tours it covers; at 1024 the rail and at 390 the
 * bottom tabs carry the anchors and the card is a bottom sheet.
 * Screenshots go to `SWITCHBOARD_V2_TOUR_SHOTS` when set.
 */

const SHOTS = process.env['SWITCHBOARD_V2_TOUR_SHOTS']?.trim() || null;
const ENV = { ...V2_SERVER_ENV, SWITCHBOARD_TUTORIAL: 'on' };
const STEPS = WHATS_NEW.find((feature) => feature.id === V2_WELCOME_ID)?.steps ?? [];
const title = (id: string): string => STEPS.find((step) => step.id === id)?.title ?? id;
const of = (n: number): string => `${n} of ${STEPS.length}`;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function apiFor(server: ServerProcess, dataDir: string): Promise<APIRequestContext> {
  const token = (await readFile(path.join(dataDir, 'sb_token'), 'utf8')).trim();
  return playwrightRequest.newContext({ baseURL: server.baseUrl, extraHTTPHeaders: { cookie: `sb_token=${token}` } });
}

async function tutorialState(api: APIRequestContext): Promise<TutorialState> {
  const response = await api.get('/api/tutorial');
  expect(response.status()).toBe(200);
  return (await response.json()) as TutorialState;
}

function statusOf(state: TutorialState, id: string): string | null {
  return state.whatsNew.find((entry) => entry.id === id)?.status ?? null;
}

const card = (page: Page): Locator => page.getByTestId('v2-tour-card');

async function expectStep(page: Page, stepTitle: string, progress: string, mode: 'spot' | 'centre'): Promise<void> {
  await expect(card(page).getByTestId('v2-tour-title')).toHaveText(stepTitle);
  await expect(card(page)).not.toHaveAttribute('data-looking', 'true');
  await expect(card(page).getByTestId('v2-tour-progress')).toHaveText(progress);
  await expect(card(page)).toHaveAttribute('data-mode', mode);
  await expect(page.getByTestId('v2-tour-spot')).toHaveCount(mode === 'spot' ? 1 : 0);
}

/** The cutout surrounds `target` (its 6 px padding, clamped to the window), once it has moved there. */
async function expectSpotAround(page: Page, target: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const [el, spot] = await Promise.all([target.boundingBox(), page.getByTestId('v2-tour-spot').boundingBox()]);
      if (!el || !spot) return 'missing';
      const viewport = page.viewportSize() ?? { width: 0, height: 0 };
      const around =
        Math.abs(spot.x - Math.max(2, el.x - 6)) < 2 &&
        Math.abs(spot.y - Math.max(2, el.y - 6)) < 2 &&
        Math.abs(spot.x + spot.width - Math.min(viewport.width - 2, el.x + el.width + 6)) < 2 &&
        Math.abs(spot.y + spot.height - Math.min(viewport.height - 2, el.y + el.height + 6)) < 2;
      return around ? 'around' : JSON.stringify({ el, spot });
    })
    .toBe('around');
}

test.describe('a brand-new install in v2', () => {
  let tmp: string;
  let server: ServerProcess;
  let api: APIRequestContext;

  test.beforeAll(async () => {
    tmp = await makeTempDir('e2e-v2-tour');
    server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), ...ENV });
    api = await apiFor(server, path.join(tmp, 'data'));
  });

  test.afterAll(async () => {
    await api?.dispose();
    await server?.stop();
    await removeTempDir(tmp);
  });

  test.beforeEach(async ({ page }) => {
    await stubToolProbes(page);
  });

  test('opens once by itself at 1440: every step highlights its v2 anchor, Back / → / focus in the card, Done stores it and returns to Home', async ({ page }) => {
    await page.goto(server.baseUrl);
    await expect(page.getByTestId('v2-shell')).toBeVisible();
    await expect(card(page).getByTestId('v2-tour-kicker')).toHaveText('What’s new · Welcome to Switchboard 2');
    await expectStep(page, title('home'), of(1), 'spot');
    await expectSpotAround(page, page.locator('[data-tour="v2-home-needs"]'));
    await expect(card(page)).toHaveAttribute('role', 'dialog');
    await expect(page.getByTestId('v2-tour-next')).toBeFocused();
    await expect(page.getByTestId('v2-tour-back')).toBeDisabled();
    await shot(page, 'desktop-1-home');

    await page.keyboard.press('ArrowRight');
    await expectStep(page, title('start'), of(2), 'spot');
    await expectSpotAround(page, page.getByTestId('v2-start-box'));
    await page.getByTestId('v2-tour-back').click();
    await expectStep(page, title('home'), of(1), 'spot');
    await page.getByTestId('v2-tour-next').click();
    await expectStep(page, title('start'), of(2), 'spot');

    await page.getByTestId('v2-tour-next').click();
    await expectStep(page, title('agents'), of(3), 'spot');
    await expect(page).toHaveURL(/\/agents$/);
    await expectSpotAround(page, page.getByTestId('v2-agents-view'));
    await shot(page, 'desktop-3-agents');

    // No agent yet: the agent view's step shows its centred card.
    await page.getByTestId('v2-tour-next').click();
    await expectStep(page, title('agent'), of(4), 'centre');
    await expect(page.getByTestId('v2-tour-missing')).toBeVisible();

    await page.getByTestId('v2-tour-next').click();
    await expectStep(page, title('projects-crews'), of(5), 'spot');
    await expect(page).toHaveURL(/\/projects$/);
    await expectSpotAround(page, page.getByTestId('v2-nav-projects'));

    await page.getByTestId('v2-tour-next').click();
    await expectStep(page, title('appearance'), of(6), 'spot');
    await expect(page).toHaveURL(/\/settings\/appearance$/);
    await expectSpotAround(page, page.getByTestId('v2-theme-switch'));
    await expect(page.getByTestId('v2-tour-next')).toHaveText('Done');
    await shot(page, 'desktop-6-appearance');

    // Tab stays inside the card.
    for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="v2-tour-card"]'))).toBe(true);

    await page.getByTestId('v2-tour-next').focus();
    await page.getByTestId('v2-tour-next').click();
    await expect(page.getByTestId('v2-tour')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${server.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`));
    const after = await tutorialState(api);
    expect(statusOf(after, V2_WELCOME_ID)).toBe('completed');
    // The classic main tour stays for a switch to Classic.
    expect(after.main.status).toBe('pending');

    await page.reload();
    await expect(page.getByTestId('v2-shell')).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.getByTestId('v2-tour')).toHaveCount(0);
  });

  test('replays from Settings › Advanced › What’s new tours at 1024 (the rail carries the anchors), records nothing; Esc ends it', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`${server.baseUrl}/settings/advanced/tutorial`);
    await expect(page.getByTestId('v2-tours')).toBeVisible();
    await expect(page.getByTestId(`v2-tours-status-${V2_WELCOME_ID}`)).toContainText('seen');
    await expect(page.getByTestId('v2-tours-classic-note')).toBeVisible();
    // The classic tours are not listed in v2.
    await expect(page.locator('[data-row^="whats-new-"]')).toHaveCount(0);
    await page.getByTestId(`v2-tours-replay-${V2_WELCOME_ID}`).click();
    await expectStep(page, title('home'), of(1), 'spot');
    // At 1024 Home's Needs-you section (or the top bar's Needs you) is the anchor.
    await page.getByTestId('v2-tour-next').click();
    await page.getByTestId('v2-tour-next').click();
    await page.getByTestId('v2-tour-next').click();
    await page.getByTestId('v2-tour-next').click();
    await expectStep(page, title('projects-crews'), of(5), 'spot');
    await expectSpotAround(page, page.getByTestId('v2-nav-projects'));
    await shot(page, 'tablet-5-projects');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('v2-tour')).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings\/advanced\/tutorial$/);
    expect(statusOf(await tutorialState(api), V2_WELCOME_ID)).toBe('completed');
  });
});

test.describe('a phone (390×844), brand-new install', () => {
  let tmp: string;
  let server: ServerProcess;
  let api: APIRequestContext;

  test.beforeAll(async () => {
    tmp = await makeTempDir('e2e-v2-tour-phone');
    server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), ...ENV });
    api = await apiFor(server, path.join(tmp, 'data'));
  });

  test.afterAll(async () => {
    await api?.dispose();
    await server?.stop();
    await removeTempDir(tmp);
  });

  test('the card is a bottom sheet; the bottom tabs carry the anchors; Skip tour stores it', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      await stubToolProbes(page);
      await page.goto(server.baseUrl);
      await expectStep(page, title('home'), of(1), 'spot');
      await expectSpotAround(page, page.getByTestId('v2-tab-needs'));
      await expect(card(page)).toHaveAttribute('data-placement', /^sheet-(bottom|top)$/);
      const sheet = await card(page).boundingBox();
      expect(sheet && Math.round(sheet.width)).toBe(390);
      await shot(page, 'phone-1-home');
      await page.getByTestId('v2-tour-next').click();
      await expectStep(page, title('start'), of(2), 'spot');
      await page.getByTestId('v2-tour-next').click();
      await expectStep(page, title('agents'), of(3), 'spot');
      await expectSpotAround(page, page.getByTestId('v2-phone-view'));
      await page.getByTestId('v2-tour-next').click();
      await expectStep(page, title('agent'), of(4), 'centre');
      await expect(card(page)).toHaveAttribute('data-placement', 'sheet-bottom');
      await page.getByTestId('v2-tour-next').click();
      // Projects and Crews live under More on a phone.
      await expectStep(page, title('projects-crews'), of(5), 'spot');
      await expectSpotAround(page, page.getByTestId('v2-tab-more'));
      await shot(page, 'phone-5-more');
      // The buttons are touch-sized.
      const next = await page.getByTestId('v2-tour-next').boundingBox();
      expect(next && next.height).toBeGreaterThanOrEqual(44);
      await page.getByTestId('v2-tour-skip').click();
      await expect(page.getByTestId('v2-tour')).toHaveCount(0);
      expect(statusOf(await tutorialState(api), V2_WELCOME_ID)).toBe('skipped');
    } finally {
      await context.close();
    }
  });
});

test.describe('an existing install (data from before the tutorial)', () => {
  let tmp: string;
  let server: ServerProcess;
  let api: APIRequestContext;

  test.beforeAll(async () => {
    tmp = await makeTempDir('e2e-v2-tour-existing');
    const dataDir = path.join(tmp, 'data');
    const folder = path.join(tmp, 'work space');
    await mkdir(folder, { recursive: true });
    const store = await openTempStore(dataDir, { migrations: (await loadMigrations()).filter((m) => m.version < 37) });
    try {
      await seedFolder(store, folder);
    } finally {
      await store.close();
    }
    server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir, ...ENV });
    api = await apiFor(server, dataDir);
  });

  test.afterAll(async () => {
    await api?.dispose();
    await server?.stop();
    await removeTempDir(tmp);
  });

  test('v2 opens only its own tours (no classic-anchored tour); skipping them also settles the classic tours the welcome covers', async ({ page }) => {
    await stubToolProbes(page);
    const before = await tutorialState(api);
    expect(statusOf(before, V2_WELCOME_ID)).toBe('pending');
    expect(statusOf(before, 'project-graph')).toBe('pending');
    expect(statusOf(before, 'project-graph-fullscreen')).toBe('pending');
    expect(statusOf(before, 'remote-update')).toBe('pending');
    expect(statusOf(before, 'crews-pin')).toBe('pending');
    expect(statusOf(before, 'graduated')).toBe('pending');
    await page.goto(server.baseUrl);
    // The welcome, the redrawn Project graph (2.4.2), its full screen and D140's remote update (2.4.3), pinned crews (2.4.4): the five v2 tours, chained.
    await expect(card(page).getByTestId('v2-tour-kicker')).toHaveText('What’s new · Welcome to Switchboard 2 (1 of 5)');
    await page.getByTestId('v2-tour-skip').click();
    await expect(card(page).getByTestId('v2-tour-kicker')).toHaveText('What’s new · The Project graph, redrawn (2 of 5)');
    await page.getByTestId('v2-tour-skip').click();
    await expect(card(page).getByTestId('v2-tour-kicker')).toHaveText('What’s new · The Project graph in full screen (3 of 5)');
    await page.getByTestId('v2-tour-skip').click();
    await expect(card(page).getByTestId('v2-tour-kicker')).toHaveText('What’s new · Update your other computers from here (4 of 5)');
    await page.getByTestId('v2-tour-skip').click();
    await expect(card(page).getByTestId('v2-tour-kicker')).toHaveText('What’s new · Pin a crew to the sidebar (5 of 5)');
    await page.getByTestId('v2-tour-skip').click();
    await expect(page.getByTestId('v2-tour')).toHaveCount(0);
    expect(statusOf(await tutorialState(api), 'project-graph')).toBe('skipped');
    expect(statusOf(await tutorialState(api), 'project-graph-fullscreen')).toBe('skipped');
    expect(statusOf(await tutorialState(api), 'remote-update')).toBe('skipped');
    expect(statusOf(await tutorialState(api), 'crews-pin')).toBe('skipped');
    await expect.poll(async () => statusOf(await tutorialState(api), 'two-themes')).toBe('skipped');
    const after = await tutorialState(api);
    expect(statusOf(after, V2_WELCOME_ID)).toBe('skipped');
    expect(statusOf(after, 'graduated')).toBe('skipped');
    // Every other classic tour waits for Classic.
    expect(statusOf(after, 'drafts')).toBe('pending');
  });
});
