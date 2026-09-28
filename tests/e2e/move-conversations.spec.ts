import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type APIRequestContext, type Page, expect, request as playwrightRequest, test } from '@playwright/test';
import type { Folder, HistoryItem, Session, SessionDetail } from '../../src/core/api.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { type FixtureName, asTerminal, fixtureLines, withChainRepaired, withSessionId, withoutTypes, writeTranscript } from '../helpers/transcripts.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D16 oracle (E2E, real path, no demo): terminal conversations continue in
 * Switchboard as the same conversation. `node src/server/main.ts` with fake-claude
 * as the CLI (`FAKE_CLAUDE_LOG`), a temp `CLAUDE_CONFIG_DIR` holding the M0.3/M0.4
 * recordings as terminal conversations (`entrypoint: "cli"`, chain links restored),
 * the saved workspace `work space` (router AGENTS.md) and a second workspace
 * `second-ws` that is not saved any more while a session still runs there (so
 * History lists its conversations with no saved folder).
 * 1. New session → **Resume a terminal conversation** → pick one → Start moves it.
 * 2. History → **Continue in Switchboard** on one row → its session opens with the
 *    terminal's turns, idle, `--resume <id>` with no message; the row is now the
 *    stored session.
 * 3. History → select three rows → **Move selected (3)**: two move, the third waits
 *    for **Add second-ws and continue**, then the last moved session opens.
 * 4. A conversation a terminal may still have open: the warning, then **Continue anyway**.
 */
test.describe.configure({ mode: 'serial' });
test.use({ timezoneId: 'UTC' });

const OLD = new Date(Date.now() - 60 * 60_000);
const ID = {
  single: randomUUID(),
  bulkConc: randomUUID(),
  bulkTx: randomUUID(),
  elsewhere: randomUUID(),
  live: randomUUID(),
  form: randomUUID(),
};

let tmp: string;
let workspace: string;
let secondWs: string;
let configDir: string;
let logFile: string;
let liveFile: string;
let server: ServerProcess;
let api: APIRequestContext;

/** Writes a recording as a terminal conversation under `root/other/<recorded folder>`; returns the transcript file. */
async function conversation(root: string, fixture: FixtureName, id: string, options: { readonly mtime?: Date; readonly untitled?: boolean } = {}): Promise<string> {
  const parent = path.join(root, 'other');
  const cwd = path.join(parent, fixture === 'tx-main' ? 'tx main' : fixture);
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(parent, 'handoff-elsewhere'), { recursive: true });
  let lines = asTerminal(withChainRepaired(withSessionId(await fixtureLines(fixture, parent), id)));
  if (options.untitled) lines = withoutTypes(lines, 'custom-title', 'agent-name');
  return writeTranscript(configDir, cwd, id, lines, options.mtime ?? OLD);
}

async function history(): Promise<HistoryItem[]> {
  const response = await api.get('/api/history');
  expect(response.status()).toBe(200);
  return (await response.json()) as HistoryItem[];
}

async function sessionByName(name: string): Promise<Session> {
  const sessions = (await (await api.get('/api/sessions')).json()) as Session[];
  const session = sessions.find((s) => s.name === name);
  if (!session) throw new Error(`no session ${name}`);
  return session;
}

async function sessionByClaudeId(claudeSessionId: string): Promise<Session> {
  const sessions = (await (await api.get('/api/sessions')).json()) as Session[];
  const session = sessions.find((s) => s.claudeSessionId === claudeSessionId);
  if (!session) throw new Error(`no session for ${claudeSessionId}`);
  return session;
}

/** The fake's argv / stdin log (`FAKE_CLAUDE_LOG`). */
async function fakeLog(): Promise<Array<{ kind: string; pid: number; argv?: string[]; line?: string }>> {
  const text = await readFile(logFile, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; pid: number; argv?: string[]; line?: string });
}

async function openHistory(page: Page): Promise<void> {
  await page.goto(`${server.baseUrl}/history`);
  await expect(page.getByTestId('view-history')).toHaveAttribute('aria-busy', 'false');
}

