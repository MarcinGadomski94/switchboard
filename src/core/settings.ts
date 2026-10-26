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
import { FRESH_OFFER_DEFAULT_PCT } from './fresh-session.ts';
import { type ModelRule, readModelRules } from './model-routing.ts';
import { EXAMPLE_PRICES, type PriceTable, readPriceTable } from './insights.ts';
import { type CiMergeMethod, isCiMergeMethod } from './ci.ts';
import { IDLE_STOP_DEFAULT_MINUTES } from './processes.ts';
import { POWER_ESTIMATE_UNSET, type PowerEstimateModel, type PowerEstimateSettings, readPowerEstimateSettings } from './power.ts';

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
  /** D101: the sidebar's TOOLS section is collapsed to its header (`docs/sidebar.md` → *TOOLS*). Editable, default `false`. */
  readonly 'ui.toolsCollapsed': boolean;
  /** D106: the sidebar's SESSIONS section is folded to its header (`docs/sidebar.md` → *SESSIONS and CHATS*). Editable, default `false`. */
  readonly 'ui.sessionsCollapsed': boolean;
  /** D106: the sidebar's CHATS section is folded to its header. Editable, default `false`. */
  readonly 'ui.chatsCollapsed': boolean;
  /**
   * D131 (`docs/v2.md` → *Two themes*): the UI a browser shows when it has no choice of its own
   * (each browser / phone may override it in Settings, kept in its `localStorage`): `v2` (the
   * Switchboard 2 UI) or `classic` (the 1.x UI). Editable, default `v2` (the service's
   * `SWITCHBOARD_UI_THEME_DEFAULT` may set another default; tests use `classic`).
   */
  readonly 'ui.theme': UiTheme;
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
   * D80: before each turn of a supervised session, save a checkpoint of its git working trees
   * (hidden refs), so a turn can be reverted (`docs/undo.md`). Editable, default `true`.
   */
  readonly 'sessions.checkpoints': boolean;
  /**
   * D81: a captured todo (⌘K, a chat selection, the share sheet) is marked as waiting for its
   * agent, which is asked once, when it is next idle, to fill in its description, plan, priority
   * and estimate (`docs/todos.md` → *Quick capture (D81)*); off = captured items stay bare.
   * Editable, default `true`.
   */
  readonly 'sessions.todoEnrich': boolean;
  /**
   * D82: Settings → Sessions → *Model by task*: the ordered rules that pick the CLI,
   * model, effort and account a todo is run with (`docs/model-routing.md`). Editable,
   * default `[]` (off until the developer adds a rule).
   */
  readonly 'sessions.modelRules': readonly ModelRule[];
  /**
   * D83: offer **Continue in a fresh session** when a supervised session's context reaches
   * {@link KnownSettings['sessions.freshOfferPct']} (`docs/fresh-session.md`). Editable, default `true`.
   */
  readonly 'sessions.freshOffer': boolean;
  /** D83: the offer's threshold, % of the context window (whole, 50–95). Editable, default 80. */
  readonly 'sessions.freshOfferPct': number;
  /**
   * D108: Settings → Notifications & usage → *Prices*: the per-model prices per 1M tokens (input,
   * output, cache write, cache read) and the currency Insights turns tokens into cost with
   * (`docs/insights.md` → *Cost per todo run*). Editable, default {@link EXAMPLE_PRICES} (marked as
   * examples until saved).
   */
  readonly 'insights.prices': PriceTable;
  /** D109: send a red check's failure (with its log tail) to the PR's session (`docs/ci.md`). Editable, default `true`. */
  readonly 'ci.sendFailures': boolean;
  /** D109: how often a PR whose checks run is read again, in minutes (1–30). Editable, default 2. */
  readonly 'ci.pendingPollMinutes': number;
  /** D109: how often any other open PR is read again, in minutes (2–120). Editable, default 10. */
  readonly 'ci.idlePollMinutes': number;
  /** D109: failure messages per PR before the watcher stops and asks you (1–10). Editable, default 3. */
  readonly 'ci.maxAttempts': number;
  /** D109: the lines of a failed job's log sent with the message (20–1000). Editable, default 150. */
  readonly 'ci.logTailLines': number;
  /** D109: how Merge PR merges (`repo` = the repository's default, else squash). Editable, default `repo`. */
  readonly 'ci.mergeMethod': CiMergeMethod;
  /**
   * D127: Settings → Processes (`docs/processes.md`): the processes a session left running (build
   * servers, test hosts, dev servers; not those marked Keep) are stopped once it has been idle this
   * many minutes (whole, 0–1440; 0 = never for being idle: a close still stops them). Editable, default 10.
   */
  readonly 'processes.idleStopMinutes': number;
  /**
   * D125: Settings → Machines → *Power estimate* (`docs/power.md`): this machine's CPU idle
   * and max watts and the rest of the system, used only while it has no battery; `null` =
   * the default ({@link KnownSettings['power.estimateDefaults']}). Editable, default all `null`.
   */
  readonly 'power.estimate': PowerEstimateSettings;
  /** D125: this machine's default estimate (by its core count; Apple silicon lower). Read-only. */
  readonly 'power.estimateDefaults': PowerEstimateModel;
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

