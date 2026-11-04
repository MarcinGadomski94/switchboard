import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import type { TeamMember, TeamSummary, TeamView } from '../../src/core/team.ts';
import { makeTempDir } from '../helpers/net.ts';
import { type PeerNode, waitFor } from '../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, startWorkspaceSession, takeoverWorld } from '../helpers/takeover.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV, useV2 } from './v2-world.ts';

/**
 * D152 · a complete move in v2, on two real Switchboards (fake claude, temp repos, local
 * bare remotes): the agent's side panel says which repos it works in; the Move dialog
 * creates the workspace on the other computer where the developer says (a picked parent +
 * a typed name, the final path shown before Move, never applied by itself), uses an
 * existing checkout for one repo and clones the other, and lists the workspace's own files
 * (the secret one marked and unticked; copied only after confirming); and the crew page's
 * **Move crew to computer…** checks every teammate, shows a blocker, then moves the crew.
 */

let tmp: string;
let world: TakeoverWorld | null = null;
let contexts: BrowserContext[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-v2-complete-move');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  world = null;
  await removeWorld(tmp);
});

async function v2Page(browser: Browser, node: PeerNode, route: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  contexts.push(context);
  const page = await context.newPage();
  await stubToolProbes(page);
  await useV2(page);
  await page.goto(`${node.baseUrl}${route}`);
  return page;
}

test('Works in, the new workspace placed where the developer says, use or clone per repo, the files with the secret confirmed', async ({ browser }) => {
  test.setTimeout(180_000);
  const w = (world = await takeoverWorld(tmp, { aRepos: { workspace: true }, bRepos: { gamma: true }, env: { ...V2_SERVER_ENV } }));
  const ws = w.paths.a.workspace;
  await mkdir(path.join(ws, 'docs'), { recursive: true });
  await writeFile(path.join(ws, 'docs', 'plan.md'), '# Plan\n');
  await mkdir(path.join(ws, '.claude'), { recursive: true });
  await writeFile(path.join(ws, '.claude', 'settings.local.json'), '{ "env": { "ACME_TOKEN": "synthetic-e2e-token-0123456789" } }\n');
  const code = await realpath(path.dirname(w.paths.b.gamma));
  const frontOnMac = path.join(code, 'elsewhere', 'front');
  await mkdir(path.dirname(frontOnMac), { recursive: true });
  await w.git(path.dirname(frontOnMac), 'clone', '-q', w.remotes.front, frontOnMac);
  const session = await startWorkspaceSession(w.a, w.folders.a.workspace as string, 'ws-agent', ['front', 'back']);

  const page = await v2Page(browser, w.a, `/agents/${session.id}`);
  // The side panel: which repos it works in, with their paths.
  const worksIn = page.getByTestId('v2-agent-works-in');
  await expect(worksIn).toContainText('Works in · front, back');
  await expect(worksIn.locator('[data-testid="v2-agent-works-in-repo"][data-name="front"]')).toContainText(w.paths.a.front);

  await page.getByTestId('v2-agent-menu').click();
  await page.getByTestId('v2-agent-menu-list').getByRole('menuitem', { name: 'Move to computer…' }).click();
  const dialog = page.getByTestId('v2-move-dialog');
  await expect(dialog.getByTestId('v2-move-works-in')).toContainText(`front (${w.paths.a.front})`);
  const move = dialog.getByTestId('v2-move-start');
  await expect(move).toBeDisabled();

  // The workspace is not on the mac: create it. The parent is only suggested; nothing applies before "Create it here".
  const section = dialog.getByTestId('v2-move-workspace');
  await expect(section).toHaveAttribute('data-mode', 'new');
  const parent = dialog.getByTestId('v2-move-new-root-parent');
  await expect(parent).toHaveValue(code);
  await expect(dialog.getByTestId('v2-move-new-root-check')).toHaveCount(0);
  // Browse the mac's folders and pick the parent there.
  await dialog.getByTestId('v2-move-new-root-browse').click();
  await expect(dialog.getByTestId('v2-move-new-root-browser')).toContainText(code);
  await dialog.getByTestId('v2-move-new-root-pick').click();
  await dialog.getByTestId('v2-move-new-root-name').fill('clients-ws');
  const newWs = path.join(code, 'clients-ws');
  await expect(dialog.getByTestId('v2-move-new-root-asked')).toContainText(newWs);
  await dialog.getByTestId('v2-move-new-root-use').click();
  await expect(dialog.getByTestId('v2-move-new-root-final')).toHaveText(newWs);
  await expect(dialog.getByTestId('v2-move-new-root-check')).toContainText('Will create');

  // front: use the checkout that is there (another folder); back: cloned into its place.
  const front = dialog.locator('[data-testid="v2-move-repo"][data-key="front"]');
  const back = dialog.locator('[data-testid="v2-move-repo"][data-key="back"]');
  await expect(back).toHaveAttribute('data-action', 'clone');
  await expect(back.getByTestId('v2-move-clone-path')).toHaveValue(path.join(newWs, 'back'));
  await front.getByTestId('v2-move-repo-other').click();
  await front.getByTestId('v2-move-repo-override').fill(frontOnMac);
  await front.getByTestId('v2-move-repo-override').blur();
  await expect(front).toHaveAttribute('data-action', 'use');
  await expect(front.getByTestId('v2-move-repo-summary')).toContainText(`Use ${frontOnMac}`);

  // The workspace's own files: AGENTS.md required, the doc ticked, the secret marked and unticked.
  const files = dialog.getByTestId('v2-move-files');
  const agents = files.locator('[data-testid="v2-move-file"][data-name="AGENTS.md"]');
  const plan = files.locator('[data-testid="v2-move-file"][data-name="docs/plan.md"]');
  const secret = files.locator('[data-testid="v2-move-file"][data-name=".claude/settings.local.json"]');
  await expect(agents).toHaveAttribute('data-ticked', 'true');
  await expect(plan).toHaveAttribute('data-ticked', 'true');
  await expect(secret).toHaveAttribute('data-secret', 'true');
  await expect(secret).not.toHaveAttribute('data-ticked', 'true');
  await expect(move).toBeEnabled();
  // Ticking the secret asks for the confirmation first.
  await secret.getByRole('checkbox').check();
  await expect(dialog.getByTestId('v2-move-files-secret')).toBeVisible();
  await expect(dialog.getByTestId('v2-move-reason')).toContainText('looks like it holds secrets');
  await expect(move).toBeDisabled();
  await dialog.getByTestId('v2-move-files-confirm').check();
  await expect(move).toBeEnabled();
  await move.click();
  await expect(dialog.getByTestId('v2-move-headline')).toContainText('Moved', { timeout: 90_000 });

  expect(await readFile(path.join(newWs, 'docs', 'plan.md'), 'utf8')).toBe('# Plan\n');
  expect(await readFile(path.join(newWs, '.claude', 'settings.local.json'), 'utf8')).toContain('synthetic-e2e-token');
  expect(await w.git(path.join(newWs, 'back'), 'remote', 'get-url', 'origin')).toBe(w.remotes.back);
});

