/**
 * First-run setup wizard (SPEC → Modals → Setup wizard). Placeholder: the overlay
 * and the 960×620 panel only (no click-outside close, as in the prototype). M5.3
 * fills it (5 steps, `claude auth status`, `gh auth status`).
 */
export function SetupWizard({ onClose }: { readonly onClose: () => void }) {
  void onClose;
  return (
    <div className="sb-overlay" data-modal="setup-wizard">
      <div className="sb-modal-wizard" role="dialog" aria-modal="true" aria-label="Setup" data-testid="modal-setup-wizard" />
    </div>
  );
}