function row(page: Page, claudeSessionId: string) {
  return page.locator(`[data-testid="history-row"][data-claude-session-id="${claudeSessionId}"]`);
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-move'));
  workspace = path.join(tmp, 'work space');
  secondWs = path.join(tmp, 'second-ws');
  configDir = path.join(tmp, 'claude-config');
  logFile = path.join(tmp, 'fake.log');
  for (const ws of [workspace, secondWs]) {
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, 'AGENTS.md'), '# AGENTS.md (Workspace Router)\n');
  }
  await mkdir(configDir, { recursive: true });

  await conversation(workspace, 'handoff', ID.single);
  await conversation(workspace, 'handoff-conc', ID.bulkConc);
  await conversation(workspace, 'tx-main', ID.bulkTx);
  await conversation(secondWs, 'handoff-mid', ID.elsewhere);
  liveFile = await conversation(workspace, 'handoff', ID.live);
  await conversation(workspace, 'handoff-conc', ID.form, { untitled: true });

  await seedFolderInDataDir(path.join(tmp, 'data'), workspace);
  server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    CLAUDE_CONFIG_DIR: configDir,
    FAKE_CLAUDE_LOG: logFile,
  });
  const token = (await readFile(path.join(tmp, 'data', 'sb_token'), 'utf8')).trim();
  api = await playwrightRequest.newContext({ baseURL: server.baseUrl, extraHTTPHeaders: { cookie: `sb_token=${token}` } });

  // second-ws: saved, a session starts there (idle, no task), then it leaves the saved list; the session keeps it.
  const added = await api.post('/api/folders', { data: { path: secondWs } });
  expect(added.status(), await added.text()).toBe(201);
  const second = (await added.json()) as Folder;
  const started = await api.post('/api/sessions', {
    data: { name: 'second-ws-keeper', task: '', workType: 'feature', mode: 'single', solutions: ['other'], phase: 'ui-first', coordination: null, qa: null, worktrees: false, ultracode: false, folder: second.id },
  });
  expect(started.status(), await started.text()).toBe(201);
  const removed = await api.delete(`/api/folders/${second.id}`);
  expect(removed.status(), await removed.text()).toBe(200);
});

