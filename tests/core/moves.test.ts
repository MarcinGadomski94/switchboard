import { describe, expect, it } from 'vitest';
import {
  MOVE_KEEP_MAX,
  MOVE_RETENTION_MS,
  type MoveRecord,
  activeMove,
  homeMoves,
  moveAgentKeys,
  moveAsRun,
  moveBadgeText,
  moveFailedDetail,
  moveFailedTitle,
  moveFromPeer,
  moveOutcomeText,
  moveRetry,
  prunedMoves,
  viewMove,
} from '../../src/core/moves.ts';
import { TAKEOVER_STEPS, TAKEOVER_STEP_LABELS } from '../../src/core/takeover.ts';

/** D154 · the moves list's pure rules (`src/core/moves.ts`): badges, Home's card, the item's texts, a peer's move, Try again. */

const MAC = 'macmacmacmac';
const PC = 'pcpcpcpcpcpc';

function move(overrides: Partial<MoveRecord> = {}): MoveRecord {
  return {
    id: 'run-1',
    kind: 'agent',
    title: 'Checkout fix',
    member: null,
    source: { id: MAC, name: 'mac-laptop', sessionId: 's1' },
    target: { id: PC, name: 'pc-office', sessionId: null },
    agentSessionId: 's1',
    state: 'running',
    step: { id: 'transfer', label: TAKEOVER_STEP_LABELS.transfer, detail: '10 of 20 KB' },
    steps: TAKEOVER_STEPS.map((id) => ({ id, label: TAKEOVER_STEP_LABELS[id], status: 'pending', detail: null })),
    startedAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:01:00.000Z',
    endedAt: null,
    error: null,
    rolledBack: null,
    rollbackNotes: [],
    interrupted: false,
    leftovers: [],
    stashes: [],
    choices: { placement: { roots: ['D:\\code'] }, clonePaths: {}, workspaceFiles: null, excludeRepos: [], stashTargets: ['D:\\code\\alpha'] },
    ...overrides,
  };
}

const failed = move({ state: 'failed', step: { id: 'apply', label: TAKEOVER_STEP_LABELS.apply, detail: null }, error: { step: 'apply', message: 'alpha: the branch has commits the original does not have.' }, rolledBack: false, rollbackNotes: ['the temporary branch could not be deleted'], endedAt: '2026-11-05T10:03:00.000Z' });

