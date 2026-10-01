import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeCodexBinEnv } from '../../tools/fake-codex/command.ts';
import { fakeOpencodeBinEnv } from '../../tools/fake-opencode/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * D62 oracle (E2E, real path: `node src/server/main.ts` with fake-claude,
 * fake-codex and fake-opencode as the CLIs, a temp data folder and a plain
 * folder; no demo seed):
 * 1. Settings → CLIs lists Claude Code, Codex CLI and OpenCode, each installed
 *    and signed in; a Codex command override to a missing program reads "Not
 *    installed" with the install help, and Reset brings it back.
 * 2. The Simple form's CLI row offers the three; Codex's models follow the CLI;
 *    a Codex session starts, its reply streams into the chat, and its tool step
 *    shows like Claude Code's.
 * 3. A second server whose Codex is signed out lists it disabled ("signed out").
 */

let tmp: string;
let folder: string;
let server: ServerProcess;

async function listSessions(page: Page): Promise<Session[]> {
  return page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as Session[]);
}

async function openSimple(page: Page): Promise<Locator> {
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute('data-mode', 'simple');
  return modal;
}

function env(dataDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    SWITCHBOARD_DATA_DIR: dataDir,
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_CODEX_BIN: fakeCodexBinEnv(),
    SWITCHBOARD_OPENCODE_BIN: fakeOpencodeBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    CODEX_HOME: path.join(tmp, 'codex-home'),
    XDG_DATA_HOME: path.join(tmp, 'opencode-data'),
    ...extra,
  };
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-cli-providers'));
  folder = path.join(tmp, 'notes');
  await mkdir(folder, { recursive: true });
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  await mkdir(path.join(tmp, 'codex-home'), { recursive: true });
  await mkdir(path.join(tmp, 'opencode-data'), { recursive: true });
  await writeFile(path.join(folder, 'todo.txt'), 'buy milk\n');
  const dataDir = path.join(tmp, 'data');
  await seedFolderInDataDir(dataDir, folder, { kind: 'plain' });
  server = await startServer(env(dataDir));
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  if (tmp) await removeTempDir(tmp);
});

test('Settings → CLIs: the three CLIs with their state; a missing Codex reads "Not installed" with the install help; Reset', async ({ page }) => {
  await page.goto(`${server.baseUrl}/settings/clis`);
  await expect(page.getByTestId('settings-title')).toHaveText('CLIs');
  const cards = page.getByTestId('settings-cli');
  await expect(cards).toHaveCount(3);
  await expect(cards.locator('.sb-set-cli-name')).toHaveText(['Claude Code', 'Codex CLI', 'OpenCode']);
  const codex = page.locator('[data-testid="settings-cli"][data-provider="codex"]');
  await expect(codex.getByTestId('settings-cli-state')).toHaveText('✓ codex-cli 0.159.3 · signed in (Logged in using ChatGPT)');
  await expect(page.locator('[data-testid="settings-cli"][data-provider="opencode"]').getByTestId('settings-cli-state')).toHaveText('✓ 1.18.34 · signed in (1 credential)');
  // Claude Code's command is the environment's (no field).
  await expect(page.locator('[data-testid="settings-cli"][data-provider="claude"]').getByTestId('settings-cli-command')).toHaveCount(0);
  await expect(page.getByTestId('settings-cli-default')).toHaveValue('claude');

  await codex.getByTestId('settings-cli-command').fill(path.join(tmp, 'no-such-codex'));
  await codex.getByTestId('settings-cli-save').click();
  await expect(codex).toHaveAttribute('data-installed', 'false');
  await expect(codex.getByTestId('settings-cli-state')).toHaveText('Not installed');
  await expect(codex.getByTestId('settings-cli-install')).toContainText('npm install -g @openai/codex');
  await expect(codex.getByTestId('settings-cli-install').getByRole('link', { name: 'Install instructions' })).toHaveAttribute('href', /^https:\/\/github\.com\/openai\/codex/);
  // It cannot be the default while it is missing.
  await expect(page.locator('[data-testid="settings-cli-default"] option[value="codex"]')).toBeDisabled();
  await codex.getByTestId('settings-cli-reset').click();
  await expect(codex).toHaveAttribute('data-installed', 'true');
  await expect(codex.getByTestId('settings-cli-state')).toHaveText('✓ codex-cli 0.159.3 · signed in (Logged in using ChatGPT)');
});

