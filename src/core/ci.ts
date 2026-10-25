/**
 * D109 · the CI / pull-request feedback loop and the issue import (`docs/ci.md`,
 * `docs/todos.md` → *Import issues (D109)*). Shared by the server's PR watcher
 * (`src/server/ci/`), Plans (D99, which reads its PR checks through the same watcher)
 * and the UI (the session header's PR chip, the Import issues dialog). Pure: no I/O.
 */

// ── PR checks (moved here from Plans: one reading for everyone) ────────────

/** The state of a PR's checks: `pending` (running), `green`, `red`, `none` (no checks configured: counts as green). */
export type PrChecksState = 'pending' | 'green' | 'red' | 'none';

/** The checks of one PR head, summed up. */
export interface PrChecks {
  readonly state: PrChecksState;
  /** The failing (or pending) checks, one line; `null` when green / none. */
  readonly summary: string | null;
  /** The PR head the reading was for. */
  readonly sha: string | null;
}

const RED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
const PENDING_STATES = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);

function entriesOf(rollup: unknown): Array<Record<string, unknown>> {
  return Array.isArray(rollup) ? rollup.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null) : [];
}

function entryName(entry: Record<string, unknown>): string {
  return String(entry['name'] ?? entry['context'] ?? 'check');
}

function isRed(entry: Record<string, unknown>): boolean {
  const conclusion = typeof entry['conclusion'] === 'string' ? entry['conclusion'].toUpperCase() : '';
  const state = typeof entry['state'] === 'string' ? entry['state'].toUpperCase() : '';
  return RED_CONCLUSIONS.has(conclusion) || state === 'FAILURE' || state === 'ERROR';
}

function isPending(entry: Record<string, unknown>): boolean {
  const status = typeof entry['status'] === 'string' ? entry['status'].toUpperCase() : '';
  const state = typeof entry['state'] === 'string' ? entry['state'].toUpperCase() : '';
  return (status !== '' && status !== 'COMPLETED') || PENDING_STATES.has(state);
}

/**
 * The state of a PR's checks from gh's `statusCheckRollup` (`gh pr view --json
 * statusCheckRollup`): CheckRuns (`status`, `conclusion`, `name`) and StatusContexts
 * (`state`, `context`). Any red one → `red` (the summary names them); else any still
 * running → `pending`; no checks at all → `none` (counts as green); else `green`.
 */
export function checksFromRollup(rollup: unknown, sha: string | null = null): PrChecks {
  const entries = entriesOf(rollup);
  if (entries.length === 0) return { state: 'none', summary: null, sha };
  const red: string[] = [];
  const pending: string[] = [];
  for (const entry of entries) {
    if (isRed(entry)) red.push(entryName(entry));
    else if (isPending(entry)) pending.push(entryName(entry));
  }
  if (red.length > 0) return { state: 'red', summary: `failed: ${red.join(', ')}`, sha };
  if (pending.length > 0) return { state: 'pending', summary: `running: ${pending.join(', ')}`, sha };
  return { state: 'green', summary: null, sha };
}

/** One failing check of a PR head and where its log is. */
export interface FailingCheck {
  readonly name: string;
  /** The GitHub Actions run (`…/actions/runs/<id>/…` in its details URL); `null` = not an Actions check (no log to fetch). */
  readonly runId: string | null;
  /** The job within the run (`…/job/<id>`), when the URL names one. */
  readonly jobId: string | null;
  /** The check's details URL. */
  readonly url: string | null;
}

/** The red checks of a rollup, in its order, with their Actions run / job ids. */
export function failingChecks(rollup: unknown): FailingCheck[] {
  const out: FailingCheck[] = [];
  for (const entry of entriesOf(rollup)) {
    if (!isRed(entry)) continue;
    const url = typeof entry['detailsUrl'] === 'string' ? entry['detailsUrl'] : typeof entry['targetUrl'] === 'string' ? entry['targetUrl'] : null;
    const run = url ? /\/actions\/runs\/(\d+)/.exec(url) : null;
    const job = url ? /\/job\/(\d+)/.exec(url) : null;
    out.push({ name: entryName(entry), runId: run?.[1] ?? null, jobId: job?.[1] ?? null, url });
  }
  return out;
}

// ── one PR as gh reports it ─────────────────────────────────────────────────

/** The fields the watcher (and Plans) ask `gh pr view` for. */
export const PR_WATCH_FIELDS = 'number,state,url,headRefOid,baseRefName,headRefName,mergeable,isDraft,reviewDecision,statusCheckRollup';

/** gh's review decision: approved, changes requested, review required, or `null` (no review rule: not required). */
export type PrReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

