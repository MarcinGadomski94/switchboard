import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type APIRequestContext, type Page, expect, request as playwrightRequest, test } from '@playwright/test';
import type { ArtifactListItem, NewSession, Session } from '../../src/core/api.ts';
import { runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';
import { type DemoApp, startDemoApp } from './visual/harness.ts';

/**
 * M7.3 oracle: the global Artifacts view. The real code path first (no demo seed,
 * D13): `node src/server/main.ts` with fake-claude as the CLI, a temp workspace
 * with a real git repo (`microfrontends/alpha-front`) and fake gh. Two sessions
 * started through the API write files with `[fake:write]`; the recorder turns them
 * into artifacts (gap #9), one inside the session's git worktree (gap #1), and
 * the view lists them from `GET /api/artifacts?type=&q=`: rows, the type filters,
 * search, a click that opens the source session, and a live update over `/hub`.
 * Then the prototype's demo rows (PR / BRANCH / TICKET types that fake-claude
 * cannot produce) through the same view.
 */
test.describe.configure({ mode: 'serial' });

let tmp: string;
let workspace: string;
let server: ServerProcess;
let api: APIRequestContext;
const sessions: Record<string, Session> = {};

const GIT_ENV = (gitConfig: string): Record<string, string> => ({
  GIT_CONFIG_GLOBAL: gitConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Switchboard Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Switchboard Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
});

async function git(cwd: string, env: Record<string, string>, ...args: string[]): Promise<void> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...env } });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function newSession(name: string, task: string, worktrees: boolean): NewSession {
  return { name, task, workType: 'feature', mode: 'single', solutions: ['alpha-front'], phase: 'ui-first', coordination: 'none', qa: null, worktrees, ultracode: false };
}

async function start(body: NewSession): Promise<Session> {
  const response = await api.post('/api/sessions', { data: body });
  expect(response.status(), await response.text()).toBe(201);
  const session = (await response.json()) as Session;
  sessions[session.name] = session;
  return session;
}

async function send(session: Session, text: string): Promise<void> {
  const response = await api.post(`/api/sessions/${session.id}/messages`, { data: { text } });
  expect(response.status()).toBe(202);
}

async function listed(): Promise<ArtifactListItem[]> {
  return (await (await api.get('/api/artifacts')).json()) as ArtifactListItem[];
}

async function waitForArtifacts(count: number): Promise<void> {
  await expect.poll(async () => (await listed()).length, { timeout: 20_000 }).toBe(count);
}

/** Every row's cells as one line (`TYPE | name | location | session | status`), sorted. */
async function rowLines(page: Page): Promise<string[]> {
  const rows = page.getByTestId('artifact-row');
  const lines = await rows.evaluateAll((els) =>
    els.map((el) => [...el.children].slice(0, 5).map((cell) => (cell.textContent ?? '').trim()).join(' | ')),
  );
  return lines.sort();
}

async function pick(page: Page, label: string): Promise<void> {
  await page.getByTestId('artifacts-filter').filter({ hasText: new RegExp(`^${label.replace(/[/&]/g, '\\$&')}$`) }).click();
  await expect(page.getByTestId('view-artifacts')).toHaveAttribute('data-filter', label);
  await settled(page);
}

/** Waits until the rows on screen belong to the current filter + search (`aria-busy` off). */
async function settled(page: Page): Promise<void> {
  await expect(page.getByTestId('view-artifacts')).toHaveAttribute('aria-busy', 'false');
}

/** Types a search and waits for its rows. */
async function searchFor(page: Page, text: string): Promise<void> {
  await page.getByTestId('artifacts-search').fill(text);
  await settled(page);
}

