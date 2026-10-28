/**
 * D145 (`docs/cleanup.md` → *Automatic clean-up of merged worktrees (D145)*): the rules of the
 * automatic clean-up of a merged worktree, kept pure so each condition is tested on its own.
 * The server side (`src/server/worktrees/auto-clean.ts`) reads the facts with git and acts.
 *
 * Developer request 2026-10-28: "when the work is done and merged, agents clean up after
 * themselves, both locally and in the git repo, only when it comes to worktrees".
 */
import { sweepTimeText } from './session-archive.ts';

/** On by default: merged worktrees of Switchboard's agents are removed by themselves. */
export const AUTO_CLEAN_SETTING = 'worktrees.autoClean';
/** On by default: the branch's copy on its remote goes too (when Switchboard's agent pushed it). */
export const AUTO_CLEAN_REMOTE_SETTING = 'worktrees.autoCleanRemote';
/** The record shown under the setting (read-only): how many were cleaned, the last ones, what was kept. */
export const AUTO_CLEAN_RECORD_SETTING = 'worktrees.autoCleanRecord';
/** How far the scan for agent-made worktrees read the events table (an event id; internal). */
export const AGENT_WORKTREES_SCANNED_SETTING = 'worktrees.agentMadeScannedTo';

/**
 * D145: the branches the clean-up never deletes, locally or on a remote, however merged they
 * are: the one list of patterns (`*` matches any characters, `/` included; compared without a
 * `refs/heads/` or remote prefix). Long-lived names, release branches and (the developer's
 * addition, 2026-10-28) `feature/*`, the epic branches task branches merge into. The worktree's
 * base and the repository's default branch are protected too ({@link protectedBranchReason}).
 * A worktree on such a branch may still be removed when it is clean and merged: the folder
 * goes, the branch stays (the divider says "kept the local branch (…)").
 */
export const PROTECTED_BRANCH_PATTERNS: readonly string[] = [
  'main',
  'master',
  'dev',
  'develop',
  'development',
  'trunk',
  'staging',
  'production',
  'HEAD',
  'release',
  'release/*',
  'release-*',
  'release_*',
  'releases/*',
  'feature/*',
];

function patternMatches(pattern: string, name: string): boolean {
  const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`).test(name);
}

/** The {@link PROTECTED_BRANCH_PATTERNS} entry `branch` (without a remote prefix) matches, else `null`. */
export function protectedPattern(branch: string): string | null {
  return PROTECTED_BRANCH_PATTERNS.find((pattern) => patternMatches(pattern, branch)) ?? null;
}

/**
 * Why `branch` must never be deleted (a {@link PROTECTED_BRANCH_PATTERNS} match, the worktree's
 * base or the repository's default branch), else `null`. Names are compared without a remote
 * prefix (`origin/dev` → `dev`).
 */
export function protectedBranchReason(branch: string, context: { readonly base?: string | null; readonly defaultBranch?: string | null; readonly remotes?: readonly string[] } = {}): string | null {
  const bare = (name: string | null | undefined): string | null => {
    if (!name) return null;
    let out = name.replace(/^refs\/(heads|remotes)\//, '');
    for (const remote of context.remotes ?? ['origin']) if (out.startsWith(`${remote}/`)) out = out.slice(remote.length + 1);
    return out;
  };
  const name = bare(branch) ?? branch;
  const pattern = protectedPattern(name);
  if (pattern !== null) return pattern.includes('*') || pattern === 'release' ? `${name} is a protected branch (${pattern})` : `${name} is a protected branch`;
  if (bare(context.base) === name) return `${name} is the base branch`;
  if (bare(context.defaultBranch) === name) return `${name} is the repository's default branch`;
  return null;
}

/** The owning agent as the clean-up sees it. */
export type AutoCleanAgentState = 'running' | 'idle' | 'archived';

