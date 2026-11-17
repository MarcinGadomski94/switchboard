import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserProfile, UserProfilesView } from '../../../src/core/user-profiles.ts';
import { TOKEN_FILE } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D165 with two real Switchboard processes (`docs/profiles.md` → *Paired computers*): the profiles
 * sync both ways over `POST /peer/v1/user-profiles` (a profile made on A shows on B, with its
 * password: switching to it on B asks for the same one); a rename on B comes back to A; a deleted
 * profile goes on both.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-user-profiles');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function names(node: PeerNode): Promise<string[]> {
  return ((await node.call('GET', '/api/user-profiles')).body as UserProfilesView).profiles.map((profile) => profile.name);
}

async function switchOn(node: PeerNode, id: string, password: string): Promise<number> {
  const token = (await readFile(path.join(node.dataDir, TOKEN_FILE), 'utf8')).trim();
  const response = await fetch(`${node.baseUrl}/api/user-profiles/switch`, { method: 'POST', headers: { cookie: `sb_token=${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id, password }) });
  await response.text();
  return response.status;
}

describe('D165 · profiles on paired computers', () => {
  it('a profile made on A shows on B with its password; a rename on B comes back; a delete goes everywhere', async () => {
    const { a, b } = await pairedNodes(tmp, {}, {}, { separateDefaults: true });
    nodes.push(a, b);
    const ann = (await a.call('POST', '/api/user-profiles', { name: 'Ann', password: 'ann-secret' })).body as UserProfile;
    const bo = (await a.call('POST', '/api/user-profiles', { name: 'Bo' })).body as UserProfile;
    // D172: B's own Default first, then A's Default (a profile of its own, never B's), Ann, Bo.
    await waitFor('Ann and Bo on B', async () => ((await names(b)).join() === 'Default,Default,Ann,Bo' ? true : null), 30_000);
    // The password travelled as its hash: B checks it.
    expect(await switchOn(b, ann.id, 'wrong')).toBe(401);
    expect(await switchOn(b, ann.id, 'ann-secret')).toBe(200);
    // A rename on B comes back to A.
    expect((await b.call('PUT', `/api/user-profiles/${bo.id}`, { name: 'Bo B' })).status).toBe(200);
    await waitFor('the rename on A', async () => ((await names(a)).includes('Bo B') ? true : null), 30_000);
    // A delete on A (no agents) goes on B too.
    expect((await a.call('DELETE', `/api/user-profiles/${bo.id}`)).status).toBe(200);
    await waitFor('Bo gone on B', async () => ((await names(b)).join() === 'Default,Default,Ann' ? true : null), 30_000);
  }, 120_000);

  it('D172: each computer keeps its own Default: renaming both differently keeps both names, on both computers; a merge on purpose makes one', async () => {
    const { a, b } = await pairedNodes(tmp, {}, {}, { separateDefaults: true });
    nodes.push(a, b);
    const own = async (node: PeerNode): Promise<UserProfile> => ((await node.call('GET', '/api/user-profiles')).body as UserProfilesView).profiles.find((profile) => profile.isDefault) as UserProfile;
    // The 2026-11-17 report: A's Default renamed "Marcin", B's "Claudiu" → before D172 the newer rename won on both.
    expect((await a.call('PUT', '/api/user-profiles/default', { name: 'Marcin' })).status).toBe(200);
    expect((await b.call('PUT', '/api/user-profiles/default', { name: 'Claudiu', color: 'blue' })).status).toBe(200);
    await waitFor('both Defaults on both computers', async () => {
      const [onA, onB] = [(await names(a)).sort().join(), (await names(b)).sort().join()];
      return onA === 'Claudiu,Marcin' && onB === 'Claudiu,Marcin' ? true : null;
    }, 30_000);
    expect((await own(a)).name).toBe('Marcin');
    expect((await own(b)).name).toBe('Claudiu');
    // A's agent stays in A's Default: B in its own Default does not see it; B lists it under A's Default.
    const listed = async (node: PeerNode): Promise<string[]> => ((await node.call('GET', '/api/sessions')).body as Array<{ id: string; title?: string | null; name: string }>).map((session) => session.name);
    const created = await a.call('POST', '/api/sessions', { name: 'marcin-agent', task: 'Say OK.', folder: a.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    expect(await listed(a)).toContain('marcin-agent');
    // B knows the agent (it is in B's view of all A's sessions) but B's Default does not see it.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await listed(b)).not.toContain('marcin-agent');
    // A merge on purpose (B: its own Default with A's, both without a password; B keeps "Claudiu"'s name, A's colour).
    const viewB = (await b.call('GET', '/api/user-profiles')).body as UserProfilesView;
    const aDefaultOnB = viewB.profiles.find((profile) => !profile.isDefault && profile.name === 'Marcin') as UserProfile;
    const merged = await b.call('POST', '/api/user-profiles/merge', { a: 'default', b: aDefaultOnB.id, keep: { name: 'a', color: 'b', password: 'a' } });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect((merged.body as { survivor: UserProfile }).survivor).toMatchObject({ id: 'default', name: 'Claudiu' });
    // One profile on both computers, each its own Default, named "Claudiu".
    await waitFor('the merge on A', async () => ((await names(a)).join() === 'Claudiu' ? true : null), 30_000);
    expect((await names(b)).join()).toBe('Claudiu');
    expect((await own(a)).name).toBe('Claudiu');
    // B now sees A's agent in its Default (one profile).
    await waitFor('A’s agent in B’s merged Default', async () => ((await listed(b)).includes('marcin-agent') ? true : null), 30_000);
    // 2026-11-17: the merged profile is edited like any other: a password set on B is the one A asks for too.
    expect((await b.call('PUT', '/api/user-profiles/default', { password: 'merged-secret' })).status).toBe(200);
    await waitFor('the password on A', async () => ((await own(a)).hasPassword ? true : null), 30_000);
    expect(await switchOn(a, 'default', 'wrong')).toBe(401);
    expect(await switchOn(a, 'default', 'merged-secret')).toBe(200);
  }, 150_000);
});
