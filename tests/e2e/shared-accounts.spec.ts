import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type BrowserContext, expect, test } from '@playwright/test';
import type { AccountProfile } from '../../src/core/accounts.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes } from '../helpers/peers.ts';

/**
 * D98 (`docs/accounts.md` → *Shared across paired machines*): two real Switchboards
 * on loopback test ports (D48 test world, fake CLIs) signed in to the same Claude
 * Code account. On B the footer's usage grid shows that account once, labelled
 * with both machines, plus A's other account labelled with A; Settings → Accounts
 * says the account is shared, lists A's other account under "On other machines",
 * and a rename on B is the name on A.
 */

let tmp: string;
let nodes: PeerNode[] = [];
let contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-shared-accounts');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function signedIn(dir: string, email: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email }));
}

test('the same account on two paired machines is one footer line with both machines; Settings shows it shared, the other machine\'s account, and a rename goes across', async ({ browser }) => {
  await signedIn(path.join(tmp, 'a', 'claude-config'), 'dev@example.com');
  await signedIn(path.join(tmp, 'b', 'claude-config'), 'dev@example.com');
  const { a, b, aId, bId } = await pairedNodes(tmp);
  nodes.push(a, b);
  const aName = (await machineOn(b, aId))?.name as string;
  const bName = (await machineOn(a, bId))?.name as string;
  // A has a second account, signed in to another login.
  const created = await a.call('POST', '/api/accounts/profiles', { cli: 'claude', name: 'Lab' });
  expect(created.status).toBe(201);
  await signedIn((created.body as AccountProfile).dir as string, 'lab@example.com');
  expect((await a.call('POST', `/api/accounts/profiles/${(created.body as AccountProfile).id}/check`)).status).toBe(200);

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${b.baseUrl}/settings/accounts`);

  // The footer: B's Default (the same account as A's) once, on both machines; A's Lab on A.
  const lines = page.getByTestId('usage-line');
  await expect(lines).toHaveCount(2, { timeout: 30_000 });
  await expect(lines.nth(0)).toHaveAttribute('data-machines', `${bName} + ${aName}`);
  await expect(lines.nth(0).getByTestId('usage-machines')).toHaveText(` · ${bName} + ${aName}`);
  await expect(lines.nth(0).locator('.sb-usage-label')).toContainText('Default');
  await expect(lines.nth(1)).toHaveAttribute('data-machines', aName);
  await expect(lines.nth(1).locator('.sb-usage-label')).toContainText('Lab');
  await expect(lines.nth(1)).toHaveAttribute('data-account', `r~${aId}~${(created.body as AccountProfile).id}`);

  // Settings → Accounts: the shared line on B's Default, A's Lab under "On other machines".
  await page.reload();
  const claude = page.locator('[data-testid="accounts-cli"][data-cli="claude"]');
  const mine = claude.locator('[data-testid="account-profile"][data-profile-id="default-claude"]');
  await expect(mine.getByTestId('account-machines')).toHaveText(`Same account on ${bName} + ${aName} · its name, order and usage are shared`);
  const peer = claude.getByTestId('account-peer');
  await expect(peer).toHaveCount(1);
  await expect(peer.getByTestId('account-peer-name')).toHaveText('Lab');
  await expect(peer.getByTestId('account-peer-account')).toHaveText(`lab@example.com · max · on ${aName}`);

  // A rename here is the account's name on A too.
  const name = mine.getByTestId('account-name');
  await name.fill('Acme');
  await name.press('Enter');
  await expect.poll(async () => ((await a.call('GET', '/api/accounts')).body as { profiles: AccountProfile[] }).profiles.find((p) => p.id === 'default-claude')?.name, { timeout: 15_000 }).toBe('Acme');

  // Manage opens A's accounts in the Machine picker.
  await peer.getByTestId('account-peer-manage').click();
  await expect(page.getByTestId('accounts-machine')).toHaveValue(aId);
  await expect(claude.locator('[data-testid="account-profile"][data-name="Lab"]')).toBeVisible();
});