test.afterAll(async () => {
  await api?.dispose();
  if (server) expect(await server.stop()).toBe(0);
  await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

test('History marks terminal conversations: a checkbox and "Continue in Switchboard"; others have neither', async ({ page }) => {
  const items = await history();
  const terminal = items.filter((item) => item.terminal === true).map((item) => item.claudeSessionId);
  expect(new Set(terminal)).toEqual(new Set(Object.values(ID)));
  expect(items.find((item) => item.claudeSessionId === ID.elsewhere)).toMatchObject({ folder: null, folderPath: secondWs });

  await openHistory(page);
  await expect(page.locator('[data-testid="history-row"][data-terminal="true"]')).toHaveCount(6);
  const keeper = await sessionByName('second-ws-keeper');
  const stored = page.locator(`[data-testid="history-row"][data-session-id="${keeper.id}"]`);
  await expect(stored).toHaveCount(1);
  await expect(stored.getByTestId('history-select')).toHaveCount(0);
  await expect(stored.getByTestId('history-continue')).toHaveCount(0);
  const single = row(page, ID.single);
  await expect(single.getByTestId('history-continue')).toHaveText('Continue in Switchboard');
  await expect(single.locator('.sb-hist-outcome')).toHaveText('ended');
  await expect(single.getByTestId('history-select')).not.toBeChecked();
  await expect(page.getByTestId('history-movebar')).toHaveCount(0);
});

test('New session → "Resume a terminal conversation": the folder\'s conversations; picking one replaces the task; Start moves it', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal.getByTestId('ns-folder')).toHaveValue(/.+/);
  const toggle = modal.getByTestId('ns-resume');
  await expect(toggle).toHaveText('↻ Resume a terminal conversation');
  await toggle.click();
  const list = modal.getByTestId('ns-resume-list');
  // The saved folder's terminal conversations (second-ws's is not in it), newest first.
  await expect(list.getByTestId('ns-resume-entry')).toHaveCount(5);
  const entry = list.locator(`[data-testid="ns-resume-entry"][data-claude-session-id="${ID.form}"]`);
  await expect(entry.locator('.sb-ns-resume-entry-title')).toHaveText('Remember the code word: lantern. Reply with just OK.');
  await expect(entry.locator('.sb-ns-resume-entry-meta')).toHaveText(/^09-27 \d{2}:\d{2} · Remember the code word: lantern\. Reply with just OK\.$/);
  await expect(list.locator(`[data-claude-session-id="${ID.elsewhere}"]`)).toHaveCount(0);

  await entry.click();
  await expect(list).toHaveCount(0);
  await expect(modal.getByTestId('ns-task')).toHaveCount(0);
  await expect(modal.getByTestId('ns-resume-picked')).toContainText('↻ Remember the code word: lantern. Reply with just OK.');
  // A moved session has no session-start answers and no worktree: those sections and toggles are gone.
  for (const section of ['work-type', 'mode', 'solutions', 'phase']) await expect(modal.locator(`[data-section="${section}"]`)).toHaveCount(0);
  await expect(modal.getByTestId('ns-switch-worktrees')).toHaveCount(0);
  await expect(modal.getByTestId('ns-name')).toHaveAttribute('placeholder', 'remember-the-code-word-lantern-reply');
  const summary = await modal.getByTestId('ns-summary-line').allTextContents();
  expect(summary).toContain(`resume    claude --resume ${ID.form}`);
  expect(summary).toContain(`cwd       ${path.join(workspace, 'other', 'handoff-conc')}`);
  expect(summary).toContain('✓ same conversation · history imported · idle');

  // D22 (developer ruling): free text is the moved session's title; its short name is derived from it.
  await modal.getByTestId('ns-name').fill('Lantern follow-up');
  await expect(modal.getByTestId('ns-name')).toHaveValue('Lantern follow-up');
  const typed = await modal.getByTestId('ns-summary-line').allTextContents();
  expect(typed).toContain('name      lantern-follow-up');
  expect(typed.filter((line) => line.startsWith('⚠'))).toEqual([]);
  await modal.getByTestId('ns-start').click();
  await expect(page.getByTestId('view-session')).toBeVisible();
  const session = await sessionByClaudeId(ID.form);
  expect(session).toMatchObject({
    name: 'lantern-follow-up',
    title: 'Lantern follow-up',
    workType: null,
    mode: null,
    phase: null,
    cwd: path.join(workspace, 'other', 'handoff-conc'),
  });
  await expect(page).toHaveURL(new RegExp(`/sessions/${session.id}`));
  await expect(page.getByTestId('session-name')).toHaveText('Lantern follow-up');
  await expect(page.locator('[data-testid="chat-message"][data-origin="terminal"]').first()).toContainText('Remember the code word: lantern.');
});

test('History: "Continue in Switchboard" moves one conversation; its session opens idle with the terminal turns; the row is the stored session', async ({ page }) => {
  await openHistory(page);
  await row(page, ID.single).getByTestId('history-continue').click();
  await expect(page.getByTestId('view-session')).toBeVisible();
  const session = await sessionByClaudeId(ID.single);
  await expect(page).toHaveURL(new RegExp(`/sessions/${session.id}`));
  expect(session).toMatchObject({ name: 'sb-handoff', claudeSessionId: ID.single, workType: null, mode: null, phase: null, folderPath: workspace });
  await expect.poll(async () => (await sessionByClaudeId(ID.single)).status).toBe('idle');
  // The chat: the terminal's four prompts and their replies (the recording's), then the move.
  const terminalPrompts = page.locator('[data-testid="chat-message"][data-origin="terminal"]');
  await expect(terminalPrompts).toHaveCount(4);
  await expect(terminalPrompts.first()).toContainText('Remember the code word: tangerine. Reply with just OK.');
  await expect(page.locator('[data-testid="chat-message"][data-role="agent"]').last()).toContainText('tangerine, kestrel');
  const detail = (await (await api.get(`/api/sessions/${session.id}`)).json()) as SessionDetail;
  expect(detail.events.at(-1)?.label).toBe('Moved from a terminal');
  // `--resume <id>` with no message (the fake logs its argv once it runs).
  const resumed = async () => (await fakeLog()).find((line) => line.kind === 'argv' && line.argv?.includes('--resume') && line.argv.includes(ID.single));
  await expect.poll(async () => (await resumed())?.argv ?? []).toEqual(expect.arrayContaining(['--resume', ID.single, '--name', 'sb-handoff']));
  const spawn = await resumed();
  expect((await fakeLog()).filter((line) => line.kind === 'stdin' && line.pid === spawn?.pid)).toEqual([]);

  await openHistory(page);
  const moved = row(page, ID.single);
  await expect(moved).toHaveCount(1);
  await expect(moved).toHaveAttribute('data-session-id', session.id);
  await expect(moved.getByTestId('history-continue')).toHaveCount(0);
});

