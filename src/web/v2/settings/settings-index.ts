import { INSTALL_APP_DESCRIPTION } from '../../views/settings/install-app.ts';
import { MODEL_RULES_DESCRIPTION, MODEL_RULES_LABEL } from '../../views/settings/model-rules.ts';
import { STANDING_INSTRUCTION_DESCRIPTION, STANDING_INSTRUCTION_LABEL } from '../../views/settings/standing-instruction.ts';
import { START_AT_LOGIN_DESCRIPTION, START_AT_LOGIN_LABEL } from '../../views/settings/start-at-login.ts';
import { ARCHIVE_WORDS, SETTINGS_LABELS, SETTINGS_WORDS as W, THEME_LABELS } from '../glossary.ts';
import type { V2SettingsSection } from '../routes.ts';
import { type AdvancedKind, resolveAdvanced } from './settings-map.ts';

/**
 * Fix after 2.0 · the search index of v2 Settings (`docs/v2.md` → *Settings*): every
 * setting a person may look for, with where it lives, so the search at the top of
 * Settings and the ⌘K palette find a single row, not only a page. Pure and DOM-free
 * (unit-tested in `tests/web/v2-settings-search.test.ts`).
 *
 * Labels come from the words the rows show: the v2 glossary for v2 rows, the classic
 * label constants where classic exports one, and otherwise the classic row's own label
 * written here. `tests/e2e/v2-settings-search.spec.ts` opens every entry's page and checks
 * that its anchor is there and shows its label, so a renamed or moved row fails a test
 * instead of drifting silently.
 */

/** One setting the search can find. */
export interface SettingEntry {
  /** Stable id (`<page>.<row>`), used in `?setting=` and the palette row id. */
  readonly id: string;
  /** The row's label as the page shows it. */
  readonly label: string;
  /** The row's help text (shown as an excerpt). */
  readonly help: string;
  /** Other words it is found by (synonyms, the v2 and classic names). Lower case. */
  readonly keywords: readonly string[];
  /** The v2 Settings section it is in. */
  readonly section: V2SettingsSection;
  /** Its Advanced page (`/settings/advanced/<sub>`), `null` outside Advanced. */
  readonly sub: AdvancedKind | null;
  /** A CSS selector of the row on its page (inside the Settings page), scrolled to and highlighted. */
  readonly anchor: string;
}

/** A `data-row` row (classic rows and the v2 rows that carry one). */
const row = (id: string): string => `[data-row="${id}"]`;
/** An element by its `data-testid`. */
const tid = (id: string): string => `[data-testid="${id}"]`;
/** The body of an Advanced page (for a page that is one setting as a whole). */
const BODY = tid('v2-advanced-body');

type Where = Pick<SettingEntry, 'section' | 'sub'>;
const at = (section: Exclude<V2SettingsSection, 'advanced'>): Where => ({ section, sub: null });
const adv = (sub: AdvancedKind): Where => ({ section: 'advanced', sub });

function entry(id: string, where: Where, label: string, help: string, keywords: string, anchor: string): SettingEntry {
  return { id, label, help, keywords: keywords.split(/\s+/).filter(Boolean), anchor, ...where };
}