test.describe('real path (fake-claude, temp workspace + git worktree)', () => {
  test.beforeAll(async () => {
    tmp = await realpath(await makeTempDir('e2e-artifacts'));
    workspace = path.join(tmp, 'work space');
    const claudeConfig = path.join(tmp, 'claude-config');
    const gitConfig = path.join(tmp, 'gitconfig');
    await mkdir(claudeConfig, { recursive: true });
    await writeFile(gitConfig, '');
    const gitEnv = GIT_ENV(gitConfig);
    // A real repo, so the pay-flow session gets its worktree (gap #1) and its DIFF a branch.
    const repo = path.join(workspace, 'microfrontends', 'alpha-front');
    await mkdir(path.join(repo, 'Pages'), { recursive: true });
    await writeFile(path.join(repo, 'README.md'), 'alpha\n');
    await git(repo, gitEnv, 'init', '-q', '-b', 'main');
    await git(repo, gitEnv, 'add', '-A');
    await git(repo, gitEnv, 'commit', '-q', '-m', 'init');
    await mkdir(path.join(workspace, 'mobile'), { recursive: true });
    server = await startServer({
      SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
      SWITCHBOARD_WORKSPACE_ROOT: workspace,
      SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
      SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
      CLAUDE_CONFIG_DIR: claudeConfig,
      // The service's git reads no developer config either.
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
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

  test('a fresh install: the table header, the five filters and "No artifacts yet."', async ({ page }) => {
    await page.goto(`${server.baseUrl}/artifacts`);
    const view = page.getByTestId('view-artifacts');
    await expect(view.locator('.sb-art-title')).toHaveText('Artifacts');
    await expect(page.getByTestId('artifacts-count')).toHaveText('0 of 0');
    await expect(page.getByTestId('artifacts-search')).toHaveAttribute('placeholder', 'Search artifacts, solutions, branches…');
    await expect(page.getByTestId('artifacts-filter')).toHaveText(['All', 'Diffs', 'PRs / branches', 'Docs & contracts', 'Ticket replies']);
    await expect(page.getByTestId('artifacts-filter').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(view.locator('.sb-art-cols > span')).toHaveText(['Type', 'Name', 'Solution · branch', 'Session', 'Status', 'Age']);
    await expect(page.getByTestId('artifacts-empty')).toHaveText('No artifacts yet.');
    await expect(page.getByTestId('nav-artifacts')).toHaveAttribute('aria-current', 'page');
  });

  test('files the sessions write become rows: type, name, solution · branch, session, age', async ({ page }) => {
    const pay = await start(newSession('pay-flow', 'Lock the contract. [fake:write contracts/pay.md]', true));
    await send(pay, 'The page. [fake:write microfrontends/alpha-front-wt-pay-flow/Pages/Pay/Pay.razor]');
    await send(pay, 'The notes. [fake:write microfrontends/alpha-front-wt-pay-flow/docs/pay-notes.md]');
    await waitForArtifacts(3);
    const docs = await start(newSession('docs-pay', 'The matrix. [fake:write coverage-matrix.md]', false));
    await send(docs, 'The follow-up. [fake:write mobile/mobile-followups/from-alpha-front.md]');
    await waitForArtifacts(6);

    await page.goto(`${server.baseUrl}/artifacts`);
    await expect(page.getByTestId('artifacts-count')).toHaveText('6 of 6');
    await expect(page.getByTestId('artifact-row')).toHaveCount(6);
    expect(await rowLines(page)).toEqual([
      'CONTRACT | contracts/pay.md | root | pay-flow | ',
      'DIFF | 2 files | alpha-front ⎇ session/pay-flow | pay-flow | ',
      'DIFF | mobile-followups · 1 file | mobile | docs-pay | ',
      'DOC | docs/pay-notes.md | alpha-front ⎇ session/pay-flow | pay-flow | ',
      'FOLLOWUP | mobile-followups/from-alpha-front.md | mobile | docs-pay | ',
      'QA | coverage-matrix.md | root | docs-pay | ',
    ]);
    // Age from the last update: everything happened within the minute.
    await expect(page.locator('.sb-art-age')).toHaveText(Array(6).fill('now'));
    // Newest first, like the API.
    const apiOrder = (await listed()).map((a) => a.name);
    await expect(page.locator('.sb-art-name')).toHaveText(apiOrder);
  });

  test('the type filters ask the service for their types; the count reads "n of total"', async ({ page }) => {
    const queries: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/artifacts' && url.search) queries.push(url.searchParams.get('type') ?? '');
    });
    await page.goto(`${server.baseUrl}/artifacts`);
    await expect(page.getByTestId('artifacts-count')).toHaveText('6 of 6');

    await pick(page, 'Diffs');
    await expect(page.getByTestId('artifacts-count')).toHaveText('2 of 6');
    await expect(page.locator('.sb-art-type')).toHaveText(['DIFF', 'DIFF']);
    await expect(page.getByTestId('artifacts-filter').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('artifacts-filter').first()).toHaveAttribute('aria-pressed', 'false');

    await pick(page, 'PRs / branches');
    await expect(page.getByTestId('artifacts-count')).toHaveText('0 of 6');
    await expect(page.getByTestId('artifact-row')).toHaveCount(0);
    await expect(page.getByTestId('artifacts-empty')).toHaveText('No artifacts match.');

    await pick(page, 'Docs & contracts');
    await expect(page.getByTestId('artifacts-count')).toHaveText('4 of 6');
    expect((await page.locator('.sb-art-type').allTextContents()).sort()).toEqual(['CONTRACT', 'DOC', 'FOLLOWUP', 'QA']);

    await pick(page, 'Ticket replies');
    await expect(page.getByTestId('artifacts-count')).toHaveText('0 of 6');
    await expect(page.getByTestId('artifacts-empty')).toHaveText('No artifacts match.');

    await pick(page, 'All');
    await expect(page.getByTestId('artifacts-count')).toHaveText('6 of 6');
    await expect(page.getByTestId('artifact-row')).toHaveCount(6);
    expect([...new Set(queries)]).toEqual(['DIFF', 'PR,BRANCH', 'DOC,CONTRACT,QA,FOLLOWUP', 'TICKET']);

    // Selected pill: the prototype's #e8e7e3 on #111214; the others #1f2024 / #c9c8c3.
    const colors = await page.getByTestId('artifacts-filter').evaluateAll((els) =>
      els.map((el) => `${getComputedStyle(el).backgroundColor} ${getComputedStyle(el).color}`),
    );
    expect(colors[0]).toBe('rgb(232, 231, 227) rgb(17, 18, 20)');
    expect(colors[1]).toBe('rgb(31, 32, 36) rgb(201, 200, 195)');
  });

  test('search runs on the service over name, solution · branch, session and type; it combines with a filter', async ({ page }) => {
    const searches: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/artifacts' && url.searchParams.has('q')) searches.push(url.searchParams.get('q') ?? '');
    });
    await page.goto(`${server.baseUrl}/artifacts`);
    await expect(page.getByTestId('artifacts-count')).toHaveText('6 of 6');

    await searchFor(page, 'pay-notes');
    await expect(page.getByTestId('artifacts-count')).toHaveText('1 of 6');
    await expect(page.locator('.sb-art-name')).toHaveText(['docs/pay-notes.md']);

    await searchFor(page, 'SESSION/PAY-FLOW');
    await expect(page.getByTestId('artifacts-count')).toHaveText('2 of 6');
    expect((await page.locator('.sb-art-type').allTextContents()).sort()).toEqual(['DIFF', 'DOC']);

    await searchFor(page, 'docs-pay');
    await expect(page.getByTestId('artifacts-count')).toHaveText('3 of 6');
    await pick(page, 'Diffs');
    await expect(page.getByTestId('artifacts-count')).toHaveText('1 of 6');
    await expect(page.locator('.sb-art-name')).toHaveText(['mobile-followups · 1 file']);

    await searchFor(page, 'root');
    await expect(page.getByTestId('artifacts-count')).toHaveText('0 of 6');
    await pick(page, 'All');
    await expect(page.getByTestId('artifacts-count')).toHaveText('2 of 6');
    expect((await page.locator('.sb-art-name').allTextContents()).sort()).toEqual(['contracts/pay.md', 'coverage-matrix.md']);

    await searchFor(page, 'nothing like this');
    await expect(page.getByTestId('artifacts-empty')).toHaveText('No artifacts match.');
    await searchFor(page, '');
    await expect(page.getByTestId('artifacts-count')).toHaveText('6 of 6');
    expect(searches).toContain('SESSION/PAY-FLOW');
    expect(searches).toContain('docs-pay');
  });

  test('a click opens the source session (Chat); Back returns to the list', async ({ page }) => {
    const documents: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documents.push(request.url());
    });
    await page.goto(`${server.baseUrl}/artifacts`);
    const row = page.getByTestId('artifact-row').filter({ hasText: 'coverage-matrix.md' });
    await expect(row).toHaveAttribute('href', `/sessions/${sessions['docs-pay']!.id}`);
    await row.click();
    await expect(page).toHaveURL(`${server.baseUrl}/sessions/${sessions['docs-pay']!.id}`);
    await expect(page.getByTestId('view-session')).toHaveAttribute('data-session-id', sessions['docs-pay']!.id);
    await expect(page.getByTestId('view-session')).toHaveAttribute('data-tab', 'chat');
    await page.goBack();
    await expect(page.getByTestId('view-artifacts')).toBeVisible();
    await page.getByTestId('artifact-row').filter({ hasText: 'contracts/pay.md' }).click();
    await expect(page.getByTestId('view-session')).toHaveAttribute('data-session-id', sessions['pay-flow']!.id);
    expect(documents).toEqual([`${server.baseUrl}/artifacts`]); // client-side navigation only
  });

  test('a new artifact appears live (the view reloads on /hub activity), with the filter kept', async ({ page }) => {
    const documents: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documents.push(request.url());
    });
    await page.goto(`${server.baseUrl}/artifacts`);
    await pick(page, 'Docs & contracts');
    await expect(page.getByTestId('artifacts-count')).toHaveText('4 of 6');
    await send(sessions['pay-flow']!, 'One more. [fake:write contracts/refund.md]');
    await expect(page.getByTestId('artifacts-count')).toHaveText('5 of 7', { timeout: 15_000 });
    await expect(page.getByTestId('artifact-row').filter({ hasText: 'contracts/refund.md' })).toHaveCount(1);
    expect(documents).toEqual([`${server.baseUrl}/artifacts`]);
  });
});

