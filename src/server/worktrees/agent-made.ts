import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { type WorktreeEvidence, evidenceNames, worktreeEvidence } from '../../core/agent-worktrees.ts';
import { AGENT_WORKTREES_SCANNED_SETTING } from '../../core/auto-clean.ts';
import { parseWorktreeList } from '../../core/worktrees.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';
import type { Store } from '../db/store.ts';
import { type RunResult, failureText, runCommand, succeeded } from '../exec.ts';
import { type FolderRef, folderOfSession, repoSolutionName } from '../folders/ref.ts';
import type { AdoptionRepo } from './manager.ts';

/** Options of {@link AgentWorktrees}. */
export interface AgentWorktreesOptions {
  readonly store: Store;
  readonly gitCommand?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** A workspace folder's solution repositories (default: none; the app passes D38's `scannedRepos`). */
  readonly repos?: (folder: FolderRef) => Promise<AdoptionRepo[]>;
  readonly now?: () => number;
  /** Event ids read per window (default 5 000). */
  readonly window?: number;
  readonly onError?: (error: unknown) => void;
}

/** A worktree may have been made this long before its session's start (clocks, a start in progress). */
const BEFORE_START_SLACK_MS = 60_000;
/** A call whose result has not arrived is read again for this long. */
const PENDING_MS = 24 * 3_600_000;
const NEEDLE = 'orktree';

interface Found {
  readonly sessionId: string;
  readonly evidence: WorktreeEvidence;
}

/**
 * D145 (`docs/worktrees.md` → *Worktrees an agent made*; D38 extended): the worktrees the
 * agents of Switchboard's sessions make themselves become Switchboard's (a `worktrees` row with
 * the session), so the automatic clean-up (and Clean-up, D84) may remove them once merged:
 * Claude Code's `EnterWorktree` (`<repo>/.claude/worktrees/<name>`), an `Agent` / `Task` run
 * with `isolation: "worktree"` (its result names the worktree it kept), and a Bash
 * `git worktree add` in any session (D38 adopts only a workspace session's, by its branch).
 *
 * The evidence is read from the sessions' stored tool events (every session, once: a high-water
 * mark in the settings, read in id windows; a call whose result is still missing is read again
 * later). A worktree is adopted only when git lists it in a repository of that session (the
 * path the call named, the session's folder, its working folder), the call names it (its path,
 * its `.claude/worktrees/<name>`, or a `git worktree add`'s folder / `-b` branch), and it was
 * made after the session started. Never a main checkout, a worktree another row has, a detached
 * one, or a terminal (hooked) session's: a worktree made by hand outside a supervised session
 * has no such call.
 */
export class AgentWorktrees {
  readonly #store: Store;
  readonly #git: readonly string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #repos: (folder: FolderRef) => Promise<AdoptionRepo[]>;
  readonly #now: () => number;
  readonly #window: number;
  readonly #onError: (error: unknown) => void;
  /** Tool calls whose result has not arrived yet: event id → first seen (ms). */
  readonly #pending = new Map<number, number>();
  #running: Promise<WorktreeRecord[]> | null = null;

  constructor(options: AgentWorktreesOptions) {
    this.#store = options.store;
    this.#git = options.gitCommand ?? ['git'];
    this.#env = options.env ?? process.env;
    this.#repos = options.repos ?? (async () => []);
    this.#now = options.now ?? Date.now;
    this.#window = options.window ?? 5_000;
    this.#onError = options.onError ?? ((error) => console.error('switchboard agent worktrees:', error));
  }