/** Every indexed setting, in the order Settings shows them (the tiebreak of the ranking). */
export const SETTINGS_INDEX: readonly SettingEntry[] = [
  // ── Usage & accounts (v2) ──
  entry('usage.accounts', at('usage'), SETTINGS_LABELS.usage, W.usageSub, 'accounts usage limit left 5-hour week weekly subscription sign in login plan', tid('v2-set-usage')),
  entry('usage.switching', at('usage'), W.switchingOn, W.switchingSub, 'switch rotate accounts order automatic limit', tid('v2-account-rules')),
  entry('usage.switch-at', at('usage'), W.switchAt, W.switchingSub, 'threshold percent limit switch earlier', row('accounts-switch-at')),
  entry('usage.all-out', at('usage'), W.whenAllOut, `${W.usePaidExtra} or ${W.pauseNewWork}.`, 'credits paid extra pause out of usage limit exhausted', row('accounts-all-out')),
  entry('usage.switch-back', at('usage'), W.switchBack, W.switchingSub, 'reset first account return back', row('accounts-switch-back')),
  entry('usage.pinned', at('usage'), W.pinnedTitle, W.pinnedSub, 'pin account agent fixed', tid('v2-account-pins')),
  entry('usage.warn-at', at('usage'), W.warnAt, W.warnSub, 'warning warn alert threshold limit usage percent max', tid('v2-usage-warnings')),
  entry('usage.insights', at('usage'), W.insightsTitle, W.seeUsage, 'cost tokens spend money usage breakdown statistics', tid('v2-insights-card')),
  // ── Rules for every agent (v2) ──
  entry('rules.text', at('rules'), SETTINGS_LABELS.rules, W.rulesSub, 'standing instruction prompt system brief agents.md guidelines', tid('v2-set-rules')),
  entry('rules.enabled', at('rules'), W.rulesOn, W.rulesApplies, 'standing instruction on off', row('rules-enabled')),
  entry('rules.apply', at('rules'), W.applyOpen, W.rulesApplies, 'standing instruction restart running update', row('rules-apply')),
  // ── Appearance (v2) ──
  entry('appearance.theme', at('appearance'), THEME_LABELS.row, THEME_LABELS.description, 'classic v2 look design skin old new', row('ui-theme')),
  entry('appearance.scheme', at('appearance'), 'Light or dark', 'Follows your computer unless you pick one.', 'dark mode light night colour color scheme automatic', row('ui-scheme')),
  entry('appearance.density', at('appearance'), W.density, W.densitySub, 'compact comfortable spacing font size chat', row('ui-density')),
  entry('appearance.motion', at('appearance'), W.motionTitle, W.motionNote, 'animation animations reduce motion accessibility', row('reduced-motion')),
  // ── Computers (v2) ──
  entry('computers.self', at('computers'), W.thisComputer, W.computersSub, 'machine computer power battery peer', '[data-testid="v2-computer"][data-self]'),
  entry('computers.add', at('computers'), W.addComputer, W.computersSub, 'pair peer machine tailscale connect second', tid('v2-add-computer')),
  entry('computers.background-apps', at('computers'), W.backgroundApps, 'What agents left running on each computer (dev servers, build servers, test hosts): keep or stop them.', 'processes running stop dev server build leftover', tid('v2-background-apps')),
  entry('computers.shared-layout', at('computers'), W.sharedLayout, W.sharedLayoutSub, 'sync folders pins layout share', tid('v2-shared-layout')),
  entry('computers.shared-accounts', at('computers'), W.sharedAccounts, W.sharedAccountsSub, 'sync accounts share peer', tid('v2-shared-accounts')),
  // ── Phones (v2) ──
  entry('phones.access', at('phones'), 'Phone access', W.phonesSub, 'phone mobile device tablet tailscale remote https', tid('v2-phone-access')),
  entry('phones.pair', at('phones'), W.pairPhone, W.pairNote, 'qr code pair phone device mobile', tid('v2-pair-phone')),

  // ── Advanced › Agents ──
  entry('clis.default', adv('clis'), 'Default CLI', 'What new sessions start on (also in the sidebar’s footer)', 'engine ai claude codex opencode default cli', row('cli-default')),
  entry('clis.models', adv('clis'), 'Models', 'What the New-session forms and the header offer', 'model models opus sonnet haiku names engine', '[data-row^="cli-"][data-row$="-models"]'),
  entry('clis.command', adv('clis'), 'Command', 'The command each engine starts with', 'path binary executable cli engine command', '[data-row^="cli-"][data-row$="-command"]'),
  entry('clis.model-rules', adv('clis'), MODEL_RULES_LABEL, MODEL_RULES_DESCRIPTION, 'routing model by task priority estimate smart fast', row('model-rules')),
  entry('sessions.working-folder', adv('sessions'), 'Working folder', 'A workspace session starts at the folder root, so the router applies; a repo session in the repo or its worktree', 'folder start directory cwd', row('working-folder')),
  entry('sessions.worktrees', adv('sessions'), 'Worktree per session', 'One worktree per solution the session writes to', 'separate copy copies branch branches worktree git isolation', row('worktrees')),
  entry('sessions.worktree-location', adv('sessions'), 'Worktree location', 'Next to the repo', 'separate copy where path worktree', row('worktree-location')),
  entry('sessions.cleanup', adv('sessions'), 'Cleanup', 'Keep until the branch’s PR is merged on GitHub', 'separate copy worktree remove merged keep', row('cleanup')),
  entry('sessions.ultracode', adv('sessions'), 'Ultracode by default', 'Pre-select workflows in the new-session form', 'ultracode workflow workflows default', row('ultracode')),
  entry('sessions.session-start', adv('sessions'), 'Session-start questions', 'Asked in the new-session form and passed to the agent as confirmed answers', 'questions agents.md start', row('session-start')),
  entry('sessions.archive', adv('sessions'), ARCHIVE_WORDS.label, ARCHIVE_WORDS.description, 'archive archived delete old retention days keep history closed', row('archive')),
  entry('sessions.todo-reminder', adv('sessions'), 'Remind the agent to finish started todos', 'When a turn ends with an item it started still in progress, send it one reminder to mark it done or say what’s left', 'task tasks todo reminder finish', row('todo-reminder')),
  entry('sessions.checkpoints', adv('sessions'), 'Save a checkpoint before each turn', 'Snapshots the session’s git working trees so a turn can be reverted; kept 7 days or 100 turns', 'undo revert checkpoint snapshot turn', row('checkpoints')),
  entry('sessions.todo-enrich', adv('sessions'), 'Let the agent fill in captured todos', 'A todo captured from ⌘K, a chat selection or the share sheet is filled in by its agent when it is next idle', 'task tasks todo capture fill describe', row('todo-enrich')),
  entry('sessions.standing-instruction', adv('sessions'), STANDING_INSTRUCTION_LABEL, STANDING_INSTRUCTION_DESCRIPTION, 'rules prompt instruction every agent', row('standing-instruction')),
  entry('sessions.fresh-offer', adv('sessions'), 'Fresh session when the context fills', 'Offer to continue in a fresh session once the context reaches this share of the window', 'context window working memory clean slate handover full', row('fresh-offer')),
  entry('schedules.list', adv('schedules'), 'Schedules', 'Every routine’s schedule', 'cron routine routines loop loops timer recurring', BODY),
  entry('memory.check', adv('memory'), 'Check notes automatically', 'A short check looks for duplicate and contradicting notes, and verifies approved notes against the code', 'notes memory check duplicates verify', row('memory-check')),
  entry('memory.frequency', adv('memory'), 'How often', 'Per folder with approved notes, only after agents worked there, and never while your usage is at the warning level', 'notes memory check frequency interval days', row('memory-check-frequency')),
  entry('processes.idle-stop', adv('processes'), 'Stop leftovers when idle', 'What an agent left running (.NET build servers, test hosts, dev servers) is stopped once it has been idle this long', 'background apps processes idle stop kill leftover dev server', row('processes-idle-stop')),
  entry('processes.build-defaults', adv('processes'), '.NET build servers', 'No MSBuild node or VBCSCompiler outlives an agent’s build', 'dotnet msbuild build server compiler', row('processes-build-defaults')),
  entry('tools.list', adv('tools'), 'Embedded tools', 'Code graph, browser preview', 'tool tools iframe frame url embed graph preview browser', BODY),
  entry('tools.frame-helper', adv('tools'), 'Frame helper', 'A Chrome extension that lets signed-in sites such as Jira open in a tool frame', 'chrome extension frame iframe jira', row('frame-helper')),
  entry('connections.list', adv('connections'), 'Connections', 'Tools agents can use (Figma, Jira, App Store Connect…)', 'mcp server servers figma jira tools integrations', BODY),
  // ── Advanced › Projects & code ──
  entry('workspace.folders', adv('workspace'), 'Folders', 'The folders agents start in', 'workspace root folder folders add path directory', BODY),
  entry('code-projects.list', adv('code-projects'), 'Code projects', 'Folders, conflicts and freshness', 'solutions repos repositories repo conflicts freshness git', BODY),
  entry('github.login', adv('github'), 'GitHub CLI login', 'Reused from gh auth. No token stored in Switchboard.', 'github gh sign in token auth', row('gh-login')),
  entry('github.pr-detection', adv('github'), 'PR merge detection', 'Marks a worktree ready to remove once its PR is merged', 'pull request change request merged poll', row('pr-detection')),
  entry('github.repositories', adv('github'), 'Repositories', 'Matched from each solution’s git remote', 'repos remote git', row('repositories')),
  entry('ci.send-failures', adv('ci'), 'Send CI failures to the session', 'When a check of a pull request fails, send the end of the failing job’s log to the agent and ask it to fix and push', 'ci automatic tests checks failure fix', row('ci-send-failures')),
  entry('ci.max-attempts', adv('ci'), 'Fixes per pull request', 'After this many failures sent for one PR, Switchboard stops and asks you', 'ci retries attempts automatic tests', row('ci-max-attempts')),
  entry('ci.log-lines', adv('ci'), 'Log lines sent', 'How much of the end of the failing job’s log goes with the message', 'ci log lines', row('ci-log-lines')),
  entry('ci.pending-poll', adv('ci'), 'While checks run', 'How often a pull request whose checks are still running is read again', 'ci poll interval checks', row('ci-pending-poll')),
  entry('ci.idle-poll', adv('ci'), 'Otherwise', 'How often any other open pull request is read again', 'ci poll interval pull request', row('ci-idle-poll')),
  entry('ci.merge-method', adv('ci'), 'Merge method', 'How Merge PR merges (gh pr merge). Nothing is merged without your click', 'combine merge squash rebase method', row('ci-merge-method')),
  entry('jira.connection', adv('jira'), 'Jira', 'The Jira connection projects import from', 'jira atlassian token api import connection', BODY),
  // ── Advanced › Accounts & devices ──
  entry('accounts.enabled', adv('accounts'), 'Switch accounts automatically', 'When a session hits its session or weekly limit, it continues on the next account with allowance.', 'accounts switch rotate limit', row('accounts-enabled')),
  entry('accounts.per-cli', adv('accounts'), 'For', 'Each CLI switches on its own.', 'accounts engine cli per', row('accounts-per-cli')),
  entry('accounts.thresholds', adv('accounts'), 'Switch earlier, before the limit error', 'At these percentages of the 5-hour and the weekly allowance', 'accounts threshold percent limit', row('accounts-thresholds')),
  entry('accounts.after-reset', adv('accounts'), 'After the limit resets', 'Stay where the session is, or go back to the first account as soon as it has allowance', 'accounts reset back first', row('accounts-after-reset')),
  entry('accounts.new', adv('accounts'), 'New sessions start on', 'The first account with allowance, or a fixed account per CLI.', 'accounts new start fixed', row('accounts-new')),
  entry('accounts.out-of-allowance', adv('accounts'), 'When every account is out of allowance', 'An account past its plan limit can keep working on credits (paid extra usage)', 'accounts credits paid extra exhausted', row('accounts-out-of-allowance')),
  entry('accounts.exhausted', adv('accounts'), 'When every account of a CLI is out of usage', 'Stop and tell you, or hand the session over to another CLI with a handover summary', 'accounts handover engine exhausted', row('accounts-exhausted')),
  entry('machines.self', adv('machines'), 'This machine', 'This computer’s name, id, power and terminal hooks', 'computer machine hooks terminal name id', row('self')),
  entry('machines.power', adv('machines'), 'Power estimate', 'Used only while this machine has no battery: its draw is estimated from the GPU, the CPU and the rest of the system', 'power battery watts energy', row('power-estimate')),
  entry('machines.peer-listener', adv('machines'), 'Peer listener', 'Lets paired computers reach this one over Tailscale', 'port listen listener tailscale peer network 13002', row('peer-listener')),
  entry('machines.allow-peer', adv('machines'), 'Allow a new peer', 'Shows a one-time code for another machine to pair with this one', 'pair code peer computer', row('allow-peer')),
  entry('machines.add', adv('machines'), 'Add machine', 'The other machine’s Tailscale address and the code it shows', 'pair add computer address tailscale ip', row('add-machine')),
  entry('devices.access', adv('devices'), 'Device access', 'Use Switchboard from your phone or tablet over Tailscale', 'phone tablet mobile tailscale https port remote', row('device-access')),
  entry('devices.pair', adv('devices'), 'Pair a device', 'Shows a QR code and a one-time code (10 minutes, single use)', 'phone qr code pair tablet', row('pair-device')),
  entry('claude.cli', adv('claude'), 'CLI', 'Where the Claude Code engine was found', 'claude code engine path binary', row('cli')),
  entry('claude.account', adv('claude'), 'Account', 'Uses the CLI’s own login. Switchboard stores no credentials.', 'claude login sign in account', row('account')),
  entry('claude.service', adv('claude'), 'Background service', 'Starts and supervises Claude Code processes', 'service daemon background port address', row('service')),
  entry('claude.bind', adv('claude'), 'Bind address', 'The service never listens beyond this PC', 'bind address localhost port network listen security', row('bind')),
  entry('claude.permissions', adv('claude'), 'Permissions', 'Follow Claude Code’s .claude/settings.json', 'permissions allow deny claude settings.json', row('permissions')),
  // ── Advanced › Notifications ──
  entry('notify.toast', adv('notify'), 'In-app toast + sound', 'Questions, approvals, failed scheduled runs, merged-PR worktrees', 'sound loud chime noise toast notification test alert', row('toast')),
  entry('notify.os', adv('notify'), 'OS notifications', 'Windows / macOS notification center, also when the tab is in the background', 'notification notifications desktop system allow permission', row('os-notifications')),
  entry('notify.near-limit', adv('notify'), 'Near the limit', 'Sessions and scheduled runs keep going', 'usage limit warn', row('near-limit')),
  entry('notify.prices', adv('notify'), 'Prices (Insights)', 'The price per million tokens of each model, for Insights’ cost', 'token tokens cost costs price prices money dollars model insights', row('insights-prices')),
  // ── Advanced › App ──
  entry('updates.check', adv('updates'), 'Updates', 'Version, check for updates, update now', 'update upgrade version release latest restart new', BODY),
  entry('login.start', adv('login'), START_AT_LOGIN_LABEL, START_AT_LOGIN_DESCRIPTION, 'login startup boot autostart launch sign in', row('start-at-login')),
  entry('cleanup.scan', adv('cleanup'), 'Clean-up', 'Preview what can be removed', 'clean cleanup disk space remove delete worktrees old', BODY),
  entry('tutorial.tours', adv('tutorial'), 'What’s new tours', 'Replay a tour', 'tour tours tutorial whats new replay welcome help', tid('v2-tours')),
  entry('setup.run', adv('setup'), W.runSetup, W.runSetupSub, 'setup wizard onboarding start again', tid('v2-run-setup')),
];

