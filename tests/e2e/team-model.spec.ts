import { type Page, expect, test } from '@playwright/test';
import { openWithHub } from './question-world.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';

/**
 * D100 follow-up 2026-10-14 · the member's model dropdown (`docs/team.md` → *Model
 * and effort*), with fake-claude (its `initialize` lists the recorded 11 models;
 * every later `init` reports the chosen one): the Settings tab lists the CLI's
 * models in the session header's picker, an effort row only for a model with levels,
 * a pick + Save changes the session's model and the next turn runs on it, the choice
 * is there after a reload, and a template's model is pre-selected in the Create form.
 */

let world: TeamWorld;

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-team-model', { plain: true });
});

test.afterAll(async () => {
  await world?.stop();
});

test.describe.configure({ mode: 'serial' });

async function closeToasts(page: Page): Promise<void> {
  while (await page.getByTestId('toast').first().isVisible()) await page.getByTestId('toast').first().getByRole('button', { name: 'Close' }).click();
}

test('Settings: the CLI\'s models in a dropdown, effort only with levels; a pick changes the session\'s model for its next turn and stays after a reload', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/team`);
  await world.setTeam(page, true);
  const session = await world.startSession(page, 'model-member', 'Reply with just OK.');
  await world.settle(page, session.id);
  const member = await world.adopt(page, session.id, 'Builder');
  await world.settle(page, session.id);
  await page.goto(`${world.baseUrl}/team`);
  await page.getByTestId('team-card').filter({ hasText: 'Builder' }).click();
  await page.getByTestId('team-tab-settings').click();

  // The session runs on the CLI's default: the dropdown starts there and lists fake-claude's 11 models.
  const button = page.getByTestId('team-form-model-button');
  await expect(button).toHaveText('Default▾');
  await button.click();
  await expect(page.getByTestId('model-option')).toHaveCount(11);
  await expect(page.locator('[data-testid="model-option"][data-value="default"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('effort-option')).toHaveText(['Default', 'low', 'medium', 'high', 'xhigh', 'max']);
  // Haiku has no effort levels: the effort row goes; Opus has them.
  await page.locator('[data-testid="model-option"][data-value="haiku"]').click();
  await expect(page.getByTestId('effort-list')).toHaveCount(0);
  await page.locator('[data-testid="model-option"][data-value="opus"]').click();
  await expect(page.getByTestId('effort-list')).toBeVisible();
  await page.locator('[data-testid="model-option"][data-value="haiku"]').click();
  await expect(button).toHaveText('Haiku 4.5▾');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('model-popover')).toHaveCount(0);
  // Esc closed only the popover, not the page.
  await expect(page.getByTestId('team-settings')).toBeVisible();
  await page.getByTestId('team-settings-save').click();
  await expect(page.getByTestId('team-settings-note')).toContainText('Saved');

  // The session's model changed the way the header's picker changes it (its step line), and the next turn runs on it.
  await expect.poll(async () => (await world.call(page, 'GET', `/api/sessions/${session.id}`)).body.model.current as string | null).toBe('haiku');
  expect((await world.call(page, 'GET', `/api/team/members/${member.id}`)).body.model).toBe('haiku');
  await world.call(page, 'POST', `/api/sessions/${session.id}/messages`, { text: 'Reply with just OK.' });
  await world.settle(page, session.id);
  await expect.poll(async () => (await world.call(page, 'GET', `/api/sessions/${session.id}`)).body.context?.model as string | null, { timeout: 20_000 }).toBe('claude-haiku-4-5-20251001');
  // The panel's subline shows what the session runs with.
  await expect(page.getByTestId('team-panel-sub')).toContainText('Haiku 4.5');

  // Kept after a reload.
  await page.reload();
  await page.getByTestId('team-card').filter({ hasText: 'Builder' }).click();
  await page.getByTestId('team-tab-settings').click();
  await expect(page.getByTestId('team-form-model-button')).toHaveText('Haiku 4.5▾');
  await page.screenshot({ path: test.info().outputPath('team-model-settings.png') });

  // D100 follow-up: a model picked in the session's own header is the member's saved model too.
  await page.goto(`${world.baseUrl}/sessions/${session.id}`);
  await page.getByTestId('session-model-button').click();
  await page.locator('[data-testid="model-option"][data-value="sonnet"]').click();
  await expect(page.getByTestId('session-model-button')).toHaveText('Sonnet 5▾');
  await expect.poll(async () => (await world.call(page, 'GET', `/api/team/members/${member.id}`)).body.model as string).toBe('sonnet');
  await page.goto(`${world.baseUrl}/team`);
  await page.getByTestId('team-card').filter({ hasText: 'Builder' }).click();
  await page.getByTestId('team-tab-settings').click();
  await expect(page.getByTestId('team-form-model-button')).toHaveText('Sonnet 5▾');
});

test('Create from a template: its suggested model and effort are pre-selected when the CLI offers them', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/team`);
  await world.setTeam(page, true);
  await closeToasts(page);
  await page.getByTestId('team-add').click();
  await page.getByTestId('team-add-template').click();
  // Planner suggests Opus · high.
  await page.locator('[data-testid="team-template"][data-template-id="planner"]').click();
  await expect(page.getByTestId('team-form-model-button')).toHaveText('Opus 5.5 · high▾');
  await page.getByTestId('team-form-model-button').click();
  await expect(page.locator('[data-testid="effort-option"][data-value="high"]')).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: test.info().outputPath('team-model-template.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('team-form-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('team-form-dialog')).toHaveCount(0);
  // Delivery tracking suggests Haiku · low: Haiku has no levels, so only the model is taken.
  await page.getByTestId('team-add').click();
  await page.getByTestId('team-add-template').click();
  await page.locator('[data-testid="team-template"][data-template-id="delivery-tracking"]').click();
  await expect(page.getByTestId('team-form-model-button')).toHaveText('Haiku 4.5▾');
});
