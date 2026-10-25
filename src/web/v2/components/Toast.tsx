import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';

/** One toast. `undo` adds the Undo button (or `actionLabel`); `tone: 'error'` for a refusal. */
export interface ToastInput {
  readonly text: ReactNode;
  readonly undo?: () => void | Promise<unknown>;
  readonly actionLabel?: string;
  readonly tone?: 'ok' | 'error';
  /** How long it stays (ms); default 5600 (the prototype's). */
  readonly ms?: number;
}

interface ToastEntry extends ToastInput {
  readonly id: number;
}

/** At most this many toasts at once (older ones go). */
export const MAX_TOASTS = 3;
/** The default time on screen (the prototype's 5.6 s). */
export const TOAST_MS = 5_600;

type Show = (toast: ToastInput) => void;

const ToastContext = createContext<Show>(() => undefined);

/** D131 · shows a toast (`.toast`): `toast({ text, undo })`. */
export function useToast(): Show {
  return useContext(ToastContext);
}

function ToastView({ entry, onDone }: { readonly entry: ToastEntry; readonly onDone: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDone(entry.id), entry.ms ?? TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [entry, onDone]);
  return (
    <div className="v2-toast" role="status" data-tone={entry.tone === 'error' ? 'error' : undefined} data-testid="v2-toast">
      <Icon name={entry.tone === 'error' ? 'alert' : 'check-circle'} size="s" />
      <span>{entry.text}</span>
      {entry.undo ? (
        <button
          type="button"
          data-testid="v2-toast-undo"
          onClick={() => {
            onDone(entry.id);
            void entry.undo?.();
          }}
        >
          {entry.actionLabel ?? 'Undo'}
        </button>
      ) : null}
    </div>
  );
}

/** D131 · the toast host (bottom centre; above the phone's tab bar). */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [entries, setEntries] = useState<readonly ToastEntry[]>([]);
  const next = useRef(1);
  const show = useCallback<Show>((toast) => {
    const id = next.current++;
    setEntries((list) => [...list, { ...toast, id }].slice(-MAX_TOASTS));
  }, []);
  const done = useCallback((id: number) => setEntries((list) => list.filter((entry) => entry.id !== id)), []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="v2-toasts" aria-live="polite">
        {entries.map((entry) => (
          <ToastView key={entry.id} entry={entry} onDone={done} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
