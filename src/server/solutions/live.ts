import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FileDiff, Solution, SolutionArtifact, SolutionBranch, SolutionGroup } from '../../core/api.ts';
import type { Phase, SessionStatus } from '../../core/model.ts';
import {
  branchFromHead,
  changesText,
  dirtyProjects,
  freshness,
  parsePhaseLedger,
  solutionPhase,
  solutionStatus,
} from '../../core/solutions-live.ts';
import { toSolutionGroups } from '../../core/workspace-rules.ts';
import { solutionCandidates } from '../../core/worktrees.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';
import type { Store } from '../db/store.ts';
import type { DiffProvider, SolutionsProvider } from '../providers.ts';
import type { WorkspaceScanner } from './scanner.ts';

/** A solution's phase ledger file, at its root (gap #12). */
export const PHASE_LEDGER_FILE = 'phase-ledger.md';
/** Follow-ups routed into a solution (router → *Mobile-followups routing*). */
export const FOLLOWUPS_FOLDER = 'mobile-followups';
/** The dirty list of the codebase-memory freshness hooks, under the workspace root. */
export const CODEBASE_MEMORY_DIRTY_FILE = path.join('.claude', '.codebase-memory-dirty');
/** Owner copy of a branch no session works on (the prototype's `⎇ main · idle`). */
export const IDLE_OWNER = 'idle';
/** Owner copy of a worktree whose session no longer exists. */
export const NO_SESSION_OWNER = '—';

/** Options for {@link LiveSolutions}. */
export interface LiveSolutionsOptions {
  /** The M6.1 scanner (folder rules, solutions, read-only check). */
  readonly scanner: WorkspaceScanner;
  readonly store: Store;
  /** The session diff (gap #10, the worktree manager); without it the changes column reads `—`. */
  readonly diff?: DiffProvider;
  /** Called when a live field could not be read (default: ignored; the field stays neutral). */
  readonly onError?: (error: unknown) => void;
}

