import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageAnswer, UsageGroupBy, UsagePeriod, UsageRow } from '../../../core/usage-breakdown.ts';
import { USAGE_GROUPS, USAGE_PERIODS, isBackgroundSession } from '../../../core/usage-breakdown.ts';
import { ApiError, api } from '../../api/client.ts';
import { useMachines } from '../../api/useMachines.ts';
import { machinesNotice } from '../../views/insights/useInsights.ts';
import { Button, Card, Chip, ComputerTag, EmptyState, Icon, Segmented, Skeleton } from '../components/index.ts';
import { USAGE_WORDS, computerStateToV2 } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { useOpenAgent } from '../shared/open-agent.ts';
import { money, tokensShort } from './insights-model.ts';
import { type UsageFilters, chartLabel, estimateText, logPages, logTime, parseUsageAddress, shareText, spanText, splitText, stackColumns, usageAddress, usageApiQuery, usageCsvHref } from './usage-model.ts';

/** Refresh while the view is open (ms). */
const REFRESH_MS = 60_000;

interface UsageState {
  readonly data: UsageAnswer | null;
  readonly error: ApiError | null;
  readonly loading: boolean;
  readonly reload: () => void;
}

/** The view's answer: merged over every computer by default (this machine at once, the paired ones filled in after), like Insights. */
function useUsage(query: string, machine: string | null): UsageState {
  const [data, setData] = useState<UsageAnswer | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const mine = (generation.current += 1);
    const current = (): boolean => generation.current === mine;
    setLoading(true);
    const fail = (caught: unknown): void => {
      if (!current()) return;
      setError(caught instanceof ApiError ? caught : new ApiError(0, String(caught)));
      setLoading(false);
    };
    const show = (answer: UsageAnswer): void => {
      if (!current()) return;
      setData(answer);
      setError(null);
    };
    if (machine !== null && machine !== 'local') {
      api.insightsUsage(`${query}&machine=local`, machine).then((answer) => {
        show(answer);
        if (current()) setLoading(false);
      }, fail);
    } else {
      const scope = machine === 'local' ? 'local' : 'all';
      api.insightsUsage(`${query}&machine=${scope}&peers=cached`).then(async (answer) => {
        show(answer);
        if (scope === 'all' && answer.machines.pending.length > 0 && current()) {
          try {
            show(await api.insightsUsage(`${query}&machine=all&peers=wait`));
          } catch {
            // The first answer stays; its notice says what is missing.
          }
        }
        if (current()) setLoading(false);
      }, fail);
    }
  }, [query, machine, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}

/**
 * D134 · Insights → Usage (`/insights?view=usage`): where each account's usage window went,
 * session by session (or by folder, model, account, kind), with a stacked chart of the top
 * five, an honest note on what the shares are, and a paged log of the replies. Pure part:
 * `usage-model.ts`; API: `GET /api/insights/usage` (`docs/insights.md` → *Usage breakdown*).
 */
