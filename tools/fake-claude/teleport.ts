import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { JsonObject } from './json.ts';

/**
 * `claude -p --teleport <id>` for the fake (D25; the print-mode behavior read
 * from the CLI in `docs/spike-remote.md` → *R.3 Teleport*, never run for real):
 * the checks a teleport makes before it loads anything, a simulated branch
 * checkout (a local branch named after the id, no network), and a short fixed
 * "remote history" that seeds the local copy's transcript. Surface:
 * `docs/fake-claude.md` → *Teleport*.
 */

/** Environment switch for the refusals the fake cannot reach for real (no cloud, no network). */
export const TELEPORT_ENV = 'FAKE_CLAUDE_TELEPORT';

/** The GitHub repository the fake's remote sessions belong to (the wrong-repo text names it). */
export const TELEPORT_REPO_ENV = 'FAKE_CLAUDE_TELEPORT_REPO';

/** Default of {@link TELEPORT_REPO_ENV}. */
export const DEFAULT_TELEPORT_REPO = 'acme/app';

/** A refusal: its stderr text and exit code. Distinct codes, so tests can tell them apart (the real CLI's codes were never captured). */
export interface TeleportRefusal {
  readonly text: string;
  readonly code: number;
}

/** `validateGitState()` in print mode (R.3, verbatim): tracked changes in the cwd; untracked files are ignored. */
export function dirtyTreeRefusal(): TeleportRefusal {
  return { text: 'Git working directory is not clean. Please commit or stash your changes before using --teleport.', code: 1 };
}

/** The repo check (R.3, verbatim): the cwd is not a checkout of the session's repository (`not_in_repo` / `mismatch`). */
export function wrongRepoRefusal(id: string, repo: string): TeleportRefusal {
  return { text: `You must run claude --teleport ${id} from a checkout of ${repo}`, code: 2 };
}

/** An archived session (the text R.2 records for `--cloud` on one; the teleport text was never captured). */
export function archivedRefusal(id: string): TeleportRefusal {
  return { text: `cloud session ${id} is archived and cannot accept new messages`, code: 3 };
}

/** The session's branch is not on origin: `git fetch origin <b>:<b>` fails (R.3; the fake's own wrapping of git's message). */
export function notPushedRefusal(branch: string): TeleportRefusal {
  return { text: `Failed to fetch branch ${branch} from origin: fatal: couldn't find remote ref ${branch}`, code: 4 };
}

/** Not signed in with claude.ai (R.9: teleport needs a claude.ai access token; the fake's own wording). */
export function signedOutRefusal(): TeleportRefusal {
  return { text: 'Not logged in · Please run /login', code: 5 };
}

/**
 * Whether the teleport reports `system/init` at once (the default) or, with
 * {@link TELEPORT_ENV}`=no-init`, only with its first turn, as the CLI does for an
 * idle `--resume` (M0.4); which one the real CLI does for `--teleport` is unknown
 * (`docs/spike-remote.md` → P6).
 */
export function reportsInitAtStart(env: NodeJS.ProcessEnv): boolean {
  return env[TELEPORT_ENV]?.trim() !== 'no-init';
}

/** The branch the fake "checks out" for a teleport of `id`: named after the id (no network). */
export function teleportBranch(id: string): string {
  return `claude/${id}`;
}

/** One exchange of the fixed remote history. */
export interface RemoteExchange {
  readonly prompt: string;
  readonly reply: string;
}

/** The fixed remote history every fake teleport loads as the conversation's start (R.3: `messagesOrigin: "remote"`). */
export function remoteHistory(branch: string): readonly RemoteExchange[] {
  return [
    { prompt: 'Remote history 1: add a /health endpoint to the API.', reply: 'Remote reply 1: added GET /health, which answers { ok: true }, and a test for it.' },
    { prompt: 'Remote history 2: push the branch.', reply: `Remote reply 2: pushed ${branch}.` },
  ];
}

