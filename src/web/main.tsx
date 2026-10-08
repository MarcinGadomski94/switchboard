import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './fonts.ts';
import './styles/tokens.css';
import './styles/global.css';
import { App } from './App.tsx';
// D74: the responsive rules after every view's own (docs/responsive.md).
import './styles/responsive/index.css';
// D34 (docs/install-app.md): keep Chrome's install offer from the start (Settings →
// Install as app; listening starts on import), and, in built UIs only, register the
// worker that shows the offline page.
import './pwa/app-install.ts';
import { registerServiceWorker } from './pwa/service-worker.ts';
// D87 (docs/devices.md): the page says whether it is in front (no system notifications on a device meanwhile).
import { startPresence } from './pwa/presence-page.ts';
import { loadPaneState } from './shell/Panes.tsx';

if (import.meta.env.PROD) registerServiceWorker();
startPresence();

const container = document.getElementById('root');
if (!container) throw new Error('Switchboard: #root element missing from index.html');
// D41: the stored pane state is read before the first paint, so a hidden sidebar or panel never flashes open.
void loadPaneState().then((panes) => {
  createRoot(container).render(
    <StrictMode>
      <App panes={panes} />
    </StrictMode>,
  );
});