test('History: Move selected (3): two move, one waits for "Add second-ws and continue", then the last moved session opens', async ({ page }) => {
  await openHistory(page);
  for (const id of [ID.bulkConc, ID.elsewhere, ID.bulkTx]) await row(page, id).getByTestId('history-select').check();
  const bar = page.getByTestId('history-movebar');
  await expect(bar).toContainText('3 selected');
  await expect(bar.getByTestId('history-move-selected')).toHaveText('Move selected (3)');
  await bar.getByTestId('history-move-selected').click();

  const dialog = page.getByTestId('move-dialog');
  await expect(dialog).toBeVisible();
  const waiting = dialog.locator(`[data-testid="move-item"][data-claude-session-id="${ID.elsewhere}"]`);
  await expect(waiting).toHaveAttribute('data-state', 'needs-folder');
  await expect(waiting.getByTestId('move-state')).toHaveText(`No saved folder holds this conversation. It sits in the workspace ${secondWs}.`);
  await expect(dialog.locator(`[data-claude-session-id="${ID.bulkConc}"]`)).toHaveAttribute('data-state', 'moved');
  await expect(dialog.locator(`[data-claude-session-id="${ID.bulkTx}"]`)).toHaveAttribute('data-state', 'moved');
  await expect(dialog.locator(`[data-claude-session-id="${ID.bulkConc}"]`).getByTestId('move-state')).toHaveText('✓ moved as sb-handoff-conc');
  await expect(dialog.getByTestId('move-cancel')).toHaveText('Cancel');
  const add = waiting.getByTestId('move-add-folder');
  await expect(add).toHaveText('Add second-ws and continue');
  await expect(waiting.getByTestId('move-skip')).toHaveText('Skip');
  await add.click();

  // Settled with nothing refused: the last moved row of the list (tx-main is the oldest) opens.
  await expect(page.getByTestId('view-session')).toBeVisible();
  const last = await sessionByClaudeId(ID.bulkTx);
  await expect(page).toHaveURL(new RegExp(`/sessions/${last.id}`));
  expect(last.name).toBe('sb-tx-probe');
  const elsewhere = await sessionByClaudeId(ID.elsewhere);
  const folders = (await (await api.get('/api/folders')).json()) as Folder[];
  const re = folders.find((folder) => folder.canonicalPath === secondWs);
  expect(re).toBeDefined();
  expect(elsewhere).toMatchObject({ folder: re?.id, folderPath: secondWs, cwd: path.join(secondWs, 'other', 'handoff-mid') });
  await sessionByClaudeId(ID.bulkConc);
});

test('History: a conversation a terminal may still have open warns; "Continue anyway" moves it', async ({ page }) => {
  const now = new Date();
  await utimes(liveFile, now, now);
  await openHistory(page);
  await row(page, ID.live).getByTestId('history-continue').click();
  const dialog = page.getByTestId('move-dialog');
  const item = dialog.locator(`[data-testid="move-item"][data-claude-session-id="${ID.live}"]`);
  await expect(item).toHaveAttribute('data-state', 'terminal-open');
  await expect(item.getByTestId('move-state')).toHaveText(
    /^The transcript changed \d+ s ago\. Two processes on one conversation split it\. Close it in the terminal first, or continue anyway\.$/,
  );
  expect((await history()).find((i) => i.claudeSessionId === ID.live)?.sessionId).toBeNull();
  await item.getByTestId('move-confirm').click();
  await expect(page.getByTestId('view-session')).toBeVisible();
  const session = await sessionByClaudeId(ID.live);
  await expect(page).toHaveURL(new RegExp(`/sessions/${session.id}`));
  // The same title again: made unique.
  expect(session.name).toBe('sb-handoff-2');
  expect((await history()).filter((i) => i.terminal === true)).toEqual([]);
});
