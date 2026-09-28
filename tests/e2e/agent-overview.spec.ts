import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D21 agent overview on the real path (D13, no demo seed): `node src/server/main.ts`
 * with fake-claude as the CLI. The right panel's first section shows, live over `/hub`:
 * - the derived table: one row for the main agent (a fresh session), then a row
 *   per Agent / Task subagent in start order (`subagent-forward`), Agent ·
 *   Description · Solution · Status, with `—` for an agent without a solution;
 * - the newest status table the agent printed (`[fake:say]`) under "As reported by
 *   the agent · now": a box-drawing table in a code fence shown as printed in
 *   monospace (never wrapped), replaced by a newer box table, then by a GFM pipe
 *   table rendered as a table, kept when a later message has no table;
 * - D19's live action and time in the main agent's Status cell while a tool runs
 *   (`interrupt-tool`'s slow Bash call), gone after Pause (`paused`).
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('agent-overview');
});

test.afterAll(async () => {
  await world?.stop();
});

const TASK = 'Build the agent overview.\nKeep it compact.';
const SLOW_COMMAND = 'node -e "setTimeout(()=>console.log(1),20000)"';

const BOX = [
  '┌─────────────┬──────────────────────────┬──────────────────┬────────────┐',
  '│ Agent       │ Description              │ Solution         │ Status     │',
  '├─────────────┼──────────────────────────┼──────────────────┼────────────┤',
  '│ 1. web      │ Free talk at 360         │ acme-app-front/  │ 🟢 running │',
  '├─────────────┼──────────────────────────┼──────────────────┼────────────┤',
  '│ 2. mobile   │ Free talk at 360         │ mobile/          │ 🟢 running │',
  '└─────────────┴──────────────────────────┴──────────────────┴────────────┘',
];
const BOX_NEWER = BOX.map((line) => line.replace('🟢 running', '✅ done   '));
const PIPE = ['| Agent | Description | Status |', '|:--|---|--:|', '| web | Free talk at 360 | done |', '| mobile | Free talk at 360 | done |'];

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return (await response.json()) as SessionDetail;
  }, id);
}

async function send(page: Page, id: string, text: string): Promise<void> {
  const status = await page.evaluate(
    async ({ sessionId, body }) => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      return response.status;
    },
    { sessionId: id, body: text },
  );
  expect(status).toBe(202);
}

/** Sends a message and waits until its turn finished (the session is `done` again with one more result). */
async function turn(page: Page, id: string, text: string): Promise<void> {
  const results = async () => (await detail(page, id)).events.filter((event) => (event.payload as { type?: string } | null)?.type === 'result').length;
  const before = await results();
  await send(page, id, text);
  await expect.poll(results).toBeGreaterThan(before);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
}

function say(reply: string): string {
  return `Report the status. [fake:say ${JSON.stringify(reply)}]`;
}

/** Every line of a box table is one rendered line: the block is exactly as tall as its lines (never wrapped). */
async function expectUnwrapped(code: Locator, lines: number): Promise<void> {
  const { height, lineHeight } = await code.evaluate((el) => ({ height: el.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight) }));
  expect(Math.round(height / lineHeight)).toBe(lines);
}

