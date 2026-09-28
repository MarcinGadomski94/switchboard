import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../helpers/git.ts';
import { REPO_ROOT } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * The Solutions view (M6.2) on the real code path (D13, no demo seed):
 * `node src/server/main.ts` with fake-claude as the CLI, a fake gh, and a temp
 * workspace of real git repos laid out by the real router rules. Sessions are
 * started through the API from the page; the view follows them through `/hub`
 * (`sessionUpdated`) without a reload and shows their branches, worktrees,
 * changes, phase ledger, artifacts & follow-ups and codebase-memory freshness.
 */
let world: GitWorld;
let server: ServerProcess;

/** The dirty-tracker hook's project id: the absolute path with runs of `:` `/` `\` turned into `-`. */
function hookProjectId(absolute: string): string {
  return absolute.replace(/\\/g, '/').replace(/[:/\\]+/g, '-').replace(/^-+|-+$/g, '');
}

test.beforeAll(async () => {
  world = await makeGitWorld();
  const ws = world.workspace;
  await writeFile(path.join(ws, 'AGENTS.md'), await readFile(path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md'), 'utf8'));
  await world.makeRepo(path.join(ws, 'nugets', 'idle-nuget'));
  await world.makeRepo(path.join(ws, 'other', 'it-tool'));
  await world.makeRepo(path.join(ws, 'deprecated', 'microfrontends', 'old-front'));
  await world.commit(world.mobile, 'phase-ledger.md', '| Interface | Phase | Seam |\n|---|---|---|\n| FreeTalkService | UI-first | seam TODO · FreeTalkViewModel.cs:41 |\n');
  await mkdir(path.join(ws, '.claude'), { recursive: true });
  await writeFile(path.join(ws, '.claude', '.codebase-memory-dirty'), `${hookProjectId(path.join(ws, 'microfrontends', 'web-front'))}\n`);
  const claudeConfig = path.join(world.root, 'claude-config');
  await mkdir(claudeConfig, { recursive: true });
  server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(world.root, 'data'),
    SWITCHBOARD_WORKSPACE_ROOT: ws,
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
async function startSession(page: Page, body: Record<string, unknown>): Promise<number> {
  return page.evaluate(async (payload) => {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workType: 'feature', mode: 'single', coordination: 'none', qa: null, ultracode: false, ...payload }),
    });
    return response.status;
  }, body);
}

function row(page: Page, name: string) {
  return page.locator(`[data-testid="solution-row"][data-solution="${name}"]`);
}

