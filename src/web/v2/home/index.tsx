import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { ArtifactListItem, Session } from '../../../core/api.ts';
import { useTick } from '../../activity/useActivity.ts';
import { api } from '../../api/client.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { useLayout } from '../../shell/useLayout.ts';
import { EmptyState, Icon, IconButton, Skeleton } from '../components/index.ts';
import { HOME_WORDS, NEEDS_PAGE_WORDS, WORDS } from '../glossary.ts';
import { V2Link, useV2Router } from '../nav.tsx';
import '../needs-you/needs.css';
import { AnswerCard } from '../shared/AnswerCard.tsx';
import { useNeedsYou } from '../shared/needs-you.ts';
import { DoneToday } from './DoneToday.tsx';
import { type StartEvents, StartBox } from './StartBox.tsx';
import { type PendingStart, WorkingNow } from './WorkingNow.tsx';
import { HOME_NEEDS_LIMIT, dateLine, doneToday, greeting, needsSummary, topNeeds, workSummary, workingNow } from './home-model.ts';
import './home.css';

/**
 * D131 · Home (`/`), lane H (`README.md`; the prototype's `#s-home` and phone
 * `home`): a greeting with what needs you and what runs, the start box, Needs you
 * (the queue's top 3 as full answer cards, then "See all N"), Working now (live
 * cards on every computer) and Done today (finished agents with Combine, new
 * results). Everything is live: the Needs-you store, the shared session list and
 * the results list follow `/hub`.
 */

function SectionHead({ id, icon, tone, title, count, countTone, hint, link }: { readonly id: string; readonly icon: string; readonly tone: string; readonly title: string; readonly count: number | null; readonly countTone?: 'amber'; readonly hint?: string; readonly link: ReactNode }) {
  return (
    <div className="v2-home-sec-h">
      <span className="v2-home-sec-i" data-tone={tone}>
        <Icon name={icon} />
      </span>
      <h2 id={id}>{title}</h2>
      {count !== null ? (
        <span className="v2-home-count" data-tone={countTone} data-testid={`${id}-count`}>
          {count}
        </span>
      ) : null}
      {hint ? <span className="v2-home-hint">{hint}</span> : null}
      {link}
    </div>
  );
}

