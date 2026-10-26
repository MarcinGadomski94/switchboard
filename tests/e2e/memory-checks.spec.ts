import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { agentMemory, approvedEntry, settledSession } from './memory-agent.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';

/**
 * D136 · the classic Memory page and the memory checks (real path: the checks run fake-claude
 * headless, as they run the real CLI). Check now verifies the folder's notes: the one the check
 * says is no longer true moves to "Removed by memory check", and Restore puts it back (same id).
 * A new proposal that contradicts an approved note shows "Conflicts with: …" with the reason;
 * "Approve and remove the old note" approves it and moves the old note to the removed list. Plus
 * the phone width. The fake's reply is chosen with a `[fake:say "…"]` token inside a note's text,
 * which the check's prompt carries.
 */
let world: QuestionWorld;
let agentId = '';

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-memory-checks');
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

/** A `[fake:say "<json>"]` token: fake-claude answers exactly `value` as JSON. */
function sayJson(value: unknown): string {
  return `[fake:say ${JSON.stringify(JSON.stringify(value))}]`;
}

async function entries(page: Page): Promise<Array<{ id: string; title: string; status: string }>> {
  return page.evaluate(async () => (await (await fetch('/api/memory/entries')).json()) as Array<{ id: string; title: string; status: string }>);
}

test('Check now: a note that is no longer true is removed (quietly), listed, and Restore brings it back', async ({ page }) => {
  await page.goto(`${world.baseUrl}/memory`);
  const agent = await world.startSession(page, 'mem-checker', 'Reply with just OK.');
  agentId = agent.id;
  await settledSession(page, agent.id);
  const staleId = await approvedEntry(world, page, agent.id, 'Acme old script', 'Run scripts/legacy.sh before a release.');
  // The second note carries the fake's answer for the check: remove the first.
  await approvedEntry(world, page, agent.id, 'Acme release branch', `Releases go from release/main. ${sayJson({ notes: [{ id: staleId, action: 'remove', reason: 'scripts/legacy.sh no longer exists.' }] })}`);

  await page.goto(`${world.baseUrl}/memory`);
  const line = page.getByTestId('memory-check-line');
  await expect(line).toContainText('Not checked yet.');
  await page.getByTestId('memory-check-now').click();
  await expect(line).toContainText('checked 2 notes, removed 1, proposed 0 edits', { timeout: 20_000 });
  const removed = page.getByTestId('memory-removed');
  await expect(removed.getByTestId('memory-removed-entry')).toHaveCount(1);
  await expect(removed.getByTestId('memory-entry-title')).toHaveText('Acme old script');
  await expect(removed.getByTestId('memory-removed-reason')).toContainText('by the memory check: scripts/legacy.sh no longer exists.');
  await expect(page.locator(`[data-testid="memory-entry"][data-entry-id="${staleId}"]`)).toHaveCount(0);
  // Quiet: no Inbox item for a check's run.
  const inbox = await page.evaluate(async () => ((await (await fetch('/api/inbox')).json()) as Array<{ title?: string }>).map((item) => item.title ?? ''));
  expect(inbox.some((title) => /check/i.test(title))).toBe(false);
  await page.screenshot({ path: path.join('test-results', 'memory-checks-removed.png') });

  await removed.getByTestId('memory-restore').click();
  await expect(page.getByTestId('memory-removed')).toHaveCount(0);
  await expect(page.locator(`[data-testid="memory-entry"][data-entry-id="${staleId}"]`)).toHaveCount(1);
  expect((await entries(page)).filter((e) => e.status === 'approved').map((e) => e.id)).toContain(staleId);
});

