import { readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { parseSemVer } from '../../src/core/semver.ts';
import { TOKEN_FILE } from '../../src/server/token.ts';
import { fakeNpmBinEnv } from '../../tools/fake-npm/command.ts';
import { fakeServiceCtlEnv } from '../../tools/fake-servicectl/command.ts';
import { type FakeGitHub, apiRelease, releaseAssets, startFakeGitHub } from '../helpers/fake-github.ts';
import { REPO_ROOT, freeTestPorts, makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, startPeerNode, waitFor } from '../helpers/peers.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D140 "Update Switchboard remotely" (`docs/updates.md` → *Remote updates*), on
 * real servers with fakes only: a fake GitHub on loopback, tools/fake-npm (slowed
 * so the progress can be seen), the login service in a temp home driven by
 * tools/fake-servicectl and the test switch that makes B "the login service"
 * (nothing real is registered, started or restarted).
 *
 * - v2 Settings › Computers on A: B's card shows its version and "Update
 *   available", Update → the confirm (B's name, the version, the agents running
 *   there) → the progress → B exits for its restart → "Restarting… reconnects
 *   when it's back" → B is back online.
 * - Classic Settings → Machines on A: B's row with its version, Update… → the
 *   inline confirm → B restarts.
 * - A phone (390×844) paired with a computer: classic Settings → Updates →
 *   Update… → the confirm names the computer → it restarts.
 */

const RUNNING = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const OFFERED = ((): string => {
  const running = parseSemVer(RUNNING);
  if (!running) throw new Error(`package.json version "${RUNNING}" is not semver`);
  return `${running.major}.${running.minor + 1}.0`;
})();

let tmp: string;
let github: FakeGitHub;
let nodes: PeerNode[] = [];

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
  tmp = await makeTempDir('e2e-remote-update');
  const [port] = await freeTestPorts();
  github = await startFakeGitHub(port !== undefined ? { port } : {});
  const assets = path.join(tmp, 'assets');
  await mkdir(assets);
  github.state.status = 200;
  github.state.release = apiRelease(OFFERED);
  github.state.assets = await releaseAssets(assets, OFFERED);
});

test.afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await github.close();
  await removeTempDir(tmp);
});

/** A release install that runs as its (fake) login service and checks the fake GitHub; `npm ci` takes 1.5 s. */
function updaterEnv(label: string): Record<string, string> {
  return {
    SWITCHBOARD_UPDATES: 'on',
    SWITCHBOARD_UPDATE_API: github.origin,
    SWITCHBOARD_UPDATE_REPO: github.repo,
    SWITCHBOARD_UPDATE_TEST_INSTALL: 'release',
    SWITCHBOARD_UPDATE_TEST_UNDER_SERVICE: '1',
    SWITCHBOARD_NPM_BIN: fakeNpmBinEnv(),
    FAKE_NPM_DELAY_MS: '1500',
    SWITCHBOARD_SERVICE_HOME: path.join(tmp, label, 'home'),
    SWITCHBOARD_SERVICE_CTL: fakeServiceCtlEnv(),
    FAKE_SERVICECTL_LOG: path.join(tmp, label, 'servicectl.log'),
    // A test run from inside a launchd job inherits its label: never let that make a node "the login service".
    XPC_SERVICE_NAME: '',
  };
}

async function twoComputers(ui: Record<string, string>): Promise<{ a: PeerNode; b: PeerNode; bId: string; bName: string }> {
  const { a, b, bId } = await pairedNodes(tmp, ui, { b: updaterEnv('b') });
  nodes.push(a, b);
  const bName = (await b.call('GET', '/api/machines')).body.self.name as string;
  await waitFor('B\'s update state on A', async () => (await machineOn(a, bId))?.update?.available === true);
  return { a, b, bId, bName };
}

