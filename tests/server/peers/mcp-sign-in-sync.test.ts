import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../src/core/api.ts';
import type { McpSignInSettings } from '../../../src/core/mcp-sign-in.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D184 with two real Switchboard processes (`docs/mcp.md` → *Synced with paired computers*): the
 * MCP sign-in mutes go both ways over `POST /peer/v1/mcp-sign-in`, each computer lists the other's
 * claude.ai connectors, and a muted server's sign-in item is left out of the merged Inbox, even
 * from a paired computer that does not sync (older than 2.5.8).
 */

const DRIVE = 'claude.ai Google Drive';
const SERVERS = JSON.stringify([
  { name: DRIVE, status: 'needs-auth', source: 'claudeai' },
  { name: 'claude.ai Claude Docs', status: 'connected', source: 'claudeai' },
]);

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-mcp-sync');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function settings(node: PeerNode): Promise<McpSignInSettings> {
  return (await node.call('GET', '/api/mcp/sign-in')).body as McpSignInSettings;
}

async function driveItems(node: PeerNode): Promise<InboxItem[]> {
  return ((await node.call('GET', '/api/inbox')).body as InboxItem[]).filter((item) => item.title === `Sign in to ${DRIVE}`);
}

async function startAgent(node: PeerNode): Promise<void> {
  const created = await node.call('POST', '/api/sessions', { name: 'drive-agent', task: 'Say OK.', folder: node.folderId, worktrees: false, ultracode: false });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
}

describe('D184 · MCP sign-in mutes and connectors on paired computers', () => {
  it('B lists A’s connectors; a mute on B goes to A (its item closes there and here); an unmute on A comes back to both', async () => {
    const { a, b } = await pairedNodes(tmp, {}, { a: { FAKE_CLAUDE_INIT_MCP_SERVERS: SERVERS } });
    nodes.push(a, b);
    await startAgent(a);
    // A raises the item; B shows it too (the merged Inbox).
    await waitFor('A’s Google Drive item', async () => ((await driveItems(a)).length === 1 ? true : null), 30_000);
    await waitFor('A’s item on B', async () => ((await driveItems(b)).length === 1 ? true : null), 30_000);
    // B's Settings lists A's connectors (A told them in the exchange when they changed).
    const onB = await waitFor('A’s connectors on B', async () => {
      const view = await settings(b);
      const computer = view.computers?.find((entry) => entry.connectors.some((connector) => connector.name === DRIVE));
      return computer ? { view, computer } : null;
    }, 30_000);
    expect(onB.computer.synced).toBe(true);
    expect(onB.computer.connectors.find((connector) => connector.name === DRIVE)?.status).toBe('needs-auth');
    expect(typeof onB.view.self).toBe('string');
    // Muted on B: applied on A at once (its item closes) and gone from B's Inbox.
    expect((await b.call('PUT', `/api/mcp/sign-in/muted/${encodeURIComponent(DRIVE)}`, { muted: true })).status).toBe(200);
    await waitFor('the mute on A', async () => ((await settings(a)).muted.includes(DRIVE) ? true : null), 30_000);
    await waitFor('A’s item closed', async () => ((await driveItems(a)).length === 0 ? true : null), 30_000);
    await waitFor('gone from B', async () => ((await driveItems(b)).length === 0 ? true : null), 30_000);
    // Asked again on A: back on B too, and A's item comes back with its next report.
    expect((await a.call('PUT', `/api/mcp/sign-in/muted/${encodeURIComponent(DRIVE)}`, { muted: false })).status).toBe(200);
    await waitFor('the unmute on B', async () => ((await settings(b)).muted.includes(DRIVE) ? null : true), 30_000);
    await waitFor('A’s item back', async () => ((await driveItems(a)).length === 1 ? true : null), 30_000);
  }, 150_000);

  it('a paired computer that does not sync (older): named as not synced; its item for a server muted here is still left out of this computer’s Inbox', async () => {
    const { a, b } = await pairedNodes(tmp, { SWITCHBOARD_PEER_TEST_HOOKS: '1' }, { a: { FAKE_CLAUDE_INIT_MCP_SERVERS: SERVERS } });
    nodes.push(a, b);
    expect((await a.call('POST', '/api/test/peers/mcp-old')).status).toBe(204);
    await startAgent(a);
    await waitFor('A’s item on B', async () => ((await driveItems(b)).length === 1 ? true : null), 30_000);
    expect((await b.call('PUT', `/api/mcp/sign-in/muted/${encodeURIComponent(DRIVE)}`, { muted: true })).status).toBe(200);
    // B tried to send it: A answered like an older computer.
    const view = await waitFor('A not synced', async () => {
      const current = await settings(b);
      return current.computers?.some((entry) => !entry.synced) ? current : null;
    }, 30_000);
    expect(view.computers?.filter((entry) => !entry.synced)).toHaveLength(1);
    // A keeps its own item (it did not take the mute), but B leaves it out.
    expect(await driveItems(a)).toHaveLength(1);
    expect((await settings(a)).muted).toEqual([]);
    expect(await driveItems(b)).toEqual([]);
  }, 150_000);
});