test('a contradicting proposal: "Conflicts with" and "Approve and remove the old note"', async ({ page }) => {
  test.skip(agentId === '', 'needs the first test’s agent');
  await page.goto(`${world.baseUrl}/memory`);
  const oldId = await approvedEntry(world, page, agentId, 'Acme staging deploy', 'Deploy to staging before production.');
  const proposed = await agentMemory(world, agentId, '', {
    title: 'Acme deploys go straight to production',
    text: `Staging was retired; deploy to production. ${sayJson({ verdict: 'conflict', id: oldId, reason: 'One says staging first, the other says no staging.' })}`,
    scope: 'workspace',
  });
  expect(proposed.status).toBe(201);
  const card = page.locator(`[data-testid="memory-proposal"][data-entry-id="${String(proposed.body['id'])}"]`);
  await expect(card.getByTestId('memory-finding-title')).toHaveText('Conflicts with: Acme staging deploy', { timeout: 20_000 });
  await expect(card.getByTestId('memory-finding-reason')).toHaveText('One says staging first, the other says no staging.');
  await expect(card.getByTestId('memory-approve')).toBeVisible();
  await page.screenshot({ path: path.join('test-results', 'memory-checks-conflict.png') });

  await card.getByTestId('memory-approve-replace').click();
  await expect(page.getByTestId('memory-queue').getByTestId('memory-proposal')).toHaveCount(0);
  await expect(page.locator(`[data-testid="memory-entry"][data-entry-id="${oldId}"]`)).toHaveCount(0);
  const removed = page.getByTestId('memory-removed').locator(`[data-entry-id="${oldId}"]`);
  await expect(removed.getByTestId('memory-removed-reason')).toContainText('when you approved its replacement: Replaced by “Acme deploys go straight to production”');
  const approved = (await entries(page)).filter((e) => e.status === 'approved').map((e) => e.title);
  expect(approved).toContain('Acme deploys go straight to production');
  expect(approved).not.toContain('Acme staging deploy');
});

test('phone width (390 × 844): the finding, the check line and the removed list fit', async ({ page }) => {
  test.skip(agentId === '', 'needs the first test’s agent');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/memory`);
  const oldId = await approvedEntry(world, page, agentId, 'Acme lint command', 'npm run lint');
  const proposed = await agentMemory(world, agentId, '', { title: 'Acme lint is eslint', text: `Lint with npx eslint . ${sayJson({ verdict: 'duplicate', id: oldId, reason: 'Both name the lint command.' })}`, scope: 'workspace' });
  expect(proposed.status).toBe(201);
  const card = page.locator(`[data-testid="memory-proposal"][data-entry-id="${String(proposed.body['id'])}"]`);
  await expect(card.getByTestId('memory-finding-title')).toHaveText('Duplicates: Acme lint command', { timeout: 20_000 });
  await expect(page.getByTestId('memory-check-status')).toBeVisible();
  for (const testId of ['memory-approve-replace', 'memory-check-now']) {
    const box = await page.getByTestId(testId).first().boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: path.join('test-results', 'memory-checks-phone.png'), fullPage: true });
  await card.getByTestId('memory-approve-replace').click();
  const removed = page.getByTestId('memory-removed').locator(`[data-entry-id="${oldId}"]`);
  await expect(removed).toHaveCount(1);
  const restore = await removed.getByTestId('memory-restore').boundingBox();
  expect((restore?.x ?? 0) + (restore?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await removed.getByTestId('memory-restore').click();
  await expect(page.locator(`[data-testid="memory-entry"][data-entry-id="${oldId}"]`)).toHaveCount(1);
});

test('Settings → Project memory: the switch, the frequency and the per-folder off', async ({ page }) => {
  test.skip(agentId === '', 'needs the first test’s agent');
  await page.goto(`${world.baseUrl}/settings/memory`);
  const content = page.getByTestId('settings-content');
  await expect(content.getByTestId('settings-title')).toHaveText('Project memory');
  const main = content.locator('[data-row="memory-check"]').getByTestId('setting-value');
  await expect(main).toHaveText('on');
  await expect(content.getByTestId('memory-check-frequency')).toHaveValue('7');
  await content.getByTestId('memory-check-frequency').selectOption('14');
  await expect.poll(async () => page.evaluate(async () => ((await (await fetch('/api/memory/check/settings')).json()) as { frequencyDays: number }).frequencyDays)).toBe(14);
  const folder = content.locator('[data-row="memory-check-folder"]');
  await expect(folder).toHaveCount(1);
  await expect(folder.getByTestId('memory-check-folder-line')).toContainText('Checked today');
  await folder.getByTestId('setting-value').click();
  await expect(folder.getByTestId('memory-check-folder-line')).toContainText('Automatic checks are off for this folder.');
  await page.goto(`${world.baseUrl}/memory`);
  await expect(page.getByTestId('memory-check-line')).toContainText('Automatic checks are off for this folder.');
  await page.goto(`${world.baseUrl}/settings/memory`);
  await main.click();
  await expect(main).toHaveText('off');
  await expect(content.getByTestId('memory-check-frequency')).toBeDisabled();
});
