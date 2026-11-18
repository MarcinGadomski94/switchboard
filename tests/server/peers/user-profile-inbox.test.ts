import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem, Session } from '../../../src/core/api.ts';
import type { UserProfile, UserProfilesView } from '../../../src/core/user-profiles.ts';
import { TOKEN_FILE } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D178 with two real Switchboard processes (`docs/profiles.md` → *Scope*): an agent of profile Ann
 * on A asks questions; on B, a browser in Default does not get A's item in its Needs you (Home), a
 * browser in Ann does; and the item B lists names its agent's profile as A named it. The pairing
 * is made from a browser request (in Default): the connection it starts must not keep that profile.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-user-profile-inbox');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

/** A call with the browser's cookie in profile `profile` (its switch first). */
async function inProfile(node: PeerNode, profile: string): Promise<(method: string, route: string, body?: unknown) => Promise<{ status: number; body: unknown }>> {
  const token = (await readFile(path.join(node.dataDir, TOKEN_FILE), 'utf8')).trim();
  const switched = await fetch(`${node.baseUrl}/api/user-profiles/switch`, { method: 'POST', headers: { cookie: `sb_token=${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: profile }) });
  await switched.text();
  const cookie = `sb_token=${token}; ${String(switched.headers.get('set-cookie')).split(';')[0]}`;
  return async (method, route, body) => {
    const response = await fetch(`${node.baseUrl}${route}`, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
  };
}

describe('D178 · a paired computer’s Needs you per profile', () => {
  it('B’s Default does not list Ann’s agent’s item on A; B’s Ann does, with its profile named', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const ann = (await a.call('POST', '/api/user-profiles', { name: 'Ann' })).body as UserProfile;
    await waitFor('Ann on B', async () => (((await b.call('GET', '/api/user-profiles')).body as UserProfilesView).profiles.some((profile) => profile.id === ann.id) ? true : null), 30_000);
    const annOnA = await inProfile(a, ann.id);
    const created = await annOnA('POST', '/api/sessions', { name: 'ann-asks', task: '[fake:ask-2q] Ask me two questions.', folder: a.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const session = created.body as Session;
    const remote = `r~${aId}~${session.id}`;
    const annOnB = await inProfile(b, ann.id);
    const defaultOnB = await inProfile(b, 'default');
    // Before D178 the pairing request's profile (Default) stayed on the connection: B fetched A's Inbox cut to Default, so Ann's item never came.
    const item = await waitFor('Ann’s item on B in Ann', async () => ((await annOnB('GET', '/api/inbox')).body as InboxItem[]).find((candidate) => candidate.sessionId === remote) ?? null, 60_000);
    expect(item.userProfileId).toBe(ann.id);
    expect(((await defaultOnB('GET', '/api/inbox')).body as InboxItem[]).some((candidate) => candidate.sessionId === remote)).toBe(false);
    // A's own browser in Default does not list it either.
    expect(((await a.call('GET', '/api/inbox')).body as InboxItem[]).some((candidate) => candidate.sessionId === session.id)).toBe(false);
  }, 150_000);
});
