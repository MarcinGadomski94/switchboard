import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitHubBindingView } from '../../../src/core/github-binding.ts';
import type { UserProfile, UserProfilesView } from '../../../src/core/user-profiles.ts';
import { TOKEN_FILE } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D190 with two real Switchboard processes (`docs/profiles.md` → *A profile's GitHub account*,
 * `docs/peers.md`): connect once on A and B's copy of the profile is signed in too (the token taken
 * with `gh auth login --with-token` on stdin, B's agents use it); Disconnect on B signs A out; a
 * profile limited to A (D173) never reaches B; the token is in no file of either data folder outside
 * the profiles' gh folders and in neither server's log.
 */

const TOKEN = 'gho_fakeTokenForTests0123456789';

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-github-sync');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function lines<T>(file: string): Promise<T[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function profiles(node: PeerNode): Promise<readonly UserProfile[]> {
  return ((await node.call('GET', '/api/user-profiles')).body as UserProfilesView).profiles;
}

async function view(node: PeerNode, id: string): Promise<GitHubBindingView> {
  return (await node.call('GET', `/api/user-profiles/${id}/github`)).body as GitHubBindingView;
}

async function connected(node: PeerNode, id: string): Promise<GitHubBindingView> {
  expect((await node.call('POST', `/api/user-profiles/${id}/github/connect`, {})).status).toBe(200);
  return waitFor(`connected on ${node.baseUrl}`, async () => {
    const current = await view(node, id);
    return current.login?.state === 'done' && current.identity ? current : null;
  }, 30_000);
}

/** Every file under `dir` but the profiles' gh folders (`github/`), as text. */
async function filesOutsideGh(dir: string): Promise<Array<{ file: string; text: string }>> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (path.relative(dir, file).split(path.sep)[0] === 'github') continue;
    out.push({ file, text: (await readFile(file)).toString('latin1') });
  }
  return out;
}

