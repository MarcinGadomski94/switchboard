import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from 'react';
import { Icon, type IconName } from './Icon.tsx';

/** The button looks of the prototype (`.btn`, `.btn.primary`, `.btn.danger`, `.btn.ghost`). */
export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

/** Props of {@link Button}. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  /** `sm` = 34 px (44 px on touch screens). */
  readonly size?: 'm' | 'sm';
  /** An icon before the label. */
  readonly icon?: IconName | string;
  /** The number key that presses it (answer cards: 1–4), shown before the label. */
  readonly num?: number;
  /** A shortcut shown after the label (`⌘↩`). */
  readonly kbd?: string;
  readonly children?: ReactNode;
}

/** D131 · a v2 button (always a real `<button>`, `type="button"` unless given). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'default', size = 'm', icon, num, kbd, children, className, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={className ? `v2-btn ${className}` : 'v2-btn'}
      data-variant={variant === 'default' ? undefined : variant}
      data-size={size === 'm' ? undefined : size}
      {...(num !== undefined ? { 'data-num': num } : {})}
      {...rest}
    >
      {num !== undefined ? (
        <span className="v2-num" aria-hidden="true">
          {num}
        </span>
      ) : null}
      {icon ? <Icon name={icon} size="s" /> : null}
      {children}
      {kbd ? (
        <span className="v2-kbd" aria-hidden="true" style={variant === 'primary' ? { background: 'transparent', color: 'inherit', borderColor: 'rgba(255,255,255,.35)' } : undefined}>
          {kbd}
        </span>
      ) : null}
    </button>
  );
});

/** Props of {@link IconButton}. */
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly icon: IconName | string;
  /** Required: the button's accessible name (and its tooltip unless `title` is given). */
  readonly label: string;
  /** A count in the corner (Needs you); 0 / absent = none. */
  readonly badge?: number;
  /** `l` = 44 px (the phone's and the touch target). */
  readonly size?: 'm' | 'l';
  readonly iconSize?: 's' | 'm' | 'l';
}

/** D131 · an icon-only button with an accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ icon, label, badge, size = 'm', iconSize = 'm', className, type = 'button', title, ...rest }, ref) {
  return (
    <button ref={ref} type={type} className={className ? `v2-icon-btn ${className}` : 'v2-icon-btn'} data-size={size === 'm' ? undefined : size} aria-label={label} title={title ?? label} {...rest}>
      <Icon name={icon} size={iconSize} />
      {badge ? (
        <span className="v2-dot-badge" aria-hidden="true">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </button>
  );
});

/** D131 · a key or shortcut (`⌘K`). */
export function Kbd({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <kbd className={className ? `v2-kbd ${className}` : 'v2-kbd'}>{children}</kbd>;
}
