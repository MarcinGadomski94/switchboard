import type { CSSProperties, HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';

/**
 * D131 · a surface (`.card`). `interactive` makes it a focusable button-like card
 * (Enter / Space activate `onClick`, the hover lift of the prototype); `pad` adds
 * the 18 px padding.
 */
export function Card({ interactive = false, pad = false, className, children, onClick, onKeyDown, ...rest }: HTMLAttributes<HTMLDivElement> & { readonly interactive?: boolean; readonly pad?: boolean; readonly children?: ReactNode }) {
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event);
    if (!interactive || event.defaultPrevented || event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.currentTarget.click();
    }
  };
  return (
    <div
      className={className ? `v2-card ${className}` : 'v2-card'}
      {...(interactive ? { 'data-interactive': '', role: rest.role ?? 'button', tabIndex: rest.tabIndex ?? 0 } : {})}
      {...(pad ? { 'data-pad': '' } : {})}
      onClick={onClick}
      onKeyDown={keyDown}
      {...rest}
    >
      {children}
    </div>
  );
}

/** D131 · a loading placeholder bar (`.skel`); `lines` stacks several (the last shorter). */
export function Skeleton({ width = '100%', height = 12, lines = 1, style }: { readonly width?: number | string; readonly height?: number; readonly lines?: number; readonly style?: CSSProperties }) {
  if (lines <= 1) return <div className="v2-skel" aria-hidden="true" style={{ width, height, ...style }} />;
  return (
    <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: 8, ...style }}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="v2-skel" style={{ width: i === lines - 1 ? '60%' : width, height }} />
      ))}
    </div>
  );
}

/** D131 · an empty state (`.empty`): "All clear" and its kind. */
export function EmptyState({ icon = 'check', title, text, action, tone = 'green', testId }: { readonly icon?: IconName | string; readonly title: string; readonly text?: ReactNode; readonly action?: ReactNode; readonly tone?: 'green' | 'grey'; readonly testId?: string }) {
  return (
    <div className="v2-empty" data-tone={tone === 'green' ? undefined : tone} data-testid={testId} role="status">
      <div className="v2-empty-big">
        <Icon name={icon} size="l" />
      </div>
      <h3>{title}</h3>
      {text ? <p>{text}</p> : null}
      {action ? <div className="v2-empty-action">{action}</div> : null}
    </div>
  );
}
