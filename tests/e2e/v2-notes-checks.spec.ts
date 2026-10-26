import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { agentMemory, approvedEntry, settledSession } from './memory-agent.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D136 · v2 and the memory checks (real path: the checks run fake-claude headless). The Notes page
 * of a folder shows its last check with Check now; a note the check says is no longer true moves
 * to "Removed by memory check" (struck through, the reason) and Restore brings it back. A proposal
 * that contradicts an approved note shows "Conflicts with: …" on the Notes page and in Needs you;
 * "Approve and remove the old note" approves it and moves the old note to the removed list. Plus
 * the phone width. The fake's reply is a `[fake:say "…"]` token inside a note's text.
 */
let world: QuestionWorld;
let agentId = '';

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-notes-checks', { env: { ...V2_SERVER_ENV } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

function sayJson(value: unknown): string {
  return `[fake:say ${JSON.stringify(JSON.stringify(value))}]`;
}

async function notes(page: Page): Promise<Array<{ id: string; title: string; status: string }>> {
  return page.evaluate(async () => (await (await fetch('/api/memory/entries')).json()) as Array<{ id: string; title: string; status: string }>);
}

function folderNotes(): string {
  return `${world.baseUrl}/notes?scope=${encodeURIComponent(`folder:${world.workspace}`)}`;
}

