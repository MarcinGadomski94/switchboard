import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { UNDO_LAST_TURN_LABEL, revertDivider, redoDivider } from '../../src/core/checkpoints.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { openWithHub } from './question-world.ts';

/**
 * D80 oracle, real path (no demo seed): `node src/server/main.ts` with fake-claude,
 * whose `[fake:write <file>]` really writes into the session's repo. The turn action
 * beside a user bubble opens the confirmation listing the files that change; Revert
 * restores the files, the chat gets the divider "Reverted to before turn N" with
 * Redo, the agent's next message carries the note; Redo brings the files back; the
 * header's *Undo last turn* reverts the newest turn; a folder that is no git repo
 * says why there is nothing to revert; on a phone the action shows without hover
 * and the dialog fits. Screenshots go to `/tmp/lane-c-shots/`.
 */

const SHOTS = '/tmp/lane-c-shots';

let tmp: string;
let repo: string;
let plain: string;
let server: ServerProcess;
let gitEnv: Record<string, string>;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...gitEnv } });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('undo'));
  repo = path.join(tmp, 'shop-front');
  plain = path.join(tmp, 'notes');
  await mkdir(repo, { recursive: true });
  await mkdir(plain, { recursive: true });
  await mkdir(SHOTS, { recursive: true });
  await writeFile(path.join(tmp, 'gitconfig'), '[gc]\n\tauto = 0\n');
  gitEnv = {
    GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Switchboard Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'README.md'), 'hello\n');
  await writeFile(path.join(repo, '.gitignore'), '*.log\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'init');
  const data = path.join(tmp, 'data');
  await seedFolderInDataDir(data, repo, { kind: 'repo', isDefault: true });
  await seedFolderInDataDir(data, plain, { kind: 'plain' });
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  server = await startServer({ ...gitEnv, SWITCHBOARD_DATA_DIR: data, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config') });
});

test.afterAll(async () => {
  try {
    if (server) expect(await server.stop()).toBe(0);
  } finally {
    await removeTempDir(tmp);
  }
});

async function startSession(page: Page, name: string, task: string, folder?: string): Promise<string> {
  const result = await page.evaluate(
    async (body) => {
      const folders = (await (await fetch('/api/folders')).json()) as Array<{ id: string; path: string }>;
      const folderId = body.folder ? folders.find((f) => f.path === body.folder)?.id : undefined;
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          body.folder
            ? // D59: a plain folder takes simple starts only.
              { simple: true, name: body.name, task: body.task, worktrees: false, ...(folderId ? { folder: folderId } : {}) }
            : {
          name: body.name,
          task: body.task,
          workType: 'feature',
          mode: 'single',
          solutions: ['shop-front'],
          phase: 'ui-first',
          coordination: 'none',
          qa: null,
          worktrees: false,
          ultracode: false,
        }),
      });
      return { status: response.status, body: (await response.json()) as { id: string } };
    },
    { name, task, folder: folder ?? null },
  );
  expect(result.status).toBe(201);
  return result.body.id;
}

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as SessionDetail, id);
}

async function waitIdle(page: Page, id: string): Promise<void> {
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toMatch(/^(done|idle)$/);
}

function userMessage(page: Page, text: string): Locator {
  return page.getByTestId('session-chat').locator('[data-testid="chat-message"][data-role="user"]').filter({ hasText: text });
}

async function exists(file: string): Promise<boolean> {
  return readFile(file).then(
    () => true,
    () => false,
  );
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-input').press('Enter');
}

