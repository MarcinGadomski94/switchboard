import { ISSUE_BODY_MAX, ISSUE_IMPORT_MAX, PR_WATCH_FIELDS, type PrReading, parsePrReading } from '../../core/ci.ts';
import { isNoPullRequest } from '../../core/worktrees.ts';
import { type RunResult, failureText, runCommand, succeeded } from '../exec.ts';

/** A merge method gh takes (`gh pr merge --squash | --merge | --rebase`). */
export type GhMergeMethod = 'squash' | 'merge' | 'rebase';

/** What `gh pr view` answered. */
export type PrViewResult = { readonly kind: 'pr'; readonly pr: PrReading } | { readonly kind: 'none' } | { readonly kind: 'error'; readonly message: string };

/** One issue `gh issue list` answered. */
export interface GhIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly url: string | null;
  readonly labels: readonly string[];
}

/**
 * D109: the gh calls of the PR watcher, its Merge PR and the GitHub issue import. The
 * watcher's unit tests pass a fake; the real one runs `gh` (`shell: false`, no prompts).
 * Never logs or answers a credential (gh keeps its own login).
 */
export interface CiGhPort {
  /** `gh pr view <selector> --json {@link PR_WATCH_FIELDS}` in `cwd`. */
  viewPr(cwd: string, selector: string): Promise<PrViewResult>;
  /** The failed jobs' log of an Actions run (`gh run view <run> --log-failed [--job <job>]`); `null` when it could not be read. */
  failedLog(cwd: string, runId: string, jobId: string | null): Promise<string | null>;
  /** The repository's default merge method as gh reports it (`viewerDefaultMergeMethod`), else `null`. */
  defaultMergeMethod(cwd: string): Promise<GhMergeMethod | null>;
  /** `gh pr merge <number> --<method>`: never `--admin`, never `--auto`, the branch is kept. */
  mergePr(cwd: string, number: number, method: GhMergeMethod): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /** `gh issue list --repo <repo> --state open …`, at most {@link ISSUE_IMPORT_MAX} (+1 to tell it was cut). */
  listIssues(cwd: string, input: { readonly repo: string; readonly label: string | null; readonly mine: boolean }): Promise<{ readonly ok: true; readonly issues: GhIssue[] } | { readonly ok: false; readonly message: string }>;
  /** The `owner/repo` of `origin` in `cwd` (`gh repo view --json nameWithOwner`), else `null`. */
  repoName(cwd: string): Promise<string | null>;
}

/** Options of {@link CiGh}. */
export interface CiGhOptions {
  readonly gh: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The real {@link CiGhPort}. */
export class CiGh implements CiGhPort {
  readonly #gh: readonly string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #timeout: number;

  constructor(options: CiGhOptions) {
    this.#gh = options.gh;
    this.#env = options.env ?? process.env;
    this.#timeout = options.timeoutMs ?? 60_000;
  }

  #run(cwd: string, args: readonly string[], maxOutputBytes?: number): Promise<RunResult> {
    return runCommand(this.#gh, args, { cwd, env: { ...this.#env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }, timeoutMs: this.#timeout, ...(maxOutputBytes ? { maxOutputBytes } : {}) });
  }

  async viewPr(cwd: string, selector: string): Promise<PrViewResult> {
    const result = await this.#run(cwd, ['pr', 'view', selector, '--json', PR_WATCH_FIELDS]);
    if (succeeded(result)) {
      const pr = parsePrReading(result.stdout);
      return pr && pr.number > 0 ? { kind: 'pr', pr } : { kind: 'error', message: `gh pr view printed an unexpected shape: ${result.stdout.slice(0, 200)}` };
    }
    if (result.error === null && isNoPullRequest(result.stderr)) return { kind: 'none' };
    return { kind: 'error', message: `gh pr view failed: ${failureText(result)}` };
  }

  async failedLog(cwd: string, runId: string, jobId: string | null): Promise<string | null> {
    const args = ['run', 'view', runId, '--log-failed', ...(jobId ? ['--job', jobId] : [])];
    // A log can be large: keep the read bounded (its tail is all that is sent).
    const result = await this.#run(cwd, args, 8 * 1024 * 1024);
    return succeeded(result) && result.stdout.trim() !== '' ? result.stdout : null;
  }

  async defaultMergeMethod(cwd: string): Promise<GhMergeMethod | null> {
    const result = await this.#run(cwd, ['repo', 'view', '--json', 'viewerDefaultMergeMethod']);
    if (!succeeded(result)) return null;
    try {
      const value = record(JSON.parse(result.stdout))?.['viewerDefaultMergeMethod'];
      const upper = typeof value === 'string' ? value.toUpperCase() : '';
      return upper === 'SQUASH' ? 'squash' : upper === 'MERGE' ? 'merge' : upper === 'REBASE' ? 'rebase' : null;
    } catch {
      return null;
    }
  }

  async mergePr(cwd: string, number: number, method: GhMergeMethod): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
    const result = await this.#run(cwd, ['pr', 'merge', String(number), `--${method}`]);
    return succeeded(result) ? { ok: true } : { ok: false, message: failureText(result).slice(0, 500) };
  }

  async listIssues(cwd: string, input: { readonly repo: string; readonly label: string | null; readonly mine: boolean }): Promise<{ readonly ok: true; readonly issues: GhIssue[] } | { readonly ok: false; readonly message: string }> {
    const args = ['issue', 'list', '--repo', input.repo, '--state', 'open', '--limit', String(ISSUE_IMPORT_MAX + 1), '--json', 'number,title,body,url,labels'];
    if (input.label) args.push('--label', input.label);
    if (input.mine) args.push('--assignee', '@me');
    const result = await this.#run(cwd, args);
    if (!succeeded(result)) return { ok: false, message: `gh issue list failed: ${failureText(result).slice(0, 300)}` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { ok: false, message: 'gh issue list printed something that is not JSON' };
    }
    const issues = (Array.isArray(parsed) ? parsed : [])
      .map(record)
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry['number'] === 'number' && typeof entry['title'] === 'string')
      .map((entry) => ({
        number: entry['number'] as number,
        title: entry['title'] as string,
        body: typeof entry['body'] === 'string' && entry['body'].trim() !== '' ? entry['body'].slice(0, ISSUE_BODY_MAX * 2) : null,
        url: typeof entry['url'] === 'string' ? entry['url'] : null,
        labels: (Array.isArray(entry['labels']) ? entry['labels'] : []).map((label) => record(label)?.['name']).filter((name): name is string => typeof name === 'string'),
      }));
    return { ok: true, issues };
  }

  async repoName(cwd: string): Promise<string | null> {
    const result = await this.#run(cwd, ['repo', 'view', '--json', 'nameWithOwner']);
    if (!succeeded(result)) return null;
    try {
      const name = record(JSON.parse(result.stdout))?.['nameWithOwner'];
      return typeof name === 'string' && name.includes('/') ? name : null;
    } catch {
      return null;
    }
  }
}
