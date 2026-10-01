import type { FolderRule, Schedule, SolutionGroup, SystemInfo } from '../../../core/api.ts';
import type { ToolState } from '../../tools/probe.ts';

/**
 * Pure helpers of the Settings view (M8.2, SPEC → Settings, `docs/settings.md`):
 * the sections, the rows' values derived from the API, and the scan table. No
 * value here is invented: what the API does not know reads "unknown".
 */

/**
 * The seven sections, in the prototype's order (`SN`), then D48's Machines; the key is the URL segment
 * (`/settings/<key>`). D14: *Workspace & solutions* became *Folders* (the key
 * stays, so old links keep working; `/settings/folders` opens it too).
 */
export const SETTINGS_SECTIONS = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'workspace', label: 'Folders' },
  { key: 'sessions', label: 'Sessions & worktrees' },
  { key: 'notify', label: 'Notifications & usage' },
  { key: 'schedules', label: 'Schedules' },
  { key: 'tools', label: 'Embedded tools' },
  { key: 'github', label: 'GitHub' },
  // D62 (docs/providers.md): the CLIs sessions run on; after the prototype's seven.
  { key: 'clis', label: 'CLIs' },
  // D63 (docs/accounts.md): more than one login per CLI, switched automatically on usage limits.
  { key: 'accounts', label: 'Accounts' },
  // D48 (docs/peers.md): paired machines; after the prototype's seven.
  { key: 'machines', label: 'Machines' },
  // D55 (docs/updates.md): GitHub releases, the update and its state.
  { key: 'updates', label: 'Updates' },
] as const;

/** A section key. */
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['key'];

/** The section of a `/settings[/:section]` route: Claude Code for none or an unknown one; `folders` is Folders (D14). */
export function resolveSection(section: string | null): SettingsSection {
  if (section === 'folders') return 'workspace';
  return SETTINGS_SECTIONS.find((s) => s.key === section)?.key ?? 'claude';
}

/** Shown when the API cannot tell (e.g. `/api/system` not reachable). */
export const UNKNOWN_VALUE = 'unknown';

/** CLI row: the path as description, `detected` / `not found` / unknown. */
export function cliRow(system: SystemInfo | null): { readonly description: string; readonly value: string } {
  if (!system) return { description: '—', value: UNKNOWN_VALUE };
  return system.cli ? { description: system.cli, value: 'detected' } : { description: '—', value: 'not found' };
}

/** Account row value: the CLI's own login (`claude auth status`, M5.3). */
export function accountValue(system: SystemInfo | null): string {
  if (!system) return UNKNOWN_VALUE;
  return system.signedIn ? 'signed in' : 'not signed in';
}

/** GitHub CLI login row value (`gh auth status`, M5.3). */
export function ghValue(system: SystemInfo | null): string {
  if (!system) return UNKNOWN_VALUE;
  return system.ghSignedIn ? '✓ signed in' : 'not signed in';
}

/** `on` / `off`. */
export function onOff(value: boolean): string {
  return value ? 'on' : 'off';
}

/** Repositories row: every solution the default folder's scan found. */
export function repoCount(groups: readonly SolutionGroup[] | null): string {
  if (!groups) return UNKNOWN_VALUE;
  const n = groups.reduce((sum, group) => sum + group.solutions.length, 0);
  return `${n} ${n === 1 ? 'repo' : 'repos'}`;
}

/** PR merge detection row: the worktree manager's poll interval. */
export function pollValue(minutes: number): string {
  return minutes > 0 ? `every ${minutes} min` : UNKNOWN_VALUE;
}

/** One row of the Workspace & solutions scan table (prototype `scan`). */
export interface ScanRow {
  readonly folder: string;
  readonly count: number;
  readonly examples: string;
  readonly rule: FolderRule;
  readonly ruleLabel: string;
}

/** The rule column's copy (prototype `scan`). */
export const RULE_LABEL: Readonly<Record<FolderRule, string>> = {
  editable: 'editable',
  'on-request': 'on request only',
  'read-only': 'read-only',
};

const RULE_RANK: Readonly<Record<FolderRule, number>> = { editable: 0, 'on-request': 1, 'read-only': 2 };

/** At most this many names are listed per row before ", …". */
const EXAMPLES = 3;

/**
 * The workspace-root folder a solution path sits in (`microfrontends/`), or `null`
 * when it is not under `root`. D14: a saved folder has two forms of its path (as
 * added and canonical), so `root` may list several; the first that holds the
 * path counts.
 */
