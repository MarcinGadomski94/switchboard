import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { remoteId } from '../../../src/core/peers.ts';
import type { TakeoverRun } from '../../../src/core/takeover.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { type PeerNode, waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * The move log (`docs/peers.md` → *The move log`, `docs/service.md` → *Following a
 * move*): two real Switchboards (pino logger on, the 2.4.18 request-log filter on,
 * as the service runs). Every take-over writes `move:` lines with the run id, one per
 * step transition, on the machine that runs the step; the initiating machine adds the
 * start and the outcome. A failure says the step and the reason (scrubbed), and the
 * undo on both sides.
 */

let tmp: string;
let world: TakeoverWorld | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('takeover-move-log');
});
afterEach(async () => {
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  world = null;
  await removeWorld(tmp);
});

interface MoveLine {
  readonly level: number;
  readonly time: number;
  readonly msg: string;
  readonly run: string;
  readonly step: string;
  readonly state: string;
  readonly side?: string;
  readonly ms?: number;
  readonly reason?: string;
  readonly [field: string]: unknown;
}

/** The node's `move:` lines of run `id` (its stdout, pino JSON). */
function moveLines(node: PeerNode, id: string): MoveLine[] {
  return node.server
    .output()
    .split('\n')
    .filter((line) => line.startsWith('{') && line.includes('"msg":"move:'))
    .map((line) => JSON.parse(line) as MoveLine)
    .filter((line) => line.run === id);
}

/** `step state` of each line, in order. */
function sequence(lines: readonly MoveLine[]): string[] {
  return lines.map((line) => `${line.step} ${line.state}`);
}

