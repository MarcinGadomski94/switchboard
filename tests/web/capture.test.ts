import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/core/api.ts';
import { FLOAT_GAP, FLOAT_MARGIN, floatPlace, selectionIn } from '../../src/web/capture/place.ts';
import { ADD_TODO_QUERY, PALETTE_MAX_RESULTS, paletteEntries, paletteTodoEntries } from '../../src/web/modals/palette.ts';

/**
 * D81 (`docs/todos.md` → *Quick capture (D81)*): the palette's `todo <text>` results and
 * "Add todo…", and where the chat selection's "Add to todo" sits.
 */

function session(id: string, lastActivityAt: string | null, extra: Partial<Session> = {}): Session {
  return { id, name: id, title: null, status: 'idle', createdAt: '2026-10-01T00:00:00.000Z', lastActivityAt, mode: null, workType: null, phase: null, solutions: [], ...extra } as unknown as Session;
}

const SESSIONS = [
  session('older', '2026-10-07T00:00:00.000Z'),
  session('newest', '2026-10-08T09:00:00.000Z', { title: 'Newest work' }),
  session('closed', '2026-10-08T10:00:00.000Z', { closedAt: '2026-10-08T10:00:00.000Z' }),
  session('current', '2026-10-06T00:00:00.000Z'),
];

describe('the palette (D81)', () => {
  it('"Add todo…" is an action after New session; picking it types `todo `', () => {
    const entries = paletteEntries({ sessions: null, tools: null, solutions: null });
    const at = entries.findIndex((entry) => entry.key === 'action:new-session');
    expect(entries[at + 1]).toMatchObject({ kind: 'action', label: 'Add todo…', hint: 'todo <title>', target: { type: 'add-todo' } });
    expect(ADD_TODO_QUERY).toBe('todo ');
  });

  it('not a todo command: null (the normal results); `todo ` alone asks for the title', () => {
    expect(paletteTodoEntries('settings', SESSIONS, null)).toBeNull();
    expect(paletteTodoEntries('todo', SESSIONS, null)).toBeNull();
    expect(paletteTodoEntries('todo ', SESSIONS, null)).toEqual([{ key: 'todo:empty', kind: 'todo', label: 'Add todo…', hint: 'type the title', target: { type: 'none' } }]);
  });

  it('in a session: that session first, then the other open sessions recent first', () => {
    const rows = paletteTodoEntries('todo Fix the flake', SESSIONS, 'current') ?? [];
    expect(rows.map((row) => `${row.label} | ${row.hint}`)).toEqual(['Add “Fix the flake” | to current', 'Add to Newest work | ', 'Add to older | ']);
    expect(rows[0]?.target).toEqual({ type: 'capture', sessionId: 'current', title: 'Fix the flake', note: null });
  });

  it('outside a session: the open sessions to pick, recent first; a long text is cut for the title and kept whole as the note', () => {
    const rows = paletteTodoEntries('todo Fix', SESSIONS, null) ?? [];
    expect(rows.map((row) => `${row.label} | ${row.hint}`)).toEqual(['Newest work | add “Fix”', 'older | add “Fix”', 'current | add “Fix”']);
    const long = `todo ${'word '.repeat(40)}end`;
    const [first] = paletteTodoEntries(long, SESSIONS, null) ?? [];
    const target = first?.target as { title: string; note: string | null };
    expect(target.title.length).toBeLessThanOrEqual(120);
    expect(target.title.endsWith('…')).toBe(true);
    expect(target.note).toBe(long.slice(5).trim());
    const many = Array.from({ length: 14 }, (_, i) => session(`s${i}`, `2026-10-0${(i % 9) + 1}T00:00:00.000Z`));
    expect(paletteTodoEntries('todo x', many, null)).toHaveLength(PALETTE_MAX_RESULTS);
  });
});

describe('the selection action (D81)', () => {
  const viewport = { width: 400, height: 800 };
  const size = { width: 128, height: 32 };

  it('sits under the selection, centred, inside the window; above it when there is no room below', () => {
    expect(floatPlace({ left: 100, top: 200, width: 100, height: 20 }, size, viewport)).toEqual({ left: 86, top: 220 + FLOAT_GAP, below: true });
    expect(floatPlace({ left: 0, top: 200, width: 10, height: 20 }, size, viewport).left).toBe(FLOAT_MARGIN);
    expect(floatPlace({ left: 390, top: 200, width: 10, height: 20 }, size, viewport).left).toBe(400 - 128 - FLOAT_MARGIN);
    expect(floatPlace({ left: 100, top: 760, width: 100, height: 20 }, size, viewport)).toEqual({ left: 86, top: 760 - FLOAT_GAP - 32, below: false });
    expect(floatPlace({ left: 100, top: 0, width: 100, height: 800 }, size, viewport)).toEqual({ left: 86, top: 800 - 32 - FLOAT_MARGIN, below: true });
  });

  it('only a selection wholly inside the conversation counts', () => {
    const inside = { id: 'in' };
    const outside = { id: 'out' };
    const container = { contains: (node: unknown) => node === inside };
    const sel = (anchor: unknown, focus: unknown, text: string, collapsed = false) => ({ isCollapsed: collapsed, rangeCount: 1, anchorNode: anchor, focusNode: focus, toString: () => text });
    expect(selectionIn(container, sel(inside, inside, '  picked text '))).toBe('picked text');
    expect(selectionIn(container, sel(inside, outside, 'x'))).toBeNull();
    expect(selectionIn(container, sel(inside, inside, '   '))).toBeNull();
    expect(selectionIn(container, sel(inside, inside, 'x', true))).toBeNull();
    expect(selectionIn(null, sel(inside, inside, 'x'))).toBeNull();
  });
});
