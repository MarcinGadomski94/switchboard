import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileDiff, Solution, SolutionArtifact, SolutionBranch, SolutionGroup } from '../../core/api.ts';
import type { Phase, SessionStatus } from '../../core/model.ts';
import { kindTag } from '../../core/artifacts.ts';
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
import { SessionRepos } from '../worktrees/session-repos.ts';
import { SessionTouchedFiles } from '../worktrees/touched.ts';
import { isMainCheckout, isWorkingTreeTop, linkedWorktreeOf } from './checkout.ts';
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
  /**
   * 2026-10-14: the repositories each session works in (`session-repos.ts`, the
   * worktree manager's `repos`: the one answer checkpoints and the Diff tab read),
   * which decides where a session writes and whether it is isolated. Defaults to
   * its own over the store.
   */
  readonly repos?: Pick<SessionRepos, 'of'>;
  /** Called when a live field could not be read (default: ignored; the field stays neutral). */
  readonly onError?: (error: unknown) => void;
}

/** One live session working in a row's main checkout, with the `{repo}` to isolate it with (M6.3). */
interface InPlaceWriter {
  readonly session: SessionRecord;
  readonly repo: string;
}

/** One live session working in a linked worktree of a row that Switchboard did not register. */
interface LinkedWriter {
  readonly session: SessionRecord;
  /** The worktree's top folder (real path). */
  readonly top: string;
  readonly branch: string | null;
  readonly repo: string;
}

