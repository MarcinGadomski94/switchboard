/**
 * D80 · Undo a turn (`docs/undo.md`): the pure part shared by the server and the
 * UI. Before each turn Switchboard snapshots every git working tree the session
 * uses into a hidden ref; a turn can be reverted to (its files, and the branch
 * when the agent committed), and a revert can be undone (Redo). Names, texts,
 * the retention rule and the wire shapes live here; no I/O.
 */

/** The namespace of every checkpoint ref (never a branch: `git branch` / `git log` without `--all` do not show them). */
export const CHECKPOINT_REF_PREFIX = 'refs/switchboard/checkpoints/';

/** Retention: a checkpoint older than this is pruned (7 days). */
export const CHECKPOINT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** Retention: at most this many turns per session keep their checkpoints (the newest). */
export const CHECKPOINT_MAX_TURNS = 100;

/** Retention: at most this many safety captures (taken before a revert / Redo) per session. */
export const CHECKPOINT_MAX_SAFETY = 20;

/** How often the retention runs (hourly; also when a session is closed). */
export const CHECKPOINT_PRUNE_INTERVAL_MS = 3600 * 1000;

/** The confirm dialog lists at most this many files per working tree (the rest are counted). */
export const CHECKPOINT_FILES_SHOWN = 200;

/** The `pending_messages.kind` of the note the agent gets with its next message. */
export const CHECKPOINT_NOTE_KIND = 'checkpoint-note';

/** The action on a user turn in the chat. */
export const REVERT_TURN_LABEL = 'Revert to before this turn';
/** The session ⋯ menu's item. */
export const UNDO_LAST_TURN_LABEL = 'Undo last turn';
/** The button on the newest revert's divider. */
export const REDO_LABEL = 'Redo';
/** The confirm dialog's second choice when the branch cannot be moved back. */
export const FILES_ONLY_LABEL = 'Revert files only';

/** The ref of turn `turn` of a session (`suffix` > 1: a second working tree of the same repo in that turn). */
export function checkpointRef(sessionId: string, turn: number, suffix = 1): string {
  return `${CHECKPOINT_REF_PREFIX}${sessionId}/${turn}${suffix > 1 ? `-${suffix}` : ''}`;
}

/** The ref of a safety capture (taken just before a revert or a Redo). */
export function safetyRef(sessionId: string, groupId: string, suffix = 1): string {
  return `${CHECKPOINT_REF_PREFIX}${sessionId}/safety/${groupId}${suffix > 1 ? `-${suffix}` : ''}`;
}

/** `true` for a ref in the checkpoint namespace (the only refs Switchboard ever deletes). */
export function isCheckpointRef(ref: string): boolean {
  return ref.startsWith(CHECKPOINT_REF_PREFIX) && !ref.includes('..') && ref.length > CHECKPOINT_REF_PREFIX.length;
}

