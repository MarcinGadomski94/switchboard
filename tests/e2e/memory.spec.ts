import { createHmac } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';

/**
 * D107 on the real path (D13, fake-claude): Settings → Experimental → Project memory (off by
 * default, no Memory cell); on, an agent's proposal through `/agent/v1/memory` with its own token
 * raises the Inbox item "1 memory proposal for work space"; Review opens the Memory page at the
 * folder with the proposing session linked; Edit… then Approve stores the edit, the item resolves,
 * and the next session in the folder gets the edited text in `--append-system-prompt` (never the
 * agent's own words or a rejected entry); + Add entry and ☆ pin; the session panel's line.
 */
let tmp: string;
let log: string;
let world: QuestionWorld;

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-memory'));
  log = path.join(tmp, 'fake.log');
  world = await startQuestionWorld('memory', { env: { FAKE_CLAUDE_LOG: log } });
});

test.afterAll(async () => {
  await world?.stop();
  if (tmp) await removeTempDir(tmp);
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

/** fake-claude's session processes, in spawn order: their `--append-system-prompt` (null without). */
async function instructions(): Promise<Array<string | null>> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind?: string; argv?: string[] })
    .filter((entry) => entry.kind === 'argv' && entry.argv?.includes('--name'))
    .map((entry) => {
      const at = entry.argv?.indexOf('--append-system-prompt') ?? -1;
      return at === -1 ? null : (entry.argv?.[at + 1] ?? null);
    });
}

async function settled(page: Page, count: number): Promise<void> {
  await expect
    .poll(async () => page.evaluate(async () => ((await (await fetch('/api/sessions')).json()) as Array<{ status: string }>).filter((s) => s.status === 'done' || s.status === 'idle').length), { timeout: 15_000 })
    .toBe(count);
}

