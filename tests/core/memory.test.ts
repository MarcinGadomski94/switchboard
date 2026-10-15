import { describe, expect, it } from 'vitest';
import {
  MEMORY_BLOCK_END,
  MEMORY_BLOCK_START,
  MEMORY_OVERFLOW_TITLES,
  type MemoryEntry,
  type MemoryReach,
  defaultProposalScope,
  memoryBlock,
  memoryBlockParts,
  memoryBudgets,
  memoryEntryText,
  memoryVisible,
  memoryCountText,
  memoryProposalsTitle,
  nearDuplicateTitle,
  readMemoryCap,
  readMemoryInput,
} from '../../src/core/memory.ts';

/** D107 · the block (approved only, pinned first then newest, the cap and the overflow line), the inputs and the duplicate check. */

let n = 0;
function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  n += 1;
  const at = `2026-10-14T10:${String(n).padStart(2, '0')}:00.000Z`;
  return {
    id: `e${n}`,
    scope: '/work/acme',
    title: `Acme fact ${n}`,
    text: `Fact ${n} text.`,
    tags: [],
    authorKind: 'agent',
    authorSessionId: 's1',
    authorLabel: 'Acme session',
    status: 'approved',
    pinned: false,
    createdAt: at,
    updatedAt: at,
    decidedAt: at,
    decidedBy: 'developer',
    proposedTitle: null,
    proposedText: null,
    scopeKind: 'workspace',
    scopeKey: null,
    scopeLabel: null,
    ...overrides,
  };
}

