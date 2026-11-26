import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitHubBindingView } from '../../../src/core/github-binding.ts';
import type { UserProfilesView } from '../../../src/core/user-profiles.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, startPeerNode, waitFor } from '../../helpers/peers.ts';

/**
 * D190 with a real Switchboard process and tools/fake-gh (`docs/profiles.md` → *A profile's GitHub
 * account*): Connect GitHub runs gh's device-code sign-in in the profile's own folder (the code shown,
 * Cancel), the profile's agents then get its gh folder, commit author and credential helper (an
 * agent started before it did not), Switchboard's own gh calls in the agent's folder use the
 * profile's folder, and Disconnect removes the sign-in.
 */

let tmp: string;
let node: PeerNode | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('profile-github');
});
afterEach(async () => {
  await node?.server.stop();
  node = null;
  await removeTempDir(tmp);
});

interface LogLine {
  readonly kind: string;
  readonly env?: Record<string, string>;
}

async function lines<T>(file: string): Promise<T[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/** The fake claude's start line of agent sessionId (its marker; other lines are probes). */
async function spawnOf(file: string, sessionId: string): Promise<LogLine | null> {
  return (await lines<LogLine>(file)).find((line) => line.kind === 'argv' && line.env?.['SWITCHBOARD_SESSION'] === sessionId) ?? null;
}

async function startAgent(n: PeerNode, name: string): Promise<string> {
  const created = await n.call('POST', '/api/sessions', { name, task: 'Say OK.', folder: n.folderId, worktrees: false, ultracode: false });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  return (created.body as { id: string }).id;
}

describe('D190 · a profile bound to a GitHub account', () => {
  it('connects with the device code, gives its agents the account (not before), runs Switchboard’s gh in the agent’s folder as it, and disconnects', async () => {
    const claudeLog = path.join(tmp, 'claude.log');
    const ghLog = path.join(tmp, 'gh.log');
    node = await startPeerNode(tmp, 'a', { repo: true, env: { FAKE_CLAUDE_LOG: claudeLog, FAKE_GH_LOG: ghLog, FAKE_GH_LOGIN_DELAY_MS: '600', FAKE_GH_DEVICE_CODE: 'WXYZ-9876' } });
    const n = node;
    const profile = ((await n.call('GET', '/api/user-profiles')).body as UserProfilesView).profiles.find((p) => p.isDefault);
    expect(profile).toBeDefined();
    const id = profile?.id as string;
    const dir = path.join(n.dataDir, 'github', id);

    // Unbound: an agent gets none of it.
    const first = await startAgent(n, 'before');
    const before = await waitFor('the first agent spawned', async () => spawnOf(claudeLog, first), 30_000);
    expect(before.env?.['GH_CONFIG_DIR']).toBeUndefined();
    expect(before.env?.['GIT_CONFIG_COUNT']).toBeUndefined();

    // Connect: gh's code shows, then the account.
    const started = await n.call('POST', `/api/user-profiles/${id}/github/connect`, { email: 'octo@example.com' });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const waiting = await waitFor('the one-time code', async () => {
      const view = (await n.call('GET', `/api/user-profiles/${id}/github`)).body as GitHubBindingView;
      return view.login?.code ? view : view.identity ? view : null;
    }, 30_000);
    if (!waiting.identity) {
      expect(waiting.login).toMatchObject({ state: 'waiting', code: 'WXYZ-9876', url: 'https://github.com/login/device' });
    }
    const done = await waitFor('connected', async () => {
      const view = (await n.call('GET', `/api/user-profiles/${id}/github`)).body as GitHubBindingView;
      return view.login?.state === 'done' && view.identity ? view : null;
    }, 30_000);
    expect(done.identity).toEqual({ login: 'octo-fake', name: 'Octo Fake', id: 4242, email: 'octo@example.com' });
    expect(done.author).toEqual({ name: 'Octo Fake', email: 'octo@example.com' });
    expect(done.signedInHere).toBe(true);
    expect((await stat(dir)).isDirectory()).toBe(true);
    // The token stays in gh's folder; the login asked gh to keep it there (not the system keyring).
    const loginCall = (await lines<{ argv: string[]; ghConfigDir: string | null }>(ghLog)).find((line) => line.argv.includes('--web'));
    expect(loginCall?.argv).toContain('--insecure-storage');
    expect(loginCall?.ghConfigDir).toBe(dir);
    // The profile list carries the binding (synced with the profile).
    expect(((await n.call('GET', '/api/user-profiles')).body as UserProfilesView).profiles.find((p) => p.id === id)?.github?.login).toBe('octo-fake');

    // Bound: the next agent runs as the account.
    const agent = await startAgent(n, 'after');
    const after = await waitFor('the second agent spawned', async () => spawnOf(claudeLog, agent), 30_000);
    expect(after.env).toMatchObject({
      GH_CONFIG_DIR: dir,
      GIT_AUTHOR_NAME: 'Octo Fake',
      GIT_AUTHOR_EMAIL: 'octo@example.com',
      GIT_COMMITTER_NAME: 'Octo Fake',
      GIT_COMMITTER_EMAIL: 'octo@example.com',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    });
    expect(after.env?.['GIT_CONFIG_VALUE_1']).toMatch(/^!.* auth git-credential$/);

    // Switchboard's own gh call in that agent's folder (Import issues' repos: gh repo view) uses the profile's folder.
    const sources = await n.call('GET', `/api/sessions/${agent}/todos/import/sources`);
    expect(sources.status, JSON.stringify(sources.body)).toBe(200);
    const repoView = (await lines<{ argv: string[]; ghConfigDir: string | null }>(ghLog)).filter((line) => line.argv[0] === 'repo' && line.argv[1] === 'view');
    expect(repoView.length).toBeGreaterThan(0);
    expect(repoView.every((line) => line.ghConfigDir === dir)).toBe(true);

    // The commit email changes; an invalid one is refused.
    expect((await n.call('PUT', `/api/user-profiles/${id}/github/email`, { email: 'not an email' })).status).toBe(422);
    const noreply = await n.call('PUT', `/api/user-profiles/${id}/github/email`, { email: null });
    expect((noreply.body as GitHubBindingView).author?.email).toBe('4242+octo-fake@users.noreply.github.com');

    // Disconnect: signed out (its folder gone), unbound.
    const gone = await n.call('POST', `/api/user-profiles/${id}/github/disconnect`, {});
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ identity: null, signedInHere: false });
    await expect(stat(dir)).rejects.toThrow();
    // Never `gh auth logout` (it would remove the account's keyring entry: this computer's own gh when the same account).
    expect((await lines<{ argv: string[] }>(ghLog)).some((line) => line.argv[0] === 'auth' && line.argv[1] === 'logout')).toBe(false);
  }, 120_000);

  it('Cancel stops a sign-in that waits; a failed one says why; another profile’s password is needed', async () => {
    node = await startPeerNode(tmp, 'a', { repo: false, env: { FAKE_GH_LOGIN_HANG: '1' } });
    const n = node;
    const id = (((await n.call('GET', '/api/user-profiles')).body as UserProfilesView).profiles.find((p) => p.isDefault)?.id) as string;
    expect((await n.call('POST', `/api/user-profiles/${id}/github/connect`, {})).status).toBe(200);
    await waitFor('waiting', async () => (((await n.call('GET', `/api/user-profiles/${id}/github`)).body as GitHubBindingView).login?.state === 'waiting' ? true : null), 30_000);
    const cancelled = await n.call('POST', `/api/user-profiles/${id}/github/cancel`, {});
    expect((cancelled.body as GitHubBindingView).login?.state).toBe('cancelled');
    expect((cancelled.body as GitHubBindingView).identity).toBeNull();

    // A profile with a password, from a browser not in it: the password first.
    const locked = (await n.call('POST', '/api/user-profiles', { name: 'Locked', password: 'locked-secret' })).body as { id: string };
    expect((await n.call('POST', `/api/user-profiles/${locked.id}/github/connect`, {})).status).toBe(401);
    expect((await n.call('POST', `/api/user-profiles/${locked.id}/github/connect`, { password: 'wrong' })).status).toBe(401);
    expect((await n.call('GET', '/api/user-profiles/nope/github')).status).toBe(404);
  }, 60_000);
});
