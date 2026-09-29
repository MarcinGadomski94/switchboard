import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem, Schedule, Session, SessionDetail, TerminalLoop } from '../../../src/core/api.ts';
import { parseRemoteId, remoteId } from '../../../src/core/peers.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, startPeerNode, waitFor } from '../../helpers/peers.ts';
import { terminalLoopLines, writeTranscript } from '../../helpers/transcripts.ts';

/**
 * D52 "A peer's schedules and loops" with two real Switchboard processes
 * (fake-claude; `docs/peers.md` → *A peer's schedules and loops*): B manages a
 * schedule that lives and runs on A (create with `machine`, Edit with its remote
 * id, Pause / Resume, Run now, Delete), a failed run's Inbox item retries on A,
 * a hand-started terminal session's `/loop` on A shows on B (read-only, from its
 * transcript) until it is hooked, and after A goes away and B restarts both stay
 * listed from the snapshot with every action refused.
 */

const CS = '5c1e0b52-aaaa-4bbb-8ccc-0123456789ab';

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-schedules');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function world() {
  const paired = await pairedNodes(tmp);
  nodes.push(paired.a, paired.b);
  return paired;
}

function template(node: PeerNode, name: string, task: string) {
  return { name, task, folder: node.folderId, worktrees: false, ultracode: false };
}

async function schedulesOf(node: PeerNode): Promise<Schedule[]> {
  const answer = await node.call('GET', '/api/schedules');
  expect(answer.status).toBe(200);
  return answer.body as Schedule[];
}

const enc = encodeURIComponent;

/** A hand-started terminal session on `node` (a live pid's registry entry) whose transcript ran `/loop 5m` with CronCreate and fired once. */
async function terminalWithLoop(node: PeerNode): Promise<void> {
  const cwd = node.repo as string;
  await mkdir(path.join(node.configDir, 'sessions'), { recursive: true });
  await writeFile(
    path.join(node.configDir, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: CS, cwd, kind: 'interactive', entrypoint: 'cli', startedAt: Date.now() - 60_000, name: 'pc-loop', status: 'idle' }),
  );
  await writeTranscript(node.configDir, cwd, CS, terminalLoopLines({ sessionId: CS, cwd, start: new Date(Date.now() - 400_000) }));
}

describe('D52 · a peer\'s schedules', () => {
  it('B creates, edits, pauses / resumes, runs and deletes a schedule that lives on A; a failed run retries on A', async () => {
    const { a, b, aId, bId } = await world();

    const created = await b.call('POST', '/api/schedules', { machine: aId, cron: '0 2 * * *', template: template(a, 'nightly-a', 'Say OK.') });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const schedule = created.body as Schedule;
    const raw = parseRemoteId(schedule.id);
    expect(raw?.machineId).toBe(aId);
    expect(schedule.machine).toMatchObject({ id: aId, state: 'online' });
    // It lives on A (untagged there), and B lists it at once.
    const onA = await schedulesOf(a);
    expect(onA.map((entry) => [entry.id, entry.name, entry.machine ?? null])).toEqual([[raw?.id, 'nightly-a', null]]);
    expect((await schedulesOf(b)).map((entry) => entry.id)).toEqual([schedule.id]);

    // Edit through its remote id; `machine` naming another machine is refused.
    const edited = await b.call('POST', '/api/schedules', { id: schedule.id, cron: '0 3 * * *', template: template(a, 'nightly-a', 'Say OK twice.') });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ id: schedule.id, cron: '0 3 * * *', description: 'Say OK twice.' });
    expect((await schedulesOf(a))[0]?.cron).toBe('0 3 * * *');
    expect((await b.call('POST', '/api/schedules', { id: schedule.id, machine: bId, cron: '0 3 * * *', template: template(a, 'nightly-a', 'x') })).status).toBe(422);

    const paused = await b.call('POST', `/api/schedules/${enc(schedule.id)}/pause`);
    expect(paused.body).toMatchObject({ id: schedule.id, paused: true, nextRunAt: null });
    expect((await schedulesOf(a))[0]?.paused).toBe(true);
    expect((await b.call('POST', `/api/schedules/${enc(schedule.id)}/resume`)).body).toMatchObject({ paused: false });

    // Run now: the run starts on A; its session is A's (a remote id on B); the result follows on B.
    const run = await b.call('POST', `/api/schedules/${enc(schedule.id)}/run`);
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    const first = (run.body as Schedule).runs[0];
    expect(first).toMatchObject({ result: 'running', triggeredBy: 'manual' });
    expect(parseRemoteId(first?.sessionId)?.machineId).toBe(aId);
    await waitFor('the run ok on B', async () => (await schedulesOf(b)).find((entry) => entry.id === schedule.id)?.runs[0]?.result === 'ok', 30_000);

    // A failed run: its Inbox item on B carries A's tag and the fix session's folder; Retry run runs it on A again.
    const crashing = (await b.call('POST', '/api/schedules', { machine: aId, cron: '0 2 * * *', template: template(a, 'crashing', '[fake:crash] Build.') })).body as Schedule;
    expect((await b.call('POST', `/api/schedules/${enc(crashing.id)}/run`)).status).toBe(200);
    const item = await waitFor('the failed-run item on B', async () =>
      ((await b.call('GET', '/api/inbox')).body as InboxItem[]).find((entry) => entry.kind === 'system' && entry.source === 'crashing'),
    );
    expect(item.machine?.id).toBe(aId);
    expect(item.prefill?.folder).toBe(a.folderId);
    expect((await b.call('POST', `/api/inbox/${enc(item.id)}/actions/retry-run`)).status).toBe(204);
    await waitFor('two failed runs on A', async () => (await schedulesOf(a)).find((entry) => entry.name === 'crashing')?.runs.map((r) => r.result).join() === 'fail,fail', 30_000);

    // Delete: gone on A and on B.
    expect((await b.call('DELETE', `/api/schedules/${enc(schedule.id)}`)).status).toBe(204);
    expect((await schedulesOf(a)).map((entry) => entry.name)).toEqual(['crashing']);
    expect((await schedulesOf(b)).map((entry) => entry.name)).toEqual(['crashing']);
    // A's own view never lists B's (B has none) nor its own twice; a peer's request gets A's own only.
    expect((await schedulesOf(a)).every((entry) => !entry.machine)).toBe(true);
  }, 90_000);
});

