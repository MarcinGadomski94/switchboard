import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ACCURACY_BUCKETS, INSIGHTS_PERIODS, type AccuracyDistribution, type InsightsAnswer, type PeriodCostRow, type TimeTokensRow, type TrendPoint } from '../../../core/insights.ts';
import { machinesNotice, useInsights } from './useInsights.ts';
import { CLI_LABELS, type CliProviderId } from '../../../core/cli-providers.ts';
import type { MachinesView } from '../../../core/peers.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { Link, useRouter } from '../../router.tsx';
import {
  PERIOD_LABELS,
  type PageFilters,
  WINDOW_LABELS,
  apiQuery,
  costText,
  dayText,
  durationText,
  filtersFromSearch,
  forecastText,
  insightsPath,
  paceText,
  percentText,
  ratioText,
  suggestionPath,
  tokensText,
  trendGeometry,
} from './insights-view.ts';
import { UsageSection } from './UsageSection.tsx';
import './insights.css';

/**
 * D108 · the Insights page (`/insights`, `docs/insights.md` → *The page*): one row of
 * filters (period, folder, CLI, model, account and, with paired machines, the machine), then
 * six sections from one `GET /api/insights` answer. Charts are inline SVG / HTML (no chart
 * library), every number is also in a table or a label (tooltips never gate a value), the
 * colours are the design tokens plus one series blue (`--ins-series`).
 */