/** How far back the remote history's timestamps go (the cloud session ran before the teleport). */
const HISTORY_AGE_MS = 10 * 60_000;

/**
 * The remote history as transcript entries (the shapes CLI 2.1.283 writes, M0.3):
 * a `user` prompt and an `assistant` text message per exchange, chained by
 * `parentUuid`, timestamps a few minutes before `now`. The caller adds the
 * envelope (`cwd`, `sessionId`, `version`, `gitBranch`, …).
 */
export function remoteHistoryEntries(history: readonly RemoteExchange[], now: number = Date.now()): JsonObject[] {
  const entries: JsonObject[] = [];
  const step = HISTORY_AGE_MS / (history.length * 2 + 1);
  let at = now - HISTORY_AGE_MS;
  for (const exchange of history) {
    at += step;
    entries.push({ type: 'user', message: { role: 'user', content: exchange.prompt }, uuid: randomUUID(), timestamp: new Date(at).toISOString() });
    at += step;
    entries.push({
      type: 'assistant',
      message: {
        id: `msg_${randomUUID().replaceAll('-', '')}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: exchange.reply }],
      },
      requestId: `req_${randomUUID().replaceAll('-', '')}`,
      uuid: randomUUID(),
      timestamp: new Date(at).toISOString(),
    });
  }
  return entries;
}

/** What {@link runGit} returns. */
interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs git in `cwd` (argv only, `shell: false`). */
function runGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', [...args], { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => resolve({ code: null, stdout, stderr: stderr || error.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Result of {@link teleportInto}: the branch now checked out, or the refusal to print. */
export type TeleportResult = { readonly ok: true; readonly branch: string } | { readonly ok: false; readonly refusal: TeleportRefusal };

/**
 * What the fake's `--teleport <id>` does before it reports anything, in the CLI's
 * order (R.3): the cwd must be a git checkout (else the wrong-repo text), with no
 * tracked changes (else the dirty-tree text; {@link TELEPORT_ENV}`=dirty` forces
 * it); then the session download (`FAKE_CLAUDE_SIGNED_OUT=1` → not signed in;
 * `wrong-repo` / `archived` from {@link TELEPORT_ENV}); then the branch
 * (`not-pushed` from {@link TELEPORT_ENV}), else `git checkout` of
 * {@link teleportBranch} (created when missing). A git failure there is printed as
 * git said it.
 */
export async function teleportInto(cwd: string, id: string, env: NodeJS.ProcessEnv): Promise<TeleportResult> {
  const mode = env[TELEPORT_ENV]?.trim() ?? '';
  const repo = env[TELEPORT_REPO_ENV]?.trim() || DEFAULT_TELEPORT_REPO;
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], env);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { ok: false, refusal: wrongRepoRefusal(id, repo) };
  const status = await runGit(cwd, ['status', '--porcelain', '--untracked-files=no'], env);
  if (mode === 'dirty' || status.code !== 0 || status.stdout.trim() !== '') return { ok: false, refusal: dirtyTreeRefusal() };
  if (env['FAKE_CLAUDE_SIGNED_OUT'] === '1') return { ok: false, refusal: signedOutRefusal() };
  if (mode === 'wrong-repo') return { ok: false, refusal: wrongRepoRefusal(id, repo) };
  if (mode === 'archived') return { ok: false, refusal: archivedRefusal(id) };
  const branch = teleportBranch(id);
  if (mode === 'not-pushed') return { ok: false, refusal: notPushedRefusal(branch) };
  const existing = await runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], env);
  const checkout = await runGit(cwd, existing.code === 0 ? ['checkout', '-q', branch] : ['checkout', '-q', '-b', branch], env);
  if (checkout.code !== 0) return { ok: false, refusal: { text: checkout.stderr.trim() || `git checkout ${branch} failed`, code: 1 } };
  return { ok: true, branch };
}