export function HomePage() {
  const phone = useLayout() === 'phone';
  const { navigate } = useV2Router();
  const needs = useNeedsYou();
  const sessions = useSessionListOf('all');
  const artifacts = useApi<ArtifactListItem[]>(() => api.artifacts());
  useHubEvent('artifactsChanged', () => artifacts.reload());
  const [pending, setPending] = useState<PendingStart | null>(null);
  // The day's lists and the header's greeting move on with the clock (a minute is enough).
  const now = useTick(60_000);

  const list = sessions.data;
  const working = useMemo(() => workingNow(list ?? []), [list]);
  const done = useMemo(() => doneToday(list ?? [], artifacts.data ?? [], needs.items, now), [list, artifacts.data, needs.items, now]);
  const top = topNeeds(needs.items, phone ? HOME_NEEDS_LIMIT.phone : HOME_NEEDS_LIMIT.wide);
  const takenNames = useMemo(() => (list ?? []).map((session) => session.name), [list]);
  const count = needs.items.length;
  const loaded = list !== null;

  const events = useMemo<StartEvents>(
    () => ({
      onStarting: (title: string) => setPending({ title, sessionId: null }),
      onStarted: (session: Session) => setPending((current) => (current ? { ...current, sessionId: session.id } : current)),
      onFailed: () => setPending(null),
    }),
    [],
  );
  // The skeleton goes once its agent is in the list (working: its live card; already finished: Done today).
  useEffect(() => {
    if (!pending?.sessionId) return undefined;
    if (list?.some((session) => session.id === pending.sessionId && session.status !== 'idle')) {
      setPending(null);
      return undefined;
    }
    // An agent that never shows as running (refused by its CLI, still idle) does not keep a skeleton forever.
    const timer = window.setTimeout(() => setPending((current) => (current === pending ? null : current)), 15_000);
    return () => window.clearTimeout(timer);
  }, [list, pending]);

  const needsBody =
    !needs.loaded && !needs.error ? (
      <Skeleton lines={2} height={64} />
    ) : needs.error && !needs.loaded ? (
      <EmptyState icon="alert" tone="grey" title={NEEDS_PAGE_WORDS.loadError} text={needs.error} />
    ) : count === 0 ? (
      <EmptyState title={WORDS.allClear} text={WORDS.allClearText} testId="v2-home-needs-empty" />
    ) : (
      <div className="v2-queue" data-testid="v2-home-needs">
        {top.shown.map((item) => (
          <AnswerCard key={item.key} item={item} variant={phone ? 'phone' : 'queue'} where="home" />
        ))}
        {top.more ? (
          <V2Link to="/needs-you" className="v2-home-more-row" data-testid="v2-home-see-all-row">
            {phone ? HOME_WORDS.seeAll(count) : HOME_WORDS.seeAllWaiting(count)}
            <Icon name="chev" size="s" />
          </V2Link>
        ) : null}
      </div>
    );

  if (phone) {
    return (
      <div className="v2-page v2-home" data-testid="v2-page-home" data-area="home" data-phone="">
        <div className="v2-row v2-home-ptop">
          <h1 className="v2-grow">{WORDS.home}</h1>
          <IconButton icon="bell" label={count > 0 ? `${WORDS.needsYou}: ${count}` : WORDS.needsYou} badge={count} size="l" onClick={() => navigate('/needs-you')} />
        </div>
        <p className="v2-home-psum">
          <b data-tone={count > 0 ? 'amber' : 'green'} data-testid="v2-home-summary">
            {needsSummary(count)}
          </b>{' '}
          · {working.length} {HOME_WORDS.working}
        </p>
        <StartBox phone takenNames={takenNames} events={events} />
        <h2 className="v2-home-psec">
          <Icon name="hand" size="s" />
          {WORDS.needsYou}
        </h2>
        {needsBody}
        <h2 className="v2-home-psec">
          <Icon name="agents" size="s" />
          {HOME_WORDS.workingNow}
        </h2>
        <WorkingNow working={working} loaded={loaded} pending={pending} items={needs.items} phone />
        <h2 className="v2-home-psec">
          <Icon name="check-circle" size="s" />
          {HOME_WORDS.doneTodayTitle}
        </h2>
        <DoneToday rows={done} loaded={loaded} phone now={now} />
      </div>
    );
  }

  return (
    <div className="v2-page v2-home" data-testid="v2-page-home" data-area="home">
      <h1 data-testid="v2-home-greeting">{greeting(now)}</h1>
      <p className="v2-page-sub">
        {dateLine(now)} ·{' '}
        <b data-tone={count > 0 ? 'amber' : 'green'} data-testid="v2-home-summary">
          {needsSummary(count)}
        </b>{' '}
        · <span data-testid="v2-home-work-summary">{workSummary(working.length, done.length)}</span>
      </p>

      <StartBox phone={false} takenNames={takenNames} events={events} />

      <section className="v2-home-sec" aria-labelledby="v2-home-needs">
        <SectionHead
          id="v2-home-needs"
          icon="hand"
          tone="amber"
          title={WORDS.needsYou}
          count={count > 0 ? count : null}
          countTone="amber"
          hint={HOME_WORDS.needsHint}
          link={
            <V2Link to="/needs-you" className="v2-home-link" data-testid="v2-home-see-all">
              {HOME_WORDS.seeAll(count)} <Icon name="chev" size="s" />
            </V2Link>
          }
        />
        {needsBody}
      </section>

      <section className="v2-home-sec" aria-labelledby="v2-home-working">
        <SectionHead
          id="v2-home-working"
          icon="agents"
          tone="blue"
          title={HOME_WORDS.workingNow}
          count={working.length}
          hint={HOME_WORDS.workingHint}
          link={
            <V2Link to="/agents" className="v2-home-link">
              {HOME_WORDS.allAgents} <Icon name="chev" size="s" />
            </V2Link>
          }
        />
        <WorkingNow working={working} loaded={loaded} pending={pending} items={needs.items} phone={false} />
      </section>

      <section className="v2-home-sec" aria-labelledby="v2-home-done">
        <SectionHead
          id="v2-home-done"
          icon="check-circle"
          tone="green"
          title={HOME_WORDS.doneTodayTitle}
          count={done.length}
          link={
            <V2Link to="/results" className="v2-home-link">
              {HOME_WORDS.allResults} <Icon name="chev" size="s" />
            </V2Link>
          }
        />
        <DoneToday rows={done} loaded={loaded} phone={false} now={now} />
      </section>
    </div>
  );
}