function topFolder(solutionPath: string, root: string | readonly string[] | null): string | null {
  const roots = root === null ? [] : typeof root === 'string' ? [root] : root;
  const normalize = (p: string): string => p.replaceAll('\\', '/').replace(/\/+$/, '');
  const full = normalize(solutionPath);
  for (const candidate of roots) {
    const base = normalize(candidate);
    if (!base || !full.toLowerCase().startsWith(`${base.toLowerCase()}/`)) continue;
    const first = full.slice(base.length + 1).split('/')[0];
    if (first) return `${first}/`;
  }
  return null;
}

/**
 * The scan table from `GET /api/solutions` (M6.1): one row per top-level folder of
 * the workspace root, in the order the groups list them. A solution's folder is
 * the first segment of its path under `root`, so the single "read-only" group
 * splits back into `deprecated/` and `infrastructure/` (ordered as its note names
 * them: `deprecated/ · infrastructure/ · never edited`); without a root (or a path
 * outside it) the group's own folder is used. Count = solutions in the folder,
 * examples = the first three names (", …" when there are more), rule = the
 * strictest rule of its solutions.
 */
export function scanRows(groups: readonly SolutionGroup[], root: string | readonly string[] | null): ScanRow[] {
  const rows = new Map<string, { names: string[]; rule: FolderRule }>();
  for (const group of groups) {
    const noted = group.note.split(' · ').filter((part) => part.endsWith('/'));
    const rank = (folder: string): number => (noted.includes(folder) ? noted.indexOf(folder) : noted.length);
    const placed = group.solutions
      .map((solution, index) => ({ solution, index, folder: topFolder(solution.path, root) ?? group.folder }))
      .sort((a, b) => rank(a.folder) - rank(b.folder) || a.index - b.index);
    for (const { solution, folder } of placed) {
      const row = rows.get(folder) ?? { names: [], rule: solution.rule };
      row.names.push(solution.name);
      if (RULE_RANK[solution.rule] > RULE_RANK[row.rule]) row.rule = solution.rule;
      rows.set(folder, row);
    }
  }
  return [...rows].map(([folder, row]) => ({
    folder,
    count: row.names.length,
    examples: row.names.slice(0, EXAMPLES).join(', ') + (row.names.length > EXAMPLES ? ', …' : ''),
    rule: row.rule,
    ruleLabel: RULE_LABEL[row.rule],
  }));
}

/** Dot color of a Settings → Schedules row (prototype `scheds.color`): paused = idle, else the last run's result. */
export function scheduleColor(schedule: Pick<Schedule, 'paused' | 'runs'>): string {
  if (schedule.paused) return 'var(--status-idle)';
  const last = schedule.runs[schedule.runs.length - 1]?.result;
  switch (last) {
    case 'ok':
      return 'var(--status-done)';
    case 'fail':
      return 'var(--status-fail)';
    case 'need':
      return 'var(--status-need)';
    case 'running':
      return 'var(--status-run)';
    default:
      return 'var(--status-idle)';
  }
}

/** The OS-notification permission as the Notifications API reports it, or `unsupported` without the API. */
export type NotificationAccess = 'granted' | 'denied' | 'default' | 'unsupported';

/** OS notification permission (prototype `notif`): the text and its color. */
export function notificationState(permission: NotificationAccess): { readonly text: string; readonly color: string } {
  switch (permission) {
    case 'granted':
      return { text: '✓ allowed', color: 'var(--status-done)' };
    case 'denied':
      return { text: '✕ blocked in browser settings', color: 'var(--status-fail)' };
    case 'default':
      return { text: 'not asked yet', color: 'var(--muted-2)' };
    default:
      return { text: 'not supported here', color: 'var(--muted-2)' };
  }
}

/** The threshold choices (every 5% from 50%), plus the stored value when it is not one of them. */
export function warnAtOptions(current: number): number[] {
  const options = Array.from({ length: 11 }, (_, i) => 50 + i * 5);
  if (!options.includes(current)) options.push(current);
  return options.sort((a, b) => a - b);
}

/** A tool card's state text (prototype `toolRows.state`). */
export const TOOL_CARD_STATE: Readonly<Record<ToolState, string>> = {
  up: 'reachable',
  down: 'not reachable',
  checking: 'checking…',
  idle: 'not tested',
  unset: 'not set',
};
