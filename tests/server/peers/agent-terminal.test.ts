import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { TerminalInfo, TerminalServerFrame } from '../../../src/core/terminals.ts';
import type { UserProfile } from '../../../src/core/user-profiles.ts';
import { TOKEN_FILE } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D182 follow-up 2026-11-20 (`docs/terminals.md` → *The agent's terminal*): computer A's browser
 * opens the terminal at the bottom of computer B's agent's conversation. The start is forwarded to B
 * (`POST /api/sessions/{id}/terminal` on B's peer API): it runs on B, in the agent's folder; its
 * socket goes through A's paired-machine proxy and B's peer listener (D170). A's Close (the page
 * leaving the conversation) ends it on B; a dropped socket ends it after the grace (here 600 ms).
 * An archived agent and another profile's agent are refused. B runs a deterministic echo program
 * (`SWITCHBOARD_TEST_TERMINAL_ARGV`), never a shell.
 */

const ECHO = "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('echo:'+d.trim()+'\\r\\n'));process.stdout.write('ready\\r\\n')";

let root: string;
let a: PeerNode;
let b: PeerNode;
let bId: string;

beforeAll(async () => {
  root = await makeTempDir('peer-agent-terminal');
  ({ a, b, bId } = await pairedNodes(root, { SWITCHBOARD_TEST_TERMINAL_ARGV: JSON.stringify([process.execPath, '-e', ECHO]), SWITCHBOARD_TEST_AGENT_TERMINAL_GRACE_MS: '600' }));
}, 90_000);

afterAll(async () => {
  await Promise.all([a?.server.stop(), b?.server.stop()]);
  await removeTempDir(root);
});

/** An agent on B in its repo (fake-claude answers at once). */
async function agentOnB(name: string): Promise<string> {
  const created = await b.call('POST', '/api/sessions', { name, task: 'Say OK.', folder: b.folderId, worktrees: false, ultracode: false });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  return (created.body as Session).id;
}

/** A's socket to B's terminal through A's paired-machine proxy, with its text so far. */
async function attach(id: string): Promise<{ readonly socket: WebSocket; readonly text: () => string }> {
  const token = (await readFile(path.join(a.dataDir, TOKEN_FILE), 'utf8')).trim();
  const origin = a.baseUrl.replace(/\/$/, '');
  const Socket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
  const socket = new Socket(`${origin.replace('http:', 'ws:')}/api/machines/${bId}/api/terminals/${id}/socket`, { headers: { origin, cookie: `sb_token=${token}` } });
  const frames: TerminalServerFrame[] = [];
  socket.addEventListener('message', (event: MessageEvent) => frames.push(JSON.parse(String(event.data)) as TerminalServerFrame));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('socket refused')), { once: true });
  });
  return { socket, text: () => frames.map((frame) => (frame.t === 'out' ? frame.d : frame.t === 'hello' ? frame.scrollback : '')).join('') };
}

describe('D182 follow-up · the agent’s terminal of a paired computer’s agent', () => {
  it('A opens it for B’s agent: it runs on B in the agent’s folder, echoes over A’s socket, and A’s Close ends it on B', async () => {
    const id = await agentOnB('acme-remote-terminal');
    const opened = await a.call('POST', `/api/sessions/r~${bId}~${id}/terminal`, { cols: 100, rows: 30 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const info = opened.body as TerminalInfo;
    expect(info).toMatchObject({ sessionId: id, cols: 100, rows: 30, cwd: await realpath(b.repo as string) });
    // It is B's terminal (reachable there by its id; not one of A's).
    expect((await b.call('GET', `/api/terminals/${info.id}`)).status).toBe(200);
    expect((await a.call('GET', `/api/terminals/${info.id}`)).status).toBe(404);
    const { socket, text } = await attach(info.id);
    await waitFor('the program on B', async () => text().includes('ready'));
    socket.send(JSON.stringify({ t: 'in', d: 'acme over the tailnet\r' }));
    await waitFor('the echo from B', async () => text().includes('echo:acme over the tailnet'));
    // Leaving the conversation on A: the page's Close goes to B.
    const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event: CloseEvent) => resolve(event.code), { once: true }));
    expect((await a.call('DELETE', `/api/machines/${bId}/api/terminals/${info.id}`)).status).toBe(204);
    expect(await closed).toBe(1000);
    expect((await b.call('GET', `/api/terminals/${info.id}`)).status).toBe(404);
  }, 60_000);

  it('a dropped socket (A’s tab closed) ends it on B after the grace', async () => {
    const id = await agentOnB('acme-remote-grace');
    const info = (await a.call('POST', `/api/sessions/r~${bId}~${id}/terminal`, {})).body as TerminalInfo;
    const { socket, text } = await attach(info.id);
    await waitFor('the program on B', async () => text().includes('ready'));
    // Attached past the grace: it stays.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await b.call('GET', `/api/terminals/${info.id}`)).status).toBe(200);
    socket.close();
    await waitFor('closed on B after its last tab', async () => (await b.call('GET', `/api/terminals/${info.id}`)).status === 404, 20_000);
  }, 60_000);

  it('refuses an archived agent of B, and a browser on A in a profile that does not see B’s agent', async () => {
    const archived = await agentOnB('acme-remote-archived');
    // Its claude process is still live (D33): Archive confirms the stop.
    const archiving = await b.call('POST', `/api/sessions/${archived}/close`, { confirm: true });
    expect(archiving.status, JSON.stringify(archiving.body)).toBeLessThan(300);
    const refused = await a.call('POST', `/api/sessions/r~${bId}~${archived}/terminal`, {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'closed' });
    // A browser on A in another profile (Ann): B's agent (Default's) is not there for it.
    const id = await agentOnB('acme-remote-profile');
    const ann = (await a.call('POST', '/api/user-profiles', { name: 'Ann', color: 'green' })).body as UserProfile;
    const token = (await readFile(path.join(a.dataDir, TOKEN_FILE), 'utf8')).trim();
    const origin = a.baseUrl.replace(/\/$/, '');
    const switched = await fetch(`${origin}/api/user-profiles/switch`, { method: 'POST', headers: { cookie: `sb_token=${token}`, 'content-type': 'application/json', origin }, body: JSON.stringify({ id: ann.id }) });
    await switched.text();
    const annCookie = String(switched.headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect(annCookie).toContain('=');
    const asAnn = await fetch(`${origin}/api/sessions/r~${bId}~${id}/terminal`, { method: 'POST', headers: { cookie: `sb_token=${token}; ${annCookie}`, 'content-type': 'application/json', origin }, body: '{}' });
    await asAnn.text();
    expect([403, 404]).toContain(asAnn.status);
  }, 90_000);
});
