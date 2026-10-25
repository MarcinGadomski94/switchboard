import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './fonts.ts';
import './styles/tokens.css';
import './styles/global.css';
import { Root, loadV2 } from './Root.tsx';
import { api } from './api/client.ts';
import { browserStorage, readScheme, serverDefaultOf, themeStore } from './theme.ts';
import { applyScheme } from './v2/scheme.ts';
import { PANE_STATE_WAIT_MS } from './shell/panes.ts';
// D74: the responsive rules after every view's own (docs/responsive.md).
import './styles/responsive/index.css';
// D34 (docs/install-app.md): keep Chrome's install offer from the start (Settings →
// Install as app; listening starts on import), and, in built UIs only, register the
// worker that shows the offline page.
import './pwa/app-install.ts';
import { registerServiceWorker } from './pwa/service-worker.ts';
// D87 (docs/devices.md): the page says whether it is in front (no system notifications on a device meanwhile).
import { startPresence } from './pwa/presence-page.ts';
// D73 fix (docs/devices.md → Notifications): a paired device sends back a push subscription Switchboard lost (re-pairing).
import { startPushRestore } from './pwa/push-restore-page.ts';
import { loadPaneState } from './shell/Panes.tsx';

if (import.meta.env.PROD) registerServiceWorker();
startPresence();
startPushRestore();

const container = document.getElementById('root');
if (!container) throw new Error('Switchboard: #root element missing from index.html');
// D41: the stored pane state is read before the first paint, so a hidden sidebar or panel never flashes open.
// D131 (docs/v2.md): the same settings read carries the theme's default; this browser's own choice
// (localStorage) wins. The v2 UI's code is loaded before the first render when it is the one shown,
// so neither UI flashes; otherwise it is fetched when the browser is idle (an instant switch).
const settings = api.settings();
const serverTheme = settings.then(serverDefaultOf, () => null);
void Promise.all([loadPaneState(settings), Promise.race([serverTheme, new Promise<null>((resolve) => setTimeout(() => resolve(null), PANE_STATE_WAIT_MS))])]).then(async ([panes, serverDefault]) => {
  const theme = themeStore.init(serverDefault);
  if (theme === 'v2') {
    applyScheme(readScheme(browserStorage()));
    await loadV2().catch(() => undefined);
  } else {
    const idle = (window as { requestIdleCallback?: (fn: () => void) => void }).requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 2_000));
    idle(() => void loadV2().catch(() => undefined));
  }
  // The default may arrive after the race (a slow service): a browser without its own choice follows it.
  void serverTheme.then((late) => {
    if (late !== serverDefault) themeStore.serverDefaultChanged(late);
  });
  createRoot(container).render(
    <StrictMode>
      <Root panes={panes} />
    </StrictMode>,
  );
});
