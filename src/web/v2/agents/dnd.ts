import type { DragEvent, KeyboardEvent } from 'react';
import { type DragKind, type DropRules, dragKindOf, dragPayload, dropOf, droppedIdOf, hoverOf } from './dnd-model.ts';

/**
 * D131 · lane A · dragging agents and folders in the folder tree (native drag
 * and drop, as the prototype): an agent row or card is a drag source; so is a
 * folder row (2.4.16: it moves into another folder, or onto Folders / Not in a
 * folder for the top level). A folder row, a crew row and the headings are drop
 * targets. The two payloads have their own data types (the rules: `dnd-model.ts`),
 * so a target never takes a folder for an agent or the other way round. The
 * keyboard way is Move to folder… (`M` on a focused row) and a folder's ⋯ › Move
 * to… (`M` on it too).
 */

let dragging: { readonly kind: DragKind; readonly id: string } | null = null;

type SourceProps = { readonly draggable: true; readonly onDragStart: (event: DragEvent<HTMLElement>) => void; readonly onDragEnd: (event: DragEvent<HTMLElement>) => void };

function source(kind: DragKind, id: string): SourceProps {
  return {
    draggable: true,
    onDragStart: (event) => {
      dragging = { kind, id };
      event.currentTarget.setAttribute('data-dragging', '');
      try {
        for (const [type, value] of dragPayload(kind, id)) event.dataTransfer.setData(type, value);
        event.dataTransfer.effectAllowed = 'move';
      } catch {
        // Some browsers refuse custom types; `dragging` still carries it.
      }
    },
    onDragEnd: (event) => {
      dragging = null;
      event.currentTarget.removeAttribute('data-dragging');
      for (const el of document.querySelectorAll('[data-drop-ok]')) el.removeAttribute('data-drop-ok');
    },
  };
}

/** The drag-source props of an agent row or card. */
export function dragSource(id: string): SourceProps {
  return source('agent', id);
}

/** The drag-source props of a folder row (2.4.16). */
export function folderDragSource(id: string): SourceProps {
  return source('folder', id);
}

/** What a target does with a dragged folder. */
export interface FolderDrop {
  /** Why the folder cannot go here (`null` = it can): no highlight on hover, and `onRefused` on a drop. */
  readonly refusal: (folderId: string) => string | null;
  /** D151: the folder is already here: a drop does nothing (no move, no toast). */
  readonly unchanged?: (folderId: string) => boolean;
  readonly onDrop: (folderId: string) => void;
  readonly onRefused: (reason: string) => void;
}

/** What a drop target takes: agents (`onAgent`), folders (`folder`), or both. */
export interface DropHandlers {
  readonly onAgent?: (agentId: string) => void;
  readonly folder?: FolderDrop;
}

function kindOf(event: DragEvent<HTMLElement>): DragKind | null {
  return dragging?.kind ?? dragKindOf(Array.from(event.dataTransfer?.types ?? []));
}

/**
 * The drop-target props of a folder row, a crew row or a heading. A function is
 * the agent handler (the targets that take agents only); {@link DropHandlers}
 * adds folders. A drag the target does not take is not accepted (the browser's
 * "no drop"); a folder it refuses is accepted without the highlight, so the drop
 * can say why.
 */
export function dropTarget(handlers: DropHandlers | ((agentId: string) => void)): { readonly onDragOver: (event: DragEvent<HTMLElement>) => void; readonly onDragLeave: (event: DragEvent<HTMLElement>) => void; readonly onDrop: (event: DragEvent<HTMLElement>) => void } {
  const { onAgent, folder }: DropHandlers = typeof handlers === 'function' ? { onAgent: handlers } : handlers;
  const rules: DropRules = { agents: onAgent !== undefined, ...(folder ? { folderRefusal: folder.refusal, ...(folder.unchanged ? { folderUnchanged: folder.unchanged } : {}) } : {}) };
  return {
    onDragOver: (event) => {
      // Only this page's own drag says which folder it is while over a target (the data is readable on drop only).
      const hover = hoverOf(kindOf(event), rules, dragging?.kind === 'folder' ? dragging.id : null);
      if (hover === 'ignore') return;
      event.preventDefault();
      try {
        event.dataTransfer.dropEffect = 'move';
      } catch {
        // Read-only in some phases.
      }
      if (hover === 'refused') event.currentTarget.removeAttribute('data-drop-ok');
      else event.currentTarget.setAttribute('data-drop-ok', '');
    },
    onDragLeave: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.removeAttribute('data-drop-ok');
    },
    onDrop: (event) => {
      const kind = kindOf(event);
      if (kind === null || hoverOf(kind, rules, null) === 'ignore') return;
      event.preventDefault();
      event.currentTarget.removeAttribute('data-drop-ok');
      let id: string | null = dragging?.kind === kind ? dragging.id : null;
      try {
        id = droppedIdOf(kind, (type) => event.dataTransfer.getData(type), id);
      } catch {
        // Fall back to the module's own record.
      }
      dragging = null;
      const outcome = dropOf(kind, id, rules);
      if (outcome.kind === 'agent') onAgent?.(outcome.id);
      else if (outcome.kind === 'folder') folder?.onDrop(outcome.id);
      else if (outcome.kind === 'refused') folder?.onRefused(outcome.reason);
    },
  };
}

/** `true` for the M key on a focused row (not in a field, no modifier). */
export function isMoveKey(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target as HTMLElement;
  if (target.closest('input, textarea, select, [contenteditable="true"]')) return false;
  return event.key === 'm' || event.key === 'M';
}