test('Move crew to computer: every teammate checked first (a blocker shown per teammate), then the crew moves one by one', async ({ browser }) => {
  test.setTimeout(180_000);
  const w = (world = await takeoverWorld(tmp, { aRepos: { alpha: true, gamma: true }, bRepos: { alpha: true, gamma: true }, env: { ...V2_SERVER_ENV } }));
  const team = (await w.a.call('POST', '/api/team/teams', { name: 'Ops' })).body as TeamSummary;
  const adopt = async (folder: string, name: string, role: string): Promise<string> => {
    const session = await startRepoSession(w.a, folder, name);
    const adopted = await w.a.call('POST', '/api/team/members', { sessionId: session.id, name: role, teamId: team.id });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    return (adopted.body as TeamMember).id;
  };
  const dev = await adopt(w.folders.a.alpha as string, 'ops-dev', 'Dev');
  const tester = await adopt(w.folders.a.gamma as string, 'ops-tester', 'Tester');
  // The mac's gamma has uncommitted work: Tester (a main-checkout session) cannot be restored there.
  await writeFile(path.join(w.paths.b.gamma, 'mac-work.txt'), 'in progress on the mac\n');

  const page = await v2Page(browser, w.a, `/crews/${team.id}`);
  await page.getByTestId('v2-crew-menu').click();
  await page.getByRole('menuitem', { name: 'Move crew to computer…' }).click();
  const dialog = page.getByTestId('v2-move-crew-computer');
  await dialog.getByTestId('v2-move-crew-option').filter({ hasText: 'mac-laptop' }).locator('input').check();
  const tMember = dialog.locator(`[data-testid="v2-move-crew-member"][data-member="${tester}"]`);
  const dMember = dialog.locator(`[data-testid="v2-move-crew-member"][data-member="${dev}"]`);
  await expect(tMember).toHaveAttribute('data-state', 'blocked', { timeout: 30_000 });
  await expect(dMember).toHaveAttribute('data-state', 'ready');
  await expect(tMember.getByTestId('v2-move-crew-blockers')).toContainText('has uncommitted changes on the target');
  await expect(dialog.getByTestId('v2-move-crew-go')).toBeDisabled();
  await expect(dialog.getByTestId('v2-move-crew-why')).toContainText('1 teammate cannot move yet');

  // Fixed on the mac: check again (pick the computer again), then move the crew.
  await rm(path.join(w.paths.b.gamma, 'mac-work.txt'));
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByTestId('v2-crew-menu').click();
  await page.getByRole('menuitem', { name: 'Move crew to computer…' }).click();
  await dialog.getByTestId('v2-move-crew-option').filter({ hasText: 'mac-laptop' }).locator('input').check();
  await expect(tMember).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await dialog.getByTestId('v2-move-crew-go').click();
  const result = dialog.getByTestId('v2-move-crew-result');
  await expect(result).toHaveAttribute('data-state', 'done', { timeout: 150_000 });
  await expect(result).toContainText('Moved Dev, Tester to mac-laptop.');
  await waitFor('both teammates on the mac', async () => {
    const view = (await w.a.call('GET', `/api/team?teamId=${team.id}`)).body as TeamView;
    return view.members.every((member) => member.machineId === w.bId) ? view : null;
  }, 30_000);
});
