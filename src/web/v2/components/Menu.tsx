import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { IconButton } from './Button.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { Portal } from './Portal.tsx';
import { useAnchoredPosition, useEscape, useOutside } from './overlay.ts';

/** One entry of a {@link Menu}: an action, or a separator. */
export type MenuItem =
  | {
      readonly id: string;
      readonly label: string;
      readonly icon?: IconName | string;
      /** A shortcut shown on the right (`M`). */
      readonly kbd?: string;
      readonly danger?: boolean;
      /** Disabled, with the reason shown under it (actions are never silently missing). */
      readonly disabledReason?: string;
      readonly onSelect: () => void;
    }
  | { readonly separator: true; readonly id: string };

/**
 * D131 · the ⋯ menu (`.menu`): `role="menu"` anchored to its button; ↑/↓, Home,
 * End move; Enter / Space pick; Escape or a click outside closes and focus goes
 * back to the button. A disabled item says why.
 */
export function Menu({ items, anchor, open, onClose, label, align = 'end', testId, id }: { readonly id?: string; readonly items: readonly MenuItem[]; readonly anchor: HTMLElement | null; readonly open: boolean; readonly onClose: () => void; readonly label: string; readonly align?: 'start' | 'end'; readonly testId?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pos = useAnchoredPosition(anchor, ref, open, align);
  const close = (): void => {
    onClose();
    anchor?.focus({ preventScroll: true });
  };
  useEscape(open, close);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  useOutside([ref, anchorRef], open, onClose);
  if (!open) return null;
  const buttons = (): HTMLElement[] => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const list = buttons();
    const index = list.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') next = list[index + 1] ?? list[0];
    else if (event.key === 'ArrowUp') next = list[index - 1] ?? list[list.length - 1];
    else if (event.key === 'Home') next = list[0];
    else if (event.key === 'End') next = list[list.length - 1];
    else if (event.key === 'Tab') {
      close();
      return;
    } else return;
    event.preventDefault();
    next?.focus();
  };
  return (
    <Portal>
    <div
      ref={(el) => {
        ref.current = el;
        // Focus the first item once mounted (keyboard users land in the menu).
        if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true });
      }}
      id={id}
      className="v2-menu"
      role="menu"
      aria-label={label}
      data-testid={testId}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
      onKeyDown={onKey}
    >
      {items.map((item) => {
        if ('separator' in item) return <hr key={item.id} />;
        const disabled = item.disabledReason !== undefined;
        return (
          <div key={item.id}>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-item={item.id}
              aria-disabled={disabled || undefined}
              {...(item.danger ? { 'data-danger': '' } : {})}
              onClick={() => {
                if (disabled) return;
                onClose();
                item.onSelect();
              }}
            >
              {item.icon ? <Icon name={item.icon} size="s" /> : null}
              <span className="v2-grow">{item.label}</span>
              {item.kbd ? <span className="v2-kbd">{item.kbd}</span> : null}
            </button>
            {disabled ? <div className="v2-menu-why">{item.disabledReason}</div> : null}
          </div>
        );
      })}
    </div>
    </Portal>
  );
}

/** D131 · the ⋯ button with its {@link Menu}. */
export function MenuButton({ items, label, icon = 'more', testId }: { readonly items: readonly MenuItem[]; readonly label: string; readonly icon?: IconName | string; readonly testId?: string }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  return (
    <>
      <IconButton
        ref={setAnchor}
        icon={icon}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid={testId}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      />
      <Menu id={menuId} items={items} anchor={anchor} open={open} onClose={() => setOpen(false)} label={label} testId={testId ? `${testId}-menu` : undefined} />
    </>
  );
}
