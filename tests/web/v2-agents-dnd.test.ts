import { describe, expect, it } from 'vitest';
import { AGENT_DRAG_TYPE, FOLDER_DRAG_TYPE, type DropRules, dragKindOf, dragPayload, dropOf, droppedIdOf, hoverOf } from '../../src/web/v2/agents/dnd-model.ts';

/**
 * 2.4.16 · the v2 folder tree's drag payloads (`dnd-model.ts`, the rules behind
 * `dnd.ts`): an agent and a folder carry their own data types, and a drop target
 * takes only the kinds it handles, so an agent dropped on a folder row never moves
 * a folder (and the other way round); a refused folder gets no highlight and its
 * reason on the drop.
 */

/** What a drag of `kind` / `id` leaves in the drop's data. */
function transfer(kind: 'agent' | 'folder', id: string): Map<string, string> {
  return new Map(dragPayload(kind, id));
}

const agentsOnly: DropRules = { agents: true };
const folderRow: DropRules = { agents: true, folderRefusal: (id) => (id === 'self' ? 'A folder can’t go inside itself.' : null) };
const foldersHeading: DropRules = { agents: false, folderRefusal: () => null };

describe('v2 tree drag payloads', () => {
  it('an agent and a folder carry different data types', () => {
    const agent = transfer('agent', 's1');
    expect(agent.get(AGENT_DRAG_TYPE)).toBe('s1');
    expect(agent.has(FOLDER_DRAG_TYPE)).toBe(false);
    expect(dragKindOf([...agent.keys()])).toBe('agent');
    const folder = transfer('folder', 'f1');
    expect(folder.get(FOLDER_DRAG_TYPE)).toBe('f1');
    expect(folder.has(AGENT_DRAG_TYPE)).toBe(false);
    // No text/plain: a folder id never reaches an agent handler's fallback.
    expect(folder.has('text/plain')).toBe(false);
    expect(dragKindOf([...folder.keys()])).toBe('folder');
    expect(dragKindOf(['Files'])).toBeNull();
    expect(dragKindOf([])).toBeNull();
  });

  it('reads the dropped id of its own kind only', () => {
    const agent = transfer('agent', 's1');
    const folder = transfer('folder', 'f1');
    const read = (data: Map<string, string>) => (type: string) => data.get(type) ?? '';
    expect(droppedIdOf('agent', read(agent), null)).toBe('s1');
    expect(droppedIdOf('folder', read(folder), null)).toBe('f1');
    expect(droppedIdOf('agent', read(folder), null)).toBeNull();
    expect(droppedIdOf('folder', read(agent), null)).toBeNull();
    // A browser that refused the custom type: text/plain for an agent, else the page's own record.
    expect(droppedIdOf('agent', read(new Map([['text/plain', 's2']])), null)).toBe('s2');
    expect(droppedIdOf('folder', read(new Map()), 'f9')).toBe('f9');
  });

  it('a folder row takes both, each to its own handler', () => {
    expect(hoverOf('agent', folderRow, null)).toBe('ok');
    expect(hoverOf('folder', folderRow, 'f1')).toBe('ok');
    expect(dropOf('agent', 's1', folderRow)).toEqual({ kind: 'agent', id: 's1' });
    expect(dropOf('folder', 'f1', folderRow)).toEqual({ kind: 'folder', id: 'f1' });
  });

  it('an agent-only target ignores a folder; a folders-only target ignores an agent', () => {
    expect(hoverOf('folder', agentsOnly, 'f1')).toBe('ignore');
    expect(dropOf('folder', 'f1', agentsOnly)).toEqual({ kind: 'ignore' });
    expect(hoverOf('agent', foldersHeading, null)).toBe('ignore');
    expect(dropOf('agent', 's1', foldersHeading)).toEqual({ kind: 'ignore' });
    expect(dropOf('folder', 'f1', foldersHeading)).toEqual({ kind: 'folder', id: 'f1' });
    expect(hoverOf(null, folderRow, null)).toBe('ignore');
    expect(dropOf('agent', null, folderRow)).toEqual({ kind: 'ignore' });
  });

  it('a refused folder: no highlight over the target, the reason on the drop, no move', () => {
    expect(hoverOf('folder', folderRow, 'self')).toBe('refused');
    expect(dropOf('folder', 'self', folderRow)).toEqual({ kind: 'refused', reason: 'A folder can’t go inside itself.' });
    // An agent is never refused by the folder rule.
    expect(dropOf('agent', 'self', folderRow)).toEqual({ kind: 'agent', id: 'self' });
  });

  it('D151 · a folder dropped where it already is: no highlight, and the drop does nothing (no move, no reason)', () => {
    const parentRow: DropRules = { ...folderRow, folderUnchanged: (id) => id === 'child' };
    expect(hoverOf('folder', parentRow, 'child')).toBe('refused');
    expect(dropOf('folder', 'child', parentRow)).toEqual({ kind: 'ignore' });
    expect(dropOf('folder', 'f1', parentRow)).toEqual({ kind: 'folder', id: 'f1' });
    // Agents are unchanged.
    expect(dropOf('agent', 'child', parentRow)).toEqual({ kind: 'agent', id: 'child' });
  });
});
