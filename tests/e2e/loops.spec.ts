import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { openWithHub } from './question-world.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';

/**
 * Loop cards (M7.2, D9) on the real code path (D13, no demo seed): `node
 * src/server/main.ts` with fake-claude as the CLI and a temp workspace. A session
 * in `other/loopy` (which holds a LOOP.md `.loop/progress.md`) runs `/loop 5m …`;
 * fake-claude calls CronCreate and then fires two turns of its own. The card
 * appears live through `/hub` with the iteration strip (padded to the progress
 * file's cap), Iteration / cap, Next / expires, Breaker and the note; a progress
 * change shows after the next turn; Pause stops the session-only schedule; "Open
 * session" opens the session. A ScheduleWakeup loop that then asks a question
 * gets the amber border; a Workflow call gets its own card.
 */
let tmp: string;
let workspace: string;
let server: ServerProcess;

const PROGRESS = (breaker: number): string =>
  ['## Current', 'item: M3.2', 'attempt: 2/5', 'last oracle: unit PASS', '## Done', '- M3.1 ✓', '## Blocked', '- (none)', '## Breaker', `consecutive_blocked: ${breaker}`, ''].join('\n');

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('loops-e2e'));
  workspace = path.join(tmp, 'work space');
  await mkdir(path.join(workspace, 'other', 'loopy', '.loop'), { recursive: true });
  await writeFile(path.join(workspace, 'other', 'loopy', '.loop', 'progress.md'), PROGRESS(1));
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  const prsFile = path.join(tmp, 'fake-gh-prs.json');
  await writeFile(prsFile, '{}');
  // D14: the workspace is a saved folder (the default) in the server's database.
  await seedFolderInDataDir(path.join(tmp, 'data'), workspace);
  server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    FAKE_GH_PRS: prsFile,
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  if (tmp) await removeTempDir(tmp);
});

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ m, u, b }) => {
      const response = await fetch(u, {
        method: m,
        headers: b === undefined ? {} : { 'content-type': 'application/json' },
        ...(b === undefined ? {} : { body: JSON.stringify(b) }),
      });
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
    },
    { m: method, u: url, b: body },
  );
}

async function startSession(page: Page, name: string, task: string, solutions: string[] = ['other/loopy']): Promise<string> {
  const result = await api<{ id: string }>(page, 'POST', '/api/sessions', {
    name,
    task,
    solutions,
    workType: 'feature',
    mode: 'single',
    phase: 'ui-first',
    coordination: 'none',
    qa: null,
    worktrees: false,
    ultracode: false,
  });
  expect(result.status).toBe(201);
  return result.body.id;
}

async function status(page: Page, id: string): Promise<string> {
  return (await api<{ status: string }>(page, 'GET', `/api/sessions/${encodeURIComponent(id)}`)).body.status;
}

async function send(page: Page, id: string, text: string): Promise<void> {
  expect((await api(page, 'POST', `/api/sessions/${encodeURIComponent(id)}/messages`, { text })).status).toBe(202);
}

async function style(locator: Locator, prop: string): Promise<string> {
  return locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
}

