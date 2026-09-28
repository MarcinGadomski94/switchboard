import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { HistoryItem, Session } from '../../src/core/api.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D25 oracle (E2E, real path, no demo): **From a remote session**.
 * `node src/server/main.ts` with fake-claude as the CLI (its `--teleport`,
 * docs/fake-claude.md → *Teleport*), fake gh, a temp git repo saved as the default
 * (repo) folder next to a saved workspace, nothing else. Through the UI:
 * 1. New session → From a remote session: only the repo folder is offered (with
 *    the hint), a claude.ai/code URL goes in, the summary names `session_<X>` and
 *    the new worktree → Start → the local copy opens: the remote history in the
 *    chat, the header's "local copy" note, `remote · local copy` in the sidebar;
 *    one message is an ordinary turn; Pause / Resume resumes the local id in the
 *    worktree; History tags it.
 * 2. With a CLI that refuses (a second server, FAKE_CLAUDE_TELEPORT=wrong-repo):
 *    the refusal shows in the form verbatim and no worktree, branch or session is left.
 */
test.describe.configure({ mode: 'serial' });

const X = '011CUe2eRemote42';
const ID = `session_${X}`;
const URL_PASTED = `https://claude.ai/code/${ID}?from=cli&m=0`;
const TITLE = 'Remote 011CUe2e';
const NAME = 'remote-011cue2e';
const NOTE = "Local copy of a remote session: new work here stays local and doesn't appear in the cloud session.";

let tmp: string;
let repo: string;
let gitEnv: Record<string, string>;
let server: ServerProcess;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...gitEnv } });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
  return result.stdout.trim();
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function sessions(page: Page): Promise<Session[]> {
  return page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as Session[]);
}

/** The cwd and argv of every fake-claude session process, teleport or resume (`log`: its FAKE_CLAUDE_LOG). */
async function fakeRuns(log: string): Promise<Array<{ cwd: string; argv: string[] }>> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind?: string; cwd?: string; argv?: string[] })
    // Session processes only (the usage meter's own `claude -p` has neither flag).
    .filter((entry) => entry.kind === 'argv' && (entry.argv?.includes('--teleport') || entry.argv?.includes('--resume')))
    .map((entry) => ({ cwd: entry.cwd ?? '', argv: entry.argv ?? [] }));
}

