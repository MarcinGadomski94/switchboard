import { type PlanChecks, checksFromRollup } from '../../core/plans.ts';
import type { PrViewResult } from '../ci/gh.ts';
import { type RunResult, failureText, runCommand, succeeded } from '../exec.ts';

/** What the scheduler learns about one repo of a running item (`docs/plans.md` → *When an item is done*). */
export interface PlanRepoState {
  /** The repo's solution name. */
  readonly repo: string;
  /** The item's branch has commits of its own beyond the commit it was cut from (D121), or a PR. */
  readonly hasWork: boolean;
  /**
   * D121: its work is in the target branch: its PR into the target is merged (gh `MERGED`; closed
   * or open never counts), or the branch has commits of its own and its tip is in the local
   * target or in `origin/<target>` (the remote-tracking ref as it is: no fetch). A branch without
   * commits of its own is never merged.
   */
  readonly merged: boolean;
  /** The PR gh reports for the item's branch; `null` = none (or gh could not be asked). */
  readonly pr: { readonly url: string | null; readonly state: string; readonly baseRefName: string | null; readonly checks: PlanChecks; readonly mergeable: string | null; readonly headRefOid?: string | null } | null;
  /** `false` when the repo has no `origin` remote or gh could not be asked: only "merged into the target" counts there (no checks). */
  readonly ghAvailable: boolean;
  /** The branch conflicts with the target (gh's `mergeable: CONFLICTING`, else a local `git merge-tree`); only read when asked. */
  readonly conflict: boolean;
  /**
   * D121: not merged, but that is not proven: the branch is gone (a cleanup removes merged
   * branches), or the repo has an `origin` and its PR could not be read. The auto-repair never
   * reopens an item on such a reading. Absent = `false`.
   */
  readonly unknown?: boolean;
}

/** One repo of an item for {@link PlanGitPort.inspect}. */
export interface PlanRepoInput {
  readonly repo: string;
  /** The repo's main checkout. */
  readonly repoPath: string;
  readonly branch: string;
  readonly target: string;
  /** The target's tip the item's worktree was cut from; `null` = not known. */
  readonly cut: string | null;
}

/**
 * D99: the git / gh reads and the one write (creating a missing target branch) behind the
 * plan scheduler; the scheduler's unit tests pass a fake.
 */
export interface PlanGitPort {
  /**
   * The ref an item's worktree is cut from in `repoPath`: the local `target`, else
   * `origin/<target>`; when neither exists, `target` is created (locally, never pushed) from
   * the local `base` or `origin/<base>`. Fails when neither the target nor the base exists.
   */
  prepareTarget(repoPath: string, target: string, base: string): Promise<{ readonly ok: true; readonly ref: string; readonly created: boolean } | { readonly ok: false; readonly message: string }>;
  /** The repo's default branch (`origin/HEAD`) and whether `target` is protected (gh, best effort). */
  targetFacts(repoPath: string, target: string): Promise<{ readonly defaultBranches: readonly string[]; readonly protectedBranches: readonly string[] }>;
  /** The commit `ref` points at, `null` when it does not exist. */
  tip(repoPath: string, ref: string): Promise<string | null>;
  /** Reads the state of one repo of a running item; `conflicts` also checks for a conflict with the target. */
  inspect(input: PlanRepoInput, options?: { readonly conflicts?: boolean }): Promise<PlanRepoState>;
}

/** Options of {@link PlanGit}. */
export interface PlanGitOptions {
  readonly git?: readonly string[];
  readonly gh: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /**
   * D109: the shared PR watcher's reading (`PrWatcher.read`): an item's PR, its checks and
   * mergeable state come from the one reading the watcher keeps, instead of a gh call of Plans'
   * own. Absent = Plans asks gh itself (tests).
   */
  readonly prs?: (repoPath: string, branch: string) => Promise<PrViewResult>;
}

/** The real {@link PlanGitPort}: `git` and `gh` as child processes (`shell: false`), never pushing. */
export class PlanGit implements PlanGitPort {
  readonly #git: readonly string[];
  readonly #gh: readonly string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #timeout: number;
  readonly #prs: PlanGitOptions['prs'] | null;

  constructor(options: PlanGitOptions) {
    this.#prs = options.prs ?? null;
    this.#git = options.git ?? ['git'];
    this.#gh = options.gh;
    this.#env = options.env ?? process.env;
    this.#timeout = options.timeoutMs ?? 60_000;
  }

  async tip(repoPath: string, ref: string): Promise<string | null> {
    const result = await this.#run(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return succeeded(result) ? result.stdout.trim() || null : null;
  }

