import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type OriginRepo, makeOriginRepo } from '../helpers/origin.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { openWithHub } from './question-world.ts';

/**
 * D47 oracle (E2E, real path, no demo seed, D13): the New-session form's
 * **Parent** field and the stacked preflight columns. `node src/server/main.ts`
 * with fake-claude, fake gh (the parent's PR #306 in alpha-front), a temp data
 * folder and a fixture workspace whose repos are cloned from **local bare
 * origins**: `microfrontends/alpha-front` (origin: master, dev, the parent task
 * branch from dev) and `microfrontends/beta-front` (origin: master, dev). The
 * task text "Create it from PROJ-3013" pre-fills the Parent field; the preflight
 * shows alpha-front stacked on the parent (PR #306 open) and beta-front falling
 * back to `origin/dev` with its PR into the epic; clearing the field is kept
 * (the text never overwrites it); Start posts the parent, cuts alpha-front's
 * worktree from `origin/<parent>` and beta-front's from `origin/dev`, pushes
 * nothing, and the first message carries the stacked Branching lines.
 */
const EPIC = 'feature/PROJ-3010-Platform-tracking-and-KPI-delivery-process-development';
const PARENT = 'PROJ-3013-configure-hubspot-opt-in-cookie-banner-across-both-domains';
const TASK = 'PROJ-3014-kpi-events';
const NAME = 'proj-3014-kpi-events';

let tmp: string;
let workspace: string;
let server: ServerProcess;
let gitEnv: Record<string, string>;
let alpha: OriginRepo;
let beta: OriginRepo;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...gitEnv } });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
  return result.stdout.trim();
}

async function listSessions(page: Page): Promise<Session[]> {
  return page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as Session[]);
}

async function firstMessage(page: Page, id: string): Promise<string[]> {
  const events = (await page.evaluate(async (sid) => (await fetch(`/api/sessions/${sid}/events`)).json(), id)) as Array<{ payload: { type?: string; text?: string } }>;
  return (events.find((event) => event.payload.type === 'user')?.payload.text ?? '').split('\n');
}

