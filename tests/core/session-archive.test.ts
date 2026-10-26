import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_DAYS_DEFAULT,
  archiveCountdownText,
  archiveDaysLabel,
  archiveDaysOf,
  archiveDeadline,
  archiveDue,
  archiveGraceRestarts,
  archiveInfo,
  archivePolicyText,
  archiveRowText,
  archiveSweepText,
  parseArchiveDays,
  readArchiveSweep,
} from '../../src/core/session-archive.ts';

/** D137 · the archive's pure rules (`src/core/session-archive.ts`). */

const DAY = 86_400_000;

describe('the archive · rules (D137)', () => {
  it('the period: whole days 0–3650 (0 = Never), default 14', () => {
    expect(ARCHIVE_DAYS_DEFAULT).toBe(14);
    expect(parseArchiveDays(0)).toBe(0);
    expect(parseArchiveDays(3650)).toBe(3650);
    for (const bad of [-1, 3651, 1.5, '14', null, undefined]) expect(parseArchiveDays(bad)).toBeNull();
    expect(archiveDaysOf(undefined)).toBe(14);
    expect(archiveDaysOf(7)).toBe(7);
    expect(archiveDaysOf('nope')).toBe(14);
  });

  it('the deadline counts from closedAt, or from the upgrade grace when that is later; Never has none', () => {
    const closed = '2026-10-01T10:00:00.000Z';
    expect(archiveDeadline(closed, null, 14)).toBe(new Date(Date.parse(closed) + 14 * DAY).toISOString());
    expect(archiveDeadline(closed, '2026-09-01T00:00:00.000Z', 14)).toBe(new Date(Date.parse(closed) + 14 * DAY).toISOString());
    expect(archiveDeadline(closed, '2026-10-20T00:00:00.000Z', 14)).toBe('2026-11-03T00:00:00.000Z');
    expect(archiveDeadline(closed, null, 0)).toBeNull();
    expect(archiveDue('2026-10-01T00:00:00.000Z', Date.parse('2026-10-01T00:00:00.000Z'))).toBe(true);
    expect(archiveDue('2026-10-02T00:00:00.000Z', Date.parse('2026-10-01T00:00:00.000Z'))).toBe(false);
    expect(archiveDue(null, Date.now())).toBe(false);
  });

  it('a kept session shows its reason instead of the countdown; an open one neither', () => {
    expect(archiveInfo({ closedAt: null, since: null, days: 14, kept: null })).toEqual({ deletesAt: null, keptReason: null });
    expect(archiveInfo({ closedAt: '2026-10-01T00:00:00.000Z', since: null, days: 14, kept: 'pinned' })).toEqual({ deletesAt: null, keptReason: 'pinned' });
    expect(archiveRowText({ deletesAt: null, keptReason: 'crew' })).toBe('Kept: a Team member');
    expect(archiveRowText({ deletesAt: null, keptReason: null })).toBeNull();
  });

  it('the countdown: Deletes today / tomorrow / in N days (calendar days)', () => {
    const now = new Date(2026, 9, 26, 9, 0);
    expect(archiveCountdownText(new Date(2026, 9, 26, 23, 0).toISOString(), now)).toBe('Deletes today');
    expect(archiveCountdownText(new Date(2026, 9, 25, 23, 0).toISOString(), now)).toBe('Deletes today');
    expect(archiveCountdownText(new Date(2026, 9, 27, 1, 0).toISOString(), now)).toBe('Deletes tomorrow');
    expect(archiveCountdownText(new Date(2026, 10, 9, 8, 0).toISOString(), now)).toBe('Deletes in 14 days');
  });

  it('the words of Settings and the list', () => {
    expect(archiveDaysLabel(0)).toBe('Never');
    expect(archiveDaysLabel(1)).toBe('1 day');
    expect(archivePolicyText(14, 'agents')).toBe('Archived agents are deleted after 14 days.');
    expect(archivePolicyText(0, 'sessions')).toBe('Archived sessions are kept until you delete them.');
  });

  it('the sweep record and its line', () => {
    const now = new Date(2026, 9, 26, 15, 0);
    const at = new Date(2026, 9, 26, 14, 2).toISOString();
    expect(readArchiveSweep(null)).toEqual({ lastRunAt: null, lastDeleted: null });
    expect(archiveSweepText({ lastRunAt: null, lastDeleted: null }, 'agent', now)).toBeNull();
    expect(archiveSweepText({ lastRunAt: at, lastDeleted: null }, 'agent', now)).toMatch(/^Last check today .*: nothing was due\.$/);
    const record = readArchiveSweep({ lastRunAt: at, lastDeleted: { at, sessions: 3, worktrees: 2, keptWorktrees: [{ path: '/x', reason: 'dirty' }, { bad: 1 }] } });
    expect(record.lastDeleted?.keptWorktrees).toEqual([{ path: '/x', reason: 'dirty' }]);
    expect(archiveSweepText(record, 'agent', now)).toMatch(/^Last: deleted 3 archived agents, 2 worktrees, today .+ \(1 worktree kept, see Clean-up\)$/);
  });
});

describe('the archive · a change of the period (D137 follow-up 2026-10-26)', () => {
  it('Never → days and a shorter period restart the grace; longer, the same, or Never keep it', () => {
    expect(archiveGraceRestarts(0, 14)).toBe(true);
    expect(archiveGraceRestarts(30, 14)).toBe(true);
    expect(archiveGraceRestarts(14, 1)).toBe(true);
    expect(archiveGraceRestarts(14, 30)).toBe(false);
    expect(archiveGraceRestarts(14, 14)).toBe(false);
    expect(archiveGraceRestarts(14, 0)).toBe(false);
    expect(archiveGraceRestarts(0, 0)).toBe(false);
  });
});
