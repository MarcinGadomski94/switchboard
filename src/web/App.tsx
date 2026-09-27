import { ModalProvider } from './modals/ModalHost.tsx';
import { RouterProvider } from './router.tsx';
import { Shell } from './shell/Shell.tsx';
import { ToastProvider } from './toast/ToastHost.tsx';

/** Root component: router, modal and toast state around the app shell. */
export function App() {
  return (
    <RouterProvider>
      <ModalProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </ModalProvider>
    </RouterProvider>
  );
}
