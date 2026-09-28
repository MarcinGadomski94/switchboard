import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D21 agent overview on the real path (D13, no demo seed): `node src/server/main.ts`
 * with fake-claude as the CLI. The right panel's first section shows, live over `/hub`:
 * - the derived table: one row for the main agent (a fresh session), then a row
 *   per Agent / Task subagent in start order, Agent · Description · Solution ·
 *   Status, with `—` for an agent without a solution; D37: a finished subagent
 *   (`subagent-forward`) has no row (its card is under "✓ 1 finished");
 * - the newest status table the agent printed (`[fake:say]`) under "As reported by
 *   the agent · now", D27: drawn as table rows (every printed column, the Status
 *   with its status dot and color, the leading emoji removed), with an "as printed"
 *   toggle that opens and closes the original in a popover over the main area (a
 *   box-drawing table in monospace, never wrapped); replaced by a newer box table,
 *   then by a GFM pipe table drawn as rows too (inline Markdown as text; the
 *   original through the chat's renderer), kept when a later message has no table;
 *   a table that does not parse (a row with an extra cell; box or pipe) shows as
 *   printed, wrapped to the panel; nothing in the panel scrolls sideways, with the
 *   wide table shown and with the popover open;
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

/** A wide box table (122 columns, wider than the panel) as an orchestrator prints it. */
const BOX = [
  '┌───────────┬──────────────────────────────────────────────────────────────┬────────────────────────────────┬────────────┐',
  '│ Agent     │ Description                                                  │ Solution                       │ Status     │',
  '├───────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────┼────────────┤',
  '│ 1. web    │ Free talk at 360: layout, tokens and the empty state (Figma) │ microfrontends/acme-app-front/ │ 🟢 running │',
  '├───────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────┼────────────┤',
  '│ 2. mobile │ Free talk at 360: the same screen in MAUI                    │ mobile/                        │ 🟢 running │',
  '└───────────┴──────────────────────────────────────────────────────────────┴────────────────────────────────┴────────────┘',
];
const BOX_NEWER = BOX.map((line) => line.replace('🟢 running', '✅ done   '));
const PIPE = [
  '| Agent | Description | Status |',
  '|:--|---|--:|',
  '| **web** | Free talk at [360](https://example.com/360) | done |',
  '| mobile | Free talk at 360 | ⏳ queued |',
];
/** D27: a pipe status table whose row has an extra cell, and a description far wider than the panel. */
const PIPE_MALFORMED = [
  '| Agent | Description | Status |',
  '|---|---|---|',
  '| web | Free talk at 360, then 640, 768 and 1024, each against its Figma frame, with the empty state and the loading skeleton | done | extra |',
];
/** D27: a status table whose second row has an extra cell (a stray │): it cannot be parsed, so it shows as printed. */
const BOX_MALFORMED = BOX.map((line, i) => (i === 5 ? line.replace('│ 🟢 running │', '│ 🟢 running │ x │') : line));

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

/** A CSS color (e.g. `var(--status-run)`) as the page computes it. */
async function computedColor(page: Page, value: string): Promise<string> {
  return page.evaluate((color) => {
    const probe = document.createElement('span');
    probe.style.color = color;
    document.body.append(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    return computed;
  }, value);
}

/** D27 (developer: the right panel never scrolls sideways): nothing in it is wider than the panel. */
async function expectNoSidewaysScroll(panel: Locator): Promise<void> {
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
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
  const doneColor = await computedColor(page, 'var(--status-done)');
  const runColor = await computedColor(page, 'var(--status-run)');
  const needColor = await computedColor(page, 'var(--status-need)');
  await expect(overview.getByTestId('overview-status').first()).toHaveCSS('color', doneColor);

  // An Agent call adds a subagent. D37: once it finished, its row is gone, as is its card ("✓ 1 finished" under
  // the cards); the rows follow the cards (same agents, same order). A working subagent's row: subagent-chat.spec.ts.
  await turn(page, id, '[fake:subagent-forward] Ask a subagent for the first line.');
  await expect(panel.getByTestId('agents-summary')).toHaveText('2 agents · 0 solutions · 0 branches');
  await expect(panel.getByTestId('agents-finished')).toHaveText('✓ 1 finished');
  await expect(rows).toHaveCount(1);
  await expect(overview.getByTestId('overview-agent')).toHaveText(['acme-app-front']);
  await expect(overview.getByTestId('overview-description')).toHaveText(['Build the agent overview.']);
  await expect(overview.getByTestId('overview-solution')).toHaveText(['—']);
  await expect(overview.getByTestId('overview-status')).toHaveText(['✓ done']);
  await expect(panel.getByTestId('agent-name')).toHaveText(['acme-app-front']);
  // Expanding the finished cards shows them in place; the overview has no toggle, its finished rows stay gone.
  await panel.getByTestId('agents-finished').click();
  await expect(panel.getByTestId('agent-name')).toHaveText(['acme-app-front', 'general-purpose']);
  await expect(rows).toHaveCount(1);

  // The agent prints a wide box-drawing status table in a code fence. D27: drawn as table rows, like the derived table.
  await turn(page, id, say(['Status:', '', '```', ...BOX, '```', '', 'Waiting on web.'].join('\n')));
  const reported = overview.getByTestId('overview-reported');
  await expect(reported).toHaveAttribute('data-format', 'box');
  await expect(reported).toHaveAttribute('data-parsed', 'true');
  await expect(overview.getByTestId('overview-reported-head')).toHaveText('As reported by the agent · now');
  const table = overview.getByTestId('overview-reported-table');
  await expect(table.getByTestId('overview-reported-column')).toHaveText(['Agent', 'Description', 'Solution', 'Status']);
  const reportedRows = table.getByTestId('overview-reported-row');
  await expect(reportedRows).toHaveCount(2);
  await expect(reportedRows.nth(0).getByTestId('overview-reported-cell')).toHaveText([
    '1. web',
    'Free talk at 360: layout, tokens and the empty state (Figma)',
    'microfrontends/acme-app-front/',
    'running',
  ]);
  await expect(reportedRows.nth(1).getByTestId('overview-reported-cell')).toHaveText(['2. mobile', 'Free talk at 360: the same screen in MAUI', 'mobile/', 'running']);
  expect(await reportedRows.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-status')))).toEqual(['run', 'run']);
  const statusCells = table.locator('[data-kind="status"]');
  await expect(statusCells).toHaveCount(2);
  await expect(statusCells.first()).toHaveAttribute('data-status', 'run');
  await expect(statusCells.first()).toHaveCSS('color', runColor);
  await expect(statusCells.first().getByTestId('overview-reported-dot')).toHaveCSS('background-color', runColor);
  // Cut with …, the full text as the tooltip; the derived table's classes; nothing wider than the panel.
  const description = reportedRows.nth(0).getByTestId('overview-reported-cell').nth(1);
  await expect(description).toHaveAttribute('title', 'Free talk at 360: layout, tokens and the empty state (Figma)');
  await expect(description).toHaveCSS('text-overflow', 'ellipsis');
  await expect(table).toHaveClass(/sb-overview-table/);
  await expect(table).toHaveCSS('table-layout', 'fixed');
  expect(await table.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expectNoSidewaysScroll(panel);
  await expect(overview.getByTestId('overview-printed')).toHaveCount(0);

  // "as printed" opens the original in a popover over the main area, as D21 showed it: monospace, never wrapped.
  const toggle = overview.getByTestId('overview-printed-toggle');
  const popover = page.getByTestId('overview-printed-popover');
  await expect(toggle).toHaveText('as printed');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(popover).toHaveCount(0);
  await toggle.click();
  await expect(popover).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(popover).toHaveAttribute('role', 'dialog');
  const code = popover.locator('pre code');
  expect(await code.evaluate((el) => el.textContent)).toBe(BOX.join('\n'));
  await expect(popover.locator('pre')).toHaveCSS('white-space', 'pre');
  await expect(popover.locator('pre')).toHaveCSS('font-family', /Geist Mono/);
  await expectUnwrapped(code, BOX.length);
  // The same block the chat shows for that message (D20).
  const chatBlock = page.getByTestId('session-chat').locator('pre code').last();
  expect(await chatBlock.evaluate((el) => el.textContent?.replace(/\n$/, ''))).toBe(BOX.join('\n'));
  // Left of the panel, inside the window; the whole table fits in it at 1440 px; the panel still does not scroll sideways.
  const [popBox, panelBox] = [await popover.boundingBox(), await panel.boundingBox()];
  expect(popBox && panelBox && popBox.x >= 0 && popBox.x + popBox.width <= panelBox.x).toBe(true);
  expect(await popover.locator('pre').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expectNoSidewaysScroll(panel);
  // Esc closes it; the toggle opens and closes it.
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(popover).toBeVisible();
  await toggle.click();
  await expect(popover).toHaveCount(0);
  await toggle.click();

  // A newer printed table replaces it: the rows and the open popover follow.
  await turn(page, id, say(['```', ...BOX_NEWER, '```'].join('\n')));
  await expect(statusCells).toHaveText(['done', 'done']);
  await expect(statusCells.first()).toHaveAttribute('data-status', 'done');
  await expect(statusCells.first()).toHaveCSS('color', doneColor);
  await expect.poll(async () => code.evaluate((el) => el.textContent)).toBe(BOX_NEWER.join('\n'));
  await expect(overview.getByTestId('overview-reported')).toHaveCount(1);
  // A click outside it closes it.
  await overview.locator('.sb-overview-label').click();
  await expect(popover).toHaveCount(0);

  // A GFM pipe table replaces it too and is drawn as rows: inline Markdown as text, the Status colored.
  await turn(page, id, say(['All agents:', '', ...PIPE].join('\n')));
  await expect(reported).toHaveAttribute('data-format', 'gfm');
  await expect(table.getByTestId('overview-reported-column')).toHaveText(['Agent', 'Description', 'Status']);
  await expect(reportedRows).toHaveCount(2);
  await expect(reportedRows.nth(0).getByTestId('overview-reported-cell')).toHaveText(['web', 'Free talk at 360', 'done']);
  await expect(reportedRows.nth(1).getByTestId('overview-reported-cell')).toHaveText(['mobile', 'Free talk at 360', 'queued']);
  await expect(statusCells.nth(0)).toHaveCSS('color', doneColor);
  await expect(statusCells.nth(1)).toHaveAttribute('data-status', 'need');
  await expect(statusCells.nth(1)).toHaveCSS('color', needColor);
  // Its original goes through the chat's renderer (D20), as D21 showed it.
  await toggle.click();
  await expect(popover).toHaveAttribute('data-format', 'gfm');
  await expect(popover.locator('th')).toHaveText(['Agent', 'Description', 'Status']);
  await expect(popover.locator('tbody tr')).toHaveCount(2);
  await expect(popover.locator('tbody tr').first().locator('td')).toHaveText(['web', 'Free talk at 360', 'done']);
  await expect(popover.locator('tbody tr').first().locator('strong')).toHaveText('web');
  await expect(popover.locator('pre')).toHaveCount(0);
  await popover.getByTestId('overview-printed-close').click();
  await expect(popover).toHaveCount(0);

  // A later message without a status table (or with a table that is not one) keeps it.
  await turn(page, id, say(['Nothing new.', '', '| File | Lines |', '|---|---|', '| a.ts | 12 |'].join('\n')));
  await expect(reported).toHaveAttribute('data-format', 'gfm');
  await expect(table.getByTestId('overview-reported-column')).toHaveText(['Agent', 'Description', 'Status']);
  expect((await detail(page, id)).reportedTable).toMatchObject({ format: 'gfm', text: PIPE.join('\n') });

  // A status table that does not parse (a row with an extra cell): the panel shows a one-line note
  // (developer ruling 2026-09-28), and "as printed" opens the unwrapped original.
  await turn(page, id, say(['```', ...BOX_MALFORMED, '```'].join('\n')));
  await expect(reported).toHaveAttribute('data-format', 'box');
  await expect(reported).toHaveAttribute('data-parsed', 'false');
  await expect(table).toHaveCount(0);
  const unreadable = overview.getByTestId('overview-unreadable');
  await expect(unreadable).toHaveText("The agent printed a table Switchboard can't read · see “as printed”");
  await expect(overview.getByTestId('overview-printed')).toHaveCount(0);
  await expectNoSidewaysScroll(panel);
  await toggle.click();
  await expectUnwrapped(popover.locator('pre code'), BOX_MALFORMED.length);
  await expectNoSidewaysScroll(panel);
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  // A pipe table that does not parse: the same note.
  await turn(page, id, say(PIPE_MALFORMED.join('\n')));
  await expect(reported).toHaveAttribute('data-format', 'gfm');
  await expect(reported).toHaveAttribute('data-parsed', 'false');
  await expect(unreadable).toBeVisible();
  await expectNoSidewaysScroll(panel);

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
  await expect(overview.getByTestId('overview-status')).toHaveText(['paused']);
});
