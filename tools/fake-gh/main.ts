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
 *   selector the branch checked out in the cwd is used. D47: a key `<repo>:<branch>` (the
 *   folder name of the cwd's repository, its main checkout for a worktree) wins over
 *   `<branch>`, so each repo can have its own PR for the same branch name. `FAKE_GH_FAIL=<text>` makes every
 *   `pr` command print that text to stderr and exit 1 (a network or auth failure).
 * - D55: `gh release view --repo <r> --json <fields>` → the JSON file named by
 *   `FAKE_GH_RELEASE` (gh's `release view` shape: tagName, name, body, assets,
 *   publishedAt, isDraft, isPrerelease, url), only the requested fields; no file →
 *   `release not found`, exit 1. `gh release download <tag> --repo <r> --pattern
 *   <name> --dir <dir> [--clobber]` copies `<FAKE_GH_RELEASE_DIR>/<name>` into
 *   `<dir>`; a missing file → `no assets match the file pattern`, exit 1.
 *   `FAKE_GH_RELEASE_FAIL=<text>` makes every `release` command fail with that text.
 * - D79: `gh pr create --base <b> --head <h> --title <t> --body <x>` → adds
 *   `{number, state: "OPEN", url, headRefName, baseRefName, title}` under `<h>` (under
 *   `<repo>:<h>` when the file already has repo keys) to the `FAKE_GH_PRS` file (number =
 *   the highest + 1) and prints its URL `https://github.com/fake/<repo>/pull/<n>`, exit 0;
 *   an open entry for `<h>` → gh's `a pull request for branch "<h>" into branch "<b>" already
 *   exists:` + its URL, exit 1. `FAKE_GH_FAIL` fails it like every `pr` command.
 * - anything else → `unknown command`, exit 1.
 * - `FAKE_GH_LOG=<file>` appends `{"argv":[…],"cwd":"…"}` per call.
 */
import { spawn } from 'node:child_process';
import { appendFile, copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

/** D47: the folder name of the repository `cwd` belongs to (the main checkout's, also from a worktree), else `null`. */
function repoName(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      const dir = out.trim();
      if (code !== 0 || dir === '') return resolve(null);
      // `<repo>/.git` → `<repo>`; a bare repository is its own folder.
      resolve(path.basename(path.basename(dir) === '.git' ? path.dirname(dir) : dir));
    });
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
  const repo = Object.keys(prs).some((key) => key.includes(':')) ? await repoName(process.cwd()) : null;
  const entry =
    (repo !== null ? prs[`${repo}:${branch}`] : undefined) ??
    prs[branch] ?? (/^\d+$/.test(branch) ? Object.values(prs).find((pr) => pr['number'] === Number(branch)) : undefined);
  if (!entry) {
    return finish(1, '', /^\d+$/.test(branch) ? `GraphQL: Could not resolve to a PullRequest with the number of ${branch}.\n` : `no pull requests found for branch "${branch}"\n`);
  }
  const picked: Record<string, unknown> = {};
  for (const field of fields) if (field in entry) picked[field] = entry[field];
  return finish(0, `${JSON.stringify(picked)}\n`);
}

/** D79: `gh pr create --base <b> --head <h> --title <t> --body <x>` into the `FAKE_GH_PRS` file. */
async function prCreate(args: string[]): Promise<never> {
  const failure = process.env['FAKE_GH_FAIL'];
  if (failure) return finish(1, '', `${failure}\n`);
  const base = option(args, '--base');
  const head = option(args, '--head') ?? (await currentBranch(process.cwd()));
  const title = option(args, '--title');
  if (!base || !head || title === null || option(args, '--body') === null) return finish(1, '', 'fake-gh only supports `pr create --base <b> --head <h> --title <t> --body <x>`\n');
  const file = process.env['FAKE_GH_PRS'];
  const prs = await loadPullRequests();
  const repo = (await repoName(process.cwd())) ?? 'repo';
  const key = Object.keys(prs).some((name) => name.includes(':')) ? `${repo}:${head}` : head;
  const existing = prs[key];
  if (existing && existing['state'] === 'OPEN') {
    return finish(1, '', `a pull request for branch "${head}" into branch "${base}" already exists:\n${String(existing['url'])}\n`);
  }
  const number = Math.max(0, ...Object.values(prs).map((pr) => (typeof pr['number'] === 'number' ? pr['number'] : 0))) + 1;
  const url = `https://github.com/fake/${repo}/pull/${number}`;
  prs[key] = { number, state: 'OPEN', url, headRefName: head, baseRefName: base, title };
  if (file) await writeFile(file, JSON.stringify(prs));
  return finish(0, `${url}\n`);
}

function option(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index !== -1) return args[index + 1] ?? null;
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : null;
}

/** D55: `gh release view` / `gh release download` from `FAKE_GH_RELEASE` / `FAKE_GH_RELEASE_DIR`. */
async function release(command: string | undefined, args: string[]): Promise<never> {
  const failure = process.env['FAKE_GH_RELEASE_FAIL'];
  if (failure) return finish(1, '', `${failure}\n`);
  if (command === 'view') {
    const fields = (option(args, '--json') ?? '').split(',').filter(Boolean);
    const file = process.env['FAKE_GH_RELEASE'];
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(await readFile(file ?? '', 'utf8')) as Record<string, unknown>;
    } catch {
      return finish(1, '', 'release not found\n');
    }
    const picked: Record<string, unknown> = {};
    for (const field of fields) if (field in entry) picked[field] = entry[field];
    return finish(0, `${JSON.stringify(fields.length > 0 ? picked : entry)}\n`);
  }
  if (command === 'download') {
    const pattern = option(args, '--pattern');
    const dir = option(args, '--dir') ?? process.cwd();
    const source = process.env['FAKE_GH_RELEASE_DIR'];
    if (!pattern || !source) return finish(1, '', 'no assets match the file pattern\n');
    try {
      await copyFile(path.join(source, pattern), path.join(dir, pattern));
    } catch {
      return finish(1, '', 'no assets match the file pattern\n');
    }
    return finish(0);
  }
  return finish(1, '', `unknown command "release ${command ?? ''}" for "gh"\n`);
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
  if (first === 'pr' && second === 'create') return prCreate(rest);
  if (first === 'release') return release(second, rest);
  return finish(1, '', `unknown command "${[first, second].filter(Boolean).join(' ')}" for "gh"\n`);
}

void main();
