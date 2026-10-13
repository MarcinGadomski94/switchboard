import { type PlanChecks, checksFromRollup } from '../../core/plans.ts';
import { type RunResult, failureText, runCommand, succeeded } from '../exec.ts';

/** What the scheduler learns about one repo of a running item (`docs/plans.md` → *When an item is done*). */
export interface PlanRepoState {
  /** The repo's solution name. */
  readonly repo: string;
  /** The item's branch has commits beyond the commit it was cut from, or a PR. */
  readonly hasWork: boolean;
  /** Its work is in the target branch: its PR into the target was merged, or its tip is in the local / origin target. */
  readonly merged: boolean;
  /** The PR gh reports for the item's branch; `null` = none (or gh could not be asked). */
  readonly pr: { readonly url: string | null; readonly state: string; readonly baseRefName: string | null; readonly checks: PlanChecks; readonly mergeable: string | null } | null;
  /** `false` when the repo has no `origin` remote or gh could not be asked: only "merged into the target" counts there (no checks). */
  readonly ghAvailable: boolean;
  /** The branch conflicts with the target (gh's `mergeable: CONFLICTING`, else a local `git merge-tree`); only read when asked. */
  readonly conflict: boolean;
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
}

/** The real {@link PlanGitPort}: `git` and `gh` as child processes (`shell: false`), never pushing. */
export class PlanGit implements PlanGitPort {
  readonly #git: readonly string[];
  readonly #gh: readonly string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #timeout: number;

  constructor(options: PlanGitOptions) {
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
    if (hasOrigin) {
      const answer = await this.#runGh(repoPath, ['pr', 'view', branch, '--json', 'state,url,baseRefName,mergeable,statusCheckRollup,headRefOid']);
      if (succeeded(answer)) {
        ghAvailable = true;
        pr = parsePr(answer);
      } else if (/no pull requests? found/i.test(failureText(answer))) {
        ghAvailable = true;
      }
    }
    const targetRef = (await this.tip(repoPath, `refs/heads/${target}`)) !== null ? target : (await this.tip(repoPath, `refs/remotes/origin/${target}`)) !== null ? `origin/${target}` : null;
    const committed = tip !== null && cut !== null && tip !== cut;
    let localMerged = false;
    if (committed && tip !== null) {
      for (const ref of [`refs/heads/${target}`, `refs/remotes/origin/${target}`]) {
        if ((await this.tip(repoPath, ref)) === null) continue;
        if (succeeded(await this.#run(repoPath, ['merge-base', '--is-ancestor', tip, ref]))) {
          localMerged = true;
          break;
        }
      }
    }
    const prMerged = pr !== null && pr.state === 'MERGED' && (pr.baseRefName === null || pr.baseRefName === target);
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
    return { repo: input.repo, hasWork: committed || pr !== null, merged, pr, ghAvailable, conflict };
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
  };
}
