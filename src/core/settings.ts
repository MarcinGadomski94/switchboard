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
  /** D41: the sidebar is slid out (the shell's reveal handle brings it back). Editable, default `false`. */
  readonly 'ui.sidebarHidden': boolean;
  /** D41: the session view's right panel is slid out, in every session. Editable, default `false`. */
  readonly 'ui.rightPanelHidden': boolean;
  /**
   * D56: the New-session dialog's last used mode (`simple`: folder, message,
   * title, model, own worktree; `full`: the router form). Editable, default
   * `simple` (a fresh install opens the simple form).
   */
  readonly 'newSession.mode': NewSessionMode;
  /** D64: the standing instruction every new / resumed session's agent gets (`docs/settings.md`). Editable, default {@link DEFAULT_STANDING_INSTRUCTION}. */
  readonly 'agents.standingInstruction': string;
  /** D64: whether the standing instruction is passed on. Editable, default `true`. */
  readonly 'agents.standingInstruction.enabled': boolean;
  /**
   * D75: when a turn ends while an item started in the session (▶ Start or the agent's
   * `todo_start`) is still in progress and the agent did not touch it in that turn, send the
   * agent one reminder to finish it (`docs/todos.md` → *In progress (D75)*). Editable, default `true`.
   */
  readonly 'sessions.todoReminder': boolean;
  /**
   * D81: a captured todo (⌘K, a chat selection, the share sheet) is marked as waiting for its
   * agent, which is asked once, when it is next idle, to fill in its description, plan, priority
   * and estimate (`docs/todos.md` → *Quick capture (D81)*); off = captured items stay bare.
   * Editable, default `true`.
   */
  readonly 'sessions.todoEnrich': boolean;
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

/** D56: the New-session dialog's modes (`docs/new-session.md` → *Simple mode (D56)*). */
export const NEW_SESSION_MODES = ['simple', 'full'] as const;

/** D56: a New-session dialog mode. */
export type NewSessionMode = (typeof NEW_SESSION_MODES)[number];

/** D56: `true` for one of {@link NEW_SESSION_MODES}. */
export function isNewSessionMode(value: unknown): value is NewSessionMode {
  return typeof value === 'string' && (NEW_SESSION_MODES as readonly string[]).includes(value);
}

/**
 * D64: the default standing instruction. Short on purpose: it costs tokens in
 * every session. It stops an agent asking about content it never wrote ("the
 * table above" that only existed in its head). D68 added one sentence: the
 * session's todo list goes through the built-in `switchboard` MCP tools; D69: the
 * agent fills a title, a short description and a handover plan; D70: also a priority
 * and an estimate (minutes), a plan is always given (`No plan: reason` allowed); D75:
 * an item is always marked in progress when started and done when finished.
 */
export const DEFAULT_STANDING_INSTRUCTION =
  "Before you ask the user a question that refers to a proposal, table, list, plan or comparison, write that content out in a message first, then ask. Never refer to content 'above' that you have not actually written in this conversation. Todo list: when asked to add to it, use the switchboard todo tools with a title, short description, handover plan (or 'No plan: reason'), priority and estimate (minutes); revise those as you learn more; always mark an item in progress when you start it and done when you finish it; check it when asked what's left.";

/**
 * D68: earlier defaults. A stored text equal to one of them (saved unchanged, or
 * stored by Reset to default) reads as the current {@link DEFAULT_STANDING_INSTRUCTION},
 * so it gets the new sentence; a text the developer edited is theirs and stays as it is.
 */
export const PREVIOUS_DEFAULT_STANDING_INSTRUCTIONS: readonly string[] = [
  // D64 (before 1.7.0).
  "Before you ask the user a question that refers to a proposal, table, list, plan or comparison, write that content out in a message first, then ask. Never refer to content 'above' that you have not actually written in this conversation.",
  // D68 (1.7.0): before D69's title, description and handover plan.
  "Before you ask the user a question that refers to a proposal, table, list, plan or comparison, write that content out in a message first, then ask. Never refer to content 'above' that you have not actually written in this conversation. Todo list: when asked to add to it, use the switchboard todo tools; mark items done when finished; check it when asked what's left.",
  // D69 (1.8.0): before D70's priority, estimate and mandatory plan.
  "Before you ask the user a question that refers to a proposal, table, list, plan or comparison, write that content out in a message first, then ask. Never refer to content 'above' that you have not actually written in this conversation. Todo list: when asked to add to it, use the switchboard todo tools and fill a title, a short description and a handover plan from the conversation; mark items done when finished; check it when asked what's left.",
  // D70 (1.9.0 – 1.11.0): before D75's in progress.
  "Before you ask the user a question that refers to a proposal, table, list, plan or comparison, write that content out in a message first, then ask. Never refer to content 'above' that you have not actually written in this conversation. Todo list: when asked to add to it, use the switchboard todo tools with a title, short description, handover plan (or 'No plan: reason'), priority and estimate (minutes); revise those as you learn more; mark items done when finished; check it when asked what's left.",
];