/** Not shown in the index, but kept here so one place lists the rows left out on purpose and why. */
export const UNINDEXED_ROWS: Readonly<Record<string, string>> = {
  'devices.this-device / device-notifications': 'shown only on a paired phone (the page opened on that phone)',
  'accounts.machine': 'shown only while a paired computer is online',
  'claude.install-app / phones.install': `shown only when the browser offers the install (${INSTALL_APP_DESCRIPTION})`,
  'updates.*': 'the rows appear only when updates are on (the section is one entry)',
  'notify.warn-at': 'the same setting as Usage & accounts › Warn at Max usage (indexed there)',
};

/** The words of a query (lower case, no empty ones). */
function words(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** The starts of the words of a text (lower case). */
function wordStarts(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}.]+/u).filter(Boolean);
}

/** A word matches a list of words when one of them starts with it. */
const startsAny = (word: string, list: readonly string[]): boolean => list.some((candidate) => candidate.startsWith(word) || candidate.replace(/^\.+/, '').startsWith(word));

/** The page name of an entry ("Advanced", then its Advanced page; or its section). */
export function settingPlace(entry: Pick<SettingEntry, 'section' | 'sub'>): string[] {
  if (entry.section !== 'advanced') return [SETTINGS_LABELS[entry.section]];
  const page = resolveAdvanced(entry.sub);
  return [SETTINGS_LABELS.advanced, ...(page ? [page.label] : [])];
}

