import { type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReportedTable, SessionActivity, SessionDetail } from '../../../core/api.ts';
import { OverviewActivityText } from '../../activity/ActivityViews.tsx';
import { useTick } from '../../activity/useActivity.ts';
import { Link, useRouter } from '../../router.tsx';
import { statusColor } from '../../shell/format.ts';
import { hasSubagentChat } from './chat.ts';
import { ChatMarkdown } from './ChatMarkdown.tsx';
import {
  OVERVIEW_COLUMNS,
  OVERVIEW_LABEL,
  type OverviewRow,
  PRINTED_POPOVER_LABEL,
  PRINTED_TOGGLE,
  UNREADABLE_TABLE,
  type ReportedColumn,
  type ReportedRow,
  type ReportedTableView as ReportedView,
  overviewRows,
  printedPopoverPlace,
  reportedHeading,
  reportedTableView,
} from './agent-overview.ts';
import { isFinishedSubagent } from './right-panel.ts';
import { OPEN_SUBAGENT_CHAT } from './subagent-chat.ts';
import './agent-overview.css';

/** The printed table's age refreshes as often as the sidebar's ages. */
const AGE_TICK_MS = 30_000;

/**
 * The right panel's agent overview (D21, `docs/session-panel.md` → *Agent
 * overview*), the panel's first section: the derived table (Agent · Description
 * · Solution · Status, one row per agent, from `SessionDetail.agents`; an active
 * agent's Status is its live D19 action and time) and, when the agent printed a
 * status table, the newest one under "As reported by the agent · <age>"
 * (`SessionDetail.reportedTable`). D27: that table is drawn like the derived one
 * (every printed column, the Status with its status dot and color), and an "as
 * printed" toggle shows the original text in a popover over the main area (a
 * box-drawing table as a chat code block, a pipe table through the chat's
 * Markdown renderer, D20); a table that cannot be parsed shows as printed,
 * wrapped. Nothing in the panel scrolls sideways. D36: a subagent's row opens its
 * chat (the whole row, and its name as a keyboard-focusable link). D37: finished
 * subagents have no row (they are simply gone; the cards below keep a "✓ N
 * finished" line).
 */
export function AgentOverview({ session, activity }: { readonly session: SessionDetail; readonly activity: SessionActivity | null }) {
  const shown = session.agents.filter((agent) => !isFinishedSubagent(agent));
  const rows = overviewRows(shown, session);
  const chats = new Set(shown.filter(hasSubagentChat).map((agent) => agent.id));
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
            <OverviewRowView key={row.id} sessionId={session.id} row={row} activity={activity} opensChat={chats.has(row.id)} />
          ))}
        </tbody>
      </table>
      {session.reportedTable ? <ReportedTableView key={session.id} table={session.reportedTable} /> : null}
    </section>
  );
}

function OverviewRowView({
  sessionId,
  row,
  activity,
  opensChat,
}: {
  readonly sessionId: string;
  readonly row: OverviewRow;
  readonly activity: SessionActivity | null;
  /** D36: a subagent with a chat to open (the row links to it). */
  readonly opensChat: boolean;
}) {
  const { navigate } = useRouter();
  const entry = activity?.agents[row.id] ?? null;
  const chat = { view: 'session', id: sessionId, tab: 'chat', agentId: row.id } as const;
  return (
    <tr
      data-testid="overview-row"
      data-agent-id={row.id}
      data-status={row.status}
      data-opens-chat={opensChat ? 'true' : undefined}
      onClick={
        opensChat
          ? (event) => {
              // The name's link handles its own clicks; a click elsewhere on the row opens the chat too.
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              navigate(chat);
            }
          : undefined
      }
    >
      <td className="sb-overview-agent" data-testid="overview-agent" title={row.name}>
        {opensChat ? (
          <Link to={chat} className="sb-overview-open" data-testid="overview-open" title={OPEN_SUBAGENT_CHAT}>
            {row.name}
          </Link>
        ) : (
          row.name
        )}
      </td>
      <td className="sb-overview-desc" data-testid="overview-description" title={row.description || undefined}>
        {row.description}
      </td>
      <td className="sb-overview-solution" data-testid="overview-solution" title={row.solutionPath ?? undefined}>
        {row.solution}
      </td>
      {/* D30: an agent waiting on background work reads as working (the running color). */}
      <td
        className="sb-overview-status"
        data-testid="overview-status"
        style={{ color: statusColor(entry?.state === 'background' ? 'run' : row.status) }}
        title={entry ? undefined : row.statusText}
      >
        {entry ? (
          <OverviewActivityText entry={entry} turnStartedAt={row.main && activity ? activity.turnStartedAt : null} background={activity?.background ?? []} />
        ) : (
          row.statusText
        )}
      </td>
    </tr>
  );
}

/**
 * The newest status table the agent printed, with its age (D27): drawn as a table
 * when it parses, else a one-line note (developer ruling 2026-09-28; nothing in
 * the panel scrolls sideways). Either way the "as printed" toggle opens the
 * original, unwrapped, in a popover over the main area.
 */
