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
    const { a, b } = await pairedNodes(tmp);
    nodes.push(a, b);
    const ann = (await a.call('POST', '/api/user-profiles', { name: 'Ann', password: 'ann-secret' })).body as UserProfile;
    const bo = (await a.call('POST', '/api/user-profiles', { name: 'Bo' })).body as UserProfile;
    await waitFor('Ann and Bo on B', async () => ((await names(b)).join() === 'Default,Ann,Bo' ? true : null), 30_000);
    // The password travelled as its hash: B checks it.
    expect(await switchOn(b, ann.id, 'wrong')).toBe(401);
    expect(await switchOn(b, ann.id, 'ann-secret')).toBe(200);
    // A rename on B comes back to A.
    expect((await b.call('PUT', `/api/user-profiles/${bo.id}`, { name: 'Bo B' })).status).toBe(200);
    await waitFor('the rename on A', async () => ((await names(a)).includes('Bo B') ? true : null), 30_000);
    // A delete on A (no agents) goes on B too.
    expect((await a.call('DELETE', `/api/user-profiles/${bo.id}`)).status).toBe(200);
    await waitFor('Bo gone on B', async () => ((await names(b)).join() === 'Default,Ann' ? true : null), 30_000);
  }, 120_000);
});