/** The breadcrumb of an entry: "Advanced › Agents & separate copies › Delete archived agents after". */
export function settingCrumbs(entry: SettingEntry): string {
  return [...settingPlace(entry), entry.label].join(W.crumbSep);
}

/** The address of an entry: its page, with `?setting=<id>` (the page scrolls to the row and highlights it). */
export function settingPath(entry: Pick<SettingEntry, 'id' | 'section' | 'sub'>): string {
  const base = entry.section === 'advanced' && entry.sub ? `/settings/advanced/${entry.sub}` : `/settings/${entry.section}`;
  return `${base}?setting=${encodeURIComponent(entry.id)}`;
}

/** The entry of an id, or `null`. */
export function settingById(id: string | null | undefined): SettingEntry | null {
  if (!id) return null;
  return SETTINGS_INDEX.find((candidate) => candidate.id === id) ?? null;
}

/** How a setting matched: 0 = the label is the query, 1 = the label starts with it, 2 = every word starts a label word, 3 = a keyword, 4 = the help text or the page. Words match at the start of a word ("port" finds "port", not "import"). */
export type SettingRank = 0 | 1 | 2 | 3 | 4;

/** A found setting. */
export interface SettingHit {
  readonly entry: SettingEntry;
  readonly rank: SettingRank;
}

