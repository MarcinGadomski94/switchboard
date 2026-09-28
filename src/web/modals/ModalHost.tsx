import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { NewSessionPrefill } from '../../core/api.ts';
import './modals.css';
import { NewSessionModal } from './NewSessionModal.tsx';
import { Palette } from './Palette.tsx';
import type { ScheduleDraft } from './schedule-form.ts';
import { SetupWizard } from './SetupWizard.tsx';

/** The app's modals (SPEC → Modals). */
export type ModalName = 'new-session' | 'setup-wizard' | 'palette';

/** Extra state a modal opens with. */
export interface ModalOptions {
  /** New session: values the form starts with instead of its defaults (M3.3 "Open fix session"). */
  readonly prefill?: NewSessionPrefill | null;
  /** New session in schedule mode (M7.1, D8): "+ New scheduled run" (`{}`) or a schedule's Edit (`{ id, cron }`). */
  readonly schedule?: ScheduleDraft | null;
}

interface ModalValue {
  readonly modal: ModalName | null;
  /** The New-session prefill of the open modal (`null` for the defaults). */
  readonly prefill: NewSessionPrefill | null;
  /** The Schedule section of the open New-session modal (`null` = a plain New session). */
  readonly schedule: ScheduleDraft | null;
  readonly open: (name: ModalName, options?: ModalOptions) => void;
  readonly close: () => void;
}

const ModalContext = createContext<ModalValue | null>(null);

/**
 * Holds which modal is open. ⌘K / Ctrl+K opens the palette and Esc closes any
 * modal, as in the prototype.
 */
export function ModalProvider({ children }: { readonly children: ReactNode }) {
  const [modal, setModal] = useState<ModalName | null>(null);
  const [prefill, setPrefill] = useState<NewSessionPrefill | null>(null);
  const [schedule, setSchedule] = useState<ScheduleDraft | null>(null);
  const open = useCallback((name: ModalName, options?: ModalOptions) => {
    setPrefill(name === 'new-session' ? (options?.prefill ?? null) : null);
    setSchedule(name === 'new-session' ? (options?.schedule ?? null) : null);
    setModal(name);
  }, []);
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

  const value = useMemo<ModalValue>(() => ({ modal, prefill, schedule, open, close }), [modal, prefill, schedule, open, close]);
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
  const { modal, prefill, schedule, close } = useModals();
  if (modal === 'new-session') return <NewSessionModal onClose={close} prefill={prefill} schedule={schedule} />;
  if (modal === 'setup-wizard') return <SetupWizard onClose={close} />;
  if (modal === 'palette') return <Palette onClose={close} />;
  return null;
}
