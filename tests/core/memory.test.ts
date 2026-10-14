import { describe, expect, it } from 'vitest';
import {
  MEMORY_BLOCK_END,
  MEMORY_BLOCK_START,
  MEMORY_OVERFLOW_TITLES,
  type MemoryEntry,
  memoryBlock,
  memoryBlockParts,
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
