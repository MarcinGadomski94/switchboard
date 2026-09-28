import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { runFake } from '../helpers/fake-claude.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * M4.1 oracle, real path (D13, no demo seed): `node src/server/main.ts` with
 * fake-claude as the CLI and a temp workspace + CLAUDE_CONFIG_DIR. A session runs
 * one turn; "⇄ Continue in terminal" shows `claude --resume <id>`; a fake
 * text-mode `claude -p --resume <id> "<prompt>"` turn stands in for the terminal
 * (M0.4 step 2); "⇄ Attach here" warns (the transcript changed moments ago); "Attach
 * anyway" imports the terminal turn into the chat and resumes the same id in a new
 * process.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('session-handoff');
});

test.afterAll(async () => {
  await world?.stop();
});

const TASK = 'Remember the code word: tangerine. Reply with just OK.';
const TERMINAL_PROMPT = 'Please also remember a second code word: kestrel. What was the first code word I gave you? Reply with just that word.';

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return (await response.json()) as SessionDetail;
  }, id);
}

/** The fake's live-process files (`<configDir>/sessions/<pid>.json`): pid → session id. */
async function liveProcesses(configDir: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  let files: string[] = [];
  try {
    files = await readdir(path.join(configDir, 'sessions'));
  } catch {
    return out;
  }
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const row = JSON.parse(await readFile(path.join(configDir, 'sessions', file), 'utf8')) as { pid: number; sessionId: string };
    out.set(row.pid, row.sessionId);
  }
  return out;
}

test('Continue in terminal → the command → a terminal turn → Attach warns → confirm → the turn is in the chat, same id', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'handoff-e2e', TASK);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  const started = await detail(page, id);
  const resumeCommand = `claude --resume ${started.claudeSessionId}`;

  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const header = page.getByTestId('session-header');
  await expect(page.getByTestId('session-name')).toHaveText('handoff-e2e');
  await expect(page.getByTestId('session-root')).toHaveText(`${world.workspace} · workspace root`);
  await expect(page.getByTestId('session-chip')).toHaveText(['work feature-building', 'mode single-solution', 'phase UI-first', 'scope acme-app-front']);
  await expect(header.getByRole('tab')).toHaveText(['Chat', 'Timeline', 'Diff · 0', 'Artifacts · 0']);
  await expect(page.getByTestId('session-tab-chat')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('session-pause')).toHaveText('Pause');
  await expect(page.getByTestId('session-handoff')).toHaveText('⇄ Continue in terminal');
  await expect(page.getByTestId('handoff-state')).toHaveText('attached');
  await expect(page.getByTestId('chat-message')).toHaveText([TASK, 'OK']);

  // ⇄ Continue in terminal: the D7 stop, then the handoff card shows the command.
  await page.getByTestId('session-handoff').click();
  await expect(page.getByTestId('session-handoff')).toHaveText('⇄ Attach here');
  await expect(page.getByTestId('handoff-state')).toHaveText('in terminal');
  await expect(page.getByTestId('handoff-command')).toHaveText(resumeCommand);
  await expect(page.getByTestId('session-pause')).toHaveText('Resume');
  await expect(page.getByTestId('session-pause')).toBeDisabled();
  const detached = await detail(page, id);
  expect(detached).toMatchObject({ attached: false, status: 'paused', live: false, resumeCommand });

  // The terminal: `claude -p --resume <id> "<prompt>"` (text mode), same CLAUDE_CONFIG_DIR.
  const terminal = await runFake(['-p', '--resume', started.claudeSessionId, TERMINAL_PROMPT], {
    cwd: world.workspace,
    env: { CLAUDE_CONFIG_DIR: world.configDir, FAKE_CLAUDE_SCENARIO: 'handoff-reattach' },
  });
  expect(terminal.code, terminal.stderr).toBe(0);
  expect(terminal.stdout.trim()).toBe('tangerine, kestrel');

  // ⇄ Attach here: the transcript changed moments ago → the warning, nothing attached yet.
  await page.getByTestId('session-handoff').click();
  await expect(page.getByTestId('attach-warning')).toBeVisible();
  await expect(page.getByTestId('attach-warning-text')).toHaveText(
    /^The transcript changed \d+ s ago\. Attaching while a terminal still has the session open forks the conversation\. Close it there first, or attach anyway\.$/,
  );
  await expect(page.getByTestId('session-handoff')).toHaveText('⇄ Attach here');
  expect((await detail(page, id)).attached).toBe(false);

  // Cancel keeps it detached; Attach anyway attaches.
  await page.getByTestId('attach-cancel').click();
  await expect(page.getByTestId('attach-warning')).toHaveCount(0);
  await page.getByTestId('session-handoff').click();
  await page.getByTestId('attach-confirm').click();
  await expect(page.getByTestId('attach-warning')).toHaveCount(0);
  await expect(page.getByTestId('session-handoff')).toHaveText('⇄ Continue in terminal');
  await expect(page.getByTestId('handoff-state')).toHaveText('attached');
  await expect(page.getByTestId('session-pause')).toHaveText('Pause');

  // The terminal turn is in the chat (it came from the transcript, not stdout).
  await expect(page.getByTestId('chat-message')).toHaveText([TASK, 'OK', TERMINAL_PROMPT, 'tangerine, kestrel']);
  await expect(page.locator('[data-testid="chat-message"][data-origin="terminal"]')).toHaveText(TERMINAL_PROMPT);

  // The new process runs under the same id.
  const attached = await detail(page, id);
  expect(attached).toMatchObject({ attached: true, live: true, claudeSessionId: started.claudeSessionId, status: 'idle' });
  const live = await liveProcesses(world.configDir);
  const pids = [...live.entries()].filter(([, sessionId]) => sessionId === started.claudeSessionId).map(([pid]) => pid);
  expect(pids).toHaveLength(1);
});
