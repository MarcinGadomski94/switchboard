import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, realpath, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { type APIRequestContext, type Page, expect, request as playwrightRequest, test } from '@playwright/test';
import type { HistoryItem, NewSession, Session } from '../../src/core/api.ts';
import { STATUS_OUTCOME } from '../../src/core/history.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { slugForCwd } from '../../tools/fake-claude/transcript.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import {
  FIXTURE_IDS,
  asTerminal,
  assistantTextLine,
  fixtureLines,
  lastUuid,
  ndjson,
  terminalUserLine,
  withSessionId,
  withoutTypes,
  writeTranscript,
} from '../helpers/transcripts.ts';
import { stubToolProbes } from './probes.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';

/**
 * M7.4 oracle: History on the real code path (no demo seed, D13). The server runs
 * `node src/server/main.ts` with fake-claude as the CLI, a temp workspace root and
 * a temp `CLAUDE_CONFIG_DIR` holding the M0.3/M0.4 fixture transcripts moved into
 * that root: terminal (`cli`) variants with a title, an ai-title, no title, a
 * slash command only and a PR link, the forked file (two leaves), plus files
 * History must hide (a headless `sdk-cli` file nobody stored, a stub, a file from
 * another root whose folder shares the slug prefix). A session started through
 * the API with fake-claude then appears with its DB data, keeps its row when a
 * terminal continues it, and the search box filters on the service.
 */
test.describe.configure({ mode: 'serial' });
// Dates are local time in the UI (`09-27 21:41`): pin the browser's zone.
test.use({ timezoneId: 'UTC' });

const OLD = new Date('2026-09-27T22:30:00.000Z');
const LOOP_ID = randomUUID();
const TX_ID = randomUUID();
const CONC_ID = randomUUID();
const MID_ID = randomUUID();
const HANDOFF_ID = randomUUID();
const STUB_ID = randomUUID();
const OTHER_ID = randomUUID();

let tmp: string;
let workspace: string;
let configDir: string;
let loopFile: string;
let server: ServerProcess;
let api: APIRequestContext;
let probe: Session;

type Line = Record<string, unknown>;

