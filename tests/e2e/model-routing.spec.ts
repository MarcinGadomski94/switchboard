import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';

/**
 * D82 on the real path (D13): Settings → Sessions → *Model by task*. Off (no rules)
 * on a fresh install; + Add rule, the selects, ↑ ↓ ×, the "Routed by rule" preview,
 * Save (stored, survives a reload), a refusal shown under its rule, and the
 * editor wrapping on a phone (never sideways).
 */
let world: QuestionWorld;
const SHOTS = process.env['LANE_E_SHOTS'] ?? null;

test.beforeAll(async () => {
  world = await startQuestionWorld('model-routing');
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  await world?.stop();
});

test('add, edit, order and save rules; a reload keeps them; a refusal names the rule', async ({ page }) => {
  await page.goto(`${world.baseUrl}/settings/sessions`);
  const row = page.locator('[data-row="model-rules"]');
  await expect(row).toContainText('Model by task');
  await expect(row.getByTestId('model-rules-empty')).toHaveText('No rules: todos run with the normal choice.');
  await expect(row.getByTestId('model-rules-save')).toBeDisabled();

  // Rule 1: low ≤ 30 min → Sonnet.
  await row.getByTestId('model-rules-add').click();
  const rules = row.getByTestId('model-rule');
  await expect(rules).toHaveCount(1);
  await rules.nth(0).getByTestId('rule-model').selectOption('sonnet');
  await expect(rules.nth(0).getByTestId('rule-preview')).toHaveText('Routed by rule: low ≤30 min → Sonnet');

  // Rule 2: urgent, any estimate → Opus.
  await row.getByTestId('model-rules-add').click();
  await rules.nth(1).getByTestId('rule-priority').selectOption('urgent');
  await rules.nth(1).getByTestId('rule-estimate').selectOption('any');
  await rules.nth(1).getByTestId('rule-model').selectOption('opus');
  await expect(rules.nth(1).getByTestId('rule-minutes')).toHaveCount(0);
  await expect(rules.nth(1).getByTestId('rule-preview')).toHaveText('Routed by rule: urgent → Opus');

  // Rule 3: any priority, > 120 min → Codex CLI (its model / effort / account need the CLI first).
  await row.getByTestId('model-rules-add').click();
  await rules.nth(2).getByTestId('rule-priority').selectOption('any');
  await rules.nth(2).getByTestId('rule-estimate').selectOption('more-than');
  await rules.nth(2).getByTestId('rule-minutes').fill('120');
  await rules.nth(2).getByTestId('rule-cli').selectOption('');
  await expect(rules.nth(2).getByTestId('rule-model')).toBeDisabled();
  await rules.nth(2).getByTestId('rule-cli').selectOption('codex');
  await expect(rules.nth(2).getByTestId('rule-preview')).toHaveText('Routed by rule: any priority >120 min → Codex CLI');

  // Order: urgent first.
  await rules.nth(1).getByTestId('rule-up').click();
  await expect(rules.nth(0).getByTestId('rule-preview')).toHaveText('Routed by rule: urgent → Opus');
  if (SHOTS) await row.screenshot({ path: `${SHOTS}/rules-editor-1440.png` });

  await row.getByTestId('model-rules-save').click();
  await expect(row.getByTestId('model-rules-save')).toBeDisabled();
  const stored = await page.evaluate(async () => ((await (await fetch('/api/settings')).json()) as Record<string, unknown>)['sessions.modelRules']);
  expect(stored).toMatchObject([
    { priority: 'urgent', estimate: { kind: 'any' }, provider: 'claude', model: 'opus' },
    { priority: 'low', estimate: { kind: 'at-most', minutes: 30 }, provider: 'claude', model: 'sonnet' },
    { priority: 'any', estimate: { kind: 'more-than', minutes: 120 }, provider: 'codex' },
  ]);

  await page.reload();
  await expect(rules).toHaveCount(3);
  await expect(rules.nth(1).getByTestId('rule-preview')).toHaveText('Routed by rule: low ≤30 min → Sonnet');

  // A refusal (0 minutes) shows the server's reason under that rule; nothing is stored.
  await rules.nth(1).getByTestId('rule-minutes').fill('0');
  await row.getByTestId('model-rules-save').click();
  await expect(rules.nth(1).getByTestId('rule-error')).toContainText('minutes must be a whole number');
  await expect(rules.nth(1)).toHaveAttribute('data-invalid', 'true');
  await row.getByTestId('model-rules-discard').click();
  await expect(rules.nth(1).getByTestId('rule-minutes')).toHaveValue('30');

  // Remove one: saved as two.
  await rules.nth(2).getByTestId('rule-remove').click();
  await row.getByTestId('model-rules-save').click();
  await expect(row.getByTestId('model-rules-save')).toBeDisabled();
  expect(await page.evaluate(async () => (((await (await fetch('/api/settings')).json()) as Record<string, unknown[]>)['sessions.modelRules'] ?? []).length)).toBe(2);
});

test('on a phone the rules wrap inside the page (no sideways scroll)', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`${world.baseUrl}/settings/sessions`);
  const row = page.locator('[data-row="model-rules"]');
  await expect(row.getByTestId('model-rule').first()).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await row.getByTestId('model-rule').first().boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
  if (SHOTS) await row.screenshot({ path: `${SHOTS}/rules-editor-360.png` });
});
