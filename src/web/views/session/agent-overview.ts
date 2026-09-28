import type { Agent, ReportedTable } from '../../../core/api.ts';
import { type ReportedStatus, parseStatusTable, reportedStatus, statusColumnIndex } from '../../../core/derive/status-table.ts';
import type { SessionStatus } from '../../../core/model.ts';
import { folderName } from '../../folders/folders.ts';
import { UNKNOWN, formatAge } from '../../shell/format.ts';
import { agentDescription, agentStatus } from './right-panel.ts';

/**
 * The right panel's agent overview (D21, `docs/session-panel.md` → *Agent
 * overview*), kept free of React so `tests/web` can check it: the derived table's
 * rows from `Session.agents` and the heading of the printed table the agent
 * reported (`SessionDetail.reportedTable`), and (D27) that table's columns and rows
 * as the overview draws them. The live Status (D19) comes from
 * `overviewActivityLabel` in `src/web/activity/activity.ts`.
 */

/** The section label (mono uppercase through the panel's `sb-sv-panel-label`, like "Agents & solutions"). */
export const OVERVIEW_LABEL = 'Agents overview';

/** The derived table's columns (D21). */
export const OVERVIEW_COLUMNS: readonly string[] = ['Agent', 'Description', 'Solution', 'Status'];

/**
 * The Status cell of an agent that is not active in a running turn and has no
 * status text of its own (D21: `✓ done`, `✕ failed`, `⏸ waiting`); the marks are
 * the chat's step marks, in the SPEC status colors.
 */
export const OVERVIEW_STATUS_WORDS: Readonly<Record<SessionStatus, string>> = {
  need: '⏸ waiting',
  run: '● running',
  done: '✓ done',
  fail: '✕ failed',
  idle: 'idle',
  paused: 'paused',
};

/** One row of the derived table. */
export interface OverviewRow {
  readonly id: string;
  /** `true` for the session's main agent (its thinking reads like the chat line). */
  readonly main: boolean;
  readonly name: string;
  /** Empty when there is none. */
  readonly description: string;
  /** The solution's folder name (`acme-app-front`), or `—` when the agent has not written into one. */
  readonly solution: string;
  /** The workspace-relative solution folder (the Solution cell's tooltip); `null` without one. */
  readonly solutionPath: string | null;
  /** Drives the Status cell's color (`statusColor`). */
  readonly status: SessionStatus;
  /** The Status cell while the agent is not active: its status text, else {@link OVERVIEW_STATUS_WORDS}. */
  readonly statusText: string;
}

/**
 * The derived table (D21): one row per agent in the order they started (the
 * session's agents: the main agent first, then one per Agent / Task call):
 * - Agent: the agent's name;
 * - Description: the agent card's (its own; the main agent's is the first line
 *   of the session's task);
 * - Solution: the folder name of the agent's `solutionPath`, `—` without one;
 * - Status: the agent's status text when set, else `✓ done` / `✕ failed` /
 *   `⏸ waiting` / `● running` / `idle` / `paused`; an agent the pause cut off
 *   reads `paused`, as on its card. While the agent is active, the view shows its
 *   live action instead (D19).
 */
export function overviewRows(
  agents: readonly Agent[],
  session: { readonly status: SessionStatus; readonly task: string },
): OverviewRow[] {
  return agents.map((agent) => {
    const { status, text } = agentStatus(agent, session.status);
    return {
      id: agent.id,
      main: agent.kind === 'main',
      name: agent.name,
      description: agentDescription(agent, session.task),
      solution: agent.solutionPath ? folderName(agent.solutionPath) : UNKNOWN,
      solutionPath: agent.solutionPath,
      status,
      statusText: text ?? OVERVIEW_STATUS_WORDS[status],
    };
  });
}

/** The printed table's heading without its age. */
export const REPORTED_HEADING = 'As reported by the agent';

/** The printed table's heading: `As reported by the agent · 3m` (the sidebar's relative age, `now` under a minute). */
export function reportedHeading(at: string, now: number): string {
  return `${REPORTED_HEADING} · ${formatAge(at, now)}`;
}

/** The text button that shows and hides the reported table as printed (D27). */
export const PRINTED_TOGGLE = 'as printed';

/** The panel's note for a printed table that does not parse (developer ruling 2026-09-28): the original is behind "as printed". */
export const UNREADABLE_TABLE = "The agent printed a table Switchboard can't read · see “as printed”";

/** The "as printed" popover's label (shown uppercase like the panel's labels) and its dialog name (D27). */
export const PRINTED_POPOVER_LABEL = 'As printed by the agent';

/** The gap (px) between the "as printed" popover and the right panel's left edge (D27). */
export const PRINTED_POPOVER_GAP = 8;

/** The popover's least distance (px) from the window's edges (D27). */
export const PRINTED_POPOVER_EDGE = 16;