describe('D52 · a peer\'s loops', () => {
  it('a terminal /loop on A shows on A and on B (tagged) until it is hooked; hooked, it is the session\'s loop', async () => {
    const { a, b, aId } = await world();
    await terminalWithLoop(a);

    const local = await waitFor('A lists its terminal loop', async () => {
      const list = (await a.call('GET', '/api/terminal-loops')).body as TerminalLoop[];
      return list.length > 0 ? list : null;
    });
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({ loop: { id: `term:${CS}:loop`, sessionId: CS, kind: '/loop', label: '/loop 5m', iteration: 2 }, terminal: { id: CS, name: 'pc-loop' } });
    expect(local[0]?.machine ?? null).toBeNull();

    const remote = await waitFor('B lists A\'s terminal loop', async () =>
      ((await b.call('GET', '/api/terminal-loops')).body as TerminalLoop[]).find((entry) => entry.terminal.id === CS),
    );
    expect(remote.loop.id).toBe(remoteId(aId, `term:${CS}:loop`));
    expect(remote.machine).toMatchObject({ id: aId, state: 'online' });

    // "Hook into…" from B: A follows it; its loop is now the hooked session's (derived from the imported events).
    const hooked = await b.call('POST', `/api/machines/${aId}/api/terminal-sessions/${CS}/hook`);
    expect(hooked.status, JSON.stringify(hooked.body)).toBe(201);
    const session = hooked.body as Session;
    expect((await a.call('GET', '/api/terminal-loops')).body).toEqual([]);
    const detail = await waitFor('the hooked session\'s loop on B', async () => {
      const answer = (await b.call('GET', `/api/sessions/${enc(session.id)}`)).body as SessionDetail;
      return answer.loops?.some((loop) => loop.kind === '/loop') ? answer : null;
    });
    expect(detail.loops?.[0]?.sessionId).toBe(session.id);
    await waitFor('B drops the terminal loop', async () => !((await b.call('GET', '/api/terminal-loops')).body as TerminalLoop[]).some((entry) => entry.terminal.id === CS), 30_000);
  }, 90_000);
});

describe('D52 · offline: the snapshot stays listed, every action is refused', () => {
  it('after A goes away and B restarts, A\'s schedule and terminal loop are listed (unreachable); Run now / Pause / Delete / Save answer 502', async () => {
    const started = await world();
    const { aId } = started;
    let { a, b } = started;
    await terminalWithLoop(a);
    const schedule = (await b.call('POST', '/api/schedules', { machine: aId, cron: '0 2 * * *', template: template(a, 'kept', 'Say OK.') })).body as Schedule;
    await waitFor('B has A\'s terminal loop', async () => ((await b.call('GET', '/api/terminal-loops')).body as TerminalLoop[]).length > 0);

    await a.server.stop();
    await b.server.stop();
    nodes = nodes.filter((node) => node !== a && node !== b);
    b = await startPeerNode(tmp, 'b', { repo: true });
    nodes.push(b);

    const listed = (await schedulesOf(b)).find((entry) => entry.id === schedule.id);
    expect(listed?.name).toBe('kept');
    expect(listed?.machine).toMatchObject({ id: aId, state: expect.not.stringMatching(/^online$/) });
    const loops = (await b.call('GET', '/api/terminal-loops')).body as TerminalLoop[];
    expect(loops.map((entry) => [entry.loop.kind, entry.machine?.id])).toEqual([['/loop', aId]]);
    expect(loops[0]?.machine?.state).not.toBe('online');

    for (const [method, route, body] of [
      ['POST', `/api/schedules/${enc(schedule.id)}/run`, undefined],
      ['POST', `/api/schedules/${enc(schedule.id)}/pause`, undefined],
      ['DELETE', `/api/schedules/${enc(schedule.id)}`, undefined],
      ['POST', '/api/schedules', { id: schedule.id, cron: '0 4 * * *', template: template(a, 'kept', 'x') }],
      ['POST', '/api/schedules', { machine: aId, cron: '0 4 * * *', template: template(a, 'other', 'x') }],
    ] as const) {
      const refused = await b.call(method, route, body);
      expect(refused.status, `${method} ${route}`).toBe(502);
      expect(refused.body).toMatchObject({ error: 'peer-unreachable', message: expect.stringMatching(/is offline — reconnect to continue$/) });
    }

    // A is back: live again.
    a = await startPeerNode(tmp, 'a', { repo: true });
    nodes.push(a);
    await waitFor('A online again on B', async () => (await machineOn(b, aId))?.state === 'online', 60_000);
    expect((await b.call('POST', `/api/schedules/${enc(schedule.id)}/pause`)).body).toMatchObject({ paused: true, machine: { state: 'online' } });
  }, 120_000);
});
