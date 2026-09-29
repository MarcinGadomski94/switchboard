/**
 * D47 (`docs/decisions.md` → *Stacked task branches*): a task branch may be
 * **stacked** on an earlier, still unmerged task branch (its **parent**) instead
 * of the epic branch. The developer types the parent in the New-session form (a
 * branch name or a task key, e.g. `PROJ-3013`); Switchboard never lists or
 * searches sibling branches. Per repo the parent resolves to the origin branch of
 * that name (a key: the one origin branch whose name starts with `<KEY>-`); the
 * task worktree is then cut from `origin/<parent>` and its PR targets the parent.
 * A repo without the parent falls back to D40's rule (`origin/<epic>` when the
 * epic is on origin, else `origin/<epic base>`, PR into the epic; without an epic
 * the origin default branch, PR into it). Nothing is created or pushed on origin
 * at session start (D40's lazy rule is unchanged).
 *
 * The pure rules shared by the server (validation, per-repo resolution, the
 * hand-off, the parent-merged message) and the UI (the Parent field, its pre-fill
 * from the task text, the preflight columns). `docs/worktrees.md` → *Stacked task
 * branches (D47)*, `docs/new-session.md` → *Parent (D47)*.
 */
import { type HandoffBranching, type SessionBranching, branchingLines, branchingTailLines, isValidBranchName } from './branching.ts';

/** A parent as typed: a task key (`PROJ-3013`, resolved per repo) or a full branch name. */
export type ParentRef = { readonly kind: 'key'; readonly key: string } | { readonly kind: 'branch'; readonly name: string };

/** The form's Parent placeholder / empty meaning. */
export const PARENT_EPIC_LABEL = 'Epic branch (independent)';

/** The example the parent messages show. */
export const PARENT_EXAMPLE = 'PROJ-3013';

/** Why a typed parent is refused (422 on field `branching.parent` / `parent`). */
export const PARENT_RULE = `the parent must be a task key (e.g. ${PARENT_EXAMPLE}) or a valid git branch name`;

/** A task key typed in any case (`proj-3013`), before it is upper-cased. */
const LOOSE_KEY = /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/;

/** Result of {@link parseParent}: the parent (`null` = the epic branch, not stacked) or why it is refused. */
export type ParentCheck = { readonly ok: true; readonly parent: ParentRef | null } | { readonly ok: false; readonly message: string };

/**
 * The Parent field's text as a parent: blank = `null` (the epic branch, D40 as
 * before); a task key in any case = `{ kind: 'key' }` upper-cased; else a full
 * branch name that passes `isValidBranchName` (a leading `origin/` is dropped:
 * the parent is always looked up on origin). Anything else is refused.
 */
export function parseParent(value: unknown): ParentCheck {
  let text = typeof value === 'string' ? value.trim() : '';
  if (text.startsWith('origin/')) text = text.slice('origin/'.length);
  if (text === '') return { ok: true, parent: null };
  if (LOOSE_KEY.test(text)) return { ok: true, parent: { kind: 'key', key: text.toUpperCase() } };
  return isValidBranchName(text) ? { ok: true, parent: { kind: 'branch', name: text } } : { ok: false, message: PARENT_RULE };
}

/** The parent as stored and shown: the key or the branch name. */
export function parentText(parent: ParentRef): string {
  return parent.kind === 'key' ? parent.key : parent.name;
}

/** The parent stored in `SessionBranching.parent` back as a {@link ParentRef} (`null` when not stacked). */
export function storedParent(branching: Pick<SessionBranching, 'parent'> | null | undefined): ParentRef | null {
  const text = branching?.parent ?? null;
  if (text === null) return null;
  const check = parseParent(text);
  return check.ok ? check.parent : null;
}

/** The ticket key a branch name starts with (`PROJ-3014-foo` → `PROJ-3014`), else `null`. */
export function branchKey(branch: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9]*-[0-9]+)(?:-|$)/.exec(branch);
  return match ? (match[1] as string).toUpperCase() : null;
}

/**
 * Why a parent cannot go with this task, else `null`: the task branch itself (or,
 * for a key, the task's own key), the epic's base (the parent must be a task
 * branch). A parent equal to the epic branch is not refused: it means "not
 * stacked" ({@link effectiveParent}).
 */
