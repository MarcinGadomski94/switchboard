import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../../src/server/db/store.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { type SessionControl, WorktreeManager } from '../../src/server/worktrees/manager.ts';
import { fakeGhCommand } from '../../tools/fake-gh/command.ts';
import { makeTempDir, removeTempDir } from './net.ts';
import { openTempStore } from './store.ts';

/** `[node, tests/helpers/git-spy.ts]`: git that logs its argv to `GIT_SPY_LOG`. */
export const GIT_SPY_COMMAND: readonly string[] = [process.execPath, path.join(import.meta.dirname, 'git-spy.ts')];

/** One logged git or gh call. */
export interface LoggedCall {
  readonly argv: string[];
  readonly cwd: string;
}

/**
 * A temp workspace with real git repositories (the router layout:
 * `microfrontends/web-front`, `mobile`) and bare "origin" remotes, a git
 * environment isolated from the developer's config (`GIT_CONFIG_GLOBAL` = an
 * empty temp file, no system config), a fake gh and a store.
 */
export interface GitWorld {
  readonly root: string;
  /** Canonical workspace root (contains a space). */
  readonly workspace: string;
  /** `<workspace>/microfrontends/web-front`, pushed to its origin. */
  readonly web: string;
  /** `<workspace>/mobile`, no remote. */
  readonly mobile: string;
  readonly store: Store;
  /** git + fake gh environment (no CLAUDE* / FAKE_CLAUDE_* from the runner). */
  readonly env: NodeJS.ProcessEnv;
  readonly gitLog: string;
  readonly ghLog: string;
  readonly prsFile: string;
  readonly errors: unknown[];
  /** Runs real git in `cwd`; throws on failure; returns trimmed stdout. */
  git(cwd: string, ...args: string[]): Promise<string>;
  /** A git repo with one commit on `main` (README.md + src/app.txt). */
  makeRepo(dir: string): Promise<string>;
  /** Adds a bare `origin` for `repo` and pushes `main` with upstream. */
  addOrigin(repo: string): Promise<string>;
  /** Writes `file` (relative to `dir`) and commits it. */
  commit(dir: string, file: string, content: string, message?: string): Promise<string>;
  /** The fake gh's pull requests (`FAKE_GH_PRS`), keyed by branch or number. */
  setPullRequests(prs: Record<string, Record<string, unknown>>): Promise<void>;
  gitCalls(): Promise<LoggedCall[]>;
  ghCalls(): Promise<LoggedCall[]>;
  /** A manager over this world (spy git, fake gh). */
  manager(options?: { sessions?: SessionControl; workspaceRoot?: string | null; ghCommand?: readonly string[] }): WorktreeManager;
  cleanup(): Promise<void>;
}

/** Options for {@link makeGitWorld}. */
export interface GitWorldOptions {
  /** Reuse a temp root / workspace / store (e.g. a supervisor world's). */
  readonly root?: string;
  readonly workspace?: string;
  readonly store?: Store;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

function cleanParentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('CLAUDE') && !key.startsWith('FAKE_CLAUDE_') && !key.startsWith('GIT_') && !key.startsWith('GH_')) env[key] = value;
  }
  return env;
}

async function readLog(file: string): Promise<LoggedCall[]> {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LoggedCall);
}

export async function makeGitWorld(options: GitWorldOptions = {}): Promise<GitWorld> {
  const ownsRoot = options.root === undefined;
  const root = options.root ?? (await realpath(await makeTempDir('worktrees')));
  const workspace = options.workspace ?? path.join(root, 'work space');
  await mkdir(workspace, { recursive: true });
  const gitConfig = path.join(root, 'gitconfig');
  await writeFile(gitConfig, '');
  const gitLog = path.join(root, 'git-spy.log');
  const ghLog = path.join(root, 'fake-gh.log');
  const prsFile = path.join(root, 'fake-gh-prs.json');
  const store = options.store ?? (await openTempStore(root));
  const env: NodeJS.ProcessEnv = {
    ...(options.baseEnv ?? cleanParentEnv()),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Switchboard Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_SPY_LOG: gitLog,
    FAKE_GH_LOG: ghLog,
    FAKE_GH_PRS: prsFile,
  };
  const errors: unknown[] = [];

  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const result = await runCommand(['git'], args, { cwd, env });
    if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${failureText(result)}`);
    return result.stdout.trim();
  };
  const commit = async (dir: string, file: string, content: string, message = `write ${file}`): Promise<string> => {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
    await git(dir, 'add', '--', file);
    await git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  const makeRepo = async (dir: string): Promise<string> => {
    await mkdir(dir, { recursive: true });
    await git(dir, 'init', '-q', '-b', 'main');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'README.md'), 'hello\n');
    await writeFile(path.join(dir, 'src', 'app.txt'), 'one\ntwo\nthree\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'init');
    return realpath(dir);
  };
  const addOrigin = async (repo: string): Promise<string> => {
    const bare = path.join(root, 'remotes', `${path.basename(repo)}.git`);
    await mkdir(bare, { recursive: true });
    await git(bare, 'init', '-q', '--bare', '-b', 'main');
    await git(repo, 'remote', 'add', 'origin', bare);
    await git(repo, 'push', '-q', '-u', 'origin', 'main');
    return bare;
  };

  const web = await makeRepo(path.join(workspace, 'microfrontends', 'web-front'));
  await addOrigin(web);
  const mobile = await makeRepo(path.join(workspace, 'mobile'));

  return {
    root,
    workspace: await realpath(workspace),
    web,
    mobile,
    store,
    env,
    gitLog,
    ghLog,
    prsFile,
    errors,
    git,
    makeRepo,
    addOrigin,
    commit,
    async setPullRequests(prs) {
      await writeFile(prsFile, JSON.stringify(prs));
    },
    gitCalls: () => readLog(gitLog),
    ghCalls: () => readLog(ghLog),
    manager(managerOptions = {}) {
      return new WorktreeManager({
        store,
        workspaceRoot: managerOptions.workspaceRoot === undefined ? workspace : managerOptions.workspaceRoot,
        ghCommand: managerOptions.ghCommand ?? fakeGhCommand(),
        gitCommand: GIT_SPY_COMMAND,
        env,
        ...(managerOptions.sessions ? { sessions: managerOptions.sessions } : {}),
        onError: (error) => errors.push(error),
      });
    },
    async cleanup() {
      if (ownsRoot) {
        await store.close();
        await removeTempDir(root);
      }
    },
  };
}

/** Git subcommands (and flags) the worktree manager must never run on anyone's tree. */
export function forbiddenGitCalls(calls: readonly LoggedCall[]): LoggedCall[] {
  const forbidden = new Set(['stash', 'reset', 'checkout', 'switch', 'clean', 'restore', 'rebase', 'merge', 'pull', 'push', 'commit']);
  return calls.filter((call) => {
    const sub = call.argv.find((arg, i) => !arg.startsWith('-') && call.argv[i - 1] !== '-c');
    return (
      (sub !== undefined && forbidden.has(sub)) ||
      call.argv.some((arg) => arg === '--force' || arg === '-f' || arg === '-D' || arg === '--hard')
    );
  });
}