/** How well `entry` matches `query` (see {@link SettingRank}); `null` = some word is nowhere. */
export function settingRank(entry: SettingEntry, query: string): SettingRank | null {
  const q = query.trim().toLowerCase();
  const qs = words(q);
  if (qs.length === 0) return null;
  const label = entry.label.toLowerCase();
  if (label === q) return 0;
  if (label.startsWith(q)) return 1;
  const labelWords = wordStarts(entry.label);
  if (qs.every((word) => startsAny(word, labelWords))) return 2;
  const named = [...labelWords, ...entry.keywords];
  if (qs.every((word) => startsAny(word, named))) return 3;
  const rest = [...named, ...wordStarts(entry.help), ...wordStarts(settingPlace(entry).join(' '))];
  if (qs.every((word) => startsAny(word, rest))) return 4;
  return null;
}

/** The settings that match `query`, best first (then in the order Settings shows them); none for an empty query. */
export function searchSettings(query: string, index: readonly SettingEntry[] = SETTINGS_INDEX, max = 40): SettingHit[] {
  return index
    .map((entry, position) => ({ entry, position, rank: settingRank(entry, query) }))
    .filter((hit): hit is { entry: SettingEntry; position: number; rank: SettingRank } => hit.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.position - b.position)
    .slice(0, max)
    .map(({ entry, rank }) => ({ entry, rank }));
}