test('the turn action opens the confirmation; Revert restores the files with a divider and Redo; the note goes with the next message', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  const id = await startSession(page, 'undo-chat', '[fake:write first.txt] Write the first file.');
  await openWithHub(page, `${server.baseUrl}/sessions/${id}`);
  await waitIdle(page, id);
  await send(page, '[fake:write second.txt] Write the second file.');
  await expect.poll(() => exists(path.join(repo, 'second.txt')), { timeout: 15_000 }).toBe(true);
  await waitIdle(page, id);
  await writeFile(path.join(repo, 'debug.log'), 'ignored, the agent wrote it\n');

  // The action beside the first bubble (hover shows it).
  const first = userMessage(page, 'Write the first file.');
  const action = first.getByTestId('chat-revert');
  await expect(action).toHaveAttribute('data-turn', '1');
  await first.hover();
  await expect(action).toHaveCSS('opacity', '1');
  await expect(action).toHaveAttribute('title', 'Revert to before this turn (turn 1)');
  await page.getByTestId('session-chat').screenshot({ path: path.join(SHOTS, 'turn-action.png') });

  await action.click();
  const dialog = page.getByTestId('revert-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('revert-title')).toHaveText('Revert to before turn 1?');
  await expect(page.getByTestId('revert-quote')).toHaveText('[fake:write first.txt] Write the first file.');
  await expect(page.getByTestId('revert-text')).toContainText('the changes of turns 1..2 are undone');
  await expect(dialog.getByTestId('revert-file')).toHaveText(['−first.txt', '−second.txt']);
  await expect(dialog.getByTestId('revert-file-count')).toHaveText('2 files');
  await expect(page.getByTestId('revert-cancel')).toBeFocused();
  await page.screenshot({ path: path.join(SHOTS, 'confirm-dialog.png') });

  // Esc cancels: nothing changed.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await exists(path.join(repo, 'first.txt'))).toBe(true);

  await first.hover();
  await action.click();
  await page.getByTestId('revert-confirm').click();
  await expect(dialog).toHaveCount(0);
  const divider = page.getByTestId('chat-divider').filter({ hasText: revertDivider(1) });
  await expect(divider).toBeVisible();
  await expect(divider.getByTestId('chat-redo')).toHaveText('Redo');
  expect(await exists(path.join(repo, 'first.txt'))).toBe(false);
  expect(await exists(path.join(repo, 'second.txt'))).toBe(false);
  expect(await readFile(path.join(repo, 'debug.log'), 'utf8')).toBe('ignored, the agent wrote it\n');
  // The conversation stays.
  await expect(userMessage(page, 'Write the second file.')).toBeVisible();
  await divider.scrollIntoViewIfNeeded();
  await page.getByTestId('session-chat').screenshot({ path: path.join(SHOTS, 'divider.png') });

  // Redo: the files are back; the divider of the Redo; no Redo button any more.
  await divider.getByTestId('chat-redo').click();
  await expect(page.getByTestId('chat-divider').filter({ hasText: redoDivider(1) })).toBeVisible();
  await expect(page.getByTestId('chat-redo')).toHaveCount(0);
  expect(await exists(path.join(repo, 'first.txt'))).toBe(true);
  expect(await exists(path.join(repo, 'second.txt'))).toBe(true);

  // Ruling 2026-10-08 (int-header-overflow): no Undo in the desktop header row; the sidebar row's ⋯ menu has it: the newest turn (2).
  await expect(page.getByTestId('session-undo-turn')).toHaveCount(0);
  const row = page.locator(`a.sb-session[data-session-id="${id}"]`);
  await row.hover();
  await row.getByTestId('sidebar-session-menu').click();
  const undo = page.getByTestId('sidebar-menu').getByTestId('sidebar-menu-undo-turn');
  await expect(undo).toHaveText(UNDO_LAST_TURN_LABEL);
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(page.getByTestId('revert-title')).toHaveText('Revert to before turn 2?');
  await expect(dialog.getByTestId('revert-file')).toHaveText(['−second.txt']);
  await page.getByTestId('revert-confirm').click();
  await expect(page.getByTestId('chat-divider').filter({ hasText: revertDivider(2) })).toBeVisible();
  expect(await exists(path.join(repo, 'second.txt'))).toBe(false);
  expect(await exists(path.join(repo, 'first.txt'))).toBe(true);

  // The next message carries the note (the agent is told); Redo goes.
  await send(page, 'What changed?');
  await expect(userMessage(page, 'What changed?')).toContainText('Switchboard reverted the files to before turn 2');
  await expect(page.getByTestId('chat-redo')).toHaveCount(0);
  await waitIdle(page, id);
});

test('a folder that is no git repository: the action is disabled and says why', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  const id = await startSession(page, 'undo-plain', 'Hello there.', plain);
  await openWithHub(page, `${server.baseUrl}/sessions/${id}`);
  await waitIdle(page, id);
  const action = userMessage(page, 'Hello there.').getByTestId('chat-revert');
  await expect(action).toHaveAttribute('data-disabled', 'true');
  await expect(action).toHaveAttribute('title', /not a git repository/);
  await action.click({ force: true });
  await expect(page.getByTestId('revert-dialog')).toHaveCount(0);
  // Never in the desktop header row (ruling int-header-overflow); the row's ⋯ menu has it, disabled, saying why (ruling D80-q1).
  await expect(page.getByTestId('session-undo-turn')).toHaveCount(0);
  const row = page.locator(`a.sb-session[data-session-id="${id}"]`);
  await row.hover();
  await row.getByTestId('sidebar-session-menu').click();
  const undo = page.getByTestId('sidebar-menu').getByTestId('sidebar-menu-undo-turn');
  await expect(undo).toHaveText(UNDO_LAST_TURN_LABEL);
  await expect(undo).toBeDisabled();
  await expect(undo).toHaveAttribute('title', /not a git repository/);
});

test('the sidebar row ⋯ menu: Undo last turn opens the confirmation for the newest turn', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  const id = await startSession(page, 'undo-menu', '[fake:write menu.txt] Write from the menu.');
  await openWithHub(page, `${server.baseUrl}/sessions/${id}`);
  await waitIdle(page, id);
  const row = page.locator(`a.sb-session[data-session-id="${id}"]`);
  await row.hover();
  await row.getByTestId('sidebar-session-menu').click();
  const undo = page.getByTestId('sidebar-menu').getByTestId('sidebar-menu-undo-turn');
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(page.getByTestId('revert-title')).toHaveText('Revert to before turn 1?');
  await page.getByTestId('revert-confirm').click();
  await expect(page.getByTestId('chat-divider').filter({ hasText: revertDivider(1) })).toBeVisible();
  expect(await exists(path.join(repo, 'menu.txt'))).toBe(false);
});

test('a phone: the action shows without hover, Undo last turn sits in the ⋯ menu, the dialog fits the screen', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await page.goto(`${server.baseUrl}/`);
    const id = await startSession(page, 'undo-phone', '[fake:write phone.txt] Write from the phone.');
    await openWithHub(page, `${server.baseUrl}/sessions/${id}`);
    await waitIdle(page, id);
    const action = userMessage(page, 'Write from the phone.').getByTestId('chat-revert');
    await expect(action).toHaveCSS('opacity', '0.55');
    await page.getByTestId('session-more').click();
    await expect(page.getByTestId('session-undo-turn')).toBeVisible();
    await page.getByTestId('session-undo-turn').click();
    const dialog = page.getByTestId('revert-dialog');
    await expect(dialog.getByTestId('revert-file')).toHaveText(['−phone.txt']);
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: path.join(SHOTS, 'confirm-dialog-phone.png') });
    await page.getByTestId('revert-confirm').tap();
    await expect(page.getByTestId('chat-divider').filter({ hasText: revertDivider(1) })).toBeVisible();
    expect(await exists(path.join(repo, 'phone.txt'))).toBe(false);
  } finally {
    await context.close();
  }
});
