import { useEffect, useMemo, useState } from 'react';
import type { SessionActivity, SessionDetail } from '../../../core/api.ts';
import { Button } from '../components/index.ts';
import { AGENT_WORDS } from '../glossary.ts';
import { HELPERS_PAGE, HELPERS_TICK_MS, type HelperFold, type HelperRows, foldHelpers, helperRows, nextFoldAt, withPendingHelpers } from './helpers-model.ts';

/**
 * 2026-10-27 · the helpers fold (`helpers-model.ts`, `docs/v2.md` → *Helpers
 * fold*): the live clock the lists fold by, the expanded state of one list (per
 * agent view, not remembered) and the rows under a list: "Show N helpers
 * finished earlier" / "Hide …" and, expanded, "Show more".
 */

/**
 * The time the fold is computed at. It moves only when it matters: a timer at the
 * moment the next recent helper folds (never sooner than a minute after the last
 * tick), and on a new session payload at most once a minute. No timer while no
 * helper can fold.
 */
export function useFoldClock(session: Pick<SessionDetail, 'agents' | 'workflows'> | null): number {
  const [now, setNow] = useState(() => Date.now());
  const agents = session?.agents;
  const runs = session?.workflows;
  // A new payload with a stale clock (nothing ticked for a while): catch up, at most once a minute.
  useEffect(() => {
    if (Date.now() - now >= HELPERS_TICK_MS) setNow(Date.now());
    // `now` is read, not followed: only a new payload catches up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, runs]);
  const next = useMemo(() => (agents ? nextFoldAt(agents, now, runs ?? []) : null), [agents, runs, now]);
  useEffect(() => {
    if (next === null) return undefined;
    const wait = Math.max(next - Date.now(), now + HELPERS_TICK_MS - Date.now(), 0);
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [next, now]);
  return now;
}

/** One list's fold: the rows, and its expanded state and page (reset when the agent changes). */
export function useHelperList<A>(fold: HelperFold<A>, sessionId: string): HelperRows<A> & { readonly expanded: boolean; readonly toggle: () => void; readonly showMore: () => void } {
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(HELPERS_PAGE);
  useEffect(() => {
    setExpanded(false);
    setLimit(HELPERS_PAGE);
  }, [sessionId]);
  const rows = useMemo(() => helperRows(fold, expanded, limit), [fold, expanded, limit]);
  return {
    ...rows,
    expanded,
    toggle: () => {
      setExpanded((value) => !value);
      setLimit(HELPERS_PAGE);
    },
    showMore: () => setLimit((value) => value + HELPERS_PAGE),
  };
}

/** The helpers of a session folded at the fold clock's time (an async helper still pending counts as active); the rows are the session's own agents. */
export function useHelpersFold(session: SessionDetail | null, background: SessionActivity['background'] | null | undefined): HelperFold<SessionDetail['agents'][number]> {
  const now = useFoldClock(session);
  return useMemo(() => {
    const agents = session?.agents ?? [];
    const fold = foldHelpers(withPendingHelpers(agents, background), now, session?.workflows ?? []);
    const own = new Map(agents.map((agent) => [agent.id, agent]));
    const back = (list: readonly SessionDetail['agents'][number][]) => list.map((agent) => own.get(agent.id) ?? agent);
    return { active: back(fold.active), recent: back(fold.recent), earlier: back(fold.earlier) };
  }, [session?.agents, session?.workflows, background, now]);
}

/** The row under a list: "Show N helpers finished earlier" (folded) or "Hide …" (expanded); nothing when none is folded. */
export function EarlierToggle({
  count,
  expanded,
  onToggle,
  words = AGENT_WORDS.showEarlierHelpers,
  testId = 'v2-agent-helpers-earlier',
}: {
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly words?: (n: number) => string;
  readonly testId?: string;
}) {
  if (count === 0) return null;
  return (
    <Button size="sm" variant="ghost" icon={expanded ? 'chev-down' : 'chev'} className="v2-ag-fold" data-testid={testId} aria-expanded={expanded} onClick={onToggle}>
      {expanded ? AGENT_WORDS.hideEarlierHelpers : words(count)}
    </Button>
  );
}

/** "Show more" under an expanded list with more folded helpers than are rendered. */
export function ShowMoreHelpers({ more, onMore, testId = 'v2-agent-helpers-more' }: { readonly more: number; readonly onMore: () => void; readonly testId?: string }) {
  if (more === 0) return null;
  return (
    <Button size="sm" variant="ghost" className="v2-ag-fold" data-testid={testId} onClick={onMore}>
      {AGENT_WORDS.showMoreHelpers(Math.min(more, HELPERS_PAGE), more)}
    </Button>
  );
}