async function summary(modal: Locator): Promise<string[]> {
  return modal.getByTestId('ns-summary-line').allTextContents();
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-stacked'));
  workspace = path.join(tmp, 'work space');
  const gitConfig = path.join(tmp, 'gitconfig');
  const dataDir = path.join(tmp, 'data');
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  await writeFile(gitConfig, '');
  gitEnv = {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Switchboard Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  alpha = await makeOriginRepo(git, tmp, path.join(workspace, 'microfrontends', 'alpha-front'), [
    ['dev', 'master'],
    [PARENT, 'dev'],
  ]);
  beta = await makeOriginRepo(git, tmp, path.join(workspace, 'microfrontends', 'beta-front'), [['dev', 'master']]);
  await writeFile(
    path.join(tmp, 'fake-gh-prs.json'),
    JSON.stringify({ [`alpha-front:${PARENT}`]: { number: 306, state: 'OPEN', url: 'https://github.test/alpha/pull/306', baseRefName: EPIC, headRefOid: await git(alpha.pusher, 'rev-parse', PARENT) } }),
  );
  await seedFolderInDataDir(dataDir, workspace);
  server = await startServer({
    ...gitEnv,
    SWITCHBOARD_DATA_DIR: dataDir,
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    FAKE_CLAUDE_SCENARIO: 'handoff-start',
    FAKE_GH_PRS: path.join(tmp, 'fake-gh-prs.json'),
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  if (tmp) await removeTempDir(tmp);
});

test('Parent pre-filled from the task: stacked preflight columns, Start cuts from origin/<parent> or origin/dev', async ({ page }) => {
  test.setTimeout(90_000);
  const alphaRefs = await alpha.refs();
  const betaRefs = await beta.refs();

  await openWithHub(page, `${server.baseUrl}/inbox`);
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal.getByTestId('ns-group').first()).toBeVisible();
  await modal.getByTestId('ns-name').fill('PROJ-3014 KPI events');
  await expect(modal.getByTestId('ns-branch')).toHaveValue(TASK);
  await modal.locator('[data-testid="ns-chip"][data-solution="alpha-front"]').click();
  await modal.locator('[data-testid="ns-chip"][data-solution="beta-front"]').click();

  const section = modal.locator('[data-section="branching"]');
  await expect(section).toBeVisible();
  // Empty = the epic branch (independent); the task text pre-fills the key.
  const parent = section.getByTestId('br-parent');
  await expect(parent).toHaveValue('');
  await section.getByTestId('br-epic-key').fill('PROJ-3010');
  await section.getByTestId('br-epic-summary').fill('Platform tracking and KPI delivery process development');
  await expect(parent).toHaveAttribute('placeholder', 'Epic branch (independent)');
  await modal.getByTestId('ns-task').fill('Add the KPI events. Create it from PROJ-3013.');
  await expect(parent).toHaveValue('PROJ-3013');
  await expect(parent).toHaveAttribute('data-derived', 'true');
  await expect(section.getByTestId('br-model')).toHaveText('epic/task · lazy · stacked');

  // The preflight: alpha-front has the parent (PR #306 open), beta-front falls back to origin/dev.
  const alphaRow = section.locator('[data-testid="br-row"][data-solution="alpha-front"]');
  const betaRow = section.locator('[data-testid="br-row"][data-solution="beta-front"]');
  await expect(alphaRow.getByTestId('br-cell-resolved')).toHaveText(`origin/${PARENT}`, { timeout: 20_000 });
  await expect(alphaRow.getByTestId('br-cell-target')).toHaveText(PARENT);
  await expect(alphaRow.getByTestId('br-cell-parent')).toHaveText('✓ PR #306 open');
  await expect(betaRow.getByTestId('br-cell-resolved')).toHaveText('origin/dev (epic not created yet; parent not in repo)');
  await expect(betaRow.getByTestId('br-cell-target')).toHaveText(`${EPIC} (epic, created lazily)`);
  await expect(betaRow.getByTestId('br-cell-parent')).toHaveText('— parent not in repo');
  await expect(modal.getByTestId('ns-start')).toBeEnabled();
  expect(await summary(modal)).toContain('parent    PROJ-3013 (stacked)');

  // Cleared by the developer: stays empty (the task text never overwrites it), the columns go.
  await parent.fill('');
  await modal.getByTestId('ns-task').fill('Add the KPI events. Stack on PROJ-3013.');
  await expect(parent).toHaveValue('');
  await expect(section.getByTestId('br-model')).toHaveText('epic/task · lazy');
  await expect(alphaRow.getByTestId('br-cell-resolved')).toHaveCount(0);
  // Typed again (lower case), tidied on blur.
  await parent.fill('proj-3013');
  await parent.blur();
  await expect(parent).toHaveValue('PROJ-3013');
  await expect(parent).toHaveAttribute('data-derived', 'false');
  await expect(alphaRow.getByTestId('br-cell-parent')).toHaveText('✓ PR #306 open', { timeout: 20_000 });

  const posted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions');
  await modal.getByTestId('ns-start').click();
  expect((await posted).postDataJSON()).toMatchObject({ branch: TASK, branching: { epic: { key: 'PROJ-3010', branch: EPIC }, base: 'dev', parent: 'PROJ-3013' } });
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('view-session')).toBeVisible();

  const alphaWorktree = path.join(workspace, 'microfrontends', `alpha-front-wt-${NAME}`);
  const betaWorktree = path.join(workspace, 'microfrontends', `beta-front-wt-${NAME}`);
  expect(await git(alphaWorktree, 'branch', '--show-current')).toBe(TASK);
  expect(await git(alphaWorktree, 'rev-parse', 'HEAD')).toBe(await git(alpha.repo, 'rev-parse', `refs/remotes/origin/${PARENT}`));
  expect(await git(betaWorktree, 'rev-parse', 'HEAD')).toBe(await git(beta.repo, 'rev-parse', 'refs/remotes/origin/dev'));
  expect(await alpha.refs()).toBe(alphaRefs);
  expect(await beta.refs()).toBe(betaRefs);

  const created = (await listSessions(page)).find((s) => s.name === NAME);
  const message = await firstMessage(page, created?.id ?? '');
  expect(message).toEqual(
    expect.arrayContaining([
      '- Branching model: epic/task (lazy), stacked',
      `  - Epic: PROJ-3010 — ${EPIC} (base: origin/dev)`,
      `  - Task branch: ${TASK}`,
      `  - Parent: ${PARENT} (stacked; PR #306 open)`,
      '  - Per-repo base / PR target:',
      `    - alpha-front: origin/${PARENT} → PR into ${PARENT}`,
      `    - beta-front: origin/dev (epic missing; parent not in repo) → PR into ${EPIC} (epic, created lazily)`,
      `  - microfrontends/alpha-front: ${alphaWorktree} (branch ${TASK}, from origin/${PARENT})`,
    ]),
  );
});
