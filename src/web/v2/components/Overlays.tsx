import { type CSSProperties, type ReactNode, useId, useRef } from 'react';
import { IconButton } from './Button.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { useAnchoredPosition, useEscape, useFocusScope, useOutside } from './overlay.ts';

/**
 * D131 · a popover anchored to a button (`.pop`, e.g. the status pill's): a
 * non-modal `dialog`; Escape or a click outside closes it and focus returns to
 * the anchor.
 */
export function Popover({ open, onClose, anchor, label, children, align = 'end', width, testId }: { readonly open: boolean; readonly onClose: () => void; readonly anchor: HTMLElement | null; readonly label: string; readonly children: ReactNode; readonly align?: 'start' | 'end'; readonly width?: number; readonly testId?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  const pos = useAnchoredPosition(anchor, ref, open, align);
  useEscape(open, () => {
    onClose();
    anchor?.focus({ preventScroll: true });
  });
  useOutside([ref, anchorRef], open, onClose);
  if (!open) return null;
  const style: CSSProperties = { ...(pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }), ...(width ? { width } : {}) };
  return (
    <div ref={ref} className="v2-pop" role="dialog" aria-label={label} data-testid={testId} style={style} tabIndex={-1}>
      {children}
    </div>
  );
}

/** The header of the modal overlays: icon, title, close. */
function OverlayHeader({ className, titleId, title, icon, onClose, extra }: { readonly className: string; readonly titleId: string; readonly title: ReactNode; readonly icon?: IconName | string; readonly onClose: () => void; readonly extra?: ReactNode }) {
  return (
    <div className={className}>
      {icon ? <Icon name={icon} size="l" /> : null}
      <h2 id={titleId}>{title}</h2>
      {extra}
      <IconButton icon="x" label="Close" onClick={onClose} data-testid="v2-overlay-close" />
    </div>
  );
}

/**
 * D131 · a modal dialog (`.scrim` + `.modal`): focus moves in and stays in, Escape
 * or the scrim closes it. `footer` = the buttons row.
 */
export function Dialog({ open, onClose, title, icon, children, footer, width, testId, labelledBy }: { readonly open: boolean; readonly onClose: () => void; readonly title?: ReactNode; readonly icon?: IconName | string; readonly children: ReactNode; readonly footer?: ReactNode; readonly width?: number; readonly testId?: string; readonly labelledBy?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  useEscape(open, onClose);
  useFocusScope(ref, open, true);
  if (!open) return null;
  return (
    <div
      className="v2-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="v2-modal" role="dialog" aria-modal="true" aria-labelledby={title ? titleId : labelledBy} data-testid={testId} style={width ? { width } : undefined} tabIndex={-1}>
        {title ? <OverlayHeader className="v2-modal-h" titleId={titleId} title={title} icon={icon} onClose={onClose} /> : null}
        <div className="v2-modal-b">{children}</div>
        {footer ? <div className="v2-modal-f">{footer}</div> : null}
      </div>
    </div>
  );
}

/**
 * D131 · the side sheet (`.sheet`, the peek): slides in from the right over a
 * light scrim; modal (focus kept inside), Escape or the scrim closes it.
 */
export function Sheet({ open, onClose, title, children, header, width, testId }: { readonly open: boolean; readonly onClose: () => void; readonly title: ReactNode; readonly children: ReactNode; readonly header?: ReactNode; readonly width?: string; readonly testId?: string }) {
  const ref = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEscape(open, onClose);
  useFocusScope(ref, open, true);
  if (!open) return null;
  return (
    <>
      <div className="v2-sheet-scrim" onMouseDown={onClose} aria-hidden="true" />
      <aside ref={ref} className="v2-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId} style={width ? { width } : undefined} tabIndex={-1}>
        <OverlayHeader className="v2-sheet-h" titleId={titleId} title={title} onClose={onClose} extra={header} />
        <div className="v2-sheet-b">{children}</div>
      </aside>
    </>
  );
}

/**
 * D131 · a drawer (`.drawer`, e.g. the result preview): a panel fixed to one side,
 * without a scrim (the page stays usable); Escape closes it. `full` = full screen.
 */
export function Drawer({ open, onClose, title, children, actions, side = 'right', full = false, testId }: { readonly open: boolean; readonly onClose: () => void; readonly title: ReactNode; readonly children: ReactNode; readonly actions?: ReactNode; readonly side?: 'left' | 'right'; readonly full?: boolean; readonly testId?: string }) {
  const ref = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEscape(open, onClose);
  useFocusScope(ref, open, false);
  if (!open) return null;
  return (
    <aside ref={ref} className="v2-drawer" data-side={side} {...(full ? { 'data-full': '' } : {})} role="dialog" aria-labelledby={titleId} data-testid={testId} tabIndex={-1}>
      <div className="v2-drawer-h">
        <div className="v2-grow" id={titleId}>
          {title}
        </div>
        {actions}
        <IconButton icon="x" label="Close" onClick={onClose} />
      </div>
      <div className="v2-drawer-b">{children}</div>
    </aside>
  );
}

/**
 * D131 · the phone's bottom sheet: rises from the bottom over a scrim; modal,
 * Escape or the scrim closes it. Used for menus, pickers and the More tab's
 * extras on a phone.
 */
export function BottomSheet({ open, onClose, title, children, testId }: { readonly open: boolean; readonly onClose: () => void; readonly title: ReactNode; readonly children: ReactNode; readonly testId?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  useEscape(open, onClose);
  useFocusScope(ref, open, true);
  if (!open) return null;
  return (
    <>
      <div className="v2-bsheet-scrim" onMouseDown={onClose} aria-hidden="true" />
      <div ref={ref} className="v2-bsheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId} tabIndex={-1}>
        <div className="v2-bsheet-grip" aria-hidden="true" />
        <OverlayHeader className="v2-bsheet-h" titleId={titleId} title={title} onClose={onClose} />
        <div className="v2-bsheet-b">{children}</div>
      </div>
    </>
  );
}
