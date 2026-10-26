import { Icon, StatusBadge } from '../components/index.ts';
import { RAIL_LABELS, TERMS, WORDS } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { RecentList } from '../shared/RecentList.tsx';
import type { StatusPill } from './status-model.ts';
import type { RailCounts } from './useShellData.ts';

/** The phone shows no Pinned list, so Recent leaves nothing out. */
const NO_PINS: readonly string[] = [];

const LINKS = [
  { to: '/projects', icon: 'projects', label: RAIL_LABELS.projects, count: 'projects' as const },
  { to: '/crews', icon: 'crew', label: RAIL_LABELS.crews, count: 'crews' as const },
  { to: '/tasks', icon: 'task', label: TERMS.task.many },
  { to: '/routines', icon: 'routine', label: TERMS.routine.many },
  { to: '/notes', icon: 'book', label: TERMS.notes.many },
  { to: '/insights', icon: 'insights', label: WORDS.insights },
  { to: '/settings', icon: 'settings', label: RAIL_LABELS.settings },
] as const;

/**
 * D131 · the phone's More tab (the prototype's `p.scr === 'more'`): the pages
 * without a tab, the usage and the computers.
 */
export function MorePage({ pill, counts }: { readonly pill: StatusPill; readonly counts: RailCounts }) {
  return (
    <div className="v2-page" data-testid="v2-page-more" data-area="more">
      <h1>{WORDS.more}</h1>
      <RecentList pinned={NO_PINS} currentId={null} variant="phone" />
      <div className="v2-plist">
        {LINKS.map((link) => {
          const n = 'count' in link ? counts[link.count] : 0;
          return (
            <V2Link key={link.to} to={link.to} className="v2-pfold">
              <span className="v2-ficon">
                <Icon name={link.icon} />
              </span>
              <span className="v2-grow">{link.label}</span>
              {n > 0 ? <span className="v2-nav-badge">{n}</span> : null}
              <Icon name="chev" size="s" />
            </V2Link>
          );
        })}
      </div>
      <h2 className="v2-psec">
        <Icon name="wallet" />
        Usage
      </h2>
      <div className="v2-plist" style={{ padding: '10px 14px' }}>
        {pill.accounts.length === 0 ? <span className="v2-muted">No usage reading yet.</span> : null}
        {pill.accounts.map((account) => (
          <div key={account.key} className="v2-bar2" style={{ fontSize: 13.5 }}>
            <span className="v2-bar2-l">{account.name}</span>
            {account.note ? (
              <span>{account.note}</span>
            ) : (
              <>
                <span className="v2-meter">
                  <b style={{ width: `${account.session ?? 0}%` }} />
                </span>
                <span>{account.session === null ? '—' : `${Math.round(account.session)}%`}</span>
              </>
            )}
          </div>
        ))}
      </div>
      <h2 className="v2-psec">
        <Icon name="desktop" />
        {TERMS.computer.many}
      </h2>
      <div className="v2-plist">
        {pill.computerRows.map((row) => (
          <div key={row.id ?? 'self'} className="v2-prow">
            <Icon name={row.state === 'offline' ? 'offline' : row.self ? 'laptop' : 'desktop'} />
            <div className="v2-grow">
              <b>{row.name}</b>
              <div className="v2-muted" style={{ fontSize: 13 }}>
                {row.power ? `${row.power} · ` : ''}
                {row.self ? 'this one' : row.detail}
              </div>
            </div>
            <StatusBadge status={row.state} size="s" />
          </div>
        ))}
      </div>
    </div>
  );
}
