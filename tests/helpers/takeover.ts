import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Session } from '../../src/core/api.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { seedFolderInDataDir } from './folders.ts';
import { enableListener, gitEnv, machineOn, type PeerNode, startPeerNode, pair, waitFor } from './peers.ts';

/**
 * D65 test worlds: two real Switchboard processes ("pc" = a, "mac" = b), each with
 * its own clones of the same bare repos (a local bare repo is the shared remote:
 * never a real network), paired and online. The fake CLIs stand in for claude /
 * codex / opencode; the folders are seeded before the servers start.
 */

/** Which repos a node has cloned. */
export interface NodeRepos {
  /** `alpha`: a repo folder (the node's default folder). */
  readonly alpha?: boolean;
  /** `ws`: a workspace folder with the repos `front` and `back`. */
  readonly workspace?: boolean;
  /** `gamma`: a second repo folder. */
  readonly gamma?: boolean;
}

/** The bare remotes (the shared remote of every clone). */
export interface Remotes {
  readonly alpha: string;
  readonly front: string;
  readonly back: string;
  readonly gamma: string;
}

/** A started world. */
export interface TakeoverWorld {
  readonly root: string;
  readonly a: PeerNode;
  readonly b: PeerNode;
  readonly aId: string;
  readonly bId: string;
  readonly remotes: Remotes;
  readonly env: Record<string, string>;
  /** Each node's fake-claude log (`FAKE_CLAUDE_LOG`): its argv, cwd and stdin lines. */
  readonly logs: Record<'a' | 'b', string>;
  /** Where each node has its repos (the same names, different folders). */
  readonly paths: Record<'a' | 'b', { readonly alpha: string; readonly workspace: string; readonly front: string; readonly back: string; readonly gamma: string }>;
  /** Folder ids of the seeded folders, per node. */
  readonly folders: Record<'a' | 'b', { alpha: string | null; workspace: string | null; gamma: string | null }>;
  /** Runs git (isolated config) and returns trimmed stdout; throws on failure. */
  git(cwd: string, ...args: string[]): Promise<string>;
}

/** Runs git with the test identity. */
export async function gitIn(root: string, cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...gitEnv(root) } });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${failureText(result)}`);
  return result.stdout.trim();
}

async function makeRemote(root: string, name: string): Promise<string> {
  await mkdir(path.join(root, 'gitconfig-dir'), { recursive: true });
  await writeFile(path.join(root, 'gitconfig'), '');
  const bare = path.join(root, 'remotes', `${name}.git`);
  await mkdir(bare, { recursive: true });
  await gitIn(root, bare, 'init', '-q', '--bare', '-b', 'main');
  const seed = path.join(root, 'seeds', name);
  await mkdir(seed, { recursive: true });
  await gitIn(root, seed, 'init', '-q', '-b', 'main');
  await writeFile(path.join(seed, 'README.md'), `# ${name}\n`);
  await writeFile(path.join(seed, 'tracked.txt'), 'one\ntwo\nthree\n');
  await gitIn(root, seed, 'add', '-A');
  await gitIn(root, seed, 'commit', '-q', '-m', 'init');
  await gitIn(root, seed, 'remote', 'add', 'origin', bare);
  await gitIn(root, seed, 'push', '-q', 'origin', 'main');
  return realpath(bare);
}

async function clone(root: string, remote: string, dir: string): Promise<string> {
  await mkdir(path.dirname(dir), { recursive: true });
  await gitIn(root, path.dirname(dir), 'clone', '-q', remote, dir);
  return realpath(dir);
}

/**
 * Starts the world. `aRepos` / `bRepos` say what each node has cloned (default:
 * both have `alpha`). Both listeners are on and the machines are paired and online.
 */
