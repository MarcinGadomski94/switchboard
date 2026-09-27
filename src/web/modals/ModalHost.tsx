import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import './modals.css';
import { NewSessionModal } from './NewSessionModal.tsx';
import { Palette } from './Palette.tsx';
import { SetupWizard } from './SetupWizard.tsx';

/** The app's modals (SPEC → Modals). */
export type ModalName = 'new-session' | 'setup-wizard' | 'palette';

interface ModalValue {
  readonly modal: ModalName | null;
  readonly open: (name: ModalName) => void;
  readonly close: () => void;
}

const ModalContext = createContext<ModalValue | null>(null);

/**
 * Holds which modal is open. ⌘K / Ctrl+K opens the palette and Esc closes any
 * modal, as in the prototype.
 */
export function ModalProvider({ children }: { readonly children: ReactNode }) {
  const [modal, setModal] = useState<ModalName | null>(null);
  const open = useCallback((name: ModalName) => setModal(name), []);
  const close = useCallback(() => setModal(null), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setModal('palette');
      } else if (event.key === 'Escape') {
        setModal(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const value = useMemo<ModalValue>(() => ({ modal, open, close }), [modal, open, close]);
  return <ModalContext.Provider value={value}>{children}</ModalContext.Provider>;
}

/** The open modal and its controls. */
export function useModals(): ModalValue {
  const value = useContext(ModalContext);
  if (!value) throw new Error('useModals outside ModalProvider');
  return value;
}

/** Renders the open modal over the shell (positioned against `.sb-shell`). */
export function ModalHost() {
  const { modal, close } = useModals();
  if (modal === 'new-session') return <NewSessionModal onClose={close} />;
  if (modal === 'setup-wizard') return <SetupWizard onClose={close} />;
  if (modal === 'palette') return <Palette onClose={close} />;
  return null;
}
