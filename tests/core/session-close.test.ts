import { describe, expect, it } from 'vitest';
import {
  CLOSE_TOOLTIP,
  SESSION_CLOSED_REASON,
  closeAsks,
  closeConfirmText,
  closeNeedsConfirm,
  closedBatchText,
  isClosed,
  openSessions,
  parseClosedFilter,
} from '../../src/core/session-close.ts';

/** D33: the pure rules and copy of closing / reopening sessions (src/core/session-close.ts). */
describe('D33 · closing sessions (rules and copy)', () => {
  it('?closed= of GET /api/sessions: absent = exclude; include / exclude as given; anything else is refused', () => {
    expect(parseClosedFilter(undefined)).toBe('exclude');
    expect(parseClosedFilter('exclude')).toBe('exclude');
    expect(parseClosedFilter('include')).toBe('include');
    for (const bad of ['', 'only', 'INCLUDE', ['include'], 1, null]) expect(parseClosedFilter(bad), String(bad)).toBeNull();
  });

  it('the list filtering: closed sessions (a closedAt) are left out, in order; a missing closedAt is open', () => {
    const list = [
      { id: 'a', closedAt: null },
      { id: 'b', closedAt: '2026-09-28T10:00:00.000Z' },
      { id: 'c' },
      { id: 'd', closedAt: '2026-09-28T11:00:00.000Z' },
    ];
    expect(openSessions(list).map((s) => s.id)).toEqual(['a', 'c']);
    expect(list.map(isClosed)).toEqual([false, true, false, true]);
    expect(openSessions([])).toEqual([]);
  });

  it('the server needs confirm for a live process or a run / need status; the UI asks only for running or waiting', () => {
    expect(closeNeedsConfirm({ live: true, status: 'done' })).toBe(true);
    expect(closeNeedsConfirm({ live: false, status: 'run' })).toBe(true);
    expect(closeNeedsConfirm({ live: false, status: 'need' })).toBe(true);
    for (const status of ['idle', 'paused', 'done', 'fail'] as const) expect(closeNeedsConfirm({ live: false, status }), status).toBe(false);
    expect(closeAsks({ status: 'run', activity: null })).toBe(true);
    expect(closeAsks({ status: 'need', activity: null })).toBe(true);
    expect(closeAsks({ status: 'done', activity: { state: 'thinking' } })).toBe(true);
    for (const status of ['idle', 'paused', 'done', 'fail'] as const) expect(closeAsks({ status, activity: null }), status).toBe(false);
    expect(closeAsks({ status: 'done' })).toBe(false);
  });

  it('copy: the confirmation names the session; the tooltip; a batch closed with its session', () => {
    expect(closeConfirmText('JIRA Ticket handling')).toBe('Stop JIRA Ticket handling and close it? Its conversation stays in History and can be reopened.');
    expect(CLOSE_TOOLTIP).toBe('Close (keeps it in History)');
    expect(closedBatchText(SESSION_CLOSED_REASON)).toBe('Closed · session closed');
  });
});