test('the switch, an agent proposal → Inbox → Review → Edit… → Approve → injected; manual add and pin', async ({ page }) => {
  // Off by default: the row says so, no Memory cell.
  await page.goto(`${world.baseUrl}/settings/experimental`);
  const row = page.locator('[data-row="experimental-memory"]');
  await expect(row).toContainText('Project memory');
  const toggle = row.getByTestId('setting-value');
  await expect(toggle).toHaveText('off');
  await expect(page.getByTestId('nav-memory')).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveText('on');
  await expect(page.getByTestId('nav-memory')).toBeVisible();

  // The developer's standing instruction is off here, so a session without memory gets no flag at all.
  await page.evaluate(async () => {
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'agents.standingInstruction.enabled': false }) });
  });
  const proposer = await world.startSession(page, 'mem-proposer', 'Reply with just OK.');
  await settled(page, 1);
  expect(await agentPropose(proposer.id, { title: 'Run the Acme tests', text: 'AGENT-WORDING: npm test' })).toBe(201);
  expect(await agentPropose(proposer.id, { title: 'Acme deploy secret', text: 'REJECTED-NEVER-INJECTED' })).toBe(201);

  // The Inbox item for the folder; Review goes to the Memory page there.
  await page.goto(`${world.baseUrl}/inbox`);
  const item = page.getByTestId('inbox-item').filter({ hasText: 'memory proposals for work space' });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('2 memory proposals for work space');
  await item.click();
  await expect(page.getByTestId('nav-memory-count')).toHaveText('2');
  await page.getByTestId('inbox-detail').getByTestId('inbox-action').filter({ hasText: 'Review' }).click();
  await expect(page).toHaveURL(/\/memory\?scope=/);
  const queue = page.getByTestId('memory-queue');
  await expect(queue.getByTestId('memory-proposal')).toHaveCount(2);
  const firstId = await queue.getByTestId('memory-proposal').filter({ hasText: 'Run the Acme tests' }).getAttribute('data-entry-id');
  const first = queue.locator(`[data-entry-id="${firstId}"]`);
  await expect(first.getByTestId('memory-entry-session')).toHaveText('mem-proposer');
  await page.screenshot({ path: path.join('test-results', 'memory-review-queue.png') });

  // Edit… then Approve: the edit is what is approved.
  await first.getByTestId('memory-edit').click();
  await first.getByTestId('memory-form-text').fill('DEVELOPER-EDIT: run npm test with the test ports.');
  await first.getByTestId('memory-form-approve').click();
  const approved = page.getByTestId('memory-approved').getByTestId('memory-entry');
  await expect(approved).toHaveCount(1);
  await expect(approved.getByTestId('memory-entry-text')).toHaveText('DEVELOPER-EDIT: run npm test with the test ports.');
  await expect(approved.getByTestId('memory-entry-meta')).toContainText('edited by you');
  // Ruling 2026-10-14: the open proposer session is only flagged (D91's older instruction), not restarted.
  await expect
    .poll(async () => page.evaluate(async (id) => ((await (await fetch(`/api/sessions/${id}`)).json()) as { instructionOutdated?: boolean }).instructionOutdated, proposer.id))
    .toBe(true);
  expect((await instructions()).length).toBe(1);
  // Reject the other: the queue empties and the Inbox item resolves.
  await queue.getByTestId('memory-proposal').filter({ hasText: 'Acme deploy secret' }).getByTestId('memory-reject').click();
  await expect(queue.getByTestId('memory-proposal')).toHaveCount(0);
  await expect(page.getByTestId('nav-memory-count')).toHaveText('');
  await expect
    .poll(async () => page.evaluate(async () => ((await (await fetch('/api/inbox')).json()) as Array<{ title: string }>).filter((i) => i.title.includes('memory proposal')).length))
    .toBe(0);

  // Manual add (pinned) and pin.
  await page.getByTestId('memory-add').click();
  const form = page.getByTestId('memory-approved').getByTestId('memory-form');
  await form.getByTestId('memory-form-title').fill('Acme branch names');
  await form.getByTestId('memory-form-text').fill('Branches are PROJ-<n>-<slug>.');
  await form.getByTestId('memory-form-tags').fill('git, naming');
  await form.getByTestId('memory-form-pinned').check();
  await form.getByTestId('memory-form-save').click();
  await expect(approved).toHaveCount(2);
  await expect(approved.nth(0)).toHaveAttribute('data-pinned', 'true');
  await expect(approved.nth(0).getByTestId('memory-entry-title')).toHaveText('Acme branch names');
  await expect(approved.nth(0).getByTestId('memory-entry-meta')).toContainText('added by you');
  const agentEntry = approved.filter({ hasText: 'Run the Acme tests' });
  await agentEntry.getByTestId('memory-pin').click();
  await expect(agentEntry.getByTestId('memory-pin')).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: path.join('test-results', 'memory-approved.png') });

  // The next session in the folder gets exactly the approved entries.
  const next = await world.startSession(page, 'mem-reader', 'Reply with just OK.');
  await expect.poll(async () => (await instructions()).filter((text) => text?.includes('DEVELOPER-EDIT')).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  const all = await instructions();
  const injected = all.filter((text): text is string => text !== null && text.includes('DEVELOPER-EDIT'));
  expect(injected.at(-1)).toContain('=== Project memory (approved by the developer) ===');
  expect(injected.at(-1)).toContain('- Acme branch names [git, naming]\n  Branches are PROJ-<n>-<slug>.');
  for (const text of all) {
    expect(text ?? '').not.toContain('AGENT-WORDING');
    expect(text ?? '').not.toContain('REJECTED-NEVER-INJECTED');
  }

  // The session's right panel: its folder's approved entries, linking to the page.
  await page.goto(`${world.baseUrl}/sessions/${next.id}`);
  await expect(page.getByTestId('session-memory-link')).toHaveText('Memory: 2 entries');
  await page.screenshot({ path: path.join('test-results', 'memory-session-line.png') });
  await page.getByTestId('session-memory-link').click();
  await expect(page.getByTestId('memory-page')).toBeVisible();
  await expect(page.getByTestId('memory-approved').getByTestId('memory-entry')).toHaveCount(2);
});
