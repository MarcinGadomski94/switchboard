import type { FolderCheck, FolderRule, SolutionGroup, SystemInfo } from '../../core/api.ts';

/**
 * The first-run setup wizard's rules and copy (M5.3, SPEC → Modals → Setup
 * wizard, prototype `WZ`, `wzSteps`, `wzChecks`, `scan`, `notif`;
 * `docs/setup.md`). Kept free of React so it can be unit-tested.
 */

/** One step: rail label, title, text (prototype `WZ`, verbatim). */
export interface WizardStep {
  readonly label: string;
  readonly title: string;
  readonly text: string;
}

/** The five steps (prototype `WZ`). */
export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    label: 'Claude Code CLI + login',
    title: 'Claude Code on this PC',
    text: 'Switchboard starts and drives Claude Code in the background, signed in with your Max plan. It also reads PR status through the GitHub CLI.',
  },
  { label: 'Workspace root', title: 'Workspace root', text: 'The folder that holds your router AGENTS.md. Every session starts here.' },
  { label: 'Scan solutions', title: 'Solutions found', text: 'Scanned the folders your router defines. The folder rules are applied as written.' },
  {
    label: 'Notifications',
    title: 'Notifications',
    text: 'When an agent asks something or a scheduled run fails, you get a sound, a toast and an OS notification, even when the tab is in the background.',
  },
  {
    label: 'Usage warnings',
    title: 'Usage-limit warnings',
    text: 'You get a warning when your Max 5-hour window reaches the threshold. Nothing is paused automatically.',
  },
];

/** The last step's index. */
export const LAST_STEP = WIZARD_STEPS.length - 1;

/** `Step 2 of 5` (prototype `wz.pos`). */
export function stepPosition(index: number): string {
  return `Step ${index + 1} of ${WIZARD_STEPS.length}`;
}

/** The primary button: `Finish` on the last step, else `Continue`. */
export function nextLabel(index: number): string {
  return index === LAST_STEP ? 'Finish' : 'Continue';
}

/** A rail item's state: before the current step (✓), the current one, or later. */
export type RailState = 'done' | 'current' | 'todo';

/** A rail item (prototype `wzSteps`: ✓ for the steps before the current one, else the number). */
export interface RailItem {
  readonly label: string;
  readonly mark: string;
  readonly state: RailState;
}

/** The steps rail for `current`. */
export function railItems(current: number): RailItem[] {
  return WIZARD_STEPS.map((step, index) => {
    const state: RailState = index < current ? 'done' : index === current ? 'current' : 'todo';
    return { label: step.label, mark: state === 'done' ? '✓' : String(index + 1), state };
  });
}

/** One row of step 1 (prototype `wzChecks`, which shows only the passing rows). */
export interface CheckRow {
  readonly ok: boolean;
  readonly label: string;
  readonly detail: string;
}

/**
 * Step 1's rows from `GET /api/system` (M5.3): the CLI (`--version`), its login
 * (`claude auth status`) and gh's login (`gh auth status`). The passing CLI and gh
 * rows are the prototype's; the plan ("Max plan") is not known to Switchboard
 * (only the exit code of `auth status` is read), so the login row does not name one.
 */
export function checkRows(info: SystemInfo): CheckRow[] {
  const cli: CheckRow = info.cli
    ? { ok: true, label: 'Claude Code CLI found', detail: info.cli }
    : { ok: false, label: 'Claude Code CLI not found', detail: 'install Claude Code or set SWITCHBOARD_CLAUDE_BIN' };
  const login: CheckRow = info.signedIn
    ? { ok: true, label: 'Signed in', detail: 'claude auth status · the login stays with Claude Code' }
    : { ok: false, label: 'Not signed in', detail: info.cli ? 'claude auth status · run claude in a terminal to sign in' : 'claude auth status needs the CLI' };
  const gh: CheckRow = info.ghSignedIn
    ? { ok: true, label: 'GitHub CLI signed in', detail: 'gh auth status · used to detect merged PRs' }
    : { ok: false, label: 'GitHub CLI not signed in', detail: 'gh auth status failed · merged PRs are not detected' };
  return [cli, login, gh];
}