test('derived table (main agent, a subagent), the printed status table as reported and replaced, the live Status', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'overview-e2e', `${TASK} Reply with just OK.`);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);

  const panel = page.getByTestId('session-right-panel');
  const overview = panel.getByTestId('agent-overview');
  // The panel's first section, above the prototype's parts.
  await expect(overview).toBeVisible();
  expect(await panel.evaluate((el) => [...el.children].map((c) => c.getAttribute('data-testid') ?? c.className))).toEqual([
    'agent-overview',
    'sb-sv-panel-head',
    'agent-cards',
    'sb-sv-panel-label sb-term-label',
    'terminal-tail',
    'handoff-card',
  ]);
  await expect(overview.locator('.sb-overview-label')).toHaveText('Agents overview');
  await expect(overview.locator('.sb-overview-label')).toHaveCSS('text-transform', 'uppercase');
  await expect(overview.getByTestId('overview-column')).toHaveText(['Agent', 'Description', 'Solution', 'Status']);

  // A session with only its main agent: one row.
  const rows = overview.getByTestId('overview-row');
  await expect(rows).toHaveCount(1);
  await expect(overview.getByTestId('overview-agent')).toHaveText(['acme-app-front']);
  await expect(overview.getByTestId('overview-description')).toHaveText(['Build the agent overview.']);
  await expect(overview.getByTestId('overview-solution')).toHaveText(['—']);
  await expect(overview.getByTestId('overview-status')).toHaveText(['✓ done']);
  await expect(overview.getByTestId('overview-reported')).toHaveCount(0);
  // In the SPEC status color (done), like the agent card's status slot.
  const doneColor = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--status-done)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(overview.getByTestId('overview-status').first()).toHaveCSS('color', doneColor);

  // An Agent call adds the subagent's row, after the main agent's.
  await turn(page, id, '[fake:subagent-forward] Ask a subagent for the first line.');
  await expect(rows).toHaveCount(2);
  await expect(overview.getByTestId('overview-agent')).toHaveText(['acme-app-front', 'general-purpose']);
  await expect(overview.getByTestId('overview-description')).toHaveText(['Build the agent overview.', 'Read hello.txt and return first line']);
  await expect(overview.getByTestId('overview-solution')).toHaveText(['—', '—']);
  await expect(overview.getByTestId('overview-status')).toHaveText(['✓ done', '✓ done']);
  // The rows follow the agent cards (same agents, same order).
  await expect(panel.getByTestId('agent-name')).toHaveText(['acme-app-front', 'general-purpose']);

  // The agent prints a box-drawing status table in a code fence: repeated as printed, in monospace, never wrapped.
  await turn(page, id, say(['Status:', '', '```', ...BOX, '```', '', 'Waiting on web.'].join('\n')));
  const reported = overview.getByTestId('overview-reported');
  await expect(reported).toHaveAttribute('data-format', 'box');
  await expect(overview.getByTestId('overview-reported-head')).toHaveText('As reported by the agent · now');
  const printed = overview.getByTestId('overview-printed');
  const code = printed.locator('pre code');
  expect(await code.evaluate((el) => el.textContent)).toBe(BOX.join('\n'));
  await expect(printed.locator('pre')).toHaveCSS('white-space', 'pre');
  await expect(printed.locator('pre')).toHaveCSS('overflow-x', 'auto');
  await expect(printed.locator('pre')).toHaveCSS('font-family', /Geist Mono/);
  await expectUnwrapped(code, BOX.length);
  // The same block the chat shows for that message (D20).
  const chatBlock = page.getByTestId('session-chat').locator('pre code').last();
  expect(await chatBlock.evaluate((el) => el.textContent?.replace(/\n$/, ''))).toBe(BOX.join('\n'));
  // The panel does not scroll sideways: the wide table scrolls inside its block.
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  // A newer printed table replaces it.
  await turn(page, id, say(['```', ...BOX_NEWER, '```'].join('\n')));
  await expect.poll(async () => code.evaluate((el) => el.textContent)).toBe(BOX_NEWER.join('\n'));
  await expect(overview.getByTestId('overview-reported')).toHaveCount(1);

  // A GFM pipe table replaces it too and renders as a table (D20 renderer).
  await turn(page, id, say(['All agents:', '', ...PIPE].join('\n')));
  await expect(reported).toHaveAttribute('data-format', 'gfm');
  await expect(printed.locator('th')).toHaveText(['Agent', 'Description', 'Status']);
  await expect(printed.locator('tbody tr')).toHaveCount(2);
  await expect(printed.locator('tbody tr').first().locator('td')).toHaveText(['web', 'Free talk at 360', 'done']);
  await expect(printed.locator('pre')).toHaveCount(0);

  // A later message without a status table (or with a table that is not one) keeps it.
  await turn(page, id, say(['Nothing new.', '', '| File | Lines |', '|---|---|', '| a.ts | 12 |'].join('\n')));
  await expect(reported).toHaveAttribute('data-format', 'gfm');
  await expect(printed.locator('th')).toHaveText(['Agent', 'Description', 'Status']);
  expect((await detail(page, id)).reportedTable).toMatchObject({ format: 'gfm', text: PIPE.join('\n') });

  // D19: while a tool runs, the main agent's Status cell shows its live action and time (the running blue).
  await send(page, id, '[fake:interrupt-tool] Run the slow command.');
  await expect.poll(async () => (await detail(page, id)).activity?.state).toBe('tool');
  const live = overview.getByTestId('overview-status').first().getByTestId('overview-activity');
  await expect(live).toHaveAttribute('data-state', 'tool');
  await expect(live).toContainText(`● Bash: ${SLOW_COMMAND}`);
  await expect(live.getByTestId('overview-activity-time')).toHaveText(/^0:\d{2}$/);
  await expect(live).toHaveAttribute('title', new RegExp(`^● Bash: ${SLOW_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} 0:\\d{2}$`));
  await expect(overview.getByTestId('overview-row').first()).toHaveAttribute('data-status', 'run');
  // The cell cuts the long action with … and keeps the time; the table stays inside the panel.
  expect(await overview.getByTestId('overview-table').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  // Pause ends the turn: the live action goes, the main agent reads paused.
  await page.getByTestId('session-pause').click();
  await expect.poll(async () => (await detail(page, id)).status).toBe('paused');
  await expect(live).toHaveCount(0);
  await expect(overview.getByTestId('overview-status')).toHaveText(['paused', '✓ done']);
});
