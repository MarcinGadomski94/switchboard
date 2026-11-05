import { describe, expect, it } from 'vitest';
import { CHAT_MOVE_STEPS, chatLookAtKey, chatMovedMessage, chatMoveUnsupportedText, chatSourceBlockers, effectiveLookAt, isSafeArtifactVersionName, isSafeAttachmentId, lastSegment, lookAtBlockers, mappedLookAt } from '../../src/core/chat-move.ts';
import { TAKEOVER_STEPS } from '../../src/core/takeover.ts';

/** D155: the pure parts of moving a chat to another computer. */

describe('D155 · chat move (core)', () => {
  it('runs a subset of the take-over steps (no capture, no apply)', () => {
    expect(CHAT_MOVE_STEPS).toEqual(['checks', 'stop', 'transfer', 'resume', 'finish']);
    expect(CHAT_MOVE_STEPS.every((step) => (TAKEOVER_STEPS as readonly string[]).includes(step))).toBe(true);
  });

  it('plans with the request first, then what was remembered; the rest is the target’s suggestion', () => {
    expect(effectiveLookAt(['/a', '/b', '/c'], { '/a': '/x', '/z': '/y' }, { '/a': '/old', '/b': null })).toEqual({ choice: { '/a': '/x', '/b': null }, remembered: true });
    expect(effectiveLookAt(['/a'], null, {})).toEqual({ choice: {}, remembered: false });
    expect(effectiveLookAt(['/a'], { '/a': null }, { '/a': '/old' })).toEqual({ choice: { '/a': null }, remembered: false });
  });

  it('maps the look-at folders: chosen ones in order, no left-out, no problem, no duplicate', () => {
    const rows = [
      { source: '/a', name: 'a', suggestion: null, match: null, target: '/t/a', problem: null },
      { source: '/b', name: 'b', suggestion: null, match: null, target: null, problem: null },
      { source: '/c', name: 'c', suggestion: null, match: null, target: '/etc', problem: 'outside' },
      { source: '/d', name: 'd', suggestion: null, match: null, target: '/t/a', problem: null },
    ] as const;
    expect(mappedLookAt(rows)).toEqual(['/t/a']);
    expect(lookAtBlockers(rows)).toEqual(['c: outside (choose another folder or leave it out)']);
  });

  it('tells the moved chat where things are now', () => {
    const text = chatMovedMessage({
      fromMachine: 'pc',
      toMachine: 'mac',
      lookAt: [
        { from: '/pc/alpha', to: '/mac/alpha' },
        { from: '/same', to: '/same' },
        { from: '/pc/notes', to: null },
      ],
      scratch: { from: '/pc/data/chats/1', to: '/mac/data/chats/2' },
      attachments: { from: '/pc/data/attachments/1', to: '/mac/data/attachments/2', count: 2 },
    });
    expect(text).toContain('This chat moved from pc to mac. It is still a chat: plan mode, read-only.');
    expect(text).toContain('Folders you look at now: /pc/alpha → /mac/alpha; /same.');
    expect(text).toContain('Left out on mac (you cannot read them here): /pc/notes.');
    expect(text).toContain('Your scratch folder is now /mac/data/chats/2 (was /pc/data/chats/1).');
    expect(text).toContain('The files the developer attached are now in /mac/data/attachments/2 (were in /pc/data/attachments/1).');
    expect(chatMovedMessage({ fromMachine: 'pc', toMachine: 'mac', lookAt: [], scratch: { from: null, to: '/s' }, attachments: { from: null, to: '/x', count: 0 } })).toContain('You look at no folders.');
  });

  it('refuses at the source: not a chat, closed, moved, answering, switching, moving', () => {
    const base = { display: 'Billing', kind: 'chat', closed: false, movedTo: null, busy: false, switching: false, moving: false };
    expect(chatSourceBlockers(base)).toEqual([]);
    expect(chatSourceBlockers({ ...base, busy: true })).toEqual(['Billing is answering: wait for its turn to end (or stop it), then move it']);
    expect(chatSourceBlockers({ ...base, kind: 'session', closed: true, movedTo: 'mac', switching: true, moving: true })).toHaveLength(5);
  });

  it('checks wire names and keys', () => {
    expect(isSafeAttachmentId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    expect(isSafeAttachmentId('../0f8fad5b')).toBe(false);
    expect(isSafeArtifactVersionName('a1b2c3d4e5/12')).toBe(true);
    for (const bad of ['a/0', '../a/1', 'a/1/2', 'a', '/a/1', 'a\\1']) expect(isSafeArtifactVersionName(bad), bad).toBe(false);
    expect(lastSegment('C:\\code\\alpha\\')).toBe('alpha');
    expect(chatLookAtKey('pc', '/a/b/', 'mac')).toBe('pc\n/a/b\nmac');
    expect(chatMoveUnsupportedText('mac')).toBe('mac runs an older Switchboard that cannot move chats: update Switchboard there, then try again');
  });
});