/** The first line of a message, trimmed and cut at 80 characters (the note and the confirm dialog quote it). */
export function firstLineOf(text: string): string {
  const line = (text.split('\n').find((part) => part.trim() !== '') ?? '').trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** `turn N` or `turns N..M`. */
function turnsText(turn: number, latest: number): string {
  return latest > turn ? `turns ${turn}..${latest}` : `turn ${turn}`;
}

/** The chat divider of a revert. */
export function revertDivider(turn: number): string {
  return `Reverted to before turn ${turn}`;
}

/** The chat divider of a Redo. */
export function redoDivider(turn: number): string {
  return `Undid the revert to before turn ${turn}`;
}

/**
 * The note the agent gets with its next message (developer ruling): "Switchboard
 * reverted the files to before turn N (<first line>); changes made in turns N..M
 * are gone. Don't rely on them."
 */
export function revertNote(turn: number, firstLine: string, latest: number): string {
  const quoted = firstLine === '' ? '' : ` (${firstLine})`;
  return `Switchboard reverted the files to before turn ${turn}${quoted}; changes made in ${turnsText(turn, latest)} are gone. Don't rely on them.`;
}

/** The note after a Redo whose revert note the agent already got. */
export function redoNote(turn: number, latest: number): string {
  return `Switchboard undid its revert to before turn ${turn}: the files are back as they were before the revert (the changes of ${turnsText(turn, latest)} are there again).`;
}

/** One capture as the retention sees it (all rows of a group share these). */
export interface RetentionGroup {
  readonly groupId: string;
  readonly kind: 'turn' | 'before-revert' | 'before-redo';
  readonly turnSeq: number;
  readonly createdAt: string;
}

/**
 * The groups of one session to prune (developer ruling): turn captures are kept
 * while they are at most 7 days old **and** among the last 100 turns (whichever
 * keeps fewer); safety captures while at most 7 days old and among the newest
 * {@link CHECKPOINT_MAX_SAFETY}. `closed` (the session was closed or deleted): all.
 */
export function prunableGroups(groups: readonly RetentionGroup[], now: number, options: { readonly closed?: boolean; readonly maxAgeMs?: number; readonly maxTurns?: number } = {}): string[] {
  if (options.closed) return [...new Set(groups.map((group) => group.groupId))];
  const maxAge = options.maxAgeMs ?? CHECKPOINT_MAX_AGE_MS;
  const maxTurns = options.maxTurns ?? CHECKPOINT_MAX_TURNS;
  const out = new Set<string>();
  const old = (group: RetentionGroup): boolean => now - Date.parse(group.createdAt) > maxAge;
  const turns = groups.filter((group) => group.kind === 'turn');
  const newestTurn = turns.reduce((max, group) => Math.max(max, group.turnSeq), 0);
  for (const group of turns) if (old(group) || group.turnSeq <= newestTurn - maxTurns) out.add(group.groupId);
  const safety = [...new Map(groups.filter((group) => group.kind !== 'turn').map((group) => [group.groupId, group])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  safety.forEach((group, index) => {
    if (old(group) || index >= CHECKPOINT_MAX_SAFETY) out.add(group.groupId);
  });
  return [...out];
}

// ── wire shapes (contract → *Undo a turn (D80)*) ─────────────────────────

/** A turn that has a checkpoint (`GET /api/sessions/{id}/checkpoints`). */
export interface CheckpointTurn {
  /** 1 = the session's first user message. */
  readonly turn: number;
  /** The user message's event (the chat bubble the action sits on). */
  readonly eventId: number | null;
  readonly createdAt: string;
  /** The working trees captured (top-level folders). */
  readonly repos: readonly string[];
  /** The message's first line. */
  readonly firstLine: string;
}

/** `GET /api/sessions/{id}/checkpoints`. */
export interface SessionCheckpoints {
  /** Settings → Sessions → *Save a checkpoint before each turn*. */
  readonly enabled: boolean;
  /** Why this session gets no checkpoints (a terminal session, a folder that is no git repo, the setting is off); `null` = it does. */
  readonly unsupported: string | null;
  /** The turns with a checkpoint, oldest first. */
  readonly turns: readonly CheckpointTurn[];
  /** The session's newest turn (its user messages so far). */
  readonly latestTurn: number;
  /** A turn runs now: a revert is refused until it is stopped. */
  readonly running: boolean;
  /** The newest revert can be undone (Redo): its turn; `null` = nothing to redo. */
  readonly redo: { readonly turn: number; readonly eventId: number | null } | null;
}

/** How a file changes in a revert. */
export type CheckpointFileChangeKind = 'added' | 'modified' | 'deleted';

/** One file a revert changes (path relative to its working tree). */
export interface CheckpointFileChange {
  readonly path: string;
  readonly change: CheckpointFileChangeKind;
}

/** What a revert does with HEAD / the branch of one working tree. */
export interface CheckpointHeadPlan {
  /** `none`: HEAD did not move; `reset`: the branch goes back (Redo: forward) to `to`; `refused`: it cannot (files only). */
  readonly action: 'none' | 'reset' | 'refused';
  readonly branch: string | null;
  /** The commits the reset takes off the branch (Redo: puts back). */
  readonly commits: number;
  readonly to: string | null;
  /** Why the branch cannot be moved (`refused`). */
  readonly reason: string | null;
}

/** One working tree in a revert preview / result. */
export interface CheckpointRepoPlan {
  readonly path: string;
  /** The folder's name. */
  readonly name: string;
  /** The files that change (at most {@link CHECKPOINT_FILES_SHOWN}). */
  readonly files: readonly CheckpointFileChange[];
  /** How many files change in all. */
  readonly fileCount: number;
  readonly head: CheckpointHeadPlan;
}

/** `GET /api/sessions/{id}/checkpoints/{turn}` (the confirm dialog) and the answer of a revert / Redo. */
export interface CheckpointPlan {
  readonly turn: number;
  readonly firstLine: string;
  readonly latestTurn: number;
  readonly repos: readonly CheckpointRepoPlan[];
  /** Why the branch cannot go back (some working tree's `refused`): only *Revert files only* is offered. */
  readonly filesOnlyReason: string | null;
  /** In an answer: the revert left the branch alone (files only). */
  readonly filesOnly?: boolean;
}
