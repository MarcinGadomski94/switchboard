import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountProfile } from '../../../src/core/accounts.ts';
import type { AccountsOverview, SystemInfo } from '../../../src/core/api.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D98 × D48 with two real Switchboard processes: the same Claude Code login on
 * both machines is one account (on both, with the machines it is on), a rename on
 * one is the name on the other, an account only one machine has is listed on the
 * other with its machine, and a paired machine's own request answers its own
 * accounts only. Scripted peers (an older Switchboard, an unreachable one, spent
 * marks): `tests/server/accounts/shared.test.ts`.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-shared-accounts');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function signedIn(dir: string, email: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email }));
}

const overview = async (node: PeerNode): Promise<AccountsOverview> => (await node.call('GET', '/api/accounts')).body as AccountsOverview;
const profile = (view: AccountsOverview, id: string): AccountProfile | undefined => view.profiles.find((p) => p.id === id);

describe('D98 · accounts shared and merged across paired machines', () => {
  it('one login on both machines is one account; names follow; an account of one machine shows on the other with its machine', async () => {
    // Both machines' own Claude Code login is the same account.
    await signedIn(path.join(tmp, 'a', 'claude-config'), 'dev@example.com');
    await signedIn(path.join(tmp, 'b', 'claude-config'), 'dev@example.com');
    const { a, b, aId, bId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const aName = (await machineOn(b, aId))?.name as string;
    const bName = (await machineOn(a, bId))?.name as string;

    // Each sees the other's copy of its Default.
    const onB = await waitFor('B merges A\'s Default', async () => {
      const view = await overview(b);
      return profile(view, 'default-claude')?.elsewhere?.some((e) => e.machineId === aId) ? view : null;
    });
    expect(profile(onB, 'default-claude')?.identity).toBe('claude:dev@example.com');
    // Nothing of A's Claude Code is listed apart (its other CLIs' accounts are: they report no identity).
    expect(onB.others?.filter((o) => o.cli === 'claude') ?? []).toEqual([]);
    await waitFor('A merges B\'s Default', async () => profile(await overview(a), 'default-claude')?.elsewhere?.some((e) => e.machineId === bId));

    // A paired machine's own request (the Machine picker) answers that machine's accounts only.
    const viaPeer = (await b.call('GET', `/api/machines/${aId}/api/accounts`)).body as AccountsOverview;
    expect(profile(viaPeer, 'default-claude')?.elsewhere).toBeUndefined();
    expect(viaPeer.others).toBeUndefined();

    // A rename on A is the account's name on B too.
    expect((await a.call('PUT', '/api/accounts/profiles/default-claude', { name: 'Acme' })).status).toBe(200);
    await waitFor('B takes the name', async () => profile(await overview(b), 'default-claude')?.name === 'Acme', 15_000);

    // B adds an account A does not have: A lists it with B's name; the footer shows one row each, with the machines.
    const created = await b.call('POST', '/api/accounts/profiles', { cli: 'claude', name: 'Lab' });
    expect(created.status).toBe(201);
    const lab = created.body as AccountProfile;
    await signedIn(lab.dir as string, 'lab@example.com');
    expect((await b.call('POST', `/api/accounts/profiles/${lab.id}/check`)).status).toBe(200);
    const onA = await waitFor('A lists B\'s Lab', async () => {
      const view = await overview(a);
      return view.others?.some((o) => o.name === 'Lab') ? view : null;
    }, 15_000);
    expect(onA.others?.find((o) => o.name === 'Lab')?.machines.map((m) => m.name)).toEqual([bName]);
    const system = (await a.call('GET', '/api/system')).body as SystemInfo;
    expect(system.accountUsage?.map((row) => [row.name, row.machines?.join(' + ')])).toEqual([
      ['Acme', `${aName} + ${bName}`],
      ['Lab', bName],
    ]);
  }, 90_000);
});