/** D131: the two UIs (`docs/v2.md`). */
export const UI_THEMES = ['v2', 'classic'] as const;

/** D131: a UI theme. */
export type UiTheme = (typeof UI_THEMES)[number];

/** D131: the default theme of a fresh install. */
export const DEFAULT_UI_THEME: UiTheme = 'v2';

/** D131: `true` for one of {@link UI_THEMES}. */
export function isUiTheme(value: unknown): value is UiTheme {
  return typeof value === 'string' && (UI_THEMES as readonly string[]).includes(value);
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
 * an item is always marked in progress when started and done when finished. D89 added
 * one more: deliverables go to the `artifact_save` tool, updating the same artifact. D94
 * one more: recurring or scheduled work goes to the `loop_create` tool (Switchboard fires it). D124
 * one more: every turn without a question card ends with the `turn_status` tool (done, waiting for
 * the developer or blocked, with a one-line ask), so the session shows whether it needs the developer. D133
 * one more: choices offered to the developer go in an AskUserQuestion card, not a list in the message.
 */
export const DEFAULT_STANDING_INSTRUCTION =
  "Before you ask the user a question that refers to a proposal, table, list, plan or comparison, write that content out in a message first, then ask. Never refer to content 'above' that you have not actually written in this conversation. Todo list: when asked to add to it, use the switchboard todo tools with a title, short description, handover plan (or 'No plan: reason'), priority and estimate (minutes); revise those as you learn more; always mark an item in progress when you start it and done when you finish it; check it when asked what's left. Save deliverables the developer should see (reports, plans, docs, diagrams, mockups) with the switchboard artifact_save tool; update the same artifact instead of creating new ones. For recurring or scheduled work use the switchboard loop_create tool, not CronCreate or /loop. End every turn without a question card with the switchboard turn_status tool. When you offer the developer choices, ask with AskUserQuestion (options to pick from), not as a list in your message.";

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
  // D75 (1.12.0 – 1.13.0): before D89's artifacts.
  "Before you ask the user a question that refers to a proposal, table, list, plan or comparison, write that content out in a message first, then ask. Never refer to content 'above' that you have not actually written in this conversation. Todo list: when asked to add to it, use the switchboard todo tools with a title, short description, handover plan (or 'No plan: reason'), priority and estimate (minutes); revise those as you learn more; always mark an item in progress when you start it and done when you finish it; check it when asked what's left.",
  // D89 (1.14.0 – 1.14.1): before D94's loops.
  "Before you ask the user a question that refers to a proposal, table, list, plan or comparison, write that content out in a message first, then ask. Never refer to content 'above' that you have not actually written in this conversation. Todo list: when asked to add to it, use the switchboard todo tools with a title, short description, handover plan (or 'No plan: reason'), priority and estimate (minutes); revise those as you learn more; always mark an item in progress when you start it and done when you finish it; check it when asked what's left. Save deliverables the developer should see (reports, plans, docs, diagrams, mockups) with the switchboard artifact_save tool; update the same artifact instead of creating new ones.",
  // D94 (1.15.0 – 1.30.0): before D124's turn_status.
  "Before you ask the user a question that refers to a proposal, table, list, plan or comparison, write that content out in a message first, then ask. Never refer to content 'above' that you have not actually written in this conversation. Todo list: when asked to add to it, use the switchboard todo tools with a title, short description, handover plan (or 'No plan: reason'), priority and estimate (minutes); revise those as you learn more; always mark an item in progress when you start it and done when you finish it; check it when asked what's left. Save deliverables the developer should see (reports, plans, docs, diagrams, mockups) with the switchboard artifact_save tool; update the same artifact instead of creating new ones. For recurring or scheduled work use the switchboard loop_create tool, not CronCreate or /loop.",
  // D124 (1.31.0 – 2.0.1): before D133's question cards.
  "Before you ask the user a question that refers to a proposal, table, list, plan or comparison, write that content out in a message first, then ask. Never refer to content 'above' that you have not actually written in this conversation. Todo list: when asked to add to it, use the switchboard todo tools with a title, short description, handover plan (or 'No plan: reason'), priority and estimate (minutes); revise those as you learn more; always mark an item in progress when you start it and done when you finish it; check it when asked what's left. Save deliverables the developer should see (reports, plans, docs, diagrams, mockups) with the switchboard artifact_save tool; update the same artifact instead of creating new ones. For recurring or scheduled work use the switchboard loop_create tool, not CronCreate or /loop. End every turn without a question card with the switchboard turn_status tool.",
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
export const EDITABLE_SETTINGS = ['sessions.worktrees', 'sessions.ultracode', 'usage.warnAtPct', 'ui.sidebarHidden', 'ui.rightPanelHidden', 'ui.toolsCollapsed', 'ui.sessionsCollapsed', 'ui.chatsCollapsed', 'ui.theme', 'newSession.mode', 'agents.standingInstruction', 'agents.standingInstruction.enabled', 'sessions.todoReminder', 'sessions.checkpoints', 'sessions.todoEnrich', 'sessions.modelRules', 'sessions.freshOffer', 'sessions.freshOfferPct', 'insights.prices', 'ci.sendFailures', 'ci.pendingPollMinutes', 'ci.idlePollMinutes', 'ci.maxAttempts', 'ci.logTailLines', 'ci.mergeMethod', 'power.estimate', 'processes.idleStopMinutes'] as const;

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
  'ui.toolsCollapsed': false,
  'ui.sessionsCollapsed': false,
  'ui.chatsCollapsed': false,
  // D131: the v2 UI unless the service or the browser says otherwise.
  'ui.theme': DEFAULT_UI_THEME,
  'newSession.mode': 'simple',
  'agents.standingInstruction': DEFAULT_STANDING_INSTRUCTION,
  'agents.standingInstruction.enabled': true,
  'sessions.todoReminder': true,
  'sessions.checkpoints': true,
  'sessions.todoEnrich': true,
  'sessions.modelRules': [],
  'sessions.freshOffer': true,
  'sessions.freshOfferPct': FRESH_OFFER_DEFAULT_PCT,
  'insights.prices': EXAMPLE_PRICES,
  // D109: the CI / PR feedback loop (docs/ci.md).
  'ci.sendFailures': true,
  'ci.pendingPollMinutes': 2,
  'ci.idlePollMinutes': 10,
  'ci.maxAttempts': 3,
  'ci.logTailLines': 150,
  'ci.mergeMethod': 'repo',
  // D125: every part at this machine's default.
  'power.estimate': POWER_ESTIMATE_UNSET,
  // D127: the idle stop of a session's leftover processes (docs/processes.md).
  'processes.idleStopMinutes': IDLE_STOP_DEFAULT_MINUTES,
};