/** Where the "as printed" popover goes, in viewport pixels (`position: fixed`). */
export interface PrintedPopoverPlace {
  readonly top: number;
  /** From the viewport's right edge. */
  readonly right: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

/**
 * Where the "as printed" popover goes (D27; nothing in the right panel scrolls
 * sideways, so the original is shown outside it): to the left of the right panel,
 * over the main area, its right edge {@link PRINTED_POPOVER_GAP} px left of the
 * panel; it grows leftwards to the printed table's width, at most to
 * {@link PRINTED_POPOVER_EDGE} px from the window's left edge (over the sidebar
 * when the table is wider than the main area), and at most the window's height
 * less that edge at the top and bottom; beyond that it scrolls inside itself. Its
 * top is the reported section's top, moved up as far as needed to stay in the
 * window. `height` is the popover's own height (0 before it is measured).
 */
export function printedPopoverPlace(input: {
  readonly anchorTop: number;
  readonly panelLeft: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly height: number;
}): PrintedPopoverPlace {
  const maxWidth = Math.max(0, input.panelLeft - PRINTED_POPOVER_GAP - PRINTED_POPOVER_EDGE);
  const maxHeight = Math.max(0, input.viewportHeight - 2 * PRINTED_POPOVER_EDGE);
  const height = Math.min(input.height, maxHeight);
  const top = Math.max(PRINTED_POPOVER_EDGE, Math.min(input.anchorTop, input.viewportHeight - PRINTED_POPOVER_EDGE - height));
  return { top, right: input.viewportWidth - input.panelLeft + PRINTED_POPOVER_GAP, maxWidth, maxHeight };
}

/** How a reported column's cells look (D27): the Agent column like the derived table's names, the Status column with its status dot and color, any other muted like its descriptions. */
export type ReportedColumnKind = 'agent' | 'status' | 'text';

/** A column of the reported table as the overview draws it (D27). */
export interface ReportedColumn {
  /** The printed header cell (plain text). */
  readonly name: string;
  readonly kind: ReportedColumnKind;
  /** Its share of the table's width, a CSS percentage (`40%`). */
  readonly width: string;
}

/** A cell of the reported table (D27). */
export interface ReportedCell {
  /** The text shown, cut with … in the cell and whole in its tooltip; a Status cell's without its leading status glyphs. */
  readonly text: string;
  /** The Status cell's color key; `null` in every other column. */
  readonly status: ReportedStatus | null;
}

/** A row of the reported table (D27). */
export interface ReportedRow {
  /** The row's Status color key (`idle` when its Status cell names no status). */
  readonly status: ReportedStatus;
  readonly cells: readonly ReportedCell[];
}

/** The reported table as the overview draws it (D27): every printed column, in order, and the rows. */
export interface ReportedTableView {
  readonly columns: readonly ReportedColumn[];
  readonly rows: readonly ReportedRow[];
}

/**
 * The reported table's width shares by header (D27, matched trimmed and
 * case-insensitively): Description the most (its text is the longest), Status
 * one and a half (its dot and a status word such as `running` or `planning` stay
 * readable); every other column one ({@link REPORTED_DEFAULT_SHARE}).
 */
export const REPORTED_COLUMN_SHARES: Readonly<Record<string, number>> = { description: 2, status: 1.5 };

/** The width share of a reported column without its own entry in {@link REPORTED_COLUMN_SHARES}. */
export const REPORTED_DEFAULT_SHARE = 1;

/**
 * The reported table's column widths (D27), each column's share of the total as a
 * percentage ({@link REPORTED_COLUMN_SHARES}): `Agent · Description · Solution ·
 * Status` → 18.18 / 36.36 / 18.18 / 27.27 %. Every cell cuts its text with … and
 * has the full text as its tooltip, as in the derived table.
 */
export function reportedColumnWidths(header: readonly string[]): string[] {
  const shares = header.map((cell) => REPORTED_COLUMN_SHARES[cell.trim().toLowerCase()] ?? REPORTED_DEFAULT_SHARE);
  const total = shares.reduce((sum, share) => sum + share, 0);
  return shares.map((share) => `${Math.round((share / total) * 10_000) / 100}%`);
}

/**
 * The reported table (D27) as the overview draws it: the printed table parsed into
 * its header and rows (`parseStatusTable`), every column in its printed order; the
 * Agent column (`agent`) in the name's color, the Status column (`status`) with
 * its status color and text (`reportedStatus`: `🟢 running` → run, `running`),
 * every other column muted. `null` when the table cannot be parsed into
 * consistent rows: the overview then shows it as printed (D21).
 */
export function reportedTableView(table: ReportedTable): ReportedTableView | null {
  const parsed = parseStatusTable(table);
  if (!parsed) return null;
  const status = statusColumnIndex(parsed.header);
  const agent = parsed.header.findIndex((cell) => cell.trim().toLowerCase() === 'agent');
  const widths = reportedColumnWidths(parsed.header);
  const columns = parsed.header.map(
    (name, index): ReportedColumn => ({
      name,
      kind: index === status ? 'status' : index === agent ? 'agent' : 'text',
      width: widths[index] ?? '',
    }),
  );
  const rows = parsed.rows.map((cells): ReportedRow => {
    const shown = cells.map((text, index): ReportedCell => (index === status ? reportedStatus(text) : { text, status: null }));
    return { status: shown[status]?.status ?? 'idle', cells: shown };
  });
  return { columns, rows };
}
