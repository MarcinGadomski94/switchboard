import { describe, expect, it } from 'vitest';
import type { MemoryEntry, MemoryScope } from '../../src/core/memory.ts';
import { ALL_NOTES, canDraftNotes, draftToast, filterFromQuery, filterOptions, inFilter, noteAuthor, noteRows, noteScopeOf, shortWhen } from '../../src/web/v2/agents/notes/notes-model.ts';

const FOLDER = '/work/acme';

function entry(over: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    scope: FOLDER,
    scopeKind: 'workspace',
    scopeKey: null,
    scopeLabel: null,
    title: 'Use acme-ui buttons',
    text: 'The checkout uses the shared acme-ui buttons.',
    tags: [],
    authorKind: 'agent',
    authorSessionId: 's1',
    authorLabel: 'Reviewer/QA',
    status: 'approved',
    pinned: false,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    decidedAt: '2026-10-20T11:00:00.000Z',
    decidedBy: 'developer',
    proposedTitle: null,
    proposedText: null,
    ...over,
  };
}

const SCOPES: MemoryScope[] = [{ scope: FOLDER, label: 'Checkout', saved: true, approved: 1, proposed: 1 }];

describe('v2 Notes · scopes in plain words', () => {
  it('names a workspace entry by its folder, a repo entry as a code project, a member entry as a teammate', () => {
    expect(noteScopeOf(entry({ id: 'a' }), SCOPES)).toEqual({ key: `folder:${FOLDER}`, kind: 'folder', name: 'Checkout', label: 'Folder · Checkout' });
    expect(noteScopeOf(entry({ id: 'b', scope: '/x/docs' }), [])).toMatchObject({ label: 'Folder · docs' });
    expect(noteScopeOf(entry({ id: 'c', scopeKind: 'repo', scopeKey: 'github.com/acme/checkout-front', scopeLabel: 'acme-checkout-front' }), SCOPES)).toEqual({
      key: 'repo:github.com/acme/checkout-front',
      kind: 'codeProject',
      name: 'acme-checkout-front',
      label: 'Code project · acme-checkout-front',
    });
    expect(noteScopeOf(entry({ id: 'd', scopeKind: 'member', scopeKey: 'm1', scopeLabel: 'Mobile QA' }), SCOPES)).toMatchObject({ key: 'member:m1', label: 'Teammate · Mobile QA' });
  });

  it('says who wrote it', () => {
    expect(noteAuthor(entry({ id: 'a', authorKind: 'developer', authorLabel: null }))).toBe('You');
    expect(noteAuthor(entry({ id: 'a' }))).toBe('Reviewer/QA');
    expect(noteAuthor(entry({ id: 'a', proposedText: 'old' }))).toBe('Reviewer/QA, edited by you');
    expect(noteAuthor(entry({ id: 'a', authorLabel: null }))).toBe('An agent');
  });

  it('shows short times like the prototype', () => {
    const now = new Date(2026, 9, 25, 15, 0).getTime();
    expect(shortWhen(new Date(2026, 9, 25, 13, 41).toISOString(), now)).toBe('13:41');
    expect(shortWhen(new Date(2026, 9, 23, 9, 0).toISOString(), now)).toBe('Fri');
    expect(shortWhen(new Date(2026, 9, 12, 9, 0).toISOString(), now)).toBe('Oct 12');
    expect(shortWhen(null, now)).toBe('');
  });
});

describe('v2 Notes · rows and order', () => {
  const sources = [
    {
      computer: null,
      scopes: SCOPES,
      entries: [
        entry({ id: 'old', decidedAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' }),
        entry({ id: 'new', decidedAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z' }),
        entry({ id: 'rej', status: 'rejected' }),
        entry({ id: 'p2', status: 'proposed', decidedAt: null, createdAt: '2026-10-24T00:00:00.000Z' }),
        entry({ id: 'p1', status: 'proposed', decidedAt: null, createdAt: '2026-10-23T00:00:00.000Z', scopeKind: 'repo', scopeKey: 'r1', scopeLabel: 'app' }),
      ],
    },
    { computer: { id: 'studio', name: 'Studio-PC', state: 'offline' as const }, scopes: [], entries: [entry({ id: 'peer', scope: '/studio/mobile', scopeKind: 'member', scopeKey: 'm9', scopeLabel: 'Mobile QA' })] },
  ];

  it('puts proposed notes first (oldest first), then approved (newest first), then rejected', () => {
    const rows = noteRows(sources);
    expect(rows.map((row) => row.entry.id)).toEqual(['p1', 'p2', 'new', 'peer', 'old', 'rej']);
    expect(rows.map((row) => row.key)).toContain('studio:peer');
  });

  it('blocks a paired computer’s notes while it is offline', () => {
    const rows = noteRows(sources);
    expect(rows.find((row) => row.entry.id === 'peer')?.blocked).toBe('Studio-PC is offline');
    expect(rows.find((row) => row.entry.id === 'new')?.blocked).toBeNull();
  });

  it('filters by folder (everything stored there), code project or teammate', () => {
    const rows = noteRows(sources);
    expect(rows.filter((row) => inFilter(row, `folder:${FOLDER}`)).map((row) => row.entry.id)).toEqual(['p1', 'p2', 'new', 'old', 'rej']);
    expect(rows.filter((row) => inFilter(row, 'repo:r1')).map((row) => row.entry.id)).toEqual(['p1']);
    expect(rows.filter((row) => inFilter(row, 'member:m9')).map((row) => row.entry.id)).toEqual(['peer']);
    expect(rows.filter((row) => inFilter(row, ALL_NOTES))).toHaveLength(6);
  });

  it('offers All, then folders, code projects and teammates with counts (rejected not counted)', () => {
    const options = filterOptions(noteRows(sources));
    expect(options.map((option) => [option.label, option.count, option.proposed])).toEqual([
      ['All notes', 5, 2],
      ['Folder · Checkout', 4, 2],
      ['Folder · mobile', 1, 0],
      ['Code project · app', 1, 1],
      ['Teammate · Mobile QA', 1, 0],
    ]);
    expect(filterOptions([], 'folder:/a/b').map((option) => option.label)).toEqual(['All notes', 'Folder · b']);
  });

  it('reads ?scope= as a filter key or a bare folder', () => {
    expect(filterFromQuery('')).toBe(ALL_NOTES);
    expect(filterFromQuery('?scope=%2Fwork%2Facme')).toBe('folder:/work/acme');
    expect(filterFromQuery('?scope=repo%3Ar1')).toBe('repo:r1');
  });
});

describe('v2 Notes · drafting', () => {
  it('only open agents on this computer, never a conversation', () => {
    expect(canDraftNotes({ kind: 'session', closedAt: null })).toBe(true);
    expect(canDraftNotes({ kind: 'chat', closedAt: null })).toBe(false);
    expect(canDraftNotes({ closedAt: '2026-10-01T00:00:00Z' })).toBe(false);
    expect(canDraftNotes({ machine: { id: 'm', name: 'M', state: 'online' } })).toBe(false);
  });

  it('says what happened', () => {
    expect(draftToast({ asked: true, reason: null, askedAt: null }, 'Fix login')).toBe('Asked “Fix login” to draft notes. They’ll wait for you in Needs you.');
    expect(draftToast({ asked: false, reason: 'asked-recently', askedAt: null }, 'A')).toContain('last 24 hours');
    expect(draftToast({ asked: false, reason: 'no-folder', askedAt: null }, 'A')).toContain('doesn’t work in a folder');
    expect(draftToast({ asked: false, reason: 'closed', askedAt: null }, 'A')).toBe('“A” is archived. Restore it first.');
  });
});
