/**
 * ⌘K / Ctrl+K palette (SPEC → Modals → Palette). Placeholder: the overlay and the
 * 620px panel only. M8.3 fills it (input, results, ↑↓ Enter).
 */
export function Palette({ onClose }: { readonly onClose: () => void }) {
  return (
    <div className="sb-overlay" data-modal="palette" onClick={onClose}>
      <div
        className="sb-modal-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Palette"
        data-testid="modal-palette"
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}