/** A pull request read through `gh pr view --json {@link PR_WATCH_FIELDS}`. */
export interface PrReading {
  readonly number: number;
  /** `OPEN`, `MERGED`, `CLOSED` (upper case). */
  readonly state: string;
  readonly url: string | null;
  readonly headRefOid: string | null;
  readonly baseRefName: string | null;
  /** `MERGEABLE`, `CONFLICTING`, `UNKNOWN` (upper case), `null` = not reported. */
  readonly mergeable: string | null;
  readonly isDraft: boolean;
  readonly review: PrReviewDecision;
  readonly checks: PrChecks;
  readonly failing: readonly FailingCheck[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses `gh pr view --json …` output; `null` when it is not a PR (no number). */
export function parsePrReading(stdout: string): PrReading | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const number = parsed['number'];
  const sha = typeof parsed['headRefOid'] === 'string' && parsed['headRefOid'] !== '' ? parsed['headRefOid'] : null;
  const review = typeof parsed['reviewDecision'] === 'string' ? parsed['reviewDecision'].toUpperCase() : '';
  return {
    number: typeof number === 'number' && Number.isInteger(number) ? number : 0,
    state: typeof parsed['state'] === 'string' ? parsed['state'].toUpperCase() : 'OPEN',
    url: typeof parsed['url'] === 'string' ? parsed['url'] : null,
    headRefOid: sha,
    baseRefName: typeof parsed['baseRefName'] === 'string' ? parsed['baseRefName'] : null,
    mergeable: typeof parsed['mergeable'] === 'string' ? parsed['mergeable'].toUpperCase() : null,
    isDraft: parsed['isDraft'] === true,
    review: review === 'APPROVED' || review === 'CHANGES_REQUESTED' || review === 'REVIEW_REQUIRED' ? review : null,
    checks: checksFromRollup(parsed['statusCheckRollup'], sha),
    failing: failingChecks(parsed['statusCheckRollup']),
  };
}

/**
 * Ready to merge: open, not a draft, every check green (or none configured), not
 * conflicting, and approved, or no approval required (gh reports no review decision
 * when the branch protection asks for none).
 */
export function prReadyToMerge(pr: Pick<PrReading, 'state' | 'isDraft' | 'checks' | 'mergeable' | 'review'>): boolean {
  if (pr.state !== 'OPEN' || pr.isDraft) return false;
  if (pr.checks.state !== 'green' && pr.checks.state !== 'none') return false;
  if (pr.mergeable === 'CONFLICTING') return false;
  return pr.review === 'APPROVED' || pr.review === null;
}

// ── the CI failure message ──────────────────────────────────────────────────

/** Default lines of a failed job's log sent to the session. */
export const DEFAULT_CI_LOG_TAIL = 150;

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const LEADING_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/;

/**
 * The last `lines` lines of `gh run view --log-failed` output, without gh's `job\tstep\t`
 * columns, the timestamps and colour codes, and blank lines at the end; `''` for none.
 */
export function trimLogTail(log: string, lines: number = DEFAULT_CI_LOG_TAIL): string {
  const cleaned = log
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => {
      const parts = line.split('\t');
      const text = parts.length >= 3 ? parts.slice(2).join('\t') : line;
      return text.replace(LEADING_TIMESTAMP, '').replace(/\s+$/, '');
    });
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') cleaned.pop();
  return cleaned.slice(-Math.max(1, lines)).join('\n');
}

/** What {@link ciFailureMessage} names. */
export interface CiFailureInput {
  readonly checks: readonly string[];
  readonly prNumber: number;
  readonly branch: string;
  /** The trimmed log tail; `null` = no log could be read. */
  readonly excerpt: string | null;
  readonly attempt: number;
  readonly maxAttempts: number;
}

/**
 * D109: the message a red check sends to the session (a normal message: queued while it
 * works, held while every account pauses for credits, a hooked session's mailbox):
 * "CI failed: <check> — <log excerpt>. Fix it and push."
 */
export function ciFailureMessage(input: CiFailureInput): string {
  const names = input.checks.length > 0 ? input.checks.join(', ') : 'a check';
  const head = `CI failed: ${names} — on PR #${input.prNumber} (${input.branch}), attempt ${input.attempt} of ${input.maxAttempts}.`;
  const body = input.excerpt && input.excerpt.trim() !== '' ? `The end of the failing job's log:\n\n~~~text\n${input.excerpt}\n~~~` : 'Its log could not be read: open the check on GitHub (gh pr checks) to see why.';
  return `${head}\n\n${body}\n\nFix it and push.`;
}

/**
 * The same-failure breaker's signature: the failing checks' names and the log tail with
 * the parts that change on every run (timestamps, hashes, numbers, durations) taken out.
 */
