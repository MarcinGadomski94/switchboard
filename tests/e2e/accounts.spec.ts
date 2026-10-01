import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Session, SessionEvent } from '../../src/core/api.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * D63 oracle (E2E, real path: `node src/server/main.ts` with the fake CLIs, a temp
 * data folder and a plain folder):
 * 1. Settings → Accounts: the Default is signed in (its own login); add a profile
 *    "Private"; Sign in opens a new tab on the fake's sign-in page, shows the
 *    progress and ends with the profile signed in (the CLI's status is the oracle).
 * 2. A session on the Default hits the fake's session limit: Switchboard moves it
 *    to Private by itself, the chat shows the divider, the session carries on on
 *    the other account; the Default reads as out of usage in Settings.
 * 3. The header shows the account, Switch account asks first, and the pin works.
 */

let tmp: string;
let server: ServerProcess;
let defaultDir: string;

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-accounts'));
  const folder = path.join(tmp, 'notes');
  defaultDir = path.join(tmp, 'claude-config');
  await mkdir(folder, { recursive: true });
  await mkdir(defaultDir, { recursive: true });
  await mkdir(path.join(tmp, 'codex-home'), { recursive: true });
  await mkdir(path.join(tmp, 'opencode-data'), { recursive: true });
  await writeFile(path.join(folder, 'todo.txt'), 'buy milk\n');
  // The Default is the developer's own login: signed in (the fake reads this marker).
  await writeFile(path.join(defaultDir, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email: 'default@example.test' }));
  const dataDir = path.join(tmp, 'data');
  await seedFolderInDataDir(dataDir, folder, { kind: 'plain' });
  server = await startServer({
    SWITCHBOARD_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: defaultDir,
    CODEX_HOME: path.join(tmp, 'codex-home'),
    XDG_DATA_HOME: path.join(tmp, 'opencode-data'),
    // A folder is signed out until the fake CLI logs it in; the login takes a moment (the progress is visible).
    FAKE_CLAUDE_AUTH_REQUIRED: '1',
    FAKE_CLAUDE_LOGIN_MS: '1500',
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  if (tmp) await removeTempDir(tmp);
});

async function sessions(page: import('@playwright/test').Page): Promise<Session[]> {
  return page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as Session[]);
}

