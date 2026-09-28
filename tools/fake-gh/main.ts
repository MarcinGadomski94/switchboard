#!/usr/bin/env node
/**
 * tools/fake-gh: a stand-in for the GitHub CLI so tests never call the real `gh`
 * or the network (AGENTS.md). Started through an argv prefix (`command.ts` →
 * `fakeGhCommand()`, the `SWITCHBOARD_GH_BIN` JSON-array form). Surface:
 * `docs/worktrees.md` → *Fake gh*.
 *
 * - `gh --version` → a version line, exit 0.
 * - `gh auth status` → exit 0, or exit 1 with gh's signed-out text when `FAKE_GH_SIGNED_OUT=1`.
 * - `gh pr view [<branch>|<number>] --json <fields>` → the entry for that selector in the
 *   JSON file named by `FAKE_GH_PRS` (`{"<branch or number>": {number, state, url, headRefOid, …}}`,
 *   re-read on every call), printed as compact JSON with only the requested fields;
 *   no entry → gh's `no pull requests found for branch "<b>"` on stderr, exit 1. Without a
 *   selector the branch checked out in the cwd is used. `FAKE_GH_FAIL=<text>` makes every
 *   `pr` command print that text to stderr and exit 1 (a network or auth failure).
 * - anything else → `unknown command`, exit 1.
 * - `FAKE_GH_LOG=<file>` appends `{"argv":[…],"cwd":"…"}` per call.
 */
import { spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';

process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => stream.write(text, () => resolve()));
}

async function finish(code: number, out = '', err = ''): Promise<never> {
  if (out) await write(process.stdout, out);
  if (err) await write(process.stderr, err);
  process.exit(code);
}

function currentBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && out.trim() !== '' ? out.trim() : null));
  });
}

async function loadPullRequests(): Promise<Record<string, Record<string, unknown>>> {
  const file = process.env['FAKE_GH_PRS'];
  if (!file) return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Record<string, unknown>>) : {};
  } catch {
    return {};
  }
}

async function prView(args: string[]): Promise<never> {
  let selector: string | null = null;
  let fields: string[] | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') {
      fields = (args[++i] ?? '').split(',').filter(Boolean);
    } else if (arg.startsWith('--json=')) {
      fields = arg.slice('--json='.length).split(',').filter(Boolean);
    } else if (arg.startsWith('-')) {
      return finish(1, '', `unknown flag: ${arg}\n`);
    } else if (selector === null) {
      selector = arg;
    } else {
      return finish(1, '', `accepts at most 1 arg(s), received ${args.length}\n`);
    }
  }
  if (!fields || fields.length === 0) return finish(1, '', 'fake-gh only supports `pr view --json <fields>`\n');
  const failure = process.env['FAKE_GH_FAIL'];
  if (failure) return finish(1, '', `${failure}\n`);
  const branch = selector ?? (await currentBranch(process.cwd()));
  if (branch === null) return finish(1, '', 'could not determine current branch\n');
  const prs = await loadPullRequests();
  const entry =
    prs[branch] ?? (/^\d+$/.test(branch) ? Object.values(prs).find((pr) => pr['number'] === Number(branch)) : undefined);
  if (!entry) {
    return finish(1, '', /^\d+$/.test(branch) ? `GraphQL: Could not resolve to a PullRequest with the number of ${branch}.\n` : `no pull requests found for branch "${branch}"\n`);
  }
  const picked: Record<string, unknown> = {};
  for (const field of fields) if (field in entry) picked[field] = entry[field];
  return finish(0, `${JSON.stringify(picked)}\n`);
}

async function main(): Promise<never> {
  const args = process.argv.slice(2);
  const logFile = process.env['FAKE_GH_LOG'];
  if (logFile) await appendFile(logFile, `${JSON.stringify({ argv: args, cwd: process.cwd() })}\n`);
  const [first, second, ...rest] = args;
  if (first === '--version') return finish(0, 'gh version 0.0.0-fake (fake-gh)\n');
  if (first === 'auth' && second === 'status') {
    if (process.env['FAKE_GH_SIGNED_OUT'] === '1') {
      return finish(1, '', 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n');
    }
    return finish(0, 'github.com\n  ✓ Logged in to github.com account fake-gh (keyring)\n');
  }
  if (first === 'pr' && second === 'view') return prView(rest);
  return finish(1, '', `unknown command "${[first, second].filter(Boolean).join(' ')}" for "gh"\n`);
}

void main();