export function UsageView({ self }: { readonly self: string }) {
  const { search, navigate } = useV2Router();
  const filters = parseUsageAddress(search);
  const now = new Date();
  const query = usageApiQuery(filters, now);
  const state = useUsage(query, filters.computer);
  const machines = useMachines();
  const set = (next: Partial<UsageFilters>): void => navigate(usageAddress({ ...filters, page: 0, ...next }), { replace: true });

  useEffect(() => {
    const timer = window.setInterval(state.reload, REFRESH_MS);
    window.addEventListener('focus', state.reload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', state.reload);
    };
  }, [state.reload]);

  const answer = state.data;
  const notice = answer ? machinesNotice(answer.machines) : null;
  const accounts = answer?.accounts ?? [];
  return (
    <div className="v2-usage" data-testid="v2-usage" data-tour="v2-usage">
      <div className="v2-ins-ph">
        <div className="v2-grow">
          <h2 className="v2-usage-h">{USAGE_WORDS.title}</h2>
          {answer ? (
            <p className="v2-page-sub" data-testid="v2-usage-totals">
              {USAGE_WORDS.totalsLine(tokensShort(answer.totals.tokens), answer.totals.turns, answer.totals.sessions)}
              {answer.totals.cost !== null ? ` · ${answer.totals.costPartial ? '≥ ' : ''}${money(answer.totals.cost, answer.currency)}` : ''}
            </p>
          ) : null}
        </div>
        <Segmented<UsagePeriod>
          label={USAGE_WORDS.periodLabel}
          testId="v2-usage-period"
          value={filters.period}
          onChange={(period) => set({ period, group: null })}
          options={USAGE_PERIODS.map((period) => ({ value: period, label: USAGE_WORDS.periodsShort[period] }))}
        />
      </div>
      <div className="v2-ins-filters" role="group" aria-label="Usage filters" data-testid="v2-usage-filters">
        <select className="v2-field v2-ins-select" aria-label="Account" data-testid="v2-usage-account" value={filters.account ?? 'all'} onChange={(event) => set({ account: event.target.value === 'all' ? null : event.target.value })}>
          <option value="all">{USAGE_WORDS.accountAll}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          {filters.account && !accounts.some((a) => a.id === filters.account) ? <option value={filters.account}>{filters.account}</option> : null}
        </select>
        <select className="v2-field v2-ins-select" aria-label={USAGE_WORDS.groupLabel} data-testid="v2-usage-group" value={filters.groupBy} onChange={(event) => set({ groupBy: event.target.value as UsageGroupBy, group: null })}>
          {USAGE_GROUPS.map((group) => (
            <option key={group} value={group}>
              {`${USAGE_WORDS.groupLabel}: ${USAGE_WORDS.groups[group]}`}
            </option>
          ))}
        </select>
        <select className="v2-field v2-ins-select" aria-label="Computer" data-testid="v2-usage-computer" value={filters.computer ?? 'all'} onChange={(event) => set({ computer: event.target.value === 'all' ? null : event.target.value })}>
          <option value="all">{USAGE_WORDS.computerAll}</option>
          <option value="local">{self || USAGE_WORDS.thisComputer}</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.state === 'online' ? m.name : `${m.name} · ${computerStateToV2(m.state)}`}
            </option>
          ))}
        </select>
      </div>
      {notice ? (
        <p className="v2-ins-note" data-testid="v2-usage-machines">
          <Icon name="desktop" size="s" />
          {notice}
        </p>
      ) : null}
      {state.error && !answer ? <EmptyState icon="alert" tone="grey" title={USAGE_WORDS.failed} text={state.error.message} action={<Button onClick={state.reload}>{USAGE_WORDS.retry}</Button>} testId="v2-usage-error" /> : null}
      {!answer && !state.error ? (
        <Card pad aria-hidden="true" data-testid="v2-usage-skeleton">
          <Skeleton width="40%" height={14} />
          <Skeleton width="100%" height={140} style={{ marginTop: 14 }} />
        </Card>
      ) : null}
      {answer ? <UsageBody answer={answer} filters={filters} self={self} now={now} set={set} /> : null}
    </div>
  );
}

