import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../helpers/git.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { openWithHub } from './question-world.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';

/**
 * The Artifacts tab (M4.6) on the real code path (D13, no demo seed): `node
 * src/server/main.ts` with fake-claude as the CLI, a fake gh and temp git repos.
 * A session with a `web-front` worktree (gap #1) has fake-claude write real
 * files; the recorder turns them into artifacts (gap #9: CONTRACT, DIFF per
 * solution + branch, DOC, QA, FOLLOWUP) and the tab lists them as type tag +
 * name + meta rows, newest first, following each write through `/hub` without a
 * reload. DIFF rows read `<solution> · <n files>` with `+/−` from the session's
 * git diff (a change the developer committed counts too); a session without
 * artifacts shows the INFO row.
 */
let world: GitWorld;
let server: ServerProcess;

test.beforeAll(async () => {
  world = await makeGitWorld();
  const claudeConfig = path.join(world.root, 'claude-config');
  await mkdir(claudeConfig, { recursive: true });
  // D14: the workspace is a saved folder (the default) in the server's database.
  await seedFolderInDataDir(path.join(world.root, 'data'), world.workspace);
  server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(world.root, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: claudeConfig,
    FAKE_CLAUDE_SCENARIO: 'handoff-start',
    FAKE_GH_PRS: world.prsFile,
    GIT_CONFIG_GLOBAL: String(world.env['GIT_CONFIG_GLOBAL']),
    GIT_CONFIG_NOSYSTEM: '1',
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  await world?.cleanup();
});

/** Starts a session through the API from the page (same origin, the sb_token cookie). */
async function startSession(page: Page, body: Record<string, unknown>): Promise<string> {
  const result = await page.evaluate(async (payload) => {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workType: 'feature', mode: 'single', phase: 'ui-first', coordination: 'none', qa: null, ultracode: false, ...payload }),
    });
    return { status: response.status, body: (await response.json()) as { id: string } };
  }, body);
  expect(result.status).toBe(201);
  return result.body.id;
}

