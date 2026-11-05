import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../src/core/api.ts';
import type { MoveRecord } from '../../src/core/moves.ts';
import { peerInboxItem } from '../../src/core/peer-wire.ts';
import { cardButtons, isLinkAction, openTargetOf } from '../../src/web/v2/shared/answer-model.ts';
import { fromInbox, inboxKindOf } from '../../src/web/v2/shared/needs-you-model.ts';
import { applyMoveChange } from '../../src/core/moves.ts';
import { choiceOfRetry, retryRequest } from '../../src/web/takeover/retry-model.ts';
import { MOVE_TRY_AGAIN } from '../../src/web/views/inbox.ts';

/** D154 · the web side of the moves list: the failed move's Needs-you card, the live list's changes, Try again's request. */

const MAC = 'macmacmacmac';
const PC = 'pcpcpcpcpcpc';

const MOVE = {
  id: 'run-1',
  kind: 'agent' as const,
  title: 'Checkout fix',
  member: null,
  source: { id: MAC, name: 'mac-laptop', sessionId: 's1' },
  target: { id: PC, name: 'pc-office', sessionId: null },
  choices: { placement: { roots: ['D:\\code'] }, clonePaths: { alpha: 'D:\\code\\alpha' }, workspaceFiles: { copy: ['AGENTS.md'] }, excludeRepos: [], stashTargets: ['D:\\code\\alpha'] },
};

const ITEM: InboxItem = {
  id: 'item-1',
  kind: 'system',
  sessionId: 's1',
  source: 'Checkout fix',
  status: 'fail',
  title: 'Couldn’t move Checkout fix to pc-office',
  label: 'Move failed',
  detail: 'Restoring the working tree here failed: alpha: diverged. Everything was undone. Checkout fix still runs on mac-laptop.',
  createdAt: '2026-11-05T10:03:00.000Z',
  branches: [],
  actions: [
    { id: 'move-try-again', label: 'Try again' },
    { id: 'dismiss', label: 'Dismiss' },
  ],
  move: MOVE,
} as InboxItem;

describe('a failed move in Needs you (D154)', () => {
  it('is a stop with the reason, Try again (opens the move, the item stays) first and Dismiss; no "try again" message to the agent', () => {
    expect(inboxKindOf(ITEM)).toBe('stopped');
    const item = fromInbox(ITEM);
    expect(item.text).toContain('Everything was undone');
    expect(isLinkAction(MOVE_TRY_AGAIN)).toBe(true);
    expect(openTargetOf(item, 'move-try-again')).toEqual({ type: 'move', move: MOVE });
    const buttons = cardButtons(item);
    expect(buttons.map((button) => [button.id, button.variant, button.intent.type])).toEqual([
      ['move-try-again', 'primary', 'open'],
      ['dismiss', 'ghost', 'answer'],
    ]);
  });

  it('a paired machine’s item names the move by its remote id', () => {
    const peer = peerInboxItem({ id: MAC, name: 'mac-laptop', state: 'online' }, ITEM);
    expect(peer.move?.id).toBe(`r~${MAC}~run-1`);
    expect(peer.move?.source).toEqual(MOVE.source);
  });

  it('Try again opens the dialog with the last choices', () => {
    const request = retryRequest({ kind: 'agent', sessionId: 's1', targetMachine: PC, targetId: PC, machineName: 'pc-office', title: 'Checkout fix', member: null, choices: MOVE.choices });
    expect(request).toEqual({ sessionId: 's1', targetMachine: PC, machineName: 'pc-office', title: 'Checkout fix', retry: MOVE.choices });
    expect(choiceOfRetry(MOVE.choices)).toEqual({ placement: { roots: ['D:\\code'] }, clonePaths: { alpha: 'D:\\code\\alpha' }, files: { copy: ['AGENTS.md'] }, stashTargets: ['D:\\code\\alpha'] });
  });
});

describe('the live moves list (D154)', () => {
  const a = { id: 'a', state: 'running' } as MoveRecord;
  const b = { id: 'b', state: 'done' } as MoveRecord;
  it('replaces a move in place, adds a new one first, drops a removed one', () => {
    expect(applyMoveChange([a, b], { move: { ...b, state: 'failed' } as MoveRecord }).map((move) => [move.id, move.state])).toEqual([
      ['a', 'running'],
      ['b', 'failed'],
    ]);
    expect(applyMoveChange([a], { move: b }).map((move) => move.id)).toEqual(['b', 'a']);
    expect(applyMoveChange([a, b], { move: a, removed: true }).map((move) => move.id)).toEqual(['b']);
  });
});
