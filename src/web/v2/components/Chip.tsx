import type { ReactNode } from 'react';
import { STATUS, type Tone, type V2Status } from '../glossary.ts';
import { Icon, type IconName } from './Icon.tsx';

/** D131 · a small rounded label (`.chip`); `outline` = the prototype's `.tag`. */
export function Chip({ tone, icon, size = 'm', children, title, className }: { readonly tone?: Tone | 'outline'; readonly icon?: IconName | string; readonly size?: 'm' | 's'; readonly children: ReactNode; readonly title?: string; readonly className?: string }) {
  return (
    <span className={className ? `v2-chip ${className}` : 'v2-chip'} data-tone={tone} data-size={size === 'm' ? undefined : size} title={title}>
      {icon ? <Icon name={icon} size="s" /> : null}
      {children}
    </span>
  );
}

/** The status's mark: the live dot for `working`, else its icon. */
function StatusMark({ status }: { readonly status: V2Status }) {
  const look = STATUS[status];
  return look.icon === 'pulse' ? <span className="v2-pulse" aria-hidden="true" /> : <Icon name={look.icon} size="s" />;
}

/**
 * D131 · a status: always icon + word + colour (never colour alone). `label`
 * replaces the word (e.g. "Waiting on tests · 12m"); `compact` shows only the mark
 * with the word for screen readers and as the tooltip (the rail's pins, the tree).
 */
export function StatusBadge({ status, label, size = 'm', compact = false }: { readonly status: V2Status; readonly label?: string; readonly size?: 'm' | 's'; readonly compact?: boolean }) {
  const look = STATUS[status];
  const word = label ?? look.label;
  if (compact) {
    return (
      <span className="v2-mini-st" data-tone={look.tone} data-status={status} title={word}>
        <StatusMark status={status} />
        <span className="v2-sr">{word}</span>
      </span>
    );
  }
  return (
    <span className="v2-chip" data-tone={look.tone} data-size={size === 'm' ? undefined : size} data-status={status} data-testid="v2-status">
      <StatusMark status={status} />
      {word}
    </span>
  );
}
