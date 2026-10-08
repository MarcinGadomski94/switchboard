import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useRouter } from '../router.tsx';
import { useQuestionNotifications } from './useQuestionNotifications.ts';
import { useUsageWarnings } from './useUsageWarnings.ts';
import './toast.css';

/** One toast (SPEC → Modals → Toast): dot, title, sub, branch line, text; Jump to session / Later. */
export interface Toast {
  readonly id: string;
  readonly title: string;
  readonly sub: string;
  /** Branch line (`solution ⎇ branch`); not rendered when empty. */
  readonly branch: string;
  readonly text: string;
  /** Session opened by "Jump to session"; no jump button without one. */
  readonly sessionId: string | null;
  /** The jump button's label (default "Jump to session"; D75's ▶ Start toast: "Open"). */
  readonly jumpLabel?: string;
}

interface ToastValue {
  readonly toasts: readonly Toast[];
  readonly show: (toast: Toast) => void;
  readonly dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastValue | null>(null);

/**
 * Holds the toasts. The host shows the newest one; a toast with the id of one
 * already listed replaces it.
 */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const show = useCallback((toast: Toast) => setToasts((list) => [...list.filter((t) => t.id !== toast.id), toast]), []);
  const dismiss = useCallback((id: string) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const value = useMemo<ToastValue>(() => ({ toasts, show, dismiss }), [toasts, show, dismiss]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

/** The toast list and its controls. */
export function useToasts(): ToastValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToasts outside ToastProvider');
  return value;
}

/**
 * Renders the newest toast over the shell (positioned against `.sb-shell`), and
 * raises one, with the chime and the OS notification, for every new question
 * batch (M3.4, `useQuestionNotifications`, `docs/notifications.md`), and one for
 * every Max usage warning in force (M9.2, `useUsageWarnings`, `docs/usage.md`).
 */
export function ToastHost() {
  const { toasts, show, dismiss } = useToasts();
  const { navigate } = useRouter();
  useQuestionNotifications(show, dismiss);
  useUsageWarnings(show);
  const toast = toasts[toasts.length - 1];
  if (!toast) return null;
  const jump = (): void => {
    dismiss(toast.id);
    if (toast.sessionId) navigate({ view: 'session', id: toast.sessionId, tab: 'chat' });
  };
  return (
    <div className="sb-toast" role="status" data-testid="toast">
      <div className="sb-toast-head">
        <span className="sb-toast-dot" />
        <span className="sb-toast-title">{toast.title}</span>
        <span className="sb-toast-sub">{toast.sub}</span>
        <button type="button" className="sb-button sb-toast-close" aria-label="Close" onClick={() => dismiss(toast.id)}>
          ✕
        </button>
      </div>
      {toast.branch ? <div className="sb-toast-branch">{toast.branch}</div> : null}
      <div className="sb-toast-text">{toast.text}</div>
      <div className="sb-toast-actions">
        {toast.sessionId ? (
          <button type="button" className="sb-button sb-toast-jump" data-testid="toast-jump" onClick={jump}>
            {toast.jumpLabel ?? 'Jump to session'}
          </button>
        ) : null}
        <button type="button" className="sb-button sb-toast-later" onClick={() => dismiss(toast.id)}>
          Later
        </button>
      </div>
    </div>
  );
}
