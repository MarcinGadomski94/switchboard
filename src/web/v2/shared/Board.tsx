import { type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';
import { Icon } from '../components/index.ts';
import { AGENTS_WORDS } from '../glossary.ts';
import { BOARD_COLUMNS, BOARD_COLUMN_ICON, type BoardColumn } from './board-model.ts';
import './board.css';

/**
 * D131 · lane X · the one v2 board (the prototype's `boardHTML` / `bcardHTML`):
 * the sticky column heads (Needs you · Working · Ready for approval · Done with
 * counts), swimlanes with a fold toggle, cells, and cards that slide to their new
 * column (FLIP, never with reduced motion). The Agents board (lane A, swimlanes
 * by Project | Crew | Folder) and a project's Board view (lane P, the project as
 * its one lane) both draw with it; each keeps its own data and column rules.
 * Styles: `board.css` (classes `v2-bd*`, `v2-lane*`, `v2-bcell`, `v2-bcard*`).
 */

/** Moves the cards from where they were to where they are now (FLIP), unless the developer asked for reduced motion. */
function useFlip(root: RefObject<HTMLDivElement | null>, key: unknown, layoutKey: unknown): void {
  const last = useRef(new Map<string, DOMRect>());
  const lastLayout = useRef(layoutKey);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    // A new grouping re-lays the whole board: no card "moved".
    if (lastLayout.current !== layoutKey) {
      lastLayout.current = layoutKey;
      last.current = new Map();
    }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const now = new Map<string, DOMRect>();
    for (const card of el.querySelectorAll<HTMLElement>('[data-flip]')) {
      const id = card.dataset['flip'] ?? '';
      const box = card.getBoundingClientRect();
      now.set(id, box);
      const before = last.current.get(id);
      if (!reduce && before && card.animate) {
        const dx = before.left - box.left;
        const dy = before.top - box.top;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 550, easing: 'cubic-bezier(.2,.8,.2,1)' });
          card.classList.add('v2-flash');
          window.setTimeout(() => card.classList.remove('v2-flash'), 1500);
        }
      }
    }
    last.current = now;
  }, [root, key, layoutKey]);
}

/** The board: an optional toolbar (group-by), the column heads, the lanes (`children`) and an optional foot line. */
export function Board({ counts, flipKey, layoutKey, toolbar, foot, children, testId, colTestIds = false }: { readonly counts: Readonly<Record<BoardColumn, number>>; readonly flipKey: string; readonly layoutKey?: unknown; readonly toolbar?: ReactNode; readonly foot?: ReactNode; readonly children: ReactNode; readonly testId?: string; readonly colTestIds?: boolean }) {
  const root = useRef<HTMLDivElement | null>(null);
  useFlip(root, flipKey, layoutKey);
  return (
    <div className="v2-bd" ref={root} {...(testId ? { 'data-testid': testId } : {})}>
      {toolbar}
      <div className="v2-bd-cols">
        {BOARD_COLUMNS.map((column) => (
          <div key={column} className="v2-bd-col-h" data-col={column} {...(colTestIds ? { 'data-testid': `v2-bd-col-${column}` } : {})}>
            <Icon name={BOARD_COLUMN_ICON[column]} size="s" />
            {AGENTS_WORDS.columns[column]}
            <span className="v2-count" data-tone={column === 'needs' && counts.needs > 0 ? 'amber' : undefined}>
              {counts[column]}
            </span>
          </div>
        ))}
      </div>
      {children}
      {foot ? (
        <div className="v2-bd-foot" data-testid="v2-bd-foot">
          {foot}
        </div>
      ) : null}
    </div>
  );
}

/** A lane's progress bar (a project's steps done). */
export function BoardProgress({ done, total }: { readonly done: number; readonly total: number }) {
  return (
    <span className="v2-progress" role="img" aria-label={AGENTS_WORDS.stepsDone(done, total)}>
      <b style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
    </span>
  );
}

/**
 * One swimlane: the fold toggle (when `onToggle` is given), its icon and title, `summary` (a
 * count or a progress), the "needs you" count while folded, `actions` on the right, and one cell
 * per column with the cards `cell(column)` gives (an empty cell says so).
 */
