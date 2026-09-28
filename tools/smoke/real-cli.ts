/**
 * D13 real-CLI smoke (docs/decisions.md → D13 check 2, within D11). A manual tool,
 * never part of `npm test` (tests never call the real `claude`):
 *
 *   npm run build && node tools/smoke/real-cli.ts
 *
 * It starts the built app on 127.0.0.1:$SMOKE_PORT (default 4975) with a fixture
 * workspace under `.spike/sandbox/real-cli-smoke/` (gitignored; one git repo,
 * `microfrontends/smoke-front`), the **real** `claude` limited to Haiku and 3 turns
 * (`SWITCHBOARD_CLAUDE_EXTRA_ARGS`), fake gh, and a temp data dir. Through the UI it
 * starts one session whose harmless prompt asks one AskUserQuestion, answers it in
 * the Inbox, waits for the reply, and prints a JSON report. The real CLI writes its
 * transcript under `~/.claude/projects/` (accepted by D11).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import type { Session, SessionDetail } from '../../src/core/api.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeGhBinEnv } from '../fake-gh/command.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const PORT = Number(process.env['SMOKE_PORT'] ?? 4975);
const BASE = `http://127.0.0.1:${PORT}`;
const CLAUDE = process.env['SMOKE_CLAUDE_BIN'] ?? path.join(os.homedir(), '.local', 'bin', 'claude');
const SANDBOX = path.join(REPO, '.spike', 'sandbox', 'real-cli-smoke');
const WORKSPACE = path.join(SANDBOX, 'workspace');
const SOLUTION = path.join(WORKSPACE, 'microfrontends', 'smoke-front');
const NAME = 'real-cli-smoke';
const TASK =
  'Use the AskUserQuestion tool exactly once to ask me one question, "Which color do you prefer?", ' +
  'with exactly two options, "Red" and "Blue". After I answer, reply with only the color I picked. ' +
  'Do not use any other tool and do not change any file.';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function git(...args: string[]): Promise<void> {
  const result = await runCommand(['git'], args, {
    cwd: SOLUTION,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Smoke', GIT_AUTHOR_EMAIL: 'smoke@example.invalid', GIT_COMMITTER_NAME: 'Smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid' },
  });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')}: ${failureText(result)}`);
}

async function main(): Promise<void> {
  await rm(SANDBOX, { recursive: true, force: true });
  await mkdir(SOLUTION, { recursive: true });
  await writeFile(path.join(SOLUTION, 'README.md'), 'smoke\n');
  await git('init', '-q', '-b', 'main');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');

  const server: ChildProcess = spawn(process.execPath, ['src/server/main.ts'], {
    cwd: REPO,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SWITCHBOARD_PORT: String(PORT),
      SWITCHBOARD_DATA_DIR: path.join(SANDBOX, 'data'),
      SWITCHBOARD_WORKSPACE_ROOT: WORKSPACE,
      SWITCHBOARD_CLAUDE_BIN: JSON.stringify([CLAUDE]),
      SWITCHBOARD_CLAUDE_EXTRA_ARGS: JSON.stringify(['--model', 'haiku', '--max-turns', '3']),
      SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
      SWITCHBOARD_SETUP_WIZARD: 'off',
    },
  });
  let log = '';
  server.stdout?.on('data', (chunk) => (log += chunk));
  server.stderr?.on('data', (chunk) => (log += chunk));
  const started = Date.now();
  const report: Record<string, unknown> = { port: PORT, claude: CLAUDE, workspace: WORKSPACE };
  const browser = await chromium.launch();
  try {
    await until('the server', async () => (await fetch(`${BASE}/`).catch(() => null))?.ok, 20_000);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${BASE}/inbox`);
    const api = async <T>(url: string): Promise<T> => page.evaluate(async (u) => (await (await fetch(u)).json()) as T, url);

    // New session from the modal (edits in place: the prompt changes nothing).
    await page.getByTestId('new-session').click();
    const modal = page.getByTestId('modal-new-session');
    await modal.getByTestId('ns-group').first().waitFor();
    await modal.getByTestId('ns-name').fill(NAME);
    await modal.getByTestId('ns-task').fill(TASK);
    await modal.locator('[data-testid="ns-chip"][data-solution="smoke-front"]').click();
    const worktrees = modal.getByTestId('ns-switch-worktrees');
    if ((await worktrees.getAttribute('aria-checked')) === 'true') await worktrees.click();
    await modal.getByTestId('ns-start').click();
    const session = await until('the session', async () => (await api<Session[]>('/api/sessions')).find((s) => s.name === NAME), 10_000);
    report['sessionId'] = session.id;

    // The question reaches the Inbox; answer "Blue" there.
    await page.getByTestId('nav-inbox').click();
    await until('the question in the Inbox', async () => (await page.getByTestId('inbox-item').count()) > 0, 120_000);
    report['questionText'] = await page.getByTestId('question').first().innerText();
    await page.getByTestId('question-option').filter({ hasText: 'Blue' }).first().click();
    await page.getByTestId('question-send').click();
    report['answered'] = 'Blue';

    const done = await until(
      'the reply',
      async () => {
        const s = (await api<Session[]>('/api/sessions')).find((x) => x.id === session.id);
        return s && (s.status === 'done' || s.status === 'fail') ? s : null;
      },
      120_000,
    );
    report['status'] = done.status;
    const detail = await api<SessionDetail>(`/api/sessions/${session.id}`);
    const events = detail.events ?? [];
    const texts = events.filter((e) => (e.payload as { type?: string }).type === 'assistant').map((e) => (e.payload as { text?: string }).text ?? '');
    report['lastReply'] = texts.at(-1) ?? null;
    report['replyNamesBlue'] = /blue/i.test(texts.at(-1) ?? '');
    report['permissionEvents'] = events.filter((e) => ['mode-mismatch', 'denied', 'request'].includes(String((e.payload as { type?: string }).type))).map((e) => `${e.kind} · ${e.label}`);
    report['eventCount'] = events.length;
    await page.goto(`${BASE}/sessions/${session.id}`);
    await page.getByTestId('chat-message').first().waitFor();
    await page.screenshot({ path: path.join(SANDBOX, 'real-cli-smoke-chat.png') });
    report['seconds'] = Math.round((Date.now() - started) / 1000);
    report['ok'] = done.status === 'done' && report['replyNamesBlue'] === true;
  } catch (error) {
    report['ok'] = false;
    report['error'] = error instanceof Error ? error.message : String(error);
    report['serverLog'] = log.slice(-2000);
  } finally {
    await browser.close();
    server.kill('SIGINT');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  console.log(JSON.stringify(report, null, 2));
  if (report['ok'] !== true) process.exitCode = 1;
}

await main();
