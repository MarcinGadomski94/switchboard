import { STATUS, type V2Status } from '../glossary.ts';
import { colorFor, initials } from './avatar-model.ts';
import { Icon, type IconName } from './Icon.tsx';

export { colorFor, initials } from './avatar-model.ts';

/** The status badge on an avatar (the prototype's `BADGE`). */
const BADGE_ICON: Readonly<Partial<Record<V2Status, string>>> = {
  needs: 'hand',
  working: 'dot',
  waiting: 'clock',
  queued: 'clock',
  stopped: 'x',
  ready: 'half',
  done: 'check',
  idle: 'moon',
  paused: 'pause',
  userstop: 'stop',
  offline: 'offline',
  reconnecting: 'refresh',
};

/**
 * D131 · an avatar (`.cav` / `.mate-av`): the name's initials or an icon on its
 * colour, with an optional status badge in the corner (the status word is given
 * to screen readers by the row, so the badge is decorative).
 */
export function Avatar({ name, color, icon, status, size = 'l', shape = 'round' }: { readonly name: string; readonly color?: string; readonly icon?: IconName | string; readonly status?: V2Status; readonly size?: 's' | 'm' | 'l'; readonly shape?: 'round' | 'square' }) {
  return (
    <span className="v2-av" data-size={size === 'l' ? undefined : size} data-shape={shape === 'round' ? undefined : shape} style={{ background: color ?? colorFor(name) }} aria-hidden="true">
      {icon ? <Icon name={icon} /> : initials(name)}
      {status ? (
        <span className="v2-av-badge" data-tone={STATUS[status].tone}>
          <Icon name={BADGE_ICON[status] ?? 'dot'} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * D131 · which computer something runs on (`.ctag`): its icon and name; offline
 * and reconnecting show so (dashed, with the word), never by colour alone.
 */
export function ComputerTag({ name, state = 'online', kind = 'desktop', short = false, since, testId = 'v2-computer-tag' }: { readonly name: string; readonly state?: 'online' | 'reconnecting' | 'offline'; readonly kind?: 'laptop' | 'desktop'; readonly short?: boolean; readonly since?: string | null; readonly testId?: string }) {
  const icon = state === 'offline' ? 'offline' : state === 'reconnecting' ? 'refresh' : kind;
  const word = state === 'online' ? '' : ` · ${state === 'offline' ? 'offline' : 'reconnecting'}`;
  const title = state === 'online' ? `Runs on ${name}` : state === 'offline' ? `${name} is offline${since ? ` since ${since}` : ''}` : `Reconnecting to ${name}…`;
  return (
    <span className="v2-ctag" data-state={state} title={title} data-testid={testId}>
      <Icon name={icon} />
      {short ? name.split(/[\s.-]/)[0] : name}
      {word}
    </span>
  );
}