export async function takeoverWorld(root: string, options: { readonly aRepos?: NodeRepos; readonly bRepos?: NodeRepos; readonly env?: Record<string, string> } = {}): Promise<TakeoverWorld> {
  const remotes: Remotes = {
    alpha: await makeRemote(root, 'alpha'),
    front: await makeRemote(root, 'front'),
    back: await makeRemote(root, 'back'),
    gamma: await makeRemote(root, 'gamma'),
  };
  const repos = { a: options.aRepos ?? { alpha: true }, b: options.bRepos ?? { alpha: true } };
  const paths = {
    a: { alpha: path.join(root, 'a', 'code', 'alpha'), workspace: path.join(root, 'a', 'ws'), front: path.join(root, 'a', 'ws', 'front'), back: path.join(root, 'a', 'ws', 'back'), gamma: path.join(root, 'a', 'code', 'gamma') },
    b: { alpha: path.join(root, 'b', 'code', 'alpha'), workspace: path.join(root, 'b', 'ws'), front: path.join(root, 'b', 'ws', 'front'), back: path.join(root, 'b', 'ws', 'back'), gamma: path.join(root, 'b', 'code', 'gamma') },
  };
  const folders = {
    a: { alpha: null as string | null, workspace: null as string | null, gamma: null as string | null },
    b: { alpha: null as string | null, workspace: null as string | null, gamma: null as string | null },
  };
  const prepare = (label: 'a' | 'b') => async (context: { readonly dataDir: string }) => {
    const has = repos[label];
    const mine = paths[label];
    if (has.alpha) {
      mine.alpha = await clone(root, remotes.alpha, mine.alpha);
      folders[label].alpha = (await seedFolderInDataDir(context.dataDir, mine.alpha, { kind: 'repo', isDefault: true })).id;
    }
    if (has.workspace) {
      await mkdir(mine.workspace, { recursive: true });
      await writeFile(path.join(mine.workspace, 'AGENTS.md'), '# AGENTS.md (Workspace Router)\n');
      mine.front = await clone(root, remotes.front, mine.front);
      mine.back = await clone(root, remotes.back, mine.back);
      mine.workspace = await realpath(mine.workspace);
      folders[label].workspace = (await seedFolderInDataDir(context.dataDir, mine.workspace, { kind: 'workspace', isDefault: !has.alpha })).id;
    }
    if (has.gamma) {
      mine.gamma = await clone(root, remotes.gamma, mine.gamma);
      folders[label].gamma = (await seedFolderInDataDir(context.dataDir, mine.gamma, { kind: 'repo' })).id;
    }
    return { ...(folders[label].alpha ? { folderId: folders[label].alpha as string } : {}), ...(has.alpha ? { repo: mine.alpha } : {}) };
  };
  const env = options.env ?? {};
  const logs = { a: path.join(root, 'a-fake-claude.log'), b: path.join(root, 'b-fake-claude.log') };
  const perNode = (label: 'a' | 'b'): Record<string, string> => ({
    ...env,
    FAKE_CLAUDE_LOG: logs[label],
    CODEX_HOME: path.join(root, label, 'codex-home'),
    FAKE_CODEX_LOG: path.join(root, `${label}-fake-codex.log`),
    XDG_DATA_HOME: path.join(root, label, 'xdg-data'),
  });
  const a = await startPeerNode(root, 'a', { env: perNode('a'), prepare: prepare('a') });
  let b: PeerNode;
  try {
    b = await startPeerNode(root, 'b', { env: perNode('b'), prepare: prepare('b') });
  } catch (error) {
    await a.server.stop();
    throw error;
  }
  try {
    const aAddress = await enableListener(a);
    await enableListener(b);
    await pair(a, b, aAddress);
    const aId = await a.machineId();
    const bId = await b.machineId();
    await waitFor('both machines online', async () => (await machineOn(b, aId))?.state === 'online' && (await machineOn(a, bId))?.state === 'online');
    return { root, a, b, aId, bId, remotes, env, logs, paths, folders, git: (cwd, ...args) => gitIn(root, cwd, ...args) };
  } catch (error) {
    await Promise.all([a.server.stop(), b.server.stop()]);
    throw error;
  }
}

/** Starts a Claude Code session on `node` in a saved repo folder and waits until it is idle. */
export async function startRepoSession(node: PeerNode, folderId: string, name: string, options: { readonly worktrees?: boolean; readonly task?: string; readonly branch?: string } = {}): Promise<Session> {
  const created = await node.call('POST', '/api/sessions', {
    name,
    task: options.task ?? 'Remember the code word: zeppelin. Reply with just OK.',
    folder: folderId,
    worktrees: options.worktrees ?? false,
    ultracode: false,
    ...(options.branch ? { branch: options.branch } : {}),
  });
  if (created.status !== 201) throw new Error(`start ${name}: HTTP ${created.status} ${JSON.stringify(created.body)}`);
  return settle(node, (created.body as Session).id);
}

/** Starts a workspace session over `solutions` (no worktrees) and waits until it is idle. */
export async function startWorkspaceSession(node: PeerNode, folderId: string, name: string, solutions: readonly string[]): Promise<Session> {
  const created = await node.call('POST', '/api/sessions', {
    name,
    task: 'Remember the code word: zeppelin. Reply with just OK.',
    folder: folderId,
    workType: 'feature',
    mode: 'single',
    phase: 'ui-first',
    coordination: 'none',
    qa: null,
    solutions,
    worktrees: false,
    ultracode: false,
  });
  if (created.status !== 201) throw new Error(`start ${name}: HTTP ${created.status} ${JSON.stringify(created.body)}`);
  return settle(node, (created.body as Session).id);
}

/** Waits for the session's first turn to be over (`idle` or `done`). */
export async function settle(node: PeerNode, id: string): Promise<Session> {
  let last = '';
  try {
    return await waitFor(`session ${id} idle`, async () => {
      const session = (await node.call('GET', `/api/sessions/${id}`)).body as Session;
      last = session.status;
      return session.status === 'idle' || session.status === 'done' ? session : null;
    }, 20_000);
  } catch (error) {
    throw new Error(`${String(error)} (status ${last}; server: ${node.server.output().slice(-1500)})`);
  }
}

/** The fake claude's argv log of a node's process (the `FAKE_CLAUDE_LOG` file), parsed. */
export async function fakeLog(file: string): Promise<Array<Record<string, any>>> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, any>);
}

/** Every file under `dir` (relative, sorted). */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === '.git') continue;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}`);
    }
  };
  await walk(dir, '');
  return out.sort();
}
