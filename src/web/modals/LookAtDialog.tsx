import { type MouseEvent, useState } from 'react';
import { CHAT_LOCKED_HINT } from '../../core/chats.ts';
import { ApiError, api } from '../api/client.ts';
import { LookAtField } from './NewChatModal.tsx';
import { startErrorText } from './new-session.ts';

/** D106: the chat the Look-at-folders dialog edits. */
export interface LookAtTarget {
  readonly id: string;
  readonly title: string;
  readonly lookAt: readonly string[];
}

/**
 * D106 · a chat's ⋯ → **Look at folders…**: the folders it may read (read-only,
 * still in plan mode). Save sends `PUT /api/chats/{id}/look-at`; the chat's process
 * restarts to read them (idle now, a running turn first finishes).
 */
export function LookAtDialog({ target, onClose }: { readonly target: LookAtTarget; readonly onClose: () => void }) {
  const [value, setValue] = useState<string[]>([...target.lookAt]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.setChatLookAt(target.id, value);
      onClose();
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
      setError(startErrorText(apiError.status, apiError.body));
      setBusy(false);
    }
  };
  return (
    <div className="sb-overlay" data-modal="look-at" onClick={onClose}>
      <div className="sb-modal-simple" role="dialog" aria-modal="true" aria-label="Look at folders" data-testid="modal-look-at" onClick={(event: MouseEvent) => event.stopPropagation()}>
        <div className="sb-ns-simple">
          <div className="sb-ns-head sb-ns-simple-head">
            <div className="sb-ns-title">Look at folders</div>
            <div className="sb-ns-sub">{target.title} may read these folders for planning. {CHAT_LOCKED_HINT}</div>
          </div>
          <LookAtField value={value} onChange={setValue} disabled={busy} testId="la" />
          {error ? (
            <div className="sb-ns-error sb-ns-simple-error" role="alert" data-testid="la-error">
              {error}
            </div>
          ) : null}
          <div className="sb-ns-simple-actions">
            <span className="sb-ns-simple-waiting" />
            <button type="button" className="sb-button sb-ns-cancel" data-testid="la-cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="sb-button sb-ns-start sb-ns-simple-start" data-testid="la-save" disabled={busy} onClick={() => void save()}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
