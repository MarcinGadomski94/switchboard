import { Card } from '../components/index.ts';
import { SETTINGS_LABELS } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { V2_SETTINGS_SECTIONS, type V2SettingsSection } from '../routes.ts';
import { Placeholder } from '../shared/Placeholder.tsx';
import { SchemeRow, ThemeRow } from './ThemeRow.tsx';
import './settings.css';

export { SchemeRow, ThemeRow } from './ThemeRow.tsx';

/**
 * D131 · Settings (`/settings[/:section[/:sub]]`), lane R: Usage & accounts,
 * Computers, Phones, Rules for every agent, Appearance, Advanced (the classic
 * sections). Lane F built Appearance's Theme row; the rest is lane R's. See
 * `README.md`.
 */
export function SettingsPage({ section, sub }: { readonly section: V2SettingsSection | null; readonly sub: string | null }) {
  const current = section ?? 'appearance';
  return (
    <div className="v2-page" data-testid="v2-page-settings" data-area="settings" data-section={current}>
      <h1>Settings</h1>
      <div className="v2-set-layout">
        <nav className="v2-subnav" aria-label="Settings">
          {V2_SETTINGS_SECTIONS.map((key) => (
            <V2Link key={key} to={{ area: 'settings', section: key, sub: null }} aria-current={key === current ? 'true' : undefined} data-testid={`v2-settings-${key}`}>
              {SETTINGS_LABELS[key]}
            </V2Link>
          ))}
        </nav>
        <div>
          {current === 'appearance' ? (
            <Card pad>
              <h2 style={{ margin: '0 0 8px', fontSize: 17 }}>{SETTINGS_LABELS.appearance}</h2>
              <ThemeRow />
              <SchemeRow />
            </Card>
          ) : (
            <Placeholder area={`settings-${current}`} title={SETTINGS_LABELS[current]} sub={sub ? `Advanced › ${sub}` : undefined} lane="R" />
          )}
        </div>
      </div>
    </div>
  );
}

/** D131 · an embedded tool (`/tools/:id`), lane R. */
export function ToolPage({ id }: { readonly id: string }) {
  return <Placeholder area="tool" title="Tool" sub={id} lane="R" />;
}

/** D131 · a phone's share (`/share`), lane R. */
export function SharePage() {
  return <Placeholder area="share" title="Add to which agent?" lane="R" />;
}
