import { type ReactNode, useEffect } from 'react';
import { ModalProvider, useModals } from '../../modals/ModalHost.tsx';
import { SetupWizard } from '../../modals/SetupWizard.tsx';
import { ToastProvider as ClassicToastProvider, useToasts } from '../../toast/ToastHost.tsx';
import { UpdateDialog } from '../../updates/UpdateDialog.tsx';
import '../../views/settings.css';
import { Portal, useToast } from '../components/index.ts';

/**
 * D131 · lane R · a classic Settings section inside v2 (Settings › Advanced, the
 * every-option pages): the classic contexts it needs (its modals and toasts), the
 * classic colours re-pointed at the v2 tokens (`.v2-classic-frame` in
 * `settings.css`, so it follows light / dark), the setup wizard and the update
 * dialog over the v2 page, and its toasts shown as v2 toasts.
 */
export function ClassicFrame({ children, testId }: { readonly children: ReactNode; readonly testId?: string }) {
  return (
    <ModalProvider>
      <ClassicToastProvider>
        <div className="v2-classic-frame" data-testid={testId}>
          {children}
        </div>
        <ClassicModals />
        <ToastBridge />
      </ClassicToastProvider>
    </ModalProvider>
  );
}

/** The classic modals a Settings section opens (others, like the classic palette, stay closed in v2). */
function ClassicModals() {
  const { modal, updateConfirm, close } = useModals();
  if (modal !== 'setup-wizard' && modal !== 'update') return null;
  return (
    <Portal>
      <div className="v2-classic-frame v2-classic-modal-layer">{modal === 'setup-wizard' ? <SetupWizard onClose={close} /> : <UpdateDialog onClose={close} confirm={updateConfirm} />}</div>
    </Portal>
  );
}

/** Shows a classic section's toast (e.g. Send test) as a v2 toast. */
function ToastBridge() {
  const { toasts, dismiss } = useToasts();
  const toast = useToast();
  useEffect(() => {
    for (const entry of toasts) {
      toast({ text: [entry.title, entry.text].filter(Boolean).join(' · ') });
      dismiss(entry.id);
    }
  }, [toasts, toast, dismiss]);
  return null;
}

/** Opens a classic modal from inside a {@link ClassicFrame} (e.g. Run setup again). */
export function useClassicModals(): ReturnType<typeof useModals> {
  return useModals();
}
