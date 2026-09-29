import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Runs real git in `cwd` (the test's isolated git environment); throws on failure; returns trimmed stdout. */
export type GitRunner = (cwd: string, ...args: string[]) => Promise<string>;

/** A repo cloned from a local bare "origin" (D40 tests: never a real remote). */
export interface OriginRepo {
  /** The clone the tests work in (its `origin` is {@link bare}; local `master` tracks `origin/master`). */
  readonly repo: string;
  /** The bare origin (`<root>/origins/<name>.git`). */
  readonly bare: string;
  /** A second clone that plays "someone else": it commits and pushes to origin. */
  readonly pusher: string;
  /** Commits `file` on `branch` in the pusher (created from `from` when new) and pushes it; returns the commit. */
  push(branch: string, file: string, content: string, from?: string): Promise<string>;
  /** `git for-each-ref` of the bare origin: every ref and its commit (to prove nothing was pushed). */
  refs(): Promise<string>;
}

/**
 * A git repo at `dir` cloned from a local bare origin whose default branch is
 * `master`, with `branches` pushed to origin in order (each `[name, from]` gets
 * one commit on top of `from`). Everything stays under `root`: the bare repo in
 * `origins/`, the pushing clone in `pushers/`.
 */
export async function makeOriginRepo(
  git: GitRunner,
  root: string,
  dir: string,
  branches: ReadonlyArray<readonly [name: string, from: string]> = [],
): Promise<OriginRepo> {
  const name = path.basename(dir);
  const bare = path.join(root, 'origins', `${name}.git`);
  const pusher = path.join(root, 'pushers', name);
  await mkdir(bare, { recursive: true });
  await mkdir(path.dirname(pusher), { recursive: true });
  await git(bare, 'init', '-q', '--bare', '-b', 'master');
  await git(path.dirname(pusher), 'clone', '-q', bare, pusher);
  await git(pusher, 'symbolic-ref', 'HEAD', 'refs/heads/master');
  const commit = async (file: string, content: string): Promise<string> => {
    await mkdir(path.dirname(path.join(pusher, file)), { recursive: true });
    await writeFile(path.join(pusher, file), content);
    await git(pusher, 'add', '--', file);
    await git(pusher, 'commit', '-q', '-m', `write ${file}`);
    return git(pusher, 'rev-parse', 'HEAD');
  };
  await commit('README.md', 'hello\n');
  await git(pusher, 'push', '-q', 'origin', 'master');
  const push = async (branch: string, file: string, content: string, from?: string): Promise<string> => {
    const exists = (await git(pusher, 'branch', '--list', branch)) !== '';
    if (exists) await git(pusher, 'switch', '-q', branch);
    else await git(pusher, 'switch', '-q', '-c', branch, from ?? 'master');
    const sha = await commit(file, content);
    await git(pusher, 'push', '-q', 'origin', branch);
    return sha;
  };
  for (const [branch, from] of branches) await push(branch, `${branch.replace(/\//g, '-')}.txt`, `${branch}\n`, from);
  await mkdir(path.dirname(dir), { recursive: true });
  await git(path.dirname(dir), 'clone', '-q', bare, dir);
  return {
    repo: dir,
    bare,
    pusher,
    push,
    refs: () => git(bare, 'for-each-ref', '--format=%(refname) %(objectname)'),
  };
}
