import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OwnedLoop, Session, SessionEvent } from '../../../src/core/api.ts';
import type { UserPayload } from '../../../src/core/event-payload.ts';
import { remoteId } from '../../../src/core/peers.ts';
import type { TakeoverRun as Run } from '../../../src/core/takeover.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, startPeerNode, waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, fakeLog, removeWorld, startRepoSession, takeoverWorld } from '../../helpers/takeover.ts';
import { assistantTextLine, lastUuid, terminalUserLine, writeTranscript } from '../../helpers/transcripts.ts';

/**
 * D94 with real Switchboard processes (fake CLIs): a Switchboard loop survives a
 * hooked session's Continue in Switchboard (D72: same session, it now fires into
 * the supervised process), a paired machine's session's loops are created and run
 * through the proxy (they fire on that machine, D48), and they travel with a
 * take-over (D65: re-created on the target, ended on the source). Firings here are
 * Run now (the real clock drives the timer in these processes).
 */

const CS = '5a6b7c8d-1234-4abc-8def-0123456789ab';

let tmp: string;
let nodes: PeerNode[] = [];
let children: ChildProcess[] = [];
let world: TakeoverWorld | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('owned-loops-peers');
});
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  if (world) {
    await Promise.all([world.a.server.stop(), world.b.server.stop()]);
    world = null;
    await removeWorld(tmp);
  } else {
    await removeTempDir(tmp);
  }
});

async function events(node: PeerNode, id: string): Promise<SessionEvent[]> {
  return (await node.call('GET', `/api/sessions/${id}/events`)).body as SessionEvent[];
}

function firingsOf(list: readonly SessionEvent[]): UserPayload[] {
  return list.map((event) => event.payload as UserPayload).filter((payload) => payload?.type === 'user' && payload.loop !== undefined);
}

