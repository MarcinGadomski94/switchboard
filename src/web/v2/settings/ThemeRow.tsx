import { api } from '../../api/client.ts';
import { themeStore, useThemeState } from '../../theme.ts';
import { Button, Segmented } from '../components/index.ts';
import { THEME_LABELS } from '../glossary.ts';
import { setScheme, useScheme } from '../scheme.ts';

/**
 * D131 · Settings › Appearance: the Theme row (v2 / Classic, this browser; the
 * switch is immediate, the address is kept) and the default for new browsers
 * (`ui.theme`), plus v2's light / dark scheme. Lane R places it in the full v2
 * Settings; the classic twin is `views/settings/AppearanceSection.tsx`.
 */
export function ThemeRow() {
  const { theme, serverDefault } = useThemeState();
  return (
    <div className="v2-set-row" data-row="ui-theme">
      <div className="v2-grow">
        <b>{THEME_LABELS.row}</b>
        <div className="v2-muted" style={{ fontSize: 13.5 }}>
          {THEME_LABELS.description}
        </div>
      </div>
      <Segmented
        label={THEME_LABELS.row}
        testId="v2-theme-switch"
        value={theme}
        onChange={(next) => themeStore.choose(next)}
        options={[
          { value: 'v2', label: THEME_LABELS.v2 },
          { value: 'classic', label: THEME_LABELS.classic },
        ]}
      />
      {serverDefault !== theme ? (
        <Button
          variant="ghost"
          size="sm"
          data-testid="v2-theme-make-default"
          onClick={() =>
            void api
              .saveSettings({ 'ui.theme': theme })
              .then(() => themeStore.serverDefaultChanged(theme))
              .catch(() => undefined)
          }
        >
          {THEME_LABELS.makeDefault}
        </Button>
      ) : null}
    </div>
  );
}

/** D131 · v2's light / dark row (this browser). */
export function SchemeRow() {
  const scheme = useScheme();
  return (
    <div className="v2-set-row" data-row="ui-scheme">
      <div className="v2-grow">
        <b>Light or dark</b>
        <div className="v2-muted" style={{ fontSize: 13.5 }}>
          Follows your computer unless you pick one.
        </div>
      </div>
      <Segmented
        label="Light or dark"
        testId="v2-scheme-switch"
        value={scheme}
        onChange={setScheme}
        options={[
          { value: 'system', label: 'Automatic' },
          { value: 'light', label: 'Light', icon: 'sun' },
          { value: 'dark', label: 'Dark', icon: 'moon' },
        ]}
      />
    </div>
  );
}