async function run(node: PeerNode, body: Record<string, unknown>): Promise<TakeoverRun> {
  const started = await node.call('POST', '/api/takeover', body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const id = (started.body as TakeoverRun).id;
  return waitFor('the take-over to end', async () => {
    const current = (await node.call('GET', `/api/takeover/runs/${id}`)).body as TakeoverRun;
    return current.state === 'running' ? null : current;
  }, 90_000);
}

/** Waits until `node` has logged run `id`'s line `step state` (the peer's last answer and its log line race a little). */
async function logged(node: PeerNode, id: string, step: string, state: string): Promise<MoveLine[]> {
  return waitFor(`${step} ${state} in the log`, async () => {
    const lines = moveLines(node, id);
    return lines.some((line) => line.step === step && line.state === state) ? lines : null;
  });
}

describe('the move log', () => {
  it('a plain Move to computer: the source logs the start, its own steps and the outcome; the target logs its steps', async () => {
    const w = (world = await takeoverWorld(tmp));
    const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'log-me');
    await writeFile(path.join(w.paths.a.alpha, 'tracked.txt'), 'uncommitted on the pc\n');

    const finished = await run(w.a, { sessionId: started.id, targetMachine: w.bId });
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    const id = finished.id;

    // The pc (source and initiating machine).
    const a = await logged(w.a, id, 'outcome', 'done');
    expect(sequence(a)).toEqual([
      'start started',
      'checks started',
      'checks finished',
      'stop started',
      'stop finished',
      'capture started',
      'push started',
      'push finished',
      'capture finished',
      'files started',
      'files finished',
      ...a.filter((line) => line.step === 'transfer').map((line) => `transfer ${line.state}`),
      'finish started',
      'finish finished',
      'outcome done',
    ]);
    const start = a[0] as MoveLine;
    expect(start).toMatchObject({ msg: 'move: start', level: 30, run: id, session: started.id, title: 'log-me', initiator: 'source' });
    expect(typeof start['source']).toBe('string');
    expect(typeof start['target']).toBe('string');
    expect(start['source']).not.toBe(start['target']);
    expect(a.find((line) => line.step === 'checks' && line.state === 'finished')).toMatchObject({ msg: 'move: checks finished', side: 'source', title: 'log-me', repos: ['alpha'] });
    expect(a.find((line) => line.step === 'push' && line.state === 'finished')).toMatchObject({ repo: 'alpha', uncommitted: 1, wip: true });
    expect(a.filter((line) => line.step === 'transfer' && line.state === 'finished').length).toBeGreaterThan(0);
    for (const line of a) {
      expect(typeof line.time).toBe('number');
      if (line.state === 'finished') expect(typeof line.ms).toBe('number');
      if (line.step !== 'start' && line.step !== 'outcome') expect(line.side).toBe('source');
    }
    expect(a.at(-1)).toMatchObject({ msg: 'move: done', state: 'done', leftovers: [] });

    // The mac (target): its own steps, the same run id; no start or outcome (it did not start the run).
    const b = await logged(w.b, id, 'close', 'finished');
    expect(sequence(b).filter((entry) => !entry.startsWith('transfer'))).toEqual([
      'plan started',
      'plan finished',
      'apply started',
      'restore started',
      'restore finished',
      'apply finished',
      'resume started',
      'resume finished',
      'close started',
      'close finished',
    ]);
    expect(b.every((line) => line.side === 'target')).toBe(true);
    expect(b.find((line) => line.step === 'plan' && line.state === 'finished')).toMatchObject({ repos: ['alpha:use'], blockers: 0 });
    expect(b.filter((line) => line.step === 'transfer' && line.state === 'finished').length).toBe(a.filter((line) => line.step === 'transfer' && line.state === 'finished').length);
  }, 180_000);

  it('a failure (a diverged branch on the target): the failing step with its reason, scrubbed, the undo on both sides and the outcome', async () => {
    const w = (world = await takeoverWorld(tmp));
    // A branch name shaped like a token: it is in the failure's text, never in the log.
    const secret = 'ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6';
    const branch = `feature/${secret}`;
    const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'will-fail');
    await w.git(w.paths.a.alpha, 'checkout', '-q', '-b', branch);
    await writeFile(path.join(w.paths.a.alpha, 'a-side.txt'), 'from the pc\n');
    await w.git(w.paths.a.alpha, 'add', '-A');
    await w.git(w.paths.a.alpha, 'commit', '-q', '-m', 'pc commit');
    await w.git(w.paths.b.alpha, 'checkout', '-q', '-b', branch);
    await writeFile(path.join(w.paths.b.alpha, 'b-side.txt'), 'from the mac\n');
    await w.git(w.paths.b.alpha, 'add', '-A');
    await w.git(w.paths.b.alpha, 'commit', '-q', '-m', 'mac commit');
    await w.git(w.paths.b.alpha, 'checkout', '-q', 'main');

    // Taken over from the mac's screen: the mac is the target and the initiating machine.
    const finished = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(finished).toMatchObject({ state: 'failed', rolledBack: true, error: { step: 'apply' } });
    expect(finished.error?.message).toContain(secret);
    const id = finished.id;

    const b = await logged(w.b, id, 'outcome', 'failed');
    const steps = sequence(b).filter((entry) => !entry.startsWith('transfer'));
    expect(steps).toEqual(['start started', 'plan started', 'plan finished', 'apply started', 'restore started', 'restore failed', 'apply failed', 'undo started', 'undo finished', 'outcome failed']);
    expect(b[0]).toMatchObject({ msg: 'move: start', initiator: 'target', session: started.id, title: 'will-fail' });
    const failed = b.find((line) => line.step === 'apply' && line.state === 'failed') as MoveLine;
    expect(failed).toMatchObject({ msg: 'move: apply failed', level: 40, side: 'target' });
    expect(typeof failed.ms).toBe('number');
    expect(failed.reason).toContain('has commits the original does not have');
    expect(failed.reason).toContain('feature/[redacted]');
    expect(b.find((line) => line.step === 'restore' && line.state === 'failed')).toMatchObject({ repo: 'alpha', level: 40 });
    expect(b.at(-1)).toMatchObject({ msg: 'move: failed at apply, rolled back', level: 40, state: 'failed', failedAt: 'apply', rolledBack: true, leftovers: [] });

    // The pc (source): its steps up to the transfer, then its rollback.
    const a = await logged(w.a, id, 'rollback', 'finished');
    expect(sequence(a).filter((entry) => !entry.startsWith('transfer'))).toEqual([
      'checks started',
      'checks finished',
      'stop started',
      'stop finished',
      'capture started',
      'push started',
      'push finished',
      'capture finished',
      'files started',
      'files finished',
      'rollback started',
      'rollback finished',
    ]);
    expect(a.find((line) => line.step === 'rollback' && line.state === 'finished')).toMatchObject({ notes: ['the session runs here again'] });

    // Nothing secret anywhere in either machine's move log.
    for (const line of [...moveLines(w.a, id), ...moveLines(w.b, id)]) expect(JSON.stringify(line)).not.toContain(secret);
  }, 180_000);
});
