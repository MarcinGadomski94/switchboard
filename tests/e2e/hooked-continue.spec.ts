import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type BrowserContext, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { CONTINUED_DIVIDER } from '../../src/core/hooked-continue.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, startPeerNode } from '../helpers/peers.ts';
import { assistantTextLine, lastUuid, terminalUserLine, writeTranscript } from '../helpers/transcripts.ts';

/**
 * D72 oracle (`docs/peers.md` → *Continuing a hooked session in Switchboard*): a
 * real Switchboard process with fake-claude, a hand-started terminal session faked
 * by a stand-in process (its registry entry names the conversation) and a
 * transcript, hooked through the API.
 *
 * - Header: the hooked note's **Continue in Switchboard**; the terminal still runs,
 *   so the dialog warns and asks; confirmed, the terminal's process is stopped, the
 *   chat shows the divider, the hooked note goes, Pause appears, and a message runs
 *   with ■ Stop in the composer.
 * - History (the terminal already gone): the row's **Continue in Switchboard**
 *   converts at once and opens the session; the sidebar row's ⋯ menu offered it too.
 */

const CS = '9a8b7c6d-aaaa-4bbb-8ccc-0123456789ab';

let tmp: string;
let node: PeerNode | null = null;
let terminal: ChildProcess | null = null;
let contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-hooked-continue');
  node = await startPeerNode(tmp, 'a', { repo: true });
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  if (terminal && terminal.exitCode === null && terminal.signalCode === null) terminal.kill('SIGKILL');
  terminal = null;
  await node?.server.stop();
  node = null;
  await removeTempDir(tmp);
});

/** The hand-started terminal session (a live stand-in process), hooked; resolves with the session and the process's exit. */
async function hookedTerminal(n: PeerNode): Promise<{ readonly session: Session; readonly exited: Promise<string> }> {
  const cwd = n.repo as string;
  terminal = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', shell: false });
  const exited = new Promise<string>((resolve) => terminal?.once('exit', (code, signal) => resolve(signal ?? String(code))));
  await mkdir(path.join(n.configDir, 'sessions'), { recursive: true });
  await writeFile(
    path.join(n.configDir, 'sessions', `${terminal.pid}.json`),
    JSON.stringify({ pid: terminal.pid, sessionId: CS, cwd, kind: 'interactive', entrypoint: 'cli', startedAt: Date.now() - 60_000, name: 'pc-terminal', status: 'idle' }),
  );
  const lines = [terminalUserLine({ sessionId: CS, cwd, content: 'Refactor the parser.', parentUuid: null, timestamp: new Date(Date.now() - 50_000).toISOString() })];
  lines.push(assistantTextLine({ sessionId: CS, cwd, text: 'Parser split in two.', parentUuid: lastUuid(lines), timestamp: new Date(Date.now() - 40_000).toISOString() }));
  await writeTranscript(n.configDir, cwd, CS, lines);
  const hooked = await n.call('POST', `/api/terminal-sessions/${CS}/hook`);
  expect(hooked.status, JSON.stringify(hooked.body)).toBe(201);
  return { session: hooked.body as Session, exited };
}

test('header: the terminal still runs, so the dialog asks; confirmed, it is stopped and the session runs under Switchboard (divider, Pause, ■ Stop)', async ({ browser }) => {
  const n = node as PeerNode;
  const { session, exited } = await hookedTerminal(n);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${n.baseUrl}/sessions/${session.id}`);
  const chat = page.getByTestId('session-chat');
  await expect(chat.getByTestId('chat-text')).toHaveText(['Refactor the parser.', 'Parser split in two.']);
  await expect(page.getByTestId('session-pause')).toHaveCount(0);

  const action = page.getByTestId('session-hooked-note').getByTestId('session-continue-hooked');
  await expect(action).toHaveText('Continue in Switchboard');
  await action.click();
  const dialog = page.getByTestId('continue-hooked-dialog');
  await expect(dialog).toHaveAttribute('data-state', 'confirm');
  await expect(dialog.getByTestId('continue-hooked-warning')).toContainText("This session's claude is still running in its terminal.");
  // Cancel changes nothing.
  await dialog.getByTestId('continue-hooked-close').click();
  await expect(dialog).toHaveCount(0);
  expect(terminal?.exitCode).toBeNull();

  await action.click();
  await page.getByTestId('continue-hooked-confirm').click();
  await expect(page.getByTestId('continue-hooked-dialog')).toHaveCount(0, { timeout: 30_000 });
  expect(await exited).toBe('SIGTERM');
  await expect(chat.getByTestId('chat-divider')).toHaveText([CONTINUED_DIVIDER]);
  await expect(page.getByTestId('session-hooked-note')).toHaveCount(0);
  await expect(page.getByTestId('session-pause')).toBeVisible();

  // It takes a message like any Switchboard session: ■ Stop while the turn runs.
  await page.getByTestId('chat-input').fill('[fake:hold 30] Keep going.');
  await page.getByTestId('chat-input').press('Enter');
  const stop = page.getByTestId('chat-stop');
  await expect(stop).toBeVisible({ timeout: 15_000 });
  await stop.click();
  await expect(chat.locator('[data-testid="chat-step"][data-mark="■"]')).toHaveText(['■ Stopped'], { timeout: 10_000 });
  await expect(page.getByTestId('chat-send')).toBeVisible();
});

test('History: the terminal is gone, the row\'s Continue in Switchboard converts at once and opens the session (the sidebar ⋯ menu offers it too)', async ({ browser }) => {
  const n = node as PeerNode;
  const { session, exited } = await hookedTerminal(n);
  terminal?.kill('SIGKILL');
  await exited;
  await expect.poll(async () => ((await n.call('GET', '/api/terminal-sessions')).body as unknown[]).length).toBe(0);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${n.baseUrl}/history`);
  const sidebarRow = page.locator(`a.sb-session[data-session-id="${session.id}"]`);
  await sidebarRow.hover();
  await sidebarRow.getByTestId('sidebar-session-menu').click();
  await expect(page.getByTestId('sidebar-menu').getByTestId('sidebar-menu-continue-hooked')).toHaveText('Continue in Switchboard');
  await page.keyboard.press('Escape');

  const row = page.locator(`[data-testid="history-row"][data-session-id="${session.id}"]`);
  await expect(row).toHaveAttribute('data-hooked', 'true');
  await row.getByTestId('history-continue-hooked').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${session.id}`), { timeout: 30_000 });
  await expect(page.getByTestId('session-chat').getByTestId('chat-divider')).toHaveText([CONTINUED_DIVIDER]);
  await expect(page.getByTestId('session-pause')).toBeVisible();
  await expect(page.getByTestId('session-hooked-note')).toHaveCount(0);
});