test.describe('demo seed (the prototype rows, incl. PR / BRANCH / TICKET)', () => {
  let demo: DemoApp;

  test.beforeAll(async () => {
    demo = await startDemoApp();
  });

  test.afterAll(async () => {
    await demo?.stop();
  });

  test.beforeEach(async ({ page }) => {
    await stubToolProbes(page);
  });

  test('the five filters over the 13 prototype rows; search; a row opens its session', async ({ page }) => {
    await page.goto(`${demo.baseUrl}/artifacts`);
    await expect(page.getByTestId('artifacts-count')).toHaveText('13 of 13');
    const counts: Array<[string, string, string[]]> = [
      ['Diffs', '3 of 13', ['DIFF']],
      ['PRs / branches', '3 of 13', ['BRANCH', 'PR']],
      ['Docs & contracts', '6 of 13', ['CONTRACT', 'DOC', 'FOLLOWUP', 'QA']],
      ['Ticket replies', '1 of 13', ['TICKET']],
      ['All', '13 of 13', ['BRANCH', 'CONTRACT', 'DIFF', 'DOC', 'FOLLOWUP', 'PR', 'QA', 'TICKET']],
    ];
    for (const [label, count, types] of counts) {
      await pick(page, label);
      await expect(page.getByTestId('artifacts-count')).toHaveText(count);
      expect([...new Set(await page.locator('.sb-art-type').allTextContents())].sort()).toEqual(types);
    }
    const pr = page.getByTestId('artifact-row').filter({ hasText: 'notifications-microservice #88 · push preferences' });
    await expect(pr.locator('.sb-art-location')).toHaveText('notifications-microservice ⎇ feature/push-prefs');
    await expect(pr.locator('.sb-art-session')).toHaveText('notifications-integration');
    await expect(pr.locator('.sb-art-meta')).toHaveText('open');
    await expect(pr.locator('.sb-art-age')).toHaveText('20m');

    await searchFor(page, 'free talk');
    await expect(page.getByTestId('artifacts-count')).toHaveText('2 of 13');
    expect((await page.locator('.sb-art-name').allTextContents()).sort()).toEqual([
      'Reply draft: Free talk empty-state copy',
      'coverage-matrix.md · Free talk',
    ]);
    await page.getByTestId('artifact-row').filter({ hasText: 'Reply draft' }).click();
    await expect(page.getByTestId('view-session')).toHaveAttribute('data-session-id', 'qa-free-talk');
  });
});