export function InsightsView() {
  const { search, navigate } = useRouter();
  const filters = useMemo(() => filtersFromSearch(search, new Date()), [search]);
  const query = apiQuery(filters);
  const state = useInsights(query, filters.machine);
  const machines = useApi<MachinesView | null>(() => api.machines().catch(() => null), []);
  const answer = state.data;
  const notice = answer ? machinesNotice(answer.machines) : null;
  const set = (patch: Partial<PageFilters>): void => navigate(insightsPath({ ...filters, ...patch }), { replace: true });

  return (
    <section className="sb-view sb-insights" data-view="insights" data-testid="view-insights" aria-busy={state.loading || undefined}>
      <header className="sb-ins-head">
        <div className="sb-ins-title-row">
          <h1 className="sb-ins-title">Insights</h1>
          {notice ? (
            <span className="sb-ins-note" role="status" data-testid="insights-machines">
              {notice}
            </span>
          ) : null}
          {answer && !answer.backfill.done ? (
            <span className="sb-ins-note" role="status" data-testid="insights-backfill">
              Counting older history… {answer.backfill.percent}%
            </span>
          ) : null}
          <button type="button" className="sb-button sb-ins-action sb-ins-refresh" data-testid="insights-refresh" onClick={state.reload}>
            Refresh
          </button>
        </div>
        <div className="sb-ins-filters" role="group" aria-label="Filters" data-testid="insights-filters" data-tour="insights-filters">
          <Select label="Period" testId="filter-period" value={filters.period} onChange={(value) => set({ period: value as PageFilters['period'] })} options={INSIGHTS_PERIODS.map((p) => [p, PERIOD_LABELS[p]])} />
          {filters.period === 'custom' ? (
            <>
              <label className="sb-ins-filter">
                <span>From</span>
                <input type="date" data-testid="filter-from" value={filters.from} max={filters.to} onChange={(event) => event.target.value && set({ from: event.target.value })} />
              </label>
              <label className="sb-ins-filter">
                <span>To</span>
                <input type="date" data-testid="filter-to" value={filters.to} min={filters.from} onChange={(event) => event.target.value && set({ to: event.target.value })} />
              </label>
            </>
          ) : null}
          <Select
            label="Folder"
            testId="filter-folder"
            value={filters.folder === null ? 'all' : filters.folder === '' ? 'none' : filters.folder}
            onChange={(value) => set({ folder: value === 'all' ? null : value === 'none' ? '' : value })}
            options={[['all', 'All folders'], ...withCurrent(answer?.options.folders ?? [], filters.folder).map((f): [string, string] => (f === '' ? ['none', 'No folder'] : [f, answer?.options.folderLabels[f] ?? folderName(f)]))]}
          />
          <Select
            label="CLI"
            testId="filter-cli"
            value={filters.cli ?? 'all'}
            onChange={(value) => set({ cli: value === 'all' ? null : value })}
            options={[['all', 'All CLIs'], ...withCurrent(answer?.options.clis ?? [], filters.cli).map((c): [string, string] => [c, CLI_LABELS[c as CliProviderId] ?? c])]}
          />
          <Select
            label="Model"
            testId="filter-model"
            value={filters.model === null ? 'all' : filters.model === '' ? 'none' : filters.model}
            onChange={(value) => set({ model: value === 'all' ? null : value === 'none' ? '' : value })}
            options={[['all', 'All models'], ...withCurrent(answer?.options.models ?? [], filters.model).map((m): [string, string] => (m === '' ? ['none', 'Default model'] : [m, m]))]}
          />
          <Select
            label="Account"
            testId="filter-account"
            value={filters.account ?? 'all'}
            onChange={(value) => set({ account: value === 'all' ? null : value })}
            options={[['all', 'All accounts'], ...(answer?.options.accounts ?? []).map((a): [string, string] => [a.id, a.name]), ...(filters.account && !answer?.options.accounts.some((a) => a.id === filters.account) ? [[filters.account, filters.account] as [string, string]] : [])]}
          />
          {(machines.data?.machines.length ?? 0) > 0 || filters.machine ? (
            <Select
              label="Machine"
              testId="filter-machine"
              value={filters.machine ?? 'all'}
              onChange={(value) => set({ machine: value === 'all' ? null : value, folder: null, account: null })}
              options={[['all', 'All machines'], ['local', `This machine${machines.data?.self.name ? ` (${machines.data.self.name})` : ''}`], ...(machines.data?.machines ?? []).map((m): [string, string] => [m.id, m.state === 'online' ? m.name : `${m.name} (offline)`])]}
            />
          ) : null}
        </div>
      </header>
      <div className="sb-ins-body" data-testid="insights-body">
        {state.error && !answer ? (
          <p className="sb-ins-empty" role="alert" data-testid="insights-error">
            Insights could not be loaded: {state.error.message}
          </p>
        ) : null}
        {!answer && !state.error ? <p className="sb-ins-empty">Loading…</p> : null}
        {answer ? <Sections answer={answer} onOpen={(path) => navigate(path)} /> : null}
        {/* D134: where each account's usage window went (the v2 Usage view's breakdown, as a section). */}
        <UsageSection machine={filters.machine} scrollTo={new URLSearchParams(search).get('view') === 'usage'} />
      </div>
    </section>
  );
}

function withCurrent(values: readonly string[], current: string | null): readonly string[] {
  return current === null || values.includes(current) ? values : [...values, current];
}

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
}

