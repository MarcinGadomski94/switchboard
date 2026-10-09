import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileDiff, Solution, SolutionArtifact, SolutionBranch, SolutionGroup } from '../../core/api.ts';
import type { Phase, SessionStatus } from '../../core/model.ts';
import { solutionFreshness } from '../../core/codebase-memory.ts';
import { NO_CONFLICT, type RepoWriter, repoConflict } from '../../core/conflicts.ts';
import { branchFromHead, branchOwnerTitle, changesText, parsePhaseLedger, solutionPhase, solutionStatus } from '../../core/solutions-live.ts';
import { type WorkspaceScan, plainFolderScan, repoFolderScan, toSolutionGroups } from '../../core/workspace-rules.ts';
import { solutionCandidates } from '../../core/worktrees.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';
import type { Store } from '../db/store.ts';
import { type FolderRef, folderOfSession, repoSolutionName } from '../folders/ref.ts';
import type { DiffProvider, SolutionsProvider } from '../providers.ts';
import { isMainCheckout } from './checkout.ts';
import { readDirtyList } from './codebase-memory.ts';
import { ScanError, WorkspaceScanner } from './scanner.ts';

/** A solution's phase ledger file, at its root (gap #12). */
export const PHASE_LEDGER_FILE = 'phase-ledger.md';
/** Follow-ups routed into a solution (router → *Mobile-followups routing*). */
export const FOLLOWUPS_FOLDER = 'mobile-followups';
/** Owner copy of a branch no session works on (the prototype's `⎇ main · idle`). */
export const IDLE_OWNER = 'idle';
/** Owner copy of a worktree whose session no longer exists. */
export const NO_SESSION_OWNER = '—';

/** Options for {@link LiveSolutions}. */
export interface LiveSolutionsOptions {
  readonly store: Store;
  /** The session diff (gap #10, the worktree manager); without it the changes column reads `—`. */
  readonly diff?: DiffProvider;
  /**
   * Which repo a solution name means in a session's own folder (the worktree
   * manager's `resolveRepo`, D14), for the open sessions of **other** folders
   * that write a repo of the folder shown (e.g. a workspace session in place in
   * `other/switchboard` while the repo folder `switchboard` is shown). Without it
   * only the shown folder's own sessions count.
   */
  readonly resolveRepo?: (solution: string, folder: FolderRef) => Promise<{ readonly repoPath: string }>;
  /** Called when a live field could not be read (default: ignored; the field stays neutral). */
  readonly onError?: (error: unknown) => void;
}

