import { EmptyState, Skeleton } from '../components/index.ts';
import { WORDS } from '../glossary.ts';
import { AnswerCard } from '../shared/AnswerCard.tsx';
import { useNeedsYou } from '../shared/needs-you.ts';

/**
 * D131 · Needs you (`/needs-you`), lane H: the one queue of everything waiting for
 * the developer (`shared/needs-you.ts`), answered in place (`shared/AnswerCard.tsx`).
 * This stub already lists and answers every item; lane H adds the filters (kind,
 * crew), the empty states and the page's Undo bar. See `README.md`.
 */
export function NeedsYouPage() {
  const { items, loaded, error } = useNeedsYou();
  return (
    <div className="v2-page" style={{ maxWidth: 880 }} data-testid="v2-page-needs-you" data-area="needs-you">
      <h1>{WORDS.needsYou}</h1>
      <p className="v2-page-sub">One queue for every agent, project step, teammate and computer. The same cards sit in each agent’s chat; answer either one and both update.</p>
      {!loaded && !error ? <Skeleton lines={3} height={64} /> : null}
      {error && !loaded ? <EmptyState icon="alert" tone="grey" title="Needs you could not be loaded" text={error} /> : null}
      {loaded && items.length === 0 ? <EmptyState title={WORDS.allClear} text={WORDS.allClearText} testId="v2-needs-empty" /> : null}
      <div className="v2-queue" data-testid="v2-needs-list" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {items.map((item) => (
          <AnswerCard key={item.key} item={item} variant="queue" where="needs" />
        ))}
      </div>
    </div>
  );
}
