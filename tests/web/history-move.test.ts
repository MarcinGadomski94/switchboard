import { describe, expect, it } from 'vitest';
import type { FolderCheck, HistoryItem } from '../../src/core/api.ts';
import {
  type MoveItem,
  addFolderLabel,
  continueBody,
  lastMoved,
  moveSelectedLabel,
  moveStateText,
  moveWarningText,
  movedState,
  movesSettled,
  needsInput,
  nextWaiting,
  opensByItself,
  pruneSelection,
  refusalState,
  refusalText,
  showsDialog,
  skipRemaining,
  startMoves,
  terminalConversations,
  updateMove,
} from '../../src/web/views/history-move.ts';

/** D16: moving terminal conversations from History and the New-session form (`src/web/views/history-move.ts`). */

const CHECK: FolderCheck = {
  path: '/Users/dev/work space',
  canonicalPath: '/Users/dev/work space',
  exists: true,
  kind: 'workspace',
  router: { title: 'AGENTS.md (Workspace Router)', lines: 10 },
  solutionCount: 3,
  repoName: null,
  problem: null,
  message: '',
};

function row(fields: Partial<HistoryItem>): HistoryItem {
  return {
    claudeSessionId: 'c1',
    sessionId: null,
    startedAt: '2026-09-27T21:41:00.000Z',
    name: 'sb-handoff',
    mode: 'terminal',
    summary: 'OK',
    branches: [],
    solutions: [],
    outcome: 'ended',
    status: 'idle',
    folder: 'f1',
    folderPath: '/ws',
    terminal: true,
    firstPrompt: 'Remember the code word',
    cwd: '/ws/other/handoff',
    ...fields,
  };
}