test('v2 Settings › Computers: Update a paired computer with a confirm, follow the progress, see it restart and come back', async ({ page }) => {
  test.setTimeout(120_000);
  const { a, b, bId, bName } = await twoComputers(V2_SERVER_ENV);
  await page.goto(`${a.baseUrl}/settings/computers`);
  const card = page.locator(`[data-testid="v2-computer"][data-machine-id="${bId}"]`);
  await expect(card.getByTestId('v2-computer-version')).toHaveText(`Switchboard ${RUNNING}`);
  await expect(card.getByTestId('v2-computer-update-available')).toHaveText(`Update available: ${OFFERED}`);
  await expect(card.getByTestId('v2-computer-update-check')).toBeVisible();

  await card.getByTestId('v2-computer-update-button').click();
  const confirm = page.getByTestId('v2-computer-update-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(`Update ${bName} to ${OFFERED}?`);
  await expect(confirm).toContainText('It restarts Switchboard there; running agents resume after the restart.');
  await expect(page.getByTestId('v2-computer-update-agents')).toHaveText('No agents are running there.');
  await page.getByTestId('v2-computer-update-confirm-button').click();

  // The progress, live from B (npm ci is slowed to 1.5 s).
  await expect(card.getByTestId('v2-computer-update-progress')).toHaveText('Installing dependencies (npm ci --omit=dev)…', { timeout: 20_000 });
  // B asks its (fake) login service for the restart and exits.
  expect(await b.server.closed).toBe(0);
  await expect(card.getByTestId('v2-computer-update-restarting')).toHaveText('Restarting… reconnects when it’s back', { timeout: 20_000 });

  // B comes back (this checkout again: the fake package cannot run), and the card shows it online with its version.
  const again = await startPeerNode(tmp, 'b', { env: { ...V2_SERVER_ENV, ...updaterEnv('b') } });
  nodes.push(again);
  await expect(card).toHaveAttribute('data-state', 'online', { timeout: 30_000 });
  await expect(card.getByTestId('v2-computer-version')).toHaveText(`Switchboard ${RUNNING}`);
  await expect(card.getByTestId('v2-computer-update-restarting')).toHaveCount(0);
});

test('v2 Needs you: a paired computer\'s "is available" item offers Update, which asks first', async ({ page }) => {
  test.setTimeout(90_000);
  const { a, bId, bName } = await twoComputers(V2_SERVER_ENV);
  await page.goto(`${a.baseUrl}/needs-you`);
  const update = page.locator('.v2-qi button[data-action="update-computer"]').first();
  await expect(update).toBeVisible({ timeout: 20_000 });
  await update.click();
  await expect(page).toHaveURL(`${a.baseUrl}/settings/computers`);
  await expect(page.getByTestId('v2-computer-update-confirm')).toContainText(`Update ${bName} to ${OFFERED}?`);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator(`[data-testid="v2-computer"][data-machine-id="${bId}"]`).getByTestId('v2-computer-update-button')).toBeVisible();
});

test('classic Settings → Machines: a paired machine\'s row shows its version and updates it after an inline confirm', async ({ page }) => {
  test.setTimeout(120_000);
  const { a, b, bId, bName } = await twoComputers({});
  await page.goto(`${a.baseUrl}/settings/machines`);
  const row = page.locator(`[data-testid="machine"][data-machine-id="${bId}"]`);
  await expect(row.getByTestId('machine-update-text')).toHaveText(`Switchboard ${RUNNING} · Update available: ${OFFERED}`);
  await expect(row.getByTestId('machine-update-check')).toBeVisible();
  await row.getByTestId('machine-update-button').click();
  await expect(row.getByTestId('machine-update-confirm')).toContainText(`Update ${bName} to ${OFFERED}? It restarts Switchboard there; running agents resume after the restart.`);
  await row.getByTestId('machine-update-confirm-button').click();
  await expect(row.getByTestId('machine-update-progress')).toBeVisible({ timeout: 20_000 });
  expect(await b.server.closed).toBe(0);
  await expect(row.getByTestId('machine-update-text')).toContainText('Restarting… reconnects when it\'s back', { timeout: 20_000 });
});

/** Pairs a 390×844 phone with `node` (its device listener on `devicePort`) through the pairing page; returns its page. */
async function pairPhone(page: Page, node: PeerNode, devicePort: number): Promise<void> {
  const code = await node.call('POST', '/api/devices/pairing');
  expect(code.status).toBe(200);
  await page.goto(`http://localhost:${devicePort}/pair#code=${code.body.code as string}`);
  await page.getByTestId('pair-name').fill('Pixel 9');
  await page.getByTestId('pair-submit').click();
  await page.waitForURL(`http://localhost:${devicePort}/`);
}

test('a phone (390×844): Settings → Updates updates the computer it is paired with, after a confirm that names it', async ({ browser }) => {
  test.setTimeout(90_000);
  const free = await freeTestPorts();
  const devicePort = free.at(-1) as number;
  const node = await startPeerNode(tmp, 'solo', { env: { ...updaterEnv('solo'), SWITCHBOARD_DEVICE_TEST_ORIGIN: `http://localhost:${devicePort}` } });
  nodes.push(node);
  expect((await node.call('PUT', '/api/devices/access', { enabled: true, port: devicePort })).status).toBe(200);
  const name = (await node.call('GET', '/api/machines')).body.self.name as string;
  await waitFor('a newer release found', async () => (await node.call('GET', '/api/updates')).body.available === true);
  expect((await readFile(path.join(node.dataDir, TOKEN_FILE), 'utf8')).length).toBeGreaterThan(0);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  try {
    const phone = await context.newPage();
    await stubToolProbes(phone);
    await pairPhone(phone, node, devicePort);
    await phone.goto(`http://localhost:${devicePort}/settings/updates`);
    await expect(phone.getByTestId('updates-update')).toHaveText(`Update to ${OFFERED}…`);
    await expect(phone.getByTestId('updates-remote-blocked')).toHaveCount(0);
    await phone.getByTestId('updates-update').tap();
    const confirm = phone.getByTestId('update-confirm');
    await expect(confirm).toContainText(`Update ${name} to ${OFFERED}?`);
    await expect(confirm).toContainText('running agents resume after the restart');
    await phone.getByTestId('update-confirm-button').tap();
    expect(await node.server.closed).toBe(0);
    expect(await readFile(path.join(node.dataDir, 'logs', 'update.log'), 'utf8')).toContain(`update to ${OFFERED} asked for from your phone (Pixel 9)`);
  } finally {
    await context.close();
  }
});