async function history(q?: string): Promise<HistoryItem[]> {
  const response = await api.get(`/api/history${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as HistoryItem[];
}

/** Each row as `date | name | mode | summary | solutions · branches | outcome`. */
async function rowLines(page: Page): Promise<string[]> {
  return page.getByTestId('history-row').evaluateAll((rows) =>
    rows.map((row) => {
      const text = (selector: string) => (row.querySelector(selector)?.textContent ?? '').trim();
      return [text('.sb-hist-date'), text('.sb-hist-name'), text('.sb-hist-mode'), text('.sb-hist-summary'), text('.sb-hist-sols'), text('.sb-hist-outcome')].join(' | ');
    }),
  );
}

async function settled(page: Page): Promise<void> {
  await expect(page.getByTestId('view-history')).toHaveAttribute('aria-busy', 'false');
}

async function searchFor(page: Page, text: string): Promise<void> {
  await page.getByTestId('history-search').fill(text);
  await settled(page);
}

/** `2026-09-28T01:02:03Z` → `09-28 01:02` (UTC, the pinned browser zone). */
function utcDate(iso: string): string {
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

/** Keeps the command-only session "active" (changed less than 2 minutes ago). */
async function touchLoop(): Promise<void> {
  const now = new Date();
  await utimes(loopFile, now, now);
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-history'));
  workspace = path.join(tmp, 'work space');
  configDir = path.join(tmp, 'claude-config');
  await mkdir(path.join(workspace, 'microfrontends', 'alpha-front'), { recursive: true });
  await mkdir(path.join(workspace, 'mobile'), { recursive: true });
  await mkdir(configDir, { recursive: true });
  const sandbox = path.join(workspace, 'other');

  // Hidden: the recorded headless (sdk-cli) tx-main that no stored session owns.
  await writeTranscript(configDir, path.join(sandbox, 'tx main'), FIXTURE_IDS['tx-main'], await fixtureLines('tx-main', sandbox), OLD);
  // A terminal session with its --name title and a PR link.
  const tx = asTerminal(withSessionId(await fixtureLines('tx-main', sandbox), TX_ID));
  tx.push({ type: 'pr-link', prNumber: 42, prUrl: 'https://github.com/acme/tx/pull/42', prRepository: 'acme/tx', timestamp: '2026-09-27T21:20:00.000Z', sessionId: TX_ID });
  await writeTranscript(configDir, path.join(sandbox, 'tx main'), TX_ID, tx, OLD);
  // The forked file (two leaves): the newest leaf's reply is "lantern, walnut".
  await writeTranscript(configDir, path.join(sandbox, 'handoff-conc'), CONC_ID, asTerminal(withSessionId(await fixtureLines('handoff-conc', sandbox), CONC_ID)), OLD);
  // No custom title but an ai-title.
  const mid = withoutTypes(asTerminal(withSessionId(await fixtureLines('handoff-mid', sandbox), MID_ID)), 'custom-title', 'agent-name');
  mid.push({ type: 'ai-title', aiTitle: 'Code word check', sessionId: MID_ID });
  await writeTranscript(configDir, path.join(sandbox, 'handoff-mid'), MID_ID, mid, OLD);
  // No title at all: named by its first prompt; resumed from a second folder.
  await writeTranscript(configDir, path.join(sandbox, 'handoff'), HANDOFF_ID, withoutTypes(asTerminal(withSessionId(await fixtureLines('handoff', sandbox), HANDOFF_ID)), 'custom-title', 'agent-name'), OLD);
  // A session started with a slash command at the root, still active.
  const command = terminalUserLine({
    sessionId: LOOP_ID,
    cwd: workspace,
    content: '<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>1h Watch the build</command-args>',
    parentUuid: null,
    timestamp: '2026-09-28T01:00:00.000Z',
  });
  const reply = assistantTextLine({ sessionId: LOOP_ID, cwd: workspace, text: 'Watching the build every hour.', parentUuid: String(command['uuid']), timestamp: '2026-09-28T01:00:05.000Z' });
  loopFile = await writeTranscript(configDir, workspace, LOOP_ID, [command, reply]);
  // Hidden: a stub (opened and closed: no prompt, no command).
  const stub: Line[] = withoutTypes(asTerminal(withSessionId(await fixtureLines('tx-main', workspace), STUB_ID)), 'user', 'assistant').map((line) =>
    typeof line['cwd'] === 'string' ? { ...line, cwd: workspace } : line,
  );
  await writeTranscript(configDir, workspace, STUB_ID, stub, OLD);
  // Hidden: another root whose project folder starts with this root's slug.
  const otherRoot = path.join(tmp, 'work space2');
  await writeTranscript(configDir, path.join(otherRoot, 'app'), OTHER_ID, asTerminal(withSessionId(await fixtureLines('tx-main', path.join(otherRoot, 'app')), OTHER_ID)), OLD);
  expect(slugForCwd(path.join(otherRoot, 'app')).startsWith(slugForCwd(workspace))).toBe(true);

  // D14: the workspace is a saved folder (the default) in the server's database.
  await seedFolderInDataDir(path.join(tmp, 'data'), workspace);
  server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    CLAUDE_CONFIG_DIR: configDir,
  });
  const token = (await readFile(path.join(tmp, 'data', 'sb_token'), 'utf8')).trim();
  api = await playwrightRequest.newContext({ baseURL: server.baseUrl, extraHTTPHeaders: { cookie: `sb_token=${token}` } });
});

test.afterAll(async () => {
  await api?.dispose();
  if (server) expect(await server.stop()).toBe(0);
  await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

const TERMINAL_ROWS = [
  '09-28 01:00 | /loop 1h Watch the build | terminal · /loop 1h | Watching the build every hour. |  | active',
  '09-27 21:41 | sb-handoff-conc | terminal | lantern, walnut | handoff-conc ⎇ main | ended',
  '09-27 21:40 | Code word check | terminal | marigold | handoff-mid ⎇ main | ended',
  '09-27 21:39 | Remember the code word: tangerine. Reply with just OK. | terminal | tangerine, kestrel | handoff ⎇ main · handoff-elsewhere | ended',
  '09-27 21:19 | sb-tx-probe | terminal | finished | tx main ⎇ feature/tx-probe | PR #42',
];

test('terminal sessions of this root are listed; headless files, stubs and other roots are not', async ({ page }) => {
  await touchLoop();
  await page.goto(`${server.baseUrl}/history`);
  const view = page.getByTestId('view-history');
  await expect(view.locator('.sb-hist-title')).toHaveText('History');
  await expect(view.locator('.sb-hist-sub')).toHaveText('past sessions · searchable transcripts');
  await expect(page.getByTestId('history-search')).toHaveAttribute('placeholder', 'Search conversations, solutions, branches…');
  await expect(page.getByTestId('nav-history')).toHaveAttribute('aria-current', 'page');
  await settled(page);
  await expect(page.getByTestId('history-row')).toHaveCount(5);
  expect(await rowLines(page)).toEqual(TERMINAL_ROWS);
  // The outcome takes its status color: active = run (blue), ended = idle (gray).
  const statuses = await page.locator('.sb-hist-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-status')));
  expect(statuses).toEqual(['run', 'idle', 'idle', 'idle', 'idle']);
  const outcomeColors = await page.locator('.sb-hist-outcome').evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
  const [run, idle] = await page.evaluate((names) =>
    names.map((name) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }),
  ['--status-run', '--status-idle']);
  expect(outcomeColors).toEqual([run, idle, idle, idle, idle]);

  const ids = (await history()).map((item) => item.claudeSessionId);
  expect(ids).toEqual([LOOP_ID, CONC_ID, MID_ID, HANDOFF_ID, TX_ID]);
  for (const hidden of [FIXTURE_IDS['tx-main'], STUB_ID, OTHER_ID]) expect(ids).not.toContain(hidden);
  // Nothing is written into the config folder by History (only the files this spec wrote are there).
  const projects = await readdir(path.join(configDir, 'projects'), { recursive: true });
  expect(projects.filter((name) => name.endsWith('.jsonl'))).toHaveLength(8);
});

test('a session run through fake-claude appears with its DB data, live over /hub', async ({ page }) => {
  await touchLoop();
  await page.goto(`${server.baseUrl}/history`);
  await settled(page);
  await expect(page.getByTestId('history-row')).toHaveCount(5);

  const body: NewSession = {
    name: 'history-probe',
    task: 'Check the history view.',
    workType: 'feature',
    mode: 'single',
    solutions: ['alpha-front'],
    phase: 'ui-first',
    coordination: 'none',
    qa: null,
    worktrees: false,
    ultracode: false,
  };
  const response = await api.post('/api/sessions', { data: body });
  expect(response.status(), await response.text()).toBe(201);
  probe = (await response.json()) as Session;

  // Live: the row appears over /hub (sessionUpdated) without a reload.
  const row = page.locator(`[data-testid="history-row"][data-session-id="${probe.id}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.locator('.sb-hist-name')).toHaveText('history-probe');
  // Newest first: the new session starts the list.
  await expect(page.getByTestId('history-row').first()).toHaveAttribute('data-session-id', probe.id);

  // Once the turn is done and in the transcript, the fake's reply ("OK") is the summary.
  await expect.poll(async () => ((await (await api.get(`/api/sessions/${probe.id}`)).json()) as Session).status, { timeout: 20_000 }).toBe('done');
  await expect.poll(async () => (await history()).find((item) => item.sessionId === probe.id)?.summary, { timeout: 20_000 }).toBe('OK');
  const current = (await (await api.get(`/api/sessions/${probe.id}`)).json()) as Session;
  await page.reload();
  await settled(page);
  expect((await rowLines(page))[0]).toBe(`${utcDate(current.createdAt)} | history-probe | single · feature · UI-first | OK | alpha-front | ${STATUS_OUTCOME.done}`);
  await expect(row).toHaveAttribute('data-status', 'done');
  const item = (await history()).find((i) => i.sessionId === probe.id);
  expect(item).toMatchObject({ claudeSessionId: probe.claudeSessionId, name: 'history-probe', status: 'done', branches: [], solutions: ['alpha-front'] });
});

test('continued in a terminal, a Switchboard session keeps its row and shows the terminal reply', async ({ page }) => {
  const detach = await api.post(`/api/sessions/${probe.id}/detach`);
  expect(detach.status(), await detach.text()).toBe(200);
  // The terminal's turn (an interactive `claude --resume <id>` writes entrypoint "cli") goes to the same file.
  const file = path.join(configDir, 'projects', slugForCwd(workspace), `${probe.claudeSessionId}.jsonl`);
  await expect.poll(async () => (await stat(file).catch(() => null))?.size ?? 0).toBeGreaterThan(0);
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Line);
  const prompt = terminalUserLine({ sessionId: probe.claudeSessionId, cwd: workspace, content: 'Terminal question about the pay flow', parentUuid: lastUuid(lines), timestamp: new Date().toISOString() });
  const reply = assistantTextLine({ sessionId: probe.claudeSessionId, cwd: workspace, text: 'Terminal reply', parentUuid: String(prompt['uuid']), timestamp: new Date().toISOString() });
  await appendFile(file, ndjson([prompt, reply]));

  await touchLoop();
  await page.goto(`${server.baseUrl}/history`);
  await settled(page);
  const rows = page.locator(`[data-testid="history-row"][data-claude-session-id="${probe.claudeSessionId}"]`);
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('.sb-hist-name')).toHaveText('history-probe');
  await expect(rows.locator('.sb-hist-summary')).toHaveText('Terminal reply');
  await expect(page.getByTestId('history-row')).toHaveCount(6);
  expect((await history('terminal question about the pay')).map((i) => i.name)).toEqual(['history-probe']);
});