/** Where the live sessions write, per row. */
interface Placement {
  readonly inPlace: Map<Row, InPlaceWriter[]>;
  readonly linked: Map<Row, LinkedWriter[]>;
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
 * - **ledger**: `phase-ledger.md` (gap #12); **artifacts**: D89: the saved
 *   artifacts of the sessions whose solutions include it (newest first), then
 *   its `mobile-followups/*.md`;
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
  readonly #repos: Pick<SessionRepos, 'of'>;
  readonly #onError: (error: unknown) => void;

  constructor(options: LiveSolutionsOptions) {
    this.#store = options.store;
    this.#repos = options.repos ?? new SessionRepos({ store: options.store, touched: new SessionTouchedFiles({ store: options.store }) });
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

    const [sessions, registered, everWorktrees, saved, dirty] = await Promise.all([
      // D106: chats work in no solution (and write nothing): left out of rows and conflicts.
      this.#store.sessions.list().then((list) => list.filter((session) => session.kind !== 'chat')),
      this.#store.worktrees.list(),
      // 2026-10-14: the removed ones too, so a repo the session left for a worktree does not read as "in place".
      this.#store.worktrees.list({ includeRemoved: true }),
      this.#store.artifacts.list(),
      folder.kind === 'workspace' ? readDirtyList(scan.root) : Promise.resolve(null),
    ]);
    if (dirty?.state === 'unreadable') this.#onError(dirty.error);
    // 2026-10-14: a registered worktree whose folder is gone (removed outside Switchboard) is a leftover, not a branch.
    const present = await Promise.all(registered.map(async (worktree) => ((await isWorkingTreeTop(worktree.path)) ? worktree : null)));
    const worktrees = present.filter((worktree): worktree is WorktreeRecord => worktree !== null);
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const writable = rows.filter((row) => !row.readOnly);
    const shownRoots = new Set([folder.root, folder.path]);
    const rowOf = this.#rowResolver(folder, scan, writable, shownRoots, worktrees);

    // D89 ruling 2026-10-09: the saved artifacts of every session whose solutions include the row (newest first).
    const savedByRow = new Map<Row, SolutionArtifact[]>();
    for (const artifact of saved) {
      const session = artifact.sessionId ? sessionsById.get(artifact.sessionId) : undefined;
      if (!session) continue;
      const seen = new Set<Row>();
      for (const name of session.solutions) {
        const row = await rowOf(session, name);
        if (!row || seen.has(row)) continue;
        seen.add(row);
        savedByRow.set(row, [...(savedByRow.get(row) ?? []), { type: kindTag(artifact), name: artifact.title, meta: `v${artifact.versions}`, sessionId: session.id, artifactId: artifact.id }]);
      }
    }

    // Registered worktrees per row (by canonical repo path), owned by the session they belong to now (D83: its successor).
    const ownerOf = (worktree: WorktreeRecord): SessionRecord | null => successor(worktree.sessionId ? (sessionsById.get(worktree.sessionId) ?? null) : null, sessionsById);
    const worktreesByRow = new Map<Row, WorktreeRecord[]>();
    for (const worktree of worktrees) {
      const row = writable.find((candidate) => candidate.canonical === worktree.repoPath);
      if (!row) continue;
      worktreesByRow.set(row, [...(worktreesByRow.get(row) ?? []), worktree]);
    }

    // 2026-10-14: where each live session really writes, from the shared repo set (session-repos.ts).
    const placement = await this.#placement(
      // Oldest first, so the rows list their sessions in a stable order.
      sessions.filter(isLiveWriter).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.name.localeCompare(b.name))),
      writable,
      everWorktrees,
      rowOf,
    );
    const changes = await this.#changes(
      [...new Set([...[...worktreesByRow.values()].flat().flatMap((w) => (w.sessionId ? [w.sessionId] : [])), ...[...placement.inPlace.values()].flat().map((p) => p.session.id)])],
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
          const session = ownerOf(worktree);
          // 2026-10-14: a closed, moved or continued session's worktree stays listed (its folder is there) but is idle and writes nothing.
          const open = session !== null && isOpenSession(session);
          branches.push({
            branch: worktree.branch,
            worktree: displayWorktreePath(row, worktree.path),
            sessionId: session?.id ?? null,
            owner: session?.name ?? NO_SESSION_OWNER,
            // D22 (developer ruling 2026-09-28): the chip and card name the owner by its display title.
            ownerTitle: branchOwnerTitle(session),
            status: open ? session.status : 'idle',
          });
          if (open) statuses.push(session.status);
          if (session !== null && isLiveWriter(session)) {
            if (session.phase) phases.push(session.phase);
            writers.push(writer(session, true, worktree.repo));
          }
        }
        // Linked worktrees the live sessions work in that Switchboard did not register (agent-made `…-wt-…` folders).
        for (const linked of placement.linked.get(row) ?? []) {
          branches.push({
            branch: linked.branch ?? '—',
            worktree: displayWorktreePath(row, linked.top),
            sessionId: linked.session.id,
            owner: linked.session.name,
            ownerTitle: branchOwnerTitle(linked.session),
            status: linked.session.status,
          });
          statuses.push(linked.session.status);
          if (linked.session.phase) phases.push(linked.session.phase);
          writers.push(writer(linked.session, true, linked.repo));
        }
        for (const { session, repo } of placement.inPlace.get(row) ?? []) {
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
          writers.push(writer(session, false, repo));
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
          artifacts: [...(savedByRow.get(row) ?? []), ...(await this.#followups(row))],
          codebaseMemory: dirty ? solutionFreshness(dirty.projects, dirty.roots, row.solution.relativePath) : 'unknown',
        });
      }),
    );
    return groups.map((group) => ({ ...group, solutions: group.solutions.map((solution) => enriched.get(solution) ?? solution) }));
  }

  /**
   * 2026-10-14 (stale Solutions and conflicts): where each **live** session writes,
   * from the shared repo set (`SessionRepos.of`):
   * - a working tree in its set that is a **linked worktree** (`.git` is a file:
   *   an agent-made `…-wt-…` folder) of a row's repo: the session is isolated
   *   there, shown as a branch of that row;
   * - a row's **main checkout** in its set: the session writes there in place
   *   only while it has its own **uncommitted** edits in it (developer ruling
   *   2026-10-14; the D90 `head` diff: its touched files with uncommitted
   *   changes). Naming the checkout (a declared solution, its cwd) or edits it
   *   committed do not make it a writer.
   */
  async #placement(
    live: readonly SessionRecord[],
    writable: readonly Row[],
    everWorktrees: readonly WorktreeRecord[],
    rowOf: (session: SessionRecord, solution: string) => Promise<Row | null>,
  ): Promise<Placement> {
    const inPlace = new Map<Row, InPlaceWriter[]>();
    const linked = new Map<Row, LinkedWriter[]>();
    const byCanonical = async (target: string): Promise<Row | null> => {
      const real = await realpath(target).catch(() => target);
      return writable.find((row) => row.git && row.canonical === real) ?? null;
    };
    const sets = await Promise.all(
      live.map(async (session) => ({
        session,
        set: await this.#repos.of(session).catch((error: unknown) => {
          this.#onError(error);
          return null;
        }),
      })),
    );
    for (const { session, set } of sets) {
      if (!set) continue;
      const mains: Array<{ readonly row: Row; readonly top: string; readonly name: string; readonly source: string }> = [];
      for (const repo of set.inPlace) {
        const link = await linkedWorktreeOf(repo.top);
        if (link) {
          const row = await byCanonical(link.main);
          if (!row) continue;
          const list = linked.get(row) ?? [];
          if (!list.some((known) => known.session.id === session.id && known.top === repo.top)) {
            linked.set(row, [...list, { session, top: repo.top, branch: link.head === null ? null : branchFromHead(link.head), repo: repo.name }]);
          }
          continue;
        }
        if (!(await isMainCheckout(repo.top))) continue;
        const row = await byCanonical(repo.top);
        if (row) mains.push({ row, top: repo.top, name: repo.name, source: repo.source });
      }
      // Developer ruling 2026-10-14: only its own uncommitted edits in the checkout make it a writer there (D90 `head`:
      // its touched files with uncommitted changes); naming the checkout, or edits it committed, do not.
      const edited = new Set(set.editedTops);
      let uncommitted: Promise<FileDiff[]> | null = null;
      for (const main of mains) {
        if (this.#diff) {
          // A registered worktree of the same name: its diff cannot be told apart from the checkout's; the session is isolated there.
          if (set.worktrees.some((worktree) => worktree.repo === main.name)) continue;
          const diff = this.#diff;
          uncommitted ??= diff.diff(session.id, undefined, 'head').catch((error: unknown): FileDiff[] => {
            this.#onError(error);
            return [];
          });
          if (!(await uncommitted).some((file) => file.solution === main.name && file.uncommitted)) continue;
        } else if (!edited.has(main.top)) {
          // Without the diff provider: its edits there, committed or not.
          continue;
        }
        const list = inPlace.get(main.row) ?? [];
        if (list.some((known) => known.session.id === session.id)) continue;
        inPlace.set(main.row, [...list, { session, repo: await this.#isolateName(session, main.row, main.source === 'solution' ? main.name : null, rowOf) }]);
      }
    }
    return { inPlace, linked };
  }

  /** The `{repo}` a session in place is isolated with: the solution it lists that means the row, else the declared name, else the row's name. */
  async #isolateName(session: SessionRecord, row: Row, declared: string | null, rowOf: (session: SessionRecord, solution: string) => Promise<Row | null>): Promise<string> {
    for (const name of session.solutions) if ((await rowOf(session, name)) === row) return name;
    return declared ?? row.solution.name;
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

/**
 * 2026-10-14: a session that still writes: open (not closed), not taken over to
 * another machine (D65 `movedTo`), not continued in a fresh session (D83
 * `continuedTo`: its successor counts instead), its process not ended (`done` /
 * `fail` after exit) and not a chat (D106). Team members (D100) count: they are
 * ordinary sessions, only hidden from the sidebar.
 */
export function isLiveWriter(session: SessionRecord): boolean {
  return isOpenSession(session) && session.endedAt === null;
}

/** 2026-10-14: a session still open here: not closed, not taken over to another machine (D65), not continued (D83), not a chat (D106). */
export function isOpenSession(session: SessionRecord): boolean {
  return session.kind !== 'chat' && session.closedAt === null && session.movedTo === null && session.continuedTo === null;
}

/** D83: the session a continued one lives on in (following `continuedTo`), else the session itself. */
function successor(session: SessionRecord | null, byId: ReadonlyMap<string, SessionRecord>): SessionRecord | null {
  let current = session;
  for (let hops = 0; current?.continuedTo && hops < 20; hops += 1) {
    const next = byId.get(current.continuedTo);
    if (!next) break;
    current = next;
  }
  return current;
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