function Select({ label, value, options, onChange, testId }: { readonly label: string; readonly value: string; readonly options: ReadonlyArray<readonly [string, string]>; readonly onChange: (value: string) => void; readonly testId: string }) {
  return (
    <label className="sb-ins-filter">
      <span>{label}</span>
      <select data-testid={testId} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function Section({ id, title, what, children }: { readonly id: string; readonly title: string; readonly what: string; readonly children: ReactNode }) {
  return (
    <section className="sb-ins-section" aria-labelledby={`ins-${id}`} data-testid={`insights-${id}`}>
      <h2 className="sb-ins-h2" id={`ins-${id}`}>
        {title}
      </h2>
      <p className="sb-ins-what">{what}</p>
      {children}
    </section>
  );
}

function Tile({ label, value, testId }: { readonly label: string; readonly value: string; readonly testId?: string }) {
  return (
    <div className="sb-ins-tile" data-testid={testId}>
      <div className="sb-ins-tile-value">{value}</div>
      <div className="sb-ins-tile-label">{label}</div>
    </div>
  );
}

function Sections({ answer, onOpen }: { readonly answer: InsightsAnswer; readonly onOpen: (path: string) => void }) {
  const open = (event: MouseEvent<HTMLAnchorElement>, path: string): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(path);
  };
  const { time, estimates, outcomes, cost, forecast, suggestions } = answer;
  return (
    <>
      <Section id="time" title="Time and tokens" what="Turns that ended in the period (sessions only; chats are counted apart). Time is the CLI's own turn time; tokens are input + cache writes + output (cache reads left out).">
        <div className="sb-ins-tiles">
          <Tile label="turns" value={String(time.totals.turns)} testId="tile-turns" />
          <Tile label="tokens" value={tokensText(time.totals.tokens)} testId="tile-tokens" />
          <Tile label="agent time" value={durationText(time.totals.durationMs)} testId="tile-time" />
          <Tile label="tokens / turn" value={time.totals.tokensPerTurn === null ? '—' : tokensText(time.totals.tokensPerTurn)} testId="tile-tpt" />
          <Tile label="sessions" value={String(time.totals.sessions)} />
        </div>
        <TrendChart trend={time.trend} />
        <div className="sb-ins-grid">
          <BarTable title="By folder" rows={time.byFolder} testId="by-folder" />
          <BarTable title="By model" rows={time.byModel} testId="by-model" />
          <BarTable title="By session (top 20)" rows={time.bySession} testId="by-session" />
        </div>
        {time.chats.turns > 0 ? (
          <p className="sb-ins-foot" data-testid="insights-chats">
            Chats (not counted above): {time.chats.turns} turns · {tokensText(time.chats.tokens)} tokens · {durationText(time.chats.durationMs)}
          </p>
        ) : null}
      </Section>

      <Section id="estimates" title="Estimate accuracy" what="Completed todos with an estimate: the time they really took ÷ the estimate (1× = on the estimate; above 1× took longer).">
        {estimates.count === 0 ? (
          <p className="sb-ins-empty">No completed todo with an estimate in this period.</p>
        ) : (
          <div className="sb-ins-grid sb-ins-grid-2">
            <Histogram title={`All · ${estimates.count} todos · median ${ratioText(estimates.median)}`} dist={estimates} testId="accuracy-all" />
            <div className="sb-ins-card">
              <h3 className="sb-ins-h3">By model and folder</h3>
              <table className="sb-ins-table" data-testid="accuracy-groups">
                <thead>
                  <tr>
                    <th scope="col">Group</th>
                    <th scope="col">Todos</th>
                    <th scope="col">Median</th>
                    {ACCURACY_BUCKETS.map((b) => (
                      <th key={b.key} scope="col">
                        {b.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...estimates.byModel.map((g) => ({ ...g, kind: 'model' })), ...estimates.byFolder.map((g) => ({ ...g, kind: 'folder' }))].map((group) => (
                    <tr key={`${group.kind}:${group.key}`}>
                      <th scope="row">
                        <span className="sb-ins-kind">{group.kind}</span> {group.label}
                      </th>
                      <td>{group.count}</td>
                      <td>{ratioText(group.median)}</td>
                      {group.buckets.map((b) => (
                        <td key={b.key}>{b.count}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>

      <Section id="outcomes" title="Outcomes and rework" what="Per model. Reopened: completed todos that went from done back to open or in progress at least once (recorded from 1.20). Plans: items merged ÷ items that ended (merged, failed, blocked); sent back: Merge-step decisions that were Send back. Reverts: turns undone (Revert / Undo last turn, minus Redos) per 100 turns.">
        {outcomes.byModel.length === 0 ? (
          <p className="sb-ins-empty">Nothing recorded in this period.</p>
        ) : (
          <div className="sb-ins-card sb-ins-scroll">
            <table className="sb-ins-table" data-testid="outcomes-table">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Todos done</th>
                  <th scope="col">Reopened</th>
                  {outcomes.plansOn ? (
                    <>
                      <th scope="col">Plans merged</th>
                      <th scope="col">Sent back</th>
                    </>
                  ) : null}
                  <th scope="col">Turns</th>
                  <th scope="col">Reverts / 100 turns</th>
                </tr>
              </thead>
              <tbody>
                {outcomes.byModel.map((row) => (
                  <tr key={row.model}>
                    <th scope="row">{row.label}</th>
                    <td>{row.todos.done}</td>
                    <td>
                      {percentText(row.todos.reopenRate)} <span className="sb-ins-muted">({row.todos.reopened})</span>
                    </td>
                    {outcomes.plansOn ? (
                      <>
                        <td>
                          {percentText(row.plans?.mergeRate ?? null)} <span className="sb-ins-muted">({row.plans?.merged ?? 0} of {(row.plans?.merged ?? 0) + (row.plans?.failed ?? 0) + (row.plans?.blocked ?? 0)})</span>
                        </td>
                        <td>
                          {percentText(row.plans?.sendBackRate ?? null)} <span className="sb-ins-muted">({row.plans?.decisions.sentBack ?? 0})</span>
                        </td>
                      </>
                    ) : null}
                    <td>{row.reverts.turns}</td>
                    <td>{row.reverts.per100Turns === null ? '—' : row.reverts.per100Turns.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!outcomes.plansOn ? <p className="sb-ins-foot">Plans is unavailable (plans.db could not be opened): its merge outcomes are not shown.</p> : null}
          </div>
        )}
      </Section>

      <Section id="cost" title="Cost per todo run" what="Each completed todo's tokens priced per model (input, output, cache writes, cache reads per 1M tokens). A subscription is not billed per token: this is what the work would cost at these prices.">
        <p className={cost.example ? 'sb-ins-banner' : 'sb-ins-foot'} data-testid="cost-prices">
          {cost.example ? 'Example prices — edit in Settings. ' : `Prices in ${cost.currency}, from Settings. `}
          <Link to={{ view: 'settings', section: 'notify' }} data-testid="cost-edit-prices">
            Edit prices
          </Link>
        </p>
        <h3 className="sb-ins-h3">Every turn of the period</h3>
        <div className="sb-ins-tiles">
          <Tile label="all turns (sessions)" value={`${cost.period.lowerBound ? '≥ ' : ''}${costText(cost.period.total, cost.currency)}`} testId="tile-period-cost" />
          {cost.period.chats > 0 ? <Tile label="chats (apart)" value={costText(cost.period.chats, cost.currency)} /> : null}
        </div>
        <div className="sb-ins-grid sb-ins-grid-2">
          <PeriodCostTable title="Period cost by folder" rows={cost.period.byFolder} currency={cost.currency} testId="period-cost-folder" />
          <PeriodCostTable title="Period cost by model" rows={cost.period.byModel} currency={cost.currency} testId="period-cost-model" />
        </div>
        {cost.period.lowerBound ? <p className="sb-ins-foot">≥: turns recorded before 1.20 have only a token total, priced as input (a lower bound).</p> : null}
        {cost.period.unpricedTokens > 0 ? <p className="sb-ins-foot">{tokensText(cost.period.unpricedTokens)} tokens of models without a price row are not in these totals.</p> : null}
        <h3 className="sb-ins-h3">Per todo</h3>
        <div className="sb-ins-tiles">
          <Tile label={`total · ${cost.priced} of ${cost.todos} todos priced`} value={costText(cost.total, cost.currency)} testId="tile-cost-total" />
          <Tile label="average per todo" value={costText(cost.average, cost.currency)} />
          <Tile label="median per todo" value={costText(cost.median, cost.currency)} />
        </div>
        {cost.lowerBound ? <p className="sb-ins-foot">Some todos completed before 1.20 have only a token total: their cost is a lower bound (priced as input).</p> : null}
        {cost.top.length > 0 ? (
          <div className="sb-ins-grid sb-ins-grid-2">
            <div className="sb-ins-card sb-ins-scroll">
              <h3 className="sb-ins-h3">Most expensive runs</h3>
              <table className="sb-ins-table" data-testid="cost-top">
                <thead>
                  <tr>
                    <th scope="col">Todo</th>
                    <th scope="col">Model</th>
                    <th scope="col">Took</th>
                    <th scope="col">Tokens</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {cost.top.map((row) => (
                    <tr key={row.todoId}>
                      <th scope="row" className="sb-ins-wrap">
                        <Link to={{ view: 'session', id: row.runSessionId ?? row.sessionId, tab: 'chat' }}>{row.title}</Link>
                      </th>
                      <td>{row.modelLabel}</td>
                      <td>{durationText(row.actualMs)}</td>
                      <td>{tokensText(row.tokens)}</td>
                      <td>
                        {row.lowerBound ? '≥ ' : ''}
                        {costText(row.cost, cost.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="sb-ins-card">
              <h3 className="sb-ins-h3">By model</h3>
              <table className="sb-ins-table" data-testid="cost-by-model">
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <th scope="col">Todos</th>
                    <th scope="col">Total</th>
                    <th scope="col">Median</th>
                  </tr>
                </thead>
                <tbody>
                  {cost.byModel.map((row) => (
                    <tr key={row.model}>
                      <th scope="row">{row.label}</th>
                      <td>{row.priced === row.todos ? row.todos : `${row.priced} of ${row.todos} priced`}</td>
                      <td>{row.priced > 0 ? costText(row.total, cost.currency) : 'no price'}</td>
                      <td>{costText(row.median, cost.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="sb-ins-empty">No completed todo in this period.</p>
        )}
      </Section>

      <Section id="forecast" title="Usage-limit forecast" what="Claude Code accounts, now: the pace of the newest readings in the current window (the last hour for the 5-hour window, the last 24 hours for the week), extrapolated in a straight line.">
        {forecast.length === 0 ? (
          <p className="sb-ins-empty">No Claude Code account.</p>
        ) : (
          <div className="sb-ins-grid">
            {forecast.map((account) => (
              <div key={account.profileId} className="sb-ins-card" data-testid="forecast-account">
                <h3 className="sb-ins-h3">
                  {account.name}
                  {account.onCredits ? <span className="sb-ins-credits"> € on credits</span> : null}
                </h3>
                {account.windows.map((w) => (
                  <div key={w.window} className="sb-ins-window" data-testid={`forecast-${w.window}`} data-verdict={w.verdict}>
                    <div className="sb-ins-window-head">
                      <span>{WINDOW_LABELS[w.window]}</span>
                      <span className="sb-ins-muted">
                        {w.pct === null ? '—' : `${Math.round(w.pct)}%`} {paceText(w)}
                      </span>
                    </div>
                    <Meter now={w.pct} projected={w.verdict === 'fills' ? 100 : w.verdict === 'holds' ? w.atReset : null} />
                    <p className="sb-ins-window-text">{forecastText(w)}</p>
                  </div>
                ))}
                {account.credits ? <p className="sb-ins-foot">Credits: {account.credits}</p> : null}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section id="suggestions" title="Suggested routing rules" what="Where a cheaper model finished the same kind of todo (priority × estimate) at least as well. Suggestions only: nothing changes until you save a rule in Model by task.">
        {suggestions.length === 0 ? (
          <p className="sb-ins-empty" data-testid="suggestions-empty">
            No suggestion: it needs at least 3 completed, priced todos per model of the same priority and estimate.
          </p>
        ) : (
          <ul className="sb-ins-suggestions">
            {suggestions.map((s) => (
              <li key={s.id} className="sb-ins-card" data-testid="suggestion">
                <p className="sb-ins-suggestion-text">{s.text}</p>
                <p className="sb-ins-muted sb-ins-evidence">
                  Median cost {costText(s.evidence.cheap.medianCost, s.evidence.currency)} vs {costText(s.evidence.expensive.medianCost, s.evidence.currency)} per todo.
                </p>
                <a className="sb-button sb-ins-action" href={suggestionPath(s)} data-testid="suggestion-open" onClick={(event) => open(event, suggestionPath(s))}>
                  Open in Model by task…
                </a>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function PeriodCostTable({ title, rows, currency, testId }: { readonly title: string; readonly rows: readonly PeriodCostRow[]; readonly currency: string; readonly testId: string }) {
  return (
    <div className="sb-ins-card" data-testid={testId}>
      <h3 className="sb-ins-h3">{title}</h3>
      {rows.length === 0 ? (
        <p className="sb-ins-empty">No turns.</p>
      ) : (
        <table className="sb-ins-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className="sb-ins-wrap" title={row.key}>
                  {row.label}
                </th>
                <td>{row.cost === null ? 'no price' : `${row.lowerBound ? '≥ ' : ''}${costText(row.cost, currency)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function BarTable({ title, rows, testId }: { readonly title: string; readonly rows: readonly TimeTokensRow[]; readonly testId: string }) {
  const max = Math.max(1, ...rows.map((row) => row.tokens));
  return (
    <div className="sb-ins-card" data-testid={testId}>
      <h3 className="sb-ins-h3">{title}</h3>
      {rows.length === 0 ? (
        <p className="sb-ins-empty">No turns.</p>
      ) : (
        <table className="sb-ins-table sb-ins-bars">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Tokens</th>
              <th scope="col">Turns</th>
              <th scope="col">Time</th>
              <th scope="col">/ turn</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className="sb-ins-wrap" title={row.key}>
                  {row.label}
                  <span className="sb-ins-bar" aria-hidden="true">
                    <span style={{ width: `${(row.tokens / max) * 100}%` }} />
                  </span>
                </th>
                <td>{tokensText(row.tokens)}</td>
                <td>{row.turns}</td>
                <td>{durationText(row.durationMs)}</td>
                <td>{row.tokensPerTurn === null ? '—' : tokensText(row.tokensPerTurn)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** The tokens-per-turn line (one series), with a crosshair tooltip and a table for every value. */
function TrendChart({ trend }: { readonly trend: readonly TrendPoint[] }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(Math.max(160, element.clientWidth - 28 - 56 - 16)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const height = 140;
  const geometry = trendGeometry(trend, width, height);
  const hovered = hover === null ? null : geometry.days[hover];
  const pick = (clientX: number, rect: DOMRect): void => {
    const x = clientX - rect.left - 44;
    let best = 0;
    geometry.days.forEach((day, i) => {
      if (Math.abs(day.x - x) < Math.abs((geometry.days[best]?.x ?? 0) - x)) best = i;
    });
    setHover(best);
  };
  const labelEvery = Math.max(1, Math.ceil(trend.length / Math.max(2, Math.floor(width / 70))));
  return (
    <div className="sb-ins-card sb-ins-trend" ref={box} data-testid="insights-trend">
      <h3 className="sb-ins-h3">Tokens per turn, by day</h3>
      <svg
        className="sb-ins-svg"
        width={width + 56}
        height={height + 34}
        role="img"
        aria-label="Tokens per turn by day (the values are in the table below)"
        tabIndex={0}
        onPointerMove={(event) => pick(event.clientX, event.currentTarget.getBoundingClientRect())}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover(trend.length - 1)}
        onBlur={() => setHover(null)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? trend.length - 1) - 1));
          if (event.key === 'ArrowRight') setHover((h) => Math.min(trend.length - 1, (h ?? 0) + 1));
        }}
      >
        <g transform="translate(44 8)">
          {geometry.ticks.map((tick) => (
            <g key={tick.label}>
              <line x1={0} x2={width} y1={tick.y} y2={tick.y} className="sb-ins-grid-line" />
              <text x={-6} y={tick.y + 3} textAnchor="end" className="sb-ins-axis">
                {tick.label}
              </text>
            </g>
          ))}
          {geometry.days.map((day, i) =>
            i % labelEvery === 0 || i === trend.length - 1 ? (
              <text key={day.point.day} x={day.x} y={height + 18} textAnchor={i === 0 ? 'start' : i === trend.length - 1 ? 'end' : 'middle'} className="sb-ins-axis">
                {dayText(day.point.day)}
              </text>
            ) : null,
          )}
          {geometry.segments.map((d) => (
            <path key={d} d={d} className="sb-ins-line" />
          ))}
          {geometry.points.map((p) => (
            <circle key={p.point.day} cx={p.x} cy={p.y} r={geometry.points.length > 40 ? 2 : 4} className="sb-ins-dot" />
          ))}
          {hovered ? <line x1={hovered.x} x2={hovered.x} y1={0} y2={height} className="sb-ins-crosshair" /> : null}
        </g>
      </svg>
      {hovered ? (
        <div className="sb-ins-tooltip" role="status" style={{ left: `${Math.min(Math.max(hovered.x + 44, 60), width - 40)}px` }} data-testid="trend-tooltip">
          <strong>{hovered.point.tokensPerTurn === null ? 'no turns' : `${tokensText(hovered.point.tokensPerTurn)} / turn`}</strong>
          <span>
            {dayText(hovered.point.day)} · {hovered.point.turns} turns · {tokensText(hovered.point.tokens)} tokens
          </span>
        </div>
      ) : null}
      <details className="sb-ins-details">
        <summary>Table</summary>
        <table className="sb-ins-table" data-testid="trend-table">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Turns</th>
              <th scope="col">Tokens</th>
              <th scope="col">Tokens / turn</th>
            </tr>
          </thead>
          <tbody>
            {trend.map((p) => (
              <tr key={p.day}>
                <th scope="row">{dayText(p.day)}</th>
                <td>{p.turns}</td>
                <td>{tokensText(p.tokens)}</td>
                <td>{p.tokensPerTurn === null ? '—' : tokensText(p.tokensPerTurn)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** The accuracy buckets as four bars, each labelled with its count. */
function Histogram({ title, dist, testId }: { readonly title: string; readonly dist: AccuracyDistribution; readonly testId: string }) {
  const max = Math.max(1, ...dist.buckets.map((b) => b.count));
  return (
    <div className="sb-ins-card" data-testid={testId}>
      <h3 className="sb-ins-h3">{title}</h3>
      <div className="sb-ins-histogram" role="list">
        {dist.buckets.map((bucket) => (
          <div key={bucket.key} className="sb-ins-hbar" role="listitem" data-bucket={bucket.key} title={`${bucket.label}: ${bucket.count} todos`} tabIndex={0}>
            <span className="sb-ins-hcount">{bucket.count}</span>
            <span className="sb-ins-hfill" style={{ height: `${(bucket.count / max) * 100}%` }} aria-hidden="true" />
            <span className="sb-ins-hlabel">{bucket.label}</span>
          </div>
        ))}
      </div>
      <p className="sb-ins-foot">{'< 1× took less than estimated; > 1× took longer.'}</p>
    </div>
  );
}

/** A usage meter: the reading now, and the straight-line projection to the reset (dashed). */
function Meter({ now, projected }: { readonly now: number | null; readonly projected: number | null }) {
  const pct = Math.max(0, Math.min(100, now ?? 0));
  const ahead = projected === null ? 0 : Math.max(0, Math.min(100, projected) - pct);
  return (
    <div className="sb-ins-meter" aria-hidden="true">
      <span className="sb-ins-meter-now" style={{ width: `${pct}%` }} />
      {ahead > 0 ? <span className="sb-ins-meter-ahead" style={{ left: `${pct}%`, width: `${ahead}%` }} /> : null}
    </div>
  );
}