  async prepareTarget(repoPath: string, target: string, base: string): Promise<{ readonly ok: true; readonly ref: string; readonly created: boolean } | { readonly ok: false; readonly message: string }> {
    if ((await this.tip(repoPath, `refs/heads/${target}`)) !== null) return { ok: true, ref: target, created: false };
    if ((await this.tip(repoPath, `refs/remotes/origin/${target}`)) !== null) return { ok: true, ref: `origin/${target}`, created: false };
    const from = (await this.tip(repoPath, `refs/heads/${base}`)) !== null ? base : (await this.tip(repoPath, `refs/remotes/origin/${base}`)) !== null ? `origin/${base}` : null;
    if (from === null) return { ok: false, message: `neither ${target} nor its base ${base} exists in ${repoPath}` };
    const created = await this.#run(repoPath, ['branch', '--no-track', target, from]);
    if (!succeeded(created)) return { ok: false, message: `could not create ${target} from ${from}: ${failureText(created)}` };
    return { ok: true, ref: target, created: true };
  }

  async targetFacts(repoPath: string, target: string): Promise<{ readonly defaultBranches: readonly string[]; readonly protectedBranches: readonly string[] }> {
    const defaults: string[] = [];
    const head = await this.#run(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (succeeded(head) && head.stdout.trim() !== '') defaults.push(head.stdout.trim().replace(/^origin\//, ''));
    const protectedBranches: string[] = [];
    if (await this.#hasOrigin(repoPath)) {
      // Best effort: gh answers the branch's protection; a failure (no access, no gh) is not a refusal.
      const answer = await this.#runGh(repoPath, ['api', `repos/{owner}/{repo}/branches/${target}`, '--jq', '.protected']);
      if (succeeded(answer) && answer.stdout.trim() === 'true') protectedBranches.push(target);
    }
    return { defaultBranches: defaults, protectedBranches };
  }

  async inspect(input: PlanRepoInput, options: { readonly conflicts?: boolean } = {}): Promise<PlanRepoState> {
    const { repoPath, branch, target, cut } = input;
    const tip = await this.tip(repoPath, `refs/heads/${branch}`);
    const hasOrigin = await this.#hasOrigin(repoPath);
    let pr: PlanRepoState['pr'] = null;
    let ghAvailable = false;
    if (hasOrigin && this.#prs) {
      // D109: through the shared PR watcher's reading.
      const answer = await this.#prs(repoPath, branch);
      if (answer.kind === 'pr') {
        ghAvailable = true;
        pr = { url: answer.pr.url, state: answer.pr.state, baseRefName: answer.pr.baseRefName, checks: answer.pr.checks, mergeable: answer.pr.mergeable, headRefOid: answer.pr.headRefOid };
      } else if (answer.kind === 'none') {
        ghAvailable = true;
      }
    } else if (hasOrigin) {
      const answer = await this.#runGh(repoPath, ['pr', 'view', branch, '--json', 'state,url,baseRefName,mergeable,statusCheckRollup,headRefOid']);
      if (succeeded(answer)) {
        ghAvailable = true;
        pr = parsePr(answer);
      } else if (/no pull requests? found/i.test(failureText(answer))) {
        ghAvailable = true;
      }
    }
    const targetRef = (await this.tip(repoPath, `refs/heads/${target}`)) !== null ? target : (await this.tip(repoPath, `refs/remotes/origin/${target}`)) !== null ? `origin/${target}` : null;
    // D121: the work of its own the branch has beyond where it started (see ownWork); none = never merged.
    const own = tip === null ? { start: cut, committed: false } : await this.#ownWork(repoPath, branch, tip, cut);
    const committed = own.committed;
    let localMerged = false;
    if (committed && tip !== null) {
      for (const ref of [`refs/heads/${target}`, `refs/remotes/origin/${target}`]) {
        if ((await this.tip(repoPath, ref)) === null) continue;
        if (await this.#isAncestor(repoPath, tip, ref)) {
          localMerged = true;
          break;
        }
      }
    }
    // D121: a PR counts only when GitHub says MERGED (a closed or open one never), into the target itself, with a head beyond the branch's start.
    const prHead = pr?.headRefOid ?? null;
    const prMerged = pr !== null && pr.state === 'MERGED' && pr.baseRefName === target && (prHead === null || own.start === null || prHead !== own.start);
    const merged = prMerged || localMerged;
    let conflict = false;
    if (options.conflicts === true && !merged && committed && tip !== null) {
      if (pr !== null && pr.mergeable === 'CONFLICTING') conflict = true;
      else if (targetRef !== null) {
        const tree = await this.#run(repoPath, ['merge-tree', '--write-tree', '--name-only', '--no-messages', targetRef, tip]);
        // Exit 1 = conflicts; other failures (an old git) are not taken for a conflict.
        conflict = tree.error === null && tree.code === 1;
      }
    }
    const unknown = !merged && (tip === null || (hasOrigin && !ghAvailable));
    return { repo: input.repo, hasWork: committed || pr !== null, merged, pr, ghAvailable, conflict, unknown };
  }