export function BoardLane({ id, title, icon, iconClass, summary, needs = 0, actions, closed = false, onToggle, cell }: { readonly id: string; readonly title: string; readonly icon: string; readonly iconClass?: string; readonly summary?: ReactNode; readonly needs?: number; readonly actions?: ReactNode; readonly closed?: boolean; readonly onToggle?: () => void; readonly cell: (column: BoardColumn) => readonly ReactNode[] }) {
  return (
    <section className="v2-lane" {...(closed ? { 'data-closed': '' } : {})} data-lane={id} data-testid="v2-lane" aria-label={title}>
      <div className="v2-lane-h">
        {onToggle ? (
          <button type="button" className="v2-lane-tog" onClick={onToggle} aria-expanded={!closed} aria-label={closed ? AGENTS_WORDS.expand(title) : AGENTS_WORDS.collapse(title)} data-testid="v2-lane-toggle">
            <Icon name="chev-down" size="s" />
          </button>
        ) : (
          <span className="v2-lane-pad" aria-hidden="true" />
        )}
        <Icon name={icon} size="s" {...(iconClass ? { className: iconClass } : {})} />
        <h3>{title}</h3>
        {summary}
        {closed && needs ? (
          <span className="v2-nb">
            <Icon name="hand" size="s" />
            {needs}
          </span>
        ) : null}
        <span className="v2-grow" />
        {actions}
      </div>
      <div className="v2-lane-g">
        {BOARD_COLUMNS.map((column) => {
          const cards = cell(column);
          return (
            <div key={column} className="v2-bcell" data-col={column} data-testid="v2-bcell">
              {cards.length ? cards : <div className="v2-none">{AGENTS_WORDS.noneInCell}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * A board card: the kind line (and a computer tag on its right), the title, the status (icon +
 * word + colour), then `children` (the ask, the activity, the buttons). A click or Enter on the
 * card (not on a button or link inside it) calls `onOpen`; `onKey` sees every other key first
 * (the Agents board's M = Move to folder).
 */
export function BoardCard({ column, flipId, kind, corner, title, status, label, off = false, onOpen, onKey, testId, cardProps, children }: { readonly column: BoardColumn; readonly flipId: string; readonly kind: ReactNode; readonly corner?: ReactNode; readonly title: ReactNode; readonly status: ReactNode; readonly label: string; readonly off?: boolean; readonly onOpen: () => void; readonly onKey?: (event: KeyboardEvent<HTMLDivElement>) => boolean; readonly testId: string; readonly cardProps?: HTMLAttributes<HTMLDivElement> & Readonly<Record<`data-${string}`, string | undefined>>; readonly children?: ReactNode }) {
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (onKey?.(event)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen();
    }
  };
  const click = (event: MouseEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    onOpen();
  };
  return (
    <div {...cardProps} className="v2-bcard" data-col={column} data-flip={flipId} data-testid={testId} {...(off ? { 'data-off': '' } : {})} role="button" tabIndex={0} aria-label={label} onClick={click} onKeyDown={keyDown}>
      <div className="v2-brow">
        <span className="v2-bkind">{kind}</span>
        <span className="v2-grow" />
        {corner}
      </div>
      <b className="v2-t">{title}</b>
      <div className="v2-brow">{status}</div>
      {children}
    </div>
  );
}

/** The ask on a card ("“Which date format?”"), amber, red for a stopped one. */
export function BoardQuote({ tone = 'amber', children }: { readonly tone?: 'amber' | 'red'; readonly children: ReactNode }) {
  return (
    <div className="v2-bq" data-tone={tone}>
      <span className="v2-bq-t">{children}</span>
    </div>
  );
}

/** The card's activity line (a live dot while it works, the time on the right). */
export function BoardActivity({ live = false, time, testId, children }: { readonly live?: boolean; readonly time?: string | null; readonly testId?: string; readonly children: ReactNode }) {
  return (
    <div className="v2-bact" {...(testId ? { 'data-testid': testId } : {})}>
      {live ? <span className="v2-pulse" aria-hidden="true" /> : null}
      <span>{children}</span>
      {time ? <span className="v2-bt">{time}</span> : null}
    </div>
  );
}

/** A right-aligned row of buttons at a card's foot. */
export function BoardButtons({ children }: { readonly children: ReactNode }) {
  return (
    <div className="v2-brow">
      <span className="v2-grow" />
      {children}
    </div>
  );
}
