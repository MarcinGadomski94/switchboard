import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../src/core/api.ts';
import {
  ALL_CLEAR,
  INBOX_ZERO,
  INBOX_ZERO_HINT,
  OPEN_SESSION,
  detailBody,
  formatToolInput,
  linksSession,
  newSessionAfter,
  refusalText,
  selectedItem,
  visibleItems,
  waitingLine,
} from '../../src/web/views/inbox.ts';

function item(id: string, kind: InboxItem['kind'], sessionId: string | null = 's1'): InboxItem {
  return {
    id,
    kind,
    sessionId,
    source: 'source',
    status: 'need',
    title: 'title',
    label: 'label',
    detail: '',
    createdAt: '2026-09-28T00:00:00.000Z',
    branches: [],
  };
}

const ITEMS = [item('a', 'questions'), item('b', 'permission'), item('c', 'system', null)];

describe('Inbox view state (src/web/views/inbox.ts, prototype inboxRaw / ib)', () => {
  it('uses the prototype copy', () => {
    expect(INBOX_ZERO).toBe('Inbox zero');
    expect(INBOX_ZERO_HINT).toBe('New questions, approvals and failed runs show up here with a toast and sound.');
    expect(ALL_CLEAR).toBe('All clear. Nothing is waiting on you.');
    expect(OPEN_SESSION).toBe('Open session →');
    expect(waitingLine(5)).toBe('5 waiting on you');
    expect(waitingLine(0)).toBe('0 waiting on you');
  });

  it('selects the picked item while it is listed, else the first; nothing for an empty list', () => {
    expect(selectedItem(ITEMS, null)?.id).toBe('a');
    expect(selectedItem(ITEMS, 'b')?.id).toBe('b');
    expect(selectedItem(ITEMS, 'gone')?.id).toBe('a');
    expect(selectedItem([], 'a')).toBeNull();
  });

  it('hides items the page already answered or acted on', () => {
    expect(visibleItems(ITEMS, new Set(['a'])).map((i) => i.id)).toEqual(['b', 'c']);
    expect(visibleItems(ITEMS, new Set()).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('picks the detail body per kind; only session items link to their session', () => {
    expect(ITEMS.map(detailBody)).toEqual(['questions', 'permission', 'system']);
    expect(ITEMS.map((i) => linksSession(i))).toEqual([true, true, false]);
    expect(linksSession(item('d', 'questions', null))).toBe(false);
    expect(linksSession(item('e', 'system', 's1'))).toBe(false);
  });

  it('shows a tool input verbatim as indented JSON', () => {
    expect(formatToolInput({ command: 'node -e "console.log(6*7)"' })).toBe('{\n  "command": "node -e \\"console.log(6*7)\\""\n}');
    expect(formatToolInput('text')).toBe('"text"');
    expect(formatToolInput(undefined)).toBe('');
  });

  it('says why an answer or action was not sent', () => {
    expect(refusalText(409, { error: 'already-answered', message: 'question batch b1 is already answered' })).toBe(
      'Not sent: question batch b1 is already answered',
    );
    expect(refusalText(404, null)).toBe('Not sent: HTTP 404');
    expect(refusalText(0, null)).toBe('Not sent: Switchboard is not reachable.');
  });

  it('opens the New-session modal with the item prefill only after "Open fix session" on a system item (M3.3)', () => {
    const prefill = { name: 'fix-nightly', task: 'nightly: failed.', solutions: ['mobile'] };
    const fix: InboxItem = { ...item('f', 'system', null), actions: [{ id: 'open-fix-session', label: 'Open fix session' }], prefill };
    expect(newSessionAfter(fix, 'open-fix-session')).toEqual(prefill);
    expect(newSessionAfter({ ...fix, prefill: undefined }, 'open-fix-session')).toEqual({});
    expect(newSessionAfter(fix, 'dismiss')).toBeNull();
    expect(newSessionAfter(item('p', 'permission'), 'open-fix-session')).toBeNull();
  });
});
