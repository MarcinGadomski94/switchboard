import type { FileDiff, HistoryItem, SolutionGroup, SystemInfo } from '../core/api.ts';

/**
 * Live data that is computed rather than stored (docs/database.md → "Not stored"),
 * behind interfaces so the demo seed (gap #21, D13) can feed alternate
 * implementations of the same interfaces when `SWITCHBOARD_DEMO=1`. Normal runs
 * never read demo data: each real implementation is added by its backlog item
 * (`docs/lanes.md`) and wired in `main.ts`.
 */

/** Diff of a session's worktrees (gap #10). Real implementation: M4.5. */
export interface DiffProvider {
  /** Changed files of the session, or only `file` (a solution-relative path) when given. */
  diff(sessionId: string, file?: string): Promise<FileDiff[]>;
}

/** The workspace scan grouped by folder (M6.1 / M6.2). Real implementation: M6.1. */
export interface SolutionsProvider {
  solutions(): Promise<SolutionGroup[]>;
}

/** CLI / gh status + machine metrics (gap #11) + usage (M9.2). Real implementation: M5.3, M9.2. */
export interface SystemProvider {
  system(): Promise<SystemInfo>;
}

/** Transcript-based History rows (M7.4). Real implementation: M7.4. */
export interface HistoryProvider {
  /** Rows matching `q` (case-insensitive), newest first. */
  history(q?: string): Promise<HistoryItem[]>;
}

/** The providers a running service has. A missing one means its item has not landed yet. */
export interface Providers {
  readonly diff?: DiffProvider;
  readonly solutions?: SolutionsProvider;
  readonly system?: SystemProvider;
  readonly history?: HistoryProvider;
}
