import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Solution, SolutionGroup } from '../../core/api.ts';
import { ApiError, api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { Link } from '../router.tsx';
import { statusColor } from '../shell/format.ts';
import { SolutionConflictCard } from './SolutionConflictCard.tsx';
import { peekSolutionFocus, useSolutionFocus } from './solution-focus.ts';
import {
  SOLUTION_FILTERS,
  type SolutionFilter,
  allSolutions,
  artifactRows,
  codebaseMemoryToolId,
  filterGroups,
  freshnessLine,
  headerMeta,
  ledgerRows,
  worktreeLabel,
  worktreeLine,
} from './solutions-format.ts';
import './solutions.css';

/** Session updates arrive in bursts (every status change); the list reloads at most this often. */
const RELOAD_DEBOUNCE_MS = 1_000;

/** The message of a failed `GET /api/solutions` (409 without a usable workspace root). */
function errorText(error: ApiError): string {
  const body = error.body as { error?: unknown; message?: unknown } | null;
  if (body?.error === 'workspace-not-configured') return 'No workspace root is configured (SWITCHBOARD_WORKSPACE_ROOT).';
  if (typeof body?.message === 'string') return body.message;
  return error.unreachable ? 'Switchboard is not reachable.' : `The solutions could not be loaded (HTTP ${error.status}).`;
}

function SolutionRow({ solution, selected, onSelect }: { readonly solution: Solution; readonly selected: boolean; readonly onSelect: () => void }) {
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  };
  return (
    <div
      className="sb-sol-row"
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-selected={selected || undefined}
      data-readonly={solution.rule === 'read-only' || undefined}
      data-testid="solution-row"
      data-solution={solution.name}
      onClick={onSelect}
      onKeyDown={onKey}
    >
      <div className="sb-sol-namecell">
        <span className="sb-sol-dot" style={{ background: statusColor(solution.status) }} />
        <div className="sb-sol-names">
          <span className="sb-sol-name">{solution.name}</span>
          {solution.flag ? (
            <span className="sb-sol-flag" data-kind={solution.conflict ? 'warn' : undefined}>
              {solution.flag}
            </span>
          ) : null}
        </div>
      </div>
      <div className="sb-sol-chips">
        {solution.branches.map((branch, index) => (
          <span className="sb-sol-chip" key={`${branch.branch}\u0000${branch.worktree ?? ''}\u0000${branch.sessionId ?? index}`} data-testid="branch-chip">
            <span className="sb-sol-chip-branch">⎇ {branch.branch}</span>
            <span className="sb-sol-chip-wt">{worktreeLabel(branch.worktree)}</span>
            <span className="sb-sol-chip-dot" style={{ background: statusColor(branch.status) }} />
            <span className="sb-sol-chip-who">{branch.owner}</span>
          </span>
        ))}
      </div>
      <span className="sb-sol-phase">{solution.phase}</span>
      <span className="sb-sol-changes">{solution.changes}</span>
    </div>
  );
}