/** A piece of text, marked when it matches a query word. */
export interface MarkedPart {
  readonly text: string;
  readonly match: boolean;
}

/** `text` split into parts where the query's words are marked at the start of a word (case-insensitive; plain text, never HTML). */
export function markParts(text: string, query: string): MarkedPart[] {
  const qs = words(query).sort((a, b) => b.length - a.length);
  if (qs.length === 0 || text === '') return [{ text, match: false }];
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const word of qs) {
    for (let from = lower.indexOf(word); from !== -1; from = lower.indexOf(word, from + 1)) {
      if (from > 0 && /[\p{L}\p{N}]/u.test(lower[from - 1] ?? '')) continue;
      for (let i = from; i < from + word.length; i += 1) marked[i] = true;
    }
  }
  const parts: MarkedPart[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const last = parts.at(-1);
    const char = text[i] ?? '';
    if (last && last.match === marked[i]) parts[parts.length - 1] = { text: last.text + char, match: last.match };
    else parts.push({ text: char, match: marked[i] === true });
  }
  return parts;
}

/** The help text cut to about `length` characters around its first match (with "…" where cut). */
export function helpExcerpt(help: string, query: string, length = 140): string {
  if (help.length <= length) return help;
  const lower = help.toLowerCase();
  const first = words(query)
    .map((word) => lower.indexOf(word))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (first === undefined || first < length - 30) return `${help.slice(0, length).trimEnd()}…`;
  const start = Math.max(0, first - 40);
  const end = Math.min(help.length, start + length);
  return `${start > 0 ? '…' : ''}${help.slice(start, end).trim()}${end < help.length ? '…' : ''}`;
}
