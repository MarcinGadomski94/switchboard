import { useState } from 'react';
import { useLayout } from '../shell/useLayout.ts';

/**
 * D74 · list and detail on a phone (`docs/responsive.md` → *List and detail*):
 * the pages with a list beside the picked item (the Inbox, Solutions, Settings'
 * sections, a session's Diff) show the two in turn on a phone: the list first,
 * the item after a pick, "‹ Back" returns. `pane` is the view's `data-pane`
 * (`undefined` outside the phone layout, so nothing changes there).
 */
export function useListDetail(initiallyDetail = false) {
  const phone = useLayout() === 'phone';
  const [shown, setShown] = useState(initiallyDetail);
  return {
    phone,
    /** The item is on screen (phone only). */
    detail: phone && shown,
    /** Shows the item (call on a pick). */
    show: () => setShown(true),
    /** Back to the list. */
    back: () => setShown(false),
    /** The view's `data-pane`: which half a phone shows; `hasDetail` = there is an item to show. */
    pane: (hasDetail = true): 'list' | 'detail' | undefined => (phone ? (shown && hasDetail ? 'detail' : 'list') : undefined),
  };
}

/** The "‹ Back" that returns a phone from an item to its list. Mounted only there. */
export function BackButton({ label, testId, onBack }: { readonly label: string; readonly testId: string; readonly onBack: () => void }) {
  return (
    <button type="button" className="sb-button sb-back" data-testid={testId} onClick={onBack}>
      <svg width="8" height="12" viewBox="0 0 8 12" aria-hidden="true" focusable="false">
        <path d="M6.5 1 1.5 6l5 5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </button>
  );
}