export function parentConflict(parent: ParentRef, context: { readonly task: string | null; readonly base: string | null; readonly epic: string | null }): string | null {
  const { task, base } = context;
  if (task !== null) {
    if (parent.kind === 'branch' && parent.name === task) return 'the parent cannot be the task branch itself';
    if (parent.kind === 'key' && branchKey(task) === parent.key) return `the parent cannot be the task's own key (${parent.key})`;
  }
  if (parent.kind === 'branch' && base !== null && context.epic !== null && parent.name === base) return `the parent must be a task branch, not the epic's base (${base})`;
  return null;
}

/** The parent that applies: `null` when none was typed or it is the epic branch itself (the D40 default). */
export function effectiveParent(parent: ParentRef | null, epicBranch: string | null): ParentRef | null {
  if (parent === null) return null;
  if (parent.kind === 'branch' && epicBranch !== null && parent.name === epicBranch) return null;
  return parent;
}

/**
 * The origin branches the parent names in one repo, from that repo's origin
 * branch names (without `origin/`, after a fetch): a key → every branch whose
 * name starts with `<KEY>-` (the task branch left out); a full name → that
 * branch when it is there. 0 = the parent is not in this repo; more than one = the
 * developer must type the full name.
 */
export function parentMatches(parent: ParentRef, originBranches: readonly string[], task: string | null): string[] {
  if (parent.kind === 'branch') return originBranches.includes(parent.name) ? [parent.name] : [];
  const prefix = `${parent.key}-`;
  return originBranches.filter((branch) => branch.startsWith(prefix) && branch !== task).sort();
}

/** The message of a key that names several origin branches in a repo. */
export function ambiguousParentMessage(key: string, matches: readonly string[]): string {
  return `${key} matches ${matches.length} branches on origin (${matches.join(', ')}): type the parent's full branch name`;
}

/** How a repo's base was resolved. */
export type BaseVia =
  /** The parent task branch, on origin in this repo. */
  | 'parent'
  /** The epic branch, on origin. */
  | 'epic'
  /** The epic's base: the epic is not on origin yet (it is cut from here lazily). */
  | 'epic-base'
  /** The repo's base override (D40's "Use other base"). */
  | 'override'
  /** No epic: the repo's origin default branch. */
  | 'default';

/** One repo's resolved base and PR target (D47 rules 2 and 4), or why it cannot be resolved. */
export type RepoBase =
  | {
      readonly ok: true;
      /** The branch the task worktree is cut from (without `origin/`); `null` when nothing is known (no default branch). */
      readonly cut: string | null;
      /** Where the task's PR goes: the parent, the epic (even while it is not on origin), or the branch cut from. */
      readonly prTarget: string | null;
      /** The parent's branch in this repo, `null` when the task is not stacked here. */
      readonly parent: string | null;
      readonly via: BaseVia;
      /** With an epic: `true` while it is not on origin. */
      readonly epicMissing: boolean;
    }
  | { readonly ok: false; readonly message: string; readonly matches: readonly string[] };

/** What {@link resolveRepoBase} knows about one repo (after a fetch). */
export interface RepoBaseFacts {
  /** {@link parentMatches} in this repo; `null` = not stacked. */
  readonly parentMatches: readonly string[] | null;
  readonly epicOnOrigin: boolean;
  /** The repo's origin default branch (`origin/HEAD`); needed only without an epic and override. */
  readonly defaultBranch: string | null;
}

/**
 * D47 rules 2 and 4 for one repo (`solution` as in `branching.bases`): the parent
 * on origin here → cut from it, PR into it; a key naming several branches is
 * refused; else D40's cut point (`origin/<epic>` when on origin, else the repo's
 * override or the epic's base; without an epic the override or the origin
 * default branch) with the PR into the epic (with an epic) or into the branch cut
 * from (without one).
 */