describe('moves (D16)', () => {
  it('starts every row waiting, calls in order, and sends only what the developer chose', () => {
    const items = startMoves([row({ claudeSessionId: 'a', name: 'A' }), row({ claudeSessionId: 'b', name: 'B' })]);
    expect(items.map((item) => [item.claudeSessionId, item.title, item.state.kind, item.addFolder, item.confirm])).toEqual([
      ['a', 'A', 'waiting', false, false],
      ['b', 'B', 'waiting', false, false],
    ]);
    expect(nextWaiting(items)?.claudeSessionId).toBe('a');
    expect(continueBody(items[0] as MoveItem)).toEqual({});
    expect(continueBody({ addFolder: true, confirm: true }, 'my-name')).toEqual({ name: 'my-name', addFolder: true, confirm: true });
  });

  it('reads the refusals: folder-not-saved, terminal-open, already in Switchboard, validation, anything else', () => {
    expect(refusalState(409, { error: 'folder-not-saved', message: 'x', check: CHECK })).toEqual({ kind: 'needs-folder', check: CHECK });
    const reasons = [{ kind: 'transcript-recent', modifiedAt: '2026-09-28T12:00:00.000Z' }];
    expect(refusalState(409, { error: 'terminal-open', message: 'x', reasons })).toEqual({ kind: 'terminal-open', reasons });
    expect(refusalState(409, { error: 'already-in-switchboard', message: 'x', sessionId: 's1' })).toEqual({ kind: 'refused', reason: 'Already in Switchboard.', sessionId: 's1' });
    expect(refusalState(422, { error: 'not-in-a-folder', message: '/tmp/x is not inside a workspace', cwd: '/tmp/x' })).toEqual({ kind: 'refused', reason: '/tmp/x is not inside a workspace' });
    expect(refusalText(422, { error: 'invalid', errors: [{ field: 'name', message: 'bad name' }] })).toBe('bad name');
    expect(refusalText(0, null)).toBe('Switchboard is not reachable.');
    expect(refusalText(500, 'oops')).toBe('The move failed (HTTP 500).');
  });

  it('settles, opens the last moved session by itself only without refusals, and shows the dialog when it has to', () => {
    let items = startMoves([row({ claudeSessionId: 'a' }), row({ claudeSessionId: 'b' }), row({ claudeSessionId: 'c' })]);
    items = updateMove(items, 'a', { state: movedState({ id: 's-a', name: 'a-name' }) });
    items = updateMove(items, 'b', { state: { kind: 'needs-folder', check: CHECK } });
    expect(needsInput(items)).toBe(true);
    expect(movesSettled(items)).toBe(false);
    expect(showsDialog(items)).toBe(true);
    items = updateMove(items, 'b', { addFolder: true, state: { kind: 'waiting' } });
    expect(nextWaiting(items)?.claudeSessionId).toBe('b');
    items = updateMove(items, 'b', { state: movedState({ id: 's-b', name: 'b-name' }) });
    items = updateMove(items, 'c', { state: movedState({ id: 's-c', name: 'c-name' }) });
    expect(movesSettled(items)).toBe(true);
    expect(lastMoved(items)).toEqual({ sessionId: 's-c', name: 'c-name' });
    expect(opensByItself(items)).toBe(true);
    // A refused or skipped one keeps the settled dialog (Open <last moved> / Close).
    const refused = updateMove(items, 'c', { state: { kind: 'refused', reason: 'no' } });
    expect(movesSettled(refused)).toBe(true);
    expect(opensByItself(refused)).toBe(false);
    expect(lastMoved(refused)).toEqual({ sessionId: 's-b', name: 'b-name' });
    expect(opensByItself(updateMove(items, 'c', { state: { kind: 'skipped' } }))).toBe(false);

    // One conversation that simply moves: no dialog.
    const single = startMoves([row({})]);
    expect(showsDialog(single)).toBe(false);
    expect(showsDialog(updateMove(single, 'c1', { state: { kind: 'terminal-open', reasons: [] } }))).toBe(true);
    // Cancel skips what is not moved yet.
    expect(skipRemaining(updateMove(startMoves([row({ claudeSessionId: 'x' }), row({ claudeSessionId: 'y' })]), 'x', { state: movedState({ id: 's', name: 'n' }) })).map((i) => i.state.kind)).toEqual([
      'moved',
      'skipped',
    ]);
  });

  it('copy: buttons, the warning, the folder line, the states', () => {
    expect(moveSelectedLabel(3)).toBe('Move selected (3)');
    expect(addFolderLabel(CHECK)).toBe('Add work space and continue');
    const now = Date.parse('2026-09-28T12:00:30.000Z');
    expect(moveWarningText([{ kind: 'transcript-recent', modifiedAt: '2026-09-28T12:00:00.000Z' }, { kind: 'terminal-live', pid: 42 }], now)).toBe(
      'The transcript changed 30 s ago. A claude process (pid 42) has this conversation open. Two processes on one conversation split it. Close it in the terminal first, or continue anyway.',
    );
    expect(moveStateText({ kind: 'needs-folder', check: CHECK })).toBe('No saved folder holds this conversation. It sits in the workspace /Users/dev/work space.');
    expect(moveStateText({ kind: 'needs-folder', check: { ...CHECK, kind: 'repo', path: '/r/app' } })).toBe('No saved folder holds this conversation. It sits in the git repository /r/app.');
    expect(moveStateText(movedState({ id: 's', name: 'code-words' }))).toBe('✓ moved as code-words');
    expect(moveStateText({ kind: 'refused', reason: 'nope' })).toBe('✕ nope');
  });

  it('the New-session list and the History selection keep only terminal conversations not in Switchboard', () => {
    const rows = [row({ claudeSessionId: 'a' }), row({ claudeSessionId: 'b', folder: 'f2' }), row({ claudeSessionId: 'c', terminal: undefined, sessionId: 's-c' }), row({ claudeSessionId: 'd', terminal: undefined })];
    expect(terminalConversations(rows, 'f1').map((r) => r.claudeSessionId)).toEqual(['a']);
    expect(terminalConversations(rows, null)).toEqual([]);
    expect([...pruneSelection(new Set(['a', 'b', 'c', 'd', 'gone']), rows)]).toEqual(['a', 'b']);
  });
});
