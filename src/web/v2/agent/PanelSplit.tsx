/**
 * D180 · the frame Files and Changes share in the side panel (`panel-layout.ts`):
 *
 * - **Wide** (the panel ≥ 760 px): the list docked on the outer (right) edge, about 290 px, and
 *   the file or diff next to the chat. The list button hides or shows the docked list.
 * - **Narrow**: the list first; once a file or diff is opened it fills the panel, and the list
 *   button pops the list over it (anchored under the content's header, at most
 *   `min(370px, 100% − 16px)` wide). A pick, Esc or a click outside closes the popover.
 *
 * The list stays mounted (hidden when it is not shown), so its folds and its scroll are kept
 * across openings.
 */
import { type ReactNode, useEffect, useRef } from 'react';
import { IconButton } from '../components/index.ts';
import type { EscTarget } from './panel-layout.ts';

/**
 * D180 · Esc in the side panel: closes `target` (`escTarget`, `panel-layout.ts`) with `onEsc`.
 * The comment box and an open menu come first: they close themselves, so a key pressed in a
 * comment box or with a menu open is left alone here. Listens on the window before the overlays
 * (the tablet drawer closes on Esc too): one Esc closes one thing.
 */
export function usePanelEsc(target: EscTarget | null, onEsc: (target: EscTarget) => void): void {
  const latest = useRef({ target, onEsc });
  latest.current = { target, onEsc };
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const { target: now, onEsc: act } = latest.current;
      if (event.key !== 'Escape' || now === null || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active?.closest('.v2-ag-chg-box') || document.querySelector('[role="menu"]')) return;
      event.preventDefault();
      event.stopPropagation();
      act(now);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

/** The list button's ids: the button names the list it controls (`aria-controls`). */
export function listId(panel: string): string {
  return `v2-side-list-${panel}`;
}

/** The list button at the far right of a file's or diff's header. */
export function ListButton({ panel, expanded, onToggle, label }: { readonly panel: string; readonly expanded: boolean; readonly onToggle: () => void; readonly label: string }) {
  return <IconButton icon="sidebar" label={label} onClick={onToggle} aria-expanded={expanded} aria-controls={listId(panel)} data-list-button="true" data-testid={`v2-side-${panel}-list-button`} />;
}

export interface PanelSplitProps {
  /** `files` or `changes`: names the list for the list button. */
  readonly panel: string;
  readonly wide: boolean;
  /** Wide: the docked list is shown. */
  readonly docked: boolean;
  /** Narrow: the list pops over the content. */
  readonly popover: boolean;
  readonly onClosePopover: () => void;
  readonly list: ReactNode;
  /** The file or diff (with its header); `null` = nothing opened (narrow: the list fills the panel). */
  readonly content: ReactNode | null;
  readonly testId: string;
}

export function PanelSplit({ panel, wide, docked, popover, onClosePopover, list, content, testId }: PanelSplitProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const shown = content === null ? true : wide ? docked : popover;
  const mode = content === null ? 'list' : wide ? (docked ? 'docked' : 'content') : popover ? 'popover' : 'content';
  // A click outside the popover (not on the list button, which toggles it itself) closes it.
  const close = useRef(onClosePopover);
  close.current = onClosePopover;
  useEffect(() => {
    if (mode !== 'popover') return undefined;
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (!target || listRef.current?.contains(target) || target.closest('[data-list-button]')) return;
      close.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [mode]);
  return (
    <div className="v2-sp-split" data-mode={mode} data-wide={wide ? 'true' : undefined} data-testid={testId}>
      {content !== null ? <div className="v2-sp-content">{content}</div> : null}
      <div ref={listRef} className="v2-sp-list" id={listId(panel)} data-shown={shown ? 'true' : undefined} aria-hidden={shown ? undefined : true} data-testid={`${testId}-list`}>
        {list}
      </div>
    </div>
  );
}
