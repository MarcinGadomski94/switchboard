import { ModalProvider } from './modals/ModalHost.tsx';
import { RouterProvider } from './router.tsx';
import { PanesProvider } from './shell/Panes.tsx';
import { PANES_SHOWN, type PaneState } from './shell/panes.ts';
import { Shell } from './shell/Shell.tsx';
import { ToastProvider } from './toast/ToastHost.tsx';

/**
 * Root component: router, pane (D41), modal and toast state around the app
 * shell. `panes` is the stored pane state, read before the first paint (`main.tsx`).
 */
export function App({ panes = PANES_SHOWN }: { readonly panes?: PaneState }) {
  return (
    <RouterProvider>
      <PanesProvider initial={panes}>
        <ModalProvider>
          <ToastProvider>
            <Shell />
          </ToastProvider>
        </ModalProvider>
      </PanesProvider>
    </RouterProvider>
  );
}