/** Bounds of `usage.warnAtPct` (a whole percentage). */
export const WARN_AT_PCT_MIN = 1;
export const WARN_AT_PCT_MAX = 100;

/** `true` if `key` is an editable setting. */
export function isEditableSetting(key: string): key is EditableSettingKey {
  return (EDITABLE_SETTINGS as readonly string[]).includes(key);
}

/** D125: a `power.estimateDefaults` value (zeros when missing: the UI then shows no default). */
function readPowerEstimateModel(value: unknown): PowerEstimateModel {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const watt = (key: string): number => (typeof record[key] === 'number' && Number.isFinite(record[key]) ? (record[key] as number) : 0);
  return { cpuIdleW: watt('cpuIdleW'), cpuMaxW: watt('cpuMaxW'), baseW: watt('baseW') };
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
    'ui.toolsCollapsed': bool('ui.toolsCollapsed', SETTING_DEFAULTS['ui.toolsCollapsed']),
    'ui.sessionsCollapsed': bool('ui.sessionsCollapsed', SETTING_DEFAULTS['ui.sessionsCollapsed']),
    'ui.chatsCollapsed': bool('ui.chatsCollapsed', SETTING_DEFAULTS['ui.chatsCollapsed']),
    'ui.theme': isUiTheme(value['ui.theme']) ? value['ui.theme'] : SETTING_DEFAULTS['ui.theme'],
    'newSession.mode': isNewSessionMode(value['newSession.mode']) ? value['newSession.mode'] : SETTING_DEFAULTS['newSession.mode'],
    'agents.standingInstruction': typeof value['agents.standingInstruction'] === 'string' ? currentStandingInstruction(value['agents.standingInstruction'] as string) : DEFAULT_STANDING_INSTRUCTION,
    'agents.standingInstruction.enabled': bool('agents.standingInstruction.enabled', SETTING_DEFAULTS['agents.standingInstruction.enabled']),
    'sessions.todoReminder': bool('sessions.todoReminder', SETTING_DEFAULTS['sessions.todoReminder']),
    'sessions.checkpoints': bool('sessions.checkpoints', SETTING_DEFAULTS['sessions.checkpoints']),
    'sessions.todoEnrich': bool('sessions.todoEnrich', SETTING_DEFAULTS['sessions.todoEnrich']),
    'sessions.modelRules': readModelRules(value['sessions.modelRules']),
    'sessions.freshOffer': bool('sessions.freshOffer', SETTING_DEFAULTS['sessions.freshOffer']),
    'sessions.freshOfferPct': num('sessions.freshOfferPct', SETTING_DEFAULTS['sessions.freshOfferPct']),
    'insights.prices': readPriceTable(value['insights.prices']),
    'ci.sendFailures': bool('ci.sendFailures', SETTING_DEFAULTS['ci.sendFailures']),
    'ci.pendingPollMinutes': num('ci.pendingPollMinutes', SETTING_DEFAULTS['ci.pendingPollMinutes']),
    'ci.idlePollMinutes': num('ci.idlePollMinutes', SETTING_DEFAULTS['ci.idlePollMinutes']),
    'ci.maxAttempts': num('ci.maxAttempts', SETTING_DEFAULTS['ci.maxAttempts']),
    'ci.logTailLines': num('ci.logTailLines', SETTING_DEFAULTS['ci.logTailLines']),
    'ci.mergeMethod': isCiMergeMethod(value['ci.mergeMethod']) ? value['ci.mergeMethod'] : SETTING_DEFAULTS['ci.mergeMethod'],
    'power.estimate': readPowerEstimateSettings(value['power.estimate']),
    'processes.idleStopMinutes': num('processes.idleStopMinutes', SETTING_DEFAULTS['processes.idleStopMinutes']),
    'power.estimateDefaults': readPowerEstimateModel(value['power.estimateDefaults']),
    'service.startAtLogin': bool('service.startAtLogin', false),
    'service.address': text('service.address') ?? '',
    'workspace.root': text('workspace.root'),
    'workspace.router': text('workspace.router'),
    'github.prPollMinutes': num('github.prPollMinutes', 0),
  };
}
