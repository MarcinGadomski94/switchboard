import type { KeyboardEvent } from 'react';
import { Link, type Route, useRouter } from '../router.tsx';
import { type NavBadge, navTitle } from './nav-grid.ts';
import { NavIcon, type NavIconName } from './nav-icons.tsx';
import { usePanes } from './Panes.tsx';

/**
 * D101 · one cell of the sidebar's navigation grid (`docs/sidebar.md` → *Navigation
 * grid*): an icon link with the view's name as its `aria-label` and tooltip (`title`,
 * also the D74 long-press bubble on a touch screen), a badge on the icon's corner and
 * the selected style of the current page. A link, so Tab reaches it and Enter opens
 * it; Space opens it too, like a button. In the tablet / phone drawer (D74) the name
 * shows under the icon (mounted only there, so the desktop cell is the icon and its badge).
 * Team (D100) and Plans (D99) render their cells with it.
 */
export function NavCell({
  to,
  label,
  icon,
  badge,
  active,
  testId,
  tour,
  badgeTestId,
}: {
  readonly to: Route;
  readonly label: string;
  readonly icon: NavIconName;
  readonly badge: NavBadge | null;
  readonly active: boolean;
  readonly testId: string;
  /** The `data-tour` anchor (the What's-new tours point at the cell). */
  readonly tour: string;
  readonly badgeTestId?: string;
}) {
  const { navigate } = useRouter();
  const { compact } = usePanes();
  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>): void => {
    if (event.key !== ' ' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <Link
      to={to}
      className="sb-nav-item"
      data-testid={testId}
      data-tour={tour}
      data-icon={icon}
      aria-label={label}
      title={navTitle(label, badge)}
      aria-current={active ? 'page' : undefined}
      onKeyDown={onKeyDown}
    >
      <NavIcon name={icon} />
      <span className="sb-badge" data-kind={badge?.kind} data-testid={badgeTestId} aria-hidden="true">
        {badge?.text ?? ''}
      </span>
      {compact ? (
        <span className="sb-nav-name" aria-hidden="true">
          {label}
        </span>
      ) : null}
    </Link>
  );
}