export function failureSignature(checks: readonly string[], excerpt: string | null): string {
  const names = [...checks].sort().join('|');
  const text = (excerpt ?? '')
    .split('\n')
    .slice(-40)
    .join('\n')
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,64}\b/g, '#')
    .replace(/\d+(?:\.\d+)?/g, '0')
    .replace(/\s+/g, ' ')
    .trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${names}#${hash.toString(16)}`;
}

// ── the session's PRs as the API answers them ──────────────────────────────

/** Why the watcher stopped sending failures for a PR. */
export type CiStopReason = 'cap' | 'same-failure';

/** One watched PR of a session (`GET /api/sessions/{id}/ci`). */
export interface SessionPr {
  /** The worktree it belongs to (the watch's key). */
  readonly worktreeId: string;
  readonly repo: string;
  readonly branch: string;
  readonly number: number;
  readonly url: string | null;
  /** `OPEN`, `MERGED`, `CLOSED`. */
  readonly state: string;
  readonly checks: PrChecksState;
  /** The failing / running checks, one line. */
  readonly summary: string | null;
  readonly review: PrReviewDecision;
  /** Open, green and approved (or approval not required). */
  readonly ready: boolean;
  /** Failure messages sent for this PR. */
  readonly attempts: number;
  readonly maxAttempts: number;
  /** Set once the watcher stopped sending failures (Try again on the Inbox item resets it). */
  readonly stopped: CiStopReason | null;
  readonly checkedAt: string | null;
}

/** `GET /api/sessions/{id}/ci`: the session's watched PRs (newest first). */
export interface SessionCi {
  readonly prs: readonly SessionPr[];
}

/** The `ciChanged` `/hub` payload: a session's PR status changed (the header chip reads `GET …/ci` again). */
export interface CiChanged {
  readonly sessionId: string;
}

/** What the session header's chip shows. */
export type CiChipState = 'running' | 'failed' | 'green' | 'merged';

/** The session header's PR chip: the most urgent of its PRs (failed, running, green, merged); `null` = no chip (no PR, or only closed ones). */
export function ciChip(prs: readonly SessionPr[]): { readonly state: CiChipState; readonly label: string; readonly pr: SessionPr } | null {
  const open = prs.filter((pr) => pr.state === 'OPEN');
  const failed = open.find((pr) => pr.checks === 'red');
  if (failed) return { state: 'failed', label: `PR #${failed.number} · CI failed`, pr: failed };
  const running = open.find((pr) => pr.checks === 'pending');
  if (running) return { state: 'running', label: `PR #${running.number} · CI running`, pr: running };
  const green = open[0];
  if (green) return { state: 'green', label: green.ready ? `PR #${green.number} · ready to merge` : `PR #${green.number} · CI green`, pr: green };
  const merged = prs.find((pr) => pr.state === 'MERGED');
  if (merged) return { state: 'merged', label: `PR #${merged.number} · merged`, pr: merged };
  return null;
}

// ── settings ────────────────────────────────────────────────────────────────

/** Settings → CI & pull requests → Merge method: the repo's default (gh), or one of gh's three. */
export const CI_MERGE_METHODS = ['repo', 'squash', 'merge', 'rebase'] as const;

/** A merge method setting. */
export type CiMergeMethod = (typeof CI_MERGE_METHODS)[number];

/** `true` for one of {@link CI_MERGE_METHODS}. */
export function isCiMergeMethod(value: unknown): value is CiMergeMethod {
  return typeof value === 'string' && (CI_MERGE_METHODS as readonly string[]).includes(value);
}

/** The bounds of the numeric CI settings (whole numbers). */
export const CI_LIMITS = {
  'ci.pendingPollMinutes': { min: 1, max: 30 },
  'ci.idlePollMinutes': { min: 2, max: 120 },
  'ci.maxAttempts': { min: 1, max: 10 },
  'ci.logTailLines': { min: 20, max: 1000 },
} as const;

// ── issue import (D109) ────────────────────────────────────────────────────

/** Where issues are imported from. */
export type IssueSource = 'github' | 'jira';

/** The most issues one preview lists. */
export const ISSUE_IMPORT_MAX = 100;

/** Longest body kept in an imported todo's description (characters, before the link line). */
export const ISSUE_BODY_MAX = 1_500;

/** Body of `POST /api/sessions/{id}/todos/import/preview` (and `query` of the import). */
export type IssueImportQuery =
  | {
      readonly source: 'github';
      /** `owner/repo`. */
      readonly repo: string;
      /** One label to filter by; `null` = any. */
      readonly label: string | null;
      /** Only issues assigned to the gh account (`--assignee @me`). */
      readonly mine: boolean;
    }
  | {
      readonly source: 'jira';
      /** A JQL query; or {@link project}. */
      readonly jql: string | null;
      /** A project key (`PROJ`): its issues that are not done. */
      readonly project: string | null;
    };

