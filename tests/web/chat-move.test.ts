import { describe, expect, it } from 'vitest';
import type { ChatMovePreview } from '../../src/core/chat-move.ts';
import { carriesLine, chatMoveBlockedReason, choiceOf, lookAtRows, matchWords, offersChatMove, staysBehind, withFolder, withLeftOut } from '../../src/web/v2/agent/chat-move-model.ts';
import { agentMenu } from '../../src/web/v2/agent/header-model.ts';

/** D155: the v2 chat Move to computer… dialog's model and its ⋯ menu entry. */

function preview(over: Partial<ChatMovePreview> = {}): ChatMovePreview {
  return {
    source: {
      machine: { id: 'pc', name: 'pc-office' },
      platform: 'darwin',
      chatId: 'c1',
      name: 'chat-c1',
      title: 'Billing',
      task: 'x',
      provider: 'claude',
      claudeSessionId: 's',
      nativeId: 's',
      model: null,
      effort: null,
      live: true,
      busy: false,
      scratch: '/data/chats/c1',
      attachmentsDir: '/data/attachments/c1',
      lookAt: [],
      conversation: { kind: 'claude-transcript', files: [{ name: 's.jsonl', size: 10 }], note: null },
      attachments: [
        { id: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'a.png', mediaType: 'image/png', kind: 'image', size: 5, pages: null, createdAt: 'x', refused: null },
        { id: '1f8fad5b-d9cb-469f-a165-70867728950e', name: 'gone.pdf', mediaType: 'application/pdf', kind: 'pdf', size: 5, pages: 1, createdAt: 'x', refused: 'its file is gone' },
      ],
      scratchFiles: { files: [{ name: 'plan.md', size: 3, refused: null }, { name: '.env', size: 3, refused: 'looks like it holds secrets (a token): it stays on this computer' }], truncated: false },
      artifacts: [{ id: 'a1', title: 'Split', kind: 'markdown', language: null, createdBy: 'agent', versions: [{ n: 1, text: true, mediaType: null, size: 4, createdBy: 'agent' }] }],
      todos: [],
      blockers: [],
    },
    target: {
      machine: { id: 'mac', name: 'mac-laptop' },
      platform: 'darwin',
      cli: { provider: 'claude', label: 'Claude Code', available: true, reason: null },
      account: { profileId: null, name: 'Default' },
      lookAt: [
        { source: '/pc/code/alpha', name: 'alpha', suggestion: '/mac/code/alpha', match: 'remote', target: '/mac/code/alpha', problem: null },
        { source: '/pc/notes', name: 'notes', suggestion: null, match: null, target: null, problem: null },
        { source: '/pc/docs', name: 'docs', suggestion: '/mac/docs', match: 'name', target: '/mac/other', problem: null },
      ],
      blockers: [],
    },
    lookAt: { '/pc/code/alpha': '/mac/code/alpha', '/pc/notes': null, '/pc/docs': '/mac/other' },
    remembered: false,
    ok: true,
    blockers: [],
    ...over,
  };
}

