import type { CodebaseMemoryFreshness, PhaseLedgerEntry, Solution, SolutionArtifact, SolutionGroup } from '../../core/api.ts';

/**
 * Pure view logic of the Solutions view (M6.2, SPEC → Solutions): filter pills,
 * header meta, worktree labels, ledger / artifact fallbacks and the freshness
 * line. Copy is the prototype's (`docs/handoff/prototype/Switchboard App.dc.html`,
 * `SG` / `sd`), with gap #12 for the missing phase ledger.
 */

/** The filter pills, in the prototype's order (`other/` rows show under All only, gap #15). */
export const SOLUTION_FILTERS = ['All', 'Web', 'Mobile', 'NuGet', 'Backend', 'Read-only'] as const;
/** A filter pill. */
export type SolutionFilter = (typeof SOLUTION_FILTERS)[number];

/** The groups with only the rows the pill shows; groups left empty are dropped. */
export function filterGroups(groups: readonly SolutionGroup[], filter: SolutionFilter): SolutionGroup[] {
  return groups
    .map((group) => ({ ...group, solutions: group.solutions.filter((s) => filter === 'All' || s.type === filter) }))
    .filter((group) => group.solutions.length > 0);
}

/** Every solution, in list order. */
export function allSolutions(groups: readonly SolutionGroup[]): Solution[] {
  return groups.flatMap((group) => [...group.solutions]);
}

function lastSeparator(text: string): number {
  return Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
}

/** The parent folder of a path in either OS form (`D:\ws\mobile` → `D:\ws`). */
export function parentPath(value: string): string {
  const at = lastSeparator(value);
  if (at < 0) return '';
  return at === 0 ? value.slice(0, 1) : value.slice(0, at);
}

/** The last segment of a path in either OS form. */
export function baseName(value: string): string {
  return value.slice(lastSeparator(value) + 1);
}

/** The workspace root a solution sits in: its path without its `relativePath` segments. */
export function workspaceRootOf(solution: Pick<Solution, 'path' | 'relativePath'>): string {
  let root = solution.path.replace(/[\\/]+$/, '');
  const depth = solution.relativePath.split('/').filter(Boolean).length;
  for (let i = 0; i < depth; i++) root = parentPath(root);
  return root;
}

/** Header meta: `D:\acme · 18 solutions · 7 active` (active = a status other than idle). */
export function headerMeta(groups: readonly SolutionGroup[]): string {
  const solutions = allSolutions(groups);
  const first = solutions[0];
  if (!first) return '';
  const active = solutions.filter((s) => s.status !== 'idle').length;
  return `${workspaceRootOf(first)} · ${solutions.length} solution${solutions.length === 1 ? '' : 's'} · ${active} active`;
}

/** A branch chip's worktree label: the worktree folder name, empty when the session works in place. */
export function worktreeLabel(worktree: string | null): string {
  return worktree ? baseName(worktree.replace(/[\\/]+$/, '')) : '';
}

/**
 * A branch card's worktree line: `in place`, `../<folder>` for a worktree next
 * to the solution (gap #1), else the worktree's full path.
 */
export function worktreeLine(worktree: string | null, solutionPath: string): string {
  if (!worktree) return 'in place';
  if (/^\.\.[\\/]/.test(worktree)) return worktree;
  const trimmed = worktree.replace(/[\\/]+$/, '');
  if (parentPath(trimmed) === parentPath(solutionPath.replace(/[\\/]+$/, ''))) return `../${baseName(trimmed)}`;
  return worktree;
}

/** A phase-ledger row as the detail panel shows it. */
export interface LedgerRow {
  readonly interface: string;
  readonly phase: string;
  /** CSS color: UI-first = need, integration = run, the fallback row muted. */
  readonly color: string;
  readonly seam: string;
}

/** The ledger rows, or the prototype's fallback row (`—`, the row's phase) with the gap #12 copy. */
export function ledgerRows(solution: Pick<Solution, 'ledger' | 'phase'>): LedgerRow[] {
  const toRow = (entry: PhaseLedgerEntry): LedgerRow => ({
    interface: entry.interface,
    phase: entry.phase,
    color: entry.phase === 'UI-first' ? 'var(--status-need)' : entry.phase === 'integration' ? 'var(--status-run)' : 'var(--muted-2)',
    seam: entry.seam,
  });
  if (solution.ledger === null) return [{ interface: '—', phase: solution.phase, color: 'var(--muted-2)', seam: 'no phase-ledger.md' }];
  if (solution.ledger.length === 0) return [{ interface: '—', phase: solution.phase, color: 'var(--muted-2)', seam: 'phase-ledger.md has no entries' }];
  return solution.ledger.map(toRow);
}

/** The artifact rows, or the prototype's INFO row when there are none. */
export function artifactRows(artifacts: readonly SolutionArtifact[]): SolutionArtifact[] {
  return artifacts.length > 0 ? [...artifacts] : [{ type: 'INFO', name: 'No artifacts', meta: '', sessionId: null }];
}

/** The codebase-memory freshness line: its text and dot color (prototype `sd.idx` / `sd.idxColor`). */
export function freshnessLine(state: CodebaseMemoryFreshness): { readonly text: string; readonly color: string } {
  if (state === 'dirty') return { text: 'codebase-memory · edited by agents since last index', color: 'var(--status-need)' };
  if (state === 'fresh') return { text: 'codebase-memory · indexed · fresh', color: 'var(--status-done)' };
  return { text: 'codebase-memory · freshness unknown', color: 'var(--status-idle)' };
}

/** The Codebase Memory tool among the configured tools (by name), if any. */
export function codebaseMemoryToolId(tools: ReadonlyArray<{ readonly id: string; readonly name: string }> | null): string | null {
  return (tools ?? []).find((tool) => /codebase\s*memory/i.test(tool.name))?.id ?? null;
}