/** D68: the stored instruction as it applies now (an earlier default is the current default). */
export function currentStandingInstruction(stored: string): string {
  return PREVIOUS_DEFAULT_STANDING_INSTRUCTIONS.includes(stored.trim()) ? DEFAULT_STANDING_INSTRUCTION : stored;
}

/** D64: the longest standing instruction `PUT /api/settings` accepts (characters). */
export const STANDING_INSTRUCTION_MAX = 4_000;

/**
 * D64: the text to pass to an agent's CLI: the stored instruction (trimmed) when
 * the toggle is on and the text is not empty, else `null` (nothing is passed).
 */
export function effectiveStandingInstruction(settings: Pick<KnownSettings, 'agents.standingInstruction' | 'agents.standingInstruction.enabled'>): string | null {
  if (!settings['agents.standingInstruction.enabled']) return null;
  const text = settings['agents.standingInstruction'].trim();
  return text === '' ? null : text;
}

/** A known setting key. */
export type SettingKey = keyof KnownSettings;

/** The keys `PUT /api/settings` accepts. */
export const EDITABLE_SETTINGS = ['sessions.worktrees', 'sessions.ultracode', 'usage.warnAtPct', 'ui.sidebarHidden', 'ui.rightPanelHidden', 'newSession.mode', 'agents.standingInstruction', 'agents.standingInstruction.enabled', 'sessions.todoReminder', 'sessions.todoEnrich'] as const;

/** An editable setting key. */
export type EditableSettingKey = (typeof EDITABLE_SETTINGS)[number];

/** The editable settings. */
export type EditableSettings = Pick<KnownSettings, EditableSettingKey>;

/** Defaults of the editable settings: the prototype's values (Settings → Sessions & worktrees, Notifications & usage; D41: both panes shown; D56: the simple New-session form). */
export const SETTING_DEFAULTS: EditableSettings = {
  'sessions.worktrees': true,
  'sessions.ultracode': false,
  'usage.warnAtPct': 90,
  'ui.sidebarHidden': false,
  'ui.rightPanelHidden': false,
  'newSession.mode': 'simple',
  'agents.standingInstruction': DEFAULT_STANDING_INSTRUCTION,
  'agents.standingInstruction.enabled': true,
  'sessions.todoReminder': true,
  'sessions.todoEnrich': true,
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
    'ui.sidebarHidden': bool('ui.sidebarHidden', SETTING_DEFAULTS['ui.sidebarHidden']),
    'ui.rightPanelHidden': bool('ui.rightPanelHidden', SETTING_DEFAULTS['ui.rightPanelHidden']),
    'newSession.mode': isNewSessionMode(value['newSession.mode']) ? value['newSession.mode'] : SETTING_DEFAULTS['newSession.mode'],
    'agents.standingInstruction': typeof value['agents.standingInstruction'] === 'string' ? currentStandingInstruction(value['agents.standingInstruction'] as string) : DEFAULT_STANDING_INSTRUCTION,
    'agents.standingInstruction.enabled': bool('agents.standingInstruction.enabled', SETTING_DEFAULTS['agents.standingInstruction.enabled']),
    'sessions.todoReminder': bool('sessions.todoReminder', SETTING_DEFAULTS['sessions.todoReminder']),
    'sessions.todoEnrich': bool('sessions.todoEnrich', SETTING_DEFAULTS['sessions.todoEnrich']),
    'service.startAtLogin': bool('service.startAtLogin', false),
    'service.address': text('service.address') ?? '',
    'workspace.root': text('workspace.root'),
    'workspace.router': text('workspace.router'),
    'github.prPollMinutes': num('github.prPollMinutes', 0),
  };
}
