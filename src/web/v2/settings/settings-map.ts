import { SETTINGS_SECTIONS } from '../../views/settings/model.ts';
import { SETTINGS_WORDS } from '../glossary.ts';
import { V2_SETTINGS_SECTIONS, type V2SettingsSection } from '../routes.ts';

/**
 * D131 · lane R · the v2 Settings map (`docs/v2.md` → *Routes*): the v2 sections,
 * the Advanced pages (`/settings/advanced/<key>`) and where every classic
 * Settings section ends up, so nothing of classic Settings is lost. Pure and
 * DOM-free (unit-tested in `tests/web/v2-settings.test.ts`).
 */

/** What an Advanced page shows (the page component picks the classic section(s) by it). */
export type AdvancedKind =
  | 'code-projects'
  | 'connections'
  | 'clis'
  | 'workspace'
  | 'sessions'
  | 'schedules'
  | 'tools'
  | 'github'
  | 'ci'
  | 'processes'
  | 'jira'
  | 'updates'
  | 'tutorial'
  | 'cleanup'
  | 'setup'
  | 'login'
  | 'claude'
  | 'notify'
  | 'accounts'
  | 'machines'
  | 'devices'
  | 'memory';

/** One Advanced page. */
export interface AdvancedPage {
  /** The URL segment (`/settings/advanced/<key>`); classic section keys keep their classic key. */
  readonly key: AdvancedKind;
  readonly label: string;
  /** The list's second line. */
  readonly sub: string;
  readonly icon: string;
}

/**
 * The Advanced pages, in the order the grouped list shows them ({@link ADVANCED_GROUPS}:
 * Agents, Projects & code, Accounts & devices, Notifications, App). The keys and URLs are
 * unchanged by the grouping (bookmarks, `classicSectionTarget` and deep links keep working).
 */
export const ADVANCED_PAGES: readonly AdvancedPage[] = [
  // Agents
  { key: 'clis', label: 'AI engines & models', sub: 'Engines, model by task, exact model names', icon: 'agents' },
  { key: 'sessions', label: 'Agents & separate copies', sub: 'Separate copies and branches, archived agents, Ultracode, checkpoints, task reminders', icon: 'copy' },
  { key: 'schedules', label: 'Schedules', sub: 'Every routine’s schedule', icon: 'routine' },
  // Project memory (D107) hook, D136: its automatic checks (the notes agents know).
  { key: 'memory', label: 'Notes checks', sub: 'Check notes automatically, how often, per folder', icon: 'book' },
  { key: 'processes', label: 'Background apps', sub: 'Auto-stop when idle', icon: 'cpu' },
  { key: 'tools', label: 'Embedded tools', sub: 'Code graph, browser preview', icon: 'sliders' },
  { key: 'connections', label: 'Connections', sub: 'Tools agents can use (Figma, Jira, App Store Connect…)', icon: 'plug' },
  // Projects & code
  { key: 'workspace', label: 'Folders', sub: 'The folders agents start in', icon: 'folder-plus' },
  { key: 'code-projects', label: 'Code projects', sub: 'Folders, conflicts and freshness', icon: 'folder' },
  { key: 'github', label: 'GitHub', sub: 'Sign-in, change-request detection', icon: 'merge' },
  { key: 'ci', label: 'CI & change requests', sub: 'Automatic tests: retries, who can combine', icon: 'check-circle' },
  { key: 'jira', label: 'Jira', sub: 'The Jira connection projects import from', icon: 'jira' },
  // Accounts & devices
  { key: 'accounts', label: 'Accounts: every option', sub: 'Add accounts, per-engine switching, other computers', icon: 'wallet' },
  { key: 'machines', label: 'Computers: every option', sub: 'Peer listener, pair by address, terminal hooks', icon: 'desktop' },
  { key: 'devices', label: 'Phones: every option', sub: 'Phone access over Tailscale, rename', icon: 'phone' },
  { key: 'claude', label: 'Claude Code service', sub: 'The engine’s path, sign-in, service and permissions', icon: 'shield' },
  // Notifications
  { key: 'notify', label: 'Notifications & prices', sub: 'Test notification, usage warning, prices per model', icon: 'bell' },
  // App
  { key: 'updates', label: 'Updates', sub: 'Version, check for updates, update now', icon: 'refresh' },
  { key: 'login', label: 'Start at login', sub: 'Start Switchboard when you log in', icon: 'laptop' },
  { key: 'cleanup', label: 'Clean-up', sub: 'Preview what can be removed', icon: 'trash' },
  { key: 'tutorial', label: 'What’s new tours', sub: 'Replay a tour', icon: 'book' },
  { key: 'setup', label: 'Setup wizard', sub: 'Run setup again', icon: 'sparkle' },
];