  /** Reads the tool events stored since the last scan and adopts what they name. One scan at a time (a second call joins it). */
  scan(): Promise<WorktreeRecord[]> {
    this.#running ??= this.#scanNow().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #scanNow(): Promise<WorktreeRecord[]> {
    const found: Found[] = [];
    // The calls still waiting for a result.
    for (const [id, since] of [...this.#pending]) {
      const event = await this.#store.events.get(id);
      const evidence = event ? worktreeEvidence(event.payload) : null;
      if (!event || evidence === null || this.#now() - since > PENDING_MS) {
        this.#pending.delete(id);
        continue;
      }
      if (evidence.complete) this.#pending.delete(id);
      found.push({ sessionId: event.sessionId, evidence });
    }
    const stored = await this.#store.settings.get(AGENT_WORKTREES_SCANNED_SETTING);
    let from = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
    const upto = await this.#store.events.maxId();
    if (upto < from) from = 0;
    while (from < upto) {
      const to = Math.min(upto, from + this.#window);
      for (const event of await this.#store.events.toolEventsMentioning(from, to, NEEDLE)) {
        const evidence = worktreeEvidence(event.payload);
        if (evidence === null) continue;
        if (!evidence.complete) this.#pending.set(event.id, this.#now());
        found.push({ sessionId: event.sessionId, evidence });
      }
      from = to;
      await this.#store.settings.set(AGENT_WORKTREES_SCANNED_SETTING, from);
      // Let other work run between windows.
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (found.length === 0) return [];
    const bySession = new Map<string, WorktreeEvidence[]>();
    for (const item of found) bySession.set(item.sessionId, [...(bySession.get(item.sessionId) ?? []), item.evidence]);
    const adopted: WorktreeRecord[] = [];
    for (const [sessionId, evidence] of bySession) {
      try {
        adopted.push(...(await this.#adopt(sessionId, evidence)));
      } catch (error) {
        this.#onError(error);
      }
    }
    return adopted;
  }

  async #adopt(sessionId: string, evidence: readonly WorktreeEvidence[]): Promise<WorktreeRecord[]> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session || session.hooked) return [];
    const started = Date.parse(session.createdAt);
    const adopted: WorktreeRecord[] = [];
    for (const repo of await this.#candidateRepos(session, evidence)) {
      const listed = await this.#runGit(repo.repoPath, ['worktree', 'list', '--porcelain']);
      if (!succeeded(listed)) {
        this.#onError(new Error(`git worktree list failed in ${repo.repoPath}: ${failureText(listed)}`));
        continue;
      }
      const [main, ...others] = parseWorktreeList(listed.stdout);
      const repoPaths = [repo.repoPath, ...(main ? [main.path] : [])];
      for (const entry of others) {
        if (entry.bare || entry.prunable || entry.branch === null) continue;
        let real: string;
        try {
          real = await realpath(entry.path);
        } catch {
          continue;
        }
        if (repoPaths.includes(real) || (await this.#store.worktrees.getLiveByPath(real)) || (await this.#store.worktrees.getLiveByPath(entry.path))) continue;
        if (!evidence.some((item) => evidenceNames(item, { paths: [entry.path, real], branch: entry.branch }, repoPaths))) continue;
        const born = await this.#bornAt(real);
        if (born !== null && Number.isFinite(started) && born < started - BEFORE_START_SLACK_MS) continue;
        adopted.push(
          await this.#store.worktrees.create({
            repo: repo.solution,
            repoPath: repo.repoPath,
            branch: entry.branch,
            baseRef: main?.branch ?? main?.head ?? null,
            path: real,
            sessionId: session.id,
          }),
        );
      }
    }
    return adopted;
  }

  /** The repositories (main checkouts) to look in: those the calls' paths are in, the session's folder's, its working folder's. */
  async #candidateRepos(session: SessionRecord, evidence: readonly WorktreeEvidence[]): Promise<AdoptionRepo[]> {
    const out: AdoptionRepo[] = [];
    const seen = new Set<string>();
    const add = async (repoPath: string | null, solution: string | null): Promise<void> => {
      if (repoPath === null) return;
      let real: string;
      try {
        real = await realpath(repoPath);
      } catch {
        return;
      }
      if (seen.has(real)) return;
      seen.add(real);
      out.push({ solution: solution ?? path.basename(real), repoPath: real });
    };
    for (const item of evidence) {
      for (const file of item.paths) {
        const marker = file.replace(/\\/g, '/').indexOf('/.claude/worktrees/');
        if (marker > 0) await add(file.slice(0, marker), null);
        else await add(await this.#mainCheckoutOf(file), null);
      }
    }
    const folder = folderOfSession(session);
    if (folder?.kind === 'repo') await add(folder.root, repoSolutionName(folder));
    if (folder?.kind === 'workspace') {
      for (const repo of await this.#repos(folder).catch((error: unknown) => (this.#onError(error), [] as AdoptionRepo[]))) await add(repo.repoPath, repo.solution);
    }
    if (session.cwd) await add(await this.#mainCheckoutOf(session.cwd), null);
    return out;
  }

  /** The main checkout of the repository `dir` is in (its common `.git` folder's parent), else `null`. */
  async #mainCheckoutOf(dir: string): Promise<string | null> {
    const result = await this.#runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const common = result.stdout.trim();
    if (!succeeded(result) || common === '' || path.basename(common) !== '.git') return null;
    return path.dirname(common);
  }

  /** When the worktree was made: the birth time of its folder in the repository's `.git/worktrees/`; `null` when unknown. */
  async #bornAt(worktree: string): Promise<number | null> {
    try {
      const link = (await readFile(path.join(worktree, '.git'), 'utf8')).trim();
      const match = /^gitdir:\s*(.+)$/m.exec(link);
      if (!match) return null;
      const admin = path.resolve(worktree, (match[1] as string).trim());
      const info = await stat(admin);
      return info.birthtimeMs > 0 ? info.birthtimeMs : null;
    } catch {
      return null;
    }
  }

  async #runGit(cwd: string, args: readonly string[]): Promise<RunResult> {
    try {
      await stat(cwd);
    } catch {
      return { code: 1, signal: null, stdout: '', stderr: `${cwd} does not exist`, error: null, timedOut: false };
    }
    return runCommand(this.#git, args, { cwd, env: { ...this.#env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 60_000 });
  }

  /** Waits for a scan in progress. */
  async close(): Promise<void> {
    await this.#running?.catch(() => undefined);
  }
}
