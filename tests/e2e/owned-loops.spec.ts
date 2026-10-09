import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { AGENT_SESSION_HEADER } from '../../src/core/todos.ts';
import { agentTokenFor } from '../../src/server/todos/agent-token.ts';
import { TOKEN_FILE } from '../../src/server/token.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { openWithHub } from './question-world.ts';

/**
 * D94 · Switchboard-owned loops on the real code path (`node src/server/main.ts`,
 * fake-claude, a temp folder): the session's agent creates a loop through its agent
 * route (what the `loop_create` tool calls), the card on Schedules & loops shows the
 * exact next firing and "no expiry", a one-shot fires on its own with the chat's
 * "⟳ <label> · run 1" chip, Pause / Run now / Cancel work from the card, and the
 * developer creates one from the session's ⋯ → New loop….
 */
let tmp: string;
let dataDir: string;
let server: ServerProcess;

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('owned-loops-e2e'));
  const workspace = path.join(tmp, 'work space');
  await mkdir(path.join(workspace, 'app'), { recursive: true });
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  dataDir = path.join(tmp, 'data');
  await seedFolderInDataDir(dataDir, workspace);
  server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir, SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config') });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  if (tmp) await removeTempDir(tmp);
});

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ m, u, b }) => {
      const response = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
    },
    { m: method, u: url, b: body },
  );
}

/** What the `switchboard` MCP helper sends for `loop_create`: the agent route with the session's agent token. */
async function agentCreate(sessionId: string, body: unknown): Promise<{ status: number; body: { id: string } }> {
  const install = (await readFile(path.join(dataDir, TOKEN_FILE), 'utf8')).trim();
  const response = await fetch(`${server.baseUrl}/agent/v1/loops`, {
    method: 'POST',
    headers: { authorization: `Bearer ${agentTokenFor(install, sessionId)}`, [AGENT_SESSION_HEADER]: sessionId, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { id: string } };
}

test('Switchboard loops: agent-created card, a firing with its chip, Pause / Run now / Cancel, New loop… from the session', async ({ page }) => {
  test.setTimeout(120_000);
  await openWithHub(page, `${server.baseUrl}/schedules`);
  const created = await api<{ id: string }>(page, 'POST', '/api/sessions', {
    name: 'loop-owner',
    task: 'Hello',
    solutions: ['app'],
    workType: 'feature',
    mode: 'single',
    phase: 'ui-first',
    coordination: 'none',
    qa: null,
    worktrees: false,
    ultracode: false,
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  await expect.poll(async () => (await api<{ status: string }>(page, 'GET', `/api/sessions/${id}`)).body.status, { timeout: 20_000 }).toBe('done');

  // The agent creates a recurring loop: the card appears live with its schedule, exact next firing and "no expiry".
  const recurring = await agentCreate(id, { prompt: 'Check the queue and report.', every_minutes: 45, label: 'Queue watch' });
  expect(recurring.status).toBe(201);
  const card = page.locator(`[data-testid="owned-loop-card"][data-loop-id="${recurring.body.id}"]`);
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await expect(card.getByTestId('owned-loop-title')).toHaveText('⟳ Queue watch');
  await expect(card.getByTestId('owned-loop-prompt')).toHaveText('Check the queue and report.');
  await expect(card.locator('[data-k="Schedule"] .sb-loop__fact-v')).toHaveText('every 45 min');
  await expect(card.locator('[data-k="Next"] .sb-loop__fact-v')).toHaveText(/^(\d\d:\d\d|tomorrow \d\d:\d\d)$/);
  await expect(card.locator('[data-k="Expires"] .sb-loop__fact-v')).toHaveText('no expiry');
  await expect(card.locator('[data-k="Runs"] .sb-loop__fact-v')).toHaveText('0');
  await expect(card.getByTestId('owned-loop-state')).toHaveText('Run by Switchboard · active');
  await page.screenshot({ path: test.info().outputPath('owned-loop-card.png') });

  // A one-shot a few seconds ahead fires on its own: the chat shows the firing with its chip.
  const soon = new Date(Date.now() + 4_000).toISOString();
  expect((await agentCreate(id, { prompt: 'One-time check.', at: soon, label: 'Once' })).status).toBe(201);
  await page.goto(`${server.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('chat-loop-chip').filter({ hasText: '⟳ Once · run 1' })).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator('[data-testid="chat-message"][data-origin="service"]').filter({ hasText: 'One-time check.' })).toHaveCount(1);
  // The session's strip lists the recurring loop (the one-shot ended).
  await expect(page.getByTestId('session-loop')).toHaveCount(1, { timeout: 10_000 });
  await page.screenshot({ path: test.info().outputPath('session-loop-strip.png') });

  // Pause / Resume, Run now, Cancel from the card.
  await page.goto(`${server.baseUrl}/schedules`);
  await card.getByTestId('owned-loop-pause').click();
  await expect(card).toHaveAttribute('data-state', 'paused');
  await expect(card.locator('[data-k="Next"] .sb-loop__fact-v')).toHaveText('paused');
  await card.getByTestId('owned-loop-resume').click();
  await expect(card).toHaveAttribute('data-state', 'active');
  await expect.poll(async () => (await api<{ status: string }>(page, 'GET', `/api/sessions/${id}`)).body.status, { timeout: 20_000 }).toBe('done');
  await card.getByTestId('owned-loop-run').click();
  await expect(card.locator('[data-k="Runs"] .sb-loop__fact-v')).toHaveText('1', { timeout: 10_000 });
  await card.getByTestId('owned-loop-cancel').click();
  await expect(card.getByTestId('owned-loop-confirm')).toBeVisible();
  await card.getByTestId('owned-loop-cancel-yes').click();
  await expect(card).toHaveCount(0);

  // ⋯ → New loop… on the session's row.
  const row = page.locator(`a.sb-session[data-session-id="${id}"]`);
  await row.hover();
  await row.getByTestId('sidebar-session-menu').click();
  await page.getByTestId('sidebar-menu').getByTestId('sidebar-menu-new-loop').click();
  const dialog = page.getByTestId('loop-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('loop-dialog-save').click();
  await expect(dialog.getByTestId('loop-dialog-error')).toHaveText('Write the prompt Switchboard sends at each firing.');
  await page.screenshot({ path: test.info().outputPath('loop-dialog.png') });
  await dialog.getByTestId('loop-dialog-prompt').fill('Nightly summary of the day.');
  await dialog.getByTestId('loop-dialog-kind-cron').click();
  await dialog.getByTestId('loop-dialog-cron').fill('0 2 * * *');
  await dialog.getByTestId('loop-dialog-label').fill('Nightly');
  await dialog.getByTestId('loop-dialog-save').click();
  await expect(dialog).toHaveCount(0);
  const nightly = page.getByTestId('owned-loop-card').filter({ hasText: 'Nightly' });
  await expect(nightly).toHaveCount(1);
  await expect(nightly.locator('[data-k="Schedule"] .sb-loop__fact-v')).toHaveText('02:00 daily');
  await expect(nightly.locator('[data-k="Next"] .sb-loop__fact-v')).toHaveText(/02:00$/);
  const listed = await api<Array<{ createdBy: string; label: string }>>(page, 'GET', `/api/sessions/${id}/loops`);
  expect(listed.body.map((l) => [l.label, l.createdBy])).toEqual([['Once', 'agent'], ['Nightly', 'developer']]);
});
