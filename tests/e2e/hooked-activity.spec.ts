import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type BrowserContext, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, pairedNodes } from '../helpers/peers.ts';
import { assistantTextLine, assistantToolLine, lastUuid, terminalUserLine, toolResultLine, writeTranscript } from '../helpers/transcripts.ts';

/**
 * D53 "Live activity for remote and hooked sessions" oracle (`docs/chat.md` →
 * *Live activity line* and *Queued messages*, `docs/peers.md` → *Hooked terminal
 * sessions*): machine B (the Mac) follows a hooked terminal session running on
 * machine A (the PC), through the D48 proxy and event forwarding. The terminal is
 * a fake: its registry entry, its transcript (grown by the test, as the CLI writes
 * it) and the hook script's calls made against A with A's hook token. Two real
 * Switchboard processes; B's UI in a browser context.
 *
 * Covers: no hook listening yet (the header note, the queued message's words);
 * UserPromptSubmit → a thinking verb; the transcript's tool_use line → `● Bash:
 * npm test` with its clock, in the chat and the sidebar row; the staleness hint
 * once the page's clock is 4 minutes on; Stop → no line; the waiter takes the
 * message → "Waiting for the session to take it up"; taken up → delivered.
 */

let tmp: string;
let nodes: PeerNode[] = [];
let contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-hooked-activity');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

const CS = '5d3a7a38-aaaa-4bbb-8ccc-0123456789ab';