/** A status line under the folder field. */
export interface RootLine {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * The line under the folder field (prototype: `✓ AGENTS.md (Workspace Router)
 * found · 640 lines`; D14: a git repo is `✓ git repo · single solution`): the
 * router file's first `# ` heading and line count, or what is wrong with the
 * folder (the server's words).
 */
export function rootLine(check: FolderCheck | null): RootLine | null {
  if (!check) return null;
  if (check.kind === 'repo') return { ok: true, text: '✓ git repo · single solution' };
  if (check.kind === 'workspace') {
    const title = check.router?.title ?? null;
    const name = !title ? 'AGENTS.md' : title.startsWith('AGENTS.md') ? title : `AGENTS.md (${title})`;
    const lines = check.router?.lines ?? 0;
    return { ok: true, text: `✓ ${name} found · ${lines} line${lines === 1 ? '' : 's'}` };
  }
  return { ok: false, text: `✕ ${check.message}` };
}

/** One row of the scan table (prototype `scan`: folder, count, examples, rule). */
export interface ScanRow {
  readonly folder: string;
  readonly count: number;
  readonly examples: string;
  readonly rule: string;
  /** `on request only` / `read-only` rows use the amber rule color. */
  readonly restricted: boolean;
}

const RULE_TEXT: Readonly<Record<FolderRule, string>> = { editable: 'editable', 'on-request': 'on request only', 'read-only': 'read-only' };
const RULE_RANK: Readonly<Record<FolderRule, number>> = { editable: 0, 'on-request': 1, 'read-only': 2 };

/**
 * The scan table from `GET /api/solutions` (the real scanner, M6.1): one row per
 * top-level folder in scan order (the read-only group splits back into
 * `deprecated/` and `infrastructure/`, in the order its note names them), its
 * solution count, the first three names (`, …` when there are more) and the
 * strictest rule in it.
 */
export function scanRows(groups: readonly SolutionGroup[]): ScanRow[] {
  const rows = new Map<string, { names: string[]; rule: FolderRule }>();
  for (const group of groups) {
    const inGroup = new Map<string, { names: string[]; rule: FolderRule }>();
    for (const solution of group.solutions) {
      const top = `${(solution.relativePath || solution.name).split('/')[0] ?? solution.name}/`;
      const row = rows.get(top) ?? inGroup.get(top) ?? { names: [], rule: 'editable' as FolderRule };
      row.names.push(solution.name);
      if (RULE_RANK[solution.rule] > RULE_RANK[row.rule]) row.rule = solution.rule;
      if (!rows.has(top)) inGroup.set(top, row);
    }
    // The group's note lists its folders in the router's order (`deprecated/ · infrastructure/ · never edited`).
    const named = group.note.split(' · ');
    const rank = (folder: string): number => {
      const index = named.indexOf(folder);
      return index === -1 ? named.length : index;
    };
    for (const [folder, row] of [...inGroup].sort((a, b) => rank(a[0]) - rank(b[0]))) rows.set(folder, row);
  }
  return [...rows].map(([folder, row]) => ({
    folder,
    count: row.names.length,
    examples: row.names.slice(0, 3).join(', ') + (row.names.length > 3 ? ', …' : ''),
    rule: RULE_TEXT[row.rule],
    restricted: row.rule !== 'editable',
  }));
}

/** The notification permission as the wizard shows it (prototype `notif`). */
export interface NotificationState {
  readonly text: string;
  readonly tone: 'done' | 'fail' | 'muted';
}

/** `Notification.permission` (or `unsupported`) → the prototype's copy and color. */
export function notificationState(permission: string): NotificationState {
  switch (permission) {
    case 'granted':
      return { text: '✓ allowed', tone: 'done' };
    case 'denied':
      return { text: '✕ blocked in browser settings', tone: 'fail' };
    case 'default':
      return { text: 'not asked yet', tone: 'muted' };
    case 'unsupported':
      return { text: 'not supported here', tone: 'muted' };
    default:
      return { text: permission, tone: 'muted' };
  }
}

/** The page's notification permission, `unsupported` without the API. */
export function currentPermission(): string {
  const w = globalThis as unknown as { Notification?: { readonly permission: string } };
  return w.Notification ? w.Notification.permission : 'unsupported';
}

/** The OS notification sent once the permission is granted (prototype `askNotif`). */
export const NOTIFICATIONS_ON = { title: 'Switchboard', body: 'Notifications are on.', tag: 'switchboard-setup' } as const;

/** sessionStorage key: the wizard was closed unfinished in this tab, so it does not open by itself again here. */
export const SKIPPED_KEY = 'switchboard.setupSkipped';
