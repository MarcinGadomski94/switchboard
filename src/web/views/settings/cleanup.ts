import { formatSize } from '../../../core/attachments.ts';
import { CLEANUP_GROUPS, type CleanupGroup, type CleanupItem, type CleanupRun, type CleanupStepStatus, ageText, totalSize } from '../../../core/cleanup.ts';

/**
 * Pure helpers of Settings → Clean-up (D84, `docs/cleanup.md`): the groups as
 * the page lists them, the size and age lines, the selection toggles and the
 * run's summary.
 */

/** One group of the page with its items (empty groups included: the page says "Nothing here"). */
export interface CleanupGroupView {
  readonly group: CleanupGroup;
  readonly items: readonly CleanupItem[];
  /** `3 items · 1.2 GB`, `1 item`, `nothing`. */
  readonly summary: string;
}

/** The scan's items by group, in page order. */
export function groupsOf(items: readonly CleanupItem[]): CleanupGroupView[] {
  return CLEANUP_GROUPS.map((group) => {
    const list = items.filter((item) => item.group === group);
    const sized = list.some((item) => item.sizeBytes !== null);
    const count = list.length === 0 ? 'nothing' : `${list.length} ${list.length === 1 ? 'item' : 'items'}`;
    return { group, items: list, summary: list.length > 0 && sized ? `${count} · ${formatSize(totalSize(list))}` : count };
  });
}

/** An item's size: `12 MB`, `≥ 1.2 GB` when the walk stopped early, `''` when not counted. */
export function sizeText(item: Pick<CleanupItem, 'sizeBytes' | 'sizeCapped'>): string {
  if (item.sizeBytes === null) return '';
  return `${item.sizeCapped ? '≥ ' : ''}${formatSize(item.sizeBytes)}`;
}

/** An item's age line: `last change 12 days ago`. */
export function ageLine(item: Pick<CleanupItem, 'lastChangeAt'>, now: number = Date.now()): string {
  const age = ageText(item.lastChangeAt, now);
  return age ? `last change ${age}` : '';
}

/** The footer: `2 selected · 340 MB` / `Nothing selected`. */
export function selectionLine(items: readonly CleanupItem[], selected: ReadonlySet<string>): string {
  const picked = items.filter((item) => selected.has(item.id));
  if (picked.length === 0) return 'Nothing selected';
  const bytes = totalSize(picked);
  return `${picked.length} selected${bytes > 0 ? ` · ${formatSize(bytes)}` : ''}`;
}

/** Ticks or unticks one item. */
export function toggled(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** A group's checkbox: `all`, `some` or `none` of its items ticked. */
export function groupState(items: readonly CleanupItem[], selected: ReadonlySet<string>): 'all' | 'some' | 'none' {
  const ticked = items.filter((item) => selected.has(item.id)).length;
  if (ticked === 0) return 'none';
  return ticked === items.length ? 'all' : 'some';
}

/**
 * The group's checkbox clicked: everything in it ticked, or (when all are)
 * unticked. Remote branches are never ticked in bulk: each one is ticked by hand.
 */
export function toggledGroup(items: readonly CleanupItem[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  const all = groupState(items, selected) === 'all';
  for (const item of items) {
    if (all) next.delete(item.id);
    else if (item.group !== 'remoteBranches') next.add(item.id);
  }
  return next;
}

/** A run step's mark in the progress list. */
export function stepMark(status: CleanupStepStatus): string {
  switch (status) {
    case 'pending':
      return '·';
    case 'running':
      return '…';
    case 'done':
      return '✓';
    case 'failed':
      return '✕';
  }
}

/** The result line: `Removed 3 · freed 1.2 GB · 1 failed`. */
export function runSummary(run: Pick<CleanupRun, 'summary' | 'finishedAt' | 'items'>): string {
  if (run.finishedAt === null) {
    const finished = run.items.filter((item) => item.status === 'done' || item.status === 'failed').length;
    return `Cleaning up… ${finished} of ${run.items.length}`;
  }
  const parts = [`Removed ${run.summary.done}`];
  if (run.summary.freedBytes > 0) parts.push(`freed ${formatSize(run.summary.freedBytes)}`);
  if (run.summary.failed > 0) parts.push(`${run.summary.failed} failed (nothing else was affected)`);
  return parts.join(' · ');
}
