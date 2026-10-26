import { useEffect, useRef, useState } from 'react';
import { USAGE_GROUPS, USAGE_KIND_LABELS, USAGE_PERIODS, type UsageAnswer, type UsageGroupBy, type UsagePeriod, usageQueryString } from '../../../core/usage-breakdown.ts';
import { api } from '../../api/client.ts';
import { Link } from '../../router.tsx';
import { tokensText } from './insights-view.ts';

const PERIOD_WORDS: Readonly<Record<UsagePeriod, string>> = { '5h': 'Current 5-hour window', week: 'This week (weekly window)', today: 'Today', '7d': 'Last 7 days' };
const GROUP_WORDS: Readonly<Record<UsageGroupBy, string>> = { session: 'Session', folder: 'Folder', model: 'Model', account: 'Account', kind: 'Kind' };

function share(value: number): string {
  if (value <= 0) return '0%';
  if (value < 0.01) return '<1%';
  return `${Math.round(value * 100)}%`;
}

function money(amount: number | null, currency: string, partial: boolean): string {
  if (amount === null) return '—';
  try {
    return `${partial ? '≥ ' : '~'}${new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: amount < 0.1 ? 4 : 2 }).format(amount)}`;
  } catch {
    return `${partial ? '≥ ' : '~'}${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * D134 · classic Insights → *Where your usage went* (`docs/insights.md` → *Usage breakdown*):
 * the same `GET /api/insights/usage` answer as v2's Usage view, as one section of the classic
 * page: period (each account's own 5-hour / weekly window, today, last 7 days), account and
 * group, the ranked table (tokens, share, cache reads, turns, models, cost, machine, a link to
 * the session) and the honest note. The stacked chart and the paged log are v2's.
 * `?view=usage` (the v2 address, kept by the theme switch) scrolls to it.
 */
export function UsageSection({ machine, scrollTo }: { readonly machine: string | null; readonly scrollTo: boolean }) {
  const [period, setPeriod] = useState<UsagePeriod>('5h');
  const [account, setAccount] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('session');
  const [answer, setAnswer] = useState<UsageAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (scrollTo) box.current?.scrollIntoView({ block: 'start' });
  }, [scrollTo]);
  useEffect(() => {
    let live = true;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const query = usageQueryString({ period, account, groupBy, from: period === 'today' ? midnight.toISOString() : null, group: null, page: 0, pageSize: 1 });
    const remote = machine !== null && machine !== 'local';
    const path = remote ? `${query}&machine=local` : `${query}&machine=${machine === 'local' ? 'local' : 'all'}&peers=wait`;
    api.insightsUsage(path, remote ? machine : null).then(
      (next) => {
        if (!live) return;
        setAnswer(next);
        setError(null);
      },
      (caught: unknown) => {
        if (live) setError(caught instanceof Error ? caught.message : String(caught));
      },
    );
    return () => {
      live = false;
    };
  }, [period, account, groupBy, machine]);
  const rows = answer?.rows.slice(0, 20) ?? [];
  const many = (answer?.machines.included.length ?? 1) > 1;
  return (
    <section ref={box} className="sb-ins-section" aria-labelledby="ins-usage" data-testid="insights-usage" data-tour="insights-usage">
      <h2 className="sb-ins-h2" id="ins-usage">
        Where your usage went
      </h2>
      <p className="sb-ins-what">
        Which sessions used each account&apos;s usage window. Shares are of the tokens Switchboard recorded (input + output + cache writes, subagents and workflow agents included), not of the limit: the provider&apos;s usage % is not computed from tokens (the token cap is not published) and also counts use outside Switchboard. Cache reads are listed apart (the context
        re-read on every call, billed at about a tenth of the input rate). With one account picked, “≈ % of limit” is an estimate: the share × the window&apos;s usage %.
      </p>
      <div className="sb-ins-filters" role="group" aria-label="Usage filters">
        <label className="sb-ins-filter">
          <span>Period</span>
          <select data-testid="usage-period" value={period} onChange={(event) => setPeriod(event.target.value as UsagePeriod)}>
            {USAGE_PERIODS.map((p) => (
              <option key={p} value={p}>
                {PERIOD_WORDS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="sb-ins-filter">
          <span>Account</span>
          <select data-testid="usage-account" value={account ?? 'all'} onChange={(event) => setAccount(event.target.value === 'all' ? null : event.target.value)}>
            <option value="all">All accounts</option>
            {(answer?.accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="sb-ins-filter">
          <span>Group by</span>
          <select data-testid="usage-group" value={groupBy} onChange={(event) => setGroupBy(event.target.value as UsageGroupBy)}>
            {USAGE_GROUPS.map((g) => (
              <option key={g} value={g}>
                {GROUP_WORDS[g]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && !answer ? (
        <p className="sb-ins-empty" role="alert">
          The usage breakdown could not be loaded: {error}
        </p>
      ) : null}
      {answer && answer.unknownWindows.length > 0 ? <p className="sb-ins-foot">No window known yet for {answer.unknownWindows.join(', ')} (no usage reading).</p> : null}
      {answer && rows.length === 0 ? <p className="sb-ins-empty">No tokens recorded in this period yet.</p> : null}
      {rows.length > 0 && answer ? (
        <div className="sb-ins-card">
          <table className="sb-ins-table" data-testid="usage-table">
            <thead>
              <tr>
                <th scope="col">{GROUP_WORDS[groupBy]}</th>
                <th scope="col">Tokens</th>
                <th scope="col">Share</th>
                {answer.estimate.available ? <th scope="col">≈ % of limit (estimate)</th> : null}
                <th scope="col">Cache reads</th>
                <th scope="col">Turns</th>
                <th scope="col">Models</th>
                <th scope="col">Cost</th>
                {many ? <th scope="col">Machine</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} data-testid="usage-row">
                  <th scope="row" className="sb-ins-wrap">
                    {row.sessionId ? <Link to={{ view: 'session', id: row.sessionId, tab: 'chat' }} data-testid="usage-open">{row.label}</Link> : row.label}
                    {row.kind && row.kind !== 'agent' ? <span className="sb-ins-foot"> · {USAGE_KIND_LABELS[row.kind]}</span> : null}
                    {row.agents.tokens > 0 ? <div className="sb-ins-foot">incl. {tokensText(row.agents.tokens)} by subagents / workflow agents</div> : null}
                  </th>
                  <td>{tokensText(row.total.tokens)}</td>
                  <td>{share(row.share)}</td>
                  {answer.estimate.available ? <td>{row.estimate ? `≈ ${Math.round(row.estimate.pct)}%` : '—'}</td> : null}
                  <td>{tokensText(row.total.cacheRead)}</td>
                  <td>{row.turns}</td>
                  <td>{row.models.map((m) => m || 'default model').join(', ')}</td>
                  <td>{money(row.cost, answer.currency, row.costPartial)}</td>
                  {many ? <td>{row.machine?.id === null ? 'This machine' : (row.machine?.name ?? '')}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sb-ins-foot">
            {tokensText(answer.totals.tokens)} tokens in {answer.totals.turns} turns{answer.rows.length > 20 ? ` · top 20 of ${answer.rows.length}` : ''}. The stacked chart and the turn-by-turn usage log are on the v2 Insights page (Usage).
          </p>
        </div>
      ) : null}
    </section>
  );
}
