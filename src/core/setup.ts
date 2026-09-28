/**
 * Pure rules of the first-run setup (M5.3, `docs/setup.md`), shared by the
 * server (the workspace-root check) and the UI (the wizard's lines).
 */

/** Settings-table keys the setup owns (`docs/setup.md`). */
export const SETUP_KEYS = {
  /** ISO time the wizard was finished; absent = setup not done. */
  completedAt: 'setup.completedAt',
  /** The workspace root chosen in the wizard (absolute); `SWITCHBOARD_WORKSPACE_ROOT` wins over it. */
  workspaceRoot: 'setup.workspaceRoot',
} as const;

/** The usage-warning threshold key (M8.2's `usage.warnAtPct`) and its default. */
export const WARN_AT_KEY = 'usage.warnAtPct';
export const DEFAULT_WARN_AT_PCT = 90;

/** A stored threshold when it is a whole number 1–100, else {@link DEFAULT_WARN_AT_PCT}. */
export function warnAtPct(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100 ? value : DEFAULT_WARN_AT_PCT;
}

/** The text of the first `# ` heading of a Markdown file, trimmed; `null` without one. */
export function routerTitle(text: string): string | null {
  const match = /^# +(.+?)\s*$/m.exec(text);
  return match?.[1] ? match[1] : null;
}

/** Lines of a text file, as editors count them: a final newline does not start another line. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
}