/** What the decision needs to know about one worktree (read right before removing). */
export interface AutoCleanFacts {
  /** The owning session's agent: working (a turn or its helper agents), idle, or archived. */
  readonly agent: AutoCleanAgentState;
  /** An open session (the owner or another) whose working folder (cwd) is this worktree or inside it: its name. */
  readonly cwdOf: string | null;
  /** Another session (open or archived) that works in it (its cwd), by name. */
  readonly usedBy: readonly string[];
  /** Processes whose working folder is inside it (their names); `null` when that cannot be read here. */
  readonly processes: readonly string[] | null;
  /** Uncommitted and untracked files (`git status --porcelain --untracked-files=all`; ignored files do not count). */
  readonly uncommitted: number;
  /** How it is merged: its HEAD is in the base (`ancestor`), its PR is `MERGED` (`pr`), or not (`null`). */
  readonly merged: 'ancestor' | 'pr' | null;
  /** The branch has commits of its own (D121: a fresh branch inside its base is never "merged"). */
  readonly ownWork: boolean;
  /** Commits of HEAD that are on no remote and not in the base. */
  readonly localOnly: number;
  /** The base it is merged into (shown in the reasons), `null` when unknown. */
  readonly base: string | null;
}

/** What to do with a worktree. */
export type AutoCleanDecision = { readonly remove: true } | { readonly remove: false; readonly reason: string };

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : noun.endsWith('s') ? 'es' : 's'}`;
}

/**
 * D145: whether a worktree goes. Every condition must hold: the owning agent is idle or
 * archived; no open session has its working folder in it (a session started in a worktree
 * keeps it until it is archived); no other session works in it; no process runs inside it;
 * nothing uncommitted or untracked; merged into its base (with commits of its own) or its PR
 * merged; and no commit only on this computer. The first that fails is the reason it is kept.
 */
export function decideAutoClean(facts: AutoCleanFacts): AutoCleanDecision {
  if (facts.agent === 'running') return { remove: false, reason: 'its agent is working' };
  if (facts.cwdOf !== null) return { remove: false, reason: `it is the working folder of ${facts.cwdOf} (removed once that agent is archived)` };
  if (facts.usedBy.length > 0) return { remove: false, reason: `also used by ${facts.usedBy.join(', ')}` };
  if (facts.processes === null) return { remove: false, reason: 'the processes running in it cannot be checked' };
  if (facts.processes.length > 0) return { remove: false, reason: `${plural(facts.processes.length, 'process')} still running in it (${facts.processes.slice(0, 3).join(', ')})` };
  if (facts.uncommitted > 0) return { remove: false, reason: plural(facts.uncommitted, 'uncommitted change') };
  if (facts.merged === null) return { remove: false, reason: facts.base === null ? 'not merged (its base is unknown)' : `not merged into ${facts.base}` };
  if (facts.merged === 'ancestor' && !facts.ownWork) return { remove: false, reason: 'no commits of its own yet' };
  if (facts.localOnly > 0) return { remove: false, reason: `${plural(facts.localOnly, 'commit')} only on this computer` };
  return { remove: true };
}

/** What the decision about the branch's remote copy needs. */
export interface RemoteFacts {
  /** "Also delete the branch on the remote" is on. */
  readonly enabled: boolean;
  /** The branch's remote (its upstream's, else `origin`), `null` when it has none. */
  readonly remote: string | null;
  /** The branch's name there. */
  readonly branch: string;
  /** Its tip there (`git ls-remote`), `null` when it is not there; `undefined` when the remote could not be read. */
  readonly tip: string | null | undefined;
  /** That tip is merged (the local HEAD that was merged, or inside the base). */
  readonly tipMerged: boolean;
  /** Why the name is protected ({@link protectedBranchReason}), else `null`. */
  readonly protectedReason: string | null;
  /** The local branch was made tracking a branch already on the remote (not pushed by Switchboard's agent). */
  readonly tracking: boolean;
}

/** `delete`, or why the remote copy stays (`null` = nothing worth saying: off, no remote, not there). */
export type RemoteDecision = { readonly delete: true } | { readonly delete: false; readonly reason: string | null };

/** D145: whether the branch's copy on its remote is deleted (never a protected, base or default branch). */
export function decideRemote(facts: RemoteFacts): RemoteDecision {
  if (!facts.enabled || facts.remote === null) return { delete: false, reason: null };
  if (facts.tip === undefined) return { delete: false, reason: `${facts.remote} could not be read` };
  if (facts.tip === null) return { delete: false, reason: null };
  if (facts.protectedReason !== null) return { delete: false, reason: facts.protectedReason };
  if (facts.tracking) return { delete: false, reason: `it was on ${facts.remote} before Switchboard's agent used it` };
  if (!facts.tipMerged) return { delete: false, reason: `${facts.remote}/${facts.branch} has commits that are not merged` };
  return { delete: true };
}