test('the search box filters on the service: prompts, replies, branches, names; "No sessions match."', async ({ page }) => {
  const queries: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/history' && url.searchParams.has('q')) queries.push(url.searchParams.get('q') ?? '');
  });
  await touchLoop();
  await page.goto(`${server.baseUrl}/history`);
  await settled(page);
  await expect(page.getByTestId('history-row')).toHaveCount(6);

  const names = () => page.locator('.sb-hist-name').allTextContents();
  await searchFor(page, 'walnut');
  expect(await names()).toEqual(['sb-handoff-conc']);
  await searchFor(page, 'KESTREL');
  expect(await names()).toEqual(['Remember the code word: tangerine. Reply with just OK.']);
  await searchFor(page, 'feature/tx-probe');
  expect(await names()).toEqual(['sb-tx-probe']);
  await searchFor(page, 'history-probe');
  expect(await names()).toEqual(['history-probe']);
  await searchFor(page, 'handoff-elsewhere');
  expect(await names()).toEqual(['Remember the code word: tangerine. Reply with just OK.']);
  await searchFor(page, 'no such conversation');
  await expect(page.getByTestId('history-row')).toHaveCount(0);
  await expect(page.getByTestId('history-empty')).toHaveText('No sessions match.');
  await searchFor(page, '');
  await expect(page.getByTestId('history-row')).toHaveCount(6);
  expect(queries).toEqual(expect.arrayContaining(['walnut', 'KESTREL', 'feature/tx-probe', 'no such conversation']));
});
