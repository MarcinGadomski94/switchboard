import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountProfile } from '../../../src/core/accounts.ts';
import type { AccountsOverview, InboxItem } from '../../../src/core/api.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D142 × D98 × D48 with two real Switchboard processes: A has one Claude Code account,
 * B the same one plus Lab. A raises "A can't switch Claude Code accounts" (its own
 * Inbox), B's merged Inbox shows it with A's name, A's Settings answer carries the
 * line (also through B's Machine picker), and once A adds Lab the item closes on both.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-account-hint');
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

const inbox = async (node: PeerNode): Promise<InboxItem[]> => (await node.call('GET', '/api/inbox')).body as InboxItem[];
const hintOn = async (node: PeerNode): Promise<InboxItem | undefined> => (await inbox(node)).find((item) => item.systemKind === 'account-hint');

describe('D142 · one account here, more on a paired machine (two processes)', () => {
  it('the lacking machine raises the item, the other shows it with that machine\'s name; adding the account clears it on both', async () => {
    await signedIn(path.join(tmp, 'a', 'claude-config'), 'dev@example.com');
    await signedIn(path.join(tmp, 'b', 'claude-config'), 'dev@example.com');
    const { a, b, aId, bId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const aName = (await machineOn(b, aId))?.name as string;
    const bName = (await machineOn(a, bId))?.name as string;

    // B signs in a second account A does not have.
    const created = await b.call('POST', '/api/accounts/profiles', { cli: 'claude', name: 'Lab' });
    expect(created.status).toBe(201);
    await signedIn((created.body as AccountProfile).dir as string, 'lab@example.com');
    expect((await b.call('POST', `/api/accounts/profiles/${(created.body as AccountProfile).id}/check`)).status).toBe(200);

    // A: its own item, informational, with Add it there naming Lab.
    const mine = await waitFor('A raises the item', () => hintOn(a), 30_000);
    expect(mine).toMatchObject({ kind: 'system', label: 'Accounts', status: 'idle', title: `${aName} can't switch Claude Code accounts`, addAccount: { cli: 'claude', name: 'Lab' } });
    expect(mine.machine ?? null).toBeNull();
    expect(mine.detail).toBe(`It has only one account signed in (Default). 1 more is signed in on ${bName} (Lab). Add it on ${aName} so agents there switch when one runs out.`);
    expect(mine.actions?.map((x) => x.id)).toEqual(['add-account', 'dismiss']);
    // B never raises one (it can switch).
    const onB = await waitFor('B shows A\'s item with A\'s name', async () => {
      const item = await hintOn(b);
      return item?.machine?.id === aId ? item : null;
    }, 30_000);
    expect(onB.machine?.name).toBe(aName);
    expect(onB.addAccount).toEqual({ cli: 'claude', name: 'Lab' });
    expect((await b.call('GET', '/api/accounts')).body as AccountsOverview).not.toHaveProperty('hints');
    expect((await inbox(b)).filter((item) => item.systemKind === 'account-hint')).toHaveLength(1);

    // Settings › Accounts' line: A's own, and through B's Machine picker (A's own fact).
    const line = `${aName} has only one account signed in (Default). 1 more is signed in on ${bName} (Lab): add it here so agents switch when one runs out.`;
    expect(((await a.call('GET', '/api/accounts')).body as AccountsOverview).hints?.map((h) => h.text)).toEqual([line]);
    expect(((await b.call('GET', `/api/machines/${aId}/api/accounts`)).body as AccountsOverview).hints?.map((h) => h.text)).toEqual([line]);

    // A adds Lab: it can switch now; the item closes there and leaves B's Inbox.
    const added = await a.call('POST', '/api/accounts/profiles', { cli: 'claude', name: 'Lab' });
    expect(added.status).toBe(201);
    await signedIn((added.body as AccountProfile).dir as string, 'lab@example.com');
    expect((await a.call('POST', `/api/accounts/profiles/${(added.body as AccountProfile).id}/check`)).status).toBe(200);
    await waitFor('A closes the item', async () => (await hintOn(a)) === undefined, 30_000);
    await waitFor('B no longer shows it', async () => (await hintOn(b)) === undefined, 30_000);
    expect(((await a.call('GET', '/api/accounts')).body as AccountsOverview).hints).toBeUndefined();
  }, 120_000);
});
