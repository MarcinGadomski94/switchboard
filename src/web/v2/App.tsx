import { RouterProvider } from '../router.tsx';
import { ToastProvider } from './components/index.ts';
import { useSystemSchemeFollow } from './scheme.ts';
import { Shell } from './shell/Shell.tsx';
import './tokens.css';
import './base.css';

/**
 * D131 · the v2 UI's root (`docs/v2.md`): the app's history router (shared with
 * the classic UI; `nav.tsx` reads it with the v2 routes), the toasts and the
 * shell. Mounted by `Root.tsx` while this browser's theme is `v2`.
 */
export function V2App() {
  useSystemSchemeFollow();
  return (
    <div className="sb2" data-testid="v2-root">
      <RouterProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </RouterProvider>
    </div>
  );
}