/** A heading of the Advanced list. */
export type AdvancedGroupId = keyof typeof SETTINGS_WORDS.advancedGroups;

/** One heading of the Advanced list and its pages, in order. */
export interface AdvancedGroup {
  readonly id: AdvancedGroupId;
  readonly label: string;
  readonly keys: readonly AdvancedKind[];
}

/**
 * Fix after 2.0 · the Advanced list under headings (the developer's order). Every
 * Advanced page sits in exactly one group (unit-tested); `ADVANCED_PAGES` lists them
 * in this order.
 */
export const ADVANCED_GROUPS: readonly AdvancedGroup[] = [
  { id: 'agents', label: SETTINGS_WORDS.advancedGroups.agents, keys: ['clis', 'sessions', 'schedules', 'memory', 'processes', 'tools', 'connections'] },
  { id: 'code', label: SETTINGS_WORDS.advancedGroups.code, keys: ['workspace', 'code-projects', 'github', 'ci', 'jira'] },
  { id: 'accounts', label: SETTINGS_WORDS.advancedGroups.accounts, keys: ['accounts', 'machines', 'devices', 'claude'] },
  { id: 'notifications', label: SETTINGS_WORDS.advancedGroups.notifications, keys: ['notify'] },
  { id: 'app', label: SETTINGS_WORDS.advancedGroups.app, keys: ['updates', 'login', 'cleanup', 'tutorial', 'setup'] },
];

/** The Advanced list's groups with their pages (a key without a page is skipped). */
export function advancedGroups(): ReadonlyArray<{ readonly group: AdvancedGroup; readonly pages: readonly AdvancedPage[] }> {
  return ADVANCED_GROUPS.map((group) => ({ group, pages: group.keys.map((key) => ADVANCED_PAGES.find((page) => page.key === key)).filter((page): page is AdvancedPage => page !== undefined) }));
}

/** The Advanced page of a `/settings/advanced/<sub>` address; old classic keys resolve (`folders` → Folders, `experimental` → Jira); `null` = the list. */
export function resolveAdvanced(sub: string | null): AdvancedPage | null {
  if (!sub) return null;
  const key = ADVANCED_ALIASES[sub] ?? sub;
  return ADVANCED_PAGES.find((page) => page.key === key) ?? null;
}

/** Other names an Advanced page answers to (classic links, prototype keys). */
const ADVANCED_ALIASES: Readonly<Record<string, AdvancedKind>> = {
  folders: 'workspace',
  experimental: 'jira',
  solutions: 'code-projects',
  mcp: 'connections',
  engines: 'clis',
  copies: 'sessions',
  tests: 'ci',
  bgapps: 'processes',
  tours: 'tutorial',
  wizard: 'setup',
  code: 'code-projects',
  notes: 'memory',
};

/** Classic sections that have a v2 section of their own. */
const CLASSIC_TO_SECTION: Readonly<Record<string, V2SettingsSection>> = { appearance: 'appearance' };

/**
 * Where a classic Settings section lives in v2 Settings: its own section
 * (`appearance`) or an Advanced page (every other one). `null` for an unknown key.
 * (Accounts, Machines and Devices also have their v2 sections Usage, Computers and
 * Phones; their every-option pages stay under Advanced, so nothing is lost.)
 */
export function classicSectionTarget(key: string): { readonly section: V2SettingsSection; readonly sub: string | null } | null {
  const own = CLASSIC_TO_SECTION[key];
  if (own) return { section: own, sub: null };
  const page = resolveAdvanced(key);
  return page ? { section: 'advanced', sub: page.key } : null;
}

/** Every classic Settings section key (`views/settings/model.ts`), plus the old ones still linked. */
export const CLASSIC_SECTION_KEYS: readonly string[] = [...SETTINGS_SECTIONS.map((section) => section.key), 'folders', 'experimental'];

/** A v2 Settings section key, or `null`. */
export function isV2Section(value: string | null | undefined): value is V2SettingsSection {
  return value !== null && value !== undefined && (V2_SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/** The section shown for `/settings` (desktop: Usage & accounts; phone: the list → `null`). */
export function shownSection(section: V2SettingsSection | null, phone: boolean): V2SettingsSection | null {
  if (section) return section;
  return phone ? null : 'usage';
}