describe('D94 × D72 · a hooked session continued in Switchboard', () => {
  it('keeps its loop (same session); Run now then reaches the new supervised process', async () => {
    const log = path.join(tmp, 'fake-claude.log');
    const node = await startPeerNode(tmp, 'a', { repo: true, env: { FAKE_CLAUDE_LOG: log } });
    nodes.push(node);
    const cwd = node.repo as string;
    const terminal = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', shell: false });
    children.push(terminal);
    const exited = new Promise<void>((resolve) => terminal.once('exit', () => resolve()));
    await mkdir(path.join(node.configDir, 'sessions'), { recursive: true });
    await writeFile(
      path.join(node.configDir, 'sessions', `${terminal.pid}.json`),
      JSON.stringify({ pid: terminal.pid, sessionId: CS, cwd, kind: 'interactive', entrypoint: 'cli', startedAt: Date.now() - 60_000, name: 'pc-terminal', status: 'idle' }),
    );
    const lines = [terminalUserLine({ sessionId: CS, cwd, content: 'Watch the build.', parentUuid: null, timestamp: new Date(Date.now() - 50_000).toISOString() })];
    lines.push(assistantTextLine({ sessionId: CS, cwd, text: 'Watching.', parentUuid: lastUuid(lines), timestamp: new Date(Date.now() - 40_000).toISOString() }));
    await writeTranscript(node.configDir, cwd, CS, lines);
    const hooked = (await node.call('POST', `/api/terminal-sessions/${CS}/hook`)).body as Session;
    const created = await node.call('POST', `/api/sessions/${hooked.id}/loops`, { prompt: 'Is the build green?', everyMinutes: 60, label: 'Build' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const loop = created.body as OwnedLoop;

    terminal.kill('SIGKILL');
    await exited;
    await waitFor('the registry to drop it', async () => ((await node.call('GET', '/api/terminal-sessions')).body as unknown[]).length === 0);
    const continued = await node.call('POST', `/api/sessions/${hooked.id}/continue-in-switchboard`, {});
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    expect((continued.body as Session).ownedLoops?.map((l) => [l.id, l.state])).toEqual([[loop.id, 'active']]);

    const ran = await node.call('POST', `/api/sessions/${hooked.id}/loops/${loop.id}/run`);
    expect(ran.status, JSON.stringify(ran.body)).toBe(200);
    expect(ran.body).toMatchObject({ runs: 1 });
    await waitFor('the firing in the resumed process', async () => {
      const stdin = (await fakeLog(log)).filter((entry) => entry['kind'] === 'stdin').map((entry) => String(entry['line']));
      return stdin.some((line) => line.includes('Is the build green?')) ? true : null;
    }, 30_000);
    expect(firingsOf(await events(node, hooked.id))).toEqual([expect.objectContaining({ text: 'Is the build green?', origin: 'service', loop: { id: loop.id, label: 'Build', run: 1 } })]);
  }, 90_000);
});

describe('D94 × D48 · a paired machine\'s session', () => {
  it('B creates, lists, runs, pauses and cancels a loop of A\'s session through the proxy; it fires on A', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const started = await a.call('POST', '/api/sessions', { name: 'loops-on-a', task: 'Say hi.', folder: a.folderId, worktrees: false, ultracode: false });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const local = (started.body as Session).id;
    const remote = remoteId(aId, local);
    const id = encodeURIComponent(remote);
    await waitFor('A idle', async () => (['done', 'idle'].includes(((await a.call('GET', `/api/sessions/${local}`)).body as Session).status) ? true : null), 30_000);

    const created = await b.call('POST', `/api/sessions/${id}/loops`, { prompt: 'Report the queue.', everyMinutes: 45, label: 'Queue' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const loop = created.body as OwnedLoop;
    expect(loop).toMatchObject({ sessionId: remote, createdBy: 'developer', title: 'Queue' });
    // Stored on A.
    expect(((await a.call('GET', `/api/sessions/${local}/loops`)).body as OwnedLoop[]).map((l) => [l.id, l.sessionId])).toEqual([[loop.id, local]]);
    expect(((await b.call('GET', `/api/sessions/${id}/loops`)).body as OwnedLoop[]).map((l) => l.sessionId)).toEqual([remote]);
    // B's session list carries it (the cards), with the remote session id.
    await waitFor('the loop on B\'s list', async () => {
      const sessions = (await b.call('GET', '/api/sessions')).body as Session[];
      return sessions.find((s) => s.id === remote)?.ownedLoops?.[0]?.sessionId === remote ? true : null;
    });

    expect((await b.call('POST', `/api/sessions/${id}/loops/${loop.id}/run`)).body).toMatchObject({ runs: 1, sessionId: remote });
    await waitFor('the firing on A', async () => (firingsOf(await events(a, local)).length === 1 ? true : null), 30_000);
    expect((await b.call('POST', `/api/sessions/${id}/loops/${loop.id}/pause`)).body).toMatchObject({ state: 'paused' });
    expect((await b.call('PUT', `/api/sessions/${id}/loops/${loop.id}`, { everyMinutes: 90 })).body).toMatchObject({ scheduleText: 'every 1 h 30 min', state: 'paused' });
    expect((await b.call('DELETE', `/api/sessions/${id}/loops/${loop.id}`)).status).toBe(204);
    expect((await a.call('GET', `/api/sessions/${local}/loops`)).body).toEqual([]);
  }, 90_000);
});

describe('D94 × D65 · take-over', () => {
  it('the loops travel with the session: re-created on the target, ended on the source', async () => {
    const w = (world = await takeoverWorld(tmp));
    const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'loop-mover');
    const made = await w.a.call('POST', `/api/sessions/${started.id}/loops`, { prompt: 'Keep checking the release.', everyMinutes: 30, label: 'Release', maxRuns: 10 });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const begun = await w.b.call('POST', '/api/takeover', { sessionId: remoteId(w.aId, started.id) });
    expect(begun.status, JSON.stringify(begun.body)).toBe(202);
    const runId = (begun.body as Run).id;
    const finished = await waitFor('the take-over to end', async () => {
      const current = (await w.b.call('GET', `/api/takeover/runs/${runId}`)).body as Run;
      return current.state === 'running' ? null : current;
    }, 90_000);
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    const created = ((await w.b.call('GET', '/api/sessions')).body as Session[]).find((s) => s.movedFrom?.sessionId === started.id) as Session;
    expect(created).toBeTruthy();
    const moved = (await w.b.call('GET', `/api/sessions/${created.id}/loops`)).body as OwnedLoop[];
    expect(moved.map((l) => [l.title, l.prompt, l.state, l.maxRuns, l.scheduleText])).toEqual([['Release', 'Keep checking the release.', 'active', 10, 'every 30 min']]);
    const source = (await w.a.call('GET', `/api/sessions/${started.id}/loops`)).body as OwnedLoop[];
    expect(source.map((l) => [l.state, l.endedReason])).toEqual([['ended', expect.stringMatching(/^the session moved to /)]]);
  }, 150_000);
});
