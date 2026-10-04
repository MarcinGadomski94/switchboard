import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { seedFolderInDataDir } from './folders.ts';
import type { Machine, MachinesView } from '../../src/core/peers.ts';
import { TOKEN_FILE } from '../../src/server/token.ts';
import { freeTestPorts } from './net.ts';
import { type ServerProcess, startServer } from './server-process.ts';

/**
 * D48 test worlds (`docs/peers.md` → *Tests*): real Switchboard processes on
 * loopback test ports acting as peers. The peer listener binds 127.0.0.1 only
 * because `SWITCHBOARD_PEER_TEST_LOOPBACK=1`; `tailscale ip -4` is the fake CLI
 * (a test server default). Each node has its own data dir and `CLAUDE_CONFIG_DIR`.
 */

/** A started node. */
export interface PeerNode {
  readonly server: ServerProcess;
  readonly dataDir: string;
  /** The node's `CLAUDE_CONFIG_DIR` (its fake-claude transcripts, its terminal sessions, its user settings). */
  readonly configDir: string;
  readonly baseUrl: string;
  /** Calls the node's local API with its cookie (as its own UI would). */
  call(method: string, route: string, body?: unknown): Promise<{ readonly status: number; readonly body: any }>;
  /** Its machine id (`GET /api/machines` → `self.id`). */
  machineId(): Promise<string>;
  /** The saved repo folder's id (`options.repo`), else `null`. */
  readonly folderId: string | null;
  /** The repo's path (`options.repo`), else `null`. */
  readonly repo: string | null;
}

/** Options of {@link startPeerNode}. */
export interface PeerNodeOptions {
  /** Extra server env. */
  readonly env?: Record<string, string>;
  /** Make a git repo `repo-<label>` (one commit) and save it as the node's default folder (a repo folder), so sessions can start there. */
  readonly repo?: boolean;
  /**
   * D65 tests: runs after the data folder exists and before the server starts (seed folders, clones); the folder id it
   * returns becomes {@link PeerNode.folderId}, its path {@link PeerNode.repo}.
   */
  readonly prepare?: (context: { readonly root: string; readonly label: string; readonly dataDir: string; readonly configDir: string }) => Promise<{ readonly folderId?: string; readonly repo?: string } | void>;
}

/** The git identity and config of test repos (no global or system config). */
export function gitEnv(root: string): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Switchboard Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
}

async function makeRepo(root: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(root, 'gitconfig'), '');
  const env = { ...process.env, ...gitEnv(root) };
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '--allow-empty', '-m', 'init']]) {
    const result = await runCommand(['git'], args, { cwd: dir, env });
    if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
  }
  return realpath(dir);
}

/** Starts one node (its data dir under `root/<label>`). */
export async function startPeerNode(root: string, label: string, options: PeerNodeOptions = {}): Promise<PeerNode> {
  const dataDir = path.join(root, label, 'data');
  const configDir = path.join(root, label, 'claude-config');
  await mkdir(dataDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  let repo: string | null = null;
  let folderId: string | null = null;
  if (options.repo) {
    repo = await makeRepo(root, path.join(root, label, `repo-${label}`));
    folderId = (await seedFolderInDataDir(dataDir, repo, { kind: 'repo' })).id;
  }
  if (options.prepare) {
    const prepared = await options.prepare({ root, label, dataDir, configDir });
    if (prepared?.folderId) folderId = prepared.folderId;
    if (prepared?.repo) repo = prepared.repo;
  }
  const server = await startServer({
    SWITCHBOARD_DATA_DIR: dataDir,
    SWITCHBOARD_PEER_TEST_LOOPBACK: '1',
    CLAUDE_CONFIG_DIR: configDir,
    ...gitEnv(root),
    ...options.env,
  });
  const token = (await readFile(path.join(dataDir, TOKEN_FILE), 'utf8')).trim();
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${server.baseUrl}${route}`, {
      method,
      headers: { cookie: `sb_token=${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed as any };
  };
  return {
    server,
    dataDir,
    configDir,
    baseUrl: server.baseUrl,
    call,
    machineId: async () => ((await call('GET', '/api/machines')).body as MachinesView).self.id,
    folderId,
    repo,
  };
}

/** Switches the node's peer listener on, on a free test port (retrying when another test takes it); returns `127.0.0.1:<port>`. */
export async function enableListener(node: PeerNode): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = (await freeTestPorts()).at(-1 - attempt);
    if (port === undefined) break;
    const answer = await node.call('PUT', '/api/machines/listener', { enabled: true, port });
    if (answer.status === 200 && answer.body.listening) return answer.body.listening as string;
  }
  throw new Error('the peer listener could not bind a free test port');
}

/** Pairs `adder` with `host` ("Allow a new peer" on host, "Add machine" on adder); returns the machine the adder now has. */
export async function pair(host: PeerNode, adder: PeerNode, hostAddress: string): Promise<Machine> {
  const code = await host.call('POST', '/api/machines/pairing-code');
  if (code.status !== 200) throw new Error(`pairing code: HTTP ${code.status}`);
  const added = await adder.call('POST', '/api/machines', { address: hostAddress, code: code.body.code });
  if (added.status !== 201) throw new Error(`add machine: HTTP ${added.status} ${JSON.stringify(added.body)}`);
  return added.body as Machine;
}

/** Two nodes with repos, both listeners on, `b` paired with `a` and both online; returns their machine ids. */
export async function pairedNodes(root: string, env: Record<string, string> = {}): Promise<{ readonly a: PeerNode; readonly b: PeerNode; readonly aId: string; readonly bId: string }> {
  const a = await startPeerNode(root, 'a', { repo: true, env });
  let b: PeerNode;
  try {
    b = await startPeerNode(root, 'b', { repo: true, env });
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
    return { a, b, aId, bId };
  } catch (error) {
    await Promise.all([a.server.stop(), b.server.stop()]);
    throw error;
  }
}

/** Polls `check` until it returns a truthy value (returned) or `timeoutMs` passes (throws with `what`). */
export async function waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
}

/** The machine `id` as `node` sees it. */
export async function machineOn(node: PeerNode, id: string): Promise<Machine | null> {
  const view = (await node.call('GET', '/api/machines')).body as MachinesView;
  return view.machines.find((machine) => machine.id === id) ?? null;
}
