import type { CodebaseMemoryStatus, FileDiff, HistoryItem, SolutionGroup, SystemInfo, ToolProbe } from '../core/api.ts';
import type { LoginServiceStatus } from '../core/login-service.ts';
import type { FolderRef } from './folders/ref.ts';

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

/**
 * One folder's solutions grouped by folder (M6.1 / M6.2; D14: one folder at a
 * time). Real implementation: `LiveSolutions` (`solutions/live.ts`) over a
 * `WorkspaceScanner` per workspace folder; a repo folder is one group with its
 * one solution.
 */
export interface SolutionsProvider {
  solutions(folder: FolderRef): Promise<SolutionGroup[]>;
  /**
   * `true` when the router's folder rules of the workspace `folder` make a
   * NewSession solution (a bare name or a workspace-relative path) read-only
   * (`docs/solutions.md`). Optional: without it the session validation matches
   * read-only rows of {@link solutions} by name.
   */
  isReadOnly?(solution: string, folder: FolderRef): Promise<boolean>;
}

/** CLI / gh status + machine metrics (gap #11) + usage (M9.2). Real implementation: `SystemProbe` (M5.3, `system/probe.ts`); M9.2 adds usage. */
export interface SystemProvider {
  /** `fresh`: check the CLI and gh again instead of answering from a recent check (the setup wizard). */
  system(options?: { readonly fresh?: boolean }): Promise<SystemInfo>;
}

/** Transcript-based History rows (M7.4). Real implementation: M7.4. */
export interface HistoryProvider {
  /** Rows matching `q` (case-insensitive), newest first. */
  history(q?: string): Promise<HistoryItem[]>;
}

/**
 * "Start at login": the per-user OS service definition (M9.1, `docs/service.md`).
 * Real implementation: `LoginService` (`service/login-service.ts`); the demo's
 * never touches the OS.
 */
export interface LoginServiceProvider {
  status(): Promise<LoginServiceStatus>;
  /** Registers / removes the service definition. Rejects with a `ServiceError` (`service/errors.ts`). */
  setStartAtLogin(enabled: boolean): Promise<LoginServiceStatus>;
}

/**
 * Reachability of an embedded tool's URL (M8.1). Real implementation: a
 * server-side GET with a 3 s timeout (`tools/probe.ts`), used when none is given.
 */
export interface ToolProbeProvider {
  probe(url: string): Promise<ToolProbe['state']>;
}

/**
 * The Codebase Memory strip (M8.1, gap #4): the projects in a workspace folder's
 * `.claude/.codebase-memory-dirty` (D14: per folder; a repo folder has none).
 * Real implementation: `tools/codebase-memory.ts`, used when none is given.
 */
export interface CodebaseMemoryProvider {
  status(folder: FolderRef): Promise<CodebaseMemoryStatus>;
}

/** The providers a running service has. A missing one means its item has not landed yet. */
export interface Providers {
  readonly diff?: DiffProvider;
  readonly solutions?: SolutionsProvider;
  readonly system?: SystemProvider;
  readonly history?: HistoryProvider;
  readonly loginService?: LoginServiceProvider;
  readonly toolProbe?: ToolProbeProvider;
  readonly codebaseMemory?: CodebaseMemoryProvider;
}
