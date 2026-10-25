import { useEffect, useState } from 'react';
import { CLI_LABELS, type CliProviderId } from '../../../core/cli-providers.ts';
import type { InsightsAnswer } from '../../../core/insights.ts';
import { api } from '../../api/client.ts';
import { useMachines } from '../../api/useMachines.ts';
import { forecastText } from '../../views/insights/insights-view.ts';
import { machinesNotice, useInsights } from '../../views/insights/useInsights.ts';
import { Button, Card, EmptyState, Icon, Segmented, Skeleton } from '../components/index.ts';
import { INSIGHTS_WORDS, computerStateToV2 } from '../glossary.ts';
import { V2Link, useV2Router } from '../nav.tsx';
import {
  type Bar,
  type HBar,
  INSIGHTS_RANGES,
  type InsightsFilters,
  type InsightsRange,
  accuracyBars,
  barsLabel,
  costBars,
  durationShort,
  estimateAccuracy,
  insightsAddress,
  insightsApiQuery,
  isEmpty,
  money,
  parseInsightsAddress,
  pct,
  rangeWord,
  rework,
  suggestionHref,
  tokenBars,
  tokensShort,
  trendApiQuery,
} from './insights-model.ts';
import './insights.css';

/** Refresh the numbers this often while the page is open (ms). */
const REFRESH_MS = 60_000;

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
}

function withCurrent(values: readonly string[], current: string | null): readonly string[] {
  return current === null || values.includes(current) ? values : [...values, current];
}

/**
 * D131 · Insights (`/insights`), lane R: agent time, tokens, cost, estimate
 * accuracy, rework and the usage forecasts (the D108 API, `GET /api/insights`,
 * merged over every computer by default), filtered by range, folder, AI engine,
 * model, account and computer (all in the address), with plain inline-SVG charts
 * and the routing suggestion. Pure part: `insights-model.ts`.
 */
