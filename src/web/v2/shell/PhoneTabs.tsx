import { Icon } from '../components/index.ts';
import { PHONE_TABS } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { PHONE_TAB_IDS, type PhoneTab, type V2Route, phoneTabOf } from '../routes.ts';

const ICONS: Readonly<Record<PhoneTab, string>> = { home: 'home', needs: 'inbox', agents: 'agents', results: 'results', more: 'more' };
const PATHS: Readonly<Record<PhoneTab, string>> = { home: '/', needs: '/needs-you', agents: '/agents', results: '/results', more: '/more' };

/**
 * D131 · the phone's bottom tab bar (the prototype's `.p-tabs`): Home · Needs you
 * (with its count) · Agents · Results · More. Shown ≤ 767 px in place of the rail.
 */
export function PhoneTabs({ route, needs }: { readonly route: V2Route; readonly needs: number }) {
  const current = phoneTabOf(route);
  return (
    <nav className="v2-ptabs" aria-label="Main" data-testid="v2-phone-tabs">
      {PHONE_TAB_IDS.map((tab) => (
        <V2Link key={tab} to={PATHS[tab]} className="v2-ptab" aria-current={current === tab ? 'page' : undefined} data-testid={`v2-tab-${tab}`} data-tour={tab === 'needs' ? 'v2-needs' : `v2-tab-${tab}`} aria-label={tab === 'needs' && needs > 0 ? `${PHONE_TABS[tab]}, ${needs}` : PHONE_TABS[tab]}>
          <Icon name={ICONS[tab]} />
          <span>{PHONE_TABS[tab]}</span>
          {tab === 'needs' && needs > 0 ? (
            <span className="v2-dot-badge" aria-hidden="true">
              {needs > 99 ? '99+' : needs}
            </span>
          ) : null}
        </V2Link>
      ))}
    </nav>
  );
}
