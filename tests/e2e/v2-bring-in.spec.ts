import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type APIRequestContext, type Page, expect, request as playwrightRequest, test } from '@playwright/test';
import type { HistoryItem, Session } from '../../src/core/api.ts';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { type FixtureName, asTerminal, fixtureLines, withChainRepaired, withSessionId, withoutTypes, writeTranscript } from '../helpers/transcripts.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D16 in the v2 theme (`docs/v2.md` → + New: From a terminal), on the real code path:
 * `node src/server/main.ts` with fake-claude as the CLI (`FAKE_CLAUDE_LOG`), a temp
 * `CLAUDE_CONFIG_DIR` holding M0.3/M0.4 recordings as terminal-only conversations
 * (`entrypoint: "cli"`, no hooks, never in Switchboard) under the saved workspace.
 * 1. + New › From a terminal lists them; the search finds one by first message, folder and id.
 * 2. Continue in Switchboard (typed name, a sidebar folder): the agent opens with the
 *    imported chat, `claude --resume <id>` with no message, idle, in that folder.
 * 3. A conversation a terminal may still have open: the warning, Cancel, then Continue anyway.
 * 4. Phone (390 × 844): the list, the search and the confirm step fill the screen.
 */
test.describe.configure({ mode: 'serial' });

const OLD = new Date(Date.now() - 60 * 60_000);
const ID = {
  single: randomUUID(),
  lantern: randomUUID(),
  live: randomUUID(),
  phone: randomUUID(),
};

let tmp: string;
let workspace: string;
let configDir: string;
let logFile: string;
let liveFile: string;
let server: ServerProcess;
let api: APIRequestContext;
let sidebarFolderId: string;

/** Writes a recording as a terminal conversation under `root/other/<recorded folder>`; returns the transcript file. */
async function conversation(root: string, fixture: FixtureName, id: string, options: { readonly untitled?: boolean } = {}): Promise<string> {
  const parent = path.join(root, 'other');
  const cwd = path.join(parent, fixture === 'tx-main' ? 'tx main' : fixture);
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(parent, 'handoff-elsewhere'), { recursive: true });
  let lines = asTerminal(withChainRepaired(withSessionId(await fixtureLines(fixture, parent), id)));
  if (options.untitled) lines = withoutTypes(lines, 'custom-title', 'agent-name');
  return writeTranscript(configDir, cwd, id, lines, OLD);
}

async function sessionByClaudeId(claudeSessionId: string): Promise<Session> {
  const sessions = (await (await api.get('/api/sessions')).json()) as Session[];
  const session = sessions.find((s) => s.claudeSessionId === claudeSessionId);
  if (!session) throw new Error(`no session for ${claudeSessionId}`);
  return session;
}

async function inSwitchboard(claudeSessionId: string): Promise<boolean> {
  const sessions = (await (await api.get('/api/sessions')).json()) as Session[];
  return sessions.some((s) => s.claudeSessionId === claudeSessionId);
}

/** The fake's argv / stdin log (`FAKE_CLAUDE_LOG`). */
async function fakeLog(): Promise<Array<{ kind: string; pid: number; argv?: string[]; line?: string }>> {
  const text = await readFile(logFile, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; pid: number; argv?: string[]; line?: string });
}

/** + New › From a terminal (the 8th kind). */
async function openBringIn(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  await page.getByTestId('v2-new').click();
  const sheet = page.getByTestId('v2-new-sheet');
  await expect(sheet).toBeVisible();
  const kind = sheet.getByTestId('v2-new-kind-bring-in');
  await expect(kind.locator('b')).toHaveText('From a terminal');
  await kind.scrollIntoViewIfNeeded();
  await kind.click();
  const dialog = page.getByTestId('v2-bring-in');
  await expect(dialog).toBeVisible();
  await expect(sheet).toHaveCount(0);
  return dialog;
}

function rowOf(dialog: ReturnType<Page['getByTestId']>, id: string) {
  return dialog.locator(`[data-testid="v2-bring-in-row"][data-claude-session-id="${id}"]`);
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-v2-bring-in'));
  workspace = path.join(tmp, 'work space');
  configDir = path.join(tmp, 'claude-config');
  logFile = path.join(tmp, 'fake.log');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'AGENTS.md'), '# AGENTS.md (Workspace Router)\n');
  await mkdir(configDir, { recursive: true });

  await conversation(workspace, 'handoff', ID.single);
  await conversation(workspace, 'handoff-conc', ID.lantern, { untitled: true });
  liveFile = await conversation(workspace, 'handoff', ID.live);
  await conversation(workspace, 'tx-main', ID.phone);

  await seedFolderInDataDir(path.join(tmp, 'data'), workspace);
  server = await startServer({
    ...V2_SERVER_ENV,
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    CLAUDE_CONFIG_DIR: configDir,
    FAKE_CLAUDE_LOG: logFile,
  });
  const token = (await readFile(path.join(tmp, 'data', 'sb_token'), 'utf8')).trim();
  api = await playwrightRequest.newContext({ baseURL: server.baseUrl, extraHTTPHeaders: { cookie: `sb_token=${token}` } });
  // A sidebar folder to put a brought-in agent into.
  const made = await api.post('/api/sidebar/folders', { data: { name: 'Imported' } });
  expect(made.status(), await made.text()).toBeLessThan(300);
  sidebarFolderId = ((await made.json()) as SidebarLayout).folders.find((f) => f.name === 'Imported')?.id ?? '';
  expect(sidebarFolderId).not.toBe('');
});