async function sessionStatus(page: Page, id: string): Promise<string> {
  return page.evaluate(async (sid) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}`);
    return ((await response.json()) as { status: string }).status;
  }, id);
}

async function sendMessage(page: Page, id: string, text: string): Promise<void> {
  const status = await page.evaluate(
    async ({ sid, body }) => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      return response.status;
    },
    { sid: id, body: text },
  );
  expect(status).toBe(202);
}

/** The color `value` computes to in this page (Chromium keeps oklch as `oklch(…)`). */
async function computed(page: Page, value: string): Promise<string> {
  return page.evaluate((v) => {
    const probe = document.createElement('div');
    probe.style.color = v;
    document.body.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, value);
}

async function style(locator: Locator, prop: string): Promise<string> {
  return locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
}

/** The tab's rows as `TAG | name | meta`, in screen order. */
async function rowTexts(page: Page): Promise<string[]> {
  return page.getByTestId('artifact-row').evaluateAll((rows) =>
    rows.map((row) => [...row.children].map((child) => child.textContent ?? '').join(' | ')),
  );
}

async function sortedRows(page: Page): Promise<string[]> {
  return (await rowTexts(page)).sort();
}

test('Artifacts: type tag + name + meta rows from real writes, live through /hub, git-based DIFF counts, empty', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${server.baseUrl}/inbox`);

  // A worktree session writes a contract at the workspace root (cwd = the workspace root).
  const id = await startSession(page, {
    name: 'arts-e2e',
    task: '[fake:write contracts/arts-e2e.md]',
    solutions: ['web-front'],
    worktrees: true,
  });
  await expect.poll(() => sessionStatus(page, id), { timeout: 20_000 }).toBe('done');

  await openWithHub(page, `${server.baseUrl}/sessions/${id}/artifacts`);
  const tab = page.getByTestId('session-artifacts');
  await expect(tab).toHaveAttribute('data-session-id', id);
  await expect(tab).toHaveAttribute('data-state', 'ready');
  const rows = page.getByTestId('artifact-row');
  await expect(rows).toHaveCount(1);
  expect(await rowTexts(page)).toEqual(['CONTRACT | contracts/arts-e2e.md | ']);
  await expect(rows.nth(0)).toHaveAttribute('title', 'workspace root');

  // Live: a write into the worktree arrives through /hub (no reload) as a DIFF of web-front, newest first.
  await sendMessage(page, id, 'Build the page [fake:write microfrontends/web-front-wt-arts-e2e/src/page.txt]');
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  await expect.poll(() => rowTexts(page), { timeout: 20_000 }).toEqual(['DIFF | web-front · 1 file | +1', 'CONTRACT | contracts/arts-e2e.md | ']);
  await expect(rows.nth(0)).toHaveAttribute('data-type', 'DIFF');
  await expect(rows.nth(0)).toHaveAttribute('title', 'web-front ⎇ session/arts-e2e');

  // A doc in the worktree: DOC + the DIFF grows to two files.
  await sendMessage(page, id, 'Write notes [fake:write microfrontends/web-front-wt-arts-e2e/docs/notes.md]');
  await expect
    .poll(() => sortedRows(page), { timeout: 20_000 })
    .toEqual(['CONTRACT | contracts/arts-e2e.md | ', 'DIFF | web-front · 2 files | +2', 'DOC | docs/notes.md | ']);
  await expect(rows.filter({ hasText: 'docs/notes.md' })).toHaveAttribute('title', 'web-front ⎇ session/arts-e2e');

  // A QA matrix at the root, then a follow-up in the mobile main checkout (outside the session's scope).
  await sendMessage(page, id, 'Coverage [fake:write coverage-matrix.md]');
  await expect(rows).toHaveCount(4, { timeout: 20_000 });
  await expect(rows.nth(0)).toHaveAttribute('data-type', 'QA');
  await sendMessage(page, id, 'Follow-up [fake:write mobile/mobile-followups/from-web-front.md]');
  await expect
    .poll(() => sortedRows(page), { timeout: 20_000 })
    .toEqual([
      'CONTRACT | contracts/arts-e2e.md | ',
      'DIFF | mobile · 1 file | ',
      'DIFF | web-front · 2 files | +2',
      'DOC | docs/notes.md | ',
      'FOLLOWUP | mobile-followups/from-web-front.md | ',
      'QA | coverage-matrix.md | ',
    ]);
  // Newest first: the follow-up's pair, then QA, then the web-front pair, then the contract.
  const order = await rowTexts(page);
  expect(order.slice(0, 2).sort()).toEqual(['DIFF | mobile · 1 file | ', 'FOLLOWUP | mobile-followups/from-web-front.md | ']);
  expect(order[2]).toBe('QA | coverage-matrix.md | ');
  expect(order.slice(3, 5).sort()).toEqual(['DIFF | web-front · 2 files | +2', 'DOC | docs/notes.md | ']);
  expect(order[5]).toBe('CONTRACT | contracts/arts-e2e.md | ');
  await expect(rows.filter({ hasText: 'mobile · 1 file' })).toHaveAttribute('title', 'mobile');

  // The DIFF counts come from git: a change the developer committed on the session branch counts too.
  const worktree = path.join(world.workspace, 'microfrontends', 'web-front-wt-arts-e2e');
  await world.commit(worktree, 'src/app.txt', 'one\nTWO\nthree\n', 'approved: TWO');
  await openWithHub(page, `${server.baseUrl}/sessions/${id}/artifacts`);
  await expect.poll(() => sortedRows(page), { timeout: 20_000 }).toContain('DIFF | web-front · 3 files | +3 −1');

  // The contract route carries the stored artifacts (names as the recorder derived them).
  const detail = (await page.evaluate(async (sid) => (await fetch(`/api/sessions/${sid}`)).json(), id)) as {
    artifacts: Array<{ type: string; name: string; solution: string | null; branch: string | null; meta: string | null }>;
  };
  const stored = detail.artifacts.map((a) => JSON.stringify([a.type, a.name, a.solution, a.branch, a.meta])).sort();
  expect(stored).toEqual(
    [
      ['CONTRACT', 'contracts/arts-e2e.md', null, null, null],
      ['DIFF', 'mobile-followups · 1 file', 'mobile', null, null],
      ['DIFF', '2 files', 'web-front', 'session/arts-e2e', null],
      ['DOC', 'docs/notes.md', 'web-front', 'session/arts-e2e', null],
      ['FOLLOWUP', 'mobile-followups/from-web-front.md', 'mobile', null, null],
      ['QA', 'coverage-matrix.md', null, null, null],
    ]
      .map((row) => JSON.stringify(row))
      .sort(),
  );

  // SPEC tokens + the prototype's inline styles.
  const first = rows.nth(0);
  expect(await style(tab, 'padding-top')).toBe('18px');
  expect(await style(tab, 'padding-left')).toBe('22px');
  expect(await style(tab, 'row-gap')).toBe('6px');
  expect(await style(first, 'background-color')).toBe(await computed(page, '#17181b'));
  expect(await style(first, 'border-top-color')).toBe(await computed(page, '#26272c'));
  expect(await style(first, 'border-top-width')).toBe('1px');
  expect(await style(first, 'border-top-left-radius')).toBe('9px');
  expect(await style(first, 'padding-top')).toBe('11px');
  expect(await style(first, 'padding-left')).toBe('14px');
  expect(await style(first, 'column-gap')).toBe('12px');
  const tag = first.getByTestId('artifact-tag');
  expect(await style(tag, 'font-family')).toContain('Geist Mono');
  expect(await style(tag, 'font-size')).toBe('10px');
  expect(await style(tag, 'font-weight')).toBe('500');
  expect(await style(tag, 'background-color')).toBe(await computed(page, '#26272c'));
  expect(await style(tag, 'color')).toBe(await computed(page, '#c9c8c3'));
  expect(await style(tag, 'border-top-left-radius')).toBe('4px');
  const name = first.getByTestId('artifact-name');
  expect(await style(name, 'font-size')).toBe('13px');
  expect(await style(name, 'font-family')).toContain('Geist');
  expect(await style(name, 'font-family')).not.toContain('Mono');
  const meta = rows.filter({ hasText: 'web-front · 3 files' }).getByTestId('artifact-meta');
  expect(await style(meta, 'font-family')).toContain('Geist Mono');
  expect(await style(meta, 'font-size')).toBe('11.5px');
  expect(await style(meta, 'color')).toBe(await computed(page, '#8d8c87'));
  // The name takes the row's free width; the meta sits at the right edge (14 px padding + 1 px border).
  const rowBox = (await first.boundingBox())!;
  const metaBox = (await rows.filter({ hasText: 'web-front · 3 files' }).getByTestId('artifact-meta').boundingBox())!;
  const metaRow = (await rows.filter({ hasText: 'web-front · 3 files' }).boundingBox())!;
  expect(Math.abs(metaBox.x + metaBox.width - (metaRow.x + metaRow.width - 15))).toBeLessThanOrEqual(1);
  expect(rowBox.width).toBeGreaterThan(600);

  // A session without artifacts: the INFO row.
  const clean = await startSession(page, { name: 'arts-clean', task: 'Nothing to write.', solutions: ['web-front'], worktrees: true });
  await expect.poll(() => sessionStatus(page, clean), { timeout: 20_000 }).toBe('done');
  await openWithHub(page, `${server.baseUrl}/sessions/${clean}/artifacts`);
  await expect(page.getByTestId('session-artifacts')).toHaveAttribute('data-session-id', clean);
  await expect(page.getByTestId('session-artifacts')).toHaveAttribute('data-state', 'empty');
  await expect(rows).toHaveCount(1);
  expect(await rowTexts(page)).toEqual(['INFO | No artifacts | ']);

  // The developer's main checkout of web-front was never touched.
  expect(await world.git(world.web, 'status', '--porcelain')).toBe('');
});