/** The color `value` computes to in this page. */
async function computed(page: Page, value: string): Promise<string> {
  return page.evaluate((v) => {
    const probe = document.createElement('div');
    probe.style.color = v;
    document.body.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, value);
}

function card(page: Page, sessionId: string): Locator {
  return page.locator(`[data-testid="loop-card"][data-session-id="${sessionId}"]`);
}

async function facts(c: Locator): Promise<string[]> {
  return c.getByTestId('loop-fact').evaluateAll((els) => els.map((el) => [...el.children].map((child) => child.textContent ?? '').join(': ')));
}

async function cells(c: Locator): Promise<string[]> {
  return c.locator('[data-result]').evaluateAll((els) => els.map((el) => el.getAttribute('data-result') ?? ''));
}

test('Loop cards: /loop + CronCreate + firings live, progress-file cap + breaker, pause stops it, Open session', async ({ page }) => {
  test.setTimeout(120_000);
  await openWithHub(page, `${server.baseUrl}/schedules`);
  const list = page.getByTestId('loop-cards');
  await expect(list).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('loop-cards-empty')).toHaveText(
    'No loops yet. A card appears when a session runs /loop, ScheduleWakeup, CronCreate or Workflow.',
  );

  // A session in other/loopy; its first turn is no loop.
  const id = await startSession(page, 'loopy', 'Hello');
  await expect.poll(() => status(page, id), { timeout: 20_000 }).toBe('done');
  await expect(page.getByTestId('loop-card')).toHaveCount(0);

  // /loop: the card appears through /hub (no reload), iterations grow with the firings.
  await send(page, id, '/loop 5m check the build [fake:tool CronCreate {"cron":"*/5 * * * *","prompt":"check the build","recurring":true}] [fake:fire 2 400]');
  const c = card(page, id);
  await expect(c).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(() => cells(c), { timeout: 20_000 }).toEqual(['ok', 'ok', 'ok', 'none', 'none']);
  await expect(page.getByTestId('loop-cards-empty')).toHaveCount(0);
  await expect(c.getByTestId('loop-name')).toHaveText('loopy');
  await expect(c.getByTestId('loop-kind')).toHaveText('/loop 5m');
  await expect(c.getByTestId('loop-open')).toHaveText('Open session');
  const [iteration, timing, breaker] = await facts(c);
  expect(iteration).toBe('Iteration / cap: 3 / 5');
  expect(timing).toMatch(/^Next \/ expires: (tomorrow )?\d\d:\d\d \/ in 7 days$/);
  expect(breaker).toBe('Breaker: 1 in a row');
  await expect(c.getByTestId('loop-note')).toHaveText(
    'Session-only schedule. It stops when the session closes or after 7 days. Last iteration: OK. Cap and breaker from other/loopy/.loop/progress.md.',
  );
  const minutes = Number((timing ?? '').match(/(\d\d):(\d\d) \//)?.[2]);
  expect(minutes % 5).toBe(0);

  // Styles (SPEC tokens, prototype inline styles).
  await expect(c).toHaveAttribute('data-status', 'done');
  expect(await style(c, 'border-top-color')).toBe(await computed(page, '#26272c'));
  expect(await style(c, 'border-top-left-radius')).toBe('12px');
  expect(await style(c, 'padding')).toBe('16px 18px');
  expect(await style(c, 'background-color')).toBe(await computed(page, '#17181b'));
  expect(await style(c.getByTestId('loop-dot'), 'background-color')).toBe(await computed(page, 'oklch(0.74 0.13 150)'));
  expect(await style(c.getByTestId('loop-name'), 'font-size')).toBe('14px');
  expect(await style(c.getByTestId('loop-name'), 'font-weight')).toBe('600');
  expect(await style(c.getByTestId('loop-kind'), 'font-family')).toContain('Geist Mono');
  expect(await style(c.getByTestId('loop-kind'), 'color')).toBe(await computed(page, '#8d8c87'));
  const firstCell = c.locator('[data-result]').first();
  expect(await style(firstCell, 'height')).toBe('10px');
  expect(await style(firstCell, 'background-color')).toBe(await computed(page, 'oklch(0.74 0.13 150)'));
  expect(await style(c.locator('[data-result="none"]').first(), 'background-color')).toBe(await computed(page, '#26272c'));
  const label = c.locator('.sb-loop__fact-k').first();
  expect(await style(label, 'text-transform')).toBe('uppercase');
  expect(await style(label, 'font-size')).toBe('10px');
  expect(await style(label, 'color')).toBe(await computed(page, '#6d6c67'));
  expect(await style(c.locator('.sb-loop__fact-v').first(), 'color')).toBe(await computed(page, '#d9d8d3'));
  expect(await style(c.getByTestId('loop-note'), 'font-size')).toBe('12.5px');
  expect(await style(c.getByTestId('loop-note'), 'color')).toBe(await computed(page, '#a9a8a3'));

  // The progress file changes; the next turn of the session picks it up (a chat message is not an iteration).
  await writeFile(path.join(workspace, 'other', 'loopy', '.loop', 'progress.md'), PROGRESS(2));
  await send(page, id, 'How is it going?');
  await expect.poll(async () => (await facts(c))[2], { timeout: 20_000 }).toBe('Breaker: 2 in a row');
  expect((await facts(c))[0]).toBe('Iteration / cap: 3 / 5');

  // The cards survive a reload (GET /api/sessions).
  await openWithHub(page, `${server.baseUrl}/schedules`);
  await expect(card(page, id)).toHaveCount(1);
  await expect.poll(() => cells(card(page, id))).toEqual(['ok', 'ok', 'ok', 'none', 'none']);

  // D93: pause ends the process: the session-only schedule is gone, and so is its card (live, through sessionUpdated).
  expect((await api(page, 'POST', `/api/sessions/${encodeURIComponent(id)}/pause`)).status).toBe(200);
  await expect(card(page, id)).toHaveCount(0, { timeout: 20_000 });

  // Open session (a live loop's card).
  await send(page, id, '/loop 5m check the build [fake:tool CronCreate {"cron":"*/5 * * * *","prompt":"check the build","recurring":true}]');
  await expect(card(page, id)).toHaveCount(1, { timeout: 20_000 });
  await card(page, id).getByTestId('loop-open').click();
  await expect(page).toHaveURL(`${server.baseUrl}/sessions/${id}`);
});

test('Loop cards: a ScheduleWakeup loop that asks gets the amber border; a Workflow call gets its own card', async ({ page }) => {
  test.setTimeout(120_000);
  await openWithHub(page, `${server.baseUrl}/schedules`);
  await expect(page.getByTestId('loop-cards')).toHaveAttribute('data-state', 'ready');

  const wake = await startSession(page, 'wakey', 'Hello', ['mobile']);
  await expect.poll(() => status(page, wake), { timeout: 20_000 }).toBe('done');
  await send(page, wake, '/loop watch the queue [fake:tool ScheduleWakeup {"delaySeconds":1200,"reason":"next check"}]');
  const w = card(page, wake);
  await expect(w).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(() => cells(w), { timeout: 20_000 }).toEqual(['ok']);
  await expect(w.getByTestId('loop-kind')).toHaveText('/loop');
  const wakeFacts = await facts(w);
  expect(wakeFacts[0]).toBe('Iteration / cap: 1 / —');
  expect(wakeFacts[1]).toMatch(/^Next \/ expires: (tomorrow )?\d\d:\d\d \/ —$/);
  expect(wakeFacts[2]).toBe('Breaker: —');
  // The /loop turn itself is the fake's recorded tool turn, whose result text is "DONE".
  await expect(w.getByTestId('loop-note')).toHaveText('Last iteration: DONE.');
  expect(await style(w, 'border-top-color')).toBe(await computed(page, '#26272c'));

  // The session asks the developer: amber border and dot while it needs them.
  await send(page, wake, 'Two questions please [fake:ask-2q]');
  await expect(w).toHaveAttribute('data-status', 'need', { timeout: 20_000 });
  expect(await style(w, 'border-top-color')).toBe(await computed(page, 'oklch(0.45 0.08 70)'));
  expect(await style(w.getByTestId('loop-dot'), 'background-color')).toBe(await computed(page, 'oklch(0.8 0.14 70)'));
  expect(await cells(w)).toEqual(['ok']);

  // A Workflow call.
  const flow = await startSession(page, 'flowy', 'Roll out [fake:tool Workflow {"name":"button rollout"}]', ['mobile']);
  const f = card(page, flow);
  await expect(f).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(() => cells(f), { timeout: 20_000 }).toEqual(['ok']);
  await expect(f.getByTestId('loop-kind')).toHaveText('Workflow · button rollout');
  expect(await facts(f)).toEqual(['Iteration / cap: 1 / —', 'Next / expires: — / —', 'Breaker: —']);
  await expect(f.getByTestId('loop-note')).toHaveText('Last iteration: fake-claude: Workflow done.');

  // Oldest loop first: the earlier test's card, then wakey, then flowy.
  const order = await page.getByTestId('loop-name').allTextContents();
  expect(order.slice(-2)).toEqual(['wakey', 'flowy']);
  // Two cards per row.
  const [a, b] = await Promise.all([w.boundingBox(), f.boundingBox()]);
  expect(a && b && Math.abs(a.width - b.width)).toBeLessThanOrEqual(1);
});
