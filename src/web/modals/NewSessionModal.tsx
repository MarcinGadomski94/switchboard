/**
 * New-session modal (SPEC → Modals → New session). Placeholder: the overlay and
 * the 1080px panel only. M5.1 fills it (sections 1–6, live summary, Start
 * session); M7.1 adds the Schedule section (D8).
 */
export function NewSessionModal({ onClose }: { readonly onClose: () => void }) {
  return (
    <div className="sb-overlay" data-modal="new-session" onClick={onClose}>
      <div
        className="sb-modal-new"
        role="dialog"
        aria-modal="true"
        aria-label="New session"
        data-testid="modal-new-session"
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}
