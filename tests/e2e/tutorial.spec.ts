import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { type APIRequestContext, type Locator, type Page, expect, request as playwrightRequest, test } from '@playwright/test';
import { MAIN_TOUR, type TutorialState, WHATS_NEW } from '../../src/core/tutorial.ts';
import { loadMigrations } from '../../src/server/db/migrate.ts';
import { openTempStore } from '../helpers/store.ts';
import { seedFolder } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';

/**
 * D85 oracle (docs/tutorial.md) on the real code path: the main tour opening by
 * itself once on a brand-new install (SWITCHBOARD_TUTORIAL back on; every other
 * spec has it off), Next / Back / Skip tour and → ← Esc, the focus kept in the
 * card, a step whose element is missing showing its centred card and an optional
 * one skipped, the seen flag in the database (no second opening), replay from
 * Settings → Tutorial and ⌘K → Tutorial (which records nothing), the What's-new
 * mini-tours of an install that had data before migration 0037 (and no main
 * tour), and the phone layout at 390×844 (the ☰ drawer opened for sidebar steps,
 * the card as a bottom sheet). Screenshots go to `SWITCHBOARD_D85_SHOTS` when set.
 */

const SHOTS = process.env['SWITCHBOARD_D85_SHOTS']?.trim() || null;
const TUTORIAL_ON = { SWITCHBOARD_TUTORIAL: 'on' };

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  // The cutout moves for 0.28 s.
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

function card(page: Page) {
  return page.getByTestId('tour-card');
}

/** Waits for a step: its title, progress and whether it spotlights or shows a centred card. */
async function expectStep(page: Page, title: string, progress: string, mode: 'spot' | 'centre'): Promise<void> {
  await expect(card(page).getByTestId('tour-title')).toHaveText(title);
  await expect(card(page)).not.toHaveAttribute('data-looking', 'true');
  await expect(card(page).getByTestId('tour-progress')).toHaveText(progress);
  await expect(card(page)).toHaveAttribute('data-mode', mode);
  await expect(page.getByTestId('tour-spot')).toHaveCount(mode === 'spot' ? 1 : 0);
}

/** The cutout surrounds `target` (its 6 px padding, clamped to the window), once it has moved there. */
async function expectSpotAround(page: Page, target: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const [el, spot] = await Promise.all([target.boundingBox(), page.getByTestId('tour-spot').boundingBox()]);
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

const TOTAL = `of ${MAIN_TOUR.length}`;
const title = (id: string): string => MAIN_TOUR.find((step) => step.id === id)?.title ?? id;

test.describe('a brand-new install', () => {
  let tmp: string;
  let server: ServerProcess;
  let api: APIRequestContext;

  test.beforeAll(async () => {
    tmp = await makeTempDir('e2e-tutorial-new');
    server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), ...TUTORIAL_ON });
    api = await apiFor(server, path.join(tmp, 'data'));
  });

  test.afterAll(async () => {
    await api?.dispose();
    await server?.stop();
    await removeTempDir(tmp);
  });

  test('opens the main tour once by itself: Next / Back / keyboard, focus kept in the card, a missing element shows a centred card, Skip tour stores the flag', async ({ page }) => {
    expect((await tutorialState(api)).main.status).toBe('pending');
    await page.goto(server.baseUrl);
    // Step 1: the sessions list, spotlighted, the card a labelled modal dialog.
    await expectStep(page, title('sessions'), `1 ${TOTAL}`, 'spot');
    await expect(card(page)).toHaveAttribute('role', 'dialog');
    await expect(card(page)).toHaveAttribute('aria-modal', 'true');
    await expect(card(page).getByTestId('tour-kicker')).toHaveText('Tour');
    await expect(card(page).getByTestId('tour-todo').locator('li')).toHaveCount(MAIN_TOUR[0]?.todo.length ?? 0);
    await expect(page.getByTestId('tour-live')).toHaveText(`Tour, step 1 ${TOTAL}: ${title('sessions')}`);
    await expect(page.getByTestId('tour-next')).toBeFocused();
    await expect(page.getByTestId('tour-back')).toBeDisabled();
    // The spotlight sits over the sessions list.
    await expectSpotAround(page, page.getByTestId('sidebar-sessions'));
    // Tab never leaves the card.
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="tour-card"]') !== null)).toBe(true);
    }

    // Next → + New session; → → the chat: no session yet, so a centred card that says so.
    await page.getByTestId('tour-next').click();
    await expectStep(page, title('new-session'), `2 ${TOTAL}`, 'spot');
    await page.keyboard.press('ArrowRight');
    await expectStep(page, title('chat'), `3 ${TOTAL}`, 'centre');
    await expect(card(page).getByTestId('tour-missing')).toContainText('Start a session with + New session');
    // ← back, Back button back.
    await page.keyboard.press('ArrowLeft');
    await expectStep(page, title('new-session'), `2 ${TOTAL}`, 'spot');
    await page.getByTestId('tour-back').click();
    await expectStep(page, title('sessions'), `1 ${TOTAL}`, 'spot');

    // Clicks on the page do nothing while the tour runs (explain-only).
    await page.mouse.click(40, 300);
    await expect(card(page)).toBeVisible();

    // Skip tour: gone, stored as skipped, and not again after a reload.
    await page.getByTestId('tour-skip').click();
    await expect(page.getByTestId('tour')).toHaveCount(0);
    await expect.poll(async () => (await tutorialState(api)).main.status).toBe('skipped');
    await page.reload();
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.getByTestId('tour')).toHaveCount(0);
  });

  test('replay from Settings → Tutorial (Esc closes it) and from ⌘K → Tutorial (to the end); a replay records nothing', async ({ page }) => {
    await page.goto(`${server.baseUrl}/settings/tutorial`);
    const replayRow = page.locator('.sb-set-row[data-row="tutorial-replay"]');
    await expect(replayRow).toContainText('Show the tutorial again');
    await expect(replayRow).toContainText('skipped');
    await expect(page.locator('.sb-set-row[data-row^="whats-new-"]')).toHaveCount(WHATS_NEW.length);
    await shot(page, 'settings-replay-row');
    await page.getByTestId('tutorial-replay').click();
    await expectStep(page, title('sessions'), `1 ${TOTAL}`, 'spot');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('tour')).toHaveCount(0);
    // Back where it started.
    await expect(page).toHaveURL(/\/settings\/tutorial$/);

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('tutorial');
    await expect(page.getByTestId('palette-row').first()).toContainText('Tutorial');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('modal-palette')).toHaveCount(0);
    await expectStep(page, title('sessions'), `1 ${TOTAL}`, 'spot');
    // Through every step to the end (no sessions: those steps are centred cards; never stuck).
    for (let i = 1; i < MAIN_TOUR.length; i++) {
      await page.getByTestId('tour-next').click();
      await expect(card(page).getByTestId('tour-progress')).toHaveText(`${i + 1} ${TOTAL}`);
      await expect(card(page)).not.toHaveAttribute('data-looking', 'true');
    }
    // The last step points at the replay row itself.
    await expectStep(page, title('settings'), `${MAIN_TOUR.length} ${TOTAL}`, 'spot');
    await expect(page.getByTestId('tour-next')).toHaveText('Done');
    await page.getByTestId('tour-next').click();
    await expect(page.getByTestId('tour')).toHaveCount(0);
    expect((await tutorialState(api)).main.status).toBe('skipped');
  });
});