/** A writable or read-only row with what the enrichment needs. */
interface Row {
  readonly solution: Solution;
  readonly readOnly: boolean;
  /** Top-level folder solution (`mobile/`, `infrastructure/`). */
  readonly wholeFolder: boolean;
  /** `.git` is a directory. */
  readonly git: boolean;
  /** Canonical path (worktree rows store canonical repo paths), or the configured one when it cannot be resolved. */
  readonly canonical: string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

function isGone(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * The real {@link SolutionsProvider} (M6.2, `docs/solutions.md` → *Live fields*):
 * the M6.1 workspace scan with every row's live fields filled from what
 * Switchboard knows and what the solution folders hold:
 * - **branches**: each live worktree of the repo (its branch, path and session),
 *   then each open session working in place (the checkout's branch); a row
 *   nobody works on shows its checkout's branch, owner `idle`;
 * - **status**: the most urgent status of those sessions; **phase**: the phase
 *   ledger's, else the sessions'; **changes**: lines added by those sessions'
 *   diffs (gap #10);
 * - **ledger**: `phase-ledger.md` (gap #12); **artifacts**: the sessions'
 *   artifacts for the solution + its `mobile-followups/*.md`;
 * - **codebaseMemory**: the workspace's `.claude/.codebase-memory-dirty`.
 *
 * Conflicts (`conflict`, `flag`) stay neutral: M6.3 detects them. Read-only: it
 * reads the database, `.git/HEAD`, `phase-ledger.md`, `mobile-followups/` and
 * the dirty list; git runs only through the diff provider.
 */
export class LiveSolutions implements SolutionsProvider {
  readonly #scanner: WorkspaceScanner;
  readonly #store: Store;
  readonly #diff: DiffProvider | null;
  readonly #onError: (error: unknown) => void;

  constructor(options: LiveSolutionsOptions) {
    this.#scanner = options.scanner;
    this.#store = options.store;
    this.#diff = options.diff ?? null;
    this.#onError = options.onError ?? (() => {});
  }

  /** NewSession read-only check: the scanner's (M6.1). */
  isReadOnly(solution: string): Promise<boolean> {
    return this.#scanner.isReadOnly(solution);
  }

  /** `GET /api/solutions` with the live fields. @throws {ScanError} without a usable workspace root. */
  async solutions(): Promise<SolutionGroup[]> {
    const scan = await this.#scanner.scan();
    const groups = toSolutionGroups(scan);
    const scanned = new Map(scan.folders.flatMap((folder) => folder.solutions.map((s) => [s.path, { git: s.git, depth: folder.depth }] as const)));
    const rows: Row[] = await Promise.all(
      groups.flatMap((group) =>
        group.solutions.map(async (solution): Promise<Row> => {
          const info = scanned.get(solution.path);
          return {
            solution,
            readOnly: solution.rule === 'read-only',
            wholeFolder: (info?.depth ?? 1) === 0,
            git: info?.git ?? false,
            canonical: await realpath(solution.path).catch(() => solution.path),
          };
        }),
      ),
    );

    const [sessions, worktrees, artifacts, dirty] = await Promise.all([
      this.#store.sessions.list(),
      this.#store.worktrees.list(),
      this.#store.artifacts.list(),
      this.#readDirty(scan.root),
    ]);
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const writable = rows.filter((row) => !row.readOnly);

    // Which row a session's solution string means (the worktree manager's resolution: a unique git checkout).
    const resolved = new Map<string, Row | null>();
    const resolve = (solution: string): Row | null => {
      if (!resolved.has(solution)) {
        const candidates = new Set(solutionCandidates(scan.root, solution) ?? []);
        const matches = writable.filter((row) => row.git && candidates.has(row.solution.path));
        resolved.set(solution, matches.length === 1 ? (matches[0] as Row) : null);
      }
      return resolved.get(solution) ?? null;
    };

    // Worktrees per row (by canonical repo path), in-place sessions per row.
    const worktreesByRow = new Map<Row, WorktreeRecord[]>();
    for (const worktree of worktrees) {
      const row = writable.find((candidate) => candidate.canonical === worktree.repoPath);
      if (!row) continue;
      worktreesByRow.set(row, [...(worktreesByRow.get(row) ?? []), worktree]);
    }
    const inPlaceByRow = new Map<Row, SessionRecord[]>();
    for (const session of sessions) {
      if (session.endedAt !== null) continue;
      for (const name of session.solutions) {
        const row = resolve(name);
        if (!row) continue;
        if ((worktreesByRow.get(row) ?? []).some((w) => w.sessionId === session.id)) continue;
        const list = inPlaceByRow.get(row) ?? [];
        if (!list.includes(session)) inPlaceByRow.set(row, [...list, session]);
      }
    }

    const changes = await this.#changes(
      [...new Set([...[...worktreesByRow.values()].flat().flatMap((w) => (w.sessionId ? [w.sessionId] : [])), ...[...inPlaceByRow.values()].flat().map((s) => s.id)])],
      (solution) => resolve(solution),
    );

    const enriched = new Map<Solution, Solution>();
    await Promise.all(
      rows.map(async (row) => {
        const head = row.git ? await this.#branch(row.solution.path) : null;
        const branches: SolutionBranch[] = [];
        const statuses: SessionStatus[] = [];
        const phases: Phase[] = [];
        const rowWorktrees = worktreesByRow.get(row) ?? [];
        for (const worktree of rowWorktrees) {
          const session = worktree.sessionId ? (sessionsById.get(worktree.sessionId) ?? null) : null;
          branches.push({
            branch: worktree.branch,
            worktree: displayWorktreePath(row, worktree.path),
            sessionId: session?.id ?? null,
            owner: session?.name ?? NO_SESSION_OWNER,
            status: session?.status ?? 'idle',
          });
          if (session) {
            statuses.push(session.status);
            if (session.endedAt === null && session.phase) phases.push(session.phase);
          }
        }
        for (const session of inPlaceByRow.get(row) ?? []) {
          branches.push({ branch: head ?? '—', worktree: null, sessionId: session.id, owner: session.name, status: session.status });
          statuses.push(session.status);
          if (session.phase) phases.push(session.phase);
        }
        if (branches.length === 0 && head) branches.push({ branch: head, worktree: null, sessionId: null, owner: IDLE_OWNER, status: 'idle' });

        const ledger = await this.#ledger(row.solution.path);
        const delta = changes.get(row) ?? { added: 0, removed: 0 };
        enriched.set(row.solution, {
          ...row.solution,
          status: row.readOnly ? 'idle' : solutionStatus(statuses),
          phase: row.readOnly ? '—' : solutionPhase(ledger, phases),
          changes: changesText(delta.added, delta.removed, row.readOnly),
          branches,
          ledger,
          artifacts: await this.#artifacts(row, artifacts),
          codebaseMemory: freshness(dirty, scan.root, row.solution.relativePath, row.wholeFolder),
        });
      }),
    );
    return groups.map((group) => ({ ...group, solutions: group.solutions.map((solution) => enriched.get(solution) ?? solution) }));
  }

  /** Lines added / removed per row by the sessions' diffs (gap #10); a failing diff counts nothing. */
  async #changes(sessionIds: readonly string[], resolve: (solution: string) => Row | null): Promise<Map<Row, { added: number; removed: number }>> {
    const totals = new Map<Row, { added: number; removed: number }>();
    const diff = this.#diff;
    if (!diff) return totals;
    const results = await Promise.all(
      sessionIds.map((id) =>
        diff.diff(id).catch((error: unknown): FileDiff[] => {
          this.#onError(error);
          return [];
        }),
      ),
    );
    for (const file of results.flat()) {
      const row = resolve(file.solution);
      if (!row) continue;
      const total = totals.get(row) ?? { added: 0, removed: 0 };
      totals.set(row, { added: total.added + file.added, removed: total.removed + file.removed });
    }
    return totals;
  }

  /** The checked-out branch from `<solution>/.git/HEAD`, `null` when it cannot be read. */
  async #branch(dir: string): Promise<string | null> {
    try {
      return branchFromHead(await readFile(path.join(dir, '.git', 'HEAD'), 'utf8'));
    } catch (error) {
      if (!isGone(error)) this.#onError(error);
      return null;
    }
  }

  /** `<solution>/phase-ledger.md` parsed (gap #12), `null` when there is none. */
  async #ledger(dir: string): Promise<Solution['ledger']> {
    try {
      return parsePhaseLedger(await readFile(path.join(dir, PHASE_LEDGER_FILE), 'utf8'));
    } catch (error) {
      if (!isGone(error) && errorCode(error) !== 'EISDIR') this.#onError(error);
      return null;
    }
  }

  /**
   * The row's artifacts: the sessions' artifacts whose solution is the row's name
   * (one per type + name, newest first), then its `mobile-followups/*.md` files not
   * already listed (FOLLOWUP, no meta).
   */
  async #artifacts(row: Row, all: Awaited<ReturnType<Store['artifacts']['list']>>): Promise<SolutionArtifact[]> {
    const out: SolutionArtifact[] = [];
    const seen = new Set<string>();
    for (const artifact of all) {
      if (artifact.solution !== row.solution.name) continue;
      const key = `${artifact.type}\u0000${artifact.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: artifact.type, name: artifact.name, meta: artifact.meta ?? '', sessionId: artifact.sessionId });
    }
    let entries: Dirent[] = [];
    try {
      entries = await readdir(path.join(row.solution.path, FOLLOWUPS_FOLDER), { withFileTypes: true });
    } catch (error) {
      if (!isGone(error)) this.#onError(error);
    }
    const files = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => `${FOLLOWUPS_FOLDER}/${entry.name}`)
      .sort();
    for (const name of files) {
      if (seen.has(`FOLLOWUP\u0000${name}`)) continue;
      seen.add(`FOLLOWUP\u0000${name}`);
      out.push({ type: 'FOLLOWUP', name, meta: '', sessionId: null });
    }
    return out;
  }

  /** The dirty list's project ids; `[]` without the file, `null` when it cannot be read. */
  async #readDirty(root: string): Promise<string[] | null> {
    try {
      return dirtyProjects(await readFile(path.join(root, CODEBASE_MEMORY_DIRTY_FILE), 'utf8'));
    } catch (error) {
      if (isGone(error)) return [];
      this.#onError(error);
      return null;
    }
  }
}

/**
 * A worktree path as the detail panel shows it: next to the repo (gap #1,
 * `../{repo}-wt-{session}`) it is given in the configured root's form (so the UI
 * can print `../<folder>`), anywhere else as stored.
 */
function displayWorktreePath(row: Row, worktreePath: string): string {
  if (path.dirname(worktreePath) === path.dirname(row.canonical)) {
    return path.join(path.dirname(row.solution.path), path.basename(worktreePath));
  }
  return worktreePath;
}