/** A writable or read-only row with what the enrichment needs. */
interface Row {
  readonly solution: Solution;
  readonly readOnly: boolean;
  /** `.git` is a directory, here or in the one nested checkout (`repo`). */
  readonly git: boolean;
  /** The git checkout the row stands for (`ScannedSolution.repoPath`), else the solution folder. */
  readonly repo: string;
  /** Canonical repo path (worktree rows store canonical repo paths), or `repo` when it cannot be resolved. */
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
 * The real {@link SolutionsProvider} (M6.2, `docs/solutions.md` → *Live fields*;
 * D14: one folder at a time): the scan of the folder asked for (a workspace:
 * the M6.1 `WorkspaceScanner` of that folder; a repo: its one solution) with
 * every row's live fields filled from what Switchboard knows and what the
 * solution folders hold:
 * - **branches**: each live worktree of the repo (its branch, path and session),
 *   then each open session working in place (the checkout's branch); a row
 *   nobody works on shows its checkout's branch, owner `idle`; D22: each
 *   branch's `ownerTitle` is its session's display title, `null` without one;
 * - **status**: the most urgent status of those sessions; **phase**: the phase
 *   ledger's, else the sessions'; **changes**: lines added by those sessions'
 *   diffs (gap #10);
 * - **ledger**: `phase-ledger.md` (gap #12); **artifacts**: its
 *   `mobile-followups/*.md` (D89: the sessions' derived artifacts are gone;
 *   saved artifacts belong to sessions, not solutions);
 * - **codebaseMemory**: a workspace's `.claude/.codebase-memory-dirty` (M6.4,
 *   `src/core/codebase-memory.ts`); `unknown` in a repo folder, which has no
 *   dirty list;
 * - **conflict** (M6.3): two or more open sessions write the repo while at
 *   least one has no worktree of its own (`flag` "⚠ shared working tree",
 *   `conflictSessions` for the card and its "Move … to worktree" actions).
 *
 * A session's solutions resolve in the session's own folder (D14), so sessions
 * of any folder that write a repo of this one count.
 *
 * Read-only: it reads the database, `.git/HEAD`, `phase-ledger.md`,
 * `mobile-followups/` and the dirty list; git runs only through the diff provider.
 */
export class LiveSolutions implements SolutionsProvider {
  readonly #store: Store;
  readonly #diff: DiffProvider | null;
  readonly #resolveRepo: LiveSolutionsOptions['resolveRepo'] | null;
  readonly #onError: (error: unknown) => void;

  constructor(options: LiveSolutionsOptions) {
    this.#store = options.store;
    this.#diff = options.diff ?? null;
    this.#resolveRepo = options.resolveRepo ?? null;
    this.#onError = options.onError ?? (() => {});
  }

  /** NewSession read-only check: the scanner's of a workspace folder (M6.1); nothing in a repo folder is read-only. */
  isReadOnly(solution: string, folder: FolderRef): Promise<boolean> {
    if (folder.kind === 'repo') return Promise.resolve(false);
    return new WorkspaceScanner({ root: folder.path }).isReadOnly(solution);
  }

  /** The folder's scan without live fields (a workspace's `WorkspaceScanner`, a repo's one row, D59: a plain folder's none). @throws {ScanError} when the folder is gone. */
  async scan(folder: FolderRef): Promise<WorkspaceScan> {
    if (folder.kind === 'workspace') return new WorkspaceScanner({ root: folder.path }).scan();
    try {
      if (!(await stat(folder.path)).isDirectory()) throw new Error('not a folder');
    } catch {
      throw new ScanError('folder-missing', `the folder does not exist: ${folder.path}`);
    }
    // D59: a plain folder has no solutions.
    if (folder.kind === 'plain') return plainFolderScan(folder.path);
    return repoFolderScan(folder.path, repoSolutionName(folder), (await isMainCheckout(folder.path)) ? folder.path : null);
  }

  /** `GET /api/solutions?folder=` with the live fields. @throws {ScanError} when the folder is gone. */
  async solutions(folder: FolderRef): Promise<SolutionGroup[]> {
    const scan = await this.scan(folder);
    const groups = toSolutionGroups(scan);
    const repoByPath = new Map(scan.folders.flatMap((f) => f.solutions.map((s) => [s.path, s.repoPath] as const)));
    const rows: Row[] = await Promise.all(
      groups.flatMap((group) =>
        group.solutions.map(async (solution): Promise<Row> => {
          const repoPath = repoByPath.get(solution.path) ?? null;
          const repo = repoPath ?? solution.path;
          return {
            solution,
            readOnly: solution.rule === 'read-only',
            git: repoPath !== null,
            repo,
            canonical: await realpath(repo).catch(() => repo),
          };
        }),
      ),
    );

    const [sessions, worktrees, dirty] = await Promise.all([
      this.#store.sessions.list(),
      this.#store.worktrees.list(),
      folder.kind === 'workspace' ? readDirtyList(scan.root) : Promise.resolve(null),
    ]);
    if (dirty?.state === 'unreadable') this.#onError(dirty.error);
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const writable = rows.filter((row) => !row.readOnly);
    const shownRoots = new Set([folder.root, folder.path]);
    const rowOf = this.#rowResolver(folder, scan, writable, shownRoots, worktrees);

    // Worktrees per row (by canonical repo path), in-place sessions per row.
    const worktreesByRow = new Map<Row, WorktreeRecord[]>();
    for (const worktree of worktrees) {
      const row = writable.find((candidate) => candidate.canonical === worktree.repoPath);
      if (!row) continue;
      worktreesByRow.set(row, [...(worktreesByRow.get(row) ?? []), worktree]);
    }
    const inPlaceByRow = new Map<Row, SessionRecord[]>();
    // The solution string each in-place session lists for a row (the `{repo}` to isolate it with, M6.3).
    const inPlaceRepo = new Map<Row, Map<string, string>>();
    for (const session of sessions) {
      if (session.endedAt !== null) continue;
      for (const name of session.solutions) {
        const row = await rowOf(session, name);
        if (!row) continue;
        if ((worktreesByRow.get(row) ?? []).some((w) => w.sessionId === session.id)) continue;
        const list = inPlaceByRow.get(row) ?? [];
        if (!list.includes(session)) inPlaceByRow.set(row, [...list, session]);
        const repos = inPlaceRepo.get(row) ?? new Map<string, string>();
        if (!repos.has(session.id)) repos.set(session.id, name);
        inPlaceRepo.set(row, repos);
      }
    }

    const changes = await this.#changes(
      [...new Set([...[...worktreesByRow.values()].flat().flatMap((w) => (w.sessionId ? [w.sessionId] : [])), ...[...inPlaceByRow.values()].flat().map((s) => s.id)])],
      async (sessionId, solution) => {
        const session = sessionsById.get(sessionId);
        return session ? rowOf(session, solution) : null;
      },
    );

    const enriched = new Map<Solution, Solution>();
    await Promise.all(
      rows.map(async (row) => {
        const head = row.git ? await this.#branch(row.repo) : null;
        const branches: SolutionBranch[] = [];
        const statuses: SessionStatus[] = [];
        const phases: Phase[] = [];
        // Open sessions writing the repo, in their worktree or in place (M6.3 conflicts).
        const writers: RepoWriter[] = [];
        const rowWorktrees = worktreesByRow.get(row) ?? [];
        for (const worktree of rowWorktrees) {
          const session = worktree.sessionId ? (sessionsById.get(worktree.sessionId) ?? null) : null;
          branches.push({
            branch: worktree.branch,
            worktree: displayWorktreePath(row, worktree.path),
            sessionId: session?.id ?? null,
            owner: session?.name ?? NO_SESSION_OWNER,
            // D22 (developer ruling 2026-09-28): the chip and card name the owner by its display title.
            ownerTitle: branchOwnerTitle(session),
            status: session?.status ?? 'idle',
          });
          if (session) {
            statuses.push(session.status);
            if (session.endedAt === null && session.phase) phases.push(session.phase);
            if (session.endedAt === null) writers.push(writer(session, true, worktree.repo));
          }
        }
        for (const session of inPlaceByRow.get(row) ?? []) {
          branches.push({
            branch: head ?? '—',
            worktree: null,
            sessionId: session.id,
            owner: session.name,
            ownerTitle: branchOwnerTitle(session),
            status: session.status,
          });
          statuses.push(session.status);
          if (session.phase) phases.push(session.phase);
          writers.push(writer(session, false, inPlaceRepo.get(row)?.get(session.id) ?? row.solution.name));
        }
        const conflict = row.readOnly ? NO_CONFLICT : repoConflict(writers);
        if (branches.length === 0 && head) branches.push({ branch: head, worktree: null, sessionId: null, owner: IDLE_OWNER, ownerTitle: null, status: 'idle' });

        const ledger = await this.#ledger(row.repo);
        const delta = changes.get(row) ?? { added: 0, removed: 0 };
        enriched.set(row.solution, {
          ...row.solution,
          status: row.readOnly ? 'idle' : solutionStatus(statuses),
          phase: row.readOnly ? '—' : solutionPhase(ledger, phases),
          changes: changesText(delta.added, delta.removed, row.readOnly),
          flag: conflict.flag,
          conflict: conflict.conflict,
          conflictSessions: conflict.sessions,
          branches,
          ledger,
          artifacts: await this.#followups(row),
          codebaseMemory: dirty ? solutionFreshness(dirty.projects, dirty.roots, row.solution.relativePath) : 'unknown',
        });
      }),
    );
    return groups.map((group) => ({ ...group, solutions: group.solutions.map((solution) => enriched.get(solution) ?? solution) }));
  }

  /**
   * Which row a session's solution string means (cached per call): the row of the
   * session's worktree for that name; else, for a session of the shown folder,
   * the worktree manager's resolution done in memory (a workspace: a unique git
   * checkout among the writable rows; a repo: its one row); else (a session of
   * another folder) the repo it resolves to in its own folder, when that repo is
   * a row here.
   */
  #rowResolver(
    folder: FolderRef,
    scan: WorkspaceScan,
    writable: readonly Row[],
    shownRoots: ReadonlySet<string>,
    worktrees: readonly WorktreeRecord[],
  ): (session: SessionRecord, solution: string) => Promise<Row | null> {
    const cache = new Map<string, Promise<Row | null>>();
    const byCanonical = (repoPath: string): Row | null => writable.find((row) => row.git && row.canonical === repoPath) ?? null;
    const resolveHere = (solution: string): Row | null => {
      if (folder.kind === 'repo') return writable.find((row) => row.git && row.solution.name === solution) ?? null;
      const candidates = new Set(solutionCandidates(scan.root, solution) ?? []);
      const matches = writable.filter((row) => row.git && (candidates.has(row.solution.path) || candidates.has(row.repo)));
      return matches.length === 1 ? (matches[0] as Row) : null;
    };
    return (session, solution) => {
      const key = `${session.id}\u0000${solution}`;
      let found = cache.get(key);
      if (!found) {
        found = (async (): Promise<Row | null> => {
          const own = worktrees.find((w) => w.sessionId === session.id && w.repo === solution);
          if (own) return byCanonical(own.repoPath);
          const home = folderOfSession(session);
          if (!home || (shownRoots.has(home.root) && home.kind === folder.kind)) return resolveHere(solution);
          if (!this.#resolveRepo) return null;
          try {
            return byCanonical((await this.#resolveRepo(solution, home)).repoPath);
          } catch {
            return null;
          }
        })();
        cache.set(key, found);
      }
      return found;
    };
  }

  /** Lines added / removed per row by the sessions' diffs (gap #10); a failing diff counts nothing. */
  async #changes(
    sessionIds: readonly string[],
    resolve: (sessionId: string, solution: string) => Promise<Row | null>,
  ): Promise<Map<Row, { added: number; removed: number }>> {
    const totals = new Map<Row, { added: number; removed: number }>();
    const diff = this.#diff;
    if (!diff) return totals;
    const results = await Promise.all(
      sessionIds.map(async (id) => ({
        id,
        files: await diff.diff(id).catch((error: unknown): FileDiff[] => {
          this.#onError(error);
          return [];
        }),
      })),
    );
    for (const { id, files } of results) for (const file of files) {
      const row = await resolve(id, file.solution);
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

  /** The row's "Artifacts & follow-ups": its `mobile-followups/*.md` files (FOLLOWUP, no meta), by name. */
  async #followups(row: Row): Promise<SolutionArtifact[]> {
    let entries: Dirent[] = [];
    try {
      entries = await readdir(path.join(row.repo, FOLLOWUPS_FOLDER), { withFileTypes: true });
    } catch (error) {
      if (!isGone(error)) this.#onError(error);
    }
    const files = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => `${FOLLOWUPS_FOLDER}/${entry.name}`)
      .sort();
    return files.map((name) => ({ type: 'FOLLOWUP', name, meta: '', sessionId: null }));
  }
}

/** An open session writing a row, for the conflict rule (M6.3). */
function writer(session: SessionRecord, isolated: boolean, repo: string): RepoWriter {
  return { sessionId: session.id, name: session.name, title: session.title, createdAt: session.createdAt, isolated, repo, attached: session.attached };
}

/**
 * A worktree path as the detail panel shows it: next to the repo (gap #1,
 * `../{repo}-wt-{session}`) it is given in the configured root's form (so the UI
 * can print `../<folder>`), anywhere else as stored.
 */
function displayWorktreePath(row: Row, worktreePath: string): string {
  if (path.dirname(worktreePath) === path.dirname(row.canonical)) {
    return path.join(path.dirname(row.repo), path.basename(worktreePath));
  }
  return worktreePath;
}
