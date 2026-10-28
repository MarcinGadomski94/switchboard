import { type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.0 (2.4.5) · a teammate's chat straight from its crew: the card's main area
 * (avatar, name, rhythm) and its Open chat button open the teammate's agent the way ⋯ › Open
 * chat does (the peek on a computer, the agent's page on a phone); ⋯ still only opens its
 * menu, Details its panel; Enter on the focused card opens it. On Crews, a teammate's avatar
 * opens its chat while the rest of the card opens the crew.
 */
let world: TeamWorld;
let mate = { id: '', sessionId: '' };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-v2-crew-open-chat', { plain: true, env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory' } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

const card = (page: Page) => page.locator(`[data-testid="v2-teammate"][data-member="${mate.id}"]`);
const peek = (page: Page) => page.getByTestId('v2-agent-peek');

async function closePeek(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(peek(page)).toHaveCount(0);
}

test('the teammate card’s name and its Open chat button open its agent; ⋯ and Details do not', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${world.baseUrl}/crews`);
  const session = await world.startSession(page, 'acme-review-run', 'Reply with just OK.');
  await world.settle(page, session.id);
  const adopted = await world.adopt(page, session.id, 'Reviewer');
  mate = { id: adopted.id, sessionId: session.id };

  await page.goto(`${world.baseUrl}/crews/team`);
  // The name opens the peek of its agent; the crew page stays.
  await card(page).getByText('Reviewer', { exact: true }).click();
  await expect(peek(page)).toBeVisible();
  await expect(page.getByTestId('v2-agent-peek-name')).toContainText('Reviewer');
  await expect(page).toHaveURL(/\/crews\/team$/);
  await closePeek(page);
  // So does the avatar beside it (the same hit area).
  // (the name's button lies over it, so the pointer goes to the position, not the element).
  const avatar = await card(page).locator('.v2-c-mate-main .v2-av').boundingBox();
  if (!avatar) throw new Error('no avatar');
  await page.mouse.click(avatar.x + avatar.width / 2, avatar.y + avatar.height / 2);
  await expect(peek(page)).toBeVisible();
  await closePeek(page);

  // The Open chat button next to Details does the same.
  const chat = card(page).getByTestId('v2-teammate-chat');
  await expect(chat).toHaveAccessibleName('Open the chat of Reviewer');
  // It fits the compact card's foot (on a narrow card, the icon alone; its tooltip names it).
  const foot = card(page).locator('.v2-c-mate-foot');
  expect(await foot.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await chat.click();
  await expect(peek(page)).toBeVisible();
  await closePeek(page);

  // ⋯ opens its menu (Open chat still in it) and nothing else.
  await card(page).getByTestId('v2-teammate-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Open chat' })).toBeVisible();
  await expect(peek(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/crews\/team$/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Open chat' })).toHaveCount(0);
  await expect(peek(page)).toHaveCount(0);

  // Details opens the teammate's panel, not its chat.
  await card(page).getByTestId('v2-teammate-details').click();
  await expect(page.getByTestId('v2-teammate-sheet')).toBeVisible();
  await expect(peek(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/crews\/team$/);

  // The job description box is its own area.
  await card(page).getByTestId('v2-teammate-jd').click();
  await expect(peek(page)).toHaveCount(0);

  // Keyboard: the card's main button takes focus, Enter opens.
  const open = card(page).getByTestId('v2-teammate-open');
  await open.focus();
  await expect(open).toBeFocused();
  await expect(open).toHaveCSS('cursor', 'pointer');
  await page.keyboard.press('Enter');
  await expect(peek(page)).toBeVisible();
  await closePeek(page);
});

test('Crews: a teammate’s avatar opens its chat; the rest of the card opens the crew', async ({ page }) => {
  await page.goto(`${world.baseUrl}/crews`);
  const crewCard = page.locator('[data-testid="v2-crew-card"][data-crew="team"]');
  const avatar = crewCard.locator(`[data-testid="v2-crew-card-mate"][data-session="${mate.sessionId}"]`);
  await expect(avatar).toHaveAccessibleName('Open the chat of Reviewer');
  await expect(avatar).toHaveAttribute('title', /^Reviewer · /);
  await avatar.click();
  await expect(peek(page)).toBeVisible();
  await expect(page).toHaveURL(/\/crews$/);
  await closePeek(page);
  await crewCard.getByRole('heading', { name: 'Team' }).click();
  await expect(page).toHaveURL(/\/crews\/team$/);
});

test('phone 390 × 844: the row’s chat button and the teammate screen’s Open chat open its agent', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/crews/team`);
  const chat = page.locator(`[data-testid="v2-teammate-row-chat"][data-member="${mate.id}"]`);
  await expect(chat).toBeVisible();
  const box = await chat.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await chat.click();
  await expect(page).toHaveURL(new RegExp(`/agents/${mate.sessionId}$`));
  await expect(page.getByTestId('v2-agent-title')).toHaveText('Reviewer');

  // The row itself still drills down to the teammate; its Open chat opens the agent.
  await page.goto(`${world.baseUrl}/crews/team`);
  await page.locator(`[data-testid="v2-teammate-row"][data-member="${mate.id}"]`).click();
  await expect(page.getByTestId('v2-teammate-panel')).toBeVisible();
  await page.getByTestId('v2-teammate-chat').click();
  await expect(page).toHaveURL(new RegExp(`/agents/${mate.sessionId}$`));
});
