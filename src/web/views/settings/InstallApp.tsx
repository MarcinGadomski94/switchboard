import { useSyncExternalStore } from 'react';
import { isStandalone, subscribeStandalone } from '../../pwa/display-mode.ts';
import { appInstallPrompt } from '../../pwa/app-install.ts';
import { INSTALL_APP_ACTION, INSTALL_APP_DESCRIPTION, INSTALL_APP_LABEL, SAFARI_INSTALL_HINT, installRowForm } from './install-app.ts';
import { Action, Row } from './rows.tsx';

/**
 * Settings → Claude Code → **Install as app** (D34, `docs/install-app.md`): a
 * settings row whose **Install** button opens the browser's install dialog while
 * Chrome offers installation; in Safari the one-line hint "Install: File → Add to
 * Dock…" instead; nothing when Switchboard already runs as an installed app, or
 * when the browser offers nothing. An addition to the prototype's rows.
 */
export function InstallAppRow() {
  const offer = useSyncExternalStore(appInstallPrompt.subscribe, appInstallPrompt.current);
  const standalone = useSyncExternalStore(subscribeStandalone, isStandalone);
  const form = installRowForm({ offered: offer !== null, standalone, userAgent: navigator.userAgent });
  if (form === 'none') return null;
  if (form === 'safari-hint') {
    return (
      <div className="sb-set-row" data-row="install-app" data-testid="settings-install-hint">
        <div className="sb-set-row-text">
          <div className="sb-set-row-desc">{SAFARI_INSTALL_HINT}</div>
        </div>
      </div>
    );
  }
  return (
    <Row id="install-app" label={INSTALL_APP_LABEL} description={INSTALL_APP_DESCRIPTION}>
      <Action testId="settings-install-app" onClick={() => void appInstallPrompt.install()}>
        {INSTALL_APP_ACTION}
      </Action>
    </Row>
  );
}
