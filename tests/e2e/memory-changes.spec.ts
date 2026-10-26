import path from 'node:path';
import { expect, test } from '@playwright/test';
import { agentMemory, approvedEntry, settledSession } from './memory-agent.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';

/**
 * D135 · the classic Memory page reviews an agent's proposals to change approved entries (real
 * path, fake-claude): an edit shows the entry now and as proposed side by side (removed words
 * struck, added ones marked); Edit… then Approve replaces it under the same id; a removal shows the
 * entry and the reason: Reject keeps it, Approve removal deletes it. Plus the phone width.
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-memory-changes');
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

test('an edit and a removal: compare, Edit… → Approve keeps the id; Reject keeps it; Approve removal deletes it', async ({ page }) => {
  await page.goto(`${world.baseUrl}/memory`);
  const agent = await world.startSession(page, 'mem-changer', 'Reply with just OK.');
  await settledSession(page, agent.id);
  const testsId = await approvedEntry(world, page, agent.id, 'Acme test command', 'Run npm test with ports 4600-4699.');
  const stagingId = await approvedEntry(world, page, agent.id, 'Acme staging deploy', 'Deploy to staging before production.');

  const edit = await agentMemory(world, agent.id, '/edit', { entry: testsId, text: 'Run npm run test:unit with ports 4600-4699.', reason: 'The script was renamed.' });
  expect(edit.status).toBe(201);
  const removal = await agentMemory(world, agent.id, '/retract', { entry: stagingId, reason: 'Staging was retired.' });
  expect(removal.status).toBe(201);

  await page.goto(`${world.baseUrl}/memory`);
  const queue = page.getByTestId('memory-queue');
  await expect(queue.getByTestId('memory-proposal')).toHaveCount(2);
  const editCard = queue.locator('[data-change="edit"]');
  await expect(editCard.getByTestId('memory-change-kind')).toHaveText('Edit');
  await expect(editCard.getByTestId('memory-compare-now-text')).toHaveText('Run npm test with ports 4600-4699.');
  await expect(editCard.getByTestId('memory-compare-proposed-text')).toHaveText('Run npm run test:unit with ports 4600-4699.');
  await expect(editCard.getByTestId('memory-compare-now-text').locator('del')).toHaveText('test ');
  await expect(editCard.getByTestId('memory-compare-proposed-text').locator('ins')).toHaveText('run test:unit ');
  await expect(editCard.getByTestId('memory-change-reason')).toContainText('The script was renamed.');
  const removalCard = queue.locator('[data-change="retract"]');
  await expect(removalCard.getByTestId('memory-removal')).toContainText('Deploy to staging before production.');
  await expect(removalCard.getByTestId('memory-change-reason')).toContainText('Staging was retired.');
  await expect(removalCard.getByTestId('memory-approve')).toHaveText('Approve removal');
  await expect(removalCard.getByTestId('memory-edit')).toHaveCount(0);
  await page.screenshot({ path: path.join('test-results', 'memory-changes-review.png') });

  // Edit… then Approve: the developer's words replace the entry, which keeps its id.
  await editCard.getByTestId('memory-edit').click();
  await editCard.getByTestId('memory-form-text').fill('Run npm run test:unit with ports 4600-4699 (unit tests only).');
  await editCard.getByTestId('memory-form-approve').click();
  const approved = page.getByTestId('memory-approved').getByTestId('memory-entry');
  await expect(page.locator(`[data-testid="memory-entry"][data-entry-id="${testsId}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-testid="memory-entry"][data-entry-id="${testsId}"]`).getByTestId('memory-entry-text')).toHaveText('Run npm run test:unit with ports 4600-4699 (unit tests only).');
  await expect(approved).toHaveCount(2);

  // Reject the removal: the entry stays.
  await removalCard.getByTestId('memory-reject').click();
  await expect(queue.getByTestId('memory-proposal')).toHaveCount(0);
  await expect(page.locator(`[data-testid="memory-entry"][data-entry-id="${stagingId}"]`)).toHaveCount(1);

  // A second removal (a rejected proposal does not block a new one), approved: the entry is gone.
  expect((await agentMemory(world, agent.id, '/retract', { entry: stagingId, reason: 'Staging really was retired.' })).status).toBe(201);
  expect((await agentMemory(world, agent.id, '/retract', { entry: stagingId, reason: 'Again.' })).status).toBe(409);
  await expect(queue.locator('[data-change="retract"]')).toHaveCount(1);
  await queue.locator('[data-change="retract"]').getByTestId('memory-approve').click();
  await expect(queue.getByTestId('memory-proposal')).toHaveCount(0);
  await expect(page.locator(`[data-testid="memory-entry"][data-entry-id="${stagingId}"]`)).toHaveCount(0);
  await expect(approved).toHaveCount(1);
  const stored = await page.evaluate(async () => ((await (await fetch('/api/memory/entries')).json()) as Array<{ title: string; status: string }>).map((e) => `${e.status}:${e.title}`));
  expect(stored.filter((line) => line.startsWith('approved:'))).toEqual(['approved:Acme test command']);
});

test('phone width (390 × 844): the comparison stacks and fits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/memory`);
  const agent = await world.startSession(page, 'mem-phone', 'Reply with just OK.');
  await settledSession(page, agent.id);
  const id = await approvedEntry(world, page, agent.id, 'Acme lint command', 'npm run lint');
  expect((await agentMemory(world, agent.id, '/edit', { entry: id, title: 'Acme lint and format', text: 'npm run lint && npm run format', reason: 'Format too.' })).status).toBe(201);
  await page.goto(`${world.baseUrl}/memory`);
  const card = page.getByTestId('memory-queue').locator('[data-change="edit"]');
  await expect(card).toHaveCount(1);
  const now = await card.getByTestId('memory-compare-now').boundingBox();
  const proposed = await card.getByTestId('memory-compare-proposed').boundingBox();
  // One column: the proposed side under the current one.
  expect((proposed?.y ?? 0) > (now?.y ?? 0) + (now?.height ?? 0) - 1).toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: path.join('test-results', 'memory-changes-phone.png'), fullPage: true });
  await card.getByTestId('memory-approve').click();
  await expect(page.locator(`[data-testid="memory-entry"][data-entry-id="${id}"]`).getByTestId('memory-entry-title')).toHaveText('Acme lint and format');
});