test.afterAll(async () => {
  await api?.dispose();
  if (server) expect(await server.stop()).toBe(0);
  await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

test('+ New › From a terminal lists the terminal-only conversations; the search finds one by first message, folder and id', async ({ page }) => {
  const rows = ((await (await api.get('/api/history')).json()) as HistoryItem[]).filter((row) => row.terminal === true);
  expect(new Set(rows.map((row) => row.claudeSessionId))).toEqual(new Set(Object.values(ID)));

  await page.goto(`${server.baseUrl}/agents`);
  const dialog = await openBringIn(page);
  await expect(dialog.getByTestId('v2-bring-in-row')).toHaveCount(4);
  await expect(dialog.getByTestId('v2-bring-in-count')).toHaveText('4 conversations');
  await expect(dialog.getByTestId('v2-bring-in-where')).toContainText('Claude Code conversations.');
  // The untitled one is named by its first message; its folder is the one it started in.
  const lantern = rowOf(dialog, ID.lantern);
  await expect(lantern.locator('.v2-bring-title')).toHaveText('Remember the code word: lantern. Reply with just OK.');
  await expect(lantern.locator('.v2-bring-line')).toContainText('handoff-conc');

  const search = dialog.getByTestId('v2-bring-in-search');
  await search.fill('code word lantern');
  await expect(dialog.getByTestId('v2-bring-in-row')).toHaveCount(1);
  await expect(rowOf(dialog, ID.lantern)).toBeVisible();
  await expect(dialog.getByTestId('v2-bring-in-count')).toHaveText('1 of 4 conversations');
  await search.fill('HANDOFF-CONC');
  await expect(dialog.getByTestId('v2-bring-in-row')).toHaveCount(1);
  await search.fill(ID.phone.slice(0, 13));
  await expect(dialog.getByTestId('v2-bring-in-row')).toHaveCount(1);
  await expect(rowOf(dialog, ID.phone)).toBeVisible();
  await search.fill('nothing like this anywhere');
  await expect(dialog.getByTestId('v2-bring-in-row')).toHaveCount(0);
  await expect(dialog.getByTestId('v2-bring-in-nomatch')).toHaveText('No conversation matches.');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // ⌘K finds it too.
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('v2-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('terminal conversation');
  await expect(palette.locator('.v2-cmd').first()).toHaveAttribute('data-command', 'action:new:bring-in');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('v2-bring-in')).toBeVisible();
});

test('Continue in Switchboard: the agent opens with the imported chat, resumed idle with no message, in the chosen folder', async ({ page }) => {
  await page.goto(`${server.baseUrl}/agents`);
  const dialog = await openBringIn(page);
  await rowOf(dialog, ID.single).click();
  const picked = dialog.getByTestId('v2-bring-in-picked');
  await expect(picked).toHaveAttribute('data-claude-session-id', ID.single);
  await expect(dialog.getByTestId('v2-bring-in-cwd')).toHaveText(path.join(workspace, 'other', 'handoff'));
  await expect(dialog.getByTestId('v2-bring-in-folder')).toHaveText('work space');
  // The name is optional: empty, the placeholder says what it will be called.
  await expect(dialog.getByTestId('v2-bring-in-name')).toHaveAttribute('placeholder', 'Optional · sb-handoff');
  // Back keeps the list.
  await dialog.getByTestId('v2-bring-in-back').click();
  await expect(dialog.getByTestId('v2-bring-in-row')).toHaveCount(4);
  await rowOf(dialog, ID.single).click();

  await dialog.getByTestId('v2-bring-in-name').fill('Tangerine follow-up');
  await dialog.getByTestId('v2-bring-in-put').selectOption(sidebarFolderId);
  await expect(dialog.getByTestId('v2-bring-in-go')).toHaveText('Continue in Switchboard');
  await dialog.getByTestId('v2-bring-in-go').click();

  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/agents\/[^/]+$/);
  const session = await sessionByClaudeId(ID.single);
  expect(new URL(page.url()).pathname).toBe(`/agents/${session.id}`);
  expect(session).toMatchObject({ name: 'tangerine-follow-up', title: 'Tangerine follow-up', claudeSessionId: ID.single, cwd: path.join(workspace, 'other', 'handoff') });
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Brought in “Tangerine follow-up”.' })).toBeVisible();
  // The terminal's turns are in the chat.
  await expect(page.getByTestId('v2-agent-chat')).toContainText('Remember the code word: tangerine');
  await expect.poll(async () => (await sessionByClaudeId(ID.single)).status, { timeout: 20_000 }).toBe('idle');
  // `--resume <id>` and no user message (only the `initialize` handshake).
  const resumed = async () => (await fakeLog()).find((line) => line.kind === 'argv' && line.argv?.includes('--resume') && line.argv.includes(ID.single));
  await expect.poll(async () => (await resumed())?.argv ?? []).toEqual(expect.arrayContaining(['--resume', ID.single]));
  const spawn = await resumed();
  expect((await fakeLog()).filter((line) => line.kind === 'stdin' && line.pid === spawn?.pid && !String(line.line).includes('"subtype":"initialize"'))).toEqual([]);
  // In the chosen sidebar folder.
  const layout = (await (await api.get('/api/sidebar')).json()) as SidebarLayout;
  expect(layout.folders.find((f) => f.id === sidebarFolderId)?.sessionIds).toContain(session.id);
  // It is no longer offered.
  const again = await openBringIn(page);
  await expect(again.getByTestId('v2-bring-in-row')).toHaveCount(3);
  await expect(rowOf(again, ID.single)).toHaveCount(0);
});

test('Still open in a terminal: the warning, Cancel keeps it out; Continue anyway brings it in (from Agents › Also)', async ({ page }) => {
  const now = new Date();
  await utimes(liveFile, now, now);
  await page.goto(`${server.baseUrl}/agents`);
  await page.getByTestId('v2-tree-bring-in').click();
  const dialog = page.getByTestId('v2-bring-in');
  await expect(dialog).toBeVisible();
  await rowOf(dialog, ID.live).click();
  await dialog.getByTestId('v2-bring-in-go').click();

  const warning = dialog.getByTestId('v2-bring-in-warning');
  await expect(warning).toHaveAttribute('data-state', 'terminal-open');
  await expect(warning).toContainText('Is it still open in a terminal?');
  await expect(dialog.getByTestId('v2-bring-in-warning-text')).toHaveText(/^The transcript changed \d+ s ago\. Two processes on one conversation split it\. Close it in the terminal first, or continue anyway\.$/);
  expect(await inSwitchboard(ID.live)).toBe(false);

  // Cancel: back to the confirm step, nothing moved.
  await dialog.getByTestId('v2-bring-in-cancel-move').click();
  await expect(warning).toHaveCount(0);
  await expect(dialog.getByTestId('v2-bring-in-go')).toBeEnabled();
  expect(await inSwitchboard(ID.live)).toBe(false);

  await dialog.getByTestId('v2-bring-in-go').click();
  await expect(warning).toHaveAttribute('data-state', 'terminal-open');
  await expect(dialog.getByTestId('v2-bring-in-confirm')).toHaveText('Continue anyway');
  await dialog.getByTestId('v2-bring-in-confirm').click();
  await expect(dialog).toHaveCount(0);
  const session = await sessionByClaudeId(ID.live);
  await expect(page).toHaveURL(new RegExp(`/agents/${session.id}$`));
  // The same title as the first one's conversation: made unique.
  expect(session.name).toBe('sb-handoff');
  await expect(page.getByTestId('v2-agent-chat')).toContainText('Remember the code word: tangerine');
});

test('phone (390 × 844): the list, the search and the confirm step fill the screen; Continue in Switchboard opens the agent', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.baseUrl}/`);
  const dialog = await openBringIn(page);
  const box = await dialog.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(388);
  expect(box?.height).toBeGreaterThanOrEqual(800);
  // Nothing scrolls sideways.
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await dialog.getByTestId('v2-bring-in-search').fill('tx main');
  const row = rowOf(dialog, ID.phone);
  await expect(dialog.getByTestId('v2-bring-in-row')).toHaveCount(1);
  const rowBox = await row.boundingBox();
  expect(rowBox?.height).toBeGreaterThanOrEqual(44);
  expect((rowBox?.x ?? -1) >= 0 && (rowBox?.x ?? 0) + (rowBox?.width ?? 999) <= 390).toBe(true);
  await row.click();
  await expect(dialog.getByTestId('v2-bring-in-picked')).toBeVisible();
  const go = dialog.getByTestId('v2-bring-in-go');
  await expect(go).toBeInViewport();
  expect((await go.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  await go.click();
  await expect(dialog).toHaveCount(0);
  const session = await sessionByClaudeId(ID.phone);
  await expect(page).toHaveURL(new RegExp(`/agents/${session.id}$`));
});
