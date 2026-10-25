import { SharePage as ClassicSharePage } from '../../capture/SharePage.tsx';
import { useLayout } from '../../shell/useLayout.ts';
import { ToolView } from '../../views/ToolView.tsx';
import { Icon } from '../components/index.ts';
import { SETTINGS_LABELS, SETTINGS_WORDS as W } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { V2_SETTINGS_SECTIONS, type V2SettingsSection } from '../routes.ts';
import { AdvancedSection } from './AdvancedSection.tsx';
import { ClassicFrame } from './ClassicFrame.tsx';
import { ComputersSection } from './ComputersSection.tsx';
import { PhonesSection } from './PhonesSection.tsx';
import { AppearanceSection, RulesSection } from './sections.tsx';
import { shownSection } from './settings-map.ts';
import { UsageSection } from './UsageSection.tsx';
import './settings.css';

export { SchemeRow, ThemeRow } from './ThemeRow.tsx';

/** Each section's icon in the left list (the prototype's subnav). */
const SECTION_ICONS: Readonly<Record<V2SettingsSection, string>> = {
  usage: 'wallet',
  computers: 'desktop',
  phones: 'phone',
  rules: 'rules',
  appearance: 'sun',
  advanced: 'sliders',
};

function Section({ section, sub }: { readonly section: V2SettingsSection; readonly sub: string | null }) {
  switch (section) {
    case 'usage':
      return <UsageSection />;
    case 'computers':
      return <ComputersSection />;
    case 'phones':
      return <PhonesSection />;
    case 'rules':
      return <RulesSection />;
    case 'appearance':
      return <AppearanceSection />;
    case 'advanced':
      return <AdvancedSection sub={sub} />;
  }
}

/**
 * D131 · Settings (`/settings[/:section[/:sub]]`), lane R (the prototype's
 * `#s-settings`): Usage & accounts, Computers, Phones, Rules for every agent,
 * Appearance and Advanced (every classic section, `settings-map.ts`). Desktop and
 * tablet: the list of sections on the left (`/settings` opens Usage & accounts);
 * phone: `/settings` is the list and a section drills down with a back link.
 */
export function SettingsPage({ section, sub }: { readonly section: V2SettingsSection | null; readonly sub: string | null }) {
  const phone = useLayout() === 'phone';
  const current = shownSection(section, phone);
  return (
    <div className="v2-page" data-wide="" data-testid="v2-page-settings" data-area="settings" data-section={current ?? 'list'} data-pane={phone ? (current ? 'detail' : 'list') : undefined}>
      {phone && current ? (
        <V2Link to="/settings" className="v2-btn v2-set-backlink" data-variant="ghost" data-size="sm" data-testid="v2-settings-back">
          <Icon name="back" size="s" />
          {W.back}
        </V2Link>
      ) : null}
      <h1>{phone && current ? SETTINGS_LABELS[current] : W.title}</h1>
      {!phone || !current ? <p className="v2-page-sub">{W.sub}</p> : null}
      <div className="v2-set-layout">
        {!phone || !current ? (
          <nav className="v2-subnav" aria-label={W.sectionsLabel} data-testid="v2-settings-nav">
            {V2_SETTINGS_SECTIONS.map((key) => (
              <V2Link key={key} to={{ area: 'settings', section: key, sub: null }} aria-current={key === current ? 'true' : undefined} data-testid={`v2-settings-${key}`}>
                <Icon name={SECTION_ICONS[key]} size="s" />
                <span className="v2-grow">{SETTINGS_LABELS[key]}</span>
                {phone ? <Icon name="chev" size="s" className="v2-muted" /> : null}
              </V2Link>
            ))}
          </nav>
        ) : null}
        {current ? (
          <div className="v2-set-main" data-testid={`v2-set-section-${current}`}>
            <Section section={current} sub={sub} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** D131 · an embedded tool (`/tools/:id`), lane R: the classic tool page (D61's frame) in the v2 page. */
export function ToolPage({ id }: { readonly id: string }) {
  return (
    <div className="v2-page v2-tool-page" data-wide="" data-testid="v2-page-tool" data-area="tool">
      <ClassicFrame testId="v2-tool-frame">
        <ToolView toolId={id} />
      </ClassicFrame>
    </div>
  );
}

/** D131 · a phone's share (`/share`), lane R: D81's "Add to which agent?" page in the v2 page. */
export function SharePage() {
  return (
    <div className="v2-page" data-testid="v2-page-share" data-area="share">
      <h1>{W.shareTitle}</h1>
      <ClassicFrame testId="v2-share-frame">
        <ClassicSharePage />
      </ClassicFrame>
    </div>
  );
}