export function resolveRepoBase(branching: Pick<SessionBranching, 'epic' | 'base' | 'bases'>, solution: string, facts: RepoBaseFacts): RepoBase {
  const matches = facts.parentMatches;
  if (matches !== null && matches.length > 1) {
    const key = branchKey(matches[0] as string) ?? (matches[0] as string);
    return { ok: false, message: ambiguousParentMessage(key, matches), matches };
  }
  if (matches !== null && matches.length === 1) {
    const parent = matches[0] as string;
    return { ok: true, cut: parent, prTarget: parent, parent, via: 'parent', epicMissing: branching.epic !== null && !facts.epicOnOrigin };
  }
  const override = branching.bases[solution];
  if (branching.epic) {
    if (facts.epicOnOrigin) return { ok: true, cut: branching.epic.branch, prTarget: branching.epic.branch, parent: null, via: 'epic', epicMissing: false };
    return { ok: true, cut: override ?? branching.base, prTarget: branching.epic.branch, parent: null, via: override !== undefined ? 'override' : 'epic-base', epicMissing: true };
  }
  const cut = override ?? facts.defaultBranch;
  return { ok: true, cut, prTarget: cut, parent: null, via: override !== undefined ? 'override' : 'default', epicMissing: false };
}

// ── parent status (gh) ──────────────────────────────────────────────────

/** `gh pr view <parent> --json …` fields the preflight and the watcher read. */
export const PARENT_PR_FIELDS = 'number,state,url,baseRefName,headRefOid';

/** A parent's pull request as gh prints it. */
export interface ParentPullRequest {
  readonly number: number;
  /** Verbatim: `OPEN`, `CLOSED`, `MERGED`. */
  readonly state: string;
  readonly url: string | null;
  /** The branch the parent's PR goes into (its own base: the epic, `dev`, …). */
  readonly baseRefName: string | null;
  /** The parent's head commit (after a merge: its last tip). */
  readonly headRefOid: string | null;
}

/** Reads `gh pr view --json number,state,url,baseRefName,headRefOid`; `null` when it is not that shape. */
export function parseParentPullRequest(stdout: string): ParentPullRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const number = record['number'];
  const state = record['state'];
  if (typeof number !== 'number' || !Number.isInteger(number) || typeof state !== 'string' || state === '') return null;
  const url = typeof record['url'] === 'string' ? record['url'] : null;
  const base = typeof record['baseRefName'] === 'string' && isValidBranchName(record['baseRefName']) ? record['baseRefName'] : null;
  const oid = typeof record['headRefOid'] === 'string' && /^[0-9a-f]{7,64}$/i.test(record['headRefOid']) ? record['headRefOid'] : null;
  return { number, state, url, baseRefName: base, headRefOid: oid };
}

/** A parent status in one repo: its PR, `none` (gh: no pull request), or `unknown` (gh failed). */
export type ParentStatus = { readonly kind: 'pr'; readonly pr: ParentPullRequest } | { readonly kind: 'none' } | { readonly kind: 'unknown'; readonly error: string };

/** The preflight's warning for a parent whose PR is merged or closed (a warning, never a block). */
export function parentStatusWarning(status: ParentStatus | null): string | null {
  if (status?.kind !== 'pr') return null;
  if (status.pr.state === 'MERGED') return 'parent merged — base on its target instead';
  if (status.pr.state === 'CLOSED') return 'parent closed — base on its target instead';
  return null;
}

/** A parent status as a short text: `PR #306 open`, `no PR`, `PR status unknown`. */
export function parentStatusText(status: ParentStatus | null): string {
  if (status === null) return '—';
  if (status.kind === 'none') return 'no PR';
  if (status.kind === 'unknown') return 'PR status unknown';
  return `PR #${status.pr.number} ${status.pr.state.toLowerCase()}`;
}

// ── task text pre-fill ──────────────────────────────────────────────────

/**
 * The phrases that say a task is stacked on an earlier one, each followed by the
 * key: "create it from", "cut it from", "branch it off", "stack(ed) on/onto",
 * "stack it on", "based on", "on top of", "build on", optionally "the branch /
 * task / PR of" before the key.
 */