describe('D155 · the chat move dialog model', () => {
  it('words each looked-at folder: the suggestion, a picked folder, left out', () => {
    const rows = lookAtRows(preview(), 'mac-laptop');
    expect(rows.map((row) => [row.name, row.mode, row.line])).toEqual([
      ['alpha', 'suggested', 'Uses /mac/code/alpha on mac-laptop'],
      ['notes', 'left-out', 'Left out: the chat cannot read it on mac-laptop'],
      ['docs', 'picked', 'Uses /mac/other on mac-laptop'],
    ]);
    expect(rows[0]?.why).toBe('the same code project (by its remote)');
    expect(matchWords('path')).toBe('the same path');
    expect(matchWords('name')).toBe('a saved folder with the same name');
    expect(matchWords(null)).toBeNull();
  });

  it('shows the target’s problem with a chosen folder', () => {
    const p = preview();
    const bad = preview({ target: { ...p.target, lookAt: [{ source: '/pc/notes', name: 'notes', suggestion: null, match: null, target: '/etc', problem: '/etc is outside the home folder and the saved folders of this machine' }] } });
    expect(lookAtRows(bad, 'mac-laptop')[0]?.line).toBe('/etc: /etc is outside the home folder and the saved folders of this machine');
  });

  it('edits the choice: use a folder (trimmed; empty = left out), leave one out', () => {
    const choice = choiceOf(preview());
    expect(withFolder(choice, '/pc/notes', '  /mac/notes ')).toMatchObject({ '/pc/notes': '/mac/notes', '/pc/code/alpha': '/mac/code/alpha' });
    expect(withFolder(choice, '/pc/notes', '   ')).toMatchObject({ '/pc/notes': null });
    expect(withLeftOut(choice, '/pc/code/alpha')).toMatchObject({ '/pc/code/alpha': null, '/pc/docs': '/mac/other' });
    // The preview's own choice is not changed in place.
    expect(choice['/pc/code/alpha']).toBe('/mac/code/alpha');
  });

  it('says what is copied and what stays behind', () => {
    expect(carriesLine(preview())).toBe('The conversation is copied (1 file) and continues there · 1 attachment · 1 scratch file · 1 artifact');
    expect(staysBehind(preview())).toEqual(['.env: looks like it holds secrets (a token): it stays on this computer', 'gone.pdf: its file is gone']);
  });

  it('says why Move is disabled', () => {
    const base = { preview: preview(), previewError: null, other: { name: 'mac-laptop', state: 'online' as const }, running: false, editing: false };
    expect(chatMoveBlockedReason(base)).toBeNull();
    expect(chatMoveBlockedReason({ ...base, running: true })).toBe('It is moving now.');
    expect(chatMoveBlockedReason({ ...base, other: { name: 'mac-laptop', state: 'offline' } })).toBe('mac-laptop is offline: it can move once it reconnects.');
    expect(chatMoveBlockedReason({ ...base, preview: null })).toBe('Checking both computers…');
    expect(chatMoveBlockedReason({ ...base, previewError: 'mac-laptop runs an older Switchboard that cannot move chats: update Switchboard there, then try again' })).toContain('update Switchboard there');
    expect(chatMoveBlockedReason({ ...base, preview: preview({ ok: false, blockers: ['Billing is answering: wait for its turn to end (or stop it), then move it'] }) })).toContain('is answering');
    expect(chatMoveBlockedReason({ ...base, editing: true })).toBe('Use the folder you typed, or close the folder picker.');
  });

  it('offers the move for an open chat that has not moved (a paired computer’s only while it is reachable)', () => {
    expect(offersChatMove({ closedAt: null, movedTo: null, machine: null })).toBe(true);
    expect(offersChatMove({ closedAt: '2026-11-05T10:00:00Z', movedTo: null, machine: null })).toBe(false);
    expect(offersChatMove({ closedAt: null, movedTo: { machineId: 'b' }, machine: null })).toBe(false);
    expect(offersChatMove({ closedAt: null, movedTo: null, machine: { state: 'offline' } })).toBe(false);
    expect(offersChatMove({ closedAt: null, movedTo: null, machine: { state: 'online' } })).toBe(true);
  });

  it('puts Move to computer… in a conversation’s ⋯ menu, with why it is disabled', () => {
    const input: Parameters<typeof agentMenu>[0] = { conversation: true, closed: false, running: false, attached: true, hooked: false, machineName: null, offline: null, remote: null, background: 0, movable: false, computers: 1, teammate: false, crews: 0, chatMovable: true };
    const entry = (over: Partial<Parameters<typeof agentMenu>[0]>) => agentMenu({ ...input, ...over }).find((item) => !('sep' in item) && item.id === 'move-chat') as { label: string; disabledReason?: string };
    expect(entry({})).toEqual({ id: 'move-chat', label: 'Move to computer…', icon: 'desktop' });
    expect(entry({ computers: 0 }).disabledReason).toBe('No other computer is paired and online.');
    expect(entry({ closed: true }).disabledReason).toBe('Archived conversations stay where they are.');
    expect(entry({ chatMovable: false }).disabledReason).toBe('It moved already.');
    expect(entry({ machineName: 'Studio-PC', offline: 'Studio-PC is offline', computers: 0 }).disabledReason).toContain('Studio-PC is offline');
    // A paired computer's chat comes here: no other computer needs to be online.
    expect(entry({ machineName: 'Studio-PC', computers: 0 }).disabledReason).toBeUndefined();
    // Not for an agent (it has its own Move to computer…).
    expect(agentMenu({ ...input, conversation: false }).some((item) => !('sep' in item) && item.id === 'move-chat')).toBe(false);
  });
});