function SolutionDetail({ solution, toolId, onMoved }: { readonly solution: Solution; readonly toolId: string | null; readonly onMoved: () => void }) {
  const fresh = freshnessLine(solution.codebaseMemory);
  return (
    <div className="sb-sol-detail" data-testid="solution-detail" data-solution={solution.name}>
      <div>
        <div className="sb-sol-detail-path" data-testid="solution-path">
          {solution.path}
        </div>
        <div className="sb-sol-detail-name">{solution.name}</div>
      </div>
      <SolutionConflictCard key={solution.path} solution={solution} onMoved={onMoved} />
      <div className="sb-sol-section">
        <div className="sb-sol-label">Branches &amp; worktrees</div>
        {solution.branches.map((branch, index) => (
          <div className="sb-sol-card" key={`${branch.branch}\u0000${branch.worktree ?? ''}\u0000${branch.sessionId ?? index}`} data-testid="branch-card">
            <div className="sb-sol-card-branch">⎇ {branch.branch}</div>
            <div className="sb-sol-card-wt">{worktreeLine(branch.worktree, solution.path)}</div>
            <div className="sb-sol-card-owner">
              <span className="sb-sol-card-dot" style={{ background: statusColor(branch.status) }} />
              <span>{branch.owner}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="sb-sol-section">
        <div className="sb-sol-label">Phase ledger</div>
        {ledgerRows(solution).map((row, index) => (
          <div className="sb-sol-ledger-row" key={`${row.interface}\u0000${index}`} data-testid="ledger-row">
            <span>{row.interface}</span>
            <span style={{ color: row.color }}>{row.phase}</span>
            <span className="sb-sol-ledger-seam">{row.seam}</span>
          </div>
        ))}
      </div>
      <div className="sb-sol-section">
        <div className="sb-sol-label">Artifacts &amp; follow-ups</div>
        {artifactRows(solution.artifacts).map((artifact, index) => (
          <div className="sb-sol-art" key={`${artifact.type}\u0000${artifact.name}\u0000${index}`} data-testid="solution-artifact">
            <span className="sb-sol-art-tag">{artifact.type}</span>
            <span className="sb-sol-art-name">{artifact.name}</span>
            <span className="sb-sol-art-meta">{artifact.meta}</span>
          </div>
        ))}
      </div>
      <div className="sb-sol-fresh" data-testid="codebase-memory" data-state={solution.codebaseMemory}>
        <span className="sb-sol-fresh-dot" style={{ background: fresh.color }} />
        <span>{fresh.text}</span>
        <Link
          to={toolId ? { view: 'tool', id: toolId } : { view: 'settings', section: 'tools' }}
          className="sb-sol-fresh-link"
          data-testid="open-codebase-memory"
        >
          open Codebase Memory ›
        </Link>
      </div>
    </div>
  );
}

/**
 * Solutions (SPEC → Solutions, M6.2): the workspace's solutions grouped by folder
 * with filter pills, one row per solution (status dot, name + flag, branch chips
 * `⎇ branch · worktree · dot · session`, phase, changes), and the selected
 * solution's detail panel (path, branches & worktrees, phase ledger, artifacts &
 * follow-ups, codebase-memory freshness) with the conflict warning card and its
 * "Move … to worktree" actions (M6.3, `SolutionConflictCard`). Everything comes
 * from `GET /api/solutions` (`LiveSolutions` on the server); session updates,
 * removable worktrees and a finished move reload it.
 */
export function SolutionsView() {
  const solutions = useApi(api.solutions);
  const tools = useApi(api.tools);
  const [filter, setFilter] = useState<SolutionFilter>('All');
  // The ⌘K palette's solution results pick the selected row (M8.3).
  const [selectedPath, setSelectedPath] = useState<string | null>(() => peekSolutionFocus()?.path ?? null);
  useSolutionFocus(setSelectedPath);

  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadSoon = (): void => {
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      solutions.reload();
    }, RELOAD_DEBOUNCE_MS);
  };
  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    },
    [],
  );
  useHubEvent('sessionUpdated', reloadSoon);
  useHubEvent('worktreeRemovable', () => solutions.reload());

  const groups: readonly SolutionGroup[] = solutions.data ?? [];
  const visible = useMemo(() => filterGroups(groups, filter), [groups, filter]);
  const every = useMemo(() => allSolutions(groups), [groups]);
  const selected = every.find((s) => s.path === selectedPath) ?? every[0] ?? null;
  const toolId = codebaseMemoryToolId(tools.data);

  let body: ReactNode = null;
  if (solutions.error && !solutions.data) {
    body = (
      <div className="sb-sol-empty" data-testid="solutions-error">
        {errorText(solutions.error)}
      </div>
    );
  } else if (solutions.data && every.length === 0) {
    body = (
      <div className="sb-sol-empty" data-testid="solutions-empty">
        No solutions found in the workspace.
      </div>
    );
  } else {
    body = visible.map((group) => [
      <div className="sb-sol-group" key={`group:${group.folder}`} data-testid="solution-group" data-folder={group.folder}>
        <span>{group.folder}</span>
        <span className="sb-sol-group-note">{group.note}</span>
      </div>,
      ...group.solutions.map((solution) => (
        <SolutionRow
          key={solution.path}
          solution={solution}
          selected={selected?.path === solution.path}
          onSelect={() => setSelectedPath(solution.path)}
        />
      )),
    ]);
  }

  return (
    <section className="sb-view sb-solutions" data-view="solutions" data-testid="view-solutions">
      <div className="sb-sol-list">
        <div className="sb-sol-head">
          <div className="sb-sol-titlebar">
            <div className="sb-sol-title">Solutions</div>
            <div className="sb-sol-meta" data-testid="solutions-meta">
              {headerMeta(groups)}
            </div>
          </div>
          <div className="sb-sol-pills" role="group" aria-label="Filter solutions">
            {SOLUTION_FILTERS.map((label) => (
              <span
                key={label}
                className="sb-sol-pill"
                role="button"
                tabIndex={0}
                aria-pressed={filter === label}
                data-testid={`solutions-filter-${label}`}
                onClick={() => setFilter(label)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setFilter(label);
                  }
                }}
              >
                {label}
              </span>
            ))}
          </div>
        </div>
        <div className="sb-sol-scroll" data-testid="solutions-list">
          {body}
        </div>
      </div>
      {selected ? (
        <SolutionDetail solution={selected} toolId={toolId} onMoved={solutions.reload} />
      ) : (
        <div className="sb-sol-detail" data-testid="solution-detail" />
      )}
    </section>
  );
}
