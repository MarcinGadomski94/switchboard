import type { NewSessionPrefill } from '../../core/api.ts';

/**
 * New-session modal (SPEC → Modals → New session). Placeholder: the overlay and
 * the 1080px panel only. M5.1 fills it (sections 1–6, live summary, Start
 * session); M7.1 adds the Schedule section (D8). `prefill` (M3.3, the Inbox's
 * "Open fix session") holds the values the form starts with; until M5.1 renders
 * the form it is carried as `data-prefill` (JSON).
 */
export function NewSessionModal({ onClose, prefill = null }: { readonly onClose: () => void; readonly prefill?: NewSessionPrefill | null }) {
  return (
    <div className="sb-overlay" data-modal="new-session" onClick={onClose}>
      <div
        className="sb-modal-new"
        role="dialog"
        aria-modal="true"
        aria-label="New session"
        data-testid="modal-new-session"
        data-prefill={prefill ? JSON.stringify(prefill) : undefined}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}