/** One issue of a preview. */
export interface ImportableIssue {
  /** `owner/repo#12` or `PROJ-12`: the link recorded so a re-import skips it. */
  readonly key: string;
  readonly title: string;
  readonly url: string | null;
  /** The body as plain text, cut; `null` = none. */
  readonly body: string | null;
  readonly labels: readonly string[];
  /** Already imported into this session (shown ticked off and disabled). */
  readonly imported: boolean;
}

/** `POST …/todos/import/preview`. */
export interface IssueImportPreview {
  readonly issues: readonly ImportableIssue[];
  /** More issues matched than {@link ISSUE_IMPORT_MAX}. */
  readonly truncated: boolean;
}

/** `GET /api/sessions/{id}/todos/import/sources`: what the dialog can offer for this session. */
export interface IssueImportSources {
  readonly github: {
    /** gh is signed in on the session's machine. */
    readonly available: boolean;
    /** The `owner/repo` of the session's repositories (their `origin`), to pick from. */
    readonly repos: readonly string[];
    readonly problem: string | null;
  };
  readonly jira: {
    /** A Jira connection exists (Settings → Jira, or `ATL_*`). */
    readonly available: boolean;
    readonly problem: string | null;
  };
}

/** Body of `POST /api/sessions/{id}/todos/import`. */
export interface IssueImportInput {
  readonly query: IssueImportQuery;
  /** The keys ticked in the preview. */
  readonly keys: readonly string[];
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PROJECT = /^[A-Z][A-Z0-9_]{0,19}$/;

/** Validates an {@link IssueImportQuery}. */
export function parseIssueQuery(body: unknown): { readonly ok: true; readonly value: IssueImportQuery } | { readonly ok: false; readonly field: string; readonly message: string } {
  if (!isRecord(body)) return { ok: false, field: 'source', message: 'give a source: github or jira' };
  if (body['source'] === 'github') {
    const repo = typeof body['repo'] === 'string' ? body['repo'].trim() : '';
    if (!REPO.test(repo)) return { ok: false, field: 'repo', message: 'give the repository as owner/repo' };
    const rawLabel = typeof body['label'] === 'string' ? body['label'].trim() : '';
    if (rawLabel.length > 50 || /[\r\n]/.test(rawLabel)) return { ok: false, field: 'label', message: 'a label is one line of at most 50 characters' };
    return { ok: true, value: { source: 'github', repo, label: rawLabel === '' ? null : rawLabel, mine: body['mine'] === true } };
  }
  if (body['source'] === 'jira') {
    const jql = typeof body['jql'] === 'string' && body['jql'].trim() !== '' ? body['jql'].trim() : null;
    const project = typeof body['project'] === 'string' && body['project'].trim() !== '' ? body['project'].trim().toUpperCase() : null;
    if (jql === null && project === null) return { ok: false, field: 'jql', message: 'give a JQL query or a project key' };
    if (jql !== null && jql.length > 1_000) return { ok: false, field: 'jql', message: 'the JQL query is at most 1,000 characters' };
    if (project !== null && !PROJECT.test(project)) return { ok: false, field: 'project', message: 'a project key is letters and digits, like PROJ' };
    return { ok: true, value: { source: 'jira', jql, project } };
  }
  return { ok: false, field: 'source', message: 'the source is github or jira' };
}

/** The JQL a Jira query runs: the given one, or a project's issues that are not done. */
export function jiraImportJql(query: Extract<IssueImportQuery, { source: 'jira' }>): string {
  return query.jql ?? `project = ${query.project ?? ''} AND statusCategory != Done ORDER BY created DESC`;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The todo an issue becomes: title "<#12 | PROJ-12> <title>" (one line, at most 120
 * characters), description = the body (cut) and a last line linking back to the issue.
 */
export function issueTodo(issue: Pick<ImportableIssue, 'key' | 'title' | 'url' | 'body'>, source: IssueSource): { readonly title: string; readonly description: string } {
  const short = source === 'github' ? `#${issue.key.split('#').pop() ?? issue.key}` : issue.key;
  const title = cut(`${short} ${issue.title.replace(/\s+/g, ' ').trim()}`, 120);
  const link = `${source === 'github' ? 'GitHub' : 'Jira'}: ${issue.url ?? issue.key}`;
  const body = issue.body && issue.body.trim() !== '' ? cut(issue.body.trim(), ISSUE_BODY_MAX) : '';
  return { title, description: [body, link].filter((part) => part !== '').join('\n\n') };
}
