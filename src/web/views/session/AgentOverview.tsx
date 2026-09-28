import type { ReportedTable, SessionActivity, SessionDetail } from '../../../core/api.ts';
import { OverviewActivityText } from '../../activity/ActivityViews.tsx';
import { useTick } from '../../activity/useActivity.ts';
import { statusColor } from '../../shell/format.ts';
import { ChatMarkdown } from './ChatMarkdown.tsx';
import { OVERVIEW_COLUMNS, OVERVIEW_LABEL, type OverviewRow, overviewRows, reportedHeading } from './agent-overview.ts';
import './agent-overview.css';

/** The printed table's age refreshes as often as the sidebar's ages. */
const AGE_TICK_MS = 30_000;

/**
 * The right panel's agent overview (D21, `docs/session-panel.md` → *Agent
 * overview*), the panel's first section: the derived table (Agent · Description
 * · Solution · Status, one row per agent, from `SessionDetail.agents`; an active
 * agent's Status is its live D19 action and time) and, when the agent printed a
 * status table, the newest one as printed under "As reported by the agent · <age>"
 * (`SessionDetail.reportedTable`): a box-drawing table as a chat code block, a
 * pipe table through the chat's Markdown renderer (D20).
 */
export function AgentOverview({ session, activity }: { readonly session: SessionDetail; readonly activity: SessionActivity | null }) {
  const rows = overviewRows(session.agents, session);
  return (
    <section className="sb-overview" data-testid="agent-overview">
      <div className="sb-sv-panel-label sb-overview-label">{OVERVIEW_LABEL}</div>
      <table className="sb-overview-table" data-testid="overview-table">
        <colgroup>
          <col className="sb-overview-col-agent" />
          <col className="sb-overview-col-desc" />
          <col className="sb-overview-col-solution" />
          <col className="sb-overview-col-status" />
        </colgroup>
        <thead>
          <tr>
            {OVERVIEW_COLUMNS.map((column) => (
              <th key={column} data-testid="overview-column">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <OverviewRowView key={row.id} row={row} activity={activity} />
          ))}
        </tbody>
      </table>
      {session.reportedTable ? <ReportedTableView table={session.reportedTable} /> : null}
    </section>
  );
}

function OverviewRowView({ row, activity }: { readonly row: OverviewRow; readonly activity: SessionActivity | null }) {
  const entry = activity?.agents[row.id] ?? null;
  return (
    <tr data-testid="overview-row" data-agent-id={row.id} data-status={row.status}>
      <td className="sb-overview-agent" data-testid="overview-agent" title={row.name}>
        {row.name}
      </td>
      <td className="sb-overview-desc" data-testid="overview-description" title={row.description || undefined}>
        {row.description}
      </td>
      <td className="sb-overview-solution" data-testid="overview-solution" title={row.solutionPath ?? undefined}>
        {row.solution}
      </td>
      <td className="sb-overview-status" data-testid="overview-status" style={{ color: statusColor(row.status) }} title={entry ? undefined : row.statusText}>
        {entry ? <OverviewActivityText entry={entry} turnStartedAt={row.main && activity ? activity.turnStartedAt : null} /> : row.statusText}
      </td>
    </tr>
  );
}

/** The newest status table the agent printed, as printed, with its age. */
function ReportedTableView({ table }: { readonly table: ReportedTable }) {
  const now = useTick(AGE_TICK_MS);
  return (
    <div className="sb-overview-reported" data-testid="overview-reported" data-format={table.format}>
      <div className="sb-overview-reported-head" data-testid="overview-reported-head" title={new Date(table.at).toLocaleString()}>
        {reportedHeading(table.at, now)}
      </div>
      {table.format === 'box' ? (
        <div className="sb-md sb-overview-printed" data-testid="overview-printed">
          <pre>
            <code>{table.text}</code>
          </pre>
        </div>
      ) : (
        <div className="sb-overview-printed" data-testid="overview-printed">
          <ChatMarkdown text={table.text} />
        </div>
      )}
    </div>
  );
}
