import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
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
import { rememberNewSessionModeInDataDir } from '../helpers/new-session-mode.ts';

/**
 * D40 oracle (E2E, real path, no demo seed, D13): the New-session form's
 * **Branching** section. `node src/server/main.ts` with fake-claude, fake gh, a
 * temp data folder and a fixture workspace whose repos are cloned from **local
 * bare origins** (never a real remote): `microfrontends/alpha-front` (origin:
 * master, dev) and `microfrontends/beta-front` (origin: master only). With an
 * epic typed, the form shows the derived epic branch and, after the automatic
 * preflight, a row per repo: alpha-front's `origin/dev` present, beta-front's
 * missing with **Drop from task** / **Use other base**. Start waits for a
 * choice; after Drop it creates alpha-front's worktree on the task branch cut
 * from `origin/dev` (none for beta-front), nothing is pushed, and the first
 * message carries the Branching lines.
 */
const EPIC = 'feature/PROJ-3010-Platform-tracking-and-KPI-delivery-process-development';
const TASK = 'PROJ-3011-kpi-dashboard';
const NAME = 'proj-3011-kpi-dashboard';

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

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function listSessions(page: Page): Promise<Session[]> {
  return page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as Session[]);
}

/** The session's first user message as the agent got it (the task + the answers block). */
async function firstMessage(page: Page, id: string): Promise<string[]> {
  const events = (await page.evaluate(async (sid) => (await fetch(`/api/sessions/${sid}/events`)).json(), id)) as Array<{ payload: { type?: string; text?: string } }>;
  return (events.find((event) => event.payload.type === 'user')?.payload.text ?? '').split('\n');
}

