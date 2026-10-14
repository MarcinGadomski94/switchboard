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
 * - D109: `gh pr view` answers whatever fields the `FAKE_GH_PRS` entry carries, so a test gives a
 *   PR its `statusCheckRollup` (CheckRuns with `name`, `status`, `conclusion`, `detailsUrl`
 *   `…/actions/runs/<run>/job/<job>`), `reviewDecision`, `mergeable`, `isDraft`, `headRefOid`.
 * - D109: `gh pr merge <number|branch> --squash|--merge|--rebase` → the entry must be `OPEN`: it
 *   becomes `MERGED` (with `mergedWith: <method>`) in the `FAKE_GH_PRS` file, exit 0; not open →
 *   gh's `Pull request #n is not mergeable`, exit 1; none → `no pull requests found`, exit 1.
 *   `FAKE_GH_MERGE_FAIL=<text>` (and `FAKE_GH_FAIL`) make it fail with that text.
 * - D109: `gh run view <run> --log-failed [--job <job>]` → the file `<FAKE_GH_RUN_LOGS>/<run>.log`
 *   (or `<run>-<job>.log` when that exists), printed as is; none → `could not find any workflow
 *   run with ID <run>`, exit 1.
 * - D109: `gh repo view [--json <fields>]` → the entry of the cwd's repo folder in the JSON file
 *   named by `FAKE_GH_REPO` (`{"<repo>": {nameWithOwner, viewerDefaultMergeMethod}, "*": {…}}`),
 *   else `{"nameWithOwner": "fake/<repo>", "viewerDefaultMergeMethod": "MERGE"}`; outside a repo,
 *   `not a git repository`, exit 1.
 * - D109: `gh issue list --repo <owner/repo> [--state open] [--label <l>] [--assignee @me]
 *   [--limit <n>] --json <fields>` → the repo's list in the JSON file named by `FAKE_GH_ISSUES`
 *   (`{"<owner/repo>": [{number, title, body, url, labels: [{name}], assignees: [{login}], state}]}`),
 *   filtered (`@me` = `fake-gh`, the account `auth status` names; state `OPEN` by default),
 *   cut to the limit (default 30), only the requested fields; an unknown repo → gh's `Could not
 *   resolve to a Repository`, exit 1. `FAKE_GH_ISSUES_FAIL=<text>` fails it.
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

/** D109: the entry `pr merge` / `pr view` name: a repo key, a branch, or a number. */
function findEntry(prs: Record<string, Record<string, unknown>>, repo: string | null, selector: string): string | null {
  if (repo !== null && prs[`${repo}:${selector}`]) return `${repo}:${selector}`;
  if (prs[selector]) return selector;
  if (/^\d+$/.test(selector)) {
    const found = Object.entries(prs).find(([key, pr]) => pr['number'] === Number(selector) && (repo === null || !key.includes(':') || key.startsWith(`${repo}:`)));
    return found ? found[0] : null;
  }
  return null;
}

/** D109: `gh pr merge <number|branch> --squash|--merge|--rebase`. */
async function prMerge(args: string[]): Promise<never> {
  const failure = process.env['FAKE_GH_MERGE_FAIL'] ?? process.env['FAKE_GH_FAIL'];
  if (failure) return finish(1, '', `${failure}\n`);
  const method = args.includes('--squash') ? 'squash' : args.includes('--rebase') ? 'rebase' : args.includes('--merge') ? 'merge' : null;
  const selector = args.find((arg) => !arg.startsWith('-')) ?? (await currentBranch(process.cwd()));
  if (method === null || selector === null) return finish(1, '', 'fake-gh only supports `pr merge <number|branch> --squash|--merge|--rebase`\n');
  const file = process.env['FAKE_GH_PRS'];
  const prs = await loadPullRequests();
  const repo = Object.keys(prs).some((key) => key.includes(':')) ? await repoName(process.cwd()) : null;
  const key = findEntry(prs, repo, selector);
  const entry = key ? prs[key] : undefined;
  if (!key || !entry) return finish(1, '', `no pull requests found for branch "${selector}"\n`);
  if (entry['state'] !== 'OPEN') return finish(1, '', `Pull request #${String(entry['number'])} is not mergeable: it is ${String(entry['state']).toLowerCase()}\n`);
  prs[key] = { ...entry, state: 'MERGED', mergedWith: method };
  if (file) await writeFile(file, JSON.stringify(prs));
  return finish(0, `✓ Merged pull request #${String(entry['number'])}\n`);
}