function UsageBody({ answer, filters, self, now, set }: { readonly answer: UsageAnswer; readonly filters: UsageFilters; readonly self: string; readonly now: Date; readonly set: (next: Partial<UsageFilters>) => void }) {
  const many = answer.machines.included.length > 1;
  const machineName = (m: { readonly id: string | null; readonly name: string } | null): string => (m === null ? '' : m.id === null ? self || USAGE_WORDS.thisComputer : m.name);
  const groupLabel = filters.group === null ? null : (answer.rows.find((row) => row.key === filters.group)?.label ?? filters.group);
  const windowed = filters.period === '5h' || filters.period === 'week';
  return (
    <>
      {answer.backfill.done ? null : (
        <p className="v2-ins-note" role="status">
          <Icon name="refresh" size="s" />
          {USAGE_WORDS.backfill} {answer.backfill.percent}%
        </p>
      )}
      <div className="v2-usage-windows" data-testid="v2-usage-windows">
        {windowed
          ? answer.spans.map((span) => (
              <span key={span.accountId ?? 'all'} className="v2-usage-window" data-testid="v2-usage-window">
                <Icon name="clock" size="s" />
                {span.sinceReset ? USAGE_WORDS.sinceReset(span.name) : spanText(span, now, '')}
              </span>
            ))
          : null}
        {answer.unknownWindows.length > 0 ? (
          <span className="v2-usage-window" data-tone="grey" data-testid="v2-usage-unknown">
            <Icon name="info" size="s" />
            {USAGE_WORDS.noWindow(answer.unknownWindows.join(', '))}
          </span>
        ) : null}
      </div>
      <div className="v2-ins-callout v2-usage-info" data-tone="grey" data-testid="v2-usage-info">
        <Icon name="info" size="s" />
        <div>
          <b>{USAGE_WORDS.infoTitle}.</b> {USAGE_WORDS.info[0]} {USAGE_WORDS.info[1]}
          {answer.estimate.available ? ` ${USAGE_WORDS.infoEstimate}` : ''}
        </div>
      </div>
      {answer.totals.turns === 0 ? <EmptyState icon="insights" tone="grey" title={USAGE_WORDS.empty} text={USAGE_WORDS.emptyHint} testId="v2-usage-empty" /> : null}
      {answer.totals.turns > 0 ? <UsageChartCard answer={answer} /> : null}
      {answer.rows.length > 0 ? (
        <Card pad className="v2-usage-card" data-testid="v2-usage-list">
          <div className="v2-usage-card-h">
            <h3>{USAGE_WORDS.groups[filters.groupBy]}</h3>
            <span className="v2-muted v2-usage-small">{answer.shareOf === 'account' ? USAGE_WORDS.shareOfAccount : USAGE_WORDS.shareOfAll}</span>
          </div>
          <ol className="v2-usage-rows">
            {answer.rows.map((row, index) => (
              <UsageListRow key={row.key} row={row} rank={index + 1} currency={answer.currency} machine={many ? machineName(row.machine) : null} grouped={filters.groupBy !== 'session'} active={filters.group === row.key} onLog={() => set({ group: filters.group === row.key ? null : row.key })} />
            ))}
          </ol>
          {answer.more ? <p className="v2-muted v2-usage-small">{USAGE_WORDS.more(answer.more.count, tokensShort(answer.more.tokens))}</p> : null}
          <p className="v2-muted v2-usage-small">{USAGE_WORDS.costNote}</p>
        </Card>
      ) : null}
      <UsageLog answer={answer} filters={filters} groupLabel={groupLabel} many={many} machineName={machineName} now={now} set={set} />
    </>
  );
}

const SLOTS = 5;

function UsageChartCard({ answer }: { readonly answer: UsageAnswer }) {
  const { columns } = stackColumns(answer.chart);
  const n = Math.max(1, columns.length);
  const slot = 100 / n;
  const width = Math.min(slot * 0.72, 14);
  const label = chartLabel(answer.chart);
  return (
    <Card pad className="v2-ins-chart v2-usage-card" data-testid="v2-usage-chart">
      <h3>{USAGE_WORDS.chartTitle}</h3>
      <div className="v2-ins-chart-sub">{USAGE_WORDS.periods[answer.query.period]}</div>
      <div className="v2-usage-legend" data-testid="v2-usage-legend">
        {answer.chart.series.map((s, index) => (
          <span key={s.key} className="v2-usage-legend-item">
            <i className="v2-usage-swatch" data-slot={s.other ? 'other' : String(index % SLOTS)} aria-hidden="true" />
            {s.label}
          </span>
        ))}
      </div>
      <svg className="v2-usage-stack" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={label} data-testid="v2-usage-stack">
        <line x1="0" y1="100" x2="100" y2="100" className="v2-ins-axis" vectorEffect="non-scaling-stroke" />
        {columns.map((column, i) => (
          <g key={column.key} data-total={column.total}>
            <title>{`${column.label}: ${tokensShort(column.total)} tokens${column.segments.map((seg) => `\n${answer.chart.series[seg.series]?.label ?? ''}: ${tokensShort(seg.value)}`).join('')}`}</title>
            {/* A full-height hit target, bigger than the marks, for the tooltip. */}
            <rect x={i * slot} y={0} width={slot} height={100} className="v2-usage-hit" />
            {column.segments.map((seg) => {
              const series = answer.chart.series[seg.series];
              // A 2-px-like surface gap between stacked segments (in plot units).
              const h = Math.max(0.6, seg.h - 0.6);
              return <rect key={seg.series} x={i * slot + (slot - width) / 2} y={seg.y} width={width} height={h} rx="1" className="v2-usage-seg" data-slot={series?.other ? 'other' : String(seg.series % SLOTS)} />;
            })}
          </g>
        ))}
      </svg>
      <div className="v2-ins-vlbl" aria-hidden="true" data-dense={columns.length > 10 || undefined}>
        {columns.map((column, i) => (
          <span key={column.key}>{columns.length > 12 && i % 2 === 1 ? '' : column.label}</span>
        ))}
      </div>
    </Card>
  );
}