test.describe('with a session (desktop screenshots)', () => {
  let world: QuestionWorld;

  test.beforeAll(async () => {
    world = await startQuestionWorld('tutorial', { env: TUTORIAL_ON });
  });

  test.afterAll(async () => {
    await world?.stop();
  });

  test('the chat steps spotlight the newest session\'s composer and the todo list\'s + Todo', async ({ page }) => {
    await page.goto(`${world.baseUrl}/settings/tutorial`);
    // A fresh install here too: the tour opened by itself; skip it, then start a session and replay.
    await expectStep(page, title('sessions'), `1 ${TOTAL}`, 'spot');
    await page.getByTestId('tour-skip').click();
    const { id } = await world.startSession(page, 'tour-chat', 'Reply with just OK.');
    await page.goto(`${world.baseUrl}/sessions/${id}`);
    await expect(page.getByTestId('chat-composer')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('tutorial');
    await page.keyboard.press('Enter');
    await expectStep(page, title('sessions'), `1 ${TOTAL}`, 'spot');
    await shot(page, 'desktop-1-sessions');
    await page.getByTestId('tour-next').click();
    await expectStep(page, title('new-session'), `2 ${TOTAL}`, 'spot');
    await page.getByTestId('tour-next').click();
    await expectStep(page, title('chat'), `3 ${TOTAL}`, 'spot');
    await expectSpotAround(page, page.getByTestId('chat-composer'));
    await shot(page, 'desktop-3-chat');
    await page.getByTestId('tour-next').click();
    await expectStep(page, title('inbox'), `4 ${TOTAL}`, 'spot');
    await page.getByTestId('tour-next').click();
    // No todos yet: the strip is the compact + Todo button.
    await expectStep(page, title('todo-strip'), `5 ${TOTAL}`, 'spot');
    await expect(page.locator('[data-tour="todo-add"]')).toBeVisible();
    await shot(page, 'desktop-5-todos');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('tour')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/sessions/${id}$`));
  });
});

test.describe('an install from before the tutorial', () => {
  let tmp: string;
  let server: ServerProcess;
  let api: APIRequestContext;

  test.beforeAll(async () => {
    tmp = await makeTempDir('e2e-tutorial-old');
    const dataDir = path.join(tmp, 'data');
    const folder = path.join(tmp, 'work space');
    await mkdir(folder, { recursive: true });
    // The database as 1.12 left it: migrations up to 0036 and a saved folder (no sessions).
    const store = await openTempStore(dataDir, { migrations: (await loadMigrations()).filter((m) => m.version < 37) });
    try {
      await seedFolder(store, folder);
    } finally {
      await store.close();
    }
    server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir, ...TUTORIAL_ON });
    api = await apiFor(server, dataDir);
  });

  test.afterAll(async () => {
    await api?.dispose();
    await server?.stop();
    await removeTempDir(tmp);
  });

  test("gets the What's-new mini-tours (not the main tour): Next through one, Skip tour, Skip all; a replay skips an optional step without its element", async ({ page }) => {
    const before = await tutorialState(api);
    expect(before.install).toBe('existing');
    expect(before.main.status).toBeNull();
    expect(before.whatsNew.every((entry) => entry.status === 'pending')).toBe(true);
    await page.goto(server.baseUrl);
    const count = WHATS_NEW.length;
    const kicker = card(page).getByTestId('tour-kicker');
    // Run in new session: its first step needs a session (none: a centred card), its second the Todos page's Select.
    await expect(kicker).toHaveText(`What's new · Run in new session (1 of ${count})`);
    await expectStep(page, 'Run a todo in its own session', '1 of 2', 'centre');
    await expect(page.getByTestId('tour-skip-all')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expectStep(page, 'Several at once', '2 of 2', 'spot');
    await expect(page).toHaveURL(/\/todos$/);
    await expect(page.getByTestId('tour-next')).toHaveText('Next tour');
    await page.getByTestId('tour-next').click();
    await expect(kicker).toHaveText(`What's new · Todos board (2 of ${count})`);
    await expectStep(page, 'The board', '1 of 1', 'spot');
    await expectSpotAround(page, page.getByTestId('todos-mode'));
    await shot(page, 'whats-new-todos-board');
    await page.getByTestId('tour-skip').click();
    await expect(kicker).toHaveText(`What's new · Estimates against actuals (3 of ${count})`);
    await page.getByTestId('tour-skip-all').click();
    await expect(page.getByTestId('tour')).toHaveCount(0);
    const after = await tutorialState(api);
    const status = Object.fromEntries(after.whatsNew.map((entry) => [entry.id, entry.status]));
    expect(status['run-in-new-session']).toBe('completed');
    expect(Object.entries(status).filter(([id]) => id !== 'run-in-new-session').every(([, value]) => value === 'skipped')).toBe(true);
    expect(after.main.status).toBeNull();
    await page.reload();
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.getByTestId('tour')).toHaveCount(0);

    // Replay one from Settings: Quick capture's second step needs a session's chat; without one it is skipped, so Next ends it.
    await page.goto(`${server.baseUrl}/settings/tutorial`);
    await expect(page.locator('.sb-set-row[data-row="whats-new-quick-capture"]')).toContainText('1.13.0 · skipped');
    await page.getByTestId('whats-new-replay-quick-capture').click();
    await expect(kicker).toHaveText("What's new · Quick capture");
    await expectStep(page, 'Capture a todo from anywhere', '1 of 2', 'spot');
    await expect(page.getByTestId('tour-skip-all')).toHaveCount(0);
    await page.getByTestId('tour-next').click();
    await expect(page.getByTestId('tour')).toHaveCount(0);
    expect((await tutorialState(api)).whatsNew.find((entry) => entry.id === 'quick-capture')?.status).toBe('skipped');
  });
});

test.describe('a phone (390×844)', () => {
  let tmp: string;
  let server: ServerProcess;

  test.beforeAll(async () => {
    tmp = await makeTempDir('e2e-tutorial-phone');
    server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), ...TUTORIAL_ON });
  });

  test.afterAll(async () => {
    await server?.stop();
    await removeTempDir(tmp);
  });

  test('sidebar steps open the ☰ drawer, the card is a bottom sheet; other steps close the drawer', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      await page.goto(server.baseUrl);
      await expectStep(page, title('sessions'), `1 ${TOTAL}`, 'spot');
      await expect(page.getByTestId('shell')).toHaveAttribute('data-drawer', 'open');
      await expect(card(page)).toHaveAttribute('data-placement', /^sheet-(bottom|top)$/);
      const sheet = await card(page).boundingBox();
      expect(sheet && Math.round(sheet.width)).toBe(390);
      await shot(page, 'phone-1-sessions');
      await page.getByTestId('tour-next').click();
      await expectStep(page, title('new-session'), `2 ${TOTAL}`, 'spot');
      await page.getByTestId('tour-next').click();
      // The chat: no session, a centred step: the drawer closes, the sheet stays at the bottom.
      await expectStep(page, title('chat'), `3 ${TOTAL}`, 'centre');
      await expect(page.getByTestId('shell')).toHaveAttribute('data-drawer', 'closed');
      await expect(card(page)).toHaveAttribute('data-placement', 'sheet-bottom');
      await page.getByTestId('tour-next').click();
      // The Inbox: the app bar's Inbox link.
      await expectStep(page, title('inbox'), `4 ${TOTAL}`, 'spot');
      await shot(page, 'phone-4-inbox');
      await page.getByTestId('tour-skip').click();
      await expect(page.getByTestId('tour')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