test('Solutions: groups, filters, live branch chips and the detail panel from the real services', async ({ page }) => {
  const ws = world.workspace;
  await page.goto(`${server.baseUrl}/solutions`);
  await expect(page.getByTestId('view-solutions')).toBeVisible();
  await expect(page.getByTestId('nav-solutions')).toHaveAttribute('aria-current', 'page');

  // The scan, grouped by folder; other/ is "on request only" (gap #15); nothing runs yet.
  await expect(page.getByTestId('solution-group')).toHaveText(['microfrontends/', 'mobile/', 'nugets/', 'other/on request only', 'read-onlydeprecated/ · never edited']);
  await expect(page.getByTestId('solutions-meta')).toHaveText(`${ws} · 5 solutions · 0 active`);
  await expect(row(page, 'idle-nuget').getByTestId('branch-chip')).toHaveText(['⎇ mainidle']);
  await expect(row(page, 'old-front')).toHaveAttribute('data-readonly', 'true');
  await expect(row(page, 'old-front').locator('.sb-sol-changes')).toHaveText('locked');

  // The first row is selected: its detail panel.
  const detail = page.getByTestId('solution-detail');
  await expect(detail).toHaveAttribute('data-solution', 'web-front');
  await expect(page.getByTestId('solution-path')).toHaveText(path.join(ws, 'microfrontends', 'web-front'));
  await expect(detail.getByTestId('ledger-row')).toHaveText(['——no phase-ledger.md']);
  await expect(detail.getByTestId('solution-artifact')).toHaveText(['INFONo artifacts']);
  await expect(page.getByTestId('codebase-memory')).toHaveAttribute('data-state', 'dirty');
  await expect(page.getByTestId('codebase-memory')).toContainText('codebase-memory · edited by agents since last index');

  // Two sessions through the API: one with a worktree on web-front, one in place on mobile.
  expect(
    await startSession(page, {
      name: 'wt-live',
      task: '[fake:write microfrontends/web-front-wt-wt-live/contracts/free-talk.md]',
      solutions: ['web-front'],
      phase: 'integration',
      worktrees: true,
    }),
  ).toBe(201);
  expect(
    await startSession(page, {
      name: 'in-place-live',
      task: '[fake:write mobile/mobile-followups/from-web-front.md]',
      solutions: ['mobile'],
      phase: 'ui-first',
      worktrees: false,
    }),
  ).toBe(201);

  // The view follows through /hub (sessionUpdated), without a reload.
  await expect(row(page, 'web-front').getByTestId('branch-chip')).toHaveText(['⎇ session/wt-liveweb-front-wt-wt-livewt-live'], { timeout: 15_000 });
  await expect(row(page, 'web-front').locator('.sb-sol-changes')).toHaveText('+1', { timeout: 15_000 });
  await expect(row(page, 'web-front').locator('.sb-sol-phase')).toHaveText('integration');
  await expect(row(page, 'mobile').getByTestId('branch-chip')).toHaveText(['⎇ mainin-place-live'], { timeout: 15_000 });
  await expect(row(page, 'mobile').locator('.sb-sol-changes')).toHaveText('+1', { timeout: 15_000 });
  await expect(row(page, 'mobile').locator('.sb-sol-phase')).toHaveText('UI-first');
  await expect(page.getByTestId('solutions-meta')).toHaveText(`${ws} · 5 solutions · 2 active`);

  // Detail of web-front: the worktree card, the session's contract artifact.
  await expect(detail.getByTestId('branch-card')).toHaveText(['⎇ session/wt-live../web-front-wt-wt-livewt-live']);
  await expect(detail.getByTestId('solution-artifact').filter({ has: page.locator('.sb-sol-art-tag', { hasText: /^CONTRACT$/ }) })).toHaveText('CONTRACTcontracts/free-talk.md');

  // Select mobile: in-place card, the ledger from phase-ledger.md, the follow-up, fresh index.
  await row(page, 'mobile').click();
  await expect(detail).toHaveAttribute('data-solution', 'mobile');
  await expect(row(page, 'mobile')).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('solution-path')).toHaveText(path.join(ws, 'mobile'));
  await expect(detail.getByTestId('branch-card')).toHaveText(['⎇ mainin placein-place-live']);
  await expect(detail.getByTestId('ledger-row')).toHaveText(['FreeTalkServiceUI-firstseam TODO · FreeTalkViewModel.cs:41']);
  await expect(detail.getByTestId('solution-artifact').filter({ has: page.locator('.sb-sol-art-tag', { hasText: /^FOLLOWUP$/ }) })).toHaveText('FOLLOWUPmobile-followups/from-web-front.md');
  await expect(page.getByTestId('codebase-memory')).toHaveAttribute('data-state', 'fresh');
  await expect(page.getByTestId('codebase-memory')).toContainText('codebase-memory · indexed · fresh');

  // Filter pills: Web, Mobile, NuGet, Backend (none here), Read-only; other/ only under All.
  const names = () => page.getByTestId('solution-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-solution')));
  await page.getByTestId('solutions-filter-Web').click();
  await expect(page.getByTestId('solutions-filter-Web')).toHaveAttribute('aria-pressed', 'true');
  expect(await names()).toEqual(['web-front']);
  await page.getByTestId('solutions-filter-Mobile').click();
  expect(await names()).toEqual(['mobile']);
  await page.getByTestId('solutions-filter-NuGet').click();
  expect(await names()).toEqual(['idle-nuget']);
  await page.getByTestId('solutions-filter-Backend').click();
  expect(await names()).toEqual([]);
  await page.getByTestId('solutions-filter-Read-only').click();
  expect(await names()).toEqual(['old-front']);
  await page.getByTestId('solutions-filter-All').click();
  expect(await names()).toEqual(['web-front', 'mobile', 'idle-nuget', 'it-tool', 'old-front']);
  // The selection survives filtering.
  await expect(detail).toHaveAttribute('data-solution', 'mobile');

  // Keyboard selection.
  await row(page, 'idle-nuget').focus();
  await page.keyboard.press('Enter');
  await expect(detail).toHaveAttribute('data-solution', 'idle-nuget');

  // "open Codebase Memory ›": no Codebase Memory tool is configured here, so it leads to Settings → Embedded tools.
  await page.getByTestId('open-codebase-memory').click();
  await expect(page).toHaveURL(`${server.baseUrl}/settings/tools`);
});

test('Solutions without a workspace root says so', async ({ page }) => {
  const bare = await startServer({ SWITCHBOARD_DATA_DIR: path.join(world.root, 'data-bare') });
  try {
    await page.goto(`${bare.baseUrl}/solutions`);
    await expect(page.getByTestId('solutions-error')).toHaveText('No workspace root is configured (SWITCHBOARD_WORKSPACE_ROOT).');
    await expect(page.getByTestId('solutions-meta')).toHaveText('');
  } finally {
    expect(await bare.stop()).toBe(0);
  }
});
