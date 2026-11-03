/**
 * D131 · lane A · the pure rules of dragging in the folder tree (no DOM; the
 * event wiring is `dnd.ts`; unit-tested). An agent and a folder (2.4.16) carry
 * their own data types, and a drop target takes only the kinds it handles, so an
 * agent dropped on a folder row never moves a folder and the other way round.
 */

/** The data type a dragged agent carries. */
export const AGENT_DRAG_TYPE = 'application/x-switchboard-agent';

/** The data type a dragged folder carries (2.4.16). */
export const FOLDER_DRAG_TYPE = 'application/x-switchboard-folder';

/** What is being dragged. */
export type DragKind = 'agent' | 'folder';

/** The kind of a drag from its data types (`null` = not ours: a file, a link, text). */
export function dragKindOf(types: readonly string[]): DragKind | null {
  if (types.includes(FOLDER_DRAG_TYPE)) return 'folder';
  if (types.includes(AGENT_DRAG_TYPE)) return 'agent';
  return null;
}

/**
 * The data a drag sets, type → value. An agent also sets `text/plain` (the
 * browsers that refuse custom types still carry it); a folder does not, so a
 * folder id never reaches an agent handler's fallback.
 */
export function dragPayload(kind: DragKind, id: string): ReadonlyArray<readonly [string, string]> {
  return kind === 'agent'
    ? [
        [AGENT_DRAG_TYPE, id],
        ['text/plain', id],
      ]
    : [[FOLDER_DRAG_TYPE, id]];
}

/** The dropped id of `kind`, read from the drop's data (`read`), else the page's own record (`fallback`). */
export function droppedIdOf(kind: DragKind, read: (type: string) => string, fallback: string | null): string | null {
  const value = kind === 'agent' ? read(AGENT_DRAG_TYPE) || read('text/plain') : read(FOLDER_DRAG_TYPE);
  return value || fallback;
}

/** What a target takes: agents, and folders with why one is refused (`null` = it is not). */
export interface DropRules {
  readonly agents: boolean;
  readonly folderRefusal?: (folderId: string) => string | null;
}

/**
 * While a drag of `kind` is over a target: `ignore` (not taken: the browser's
 * "no drop"), `ok` (highlighted), `refused` (taken without the highlight, so the
 * drop can say why). `folderId` is the page's own folder drag, when known.
 */
export function hoverOf(kind: DragKind | null, rules: DropRules, folderId: string | null): 'ignore' | 'ok' | 'refused' {
  if (kind === 'agent') return rules.agents ? 'ok' : 'ignore';
  if (kind === 'folder' && rules.folderRefusal) return folderId !== null && rules.folderRefusal(folderId) !== null ? 'refused' : 'ok';
  return 'ignore';
}

/** What a drop does. */
export type DropOutcome = { readonly kind: 'ignore' } | { readonly kind: 'agent'; readonly id: string } | { readonly kind: 'folder'; readonly id: string } | { readonly kind: 'refused'; readonly reason: string };

/** The drop of `id` (of `kind`) on a target with `rules`. */
export function dropOf(kind: DragKind | null, id: string | null, rules: DropRules): DropOutcome {
  if (kind === null || id === null || hoverOf(kind, rules, null) === 'ignore') return { kind: 'ignore' };
  if (kind === 'agent') return { kind: 'agent', id };
  const reason = rules.folderRefusal?.(id) ?? null;
  return reason ? { kind: 'refused', reason } : { kind: 'folder', id };
}