test('the Simple form starts a Codex session: the CLI row, its own models, the reply and a tool step in the chat', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const modal = await openSimple(page);
  const cli = modal.getByTestId('ns-cli');
  await expect(cli.locator('option')).toHaveText(['Claude Code', 'Codex CLI', 'OpenCode']);
  await expect(cli).toHaveValue('claude');
  await cli.selectOption('codex');
  // Codex's own models (read from `codex app-server` → model/list when its status was checked), not Claude Code's aliases.
  await modal.getByTestId('ns-model-button').click();
  await expect(modal.locator('[data-testid="model-option"]')).toHaveCount(3);
  expect(await modal.locator('[data-testid="model-option"]').evaluateAll((options) => options.map((option) => option.getAttribute('data-value')))).toEqual(['default', 'gpt-5.5-codex', 'gpt-5.5-mini']);
  await page.keyboard.press('Escape');
  await modal.getByTestId('ns-message').fill('[fake:cmd git status] check the tree');
  await modal.getByTestId('ns-start').click();
  await expect(page.getByTestId('view-session')).toBeVisible();
  const session = (await listSessions(page)).find((entry) => entry.provider === 'codex');
  expect(session).toBeDefined();
  const chat = page.getByTestId('view-session');
  await expect(chat.getByText('OK', { exact: true })).toBeVisible();
  await expect(chat.getByText('git status').first()).toBeVisible();
  // The models Codex reported are offered from now on.
  await expect
    .poll(async () => page.evaluate(async () => ((await (await fetch('/api/models?provider=codex')).json()) as { options: Array<{ value: string }> | null }).options?.map((option) => option.value) ?? null))
    .toEqual(['default', 'gpt-5.5-codex', 'gpt-5.5-mini']);
});

test('an OpenCode session from the Simple form: its models (provider/model), the reply in the chat', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const modal = await openSimple(page);
  await modal.getByTestId('ns-cli').selectOption('opencode');
  await modal.getByTestId('ns-model-button').click();
  await expect(modal.locator('[data-testid="model-option"]')).toHaveCount(3);
  expect(await modal.locator('[data-testid="model-option"]').evaluateAll((options) => options.map((option) => option.getAttribute('data-value')))).toEqual(['default', 'anthropic/claude-sonnet-5', 'openai/gpt-5.5']);
  await page.keyboard.press('Escape');
  await modal.getByTestId('ns-message').fill('[fake:say "Hello from **OpenCode**"]');
  await modal.getByTestId('ns-start').click();
  const view = page.getByTestId('view-session');
  await expect(view).toBeVisible();
  await expect(view.locator('strong', { hasText: 'OpenCode' })).toBeVisible();
  expect((await listSessions(page)).some((entry) => entry.provider === 'opencode')).toBe(true);
});

test('a signed-out Codex is listed but cannot be chosen, with the reason', async ({ page }) => {
  const dataDir = path.join(tmp, 'data-2');
  await seedFolderInDataDir(dataDir, folder, { kind: 'plain' });
  const second = await startServer(env(dataDir, { FAKE_CODEX_SIGNED_OUT: '1' }));
  try {
    await page.goto(`${second.baseUrl}/inbox`);
    const modal = await openSimple(page);
    const option = modal.locator('[data-testid="ns-cli"] option[value="codex"]');
    await expect(option).toHaveText('Codex CLI (signed out)');
    await expect(option).toBeDisabled();
    await expect(option).toHaveAttribute('title', /^Codex CLI is signed out: Run `codex login`/);
  } finally {
    expect(await second.stop()).toBe(0);
  }
});