async function events(page: import('@playwright/test').Page, id: string): Promise<SessionEvent[]> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${sessionId}/events`)).json()) as SessionEvent[], id);
}

test('Settings → Accounts: add a profile, sign in through a new tab; a session hits the limit and moves to the other account by itself', async ({ page, context }) => {
  // The fake's sign-in page (no network): the new tab's address is what matters.
  await context.route('https://login.fake-claude.example.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>fake sign-in</title>fake sign-in page' }));

  await page.goto(`${server.baseUrl}/settings/accounts`);
  await expect(page.getByTestId('settings-title')).toHaveText('Accounts');
  const claude = page.locator('[data-testid="accounts-cli"][data-cli="claude"]');
  const defaultCard = claude.locator('[data-testid="account-profile"][data-profile-id="default-claude"]');
  await expect(defaultCard.getByTestId('account-status')).toHaveText('signed in · default@example.test · max');
  await expect(defaultCard.getByTestId('account-builtin-note')).toBeVisible();
  // The Default is the developer's own login: no Sign in / Sign out / Delete here.
  await expect(defaultCard.getByTestId('account-signin')).toHaveCount(0);
  await expect(defaultCard.getByTestId('account-delete')).toHaveCount(0);

  // Add a profile.
  await claude.getByTestId('account-add-name').fill('Private');
  await claude.getByTestId('account-add-button').click();
  const privateCard = claude.locator('[data-testid="account-profile"][data-name="Private"]');
  await expect(privateCard).toBeVisible();
  await expect(privateCard.getByTestId('account-status')).toHaveText('signed out');
  await expect(privateCard.getByTestId('account-rank')).toHaveText('2');

  // Sign in: the tab opens on the page the CLI printed.
  await privateCard.getByTestId('account-signin').click();
  await privateCard.getByTestId('account-signin-email').fill('me@example.test');
  const popupPromise = context.waitForEvent('page');
  await privateCard.getByTestId('account-signin-start').click();
  const popup = await popupPromise;
  await popup.waitForURL(/^https:\/\/login\.fake-claude\.example\.test\/oauth\/authorize\?client=fake&state=/);
  await expect(privateCard.getByTestId('account-signin-status')).toHaveText('Finish the sign-in in the tab that opened. This page notices when it is done.');
  await expect(privateCard.getByTestId('account-signin-link')).toHaveAttribute('href', /^https:\/\/login\.fake-claude\.example\.test\//);
  await expect(privateCard.getByTestId('account-signin-command')).toContainText('claude auth login --claudeai');
  // The CLI finishes (the fake signs the folder in); the CLI's status says so.
  await expect(privateCard.getByTestId('account-signin-status')).toHaveText('Signed in.', { timeout: 20_000 });
  await expect(privateCard.getByTestId('account-status')).toHaveText('signed in · me@example.test · max');
  await privateCard.getByTestId('account-signin-cancel').click();
  await popup.close();

  // A session on the Default (picked on purpose).
  await page.goto(`${server.baseUrl}/inbox`);
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal).toHaveAttribute('data-mode', 'simple');
  await expect(modal.getByTestId('ns-account')).toHaveValue('');
  await modal.getByTestId('ns-account').selectOption({ label: 'Default' });
  await modal.getByTestId('ns-message').fill('first task');
  await modal.getByTestId('ns-start').click();
  const view = page.getByTestId('view-session');
  await expect(view).toBeVisible();
  const header = page.getByTestId('session-header');
  await expect(header.getByTestId('session-account-picker')).toHaveValue('default-claude');
  await expect(view.getByTestId('chat-message').filter({ hasText: 'OK' }).first()).toBeVisible();
  const session = (await sessions(page)).find((s) => s.profileId === 'default-claude');
  expect(session).toBeDefined();
  const id = (session as Session).id;

  // The Default hits its session limit: the next message fails with the CLI's limit text; Switchboard switches by itself.
  await writeFile(path.join(defaultDir, '.fake-limit'), "You've hit your session limit · resets 11:59pm");
  const composer = page.getByTestId('chat-input');
  await composer.fill('second task');
  await composer.press('Enter');
  await expect(view.getByTestId('chat-divider')).toHaveText(/^Switched account: Default → Private \(session limit, resets \d\d:\d\d\)$/, { timeout: 30_000 });
  await expect(header.getByTestId('session-account-picker')).toHaveValue(/^(?!default-claude$).+/);
  expect((await sessions(page)).find((s) => s.id === id)?.profileName).toBe('Private');
  // It carries on there: the interrupted turn is picked up and answered (a Switchboard bubble, then a reply after the divider).
  await expect(view.locator('[data-testid="chat-message"][data-origin="service"]').last()).toContainText('Continue where you left off');
  await expect
    .poll(async () => (await events(page, id)).filter((e) => (e.payload as { type?: string } | null)?.type === 'result' && !(e.payload as { isError?: boolean }).isError).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);

  // Settings shows the Default as out of usage until its reset.
  await page.goto(`${server.baseUrl}/settings/accounts`);
  await expect(defaultCard.getByTestId('account-spent')).toContainText('Out of usage until');
  await expect(defaultCard).toHaveAttribute('data-spent', 'true');
  await expect(privateCard.getByTestId('account-sessions')).toHaveText('1 session');
});

test('the header: Switch account asks first and moves the session back; the pin; ordering in Settings', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const list = await sessions(page);
  const session = list.find((s) => s.profileName === 'Private') as Session;
  expect(session).toBeDefined();
  await page.goto(`${server.baseUrl}/sessions/${session.id}`);
  const header = page.getByTestId('session-header');
  const pin = header.getByTestId('session-account-pin');
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await sessions(page)).find((s) => s.id === session.id)?.profilePinned).toBe(true);
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  // Switch account: asks first, then the divider.
  await header.getByTestId('session-account-picker').selectOption('default-claude');
  await expect(header.getByTestId('session-account-confirm')).toContainText('Switch this session from Private to Default?');
  await header.getByTestId('session-account-switch').click();
  await expect(page.getByTestId('chat-divider').last()).toHaveText('Switched account: Private → Default (switched by you)', { timeout: 30_000 });
  await expect(header.getByTestId('session-account-picker')).toHaveValue('default-claude');

  // Priority order: Private moves up; the order is stored.
  await page.goto(`${server.baseUrl}/settings/accounts`);
  const claude = page.locator('[data-testid="accounts-cli"][data-cli="claude"]');
  await claude.locator('[data-testid="account-profile"][data-name="Private"]').getByTestId('account-up').click();
  await expect(claude.locator('[data-testid="account-profile"]').first()).toHaveAttribute('data-name', 'Private');
  await expect(claude.locator('[data-testid="account-profile"]').first().getByTestId('account-rank')).toHaveText('1');
});
