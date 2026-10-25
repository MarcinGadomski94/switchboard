import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · lane A · the v2 Notes page (`/notes`, "What agents know") on the real
 * path (fake-claude): an agent proposes a note through `/agent/v1/memory` (what
 * `memory_propose` sends); it arrives live, proposed and first, with its scope in
 * plain words; Approve moves it to the approved list with the toast; Edit saves;
 * Delete offers Undo. Plus the phone width (390 × 844).
 */
let world: QuestionWorld;
let proposerId = '';

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-notes', { env: { ...V2_SERVER_ENV } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

/** What the agent's `memory_propose` does: `POST /agent/v1/memory` with the session's agent token. */
async function agentPropose(sessionId: string, input: { title: string; text: string }): Promise<number> {
  const secret = (await readFile(path.join(world.dataDir, 'sb_token'), 'utf8')).trim();
  const token = createHmac('sha256', secret).update(`switchboard-agent-todos:${sessionId}`).digest('base64url');
  const url = new URL(world.baseUrl);
  const body = JSON.stringify(input);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: '/agent/v1/memory',
        method: 'POST',
        headers: { host: url.host, authorization: `Bearer ${token}`, 'x-switchboard-session': sessionId, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function settled(page: Page, id: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async (sid) => ((await (await fetch(`/api/sessions/${sid}`)).json()) as { status: string }).status, id), { timeout: 20_000 }).toMatch(/^(done|idle)$/);
}

test('a proposed note arrives live, first; Approve, Edit, Delete with Undo', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/notes`);
  await expect(page.getByTestId('v2-page-notes')).toBeVisible();
  await expect(page.getByTestId('v2-notes-empty')).toBeVisible();
  await expect(page.getByTestId('v2-notes-tip')).toContainText('Agents propose notes; you approve them in Needs you.');

  const proposer = await world.startSession(page, 'note-proposer', 'Reply with just OK.');
  proposerId = proposer.id;
  await settled(page, proposer.id);
  expect(await agentPropose(proposer.id, { title: 'Use the shared buttons', text: 'The checkout uses the shared acme-ui buttons; never style buttons by hand.' })).toBe(201);

  // Live (memoryChanged): proposed, marked, with its scope in plain words and its author.
  const proposed = page.getByTestId('v2-notes-proposed').getByTestId('v2-notes-row');
  await expect(proposed).toHaveCount(1);
  await expect(proposed).toHaveAttribute('data-status', 'proposed');
  await expect(proposed.getByTestId('v2-status')).toContainText('Proposed');
  await expect(proposed.getByTestId('v2-notes-scope')).toHaveText(/^(Folder|Code project) · /);
  await expect(proposed).toContainText('by note-proposer');
  await expect(page.getByTestId('v2-notes-empty')).toHaveCount(0);
  await page.screenshot({ path: path.join('test-results', 'v2-notes-desktop.png') });

  // Approve: the toast, the row moves to the approved list.
  await proposed.getByTestId('v2-notes-approve').click();
  await expect(page.getByTestId('v2-toast').first()).toContainText(/^Approved\. Agents in .+ now know it\./);
  await expect(page.getByTestId('v2-notes-proposed')).toHaveCount(0);
  const approved = page.getByTestId('v2-notes-approved').getByTestId('v2-notes-row');
  await expect(approved).toHaveCount(1);
  await expect(approved).toHaveAttribute('data-status', 'approved');
  await expect(approved.getByTestId('v2-notes-title')).toHaveText('Use the shared buttons');
  const stored = await page.evaluate(async () => ((await (await fetch('/api/memory/entries?scope=')).json()) as Array<{ status: string }>).map((e) => e.status));
  expect(stored).toEqual(['approved']);

  // Edit (Dialog): saved through the API.
  await approved.getByTestId('v2-notes-edit').click();
  const dialog = page.getByTestId('v2-notes-edit-dialog');
  await dialog.getByTestId('v2-notes-edit-text').fill('Use acme-ui buttons everywhere.');
  await dialog.getByTestId('v2-notes-edit-save').click();
  await expect(dialog).toHaveCount(0);
  await expect(approved.getByTestId('v2-notes-text')).toHaveText('“Use acme-ui buttons everywhere.”');

  // Delete: hidden at once, Undo brings it back (nothing was deleted).
  await approved.getByTestId('v2-notes-delete').click();
  await expect(page.getByTestId('v2-notes-approved')).toHaveCount(0);
  await page.getByTestId('v2-toast-undo').click();
  await expect(page.getByTestId('v2-notes-approved').getByTestId('v2-notes-row')).toHaveCount(1);

  // The scope filter: All and the note's own scope; ?scope= preselects.
  const options = page.getByTestId('v2-notes-filter-option');
  await expect(options.first()).toHaveAttribute('aria-pressed', 'true');
  await options.nth(1).click();
  await expect(page).toHaveURL(/\/notes\?scope=/);
  await expect(options.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('v2-notes-row')).toHaveCount(1);
});

test('phone width (390 × 844): the note and its buttons fit, touch-sized', async ({ page }) => {
  test.skip(proposerId === '', 'needs the first test’s note');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await agentPropose(proposerId, { title: 'Release notes language', text: 'Release notes are written in British English.' })).toBe(201);
  await openWithHub(page, `${world.baseUrl}/notes`);
  const row = page.getByTestId('v2-notes-proposed').getByTestId('v2-notes-row');
  await expect(row).toHaveCount(1);
  const approve = row.getByTestId('v2-notes-approve');
  await expect(approve).toBeVisible();
  const box = await approve.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join('test-results', 'v2-notes-phone-dark.png'), fullPage: true });
  await approve.click();
  await expect(page.getByTestId('v2-notes-approved').getByTestId('v2-notes-row')).toHaveCount(2);
});
