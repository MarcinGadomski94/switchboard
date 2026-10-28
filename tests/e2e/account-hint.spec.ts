import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import type { AccountProfile } from '../../src/core/accounts.ts';
import type { InboxItem } from '../../src/core/api.ts';
import { THEME_STORAGE_KEY } from '../../src/web/theme.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, waitFor } from '../helpers/peers.ts';
import { useV2 } from './v2-world.ts';

/**
 * D142 (`docs/accounts.md` → *One account here, more on a paired machine*): two real
 * Switchboards paired on loopback (D48 test world, fake CLIs, never a real login). A has
 * one Claude Code account, B the same one plus Lab. A raises "A can't switch Claude Code
 * accounts"; on B it is in the merged queue with A's name, and **Add it there** opens
 * Settings › Accounts with A picked in the Machine picker and the Add form prefilled with
 * "Lab": v2 (Needs you → Advanced › Accounts: every option) and classic (Inbox → Settings →
 * Accounts). A's own Settings shows the line with **Add it here**.
 */

let tmp: string;
let nodes: PeerNode[] = [];
let contexts: BrowserContext[] = [];
let a: PeerNode;
let b: PeerNode;
let aId = '';
let aName = '';
let bName = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-account-hint');
  await signedIn(path.join(tmp, 'a', 'claude-config'), 'dev@example.com');
  await signedIn(path.join(tmp, 'b', 'claude-config'), 'dev@example.com');
  const paired = await pairedNodes(tmp);
  a = paired.a;
  b = paired.b;
  aId = paired.aId;
  nodes.push(a, b);
  aName = (await machineOn(b, aId))?.name as string;
  bName = (await machineOn(a, paired.bId))?.name as string;
  // B signs in a second account A does not have.
  const created = await b.call('POST', '/api/accounts/profiles', { cli: 'claude', name: 'Lab' });
  expect(created.status).toBe(201);
  await signedIn((created.body as AccountProfile).dir as string, 'lab@example.com');
  expect((await b.call('POST', `/api/accounts/profiles/${(created.body as AccountProfile).id}/check`)).status).toBe(200);
  // A's item has reached B's merged queue.
  await waitFor('B shows A\'s item', async () => ((await b.call('GET', '/api/inbox')).body as InboxItem[]).some((item) => item.systemKind === 'account-hint' && item.machine?.id === aId), 30_000);
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
});

test.afterAll(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function signedIn(dir: string, email: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email }));
}

async function newPage(browser: import('@playwright/test').Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  contexts.push(context);
  return context.newPage();
}

const title = (): string => `${aName} can't switch Claude Code accounts`;

test('v2: the paired computer\'s item in Needs you with its name; Add it there → Advanced › Accounts with that computer picked and the name prefilled', async ({ browser }) => {
  const page = await newPage(browser);
  await useV2(page);
  await page.goto(`${b.baseUrl}/needs-you`);
  const card = page.getByTestId('v2-needs-list').locator('.v2-qi').filter({ hasText: title() });
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await expect(card).toContainText(`It has only one account signed in (Default). 1 more is signed in on ${bName} (Lab).`);
  await expect(card.getByTestId('v2-computer-tag')).toContainText(aName);
  await expect(card.getByRole('button', { name: 'Dismiss' })).toBeVisible();

  await card.getByRole('button', { name: 'Add it there' }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/advanced/accounts\\?machine=${aId}&add=claude&name=Lab$`));
  await expect(page.getByTestId('accounts-machine')).toHaveValue(aId);
  const claude = page.locator('[data-testid="accounts-cli"][data-cli="claude"]');
  await expect(claude.getByTestId('account-add-name')).toHaveValue('Lab');
  await expect(claude.getByTestId('account-add-name')).toBeFocused();
  // A's own line, through the Machine picker.
  await expect(claude.getByTestId('account-hint-text')).toHaveText(`${aName} has only one account signed in (Default). 1 more is signed in on ${bName} (Lab): add it here so agents switch when one runs out.`);
  // The item stays open (a link, not an answer).
  expect(((await b.call('GET', '/api/inbox')).body as InboxItem[]).some((item) => item.systemKind === 'account-hint')).toBe(true);
});

test('classic: the Inbox item with the machine\'s name; Add it there → Settings → Accounts on that machine with the name prefilled; A\'s own Settings line with Add it here', async ({ browser }) => {
  const page = await newPage(browser);
  await page.addInitScript((key: string) => window.localStorage.setItem(key, 'classic'), THEME_STORAGE_KEY);
  await page.goto(`${b.baseUrl}/inbox`);
  const row = page.getByTestId('inbox-item').filter({ hasText: title() });
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toContainText(aName);
  await expect(row).toContainText('Accounts');
  await row.click();
  const detail = page.getByTestId('inbox-detail');
  await expect(detail.getByTestId('inbox-machine')).toContainText(aName);
  await detail.locator('[data-testid="inbox-action"][data-action="add-account"]').click();
  await expect(page).toHaveURL(new RegExp(`/settings/accounts\\?machine=${aId}&add=claude&name=Lab$`));
  await expect(page.getByTestId('accounts-machine')).toHaveValue(aId);
  const claude = page.locator('[data-testid="accounts-cli"][data-cli="claude"]');
  await expect(claude.getByTestId('account-add-name')).toHaveValue('Lab');

  // A's own Settings → Accounts: the line, and Add it here prefills the form.
  const own = await newPage(browser);
  await own.addInitScript((key: string) => window.localStorage.setItem(key, 'classic'), THEME_STORAGE_KEY);
  await own.goto(`${a.baseUrl}/settings/accounts`);
  const mine = own.locator('[data-testid="accounts-cli"][data-cli="claude"]');
  await expect(mine.getByTestId('account-hint-text')).toHaveText(`${aName} has only one account signed in (Default). 1 more is signed in on ${bName} (Lab): add it here so agents switch when one runs out.`, { timeout: 30_000 });
  await expect(mine.getByTestId('account-add-name')).toHaveValue('');
  await mine.getByTestId('account-hint-add').click();
  await expect(mine.getByTestId('account-add-name')).toHaveValue('Lab');
  // Codex has no identity: no line there.
  await expect(own.locator('[data-testid="accounts-cli"][data-cli="codex"]').getByTestId('account-hint')).toHaveCount(0);
});