/** What a clean-up removed (the chat divider and the log line say it). */
export interface CleanedWorktree {
  /** The worktree folder's name. */
  readonly name: string;
  /** `merged into dev` or `PR #12 merged`. */
  readonly how: string;
  /** The local branch was deleted. */
  readonly localBranch: boolean;
  /** Why the local branch stayed, `null` when deleted or there was none to delete. */
  readonly localKept: string | null;
  /** `origin/<branch>` when the remote copy was deleted. */
  readonly remote: string | null;
  /** `origin/<branch> (reason)` when the remote copy stayed for a reason. */
  readonly remoteKept: string | null;
}

function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) as string}`;
}

/**
 * The chat divider and log line: "Cleaned up worktree x: merged into dev; removed the folder,
 * the local branch and origin/x" (with "; kept origin/x (the remote refused: …)" when it stayed).
 */
export function cleanedText(cleaned: CleanedWorktree): string {
  const removed = ['the folder', ...(cleaned.localBranch ? ['the local branch'] : []), ...(cleaned.remote ? [cleaned.remote] : [])];
  const kept = [...(cleaned.localKept ? [`the local branch (${cleaned.localKept})`] : []), ...(cleaned.remoteKept ? [cleaned.remoteKept] : [])];
  return `Cleaned up worktree ${cleaned.name}: ${cleaned.how}; removed ${joinAnd(removed)}${kept.length > 0 ? `; kept ${joinAnd(kept)}` : ''}`;
}

/** The record under the setting. */
export interface AutoCleanRecord {
  /** Worktrees cleaned up since the feature started. */
  readonly cleaned: number;
  readonly lastCleanedAt: string | null;
  /** The newest cleaned ones (at most {@link AUTO_CLEAN_RECENT_MAX}), newest last. */
  readonly recent: ReadonlyArray<{ readonly at: string; readonly path: string; readonly text: string }>;
  /** The worktrees kept at their last check and why (at most {@link AUTO_CLEAN_KEPT_MAX}). */
  readonly kept: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

export const AUTO_CLEAN_RECENT_MAX = 20;
export const AUTO_CLEAN_KEPT_MAX = 50;
export const EMPTY_AUTO_CLEAN_RECORD: AutoCleanRecord = { cleaned: 0, lastCleanedAt: null, recent: [], kept: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored record (anything broken reads as empty parts). */
export function readAutoCleanRecord(value: unknown): AutoCleanRecord {
  if (!isRecord(value)) return EMPTY_AUTO_CLEAN_RECORD;
  const recent = Array.isArray(value['recent'])
    ? value['recent'].flatMap((item: unknown) => (isRecord(item) && typeof item['at'] === 'string' && typeof item['path'] === 'string' && typeof item['text'] === 'string' ? [{ at: item['at'], path: item['path'], text: item['text'] }] : []))
    : [];
  const kept = Array.isArray(value['kept'])
    ? value['kept'].flatMap((item: unknown) => (isRecord(item) && typeof item['path'] === 'string' && typeof item['reason'] === 'string' ? [{ path: item['path'], reason: item['reason'] }] : []))
    : [];
  return {
    cleaned: typeof value['cleaned'] === 'number' && Number.isFinite(value['cleaned']) ? value['cleaned'] : 0,
    lastCleanedAt: typeof value['lastCleanedAt'] === 'string' ? value['lastCleanedAt'] : null,
    recent: recent.slice(-AUTO_CLEAN_RECENT_MAX),
    kept: kept.slice(-AUTO_CLEAN_KEPT_MAX),
  };
}

/** "Cleaned up 3 worktrees so far, the last today 14:02 · 2 kept (see Clean-up)"; `null` before anything happened. */
export function autoCleanRecordText(record: AutoCleanRecord, now: Date = new Date()): string | null {
  const kept = record.kept.length > 0 ? ` · ${record.kept.length} kept for now (see Clean-up)` : '';
  if (record.cleaned === 0 || record.lastCleanedAt === null) return kept ? `Nothing cleaned up yet${kept}` : null;
  return `Cleaned up ${plural(record.cleaned, 'worktree')} so far, the last ${sweepTimeText(record.lastCleanedAt, now)}${kept}`;
}
