import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D61 UI oracle (E2E, real path, fake-claude, a temp HOME and CLAUDE_CONFIG_DIR):
 * open /mcp from the nav, see the folder's servers grouped by scope with secrets
 * masked, Check one, Add a stdio server, Edit it (the env value kept server-side),
 * Disable / Enable it, Remove it (confirmed), and sign in to an HTTP server (the
 * fake's authorization page opens in a new tab and completes the sign-in).
 */

let tmp: string;
let home: string;
let project: string;
let server: ServerProcess;

const SECRET_ENV = 'k3yVALUE';
const SECRET_HEADER = 'hdrSECRET';

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-mcp'));
  home = path.join(tmp, 'home');
  project = path.join(tmp, 'project');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(home, '.claude', '.claude.json'),
    JSON.stringify({
      mcpServers: { acme: { type: 'stdio', command: 'npx', args: ['acme-mcp'], env: { API_KEY: SECRET_ENV } } },
      projects: { [project]: { mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${SECRET_HEADER}` } } } } },
    }),
  );
  await seedFolderInDataDir(path.join(tmp, 'data'), project, { kind: 'repo' });
  server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    FAKE_CLAUDE_LOG: path.join(tmp, 'fake.log'),
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  if (tmp) await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

test('the MCP page: list per folder, check, add, edit, disable / enable, remove, sign in', async ({ page, context }) => {
  await page.goto(`${server.baseUrl}/`);
  await page.getByTestId('nav-mcp').click();
  await expect(page).toHaveURL(`${server.baseUrl}/mcp`);
  const view = page.getByTestId('view-mcp');
  await expect(view.getByTestId('mcp-folder-path')).toHaveText(project);
  await expect(view.getByTestId('mcp-group')).toHaveCount(2);
  await expect(view.getByTestId('mcp-group').first()).toHaveAttribute('data-scope', 'local');
  const acme = view.locator('[data-testid="mcp-server"][data-name="acme"]');
  const docs = view.locator('[data-testid="mcp-server"][data-name="docs"]');
  await expect(acme.getByTestId('mcp-target')).toHaveText('npx acme-mcp');
  await expect(acme).toContainText('env API_KEY');
  await expect(docs).toContainText('headers Authorization');
  await expect(acme).toHaveAttribute('data-status', 'unchecked');
  expect(await page.content()).not.toContain(SECRET_ENV);
  expect(await page.content()).not.toContain(SECRET_HEADER);

  // Check one: `claude mcp get acme` in the folder.
  await acme.getByTestId('mcp-check').click();
  await expect(acme).toHaveAttribute('data-status', 'connected');
  await expect(acme.getByTestId('mcp-checked')).toContainText('checked');
  await expect(view.getByTestId('mcp-command')).toHaveText('claude mcp get acme');

  // Check all: the helper's mcp_status (tools counted).
  await view.getByTestId('mcp-check-all').click();
  await expect(acme.getByTestId('mcp-tools')).toHaveText('3 tools');
  await expect(docs).toHaveAttribute('data-status', 'needs-auth');

  // Add a stdio server (user scope) with a secret env value.
  await view.getByTestId('mcp-add').click();
  const form = view.getByTestId('mcp-form');
  await form.getByTestId('mcp-form-name').fill('bad name');
  await form.getByTestId('mcp-form-save').click();
  await expect(form.getByTestId('mcp-form-error-name')).toContainText('Names can only contain letters, numbers, hyphens, and underscores.');
  await form.getByTestId('mcp-form-name').fill('files');
  await form.getByTestId('mcp-form-scope').selectOption('project');
  await expect(form.getByTestId('mcp-form-project-note')).toContainText('.mcp.json');
  await form.getByTestId('mcp-form-scope').selectOption('user');
  await form.getByTestId('mcp-form-command').fill('npx');
  await form.getByTestId('mcp-form-args').fill('files-mcp\n--verbose');
  await form.getByTestId('mcp-form-env-add').click();
  await form.getByLabel('Environment name').fill('FILES_TOKEN');
  await form.getByLabel('Environment value').fill('s3cretTOKEN');
  await form.getByTestId('mcp-form-save').click();
  await expect(form).toHaveCount(0);
  const files = view.locator('[data-testid="mcp-server"][data-name="files"]');
  await expect(files.getByTestId('mcp-target')).toHaveText('npx files-mcp --verbose');
  await expect(view.getByTestId('mcp-restart-note')).toBeVisible();
  await expect(view.getByTestId('mcp-command')).toContainText(`claude mcp add-json files '{"type":"stdio","command":"npx","args":["files-mcp","--verbose"],"env":{"FILES_TOKEN":"••••"}}' --scope user`);
  expect(await page.content()).not.toContain('s3cretTOKEN');

  // Edit: the env value is a kept placeholder; change the args only.
  await files.getByTestId('mcp-edit').click();
  await expect(form.getByLabel('Environment value')).toHaveAttribute('placeholder', '•••• unchanged');
  await expect(form.getByLabel('Environment value')).toHaveValue('');
  await form.getByTestId('mcp-form-args').fill('files-mcp');
  await form.getByTestId('mcp-form-save').click();
  await expect(form).toHaveCount(0);
  await expect(files.getByTestId('mcp-target')).toHaveText('npx files-mcp');
  const stored = JSON.parse(await readFile(path.join(home, '.claude', '.claude.json'), 'utf8')) as { mcpServers: Record<string, { env?: Record<string, string> }> };
  expect(stored.mcpServers['files']?.env).toEqual({ FILES_TOKEN: 's3cretTOKEN' });

  // Disable / Enable for this folder (mcp_toggle).
  await files.getByTestId('mcp-toggle').click();
  await expect(files).toHaveAttribute('data-status', 'disabled');
  await expect(files.getByTestId('mcp-toggle')).toHaveText('Enable');
  await files.getByTestId('mcp-toggle').click();
  await expect(files).toHaveAttribute('data-status', 'connected');

  // Remove, confirmed.
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('claude mcp remove files --scope user');
    void dialog.accept();
  });
  await files.getByTestId('mcp-remove').click();
  await expect(files).toHaveCount(0);

  // Sign in to the HTTP server: the fake's authorization page opens in a new tab and completes.
  const popup = context.waitForEvent('page');
  await docs.getByTestId('mcp-auth').click();
  const tab = await popup;
  await expect(tab.locator('body')).toContainText('Authentication successful', { timeout: 15_000 });
  await expect(view.getByTestId('mcp-auth-done')).toBeVisible({ timeout: 15_000 });
  await expect(docs).toHaveAttribute('data-status', 'connected');
  await tab.close();
});
