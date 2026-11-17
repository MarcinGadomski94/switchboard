import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MachinesView } from '../../../src/core/peers.ts';
import type { TerminalInfo, TerminalServerFrame, TerminalsView } from '../../../src/core/terminals.ts';
import { TOKEN_FILE } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D170 (`docs/terminals.md` → *Paired computers*): computer A's browser opens a terminal on paired
 * computer B and types into it: the routes through the paired-machine proxy, the socket piped
 * through B's peer listener (`/peer/v1/terminals/{id}/socket`, its bearer token). B runs a
 * deterministic echo program (`SWITCHBOARD_TEST_TERMINAL_ARGV`), never a shell. B's peer socket
 * without the pairing's token is refused.
 */

const ECHO = "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('echo:'+d.trim()+'\\r\\n'));process.stdout.write('ready\\r\\n')";

let root: string;
let a: PeerNode;
let b: PeerNode;
let bId: string;

beforeAll(async () => {
  root = await makeTempDir('peer-terminals');
  ({ a, b, bId } = await pairedNodes(root, { SWITCHBOARD_TEST_TERMINAL_ARGV: JSON.stringify([process.execPath, '-e', ECHO]) }));
}, 90_000);

afterAll(async () => {
  await Promise.all([a?.server.stop(), b?.server.stop()]);
  await removeTempDir(root);
});

describe('D170 · a terminal on the paired computer', () => {
  it('A opens it on B, types and sees the echo through the peer link; B lists it as its own; Close on A ends it on B', async () => {
    const created = await a.call('POST', `/api/machines/${bId}/api/terminals`, {});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body as TerminalInfo).id;
    expect(((await b.call('GET', '/api/terminals')).body as TerminalsView).terminals.map((t) => t.id)).toEqual([id]);
    expect(((await a.call('GET', `/api/machines/${bId}/api/terminals`)).body as TerminalsView).terminals.map((t) => t.id)).toEqual([id]);

    const token = (await readFile(path.join(a.dataDir, TOKEN_FILE), 'utf8')).trim();
    const aOrigin = a.baseUrl.replace(/\/$/, '');
    const Socket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
    const socket = new Socket(`${aOrigin.replace('http:', 'ws:')}/api/machines/${bId}/api/terminals/${id}/socket`, { headers: { origin: aOrigin, cookie: `sb_token=${token}` } });
    const frames: TerminalServerFrame[] = [];
    socket.addEventListener('message', (event: MessageEvent) => frames.push(JSON.parse(String(event.data)) as TerminalServerFrame));
    const text = (): string => frames.map((frame) => (frame.t === 'out' ? frame.d : frame.t === 'hello' ? frame.scrollback : '')).join('');
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('socket refused')), { once: true });
    });
    await waitFor('the hello from B', async () => frames[0]?.t === 'hello');
    await waitFor('the program on B', async () => text().includes('ready'));
    socket.send(JSON.stringify({ t: 'in', d: 'over the tailnet\r' }));
    await waitFor('the echo from B', async () => text().includes('echo:over the tailnet'));

    const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event: CloseEvent) => resolve(event.code), { once: true }));
    expect((await a.call('DELETE', `/api/machines/${bId}/api/terminals/${id}`)).status).toBe(204);
    expect(await closed).toBe(1000);
    expect(((await b.call('GET', '/api/terminals')).body as TerminalsView).terminals).toEqual([]);
  });

  it('B’s peer socket refuses a caller without the pairing’s token, and any Origin', async () => {
    const listening = ((await b.call('GET', '/api/machines')).body as MachinesView).listener.listening as string;
    const [host, port] = listening.split(':') as [string, string];
    const upgrade = (headers: Record<string, string>): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = http.request({ host, port: Number(port), path: '/peer/v1/terminals/x/socket', agent: false, headers: { host: listening, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), ...headers } });
        req.on('response', (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('upgrade', () => resolve(101));
        req.on('error', reject);
        req.end();
      });
    expect(await upgrade({})).toBe(401);
    expect(await upgrade({ authorization: 'Bearer nope' })).toBe(401);
    expect(await upgrade({ origin: 'http://evil.example' })).toBe(403);
  });
});