  /**
   * D121 (`docs/plans.md` → *Merge step*): whether branch `branch` (at `tip`) has work of its own,
   * and the commit it started from. The start is the commit its reflog says it was created from
   * (exact, also when the target moved between the scheduler's read of the cut and the worktree's
   * cut), else the recorded `cut`; with neither nothing is proven (no work). Work of its own: the
   * tip is beyond the start (`start` an ancestor of `tip`, `tip` ≠ `start`) and, when the reflog
   * tells, at least one entry that made a commit of its own (a commit, an amend, a cherry-pick, a
   * revert, a rebase that kept commits) is still on the branch. A branch only fast-forwarded,
   * reset or rebased onto newer target commits has no work of its own: it is never "merged".
   */
  async #ownWork(repoPath: string, branch: string, tip: string, cut: string | null): Promise<{ readonly start: string | null; readonly committed: boolean }> {
    const reflog = await this.#reflog(repoPath, branch);
    const oldest = reflog.at(-1);
    const created = oldest !== undefined && oldest.subject.startsWith('branch: Created from') ? oldest.sha : null;
    const start = created ?? cut;
    if (start === null || tip === start || !(await this.#isAncestor(repoPath, start, tip))) return { start, committed: false };
    // Without a reflog (expired, or switched off) the commits beyond the recorded cut are all there is to go by.
    if (created === null) return { start, committed: true };
    for (const entry of reflog) {
      if (entry.sha === start || !isOwnEntry(entry)) continue;
      if (!(await this.#isAncestor(repoPath, entry.sha, tip)) || (await this.#isAncestor(repoPath, entry.sha, start))) continue;
      return { start, committed: true };
    }
    return { start, committed: false };
  }

  /** The reflog of `refs/heads/<branch>`, newest first (`[]` when it has none). */
  async #reflog(repoPath: string, branch: string): Promise<Array<{ readonly sha: string; readonly subject: string }>> {
    const result = await this.#run(repoPath, ['reflog', 'show', '--format=%H %gs', `refs/heads/${branch}`, '--']);
    if (!succeeded(result)) return [];
    const out: Array<{ sha: string; subject: string }> = [];
    for (const line of result.stdout.split('\n')) {
      const match = /^([0-9a-f]{40,64}) (.*)$/.exec(line.trim());
      if (match) out.push({ sha: match[1] as string, subject: match[2] as string });
    }
    return out;
  }

  async #isAncestor(repoPath: string, ancestor: string, of: string): Promise<boolean> {
    return succeeded(await this.#run(repoPath, ['merge-base', '--is-ancestor', ancestor, of]));
  }

  async #hasOrigin(repoPath: string): Promise<boolean> {
    return succeeded(await this.#run(repoPath, ['remote', 'get-url', 'origin']));
  }

  #run(cwd: string, args: readonly string[]): Promise<RunResult> {
    return runCommand(this.#git, args, { cwd, env: { ...this.#env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: this.#timeout });
  }

  #runGh(cwd: string, args: readonly string[]): Promise<RunResult> {
    return runCommand(this.#gh, args, { cwd, env: { ...this.#env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }, timeoutMs: this.#timeout });
  }
}

/**
 * D121: a reflog entry that made a commit of the branch's own: `commit` / `commit (amend)`,
 * `cherry-pick`, `revert`, `am`, or a rebase / pull --rebase that ended on a commit other than the
 * one it went onto. A fast-forward, a reset, a merge commit or the branch's creation is not.
 */
function isOwnEntry(entry: { readonly sha: string; readonly subject: string }): boolean {
  if (/^commit( \(amend\))?: /.test(entry.subject) || /^(cherry-pick|revert|am)\b/.test(entry.subject)) return true;
  const rebase = /\(finish\): .* onto ([0-9a-f]{40,64})$/.exec(entry.subject);
  return rebase !== null && rebase[1] !== entry.sha;
}

function parsePr(result: RunResult): PlanRepoState['pr'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  const sha = typeof value['headRefOid'] === 'string' ? value['headRefOid'] : null;
  return {
    url: typeof value['url'] === 'string' ? value['url'] : null,
    state: typeof value['state'] === 'string' ? value['state'].toUpperCase() : 'OPEN',
    baseRefName: typeof value['baseRefName'] === 'string' ? value['baseRefName'] : null,
    checks: checksFromRollup(value['statusCheckRollup'], sha),
    mergeable: typeof value['mergeable'] === 'string' ? value['mergeable'].toUpperCase() : null,
    headRefOid: sha,
  };
}