function ReportedTableView({ table }: { readonly table: ReportedTable }) {
  const now = useTick(AGE_TICK_MS);
  const view = useMemo(() => reportedTableView(table), [table]);
  const [printed, setPrinted] = useState(false);
  const popoverId = useId();
  const section = useRef<HTMLDivElement | null>(null);
  const toggle = useRef<HTMLButtonElement | null>(null);
  return (
    <div ref={section} className="sb-overview-reported" data-testid="overview-reported" data-format={table.format} data-parsed={view ? 'true' : 'false'}>
      <div className="sb-overview-reported-bar">
        <div className="sb-overview-reported-head" data-testid="overview-reported-head" title={new Date(table.at).toLocaleString()}>
          {reportedHeading(table.at, now)}
        </div>
        <button
          ref={toggle}
          type="button"
          className="sb-button sb-overview-printed-toggle"
          data-testid="overview-printed-toggle"
          aria-expanded={printed}
          aria-controls={printed ? popoverId : undefined}
          onClick={() => setPrinted((open) => !open)}
        >
          {PRINTED_TOGGLE}
        </button>
      </div>
      {view ? (
        <ReportedTableGrid view={view} />
      ) : (
        <div className="sb-overview-unreadable" data-testid="overview-unreadable">
          {UNREADABLE_TABLE}
        </div>
      )}
      {printed ? <PrintedPopover id={popoverId} table={table} anchor={section} toggle={toggle} onClose={() => setPrinted(false)} /> : null}
    </div>
  );
}

/** The reported table drawn like the derived table (D27): same classes, every printed column. */
function ReportedTableGrid({ view }: { readonly view: ReportedView }) {
  return (
    <table className="sb-overview-table sb-overview-reported-table" data-testid="overview-reported-table">
      <colgroup>
        {view.columns.map((column, index) => (
          <col key={index} style={{ width: column.width }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {view.columns.map((column, index) => (
            <th key={index} data-testid="overview-reported-column" title={column.name || undefined}>
              {column.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {view.rows.map((row, index) => (
          <ReportedRowView key={index} row={row} columns={view.columns} />
        ))}
      </tbody>
    </table>
  );
}

const CELL_CLASS: Readonly<Record<ReportedColumn['kind'], string>> = {
  agent: 'sb-overview-agent',
  status: 'sb-overview-status sb-overview-reported-status',
  text: 'sb-overview-desc',
};

function ReportedRowView({ row, columns }: { readonly row: ReportedRow; readonly columns: readonly ReportedColumn[] }) {
  return (
    <tr data-testid="overview-reported-row" data-status={row.status}>
      {row.cells.map((cell, index) => {
        const kind = columns[index]?.kind ?? 'text';
        const title = cell.text || undefined;
        if (kind === 'status' && cell.status) {
          return (
            <td
              key={index}
              className={CELL_CLASS.status}
              data-testid="overview-reported-cell"
              data-kind={kind}
              data-status={cell.status}
              style={{ color: statusColor(cell.status) }}
              title={title}
            >
              <span className="sb-overview-dot" data-testid="overview-reported-dot" aria-hidden="true" />
              {cell.text}
            </td>
          );
        }
        return (
          <td key={index} className={CELL_CLASS[kind]} data-testid="overview-reported-cell" data-kind={kind} title={title}>
            {cell.text}
          </td>
        );
      })}
    </tr>
  );
}

/** The table as printed (D21): a box table as the chat's code block, a pipe table through the chat's Markdown renderer. */
function PrintedText({ table }: { readonly table: ReportedTable }) {
  return table.format === 'box' ? (
    <div className="sb-md">
      <pre>
        <code>{table.text}</code>
      </pre>
    </div>
  ) : (
    <ChatMarkdown text={table.text} />
  );
}

/**
 * The "as printed" popover (D27): the original table, unwrapped, over the main
 * area to the left of the right panel ({@link printedPopoverPlace}), scrolling
 * inside itself when it is still too wide or tall. Rendered into `document.body`
 * so it never widens the panel. The toggle again, ✕, Esc or a click outside it
 * closes it.
 */
function PrintedPopover({
  id,
  table,
  anchor,
  toggle,
  onClose,
}: {
  readonly id: string;
  readonly table: ReportedTable;
  readonly anchor: RefObject<HTMLDivElement | null>;
  readonly toggle: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const place = (): void => {
      const el = box.current;
      const at = anchor.current;
      if (!el || !at) return;
      const panel = at.closest('.sb-sv-panel') ?? at;
      const viewport = { viewportWidth: document.documentElement.clientWidth, viewportHeight: document.documentElement.clientHeight };
      const first = printedPopoverPlace({ anchorTop: at.getBoundingClientRect().top, panelLeft: panel.getBoundingClientRect().left, ...viewport, height: 0 });
      el.style.right = `${first.right}px`;
      el.style.maxWidth = `${first.maxWidth}px`;
      el.style.maxHeight = `${first.maxHeight}px`;
      const placed = printedPopoverPlace({ anchorTop: at.getBoundingClientRect().top, panelLeft: panel.getBoundingClientRect().left, ...viewport, height: el.offsetHeight });
      el.style.top = `${placed.top}px`;
      el.style.visibility = 'visible';
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, table.text, table.format]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close.current();
    };
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      // The toggle handles its own clicks.
      if (target && !box.current?.contains(target) && !toggle.current?.contains(target)) close.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [toggle]);

  return createPortal(
    <div ref={box} id={id} className="sb-overview-pop" role="dialog" aria-label={PRINTED_POPOVER_LABEL} data-testid="overview-printed-popover" data-format={table.format}>
      <div className="sb-overview-pop-head">
        <span className="sb-overview-pop-label">{PRINTED_POPOVER_LABEL}</span>
        <button type="button" className="sb-button sb-overview-pop-close" data-testid="overview-printed-close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="sb-overview-pop-body sb-overview-printed">
        <PrintedText table={table} />
      </div>
    </div>,
    document.body,
  );
}
