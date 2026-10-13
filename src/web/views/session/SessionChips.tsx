import { useLayoutEffect, useRef, useState } from 'react';
import type { SessionChip } from '../../../core/api.ts';
import { browserStorage } from './useDiffScope.ts';
import { LESS_LABEL, foldChips, headerChips, loadChipsExpanded, moreLabel, saveChipsExpanded } from './chip-row.ts';
import { ChipSkeletons } from './SessionSkeletons.tsx';

/** Props of {@link SessionChips}. */
export interface SessionChipsProps {
  readonly sessionId: string;
  readonly chips: readonly SessionChip[];
  readonly solutions: readonly string[];
  /** D45: chip-shaped placeholders while the session loads. */
  readonly placeholder: boolean;
}

/** Width assumed for the toggle before it was measured (px). */
const TOGGLE_GUESS = 96;
/** Width of one more digit in the toggle's label (11.5 px mono, px). */
const DIGIT = 7.5;

/** A chip's one-line width, also while it is cut with … (its border box). */
function naturalWidth(element: HTMLElement): number {
  return element.scrollWidth + (element.offsetWidth - element.clientWidth);
}

/**
 * The session header's chip row (M4.1; D104: folds to one line). Every chip stays
 * mounted: the ones past the folded line are taken out of the flow and hidden
 * (`data-folded`), so they keep their measured width and the row can be fitted
 * again on every size change (`ResizeObserver`: the window, the right panel, the
 * sidebar). When everything fits, the row is the one it always was.
 */
export function SessionChips({ sessionId, chips, solutions, placeholder }: SessionChipsProps) {
  const items = headerChips(chips, solutions);
  const itemsKey = items.map((item) => item.id).join('\n');
  const row = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [remembered, setRemembered] = useState(() => ({ sessionId, expanded: loadChipsExpanded(browserStorage(), sessionId) }));
  const expanded = remembered.sessionId === sessionId ? remembered.expanded : loadChipsExpanded(browserStorage(), sessionId);
  /** `null`: everything fits on one line; else how many chips the folded row shows. */
  const [shown, setShown] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useLayoutEffect(() => {
    const element = row.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setTick((n) => n + 1));
    observer.observe(element);
    // The web fonts change the chips' widths once they arrive.
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) setTick((n) => n + 1);
    });
    return () => {
      live = false;
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const available = element.clientWidth;
    // Hidden (the short-window rule, `docs/responsive.md`): nothing to fit.
    if (available === 0) return;
    const widths = [...element.querySelectorAll<HTMLElement>(':scope > [data-testid="session-chip"]')].map(naturalWidth);
    const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
    const measured = toggle.current ? toggle.current.getBoundingClientRect().width : null;
    const measuredHidden = shown !== null ? widths.length - shown : 0;
    const digits = (n: number): number => String(n).length;
    const toggleWidth = (hidden: number): number => (measured !== null && !expanded ? measured + (digits(hidden) - digits(measuredHidden)) * DIGIT : TOGGLE_GUESS);
    const next = foldChips({ available, gap, widths, toggleWidth });
    if (next !== shown) setShown(next);
  }, [tick, itemsKey, expanded, shown]);

  const setExpanded = (value: boolean): void => {
    saveChipsExpanded(browserStorage(), sessionId, value);
    setRemembered({ sessionId, expanded: value });
  };

  const fold = shown === null ? undefined : expanded ? 'expanded' : 'collapsed';
  const hidden = shown === null ? 0 : items.length - shown;
  return (
    <div className="sb-sv-chips" data-testid="session-chips" data-fold={fold} id={`sb-sv-chips-${sessionId}`} ref={row}>
      {/* D45 (developer ruling): chip-shaped blocks hold the row while the session loads, so the tabs do not jump. */}
      {placeholder ? <ChipSkeletons /> : null}
      {items.map((chip, index) => {
        const folded = fold === 'collapsed' && shown !== null && index >= shown;
        return (
          <span
            key={chip.id}
            className="sb-sv-chip"
            data-testid="session-chip"
            data-loop={chip.loop ? 'true' : 'false'}
            data-scope={chip.scope ? 'true' : undefined}
            data-folded={folded ? 'true' : undefined}
            aria-hidden={folded || undefined}
            title={chip.k ? `${chip.k} ${chip.v}` : chip.v}
          >
            {chip.k ? <span className="sb-sv-chip-k">{chip.k} </span> : null}
            {chip.v}
          </span>
        );
      })}
      {fold ? (
        <button
          type="button"
          ref={toggle}
          className="sb-sv-chip sb-sv-chip-more"
          data-testid="session-chips-toggle"
          data-tour="session-chips-toggle"
          aria-expanded={expanded}
          aria-controls={`sb-sv-chips-${sessionId}`}
          title={expanded ? 'Show the chips on one line' : `Show all ${items.length} chips`}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? LESS_LABEL : moreLabel(hidden)}
        </button>
      ) : null}
    </div>
  );
}