export function InsightsPage() {
  const { search, navigate } = useV2Router();
  const filters = parseInsightsAddress(search);
  const now = new Date();
  const query = insightsApiQuery(filters, now);
  const machine = filters.computer;
  const state = useInsights(query, machine);
  const trendQuery = trendApiQuery(filters, now);
  const [trend, setTrend] = useState<{ readonly key: string; readonly answer: InsightsAnswer } | null>(null);
  const machines = useMachines();
  const [self, setSelf] = useState('');
  const set = (next: Partial<InsightsFilters>): void => navigate(insightsAddress({ ...filters, ...next }), { replace: true });

  useEffect(() => {
    void api.machines().then((view) => setSelf(view.self.name), () => undefined);
  }, []);
  // Live: the numbers follow while the page is open (and when the window comes back).
  useEffect(() => {
    const timer = window.setInterval(state.reload, REFRESH_MS);
    window.addEventListener('focus', state.reload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', state.reload);
    };
  }, [state.reload]);
  // Today's chart shows the last 7 days: one more read (the other ranges chart their own days).
  const trendKey = `${trendQuery}\n${machine ?? ''}`;
  useEffect(() => {
    if (trendQuery === query) return undefined;
    let live = true;
    const remote = machine !== null && machine !== 'local';
    const path = remote ? `${trendQuery}&machine=local` : `${trendQuery}&machine=${machine === 'local' ? 'local' : 'all'}&peers=cached`;
    api.insights(path, remote ? machine : null).then(
      (answer) => {
        if (live) setTrend({ key: trendKey, answer });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [trendKey, query]);

  const answer = state.data;
  const trendAnswer = trendQuery === query ? answer : trend?.key === trendKey ? trend.answer : null;
  const notice = answer ? machinesNotice(answer.machines) : null;
  const where = machine === null ? INSIGHTS_WORDS.subAll : `${INSIGHTS_WORDS.subOne} ${machine === 'local' ? self || INSIGHTS_WORDS.thisComputer : (machines.find((m) => m.id === machine)?.name ?? machine)}`;
  const options = answer?.options;
  const select = (label: string, testId: string, value: string | null, all: string, list: ReadonlyArray<readonly [string, string]>, key: keyof InsightsFilters) => (
    <select
      className="v2-field v2-ins-select"
      aria-label={label}
      data-testid={testId}
      value={value ?? 'all'}
      onChange={(event) => set({ [key]: event.target.value === 'all' ? null : event.target.value } as Partial<InsightsFilters>)}
    >
      <option value="all">{all}</option>
      {list.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );

  return (
    <div className="v2-page v2-ins" data-wide="" data-testid="v2-page-insights" data-area="insights" aria-busy={state.loading || undefined}>
      <V2Link to="/settings/usage" className="v2-btn v2-ins-back" data-variant="ghost" data-size="sm" data-testid="v2-insights-back">
        <Icon name="back" size="s" />
        {INSIGHTS_WORDS.back}
      </V2Link>
      <div className="v2-ins-ph">
        <div className="v2-grow">
          <h1>{INSIGHTS_WORDS.title}</h1>
          <p className="v2-page-sub" data-testid="v2-insights-sub">
            {INSIGHTS_WORDS.ranges[filters.range]}, {where}. {INSIGHTS_WORDS.subCost}
          </p>
        </div>
        <Segmented<InsightsRange>
          label={INSIGHTS_WORDS.rangeLabel}
          testId="v2-insights-range"
          value={filters.range}
          onChange={(range) => set({ range })}
          options={INSIGHTS_RANGES.map((range) => ({ value: range, label: INSIGHTS_WORDS.ranges[range] }))}
        />
      </div>
      <div className="v2-ins-filters" role="group" aria-label="Filters" data-testid="v2-insights-filters">
        {select(
          INSIGHTS_WORDS.folder,
          'v2-insights-folder',
          filters.folder,
          INSIGHTS_WORDS.folderAll,
          withCurrent(options?.folders.map((f) => (f === '' ? 'none' : f)) ?? [], filters.folder).map((f): [string, string] => [f, f === 'none' ? INSIGHTS_WORDS.noFolder : (options?.folderLabels[f] ?? folderName(f))]),
          'folder',
        )}
        {select(INSIGHTS_WORDS.engine, 'v2-insights-engine', filters.cli, INSIGHTS_WORDS.engineAll, withCurrent(options?.clis ?? [], filters.cli).map((c): [string, string] => [c, CLI_LABELS[c as CliProviderId] ?? c]), 'cli')}
        {select(
          INSIGHTS_WORDS.model,
          'v2-insights-model',
          filters.model,
          INSIGHTS_WORDS.modelAll,
          withCurrent(options?.models.map((m) => (m === '' ? 'none' : m)) ?? [], filters.model).map((m): [string, string] => [m, m === 'none' ? INSIGHTS_WORDS.defaultModel : m]),
          'model',
        )}
        {select(
          INSIGHTS_WORDS.account,
          'v2-insights-account',
          filters.account,
          INSIGHTS_WORDS.accountAll,
          [...(options?.accounts ?? []).map((a): [string, string] => [a.id, a.name]), ...(filters.account && !options?.accounts.some((a) => a.id === filters.account) ? [[filters.account, filters.account] as [string, string]] : [])],
          'account',
        )}
        {select(
          INSIGHTS_WORDS.computer,
          'v2-insights-computer',
          filters.computer,
          INSIGHTS_WORDS.computerAll,
          [['local', self || INSIGHTS_WORDS.thisComputer], ...machines.map((m): [string, string] => [m.id, m.state === 'online' ? m.name : `${m.name} · ${computerStateToV2(m.state)}`])],
          'computer',
        )}
      </div>
      {notice ? (
        <p className="v2-ins-note" data-testid="v2-insights-machines">
          <Icon name="desktop" size="s" />
          {notice}
        </p>
      ) : null}
      {state.error && !answer ? (
        <EmptyState icon="alert" tone="grey" title={INSIGHTS_WORDS.failed} text={state.error.message} action={<Button onClick={state.reload}>{INSIGHTS_WORDS.retry}</Button>} testId="v2-insights-error" />
      ) : null}
      {!answer && !state.error ? <InsightsSkeleton /> : null}
      {answer ? <Body answer={answer} trend={trendAnswer} range={filters.range} /> : null}
    </div>
  );
}

function InsightsSkeleton() {
  return (
    <div data-testid="v2-insights-skeleton" aria-hidden="true">
      <div className="v2-ins-tiles">
        {Array.from({ length: 6 }, (_, i) => (
          <Card key={i} pad>
            <Skeleton width="50%" height={11} />
            <Skeleton width="70%" height={26} style={{ marginTop: 10 }} />
            <Skeleton width="60%" height={10} style={{ marginTop: 10 }} />
          </Card>
        ))}
      </div>
      <Card pad className="v2-ins-skel-chart">
        <Skeleton width="30%" height={14} />
        <Skeleton width="100%" height={160} style={{ marginTop: 14 }} />
      </Card>
    </div>
  );
}

function Body({ answer, trend, range }: { readonly answer: InsightsAnswer; readonly trend: InsightsAnswer | null; readonly range: InsightsRange }) {
  const word = rangeWord(range);
  const totals = answer.time.totals;
  const currency = answer.cost.currency;
  const accuracy = estimateAccuracy(answer.estimates);
  const redo = rework(answer.outcomes.byModel);
  const today = answer.query.to;
  const bars = trend ? tokenBars(trend.time.trend, today) : [];
  const cost = costBars(answer.cost.period.byFolder, currency);
  const accuracyRows = accuracyBars(answer.estimates);
  const suggestion = answer.suggestions[0] ?? null;
  const pressing = answer.forecast.flatMap((account) => {
    const window = account.windows.find((w) => w.verdict === 'full' || w.verdict === 'fills');
    return window ? [{ account, window }] : [];
  });
  const calm = answer.forecast.slice(0, 2).flatMap((account) => (account.windows[0] ? [{ account, window: account.windows[0] }] : []));
  const forecasts = pressing.length > 0 ? pressing : calm;
  const pricedModels = answer.cost.byModel.filter((row) => row.priced > 0).map((row) => row.label);
  return (
    <>
      {answer.backfill.done ? null : (
        <p className="v2-ins-note" role="status">
          <Icon name="refresh" size="s" />
          {INSIGHTS_WORDS.backfill} {answer.backfill.percent}%
        </p>
      )}
      {suggestion ? (
        <div className="v2-ins-callout" data-tone="accent" data-testid="v2-insights-suggestion">
          <Icon name="sparkle" size="s" />
          <span>
            <b>{INSIGHTS_WORDS.suggestion}</b> {suggestion.text}{' '}
            <V2Link to={suggestionHref(suggestion)} className="v2-btn" data-size="sm" data-testid="v2-insights-suggestion-switch">
              {INSIGHTS_WORDS.switchRule}
            </V2Link>
          </span>
        </div>
      ) : null}
      {isEmpty(answer) ? <EmptyState icon="insights" tone="grey" title={INSIGHTS_WORDS.emptyTitle} text={INSIGHTS_WORDS.emptyText} testId="v2-insights-empty" /> : null}
      <div className="v2-ins-tiles" data-testid="v2-insights-tiles">
        <Tile id="time" k={`${INSIGHTS_WORDS.tiles.time} ${word}`} v={durationShort(totals.durationMs)} s={`${totals.sessions} ${totals.sessions === 1 ? 'agent' : 'agents'} · ${totals.turns} ${totals.turns === 1 ? 'reply' : 'replies'}`} />
        <Tile id="tokens" k={`${INSIGHTS_WORDS.tiles.tokens} ${word}`} v={tokensShort(totals.tokens)} s={totals.tokensPerTurn === null ? '—' : `${tokensShort(totals.tokensPerTurn)} per reply`} />
        <Tile
          id="cost"
          k={`${INSIGHTS_WORDS.tiles.cost} ${word}`}
          v={money(answer.cost.period.total, currency)}
          s={answer.cost.period.lowerBound ? 'at least: older replies have no split' : answer.cost.period.chats > 0 ? `${money(answer.cost.period.chats, currency)} more in conversations` : 'every agent'}
        />
        <Tile id="estimates" k={INSIGHTS_WORDS.tiles.estimates} v={pct(accuracy)} s={answer.estimates.count === 0 ? 'no finished tasks with an estimate' : `accurate ${word} · ${answer.estimates.count} ${answer.estimates.count === 1 ? 'task' : 'tasks'}`} />
        <Tile id="rework" k={INSIGHTS_WORDS.tiles.rework} v={pct(redo.rate)} s={`${redo.reopened} of ${redo.done} tasks reopened · ${redo.sentBack} change ${redo.sentBack === 1 ? 'request' : 'requests'} sent back`} />
        <Tile
          id="prices"
          k={INSIGHTS_WORDS.tiles.prices}
          v={answer.cost.example ? INSIGHTS_WORDS.examplePrices : INSIGHTS_WORDS.yourPrices}
          small
          s={`${pricedModels.length > 0 ? `${pricedModels.join(' · ')} · ` : ''}${currency} · ${INSIGHTS_WORDS.editPrices}`}
        />
      </div>
      <div className="v2-ins-grid">
        <Card pad className="v2-ins-chart" data-testid="v2-insights-tokens-chart">
          <h3>{INSIGHTS_WORDS.tokensPerDay}</h3>
          <div className="v2-ins-chart-sub">{range === 'today' ? INSIGHTS_WORDS.last7 : INSIGHTS_WORDS.ranges[range]}</div>
          {trend ? <VBars bars={bars} label={barsLabel(INSIGHTS_WORDS.tokensPerDay, bars)} /> : <Skeleton width="100%" height={180} />}
        </Card>
        <Card pad className="v2-ins-chart" data-testid="v2-insights-cost-chart">
          <h3>{INSIGHTS_WORDS.costWent}</h3>
          <div className="v2-ins-chart-sub">
            {money(answer.cost.period.total, currency)} total · {word}
          </div>
          <HBars bars={cost} label={`${INSIGHTS_WORDS.costWent}: ${cost.map((b) => `${b.label} ${b.valueText}`).join(', ')}`} testId="v2-insights-cost-bars" />
          <div className="v2-ins-forecast" data-testid="v2-insights-forecast">
            {answer.forecast.length === 0 ? <p className="v2-muted">{INSIGHTS_WORDS.noForecast}</p> : null}
            {forecasts.map(({ account, window }) => (
              <div key={`${account.profileId}-${window.window}`} className="v2-ins-callout" data-tone={window.verdict === 'full' || window.verdict === 'fills' ? 'amber' : 'grey'}>
                <Icon name="alert" size="s" />
                <span>
                  <b>{account.name}</b>: {forecastText(window)}
                  {account.onCredits && account.credits ? ` ${account.credits}.` : ''}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card pad className="v2-ins-chart v2-ins-wide" data-testid="v2-insights-estimates-chart">
        <h3>{INSIGHTS_WORDS.estimateVsActual}</h3>
        <div className="v2-ins-chart-sub">
          {INSIGHTS_WORDS.estimateSub}
          {answer.estimates.median === null ? '' : ` · median ${answer.estimates.median.toFixed(1)}×`}
        </div>
        <HBars bars={accuracyRows} label={`${INSIGHTS_WORDS.estimateVsActual}: ${accuracyRows.map((b) => `${b.label}: ${b.valueText}`).join(', ')}`} testId="v2-insights-accuracy-bars" />
      </Card>
    </>
  );
}

function Tile({ id, k, v, s, small = false }: { readonly id: string; readonly k: string; readonly v: string; readonly s: string; readonly small?: boolean }) {
  return (
    <Card pad className="v2-ins-tile" data-testid={`v2-insights-tile-${id}`}>
      <div className="v2-ins-k">{k}</div>
      <div className="v2-ins-v" data-small={small || undefined}>
        {v}
      </div>
      <div className="v2-ins-s">{s}</div>
    </Card>
  );
}

/** Vertical bars as inline SVG (one rect per day) with the values and days under them. */
function VBars({ bars, label }: { readonly bars: readonly Bar[]; readonly label: string }) {
  const n = Math.max(1, bars.length);
  const slot = 100 / n;
  const width = Math.min(slot * 0.7, 14);
  return (
    <div className="v2-ins-vbars">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={label} data-testid="v2-insights-vbars">
        <line x1="0" y1="100" x2="100" y2="100" className="v2-ins-axis" vectorEffect="non-scaling-stroke" />
        {bars.map((bar, i) => {
          const h = bar.value > 0 ? Math.max(1.5, bar.height * 0.95) : 0;
          return <rect key={bar.key} x={i * slot + (slot - width) / 2} y={100 - h} width={width} height={h} rx="1" className="v2-ins-bar" data-last={bar.last || undefined} />;
        })}
      </svg>
      <div className="v2-ins-vlbl" aria-hidden="true" data-dense={bars.length > 10 || undefined}>
        {bars.map((bar) => (
          <span key={bar.key} data-last={bar.last || undefined}>
            <i>{bar.valueText}</i>
            {bar.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Horizontal bars (label, value, an inline-SVG meter). */
function HBars({ bars, label, testId }: { readonly bars: readonly HBar[]; readonly label: string; readonly testId: string }) {
  if (bars.length === 0)
    return (
      <p className="v2-muted" data-testid={testId}>
        —
      </p>
    );
  return (
    <div role="img" aria-label={label} data-testid={testId}>
      {bars.map((bar) => (
        <div key={bar.key} className="v2-ins-hbar" data-key={bar.key}>
          <div className="v2-ins-hbar-row" aria-hidden="true">
            <span className="v2-grow">{bar.label}</span>
            <b>{bar.valueText}</b>
          </div>
          <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="v2-ins-meter" aria-hidden="true">
            <rect x="0" y="0" width="100" height="8" rx="4" className="v2-ins-meter-bg" />
            {bar.width > 0 ? <rect x="0" y="0" width={Math.max(2, bar.width)} height="8" rx="4" className="v2-ins-meter-fill" /> : null}
          </svg>
        </div>
      ))}
    </div>
  );
}