/** A call of the hook script against `target` (its hook token), as the CLI would make it. */
async function hookCall(target: PeerNode, kind: 'event' | 'permission' | 'waiter', event: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const token = (await readFile(path.join(target.dataDir, 'hook-token'), 'utf8')).trim();
  const response = await fetch(`${target.baseUrl}/hook/v1/${kind}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ event, claudePid: process.pid, entrypoint: 'cli' }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('a hooked terminal session on the peer: no hook listening yet, Thinking → ● Bash → idle, the staleness hint, the message handed to the hook', async ({ browser }) => {
  const world = await pairedNodes(tmp);
  nodes.push(world.a, world.b);
  const { a, b, aId } = world;

  // A's hand-started terminal session: its registry entry (a live pid) and its transcript with one finished turn.
  const cwd = a.repo as string;
  await mkdir(path.join(a.configDir, 'sessions'), { recursive: true });
  await writeFile(
    path.join(a.configDir, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: CS, cwd, kind: 'interactive', entrypoint: 'cli', startedAt: Date.now() - 60_000, name: 'pc-terminal', status: 'idle' }),
  );
  const lines: Record<string, unknown>[] = [terminalUserLine({ sessionId: CS, cwd, content: 'Refactor the parser.', parentUuid: null, timestamp: new Date(Date.now() - 50_000).toISOString() })];
  lines.push(assistantTextLine({ sessionId: CS, cwd, text: 'Parser split in two.', parentUuid: lastUuid(lines), timestamp: new Date(Date.now() - 40_000).toISOString() }));
  const transcript = await writeTranscript(a.configDir, cwd, CS, lines);
  const append = async (...more: Record<string, unknown>[]): Promise<void> => {
    lines.push(...more);
    await appendFile(transcript, more.map((line) => `${JSON.stringify(line)}\n`).join(''));
  };
  const base = { session_id: CS, cwd, transcript_path: transcript };

  // The hooks go in on A after the session started; B hooks into it through A's peer API.
  expect((await a.call('POST', '/api/hooks/install')).status).toBe(200);
  const hooked = await b.call('POST', `/api/machines/${aId}/api/terminal-sessions/${CS}/hook`);
  expect(hooked.status, JSON.stringify(hooked.body)).toBe(201);
  const id = (hooked.body as Session).id;
  expect(id.startsWith(`r~${aId}~`)).toBe(true);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.clock.install({ time: Date.now() });
  await page.goto(`${b.baseUrl}/sessions/${encodeURIComponent(id)}`);
  const view = page.getByTestId('view-session');
  await expect(view.getByTestId('chat-text')).toHaveText(['Refactor the parser.', 'Parser split in two.']);

  // No hook has run in that terminal since the hooks went in: the header says so.
  const noHook = 'No hook listening yet — type anything in that terminal once (the hooks were installed after this session started)';
  await expect(page.getByTestId('session-hooked-delivery')).toHaveText(noHook);
  await expect(page.getByTestId('chat-activity')).toHaveCount(0);

  // A message from B: queued, and it says why.
  await page.getByTestId('chat-input').fill('Also add a test for empty input.');
  await page.getByTestId('chat-input').press('Enter');
  const bubble = view.getByTestId('chat-message').filter({ hasText: 'Also add a test for empty input.' });
  await expect(bubble.getByTestId('chat-queued')).toHaveAttribute('title', noHook);
  await expect(bubble.getByTestId('chat-queued-note')).toHaveText(noHook);

  // The developer types in the terminal: UserPromptSubmit → a thinking verb (the transcript has not shown the prompt yet).
  await hookCall(a, 'event', { ...base, hook_event_name: 'UserPromptSubmit' });
  const line = page.getByTestId('chat-activity');
  await expect(line).toHaveAttribute('data-state', 'thinking', { timeout: 15_000 });
  await expect(page.getByTestId('chat-activity-text')).toHaveText(/…$/);
  await expect(page.getByTestId('chat-activity-time')).toHaveText(/^\d+s$/);
  // Mid-turn, with no waiter: the message waits for the turn's end, and the header no longer warns.
  await expect(bubble.getByTestId('chat-queued-note')).toHaveText('Waiting for the next turn boundary');
  await expect(page.getByTestId('session-hooked-delivery')).toHaveCount(0);
  await append(terminalUserLine({ sessionId: CS, cwd, content: 'Run the tests.', parentUuid: lastUuid(lines), timestamp: new Date().toISOString() }));

  // The CLI writes the tool_use line as the tool starts: `● Bash: npm test` and its clock (no hook involved).
  await append(assistantToolLine({ sessionId: CS, cwd, toolUseId: 'toolu_e2e_bash', name: 'Bash', input: { command: 'npm test' }, parentUuid: lastUuid(lines), timestamp: new Date().toISOString() }));
  await expect(line).toHaveAttribute('data-state', 'tool', { timeout: 15_000 });
  await expect(page.getByTestId('chat-activity-glyph')).toHaveText('●');
  await expect(page.getByTestId('chat-activity-text')).toHaveText('Bash: npm test');
  await expect(page.getByTestId('chat-activity-time')).toHaveText(/^0:\d{2}$/);
  await expect(page.getByTestId('chat-activity-stale')).toHaveCount(0);
  const row = page.getByTestId('sidebar-sessions').locator('a').filter({ hasText: 'pc-terminal' });
  await expect(row.getByTestId('session-activity')).toContainText('Bash: npm test');

  // Nothing moves for 4 minutes (the page's clock): "· no activity for 4m", muted, on the chat line and the sidebar row.
  await page.clock.setSystemTime(Date.now() + 4 * 60_000 + 5_000);
  await expect(page.getByTestId('chat-activity-stale')).toHaveText('· no activity for 4m');
  await expect(page.getByTestId('chat-activity-stale')).toHaveCSS('color', 'rgb(118, 117, 111)'); // --muted-3, like the token count
  await expect(row.getByTestId('session-activity-stale')).toHaveText('· no activity for 4m');
  await page.clock.setSystemTime(Date.now());

  // The tool ends, the reply, Stop: no line.
  await append(toolResultLine({ sessionId: CS, cwd, toolUseId: 'toolu_e2e_bash', text: '42 passed', parentUuid: lastUuid(lines), timestamp: new Date().toISOString() }));
  await append(assistantTextLine({ sessionId: CS, cwd, text: 'All 42 tests pass.', parentUuid: lastUuid(lines), timestamp: new Date().toISOString() }));
  await hookCall(a, 'event', { ...base, hook_event_name: 'Stop' });
  await expect(line).toHaveCount(0, { timeout: 15_000 });
  await expect(view.getByTestId('chat-text')).toContainText(['All 42 tests pass.'], { timeout: 15_000 });

  // The Stop waiter arms (the terminal now has a hook listening): it takes the message at once; the CLI has not taken it up yet.
  const waiter = await hookCall(a, 'waiter', { ...base, hook_event_name: 'Stop' });
  expect(waiter.status).toBe(200);
  expect(waiter.body.message).toContain('Also add a test for empty input.');
  await expect(bubble.getByTestId('chat-queued-note')).toHaveText('Waiting for the session to take it up (delivered to its hook)', { timeout: 15_000 });

  // The wake-up's turn: taken up (the transcript's copy), no clock and no words.
  const woken = {
    type: 'user',
    uuid: 'wake-d53',
    parentUuid: lastUuid(lines),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: `<task-notification>\n<summary>Message from Switchboard</summary>\n</task-notification>\n<system-reminder>\nThe developer sent this message from Switchboard: Also add a test for empty input.\n</system-reminder>` },
  };
  await append(woken);
  await hookCall(a, 'event', { ...base, hook_event_name: 'UserPromptSubmit' });
  await expect(bubble.getByTestId('chat-queued')).toHaveCount(0, { timeout: 15_000 });
  await expect(bubble.getByTestId('chat-queued-note')).toHaveCount(0);
  await expect(line).toHaveAttribute('data-state', 'thinking');
});