test('Notes: Check now removes a stale note into "Removed by memory check"; Restore brings it back', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/notes`);
  const agent = await world.startSession(page, 'notes-checker', 'Reply with just OK.');
  agentId = agent.id;
  await settledSession(page, agent.id);
  const staleId = await approvedEntry(world, page, agent.id, 'Acme old dashboard', 'The dashboard lives in apps/old-dashboard.');
  await approvedEntry(world, page, agent.id, 'Acme dashboard', `The dashboard lives in apps/dashboard. ${sayJson({ notes: [{ id: staleId, action: 'remove', reason: 'apps/old-dashboard was deleted.' }] })}`);

  await openWithHub(page, folderNotes());
  const line = page.getByTestId('v2-notes-check-line');
  await expect(line).toContainText('Not checked yet.');
  await page.getByTestId('v2-notes-check-now').click();
  await expect(line).toContainText('checked 2 notes, removed 1, proposed 0 edits', { timeout: 20_000 });
  const removed = page.getByTestId('v2-notes-removed').getByTestId('v2-notes-removed-row');
  await expect(removed).toHaveCount(1);
  await expect(removed.getByTestId('v2-notes-title')).toHaveText('Acme old dashboard');
  await expect(removed.getByTestId('v2-notes-removed-reason')).toContainText('by the memory check: apps/old-dashboard was deleted.');
  await expect(page.getByTestId('v2-notes-approved').locator(`[data-note-id="${staleId}"]`)).toHaveCount(0);
  await page.screenshot({ path: path.join('test-results', 'v2-notes-checks-removed.png') });

  await removed.getByTestId('v2-notes-restore').click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Restored.' })).toHaveCount(1);
  await expect(page.getByTestId('v2-notes-removed')).toHaveCount(0);
  await expect(page.getByTestId('v2-notes-approved').locator(`[data-note-id="${staleId}"]`)).toHaveCount(1);
});

test('Notes: a conflicting proposal, "Approve and remove the old note"', async ({ page }) => {
  test.skip(agentId === '', 'needs the first test’s agent');
  await openWithHub(page, folderNotes());
  const oldId = await approvedEntry(world, page, agentId, 'Acme currency', 'Prices are shown in EUR.');
  const proposed = await agentMemory(world, agentId, '', { title: 'Acme prices follow the locale', text: `Prices use the visitor’s currency. ${sayJson({ verdict: 'conflict', id: oldId, reason: 'EUR only vs the visitor’s currency.' })}`, scope: 'workspace' });
  expect(proposed.status).toBe(201);
  const row = page.getByTestId('v2-notes-proposed').locator(`[data-note-id="${String(proposed.body['id'])}"]`);
  await expect(row.getByTestId('v2-notes-finding-title')).toHaveText('Conflicts with: Acme currency', { timeout: 20_000 });
  await expect(row.getByTestId('v2-notes-finding-reason')).toHaveText('EUR only vs the visitor’s currency.');
  await expect(row.getByTestId('v2-notes-approve')).toBeVisible();
  await page.screenshot({ path: path.join('test-results', 'v2-notes-checks-conflict.png') });
  await row.getByTestId('v2-notes-approve-replace').click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'The old note moved to “Removed by memory check”.' })).toHaveCount(1);
  await expect(page.getByTestId('v2-notes-removed').locator(`[data-note-id="${oldId}"]`)).toHaveCount(1);
  const approved = (await notes(page)).filter((n) => n.status === 'approved').map((n) => n.title);
  expect(approved).toContain('Acme prices follow the locale');
  expect(approved).not.toContain('Acme currency');
});

test('Needs you: the note card says what it conflicts with; "Approve and remove the old note"', async ({ page }) => {
  test.skip(agentId === '', 'needs the first test’s agent');
  await openWithHub(page, folderNotes());
  const oldId = await approvedEntry(world, page, agentId, 'Acme buttons', 'Use the shared acme-ui buttons.');
  const proposed = await agentMemory(world, agentId, '', { title: 'Acme buttons are local', text: `Each app has its own buttons. ${sayJson({ verdict: 'conflict', id: oldId, reason: 'Shared vs local buttons.' })}`, scope: 'workspace' });
  expect(proposed.status).toBe(201);
  await expect(page.getByTestId('v2-notes-proposed').locator(`[data-note-id="${String(proposed.body['id'])}"]`).getByTestId('v2-notes-finding')).toHaveCount(1, { timeout: 20_000 });
  await openWithHub(page, `${world.baseUrl}/needs-you`);
  const card = page.getByTestId('v2-answer-card').and(page.locator('[data-kind="note"]')).filter({ hasText: 'Acme buttons are local' });
  await expect(card.getByTestId('v2-answer-finding')).toContainText('Conflicts with: Acme buttons');
  await expect(card.getByTestId('v2-answer-finding')).toContainText('Shared vs local buttons.');
  await expect(card.locator('[data-action="note-approve-replace"]')).toHaveText(/Approve and remove the old note/);
  await page.screenshot({ path: path.join('test-results', 'v2-needs-note-conflict.png') });
  await card.locator('[data-action="note-approve-replace"]').click();
  await expect.poll(async () => (await notes(page)).some((n) => n.id === oldId), { timeout: 15_000 }).toBe(false);
  expect((await notes(page)).find((n) => n.id === String(proposed.body['id']))?.status).toBe('approved');
  const removed = await page.evaluate(async () => ((await (await fetch('/api/memory/removed')).json()) as Array<{ id: string; removedBy: string }>).map((r) => `${r.id}:${r.removedBy}`));
  expect(removed).toContain(`${oldId}:approval`);
});

test('phone width (390 × 844): the finding, the check line and the removed list fit', async ({ page }) => {
  test.skip(agentId === '', 'needs the first test’s agent');
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, folderNotes());
  const oldId = await approvedEntry(world, page, agentId, 'Acme lint command', 'npm run lint');
  const proposed = await agentMemory(world, agentId, '', { title: 'Acme lint is eslint', text: `Lint with npx eslint . ${sayJson({ verdict: 'duplicate', id: oldId, reason: 'Both name the lint command.' })}`, scope: 'workspace' });
  expect(proposed.status).toBe(201);
  const row = page.getByTestId('v2-notes-proposed').locator(`[data-note-id="${String(proposed.body['id'])}"]`);
  await expect(row.getByTestId('v2-notes-finding-title')).toHaveText('Duplicates: Acme lint command', { timeout: 20_000 });
  await expect(page.getByTestId('v2-notes-check')).toBeVisible();
  for (const locator of [row.getByTestId('v2-notes-approve-replace'), page.getByTestId('v2-notes-check-now')]) {
    const box = await locator.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await row.getByTestId('v2-notes-approve-replace').click();
  const removed = page.getByTestId('v2-notes-removed').locator(`[data-note-id="${oldId}"]`);
  await expect(removed).toHaveCount(1);
  const restore = await removed.getByTestId('v2-notes-restore').boundingBox();
  expect((restore?.x ?? 0) + (restore?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join('test-results', 'v2-notes-checks-phone-dark.png'), fullPage: true });
  await removed.getByTestId('v2-notes-restore').click();
  await expect(page.getByTestId('v2-notes-approved').locator(`[data-note-id="${oldId}"]`)).toHaveCount(1);
});

test('Settings → Advanced → Notes checks: the same switches in v2', async ({ page }) => {
  test.skip(agentId === '', 'needs the first test’s agent');
  await openWithHub(page, `${world.baseUrl}/settings/advanced`);
  await page.getByTestId('v2-advanced-memory').click();
  const body = page.getByTestId('v2-advanced-body');
  await expect(body.getByTestId('settings-title')).toHaveText('Project memory');
  await expect(body.locator('[data-row="memory-check"]').getByTestId('setting-value')).toHaveText('on');
  await expect(body.locator('[data-row="memory-check-folder"]')).toHaveCount(1);
});