function UsageListRow({ row, rank, currency, machine, grouped, active, onLog }: { readonly row: UsageRow; readonly rank: number; readonly currency: string; readonly machine: string | null; readonly grouped: boolean; readonly active: boolean; readonly onLog: () => void }) {
  const [open, setOpen] = useState(false);
  const openAgent = useOpenAgent();
  const hasAgents = row.agents.tokens > 0 || row.agents.cacheRead > 0;
  return (
    <li className="v2-usage-row" data-testid="v2-usage-row" data-key={row.key}>
      <div className="v2-usage-row-main">
        <span className="v2-usage-rank" aria-hidden="true">
          {rank}
        </span>
        <div className="v2-grow v2-usage-name">
          <div className="v2-row v2-usage-title">
            <b data-testid="v2-usage-row-label">{row.label}</b>
            {row.kind && row.kind !== 'agent' ? (
              <Chip size="s" tone="grey">
                {USAGE_WORDS.kinds[row.kind]}
              </Chip>
            ) : null}
            {machine ? <ComputerTag name={machine} short testId="v2-usage-row-computer" /> : null}
          </div>
          <div className="v2-muted v2-usage-small">
            {splitText(row.total)} · {tokensShort(row.total.cacheRead)} {USAGE_WORDS.cacheRead}
          </div>
          <div className="v2-muted v2-usage-small">
            {row.turns} {row.turns === 1 ? 'reply' : 'replies'}
            {row.models.length > 0 ? ` · ${row.models.map((m) => m || 'default model').join(', ')}` : ''}
            {row.cost !== null ? ` · ${row.costPartial ? '≥ ' : ''}${money(row.cost, currency)}` : ''}
          </div>
        </div>
        <div className="v2-usage-num">
          <b data-testid="v2-usage-row-tokens">{tokensShort(row.total.tokens)}</b>
          <span data-testid="v2-usage-row-share">{shareText(row.share)}</span>
          {row.estimate ? (
            <span className="v2-usage-est" data-testid="v2-usage-row-estimate" title={USAGE_WORDS.infoEstimate}>
              {estimateText(row.estimate)} <i>({USAGE_WORDS.estimateTag})</i>
            </span>
          ) : null}
        </div>
      </div>
      <svg viewBox="0 0 100 6" preserveAspectRatio="none" className="v2-usage-share" aria-hidden="true">
        <rect x="0" y="0" width="100" height="6" rx="3" className="v2-ins-meter-bg" />
        {row.share > 0 ? <rect x="0" y="0" width={Math.max(1.5, row.share * 100)} height="6" rx="3" className="v2-ins-meter-fill" /> : null}
      </svg>
      <div className="v2-usage-actions">
        {row.sessionId ? (
          <Button size="sm" icon="eye" onClick={() => openAgent(row.sessionId as string)} data-testid="v2-usage-row-open">
            {USAGE_WORDS.open}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" icon="list" onClick={onLog} aria-pressed={active} title={USAGE_WORDS.logFilterHint(row.label)} data-testid="v2-usage-row-log">
          {USAGE_WORDS.logFilter}
        </Button>
        {!grouped ? (
          <Button size="sm" variant="ghost" icon={open ? 'chev-down' : 'chev'} onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="v2-usage-row-agents">
            {open ? USAGE_WORDS.hideAgents : USAGE_WORDS.showAgents}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="v2-usage-agents" data-testid="v2-usage-agents">
          <div>
            {USAGE_WORDS.ownLine}: <b>{tokensShort(row.total.tokens - row.agents.tokens)}</b>
          </div>
          {hasAgents ? (
            <>
              <div>
                {USAGE_WORDS.agentsLine}: <b>{tokensShort(row.agents.tokens)}</b> · {tokensShort(row.agents.cacheRead)} {USAGE_WORDS.cacheRead}
              </div>
              <ul>
                {row.agentModels.map((m) => (
                  <li key={m.model}>
                    {m.model || 'default model'}: {tokensShort(m.tokens)} · {tokensShort(m.cacheRead)} {USAGE_WORDS.cacheRead}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="v2-muted">{USAGE_WORDS.agentsNone}</div>
          )}
        </div>
      ) : null}
    </li>
  );
}

function UsageLog({
  answer,
  filters,
  groupLabel,
  many,
  machineName,
  now,
  set,
}: {
  readonly answer: UsageAnswer;
  readonly filters: UsageFilters;
  readonly groupLabel: string | null;
  readonly many: boolean;
  readonly machineName: (m: { readonly id: string | null; readonly name: string }) => string;
  readonly now: Date;
  readonly set: (next: Partial<UsageFilters>) => void;
}) {
  const { page, pages } = logPages(answer.log);
  const openAgent = useOpenAgent();
  return (
    <Card pad className="v2-usage-card" data-testid="v2-usage-log">
      <div className="v2-usage-card-h">
        <h3>{USAGE_WORDS.logTitle}</h3>
        <span className="v2-muted v2-usage-small v2-grow">
          {USAGE_WORDS.logSub} {groupLabel ? USAGE_WORDS.logFiltered(groupLabel) : ''}
        </span>
        {groupLabel ? (
          <Button size="sm" variant="ghost" onClick={() => set({ group: null })} data-testid="v2-usage-log-all">
            {USAGE_WORDS.logAll}
          </Button>
        ) : null}
        {answer.log.total > 0 ? (
          <a className="v2-btn" data-size="sm" data-variant="ghost" href={usageCsvHref(filters, now)} download data-testid="v2-usage-csv">
            <Icon name="download" size="s" />
            {USAGE_WORDS.csv}
          </a>
        ) : null}
      </div>
      {answer.log.rows.length === 0 ? <p className="v2-muted">{USAGE_WORDS.logEmpty}</p> : null}
      <ul className="v2-usage-log">
        {answer.log.rows.map((row) => (
          <li key={row.id} className="v2-usage-log-row" data-testid="v2-usage-log-row">
            <span className="v2-usage-log-time">{logTime(row.at, now)}</span>
            {isBackgroundSession(row.sessionId) ? (
              // Project memory (D107) hook, D136: a memory check has no agent to open.
              <span className="v2-usage-log-title">{row.title}</span>
            ) : (
              <button type="button" className="v2-usage-log-title" onClick={() => openAgent(row.sessionId)} title={USAGE_WORDS.open}>
                {row.title}
              </button>
            )}
            <span className="v2-muted v2-usage-log-model">{row.models.map((m) => m || 'default model').join(' + ')}</span>
            <span className="v2-usage-log-tokens">
              <b>{tokensShort(row.total.tokens)}</b>
              <span className="v2-muted"> · {tokensShort(row.total.cacheRead)} cached</span>
            </span>
            <span className="v2-muted v2-usage-log-account">
              {row.accountName}
              {many ? ` · ${machineName(row.machine)}` : ''}
            </span>
          </li>
        ))}
      </ul>
      {pages > 1 ? (
        <div className="v2-usage-pager" data-testid="v2-usage-pager">
          <Button size="sm" disabled={page <= 1} onClick={() => set({ group: filters.group, page: answer.log.page - 1 })} data-testid="v2-usage-prev">
            {USAGE_WORDS.prev}
          </Button>
          <span className="v2-muted" data-testid="v2-usage-page">
            {USAGE_WORDS.page(page, pages)}
          </span>
          <Button size="sm" disabled={page >= pages} onClick={() => set({ group: filters.group, page: answer.log.page + 1 })} data-testid="v2-usage-next">
            {USAGE_WORDS.next}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
