import type { DragEvent, KeyboardEvent } from 'react';

/**
 * D131 · lane A · dragging agents onto folders (native drag and drop, as the
 * prototype): a row or card is a drag source; a folder row, a crew row and the
 * "Not in a folder" heading are drop targets. The keyboard way is Move to
 * folder… (`M` on a focused row).
 */

/** The data type a dragged agent carries. */
export const AGENT_DRAG_TYPE = 'application/x-switchboard-agent';

let dragging: string | null = null;

/** The drag-source props of an agent row or card. */
export function dragSource(id: string): { readonly draggable: true; readonly onDragStart: (event: DragEvent<HTMLElement>) => void; readonly onDragEnd: (event: DragEvent<HTMLElement>) => void } {
  return {
    draggable: true,
    onDragStart: (event) => {
      dragging = id;
      event.currentTarget.setAttribute('data-dragging', '');
      try {
        event.dataTransfer.setData(AGENT_DRAG_TYPE, id);
        event.dataTransfer.setData('text/plain', id);
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

/** The drop-target props of a folder row, a crew row or the loose heading; `onDrop` gets the agent id. */
export function dropTarget(onDrop: (agentId: string) => void): { readonly onDragOver: (event: DragEvent<HTMLElement>) => void; readonly onDragLeave: (event: DragEvent<HTMLElement>) => void; readonly onDrop: (event: DragEvent<HTMLElement>) => void } {
  return {
    onDragOver: (event) => {
      if (!dragging && !event.dataTransfer.types.includes(AGENT_DRAG_TYPE)) return;
      event.preventDefault();
      try {
        event.dataTransfer.dropEffect = 'move';
      } catch {
        // Read-only in some phases.
      }
      event.currentTarget.setAttribute('data-drop-ok', '');
    },
    onDragLeave: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.removeAttribute('data-drop-ok');
    },
    onDrop: (event) => {
      event.preventDefault();
      event.currentTarget.removeAttribute('data-drop-ok');
      let id = dragging;
      try {
        id = event.dataTransfer.getData(AGENT_DRAG_TYPE) || event.dataTransfer.getData('text/plain') || dragging;
      } catch {
        // Fall back to the module's own record.
      }
      dragging = null;
      if (id) onDrop(id);
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