describe('D190 · a profile’s GitHub sign-in on the paired computers', () => {
  it('connect on A → B signed in (stdin, its agent uses it); disconnect on B → A signed out; the token nowhere else', async () => {
    const stdinLog = path.join(tmp, 'gh-stdin.log');
    const bClaude = path.join(tmp, 'b-claude.log');
    const { a, b } = await pairedNodes(tmp, { FAKE_GH_STDIN_LOG: stdinLog, FAKE_GH_LOGIN_DELAY_MS: '200' }, { b: { FAKE_CLAUDE_LOG: bClaude } });
    nodes.push(a, b);
    const onA = (await profiles(a)).find((p) => p.isDefault) as UserProfile;
    const onB = (await profiles(b)).find((p) => p.isDefault) as UserProfile;
    const dirA = path.join(a.dataDir, 'github', onA.id);
    const dirB = path.join(b.dataDir, 'github', onB.id);

    await connected(a, onA.id);
    // B: the binding (with the profile) and the sign-in (gh --with-token, the token on stdin).
    const there = await waitFor('signed in on B', async () => {
      const current = await view(b, onB.id);
      return current.identity?.login === 'octo-fake' && current.signedInHere ? current : null;
    }, 30_000);
    expect(there.author).toEqual({ name: 'Octo Fake', email: '4242+octo-fake@users.noreply.github.com' });
    const imported = await lines<{ dir: string; token: string }>(stdinLog);
    expect(imported).toEqual([{ dir: dirB, token: TOKEN }]);

    // B's agent runs as the account, with B's own folder.
    const created = await b.call('POST', '/api/sessions', { name: 'on-b', task: 'Say OK.', folder: b.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const agentId = (created.body as { id: string }).id;
    const spawned = await waitFor('B’s agent spawned', async () => (await lines<{ kind: string; env?: Record<string, string> }>(bClaude)).find((line) => line.kind === 'argv' && line.env?.['SWITCHBOARD_SESSION'] === agentId) ?? null, 30_000);
    expect(spawned.env).toMatchObject({ GH_CONFIG_DIR: dirB, GIT_AUTHOR_NAME: 'Octo Fake', GIT_CONFIG_COUNT: '2' });

    // The token: in the gh folders only, never in a data folder's other files (dbs, settings) or a log.
    for (const node of [a, b]) {
      const leaks = (await filesOutsideGh(node.dataDir)).filter((entry) => entry.text.includes(TOKEN)).map((entry) => entry.file);
      expect(leaks).toEqual([]);
      expect(node.server.output()).not.toContain(TOKEN);
    }
    // The peer token files are not GitHub's.
    expect((await readFile(path.join(a.dataDir, TOKEN_FILE), 'utf8')).includes(TOKEN)).toBe(false);

    // Disconnect on B: A signs out too (its folder removed), the binding gone on both.
    expect((await b.call('POST', `/api/user-profiles/${onB.id}/github/disconnect`, {})).status).toBe(200);
    await waitFor('signed out on A', async () => {
      const current = await view(a, onA.id);
      return current.identity === null && !current.signedInHere ? true : null;
    }, 30_000);
    // The sign-out itself (the tombstone): A's folder goes.
    await waitFor('A’s gh folder removed', async () => stat(dirA).then(() => null, () => true), 30_000);
    await expect(stat(dirB)).rejects.toThrow();
  }, 180_000);

  it('an older paired computer (no route): nothing sent, named in Settings as one to connect on', async () => {
    const stdinLog = path.join(tmp, 'gh-stdin.log');
    const { a, b } = await pairedNodes(tmp, { FAKE_GH_STDIN_LOG: stdinLog, FAKE_GH_LOGIN_DELAY_MS: '200', SWITCHBOARD_PEER_TEST_HOOKS: '1' });
    nodes.push(a, b);
    expect((await a.call('POST', '/api/test/peers/github-old')).status).toBe(204);
    const onB = (await profiles(b)).find((p) => p.isDefault) as UserProfile;
    await connected(b, onB.id);
    const named = await waitFor('A named as older', async () => {
      const current = await view(b, onB.id);
      return current.unsynced && current.unsynced.length === 1 ? current.unsynced : null;
    }, 30_000);
    expect(named).toHaveLength(1);
    expect(await lines(stdinLog)).toEqual([]);
  }, 180_000);

  it('a profile limited to A (D173) is not sent to B; one allowed everywhere is', async () => {
    const stdinLog = path.join(tmp, 'gh-stdin.log');
    const { a, b, aId } = await pairedNodes(tmp, { FAKE_GH_STDIN_LOG: stdinLog, FAKE_GH_LOGIN_DELAY_MS: '200' }, {}, { separateDefaults: true });
    nodes.push(a, b);
    const ann = (await a.call('POST', '/api/user-profiles', { name: 'Ann', password: 'ann-secret' })).body as UserProfile;
    const bo = (await a.call('POST', '/api/user-profiles', { name: 'Bo' })).body as UserProfile;
    const cy = (await a.call('POST', '/api/user-profiles', { name: 'Cy' })).body as UserProfile;
    await waitFor('the profiles on B', async () => ((await profiles(b)).some((p) => p.name === 'Cy') ? true : null), 30_000);
    // Ann (the first admin) limits Bo to A.
    const token = (await readFile(path.join(a.dataDir, TOKEN_FILE), 'utf8')).trim();
    const switched = await fetch(`${a.baseUrl}/api/user-profiles/switch`, { method: 'POST', headers: { cookie: `sb_token=${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: ann.id, password: 'ann-secret' }) });
    await switched.text();
    const cookie = `sb_token=${token}; ${(switched.headers.get('set-cookie') ?? '').split(';')[0]}`;
    const asAnn = async (method: string, route: string, body: unknown) => {
      const response = await fetch(`${a.baseUrl}${route}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.text() };
    };
    expect((await asAnn('PUT', `/api/user-profiles/${ann.id}/admin`, { admin: true, adminPassword: 'ann-secret' })).status).toBe(200);
    const limited = await asAnn('PUT', `/api/user-profiles/${bo.id}/access`, { computers: [aId], adminPassword: 'ann-secret' });
    expect(limited.status, limited.body).toBe(200);
    await waitFor('Bo not allowed on B', async () => ((await profiles(b)).find((p) => p.name === 'Bo')?.allowedHere === false ? true : null), 30_000);

    await connected(a, bo.id);
    await connected(a, cy.id);
    // Cy reaches B (sent after Bo's sign-in: every exchange carries all of them); Bo never does.
    const cyOnB = (await profiles(b)).find((p) => p.name === 'Cy') as UserProfile;
    await waitFor('Cy signed in on B', async () => ((await view(b, cyOnB.id)).signedInHere ? true : null), 30_000);
    const imported = await lines<{ dir: string; token: string }>(stdinLog);
    expect(imported.map((line) => line.dir)).toEqual([path.join(b.dataDir, 'github', cyOnB.id)]);
    const boOnB = (await profiles(b)).find((p) => p.name === 'Bo') as UserProfile;
    await expect(stat(path.join(b.dataDir, 'github', boOnB.id))).rejects.toThrow();
  }, 180_000);
});