const STACK_PHRASE =
  /\b(?:(?:create|cut|branch|start)(?:\s+(?:it|this|the\s+branch|the\s+task))?\s+(?:from|off(?:\s+of)?)|stack(?:ed)?(?:\s+(?:it|this))?\s+(?:on(?:\s+top\s+of)?|onto)|based\s+on|on\s+top\s+of|build(?:\s+it)?\s+on)\s+(?:(?:the\s+)?(?:branch|task|ticket|PR)\s+(?:of\s+)?)?[`'"]?([A-Za-z][A-Za-z0-9]*-[0-9]+)(?![0-9])/i;

/**
 * The key a task text stacks on ("create it from PROJ-3013", "stack on
 * PROJ-3013", "based on PROJ-3013-some-branch", …), upper-cased, else `null`. The
 * form pre-fills the Parent field with it while the developer has not typed there.
 */
export function parentFromTask(text: string): string | null {
  const match = STACK_PHRASE.exec(text);
  return match ? (match[1] as string).toUpperCase() : null;
}

// ── hand-off ────────────────────────────────────────────────────────────

/** One repo of a stacked session's hand-off. */
export interface StackRepo {
  /** The solution as the session names it (`acme-app-front`). */
  readonly solution: string;
  /** Resolved; `null` for a repo without an `origin` remote (cut from its HEAD). */
  readonly base: Extract<RepoBase, { ok: true }> | null;
  /** The parent's PR in this repo (only when the parent is in it); `null` = not asked. */
  readonly status: ParentStatus | null;
}

/** What the answers block says about a stacked session (D47). */
export interface HandoffStack {
  /** The parent as typed (a key or a branch name). */
  readonly parent: string;
  /** Per repo, in the session's order; empty when no worktree is made up front (D38). */
  readonly repos: readonly StackRepo[];
}

/** The model line's suffix of a stacked session. */
export const STACKED = 'stacked';

/**
 * The parent's name as the hand-off shows it: the one full name every repo
 * resolved it to; the typed value when no repo has it; the typed value and the
 * names when repos differ.
 */
export function parentDisplay(stack: HandoffStack): string {
  const names = [...new Set(stack.repos.flatMap((repo) => (repo.base?.parent ? [repo.base.parent] : [])))];
  if (names.length === 1) return names[0] as string;
  if (names.length === 0) return stack.parent;
  return `${stack.parent} (${names.join(', ')})`;
}

/** `(stacked; PR #306/#1080 open)`'s part after `stacked; `: the parent PRs grouped by state. */
export function parentPrSummary(stack: HandoffStack): string {
  const repos = stack.repos.filter((repo) => repo.base?.parent);
  if (stack.repos.length === 0) return 'resolved per repo';
  if (repos.length === 0) return 'not on origin in any repo';
  const byState = new Map<string, number[]>();
  const parts: string[] = [];
  const none: string[] = [];
  const unknown: string[] = [];
  for (const repo of repos) {
    const status = repo.status;
    if (status?.kind === 'pr') {
      const state = status.pr.state.toLowerCase();
      const numbers = byState.get(state) ?? [];
      if (!numbers.includes(status.pr.number)) numbers.push(status.pr.number);
      byState.set(state, numbers);
    } else if (status?.kind === 'none') none.push(repo.solution);
    else unknown.push(repo.solution);
  }
  for (const [state, numbers] of byState) parts.push(`PR ${numbers.map((n) => `#${n}`).join('/')} ${state}`);
  if (none.length > 0) parts.push(byState.size === 0 && unknown.length === 0 ? 'no PR' : `no PR in ${none.join(', ')}`);
  if (unknown.length > 0) parts.push(`PR status unknown in ${unknown.join(', ')}`);
  return parts.join(', ');
}

/** One repo's `<base> → PR into <target>` text (the hand-off's per-repo line, the preflight's cells). */
export function repoBaseLine(repo: StackRepo, epicBranch: string | null): string {
  const base = repo.base;
  if (base === null) return 'its current HEAD (no origin remote) → no PR target (no origin remote)';
  const notes: string[] = [];
  if (base.via === 'override') notes.push('base override');
  if (base.via !== 'parent' && base.epicMissing) notes.push('epic missing');
  if (base.via !== 'parent') notes.push('parent not in repo');
  const from = base.cut === null ? "the origin default branch (unknown)" : `origin/${base.cut}`;
  let target: string;
  if (base.prTarget === null) target = 'its origin default branch';
  else if (base.via === 'parent') target = base.prTarget;
  else if (epicBranch !== null && base.prTarget === epicBranch) target = `${base.prTarget} (epic${base.epicMissing ? ', created lazily' : ''})`;
  else target = base.prTarget;
  return `${from}${notes.length > 0 ? ` (${notes.join('; ')})` : ''} → PR into ${target}`;
}

/**
 * The stacked session's push rule: the task branch is pushed only at a repo's
 * first code change; in a repo whose base is not the parent the epic follows
 * D40's lazy rule.
 */
export function stackedRule(epic: string | null, base: string, overrides: boolean): string {
  if (epic === null) {
    return 'push the task branch with `git push -u origin <same name>` only in a repo at its first code change; never create it in repos that are not changed; open each repo\'s PR into its PR target above';
  }
  return (
    'push the task branch with `git push -u origin <same name>` only in a repo at its first code change; ' +
    `in a repo where the parent is not on origin, create and push the epic too (cut from the current \`origin/${base}\`${overrides ? " or the repo's base override" : ''} when it is missing on origin); ` +
    "never create a branch in repos that are not changed; open each repo's PR into its PR target above"
  );
}

/** Rule 5 as the hand-off states it (the watcher sends the same steps when the parent merges). */
export function parentMergeRule(task: string): string {
  return (
    "Switchboard watches the parent's PR in each repo and tells you when it merges; then retarget this task's PR to the parent's own base " +
    `(\`gh pr edit ${task} --base <parent's base>\`) and rebase ${task} onto \`origin/<parent's base>\` ` +
    `(\`git rebase --onto origin/<parent's base> <old parent tip> ${task}\` when the parent was squash-merged, else a normal rebase), then report; ` +
    'ask the developer before force-pushing a rebased branch'
  );
}

/** The per-repo line of a stacked session started without picked solutions (D38): the rule instead of a table. */
export function perRepoRule(parent: string, epic: string | null, base: string): string {
  const which = LOOSE_KEY.test(parent) ? `the origin branch whose name starts with ${parent}- (ask if there are several)` : parent;
  const fallback = epic === null ? "the origin default branch (PR into it)" : `origin/${epic} when it is on origin, else origin/${base} (PR into ${epic}, the epic, created lazily)`;
  return `in each repo you change, after git fetch origin --prune: origin/<parent> when ${which} is on origin there (PR into it), else ${fallback}`;
}

/**
 * The Branching lines of a stacked session (D47), replacing D40's epic / task
 * lines, each nested under the model line:
 * ```
 * - Branching model: epic/task (lazy), stacked
 *   - Epic: PROJ-3010 — feature/PROJ-3010-… (base: origin/dev)
 *   - Task branch: PROJ-3014-…
 *   - Parent: PROJ-3013-… (stacked; PR #306/#1080 open)
 *   - Per-repo base / PR target:
 *     - acme-app-front: origin/PROJ-3013-… → PR into PROJ-3013-…
 *     - quizzes-front: origin/dev (epic missing; parent not in repo) → PR into feature/PROJ-3010-… (epic, created lazily)
 *   - Rule: …
 *   - When the parent merges: …
 * ```
 * Without an epic the model is `task only, stacked` and there is no Epic line.
 */
export function stackedLines(input: { readonly task: string; readonly epic: { readonly key: string; readonly branch: string } | null; readonly base: string; readonly overrides: boolean; readonly stack: HandoffStack }): string[] {
  const { task, epic, base, stack } = input;
  const lines = [epic ? `- Branching model: epic/task (lazy), ${STACKED}` : `- Branching model: task only, ${STACKED}`];
  if (epic) lines.push(`  - Epic: ${epic.key} — ${epic.branch} (base: origin/${base})`);
  lines.push(`  - Task branch: ${task}`, `  - Parent: ${parentDisplay(stack)} (${STACKED}; ${parentPrSummary(stack)})`);
  if (stack.repos.length === 0) lines.push(`  - Per-repo base / PR target: ${perRepoRule(stack.parent, epic?.branch ?? null, base)}`);
  else {
    lines.push('  - Per-repo base / PR target:');
    for (const repo of stack.repos) lines.push(`    - ${repo.solution}: ${repoBaseLine(repo, epic?.branch ?? null)}`);
  }
  lines.push(`  - Rule: ${stackedRule(epic?.branch ?? null, base, input.overrides)}`, `  - When the parent merges: ${parentMergeRule(task)}`);
  return lines;
}

// ── parent merged (rule 5) ──────────────────────────────────────────────

/** How the parent reached its base: a merge commit (its tip is in the base), a squash / rebase merge (it is not), or not known. */
export type MergeKind = 'merge' | 'squash' | 'unknown';

/** What the parent-merged Inbox item and message name. */
export interface ParentMerged {
  readonly solution: string;
  /** The child task branch. */
  readonly task: string;
  readonly parent: string;
  /** The parent PR's base (where the child goes now). */
  readonly parentBase: string;
  readonly parentPr: number | null;
  /** The parent's tip before the merge (gh's `headRefOid`, else the commit the child was cut from). */
  readonly oldTip: string | null;
  readonly merge: MergeKind;
  /** The child's own PR, when Switchboard has seen one. */
  readonly childPr: number | null;
  readonly worktreePath: string;
}

/** The Inbox item's title: `Parent PROJ-3013-… merged — retarget and rebase PROJ-3014-…`. */
export function parentMergedTitle(merged: Pick<ParentMerged, 'parent' | 'task'>): string {
  return `Parent ${merged.parent} merged — retarget and rebase ${merged.task}`;
}

/** The rebase command for the agent. */
export function rebaseCommand(merged: Pick<ParentMerged, 'task' | 'parentBase' | 'oldTip' | 'merge'>): string {
  const onto = `origin/${merged.parentBase}`;
  if (merged.merge === 'merge') return `git rebase ${onto} ${merged.task}`;
  return `git rebase --onto ${onto} ${merged.oldTip ?? '<old parent tip>'} ${merged.task}`;
}

/**
 * The message sent to a stacked session when its parent's PR merged (rule 5):
 * retarget the task's PR to the parent's base when it exists, rebase the task
 * branch onto that base (`--onto` after a squash merge), then report. Switchboard
 * itself never runs `gh pr edit`, a rebase or a push.
 */
export function parentMergedMessage(merged: ParentMerged): string {
  const how =
    merged.merge === 'merge'
      ? 'it was merged with a merge commit, so a normal rebase is enough'
      : merged.merge === 'squash'
        ? `it was squash-merged (its old tip ${merged.oldTip ?? 'is unknown'} is not in origin/${merged.parentBase}), so rebase with --onto`
        : `check with \`git merge-base --is-ancestor ${merged.oldTip ?? '<old parent tip>'} origin/${merged.parentBase}\` whether it was squash-merged (not an ancestor: use --onto as below; an ancestor: a normal \`git rebase origin/${merged.parentBase} ${merged.task}\`)`;
  const pr = merged.childPr !== null ? `your PR #${merged.childPr}` : `your PR for ${merged.task}, if you have opened one,`;
  return [
    `Switchboard: the parent branch ${merged.parent}${merged.parentPr !== null ? ` (PR #${merged.parentPr})` : ''} was merged into ${merged.parentBase} in ${merged.solution}; ${how}.`,
    `In ${merged.worktreePath}:`,
    `1. Retarget ${pr} to ${merged.parentBase}: \`gh pr edit ${merged.task} --base ${merged.parentBase}\`.`,
    `2. \`git fetch origin --prune\`, then rebase ${merged.task} onto origin/${merged.parentBase}: \`${rebaseCommand(merged)}\`.`,
    '3. Report what you did. Ask the developer before force-pushing the rebased branch.',
  ].join('\n');
}

/**
 * The answers-block Branching lines of a session (D40, D47): a stacked session's
 * {@link stackedLines} followed by D40's override / drop lines; else D40's
 * `branchingLines` unchanged.
 */
export function handoffLines(branching: HandoffBranching): string[] {
  const stack = branching.stack ?? null;
  if (stack === null) return branchingLines(branching);
  return [
    ...stackedLines({ task: branching.task, epic: branching.epic, base: branching.base, overrides: branching.overrides.length > 0, stack }),
    ...branchingTailLines(branching),
  ];
}
