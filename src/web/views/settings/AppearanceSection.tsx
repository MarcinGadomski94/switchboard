import { useState } from 'react';
import type { UiTheme } from '../../../core/settings.ts';
import { api } from '../../api/client.ts';
import { themeStore, useThemeState } from '../../theme.ts';
import { Action, Row, SectionTitle } from './rows.tsx';

/** The theme names as both UIs show them (`src/web/v2/glossary.ts` → `THEME_LABELS`). */
const THEME_NAMES: Readonly<Record<UiTheme, string>> = { v2: 'v2', classic: 'Classic' };

/**
 * D131 · Settings → Appearance (`docs/v2.md` → *Two themes*): this browser's
 * theme (v2 / Classic: the switch swaps the whole UI at once, no reload; kept in
 * this browser) and the default for browsers that have not chosen (`ui.theme`).
 */
export function AppearanceSection() {
  const { theme, serverDefault, device } = useThemeState();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const makeDefault = (next: UiTheme): void => {
    setBusy(true);
    setNote(null);
    api
      .saveSettings({ 'ui.theme': next })
      .then(() => themeStore.serverDefaultChanged(next))
      .catch(() => setNote('The default could not be saved.'))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <SectionTitle>Appearance</SectionTitle>
      <Row id="ui-theme" tour="theme-switch" label="Theme" description="The look of Switchboard in this browser. v2 is the new design; Classic is this one. The switch is immediate and kept in this browser.">
        <div className="sb-set-choice" role="group" aria-label="Theme" data-testid="theme-switch">
          {(['v2', 'classic'] as const).map((option) => (
            <button key={option} type="button" className="sb-set-action" data-testid={`theme-${option}`} aria-pressed={theme === option} onClick={() => themeStore.choose(option)}>
              {THEME_NAMES[option]}
            </button>
          ))}
        </div>
      </Row>
      <Row
        id="ui-theme-default"
        label="Default for new browsers"
        description={`Browsers and phones that have not chosen show ${THEME_NAMES[serverDefault ?? 'v2']}.${device ? ` This browser chose ${THEME_NAMES[device]}.` : ' This browser follows it.'}`}
      >
        {serverDefault === theme ? (
          <span className="sb-set-value" data-testid="theme-default-value">
            {THEME_NAMES[theme]}
          </span>
        ) : (
          <Action testId="theme-make-default" onClick={() => (busy ? undefined : makeDefault(theme))}>
            Make {THEME_NAMES[theme]} the default
          </Action>
        )}
      </Row>
      {note ? (
        <div className="sb-set-note sb-set-error" data-testid="settings-note">
          {note}
        </div>
      ) : null}
    </>
  );
}
