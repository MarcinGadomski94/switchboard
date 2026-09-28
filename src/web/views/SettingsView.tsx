import { StartAtLoginRow } from './settings/StartAtLogin.tsx';

/**
 * Settings (SPEC → Settings): `230px nav | content`, 7 sections. Placeholder from
 * M1.4 (docs/lanes.md); M8.2 fills it (M5.3 "Run setup again", M8.1 Embedded tools).
 * Until then it holds M9.1's "Start at login" row on the Claude Code section
 * (`/settings`, `/settings/claude`); M8.2 puts `StartAtLoginToggle` in its own row.
 */
export function SettingsView({ section }: { readonly section: string | null }) {
  const claude = section === null || section === 'claude';
  return (
    <section className="sb-view" data-view="settings" data-testid="view-settings" data-section={section ?? ''}>
      {claude ? (
        <div className="sb-login-content">
          <StartAtLoginRow />
        </div>
      ) : null}
    </section>
  );
}
