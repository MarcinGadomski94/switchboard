/**
 * The settings Switchboard knows (`GET/PUT /api/settings`, M8.2, `docs/settings.md`).
 * Shared by the server (defaults, validation, the facts it reports) and the UI.
 *
 * The contract's `Settings` is a key → JSON value object. `GET` returns every key
 * below: the **editable** preferences (stored in the `settings` table, their
 * default until set) and the **read-only** values the service reports about
 * itself (configuration, files, constants). `PUT` takes any subset of the
 * editable keys.
 */

/** Every key `GET /api/settings` returns, with its value type. */
export interface KnownSettings {
  /** Pre-select "Worktree per session" in the New-session form (M5.1). Editable, default `true`. */
  readonly 'sessions.worktrees': boolean;
  /** Pre-select Ultracode in the New-session form (M5.1). Editable, default `false`. */
  readonly 'sessions.ultracode': boolean;
  /** Usage warning threshold in % of either Max window (M9.2). Editable, default 90. */
  readonly 'usage.warnAtPct': number;
  /** Launch the service at login. Read-only until M9.1 adds the toggle; `false` until set. */
  readonly 'service.startAtLogin': boolean;
  /** Where the service listens (`127.0.0.1:<port>`). Read-only. */
  readonly 'service.address': string;
  /** D14: the default saved folder's path (`docs/folders.md`); `null` when no folder is saved. Read-only (Settings → Folders changes it). */
  readonly 'workspace.root': string | null;
  /**
   * The router file of the default folder when it is a workspace: its first `# `
   * heading (`AGENTS.md (Workspace Router)`), `AGENTS.md` when it has none,
   * `null` when there is no `AGENTS.md`, no default folder, or it is a repo (D14). Read-only.
   */
  readonly 'workspace.router': string | null;
  /** How often the worktree manager asks gh for PR state, in minutes. Read-only. */
  readonly 'github.prPollMinutes': number;
}

/** A known setting key. */
export type SettingKey = keyof KnownSettings;

/** The keys `PUT /api/settings` accepts. */
export const EDITABLE_SETTINGS = ['sessions.worktrees', 'sessions.ultracode', 'usage.warnAtPct'] as const;

/** An editable setting key. */
export type EditableSettingKey = (typeof EDITABLE_SETTINGS)[number];

/** The editable settings. */
export type EditableSettings = Pick<KnownSettings, EditableSettingKey>;

/** Defaults of the editable settings: the prototype's values (Settings → Sessions & worktrees, Notifications & usage). */
export const SETTING_DEFAULTS: EditableSettings = {
  'sessions.worktrees': true,
  'sessions.ultracode': false,
  'usage.warnAtPct': 90,
};

/** Bounds of `usage.warnAtPct` (a whole percentage). */
export const WARN_AT_PCT_MIN = 1;
export const WARN_AT_PCT_MAX = 100;

/** `true` if `key` is an editable setting. */
export function isEditableSetting(key: string): key is EditableSettingKey {
  return (EDITABLE_SETTINGS as readonly string[]).includes(key);
}

/** The known values of a `GET /api/settings` body (anything missing or of the wrong type reads as the default / unknown). */
export function readKnownSettings(body: Readonly<Record<string, unknown>> | null | undefined): KnownSettings {
  const value = body ?? {};
  const bool = (key: SettingKey, fallback: boolean): boolean => (typeof value[key] === 'boolean' ? (value[key] as boolean) : fallback);
  const text = (key: SettingKey): string | null => (typeof value[key] === 'string' ? (value[key] as string) : null);
  const num = (key: SettingKey, fallback: number): number => (typeof value[key] === 'number' ? (value[key] as number) : fallback);
  return {
    'sessions.worktrees': bool('sessions.worktrees', SETTING_DEFAULTS['sessions.worktrees']),
    'sessions.ultracode': bool('sessions.ultracode', SETTING_DEFAULTS['sessions.ultracode']),
    'usage.warnAtPct': num('usage.warnAtPct', SETTING_DEFAULTS['usage.warnAtPct']),
    'service.startAtLogin': bool('service.startAtLogin', false),
    'service.address': text('service.address') ?? '',
    'workspace.root': text('workspace.root'),
    'workspace.router': text('workspace.router'),
    'github.prPollMinutes': num('github.prPollMinutes', 0),
  };
}