describe('the moves list (D154)', () => {
  it('a badge says where it moves and the step in short words', () => {
    expect(moveBadgeText(move())).toBe('Moving to pc-office… (copying the chat)');
    expect(moveBadgeText(move({ step: { id: 'apply', label: TAKEOVER_STEP_LABELS.apply, detail: null } }))).toBe('Moving to pc-office… (restoring the code)');
    expect(moveBadgeText(move({ step: null }))).toBe('Moving to pc-office…');
  });

  it('the outcome and the failure item say the step, the reason, what the undo left, where the agent runs, the leftovers and the stash', () => {
    expect(moveOutcomeText(move({ state: 'done', step: null, endedAt: '2026-11-05T10:03:00.000Z' }))).toBe('Checkout fix now runs on pc-office.');
    expect(moveOutcomeText(failed)).toBe('Restoring the working tree here failed: alpha: the branch has commits the original does not have. Undoing it left something behind: the temporary branch could not be deleted. Checkout fix still runs on mac-laptop.');
    expect(moveFailedTitle({ ...failed, member: { id: 'm1', name: 'Developer', teamId: 't', teamName: 'Core' } })).toBe('Couldn’t move Developer to pc-office');
    const detail = moveFailedDetail({ ...failed, leftovers: [{ id: 'l1', repoPath: '/a', remoteName: 'origin', remoteUrl: 'u', branch: 'switchboard/takeover/x/main', at: '', reason: null, machineId: null }], stashes: [{ path: 'D:\\code\\alpha', machine: 'pc-office', message: 'switchboard: before moving', files: 3, commit: null }] });
    expect(detail).toContain('1 temporary branch is still on the remote: open the move to delete it.');
    expect(detail).toContain('Stashed 3 uncommitted files in D:\\code\\alpha on pc-office as "switchboard: before moving".');
    expect(moveOutcomeText({ ...failed, interrupted: true, rolledBack: null })).toBe('Restoring the working tree here failed: alpha: the branch has commits the original does not have. Checkout fix still runs on mac-laptop.');
  });

  it('the same agent across machines: its source session, the new one once done, its member', () => {
    expect(moveAgentKeys(move())).toEqual([`session:${MAC}:s1`]);
    expect(moveAgentKeys(move({ state: 'done', target: { id: PC, name: 'pc-office', sessionId: 's9' }, member: { id: 'm1', name: 'D', teamId: 't', teamName: 'C' } }))).toEqual([`session:${MAC}:s1`, `session:${PC}:s9`, 'member:m1']);
  });

  it('each machine names the agent its own way; a peer’s move gets a remote id, its machine, the leftovers’ machine from here', () => {
    expect(viewMove(move(), PC).agentSessionId).toBe(`r~${MAC}~s1`);
    expect(viewMove(move({ state: 'done', target: { id: PC, name: 'pc-office', sessionId: 's9' } }), PC).agentSessionId).toBe('s9');
    const fromMac = moveFromPeer({ id: MAC, name: 'mac-laptop', state: 'online' }, PC, { ...failed, leftovers: [{ id: 'l1', repoPath: '/a', remoteName: 'origin', remoteUrl: 'u', branch: 'b', at: '', reason: null, machineId: null }] });
    expect(fromMac).toMatchObject({ id: `r~${MAC}~run-1`, machine: { id: MAC, name: 'mac-laptop', state: 'online' }, agentSessionId: `r~${MAC}~s1` });
    expect(fromMac?.leftovers[0]?.machineId).toBe(MAC);
    expect(moveFromPeer({ id: MAC, name: 'mac-laptop', state: 'online' }, PC, { nope: true })).toBeNull();
  });

  it('a running move is found by the agent, the teammate or the crew', () => {
    const teammate = move({ id: 'run-2', kind: 'teammate', member: { id: 'm1', name: 'Developer', teamId: 'crew-1', teamName: 'Core' }, agentSessionId: 's2' });
    const list = [failed, teammate, move()];
    expect(activeMove(list, { sessionId: 's1' })?.id).toBe('run-1');
    expect(activeMove([failed], { sessionId: 's1' })).toBeNull();
    expect(activeMove(list, { memberId: 'm1' })?.id).toBe('run-2');
    expect(activeMove(list, { teamId: 'crew-1' })?.id).toBe('run-2');
    expect(activeMove(list, { teamId: 'crew-2' })).toBeNull();
  });

  it('Home: the running ones oldest first, the finished ones newest first, nothing older than a day', () => {
    const now = Date.parse('2026-11-05T12:00:00.000Z');
    const old = move({ id: 'old', state: 'done', step: null, endedAt: new Date(now - MOVE_RETENTION_MS - 1).toISOString() });
    const done = move({ id: 'done', state: 'done', step: null, endedAt: '2026-11-05T11:00:00.000Z' });
    const second = move({ id: 'second', startedAt: '2026-11-05T11:30:00.000Z' });
    const card = homeMoves([second, done, old, failed, move()], now);
    expect(card.running.map((entry) => entry.id)).toEqual(['run-1', 'second']);
    expect(card.finished.map((entry) => entry.id)).toEqual(['done', 'run-1']);
  });

  it('keeps running moves and at most the newest finished ones within the retention', () => {
    const now = Date.parse('2026-11-05T12:00:00.000Z');
    const many = Array.from({ length: MOVE_KEEP_MAX + 5 }, (_, n) => move({ id: `m${n}`, state: 'done', step: null, startedAt: new Date(now - (n + 1) * 60_000).toISOString(), endedAt: new Date(now - n * 60_000).toISOString() }));
    const kept = prunedMoves([...many, move({ id: 'live' })], now);
    expect(kept).toHaveLength(MOVE_KEEP_MAX);
    expect(kept[0]?.id).toBe('live');
    expect(kept.at(-1)?.id).toBe(`m${MOVE_KEEP_MAX - 2}`);
  });

  it('Try again: the same agent (still on the source) to the same computer, with the last choices, from either machine', () => {
    expect(moveRetry(failed, MAC)).toEqual({ kind: 'agent', sessionId: 's1', targetMachine: PC, targetId: PC, machineName: 'pc-office', title: 'Checkout fix', member: null, choices: failed.choices });
    // On the target: the agent comes here (Move here), from the source computer.
    expect(moveRetry(failed, PC)).toMatchObject({ sessionId: `r~${MAC}~s1`, targetMachine: null, targetId: PC, machineName: 'mac-laptop' });
  });

  it('a record reads as the take-over run the dialog shows', () => {
    const run = moveAsRun(move({ state: 'done', step: null, target: { id: PC, name: 'pc-office', sessionId: 's9' }, agentSessionId: `r~${PC}~s9` }), ['git push']);
    expect(run.result).toEqual({ sessionId: `r~${PC}~s9`, machineName: 'pc-office', machineId: PC, local: false });
    expect(run.log).toEqual(['git push']);
  });
});
