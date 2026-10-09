import type { CodebaseMemoryStatus, DiffScope, DiffTargets, DiffCount, FileDiff, HistoryItem, SolutionGroup, SystemInfo, ToolProbe } from '../core/api.ts';
import type { LoginServiceStatus } from '../core/login-service.ts';
import type { UpdateStatus } from '../core/updates.ts';
import type { FolderRef } from './folders/ref.ts';
import type { FrameHelperOpener } from './tools/frame-helper.ts';
import type { FramingHeaders } from './tools/framing.ts';

/**
 * Live data that is computed rather than stored (docs/database.md → "Not stored"),
 * behind interfaces so the demo seed (gap #21, D13) can feed alternate
 * implementations of the same interfaces when `SWITCHBOARD_DEMO=1`. Normal runs
 * never read demo data: each real implementation is added by its backlog item
 * (`docs/lanes.md`) and wired in `main.ts`.
 */

/** Diff of a session's worktrees (gap #10). Real implementation: M4.5. */
export interface DiffProvider {
  /**
   * Changed files of the session, or only `file` (a solution-relative path) when
   * given. D90: `scope` picks which changes ({@link DiffScope}); without one, the
   * whole branch (`branch`, the behavior before D90: what `SessionDetail.files`
   * and the Artifacts counts read). The route's default is `head`.
   */
  diff(sessionId: string, file?: string, scope?: DiffScope): Promise<FileDiff[]>;
  /** D90: the working trees the diff reads (the Diff tab's views and header); absent → none known. */
  targets?(sessionId: string): Promise<DiffTargets>;
  /**
   * D90 ruling: how many files `diff(sessionId, undefined, scope)` would list in the
   * view the Diff tab shows for `scope` (see {@link DiffCount}), without reading the
   * patches; absent → the route counts `diff()`'s answer.
   */
  count?(sessionId: string, scope: DiffScope): Promise<DiffCount>;
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

/** What one probe of a tool URL found (M8.1; D15 adds the framing headers). */
export interface ToolProbeReport {
  readonly state: ToolProbe['state'];
  /** D15: the answer's `X-Frame-Options` / CSP headers; `null` when the tool is down (or the provider does not look). */
  readonly framing: FramingHeaders | null;
}

/**
 * Reachability of an embedded tool's URL (M8.1). Real implementation: a
 * server-side GET with a 3 s timeout (`tools/probe.ts`), used when none is given.
 */
export interface ToolProbeProvider {
  probe(url: string): Promise<ToolProbeReport>;
}

/**
 * D15: the embedded tools' framing proxies (`docs/tools.md` → *Framing proxy*).
 * Real implementation: `ToolProxies` (`tools/proxies.ts`), created, synced and
 * closed by main.ts in normal runs. Demo mode has none, so its tools keep
 * `frameUrl: null`.
 */
export interface ToolFrameProvider {
  /** Starts, restarts (changed URL) or stops proxies so they match the saved tools. */
  sync(tools: ReadonlyArray<{ readonly id: string; readonly url: string | null }>): Promise<void>;
  /** The proxy URL that frames `toolId` for a page on `hostname` (`127.0.0.1` or `localhost`); `null` without a running proxy. */
  frameUrl(toolId: string, hostname?: string): string | null;
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
  /** D15: without it (demo mode, tests that do not pass one) every tool's `frameUrl` is `null`. */
  readonly toolFrames?: ToolFrameProvider;
  readonly codebaseMemory?: CodebaseMemoryProvider;
  /**
   * D35 (`docs/frame-helper.md` → *Guided setup*): the OS openers of the frame-helper
   * setup (`tools/frame-helper.ts` → `createFrameHelperOpener`), wired by main.ts
   * with `SWITCHBOARD_OPEN_COMMAND`. Without one (tests that build the app bare)
   * `POST /api/frame-helper/reveal` and `/open-extensions` answer 501, so nothing
   * can open a real app by accident.
   */
  readonly frameHelperOpener?: FrameHelperOpener;
  /**
   * D55 (`docs/updates.md`): the updater (`updates/service.ts` → `UpdateService`),
   * wired by main.ts in normal runs unless `SWITCHBOARD_UPDATES=off`. Without one
   * (demo mode, tests that build the app bare) the `/api/updates*` routes answer
   * 501, so nothing ever calls GitHub by accident.
   */
  readonly updates?: UpdatesProvider;
}

/** D55: what the updates routes need from the updater. */
export interface UpdatesProvider {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  /** Starts the update to `version`; throws an `UpdateError` (`updates/service.ts`) when refused. */
  install(version: string): UpdateStatus;
  dismiss(version: string): Promise<UpdateStatus>;
}
