import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * M4.3, real path (D13, no demo seed): `node src/server/main.ts` with fake-claude
 * as the CLI, a temp workspace with a real git repo (`acme-app-front`) and a
 * session started with worktrees. The right panel shows:
 * - the agent cards: the main agent placed by its write into its worktree (path +
 *   ⎇ branch), a subagent from an Agent call (`subagent-forward`), the summary;
 * - the terminal tail from the real events: the Bash command + its output, the
 *   subagent's Read (prefixed), the turn results, the lifecycle, the cursor while a
 *   turn runs (`hang`), and `Paused` after Pause (the main agent reads `paused`);
 * - the handoff card's copy puts `claude --resume <id>` on the clipboard.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('session-panel');
});

test.afterAll(async () => {
  await world?.stop();
});

const TASK = '[fake:tool-use] Create out.txt and list the files.';

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

test('agent cards, terminal tail and the handoff copy from a real session', async ({ page, context }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'panel-e2e', TASK, true);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  const started = await detail(page, id);
  const worktreeFile = 'microfrontends/acme-app-front-wt-panel-e2e/src/panel.txt';

  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const panel = page.getByTestId('session-right-panel');
  await expect(panel.getByTestId('agents-summary')).toHaveText('1 agents · 0 solutions · 0 branches');
  await expect(panel.getByTestId('agent-name')).toHaveText(['acme-app-front']);
  await expect(panel.getByTestId('agent-path')).toHaveText(['workspace root']);
  await expect(panel.getByTestId('terminal-line')).toHaveText(['Started', '$ ls', 'hello.txt', 'out.txt', 'DONE']);

  // A write into the session's worktree places the main agent there (path + ⎇ branch), live over /hub.
  await send(page, id, `Now the panel. [fake:write ${worktreeFile}]`);
  await expect(panel.getByTestId('agent-path')).toHaveText(['microfrontends/acme-app-front']);
  await expect(panel.getByTestId('agent-branch')).toHaveText(['⎇ session/panel-e2e']);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');

  // An Agent call adds a subagent card; its Read shows in the tail with its name.
  await send(page, id, '[fake:subagent-forward] Ask a subagent for the first line.');
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  await expect(panel.getByTestId('agents-summary')).toHaveText('2 agents · 1 solutions · 1 branches');
  const cards = panel.getByTestId('agent-card');
  await expect(cards).toHaveCount(2);
  await expect(panel.getByTestId('agent-name')).toHaveText(['acme-app-front', 'general-purpose']);
  await expect(panel.getByTestId('agent-desc')).toHaveText([TASK, 'Read hello.txt and return first line']);
  await expect(panel.getByTestId('agent-status')).toHaveText(['done', 'done']);
  await expect(panel.getByTestId('agent-path')).toHaveText(['microfrontends/acme-app-front', 'workspace root']);
  await expect(cards.nth(1).getByTestId('agent-branch')).toHaveCount(0);
  const lines = panel.getByTestId('terminal-line');
  await expect(lines).toHaveText(['Started', '$ ls', 'hello.txt', 'out.txt', 'DONE', 'DONE', '[general-purpose] ✓ Read · hello.txt', 'alpha line one']);
  expect(await lines.evaluateAll((els) => els.map((el) => el.getAttribute('data-tone')))).toEqual(['out', 'cmd', 'out', 'out', 'out', 'out', 'ok', 'out']);
  // Tones as the prototype colors them: `$` muted, `✓` green, output #bfbeb8.
  await expect(lines.nth(1)).toHaveCSS('color', 'rgb(109, 108, 103)');
  await expect(lines.nth(2)).toHaveCSS('color', 'rgb(191, 190, 184)');

  // A turn that runs: the cursor is the last line; the main agent's status slot shows its live action (D19: thinking + the turn's time).
  await send(page, id, '[fake:hang] Keep working.');
  await expect(lines.last()).toHaveText('▍');
  await expect(panel.getByTestId('agent-status').first()).toHaveText(/^Thinking… \d+s$/);
  await expect(lines).toHaveCount(8);
  await expect(lines.first()).toHaveText('$ ls');

  // Pause: the cursor goes, `Paused` is the newest line, the main agent reads paused (idle dot).
  await page.getByTestId('session-pause').click();
  await expect.poll(async () => (await detail(page, id)).status).toBe('paused');
  await expect(lines).toHaveText(['$ ls', 'hello.txt', 'out.txt', 'DONE', 'DONE', '[general-purpose] ✓ Read · hello.txt', 'alpha line one', 'Paused']);
  await expect(panel.getByTestId('agent-status').first()).toHaveText('paused');
  await expect(cards.first()).toHaveAttribute('data-status', 'paused');
  await expect(cards.first().locator('.sb-agent-dot')).toHaveCSS('background-color', 'rgb(90, 89, 85)');

  // Copy: `claude --resume <id>` reaches the clipboard, the label reads "copied" for a moment.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: world.baseUrl });
  await expect(panel.getByTestId('handoff-command')).toHaveText(`claude --resume ${started.claudeSessionId}`);
  await panel.getByTestId('handoff-copy').click();
  await expect(panel.getByTestId('handoff-copy')).toHaveText('copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`claude --resume ${started.claudeSessionId}`);
  await expect(panel.getByTestId('handoff-copy')).toHaveText('copy');

  // The panel's order (prototype): header, cards, Terminal label, the tail, the handoff card; D21's agent overview comes first.
  expect(await panel.evaluate((el) => [...el.children].map((c) => c.getAttribute('data-testid') ?? c.className))).toEqual([
    'agent-overview',
    'sb-sv-panel-head',
    'agent-cards',
    'sb-sv-panel-label sb-term-label',
    'terminal-tail',
    'handoff-card',
  ]);
});
