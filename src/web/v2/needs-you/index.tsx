import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useLayout } from '../../shell/useLayout.ts';
import { Button, EmptyState, Icon, Kbd, Skeleton } from '../components/index.ts';
import { NEEDS_FILTERS, NEEDS_FILTER_LABELS, NEEDS_PAGE_WORDS, WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { AnswerCard } from '../shared/AnswerCard.tsx';
import { useNeedsYou } from '../shared/needs-you.ts';
import { type PageFilter, applyFilter, crewChips, isPageFilter, kindCounts, stepIndex } from './needs-filter.ts';
import './needs.css';

/**
 * D131 · Needs you (`/needs-you`), lane H (`README.md`; the prototype's
 * `#s-needs` and the phone's Needs-you tab): the one queue of everything waiting
 * for the developer (`shared/needs-you.ts`), live, answered in place
 * (`shared/AnswerCard.tsx`: Undo toasts, the agent / crew / computer tags, Open
 * agent). Filter chips by kind group and by crew (`needs-filter.ts`; `?filter=`
 * opens one); the all-clear and "nothing of this kind" states.
 *
 * Keys: ↑ / ↓ move between the cards, 1–9 press a focused card's answers (the
 * card's own), Enter on a focused card sends its answer when it has a Send (a
 * batch or a multi-select).
 */

/** The filter chips' icons (the prototype's). */
const FILTER_ICON: Readonly<Record<string, string>> = { question: 'question', approval: 'shield', ready: 'half', setup: 'book', ask: 'chat', stopped: 'octagon' };

function cardsIn(list: HTMLElement | null): HTMLElement[] {
  return list ? Array.from(list.querySelectorAll<HTMLElement>(':scope > .v2-qi')) : [];
}

export function NeedsYouPage() {
  const phone = useLayout() === 'phone';
  const { search } = useV2Router();
  const { items, loaded, error } = useNeedsYou();
  const [filter, setFilter] = useState<PageFilter>(() => {
    const asked = new URLSearchParams(search).get('filter');
    return isPageFilter(asked) ? asked : 'all';
  });
  const shown = useMemo(() => applyFilter(items, filter), [items, filter]);
  const counts = useMemo(() => kindCounts(items), [items]);
  const crews = useMemo(() => crewChips(items, filter), [items, filter]);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** The card index to focus once an answered card has left (the next one moves up into its place). */
  const refocus = useRef<number | null>(null);

  useEffect(() => {
    const at = refocus.current;
    if (at === null) return;
    refocus.current = null;
    const cards = cardsIn(listRef.current);
    const next = cards[Math.min(at, cards.length - 1)];
    // Only while the focus went with the answered card (nothing else took it).
    if (next && (document.activeElement === document.body || document.activeElement === null)) next.focus();
  }, [shown]);

  const onListKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    const inField = target.matches('textarea, input:not([type="checkbox"]):not([type="radio"]), select');
    const card = target.closest<HTMLElement>('.v2-qi');
    if (!card || inField) return;
    const cards = cardsIn(listRef.current);
    const index = cards.indexOf(card);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = cards[stepIndex(index, event.key === 'ArrowDown' ? 1 : -1, cards.length)];
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter' && target === card) {
      const send = card.querySelector<HTMLButtonElement>('[data-testid="v2-answer-send"]');
      if (send && !send.disabled) {
        event.preventDefault();
        send.click();
      }
    }
  };

  const chip = (value: PageFilter, label: string, count: number, icon?: string) => (
    <button key={value} type="button" className="v2-fchip" aria-pressed={filter === value} onClick={() => setFilter(value)} data-testid={`v2-needs-filter-${value}`} data-filter={value}>
      {icon ? <Icon name={icon} size="s" /> : null}
      {label} <span className="v2-fchip-n">{count}</span>
    </button>
  );

  return (
    <div className="v2-page v2-needs" style={{ maxWidth: 880 }} data-testid="v2-page-needs-you" data-area="needs-you">
      <h1>{WORDS.needsYou}</h1>
      <p className="v2-page-sub">{phone ? NEEDS_PAGE_WORDS.phoneSub : NEEDS_PAGE_WORDS.sub}</p>
      {loaded && items.length > 0 ? (
        <div className="v2-needs-filters" role="group" aria-label={NEEDS_PAGE_WORDS.filterLabel} data-testid="v2-needs-filters">
          {NEEDS_FILTERS.map((value) => chip(value, NEEDS_FILTER_LABELS[value], counts[value], FILTER_ICON[value]))}
          {crews.map((crew) => chip(crew.filter, crew.label, crew.count, 'crew'))}
          {phone ? null : (
            <>
              <span className="v2-grow" />
              <span className="v2-needs-keyhint">
                <Kbd>Tab</Kbd> {NEEDS_PAGE_WORDS.keyHintTab} <Kbd>1</Kbd>–<Kbd>9</Kbd> {NEEDS_PAGE_WORDS.keyHintAnswer} · <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
              </span>
            </>
          )}
        </div>
      ) : null}
      {!loaded && !error ? <Skeleton lines={3} height={64} /> : null}
      {error && !loaded ? <EmptyState icon="alert" tone="grey" title={NEEDS_PAGE_WORDS.loadError} text={error} /> : null}
      {loaded && items.length === 0 ? <EmptyState title={WORDS.allClear} text={WORDS.allClearText} testId="v2-needs-empty" /> : null}
      {loaded && items.length > 0 && shown.length === 0 ? (
        <EmptyState
          title={NEEDS_PAGE_WORDS.nothingOfKind}
          text={NEEDS_PAGE_WORDS.tryAll}
          testId="v2-needs-filter-empty"
          action={
            <Button variant="default" onClick={() => setFilter('all')}>
              {NEEDS_PAGE_WORDS.showAll}
            </Button>
          }
        />
      ) : null}
      <div className="v2-queue" data-testid="v2-needs-list" ref={listRef} onKeyDown={onListKey}>
        {shown.map((item, index) => (
          <AnswerCard
            key={item.key}
            item={item}
            variant={phone ? 'phone' : 'queue'}
            where="needs"
            openAgent
            onAnswered={() => {
              refocus.current = index;
            }}
          />
        ))}
      </div>
    </div>
  );
}