/** A server over its own data folder: the repo (default) and a workspace saved, fake CLIs, the fake's env on top. */
async function serverFor(name: string, fakeEnv: Record<string, string> = {}): Promise<{ server: ServerProcess; log: string }> {
  const data = path.join(tmp, `data-${name}`);
  const workspace = path.join(tmp, `workspace-${name}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'AGENTS.md'), await readFile(path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md'), 'utf8'));
  await seedFolderInDataDir(data, repo, { kind: 'repo', isDefault: true });
  await seedFolderInDataDir(data, workspace, { kind: 'workspace' });
  const log = path.join(tmp, `fake-${name}.log`);
  const started = await startServer({
    ...gitEnv,
    ...fakeEnv,
    SWITCHBOARD_DATA_DIR: data,
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    FAKE_GH_PRS: path.join(tmp, 'fake-gh-prs.json'),
    FAKE_CLAUDE_LOG: log,
  });
  return { server: started, log };
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-teleport'));
  repo = path.join(tmp, 'app-repo');
  const gitConfig = path.join(tmp, 'gitconfig');
  await writeFile(gitConfig, '');
  gitEnv = {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Switchboard Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'README.md'), 'hello\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'init');
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  await writeFile(path.join(tmp, 'fake-gh-prs.json'), '{}');
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  if (tmp) await removeTempDir(tmp);
});

test('a CLI refusal shows in the form verbatim and leaves no worktree, branch or session', async ({ page }) => {
  test.setTimeout(60_000);
  const refusing = await serverFor('refused', { FAKE_CLAUDE_TELEPORT: 'wrong-repo' });
  try {
    await stubToolProbes(page);
    await page.goto(refusing.server.baseUrl);
    await page.getByTestId('new-session').click();
    const modal = page.getByTestId('modal-new-session');
    await modal.getByTestId('ns-remote').click();
    await modal.getByTestId('ns-remote-input').fill(ID);
    await modal.getByTestId('ns-start').click();
    await expect(modal.getByTestId('ns-error')).toHaveText(`Not started: You must run claude --teleport ${ID} from a checkout of acme/app`);
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('ns-start')).toHaveText('Start session');
    expect(await sessions(page)).toEqual([]);
    expect(await exists(path.join(tmp, `app-repo-wt-${NAME}`))).toBe(false);
    expect(await git(repo, 'branch', '--list', `session/${NAME}`)).toBe('');
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain('-wt-');
    // Editing the form clears the line.
    await modal.getByTestId('ns-remote-input').fill(`${ID}9`);
    await expect(modal.getByTestId('ns-error')).toHaveCount(0);
  } finally {
    expect(await refusing.server.stop()).toBe(0);
  }
});

test('pull a remote session into the repo: its history, the local-copy note, one turn, pause and resume, History', async ({ page }) => {
  test.setTimeout(120_000);
  const started = await serverFor('main');
  server = started.server;
  await stubToolProbes(page);
  await page.goto(server.baseUrl);

  // 1. The option: only the repo folder, the hint, the remote field in the task's place, the router sections gone.
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal.getByTestId('ns-folder').locator('option')).toHaveText(['app-repo (default)', 'workspace-main']);
  const toggle = modal.getByTestId('ns-remote');
  await expect(toggle).toHaveText('⇣ From a remote session');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(modal.getByTestId('ns-folder').locator('option')).toHaveText(['app-repo (default)']);
  await expect(modal.getByTestId('ns-remote-hint')).toHaveText('Only git repo folders: a remote session continues in a checkout of its GitHub repository.');
  await expect(modal.getByTestId('ns-task')).toHaveCount(0);
  await expect(modal.getByTestId('ns-section')).toHaveCount(2);
  await expect(modal.getByTestId('ns-remote-note')).toBeVisible();
  await expect(modal.getByTestId('ns-start')).toBeDisabled();

  await modal.getByTestId('ns-remote-input').fill(URL_PASTED);
  const worktree = path.join(tmp, `app-repo-wt-${NAME}`);
  await expect(modal.getByTestId('ns-summary-line')).toHaveText([
    '# claude code · background · Max',
    'folder    app-repo · git repo',
    `remote    ${ID}`,
    `cwd       ${worktree}`,
    `name      ${NAME}`,
    ' ',
    '# worktree · claude checks out its branch',
    `../app-repo-wt-${NAME}`,
    ' ',
    '✓ local copy · history · idle',
  ]);
  await expect(modal.getByTestId('ns-start')).toBeEnabled();
  await modal.getByTestId('ns-start').click();
  await expect(modal).toHaveCount(0);

  // 2. The local copy: its title, its worktree, the note with the remote session's link, the remote history in the chat.
  await expect(page.getByTestId('session-name')).toHaveText(TITLE);
  await expect(page.getByTestId('session-root')).toHaveText(`${worktree} · worktree of app-repo`);
  await expect(page.getByTestId('session-remote-copy-note')).toContainText(NOTE);
  await expect(page.getByTestId('session-remote-copy-link')).toHaveText(ID);
  await expect(page.getByTestId('session-remote-copy-link')).toHaveAttribute('href', `https://claude.ai/code/${ID}`);
  const chat = page.getByTestId('session-chat');
  await expect(chat.getByTestId('chat-text')).toHaveText([
    'Remote history 1: add a /health endpoint to the API.',
    'Remote reply 1: added GET /health, which answers { ok: true }, and a test for it.',
    'Remote history 2: push the branch.',
    `Remote reply 2: pushed claude/${ID}.`,
  ]);
  await expect(chat.locator('[data-role="user"]')).toHaveCount(2);
  await expect(chat.locator('[data-role="user"][data-origin="remote"]')).toHaveCount(2);
  await expect(page.getByTestId('sidebar-sessions')).toContainText('remote · local copy');
  const session = (await sessions(page)).find((listed) => listed.name === NAME);
  expect(session).toMatchObject({ remoteSource: ID, cwd: worktree, folderKind: 'repo', status: 'idle', live: true });
  expect(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`claude/${ID}`);
  const [first] = await fakeRuns(started.log);
  expect(first?.cwd).toBe(worktree);
  expect(first?.argv).toContain('--teleport');
  expect(first?.argv[first.argv.indexOf('--teleport') + 1]).toBe(ID);
  expect(first?.argv).not.toContain('--session-id');

  // 3. One message: an ordinary turn of the local copy.
  await page.getByTestId('chat-input').fill('Reply with just OK.');
  await page.getByTestId('chat-send').click();
  await expect(chat.getByTestId('chat-text')).toHaveText([
    'Remote history 1: add a /health endpoint to the API.',
    'Remote reply 1: added GET /health, which answers { ok: true }, and a test for it.',
    'Remote history 2: push the branch.',
    `Remote reply 2: pushed claude/${ID}.`,
    'Reply with just OK.',
    'OK',
  ]);
  await expect.poll(async () => (await sessions(page)).find((listed) => listed.name === NAME)?.status, { timeout: 15_000 }).toBe('done');

  // 4. Pause / Resume: the local id, --resume, in the worktree.
  const pause = page.getByTestId('session-pause');
  await expect(pause).toHaveText('Pause');
  await pause.click();
  await expect(pause).toHaveText('Resume');
  await pause.click();
  await expect(pause).toHaveText('Pause');
  await expect.poll(async () => (await fakeRuns(started.log)).length).toBe(2);
  const [, resumed] = await fakeRuns(started.log);
  expect(resumed?.cwd).toBe(worktree);
  expect(resumed?.argv[resumed.argv.indexOf('--resume') + 1]).toBe(session?.claudeSessionId);
  expect(resumed?.argv).not.toContain('--teleport');
  await expect.poll(async () => (await sessions(page)).find((listed) => listed.name === NAME)?.status, { timeout: 15_000 }).toMatch(/^(done|run)$/);
  await expect(page.getByTestId('session-remote-copy-note')).toContainText(NOTE);

  // 5. History: tagged like the sidebar, the note as the tag's tooltip.
  await page.getByTestId('nav-history').click();
  const row = page.getByTestId('history-row').filter({ hasText: TITLE });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.sb-hist-mode')).toHaveText('remote · local copy');
  await expect(row.locator('.sb-hist-mode')).toHaveAttribute('title', NOTE);
  const items = await page.evaluate(async () => (await (await fetch('/api/history')).json()) as HistoryItem[]);
  expect(items.find((item) => item.sessionId === session?.id)).toMatchObject({ mode: 'remote · local copy' });
});