async function summary(modal: Locator): Promise<string[]> {
  return modal.getByTestId('ns-summary-line').allTextContents();
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-branching'));
  workspace = path.join(tmp, 'work space');
  const gitConfig = path.join(tmp, 'gitconfig');
  const dataDir = path.join(tmp, 'data');
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  await writeFile(gitConfig, '');
  await writeFile(path.join(tmp, 'fake-gh-prs.json'), '{}');
  gitEnv = {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Switchboard Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  alpha = await makeOriginRepo(git, tmp, path.join(workspace, 'microfrontends', 'alpha-front'), [['dev', 'master']]);
  beta = await makeOriginRepo(git, tmp, path.join(workspace, 'microfrontends', 'beta-front'));
  await seedFolderInDataDir(dataDir, workspace);
  // D56: this spec exercises the Full New-session form (Simple is the fresh-install default).
  await rememberNewSessionModeInDataDir(dataDir, 'full');
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

test('an epic: the derived epic branch, the preflight table, Drop from task, Start cuts the worktree from origin/dev', async ({ page }) => {
  test.setTimeout(90_000);
  // Someone moves dev on origin after the clone: the worktree must come from the fetched origin/dev.
  const devTip = await alpha.push('dev', 'dev-2.txt', 'two\n');
  const alphaRefs = await alpha.refs();
  const betaRefs = await beta.refs();

  await openWithHub(page, `${server.baseUrl}/inbox`);
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal.getByTestId('ns-group').first()).toBeVisible();
  await modal.getByTestId('ns-name').fill('PROJ-3011 KPI dashboard');
  await modal.getByTestId('ns-task').fill('Build the KPI dashboard.');
  await expect(modal.getByTestId('ns-branch')).toHaveValue(TASK);
  await modal.locator('[data-testid="ns-chip"][data-solution="alpha-front"]').click();
  await modal.locator('[data-testid="ns-chip"][data-solution="beta-front"]').click();

  // The Branching section: no epic yet → task only; the creation policy is read-only.
  const section = modal.locator('[data-section="branching"]');
  await expect(section).toBeVisible();
  await expect(section.getByTestId('br-model')).toHaveText('task only · no epic');
  await expect(section.getByTestId('br-creation')).toHaveText('Creation: lazy: on first code change');
  await section.getByTestId('br-epic-key').fill('PROJ-3010');
  await section.getByTestId('br-epic-summary').fill('Platform tracking and KPI delivery process development');
  await expect(section.getByTestId('br-epic-branch')).toHaveValue(EPIC);
  await expect(section.getByTestId('br-epic-base')).toHaveValue('dev');
  await expect(section.getByTestId('br-model')).toHaveText('epic/task · lazy');

  // The preflight runs by itself: alpha-front has origin/dev, beta-front does not.
  const rows = section.getByTestId('br-row');
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  const alphaRow = section.locator('[data-testid="br-row"][data-solution="alpha-front"]');
  const betaRow = section.locator('[data-testid="br-row"][data-solution="beta-front"]');
  await expect(alphaRow.getByTestId('br-cell-base')).toHaveText('✓ origin/dev');
  await expect(alphaRow.getByTestId('br-cell-epic')).toHaveText('— not on origin (cut lazily)');
  await expect(alphaRow.getByTestId('br-cell-task')).toHaveText('— new');
  // Ruling D47-columns: the PR target shows for every branching session (here the epic, not on origin yet).
  await expect(alphaRow.getByTestId('br-cell-target')).toHaveText(`${EPIC} (epic, created lazily)`);
  await expect(alphaRow.getByTestId('br-cell-resolved')).toHaveCount(0);
  await expect(betaRow.getByTestId('br-cell-base')).toContainText('⚠ no origin/dev');
  await expect(betaRow.getByTestId('br-drop')).toBeVisible();
  await expect(betaRow.getByTestId('br-other-base')).toBeVisible();
  await expect(modal.getByTestId('ns-start')).toBeDisabled();
  expect(await summary(modal)).toContain('⚠ beta-front: origin/dev is missing: drop it or use another base');

  // Drop beta-front: Start is enabled, the summary says so.
  await betaRow.getByTestId('br-drop').click();
  await expect(betaRow).toHaveAttribute('data-dropped', 'true');
  await expect(modal.getByTestId('ns-start')).toBeEnabled();
  const lines = await summary(modal);
  expect(lines).toEqual(expect.arrayContaining([`branch    ${TASK}`, `epic      ${EPIC}`, 'base      origin/dev', 'dropped   beta-front', `../alpha-front-wt-${NAME}`]));
  expect(lines).not.toContain(`../beta-front-wt-${NAME}`);

  const posted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions');
  await modal.getByTestId('ns-start').click();
  expect((await posted).postDataJSON()).toMatchObject({
    solutions: ['alpha-front', 'beta-front'],
    branch: TASK,
    branching: { epic: { key: 'PROJ-3010', summary: 'Platform tracking and KPI delivery process development', branch: EPIC }, base: 'dev', dropped: ['beta-front'] },
  });
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('view-session')).toBeVisible();

  // The worktree: on the task branch, from the fetched origin/dev; none for beta-front; nothing pushed.
  const worktree = path.join(workspace, 'microfrontends', `alpha-front-wt-${NAME}`);
  expect(await git(worktree, 'branch', '--show-current')).toBe(TASK);
  expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(devTip);
  expect(await exists(path.join(workspace, 'microfrontends', `beta-front-wt-${NAME}`))).toBe(false);
  expect(await beta.refs()).toBe(betaRefs);
  expect(await alpha.refs()).toBe(alphaRefs);
  const created = (await listSessions(page)).find((s) => s.name === NAME);
  expect(created?.solutions).toEqual(['alpha-front']);

  const message = await firstMessage(page, created?.id ?? '');
  expect(message).toEqual(
    expect.arrayContaining([
      '- Solutions in scope: microfrontends/alpha-front',
      '- Branching model: epic/task (lazy)',
      `- Epic: PROJ-3010 · ${EPIC} (base: origin/dev)`,
      `- Task branch: ${TASK} (base: ${EPIC})`,
      '- Rule: create and push the epic + task branches with `git push -u origin <same name>` only in a repo at its first code change; cut the epic from the current `origin/dev` when it is missing on origin; never create either branch in repos that are not changed',
      '- Dropped repos (no base branch): microfrontends/beta-front',
      `  - microfrontends/alpha-front: ${worktree} (branch ${TASK}, from origin/dev)`,
    ]),
  );
});