describe('D107 · memoryBlock', () => {
  it('approved entries only; none → null', () => {
    expect(memoryBlock([entry({ status: 'proposed' }), entry({ status: 'rejected' })], 4000, 'Acme app')).toBeNull();
    const block = memoryBlock([entry({ title: 'Kept', status: 'approved' }), entry({ title: 'Queued', status: 'proposed', text: 'NOPE' }), entry({ title: 'Refused', status: 'rejected', text: 'NOPE' })], 4000, 'Acme app') as string;
    expect(block.split('\n')[0]).toBe(MEMORY_BLOCK_START);
    expect(block.split('\n').at(-1)).toBe(MEMORY_BLOCK_END);
    expect(block).toContain('Folder: Acme app.');
    expect(block).toContain('- Kept\n');
    expect(block).not.toContain('NOPE');
    expect(block).not.toContain('Queued');
  });

  it('pinned first, then newest; tags shown; multi-line text indented', () => {
    const old = entry({ title: 'Old', decidedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
    const pinnedOld = entry({ title: 'Pinned old', pinned: true, decidedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' });
    const fresh = entry({ title: 'Fresh', tags: ['build', 'ci'], text: 'line one\nline two', decidedAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' });
    const parts = memoryBlockParts([old, pinnedOld, fresh], 4000, 'Acme') as NonNullable<ReturnType<typeof memoryBlockParts>>;
    expect(parts.included).toEqual([pinnedOld.id, fresh.id, old.id]);
    expect(parts.text).toContain('- Fresh [build, ci]\n  line one\n  line two');
  });

  it('the cap: entries while they fit, then one overflow line with the rest of the titles and memory_list', () => {
    const pinned = entry({ title: 'Pinned rule', pinned: true, text: 'p'.repeat(300), decidedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    const newest = entry({ title: 'Newest', text: 'n'.repeat(300), decidedAt: '2026-10-14T12:00:00.000Z', updatedAt: '2026-10-14T12:00:00.000Z' });
    const older = entry({ title: 'Older', text: 'o'.repeat(300), decidedAt: '2026-10-13T12:00:00.000Z', updatedAt: '2026-10-13T12:00:00.000Z' });
    const small = entry({ title: 'Small but oldest', text: 's', decidedAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' });
    const parts = memoryBlockParts([older, small, newest, pinned], 700, 'Acme') as NonNullable<ReturnType<typeof memoryBlockParts>>;
    expect(parts.included).toEqual([pinned.id, newest.id]);
    // The first entry that does not fit stops the list: the smaller, older one after it is listed too (order kept).
    expect(parts.overflow).toEqual([older.id, small.id]);
    expect(parts.text).toContain('2 more approved entries, not shown to save space: "Older", "Small but oldest". Read them with the switchboard memory_list tool when they matter.');
    expect(parts.text).not.toContain('o'.repeat(300));
    // The entries' part stays within the cap.
    const body = parts.text.split('\n').filter((line) => line.startsWith('- ') || line.startsWith('  ')).join('\n');
    expect(body.length).toBeLessThanOrEqual(700);
  });

  it(`the overflow line names at most ${MEMORY_OVERFLOW_TITLES} titles`, () => {
    const many = Array.from({ length: 30 }, (_, i) => entry({ title: `Overflow ${i}`, text: 'x'.repeat(100) }));
    const text = memoryBlock(many, 500, 'Acme') as string;
    expect(text).toMatch(/\d+ more approved entries, not shown to save space: .* and \d+ more\. Read them/);
  });
});

describe('D107 · inputs, duplicates, texts', () => {
  it('reads and checks entry fields', () => {
    expect(readMemoryInput({ title: '  Build   cmd ', text: 'npm  ci\r\n\r\n\r\nnpm test  ', tags: [' Build ', 'build', 'Test Tools'] }, ['title', 'text'])).toEqual({ ok: true, value: { title: 'Build cmd', text: 'npm ci\n\nnpm test', tags: ['build', 'test-tools'] } });
    expect(readMemoryInput({ text: 'x' }, ['title', 'text'])).toMatchObject({ ok: false, field: 'title' });
    expect(readMemoryInput({ title: 'x', text: 'y'.repeat(1001) }, ['title', 'text'])).toMatchObject({ ok: false, field: 'text' });
    expect(readMemoryInput({ tags: Array.from({ length: 9 }, (_, i) => `t${i}`) })).toMatchObject({ ok: false, field: 'tags' });
    expect(readMemoryInput({ pinned: 'yes' })).toMatchObject({ ok: false, field: 'pinned' });
    expect(readMemoryCap({ cap: 4000 })).toBe(4000);
    expect(readMemoryCap({ cap: 100 })).toBeNull();
  });

  it('near-identical titles', () => {
    expect(nearDuplicateTitle('Build command', 'build-command!')).toBe(true);
    expect(nearDuplicateTitle('Build command', 'Build commands')).toBe(true);
    expect(nearDuplicateTitle('Où sont les tests', 'Ou sont les tests')).toBe(true);
    expect(nearDuplicateTitle('Build command', 'Test command')).toBe(false);
    expect(nearDuplicateTitle('CI', 'CD')).toBe(false);
  });

  it('texts', () => {
    expect(memoryProposalsTitle(3, 'Acme app')).toBe('3 memory proposals for Acme app');
    expect(memoryProposalsTitle(1, 'Acme app')).toBe('1 memory proposal for Acme app');
    expect(memoryCountText(1)).toBe('Memory: 1 entry');
    expect(memoryCountText(4)).toBe('Memory: 4 entries');
  });
});

/** D107 follow-up 2026-10-15 · scopes: order, budgets with spill-over both ways, the overflow line. */
describe('D107 follow-up · scoped blocks', () => {
  const REPO = { key: 'github.com/acme/app', label: 'app' };
  const MEMBER: MemoryReach = { memberId: 'm1', memberLabel: 'Builder', repos: [REPO] };
  const PLAIN: MemoryReach = { memberId: null, memberLabel: null, repos: [REPO] };

  /** An approved entry whose block text is exactly `size` characters. */
  function sized(kind: 'member' | 'repo' | 'workspace', size: number, title: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
    const base = entry({ title, text: '', scopeKind: kind, scopeKey: kind === 'member' ? 'm1' : kind === 'repo' ? REPO.key : null, scopeLabel: kind === 'member' ? 'Builder' : kind === 'repo' ? 'app' : null, ...overrides });
    const pad = size - memoryEntryText({ ...base, text: '' }).length;
    return { ...base, text: 'y'.repeat(pad) };
  }

  it('budgets: 50 / 30 / 20 for a member; without one the member share goes to repo and workspace (3 : 2)', () => {
    expect(memoryBudgets(4000, true)).toEqual({ member: 2000, repo: 1200, workspace: 800 });
    expect(memoryBudgets(4000, false)).toEqual({ member: 0, repo: 2400, workspace: 1600 });
  });

  it('visibility and the default proposal scope', () => {
    expect(memoryVisible({ scope: '/w', scopeKind: 'workspace', scopeKey: null }, '/w', PLAIN)).toBe(true);
    expect(memoryVisible({ scope: '/other', scopeKind: 'workspace', scopeKey: null }, '/w', PLAIN)).toBe(false);
    expect(memoryVisible({ scope: '/other', scopeKind: 'repo', scopeKey: REPO.key }, '/w', PLAIN)).toBe(true);
    expect(memoryVisible({ scope: '/w', scopeKind: 'member', scopeKey: 'm1' }, '/w', PLAIN)).toBe(false);
    expect(memoryVisible({ scope: '/other', scopeKind: 'member', scopeKey: 'm1' }, '/w', MEMBER)).toBe(true);
    expect(defaultProposalScope(MEMBER)).toBe('member');
    expect(defaultProposalScope(PLAIN)).toBe('repo');
    expect(defaultProposalScope({ ...PLAIN, repos: [REPO, { key: 'k2', label: 'other' }] })).toBe('workspace');
    expect(defaultProposalScope({ ...PLAIN, repos: [] })).toBe('workspace');
  });

  it('member first, then repo, then workspace; within each pinned first, then newest', () => {
    const ws = sized('workspace', 50, 'Workspace new');
    const repo = sized('repo', 50, 'Repo fact');
    const memberOld = sized('member', 50, 'Member old');
    const memberPinned = sized('member', 50, 'Member pinned', { pinned: true, updatedAt: '2026-01-01T00:00:00.000Z', decidedAt: '2026-01-01T00:00:00.000Z' });
    const parts = memoryBlockParts([ws, repo, memberOld, memberPinned], 4000, 'Acme', MEMBER) as NonNullable<ReturnType<typeof memoryBlockParts>>;
    expect(parts.included).toEqual([memberPinned.id, memberOld.id, repo.id, ws.id]);
    expect(parts.counts).toEqual({ member: 2, repo: 1, workspace: 1 });
    const lines = parts.text.split('\n').filter((line) => line.startsWith('-- '));
    expect(lines).toEqual(['-- For you, Builder (member memory) --', '-- Repository app (repo memory) --', '-- Everyone in Acme (workspace memory) --']);
  });

  it('unused budget passes on: a small member share leaves room for a big repo entry', () => {
    // cap 1000 → member 500, repo 300, workspace 200.
    const member = sized('member', 200, 'Small member fact');
    const repo = sized('repo', 500, 'Big repo fact');
    const ws = sized('workspace', 200, 'Workspace fact');
    const parts = memoryBlockParts([member, repo, ws], 1000, 'Acme', MEMBER) as NonNullable<ReturnType<typeof memoryBlockParts>>;
    // member 200 (300 left over) → repo 300 + 300 = 600 takes 501 → workspace 200 + 99 = 299 takes 201.
    expect(parts.included).toEqual([member.id, repo.id, ws.id]);
    expect(parts.overflow).toEqual([]);
  });

  it('and back down: room left by later scopes goes to the member scope that stopped early; the rest are named', () => {
    // cap 1000 → member 500: the first 300 fits, the second (301) does not; repo and workspace leave room.
    const m1 = sized('member', 300, 'Member one', { pinned: true });
    const m2 = sized('member', 300, 'Member two');
    const m3 = sized('member', 300, 'Member three', { updatedAt: '2026-01-01T00:00:00.000Z', decidedAt: '2026-01-01T00:00:00.000Z' });
    const ws = sized('workspace', 100, 'Workspace fact');
    const parts = memoryBlockParts([m1, m2, m3, ws], 1000, 'Acme', MEMBER) as NonNullable<ReturnType<typeof memoryBlockParts>>;
    // Pass 1: member 300; repo none; workspace 101. Pass 2: 599 left → member two (301) fits, member three (301) does not.
    expect(parts.included).toEqual([m1.id, m2.id, ws.id]);
    expect(parts.overflow).toEqual([m3.id]);
    expect(parts.counts).toEqual({ member: 2, repo: 0, workspace: 1 });
    expect(parts.text).toContain('1 more approved entry, not shown to save space: "Member three". Read them with the switchboard memory_list tool when they matter.');
    // The text kept within the cap (headings and head lines are not counted).
    const body = parts.text.split('\n').filter((line) => line.startsWith('- ') || line.startsWith('  ')).join('\n');
    expect(body.length).toBeLessThanOrEqual(1000);
  });

  it("a non-member session never sees member entries; its member share went to repo and workspace", () => {
    const member = sized('member', 100, 'Someone else');
    const repo = sized('repo', 550, 'Repo fact');
    const ws = sized('workspace', 350, 'Workspace fact');
    // cap 1000 without a member → repo 600, workspace 400: both fit.
    const parts = memoryBlockParts([member, repo, ws], 1000, 'Acme', PLAIN) as NonNullable<ReturnType<typeof memoryBlockParts>>;
    expect(parts.included).toEqual([repo.id, ws.id]);
    expect(parts.text).not.toContain('Someone else');
  });

  it('a workspace-only block reads exactly as before scopes', () => {
    const a = entry({ title: 'Kept' });
    const b = entry({ title: 'Also kept' });
    expect(memoryBlock([a, b], 4000, 'Acme', PLAIN)).toBe(memoryBlock([a, b], 4000, 'Acme'));
    expect(memoryBlock([a, b], 4000, 'Acme') as string).not.toContain('-- ');
    expect((memoryBlock([a, b], 4000, 'Acme') as string).split('\n')[1]).toMatch(/^Folder: Acme\. Durable facts and conventions about this project/);
  });
});