/** D109: `gh run view <run> --log-failed [--job <job>]` from `FAKE_GH_RUN_LOGS`. */
async function runView(args: string[]): Promise<never> {
  const run = args.find((arg) => /^\d+$/.test(arg));
  if (!run || !args.includes('--log-failed')) return finish(1, '', 'fake-gh only supports `run view <run> --log-failed [--job <job>]`\n');
  const job = option(args, '--job');
  const dir = process.env['FAKE_GH_RUN_LOGS'];
  if (dir) {
    for (const name of [...(job ? [`${run}-${job}.log`] : []), `${run}.log`]) {
      try {
        return finish(0, await readFile(path.join(dir, name), 'utf8'));
      } catch {
        // Next candidate.
      }
    }
  }
  return finish(1, '', `could not find any workflow run with ID ${run}\n`);
}

/** D109: `gh repo view [--json <fields>]` for the cwd's repo. */
async function repoView(args: string[]): Promise<never> {
  const repo = await repoName(process.cwd());
  if (repo === null) return finish(1, '', 'failed to run git: fatal: not a git repository (or any of the parent directories): .git\n');
  let entry: Record<string, unknown> = { nameWithOwner: `fake/${repo}`, viewerDefaultMergeMethod: 'MERGE' };
  const file = process.env['FAKE_GH_REPO'];
  if (file) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, Record<string, unknown>>;
      entry = parsed[repo] ?? parsed['*'] ?? entry;
    } catch {
      // No usable file: the default.
    }
  }
  const fields = (option(args, '--json') ?? '').split(',').filter(Boolean);
  const picked: Record<string, unknown> = {};
  for (const field of fields) if (field in entry) picked[field] = entry[field];
  return finish(0, `${JSON.stringify(fields.length > 0 ? picked : entry)}\n`);
}

/** D109: `gh issue list --repo <r> …` from `FAKE_GH_ISSUES`. */
async function issueList(args: string[]): Promise<never> {
  const failure = process.env['FAKE_GH_ISSUES_FAIL'];
  if (failure) return finish(1, '', `${failure}\n`);
  const repo = option(args, '--repo');
  if (!repo) return finish(1, '', 'fake-gh only supports `issue list --repo <owner/repo>`\n');
  let all: Record<string, Array<Record<string, unknown>>> = {};
  try {
    all = JSON.parse(await readFile(process.env['FAKE_GH_ISSUES'] ?? '', 'utf8')) as Record<string, Array<Record<string, unknown>>>;
  } catch {
    all = {};
  }
  const list = all[repo];
  if (!Array.isArray(list)) return finish(1, '', `GraphQL: Could not resolve to a Repository with the name '${repo}'. (repository)\n`);
  const state = (option(args, '--state') ?? 'open').toUpperCase();
  const label = option(args, '--label');
  const assignee = option(args, '--assignee');
  const limit = Number(option(args, '--limit') ?? '30');
  const fields = (option(args, '--json') ?? '').split(',').filter(Boolean);
  const names = (value: unknown, key: string): string[] => (Array.isArray(value) ? value.map((entry) => (typeof entry === 'object' && entry !== null ? String((entry as Record<string, unknown>)[key] ?? '') : '')) : []);
  const matched = list
    .filter((issue) => state === 'ALL' || String(issue['state'] ?? 'OPEN').toUpperCase() === state)
    .filter((issue) => label === null || names(issue['labels'], 'name').includes(label))
    .filter((issue) => assignee === null || names(issue['assignees'], 'login').includes(assignee === '@me' ? 'fake-gh' : assignee))
    .slice(0, Number.isInteger(limit) && limit > 0 ? limit : 30)
    .map((issue) => {
      if (fields.length === 0) return issue;
      const picked: Record<string, unknown> = {};
      for (const field of fields) if (field in issue) picked[field] = issue[field];
      return picked;
    });
  return finish(0, `${JSON.stringify(matched)}\n`);
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
  if (first === 'pr' && second === 'merge') return prMerge(rest);
  if (first === 'run' && second === 'view') return runView(rest);
  if (first === 'repo' && second === 'view') return repoView(rest);
  if (first === 'issue' && second === 'list') return issueList(rest);
  if (first === 'release') return release(second, rest);
  return finish(1, '', `unknown command "${[first, second].filter(Boolean).join(' ')}" for "gh"\n`);
}

void main();
