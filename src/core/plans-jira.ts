/**
 * D99 · Plans · Jira (`docs/plans.md` → *Jira import and status sync*; contract → *Plans ·
 * Jira (D99)* in `docs/handoff/contracts/local-api.md`): the shapes and the pure rules of the
 * Jira import (an epic's child issues → plan items, their "blocks" links → dependencies) and
 * of the optional status sync. No I/O here: the server's `src/server/plans/jira/` reads Jira.
 */
import { findCycle, type PlanEdge } from './plans.ts';
import { SIDEBAR_FOLDER_NAME_MAX, type SidebarLayout, type SidebarTreeProblem, addFolder, checkFolderParent, placeSession } from './sidebar-layout.ts';
import type { JiraContextCounts } from './plans-jira-context.ts';
import { TODO_DESCRIPTION_MAX, TODO_TITLE_MAX, type TodoToolDefinition } from './todos.ts';

// ── sync settings ─────────────────────────────────────────────────────────

/**
 * A plan's Jira status sync (per plan, chosen in the import dialog, changeable on the plan):
 * - `off` (default): nothing is read or written after the import;
 * - `read-only`: the tickets' title, status and description are read again on demand and
 *   every {@link JIRA_REFRESH_MS} while the plan runs; a status drift is noted on the item;
 * - `write`: `read-only`, plus transitions and comments as the items' runs move.
 */
export const JIRA_SYNC_MODES = ['off', 'read-only', 'write'] as const;
/** One of {@link JIRA_SYNC_MODES}. */
export type JiraSyncMode = (typeof JIRA_SYNC_MODES)[number];

/** The transition names the write mode looks for in an issue's available transitions (matched by name, case-insensitive). */
export interface JiraTransitionNames {
  /** When the item's run starts. */
  readonly inProgress: string;
  /** When the item's pull request opens. */
  readonly inReview: string;
  /** D116: when the item's work is merged into the plan's target (only with {@link PlanJiraState.doneOnMerge}). */
  readonly done: string;
}

/** The default transition names. */
export const DEFAULT_JIRA_TRANSITIONS: JiraTransitionNames = { inProgress: 'In Progress', inReview: 'In Review', done: 'Done' };

/**
 * D116 · "Move to Done when merged into the feature branch": on for a new plan (the import's
 * default when the body omits it); a plan imported before D116 has it off.
 */
export const DEFAULT_JIRA_DONE_ON_MERGE = true;

/** How often a running plan's tickets are read again (read-only and write). */
export const JIRA_REFRESH_MS = 30 * 60_000;

/** The longest transition name accepted. */
export const JIRA_TRANSITION_NAME_MAX = 60;

/** The most activity entries kept per plan (oldest dropped). */
export const JIRA_ACTIVITY_MAX = 200;

/** The most child issues read from one epic (the plan's own limit is lower; the preview says when it cuts). */
export const JIRA_IMPORT_MAX = 100;

// ── preview ───────────────────────────────────────────────────────────────

/** One child issue of the epic as the preview shows it. */
export interface JiraPreviewItem {
  readonly key: string;
  readonly summary: string;
  /** The description as plain text (`null` = none). */
  readonly description: string | null;
  /** From the "Acceptance criteria" custom field, else a description section of that name; `null` = none found. */
  readonly acceptanceCriteria: string | null;
  /** Where {@link acceptanceCriteria} came from. */
  readonly acceptanceSource: 'field' | 'description' | null;
  readonly components: readonly string[];
  readonly status: string | null;
  readonly assignee: string | null;
  /** The original estimate in minutes (`timeoriginalestimate`), `null` = none. */
  readonly estimateMinutes: number | null;
  /** `<base>/browse/<key>`. */
  readonly url: string;
  /** `true` when no dependency inside the epic names it (flagged in the preview). */
  readonly unlinked: boolean;
  /** D118: what the agents will get besides the text (the preview only; the import's answer leaves it out). */
  readonly counts?: JiraContextCounts;
}

/** A dependency inside the epic: `to` waits on `from` (the plan's "`to` after `from`"). */
export interface JiraPreviewEdge extends PlanEdge {
  /** "PROJ-12 waits on PROJ-11". */
  readonly text: string;
}

/** A "blocks" link to an issue outside the epic: shown as a note, never a dependency. */
export interface JiraExternalLink {
  /** The epic's issue. */
  readonly key: string;
  /** The issue outside the epic. */
  readonly other: string;
  /** `waits-on`: {@link key} is blocked by {@link other}; `blocks`: {@link key} blocks {@link other}. */
  readonly relation: 'waits-on' | 'blocks';
  /** "PROJ-12 waits on PROJ-99 (outside the epic)". */
  readonly text: string;
}

/** A link left out because it would close a cycle (the plan refuses cycles). */
export interface JiraCycleLink extends PlanEdge {
  /** The keys around the cycle the link would close, ending where it starts. */
  readonly cycle: readonly string[];
  /** "PROJ-13 waits on PROJ-15 was left out: PROJ-15 → PROJ-13 → PROJ-15 would be a cycle". */
  readonly text: string;
}

/** `POST /api/sessions/{id}/plans/jira/preview`: what an import would create. Nothing is created. */
export interface JiraPreview {
  /**
   * D118: the preview also reads the epic's description, acceptance criteria and counts (shown
   * collapsed in the dialog: the plan's agent gets them in full, each run shortened).
   */
  readonly epic: { readonly key: string; readonly summary: string; readonly url: string; readonly description?: string | null; readonly acceptanceCriteria?: string | null; readonly counts?: JiraContextCounts };
  readonly items: readonly JiraPreviewItem[];
  /** The dependencies that would be created. */
  readonly edges: readonly JiraPreviewEdge[];
  readonly externalLinks: readonly JiraExternalLink[];
  /** Links left out because of a cycle. */
  readonly cycles: readonly JiraCycleLink[];
  /** The keys of {@link items} without a dependency inside the epic. */
  readonly unlinked: readonly string[];
  /** Children beyond {@link JIRA_IMPORT_MAX} that were not read. */
  readonly truncated: boolean;
  /** "PROJ-10 Acme checkout" (the dialog pre-fills the plan title). */
  readonly suggestedTitle: string;
  /** `feature/PROJ-10-acme-checkout` (the dialog pre-fills the target branch). */
  readonly suggestedTargetBranch: string;
  /**
   * Whether the dialog itself proposes an order: always `false`. The missing order is proposed
   * after the import, on the plan: the source session's agent is asked (`plan_propose_dependencies`)
   * and the developer ticks its proposals (`PlanEdgeProposals`; ruling D99-Jira-q1 (b)).
   */
  readonly proposeAvailable: boolean;
}

// ── state shown on a plan ─────────────────────────────────────────────────

/** A ticket as last read for a plan item. */
export interface PlanJiraItem {
  readonly itemId: string;
  readonly key: string;
  readonly url: string;
  /** The status read at the import. */
  readonly statusAtImport: string | null;
  /** The status last read. */
  readonly status: string | null;
  /** Its category (`new`, `indeterminate`, `done`), as Jira reports it. */
  readonly statusCategory: string | null;
  readonly summary: string | null;
  /** When the ticket was last read (`null` = only at the import). */
  readonly refreshedAt: string | null;
  /** A Jira status drift ("Jira says Done; the item is running"), `null` = none. */
  readonly drift: string | null;
  /** The last soft failure of a write ("no transition In Review for PROJ-12"), `null` = none. */
  readonly syncNote: string | null;
}

/** One line of a plan's Jira activity: every write, every soft failure, every refresh. */
export interface PlanJiraActivity {
  readonly id: string;
  readonly at: string;
  readonly itemId: string | null;
  readonly key: string | null;
  /** D115: `ask-repos` = the plan's agent was asked to pick its items' repositories. D121: `reopened` = an item done by mistake was reopened. */
  readonly kind: 'import' | 'refresh' | 'transition' | 'comment' | 'soft-failure' | 'error' | 'settings' | 'ask-repos' | 'reopened';
  readonly text: string;
}

/** `GET /api/plans/{id}/jira`: a plan's Jira link, its sync setting and what it did. */
export interface PlanJiraState {
  readonly planId: string;
  readonly epicKey: string;
  /** `<base>/browse/<epic>`. */
  readonly epicUrl: string;
  readonly sync: JiraSyncMode;
  readonly transitions: JiraTransitionNames;
  /** D116: the write mode moves a ticket to Done ({@link JiraTransitionNames.done}) once its item is merged into the target. */
  readonly doneOnMerge: boolean;
  readonly lastRefreshAt: string | null;
  readonly items: readonly PlanJiraItem[];
  /** Newest first. */
  readonly activity: readonly PlanJiraActivity[];
}

/** `GET /api/integrations/jira`: whether Jira is configured on this machine (the token is never answered). */
export interface JiraConnectionStatus {
  readonly configured: boolean;
  /** Where the credentials come from: Settings (the OS keychain) or the environment (`ATL_*`); `null` = none. */
  readonly source: 'settings' | 'env' | null;
  readonly baseUrl: string | null;
  readonly email: string | null;
  /** Whether Settings can store credentials here (an OS keychain is available). */
  readonly keychain: boolean;
}

// ── parsing ───────────────────────────────────────────────────────────────

const KEY_RE = /[A-Z][A-Z0-9]*-[0-9]+/g;

/**
 * The epic's key from what the developer pasted: a key (`proj-10` too) or an issue URL
 * (`https://acme.atlassian.net/browse/PROJ-10`, `…?selectedIssue=PROJ-10`); `null` = none found.
 */
export function parseEpicKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  if (/^[A-Za-z][A-Za-z0-9]*-[0-9]+$/.test(text)) return text.toUpperCase();
  const selected = /[?&]selectedIssue=([A-Za-z][A-Za-z0-9]*-[0-9]+)/.exec(text);
  if (selected?.[1]) return selected[1].toUpperCase();
  const found = text.toUpperCase().match(KEY_RE);
  return found && found.length > 0 ? (found[found.length - 1] as string) : null;
}

/**
 * A Jira base URL as Switchboard accepts it: `https://<host>` (a path is dropped), or
 * `http://` only on loopback (the tests' fake Jira). `null` = not acceptable.
 */
export function normalizeJiraBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  return url.origin;
}

// ── Atlassian Document Format → text ──────────────────────────────────────

interface AdfNode {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly content?: unknown;
  readonly attrs?: unknown;
}

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? (node.content.filter((child) => typeof child === 'object' && child !== null) as AdfNode[]) : [];
}

function inlineText(node: AdfNode): string {
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention' || node.type === 'emoji' || node.type === 'inlineCard') {
    const attrs = (typeof node.attrs === 'object' && node.attrs !== null ? node.attrs : {}) as Record<string, unknown>;
    const text = attrs['text'] ?? attrs['shortName'] ?? attrs['url'];
    return typeof text === 'string' ? text : '';
  }
  return children(node).map(inlineText).join('');
}

function blockText(node: AdfNode, indent = ''): string {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return indent + inlineText(node);
    case 'bulletList':
    case 'orderedList':
      return children(node)
        .map((item, index) => {
          const marker = node.type === 'orderedList' ? `${index + 1}. ` : '- ';
          const [first, ...rest] = children(item).map((child) => blockText(child, `${indent}  `).trimStart());
          return [`${indent}${marker}${first ?? ''}`, ...rest.map((line) => `${indent}  ${line}`)].join('\n');
        })
        .join('\n');
    case 'taskList':
      return children(node)
        .map((item) => `${indent}- [${(item.attrs as Record<string, unknown> | undefined)?.['state'] === 'DONE' ? 'x' : ' '}] ${inlineText(item)}`)
        .join('\n');
    case 'codeBlock':
      return `${indent}${inlineText(node)}`;
    case 'rule':
      return `${indent}---`;
    default:
      return children(node).length > 0 ? children(node).map((child) => blockText(child, indent)).join('\n') : inlineText(node);
  }
}

/** Plain text of a Jira field value: an ADF document (API v3), or a string (a plain text field); `null` when empty. */
export function adfToText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value !== 'object') return null;
  const blocks = children(value as AdfNode);
  const text = (blocks.length > 0 ? blocks.map((block) => blockText(block)).join('\n\n') : inlineText(value as AdfNode)).replace(/\n{3,}/g, '\n\n').trim();
  return text === '' ? null : text;
}

const AC_HEADING = /^\s*(?:#+\s*)?(?:\*\*)?acceptance\s+criteria(?:\*\*)?\s*:?\s*$/i;

/**
 * Splits a description into its text and an "Acceptance criteria" section: an ADF heading of
 * that name, or a line that is just "Acceptance criteria" / "Acceptance criteria:"; the
 * section runs to the next heading (ADF) or to the end. `acceptance` is `null` when there is none.
 */
export function splitAcceptanceCriteria(description: unknown): { readonly text: string | null; readonly acceptance: string | null } {
  if (description !== null && typeof description === 'object') {
    const blocks = children(description as AdfNode);
    const at = blocks.findIndex((block) => (block.type === 'heading' || block.type === 'paragraph') && AC_HEADING.test(inlineText(block)));
    if (at >= 0) {
      const level = (blocks[at]?.attrs as Record<string, unknown> | undefined)?.['level'];
      let end = blocks.length;
      for (let index = at + 1; index < blocks.length; index += 1) {
        const block = blocks[index] as AdfNode;
        const next = (block.attrs as Record<string, unknown> | undefined)?.['level'];
        if (block.type === 'heading' && (typeof level !== 'number' || typeof next !== 'number' || next <= level)) {
          end = index;
          break;
        }
      }
      const doc = (content: AdfNode[]) => ({ type: 'doc', content });
      return { text: adfToText(doc([...blocks.slice(0, at), ...blocks.slice(end)])), acceptance: adfToText(doc(blocks.slice(at + 1, end))) };
    }
    return { text: adfToText(description), acceptance: null };
  }
  const text = adfToText(description);
  if (text === null) return { text: null, acceptance: null };
  const lines = text.split('\n');
  const at = lines.findIndex((line) => AC_HEADING.test(line));
  if (at < 0) return { text, acceptance: null };
  const before = lines.slice(0, at).join('\n').trim();
  const after = lines.slice(at + 1).join('\n').trim();
  return { text: before === '' ? null : before, acceptance: after === '' ? null : after };
}

// ── issues → preview ──────────────────────────────────────────────────────

/** The fields of a Jira issue the import reads (`GET /rest/api/3/search/jql`). */
export interface JiraIssueInput {
  readonly key: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nameOf(value: unknown, field = 'name'): string | null {
  const found = record(value)?.[field];
  return typeof found === 'string' && found.trim() !== '' ? found.trim() : null;
}

/** A "blocks" link type (by its name `Blocks`, or its outward / inward words). */
export function isBlocksLink(type: unknown): boolean {
  const value = record(type);
  if (!value) return false;
  const name = String(value['name'] ?? '').toLowerCase();
  const outward = String(value['outward'] ?? '').toLowerCase();
  const inward = String(value['inward'] ?? '').toLowerCase();
  return name === 'blocks' || outward === 'blocks' || inward === 'is blocked by';
}

/**
 * The "blocks" links of an issue, as "`to` waits on `from`" pairs (both directions read).
 *
 * Jira REST v3 (`fields=issuelinks`; D117, the D99 direction fix): a link entry on an issue
 * carries the **other** issue, under the side that other issue is on, and Jira shows the
 * **opposite** side's verb. For the type `{ name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }`:
 * - on X ("X blocks Y" in Jira's UI) the entry is `{ inwardIssue: Y }`: Y waits on X;
 * - on Y ("Y is blocked by X") the entry is `{ outwardIssue: X }`: Y waits on X.
 *
 * So on issue I, `outwardIssue: O` means "I is blocked by O" (I waits on O) and
 * `inwardIssue: N` means "I blocks N" (N waits on I). Both sides of one link give the same
 * pair; {@link buildJiraPreview} keeps it once.
 */
export function blocksLinks(issue: JiraIssueInput): Array<{ readonly from: string; readonly to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  const links = Array.isArray(issue.fields['issuelinks']) ? (issue.fields['issuelinks'] as unknown[]) : [];
  for (const raw of links) {
    const link = record(raw);
    if (!link || !isBlocksLink(link['type'])) continue;
    const outward = nameOf(link['outwardIssue'], 'key');
    const inward = nameOf(link['inwardIssue'], 'key');
    // `outwardIssue: O` = "this issue is blocked by O": this one waits on O.
    if (outward) out.push({ from: outward.toUpperCase(), to: issue.key });
    // `inwardIssue: N` = "this issue blocks N": N waits on this one.
    if (inward) out.push({ from: issue.key, to: inward.toUpperCase() });
  }
  return out;
}

/** The ticket number of a key, for ordering (`PROJ-12` → 12). */
function keyNumber(key: string): number {
  return Number(key.slice(key.lastIndexOf('-') + 1));
}

/** Keys in ticket order (project, then number). */
export function compareKeys(a: string, b: string): number {
  const pa = a.slice(0, a.lastIndexOf('-'));
  const pb = b.slice(0, b.lastIndexOf('-'));
  return pa === pb ? keyNumber(a) - keyNumber(b) : pa < pb ? -1 : 1;
}

/** A short branch slug of a title (lower case, dashes, ≤ 40 characters). */
function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** One issue as a {@link JiraPreviewItem} (the import's preview, and the read-only refresh). */
export function jiraPreviewItem(issue: JiraIssueInput, baseUrl: string, acceptanceField: string | null, unlinked: boolean): JiraPreviewItem {
  const fields = issue.fields;
  const split = splitAcceptanceCriteria(fields['description']);
  const fromField = acceptanceField ? adfToText(fields[acceptanceField]) : null;
  const seconds = typeof fields['timeoriginalestimate'] === 'number' ? fields['timeoriginalestimate'] : null;
  const components = Array.isArray(fields['components']) ? (fields['components'] as unknown[]).map((component) => nameOf(component)).filter((name): name is string => name !== null) : [];
  return {
    key: issue.key,
    summary: typeof fields['summary'] === 'string' ? fields['summary'].trim() : issue.key,
    description: fromField !== null ? adfToText(fields['description']) : split.text,
    acceptanceCriteria: fromField ?? split.acceptance,
    acceptanceSource: fromField !== null ? 'field' : split.acceptance !== null ? 'description' : null,
    components,
    status: nameOf(fields['status']),
    assignee: nameOf(fields['assignee'], 'displayName'),
    estimateMinutes: seconds !== null && seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : null,
    url: `${baseUrl}/browse/${issue.key}`,
    unlinked,
  };
}

/** An issue's status category key (`new`, `indeterminate`, `done`), `null` = unknown. */
export function statusCategoryOf(issue: JiraIssueInput): string | null {
  const status = record(issue.fields['status']);
  const category = record(status?.['statusCategory'])?.['key'];
  return typeof category === 'string' ? category : null;
}

/** Input of {@link buildJiraPreview}. */
export interface JiraPreviewInput {
  readonly baseUrl: string;
  readonly epic: JiraIssueInput;
  /** The epic's child issues. */
  readonly children: readonly JiraIssueInput[];
  /** The id of the "Acceptance criteria" custom field, when Jira has one. */
  readonly acceptanceField: string | null;
  readonly truncated?: boolean;
}

/**
 * D99-Jira: the preview of an epic's import. Items in ticket order; every "blocks" link
 * between two children becomes a dependency ("PROJ-12 waits on PROJ-11"), links to issues
 * outside the epic become notes, and a link that would close a cycle is left out and
 * reported with the cycle (links are taken in ticket order, so the report is stable).
 */
export function buildJiraPreview(input: JiraPreviewInput): JiraPreview {
  const browse = (key: string) => `${input.baseUrl}/browse/${key}`;
  const issues = [...input.children].sort((a, b) => compareKeys(a.key, b.key));
  const inside = new Set(issues.map((issue) => issue.key));
  const seen = new Set<string>();
  const internal: Array<{ from: string; to: string }> = [];
  const externalLinks: JiraExternalLink[] = [];
  const seenExternal = new Set<string>();
  for (const issue of issues) {
    for (const link of blocksLinks(issue)) {
      if (link.from === link.to) continue;
      const id = `${link.from}>${link.to}`;
      if (inside.has(link.from) && inside.has(link.to)) {
        if (!seen.has(id)) {
          seen.add(id);
          internal.push(link);
        }
        continue;
      }
      const own = inside.has(link.to) ? link.to : link.from;
      const other = own === link.to ? link.from : link.to;
      const relation = own === link.to ? 'waits-on' : 'blocks';
      const externalId = `${own}|${other}|${relation}`;
      if (seenExternal.has(externalId)) continue;
      seenExternal.add(externalId);
      externalLinks.push({ key: own, other, relation, text: relation === 'waits-on' ? `${own} waits on ${other} (outside the epic)` : `${own} blocks ${other} (outside the epic)` });
    }
  }
  internal.sort((a, b) => compareKeys(a.to, b.to) || compareKeys(a.from, b.from));
  const edges: JiraPreviewEdge[] = [];
  const cycles: JiraCycleLink[] = [];
  for (const link of internal) {
    const cycle = findCycle(edges, link.from, link.to);
    if (cycle) {
      // findCycle answers [from, to, …, from]: shown as "waits on" order, from the waiting one.
      const around = [...cycle].reverse();
      cycles.push({ ...link, cycle: around, text: `${link.to} waits on ${link.from} was left out: ${around.join(' → ')} would be a cycle (each waits on the next)` });
      continue;
    }
    edges.push({ ...link, text: `${link.to} waits on ${link.from}` });
  }
  const linked = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const items: JiraPreviewItem[] = issues.map((issue) => jiraPreviewItem(issue, input.baseUrl, input.acceptanceField, !linked.has(issue.key)));
  const epicSummary = typeof input.epic.fields['summary'] === 'string' ? input.epic.fields['summary'].trim() : input.epic.key;
  const titleSlug = slug(epicSummary);
  return {
    epic: { key: input.epic.key, summary: epicSummary, url: browse(input.epic.key) },
    items,
    edges,
    externalLinks,
    cycles,
    unlinked: items.filter((item) => item.unlinked).map((item) => item.key),
    truncated: input.truncated === true,
    suggestedTitle: `${input.epic.key} ${epicSummary}`.slice(0, 120),
    suggestedTargetBranch: `feature/${input.epic.key}${titleSlug ? `-${titleSlug}` : ''}`,
    proposeAvailable: false,
  };
}

// ── re-read dependencies (D117) ──────────────────────────────────────────

/** A dependency of a plan as the re-read shows it: item ids, and "PROJ-12 waits on PROJ-11". */
export interface JiraRelinkEdge extends PlanEdge {
  readonly text: string;
}

/**
 * D117 · `POST /api/plans/{id}/jira/dependencies`: what **Re-read dependencies from Jira** changes
 * on a draft Jira plan (`apply: false`), or changed (`apply: true`). Edges are by item id.
 */
export interface JiraRelinkDiff {
  /** Dependencies that contradict Jira (the reverse of a Jira "blocks" link): removed. */
  readonly removed: readonly JiraRelinkEdge[];
  /** Jira "blocks" links the plan does not have yet: added. */
  readonly added: readonly JiraRelinkEdge[];
  /** Jira links the plan already has the right way round. */
  readonly unchanged: number;
  /** The developer's and the accepted proposals' dependencies: never touched. */
  readonly kept: readonly JiraRelinkEdge[];
  /** Jira links left out because they would close a cycle with a kept dependency. */
  readonly cycles: readonly JiraRelinkEdge[];
  /** Identifies this diff; `apply` with a stale one answers 409 `changed`. */
  readonly fingerprint: string;
  readonly applied: boolean;
}

/** Input of {@link jiraRelinkDiff}. */
export interface JiraRelinkInput {
  /** The plan's items: id, label ("PROJ-12"), and its Jira key (`null` for an item added by hand). */
  readonly items: ReadonlyArray<{ readonly id: string; readonly label: string; readonly key: string | null }>;
  /** The plan's dependencies now (item ids). */
  readonly edges: readonly PlanEdge[];
  /** The epic's dependencies as Jira says now ({@link JiraPreview.edges}, by key). */
  readonly jira: readonly PlanEdge[];
  /** Jira links the preview left out as a cycle ({@link JiraPreview.cycles}, by key): a plan dependency equal to one is still Jira's. */
  readonly jiraCycles?: readonly PlanEdge[];
  /** Accepted proposals (item ids): kept even when they contradict Jira. */
  readonly proposals: readonly PlanEdge[];
}

/**
 * D117 · the re-read's rule. Plans do not record where a dependency came from, so: a plan
 * dependency that **is** a Jira link stays; one that is the **reverse** of a Jira link is what the
 * pre-D117 import made (it read every link backwards) and is removed, unless it is an accepted
 * proposal; anything else (added by hand, an accepted proposal, a link since removed in Jira) is
 * kept. Then each Jira link the plan lacks is added, in ticket order, unless it would close a
 * cycle with what is kept (reported). Links to items no longer in the plan are skipped.
 */
export function jiraRelinkDiff(input: JiraRelinkInput): Omit<JiraRelinkDiff, 'fingerprint' | 'applied'> {
  const byKey = new Map(input.items.filter((item) => item.key !== null).map((item) => [item.key as string, item.id]));
  const label = new Map(input.items.map((item) => [item.id, item.label]));
  const view = (edge: PlanEdge): JiraRelinkEdge => ({ from: edge.from, to: edge.to, text: `${label.get(edge.to) ?? edge.to} waits on ${label.get(edge.from) ?? edge.from}` });
  const id = (edge: PlanEdge) => `${edge.from}>${edge.to}`;
  const toIds = (links: readonly PlanEdge[]): PlanEdge[] => {
    const out: PlanEdge[] = [];
    for (const link of links) {
      const from = byKey.get(link.from);
      const to = byKey.get(link.to);
      if (from && to && !out.some((edge) => edge.from === from && edge.to === to)) out.push({ from, to });
    }
    return out;
  };
  const jira = toIds(input.jira);
  const jiraIds = new Set([...jira, ...toIds(input.jiraCycles ?? [])].map(id));
  const proposed = new Set(input.proposals.map(id));
  const removed: JiraRelinkEdge[] = [];
  const kept: JiraRelinkEdge[] = [];
  const current: PlanEdge[] = [];
  let unchanged = 0;
  for (const edge of input.edges) {
    if (jiraIds.has(id(edge))) {
      unchanged += 1;
      current.push(edge);
    } else if (jiraIds.has(id({ from: edge.to, to: edge.from })) && !proposed.has(id(edge))) {
      removed.push(view(edge));
    } else {
      kept.push(view(edge));
      current.push(edge);
    }
  }
  const added: JiraRelinkEdge[] = [];
  const cycles: JiraRelinkEdge[] = [];
  const have = new Set(current.map(id));
  for (const edge of jira) {
    if (have.has(id(edge))) continue;
    if (findCycle(current, edge.from, edge.to)) {
      cycles.push(view(edge));
      continue;
    }
    current.push(edge);
    have.add(id(edge));
    added.push(view(edge));
  }
  return { removed, added, unchanged, kept, cycles };
}

/** Cuts `text` to `max` characters, ending with "…" when it was longer. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** D118: the todo keeps the ticket's description cut to this (the full text comes from Jira when the run starts). */
export const JIRA_TODO_DESCRIPTION_MAX = 1_200;
/** D118: the todo keeps the acceptance criteria cut to this. */
export const JIRA_TODO_ACCEPTANCE_MAX = 1_500;
/** D118: the todo's last line. */
export const JIRA_TODO_CONTEXT_LINE = 'The full Jira context (description, acceptance criteria, sub-tasks, comments, links, attachment names and the epic) is read from Jira when the run starts; plan_jira_context reads it any time.';

/**
 * The todo an item becomes: title "KEY Summary"; description = a short summary (D118): the
 * ticket's description cut to {@link JIRA_TODO_DESCRIPTION_MAX}, its acceptance criteria cut to
 * {@link JIRA_TODO_ACCEPTANCE_MAX}, a line with the ticket's link, components and assignee, and
 * {@link JIRA_TODO_CONTEXT_LINE}. Always within the todo's limit: nothing is dropped silently,
 * since the run's first message carries the full text read from Jira at its start.
 */
export function jiraItemTodo(item: JiraPreviewItem): { readonly title: string; readonly description: string } {
  const title = cut(`${item.key} ${item.summary}`, TODO_TITLE_MAX);
  const facts = [`Jira: ${item.url}`, item.components.length > 0 ? `components ${item.components.join(', ')}` : null, item.assignee ? `assignee ${item.assignee}` : null].filter(Boolean).join(' · ');
  const acceptance = item.acceptanceCriteria ? `Acceptance criteria:\n${cut(item.acceptanceCriteria, JIRA_TODO_ACCEPTANCE_MAX)}` : '';
  const body = item.description ? cut(item.description, JIRA_TODO_DESCRIPTION_MAX) : '';
  return { title, description: cut([body, acceptance, facts, JIRA_TODO_CONTEXT_LINE].filter((part) => part !== '').join('\n\n'), TODO_DESCRIPTION_MAX) };
}

/**
 * D118: whether a todo's description is the import's text of ticket `url` (before or after D118:
 * both end with the line "Jira: <url>…"), so a run whose fresh Jira read succeeded leaves it out
 * of the brief instead of repeating it next to the "Jira context" block. A description the
 * developer rewrote without that line is kept.
 */
export function isImportedJiraText(description: string | null, url: string): boolean {
  if (description === null) return false;
  return description.split('\n').some((line) => line.startsWith(`Jira: ${url}`) && (line.length === `Jira: ${url}`.length || line[`Jira: ${url}`.length] === ' '));
}

// ── the sync's rules ──────────────────────────────────────────────────────

/**
 * The marker a Switchboard comment ends with, so a retry finds a comment it already posted
 * (writes are idempotent): `[switchboard:<planId>:<itemId>:<event>]`.
 */
export function jiraCommentMarker(planId: string, itemId: string, event: string): string {
  return `[switchboard:${planId}:${itemId}:${event}]`;
}

/** The texts of the write mode's comments. */
export const JIRA_COMMENTS = {
  pr: (url: string) => `Pull request opened: ${url}`,
  question: () => 'The agent working on this ticket is waiting for an answer from the developer.',
  merged: (target: string) => `Merged into ${target}.`,
} as const;

/** A transition of an issue (`GET /rest/api/3/issue/{key}/transitions`). */
export interface JiraTransition {
  readonly id: string;
  readonly name: string;
  readonly to: string | null;
}

/** The transition named `name` (its own name or its target status' name, case-insensitive), or `null`. */
export function findTransition(transitions: readonly JiraTransition[], name: string): JiraTransition | null {
  const wanted = name.trim().toLowerCase();
  return transitions.find((transition) => transition.name.toLowerCase() === wanted) ?? transitions.find((transition) => transition.to?.toLowerCase() === wanted) ?? null;
}

/**
 * A Jira status drift note for an item, or `null`: the ticket is Done while the item is not
 * (or the other way round), it still says To Do while the item's run works, or its status
 * changed since the import.
 */
export function jiraDrift(input: { readonly itemState: string; readonly status: string | null; readonly statusCategory: string | null; readonly statusAtImport: string | null }): string | null {
  const { status, statusCategory } = input;
  if (status === null) return null;
  const done = input.itemState === 'done';
  if (statusCategory === 'done' && !done) return `Jira says ${status}; the plan item is ${input.itemState}`;
  const working = ['running', 'question', 'ready-to-merge'].includes(input.itemState);
  if (working && statusCategory === 'new') return `Jira still says ${status} while the item's run works`;
  if (input.statusAtImport !== null && status !== input.statusAtImport) return `Jira status changed: ${input.statusAtImport} → ${status}`;
  return null;
}

/** A transition name as stored: trimmed, 1–{@link JIRA_TRANSITION_NAME_MAX} characters; `null` = invalid. */
export function checkTransitionName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name === '' || name.length > JIRA_TRANSITION_NAME_MAX ? null : name;
}

// ── proposed order (D99-Jira-q1 ruling (b)) ───────────────────────────────

/** A proposal's state: `pending` (waiting for the developer), `accepted` (the dependency was added), `rejected`. */
export const EDGE_PROPOSAL_STATES = ['pending', 'accepted', 'rejected'] as const;
/** One of {@link EDGE_PROPOSAL_STATES}. */
export type EdgeProposalState = (typeof EDGE_PROPOSAL_STATES)[number];

/**
 * A dependency the source session's agent proposed (`plan_propose_dependencies`): "`to` should
 * wait on `from`". Nothing changes until the developer accepts it on the plan.
 */
export interface PlanEdgeProposal {
  readonly id: string;
  readonly planId: string;
  /** The item that goes first (its id). */
  readonly fromItemId: string;
  /** The item that waits (its id). */
  readonly toItemId: string;
  /** Their labels (the key, else the title in quotes). */
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly state: EdgeProposalState;
  /** Why the last Accept was refused (a cycle), `null` = none. */
  readonly note: string | null;
  /** "PROJ-12 should wait on PROJ-11". */
  readonly text: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

/** The most proposals one call may make, and the longest reason kept. */
export const EDGE_PROPOSALS_MAX = 50;
export const EDGE_PROPOSAL_REASON_MAX = 500;

/** "PROJ-12 should wait on PROJ-11". */
export function proposalText(from: string, to: string): string {
  return `${to} should wait on ${from}`;
}

/**
 * The message the plan's source session gets (after a Jira import with unlinked items, or
 * the developer's **Propose order**): the plan, its items (the unlinked ones marked), the
 * dependencies it has, and the ask to call `plan_propose_dependencies`, which changes nothing.
 */
export function proposeOrderMessage(input: { readonly planId: string; readonly planTitle: string; readonly items: ReadonlyArray<{ readonly label: string; readonly title: string; readonly unlinked: boolean }>; readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string }> }): string {
  const unlinked = input.items.filter((item) => item.unlinked);
  return [
    `Please propose the missing order for the plan "${input.planTitle}" [${input.planId}].`,
    unlinked.length > 0 ? `These items have no dependency yet: ${unlinked.map((item) => item.label).join(', ')}.` : 'Check whether any dependency is missing.',
    `Items:\n${input.items.map((item) => `- ${item.label}: ${item.title}${item.unlinked ? ' (no links)' : ''}`).join('\n')}`,
    input.edges.length > 0 ? `Existing dependencies:\n${input.edges.map((edge) => `- ${edge.to} waits on ${edge.from}`).join('\n')}` : 'There are no dependencies yet.',
    `Read the items' todos (todo_get) if you need their details, then call plan_propose_dependencies once with plan_id ${input.planId} and every dependency you think is missing (from = the item that goes first, to = the one that waits, and a one-line reason). These are only proposals: the developer accepts or rejects each on the plan. Do not call plan_add_dependency for them, and do not start any work.`,
  ].join('\n\n');
}

/** D99-Jira-q1: the plan tool that proposes dependencies (registered with the other plan tools, only while Plans is on). */
export const PLAN_PROPOSE_TOOL: TodoToolDefinition = {
  name: 'plan_propose_dependencies',
  description:
    'Propose dependencies for a plan of this session ("to should wait on from"), each with a one-line reason. These are PROPOSALS for the developer, not changes: nothing in the plan changes until the developer accepts each one on the plan (a proposal that would make a cycle is refused then). Use it when Switchboard asks you to propose the missing order of a plan, e.g. after a Jira import. Proposals already made, already in the plan, or naming the same item twice are skipped.',
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'The plan id, as plan_status or the message shows it in brackets.' },
      proposals: {
        type: 'array',
        maxItems: EDGE_PROPOSALS_MAX,
        description: 'The dependencies you propose.',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'The key (or item id) of the item that goes first.' },
            to: { type: 'string', description: 'The key (or item id) of the item that waits for it.' },
            reason: { type: 'string', description: 'One line: why it should wait (e.g. "the page calls the cart API").' },
          },
          required: ['from', 'to', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['plan_id', 'proposals'],
    additionalProperties: false,
  },
  annotations: { title: 'Propose plan dependencies', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

// ── D119: the plan's own sidebar subfolder ────────────────────────────────

/** D119: a plan's own sidebar subfolder is named like its owner session: "Plan · <plan title>". */
export const PLAN_SIDEBAR_FOLDER_PREFIX = 'Plan · ';

/**
 * Cuts `text` to at most `max` characters: whole when it fits; else at the last word break in
 * its last third (else mid-word), with "…".
 */
function cutName(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const room = trimmed.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  const cut = space >= Math.floor((max * 2) / 3) ? room.slice(0, space) : room;
  return `${cut.replace(/[\s·,;:–-]+$/u, '')}…`;
}

/**
 * D119: the name of a plan's own sidebar subfolder: the owner session's title ("Plan · <plan
 * title>", `planOwnerTitle`) cut to the sidebar's {@link SIDEBAR_FOLDER_NAME_MAX} characters at
 * a word break (a title the session already cut keeps its words, not a second "…").
 */
export function planSidebarFolderName(sessionTitle: string): string {
  const title = sessionTitle.trim().replace(/…$/u, '').trimEnd() || `${PLAN_SIDEBAR_FOLDER_PREFIX}Jira epic`;
  const whole = sessionTitle.trim().endsWith('…') ? `${title}…` : title;
  return whole.length <= SIDEBAR_FOLDER_NAME_MAX ? whole : cutName(title, SIDEBAR_FOLDER_NAME_MAX);
}

/**
 * D119: `name`, or, when a folder at the same level is named exactly so, `name (2)`, `name (3)`…
 * (the first free one; the name is cut to leave room for the suffix within
 * {@link SIDEBAR_FOLDER_NAME_MAX}). `taken` = the names of the folders at that level.
 */
export function uniqueSidebarFolderName(name: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(name)) return name;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const candidate = `${name.length + suffix.length <= SIDEBAR_FOLDER_NAME_MAX ? name : cutName(name.replace(/…$/u, ''), SIDEBAR_FOLDER_NAME_MAX - suffix.length)}${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
}

/**
 * D119: the layout with a new subfolder `folderId` for a plan (named {@link uniqueSidebarFolderName}
 * of `name` among the folders at that level) in `parentId` (`null` = the top level), holding
 * `sessionId` as its first item (taken out of wherever it was). A parent that is gone or cannot
 * hold one more level (D58) → the top level. Answers the layout and the name used.
 */
export function addPlanSidebarFolder(
  layout: SidebarLayout,
  input: { readonly folderId: string; readonly name: string; readonly parentId: string | null; readonly sessionId: string },
): { readonly layout: SidebarLayout; readonly name: string; readonly parentId: string | null } | null {
  const parentId = input.parentId !== null && checkFolderParent(layout, null, input.parentId) === null ? input.parentId : null;
  const name = uniqueSidebarFolderName(
    input.name,
    layout.folders.filter((folder) => (folder.parentId ?? null) === parentId).map((folder) => folder.name),
  );
  const added = addFolder(layout, input.folderId, name, parentId);
  if (!added) return null;
  const placed = placeSession(added, { sessionId: input.sessionId, place: 'folder', folderId: input.folderId, index: 0 });
  return placed ? { layout: placed, name, parentId } : null;
}

/**
 * D119: whether a plan's subfolder may be made in sidebar folder `folderId` (`null` = the top
 * level): `null` = fine; else why not (an unknown folder, or one {@link SIDEBAR_FOLDER_DEPTH_MAX}
 * levels deep that cannot hold another).
 */
export function planSidebarFolderProblem(layout: SidebarLayout, folderId: string | null): SidebarTreeProblem | null {
  return checkFolderParent(layout, null, folderId);
}

/** D119: what {@link defaultPlanSidebarFolder} reads of a listed session. */
export interface PlanFolderSession {
  readonly id: string;
  /** The saved folder it started in (its machine's id) and its path. */
  readonly folder: string | null;
  readonly folderPath: string | null;
  /** The paired machine it runs on (absent / `null` = this one). */
  readonly machine?: { readonly id: string } | null;
  readonly kind?: string;
  readonly closedAt?: string | null;
  readonly lastActivityAt: string | null;
  readonly createdAt: string;
}

/**
 * D119 · the import dialog's default sidebar folder for a plan (`null` = the sidebar root):
 *
 * 1. the sidebar folder holding the most open sessions that run in the chosen working folder
 *    (on the chosen machine: its saved folder id, or the same path); a session in a plan's own
 *    subfolder ("Plan · …") counts for the folder that subfolder sits in (so a new plan goes
 *    next to the earlier ones, not inside one); on a tie, the folder with the most recently
 *    active such session;
 * 2. none → the developer's last choice for that working folder (`lastChoice`: a folder id
 *    while it still exists, `null` = the root; `undefined` = none remembered);
 * 3. otherwise the root.
 *
 * A folder too deep to hold the plan's subfolder (D58) gives the nearest folder above it that can.
 */
export function defaultPlanSidebarFolder(input: {
  readonly layout: SidebarLayout;
  readonly sessions: readonly PlanFolderSession[];
  /** The machine the plan runs on (`null` = this one). */
  readonly machine: string | null;
  /** The chosen working folder (that machine's saved folder). */
  readonly workingFolder: { readonly id: string; readonly path: string } | null;
  readonly lastChoice?: string | null;
}): string | null {
  const { layout, workingFolder } = input;
  const byId = new Map(layout.folders.map((folder) => [folder.id, folder]));
  const plain = (id: string | null): string | null => {
    let at = id === null ? undefined : byId.get(id);
    for (let guard = 0; at && at.name.startsWith(PLAN_SIDEBAR_FOLDER_PREFIX) && guard <= layout.folders.length; guard += 1) {
      const parent = at.parentId ?? null;
      at = parent === null ? undefined : byId.get(parent);
    }
    return at?.id ?? null;
  };
  if (workingFolder) {
    const tally = new Map<string, { count: number; latest: number }>();
    for (const session of input.sessions) {
      if (session.kind === 'chat' || (session.closedAt ?? null) !== null) continue;
      if ((session.machine?.id ?? null) !== input.machine) continue;
      if (session.folder !== workingFolder.id && (session.folderPath === null || session.folderPath !== workingFolder.path)) continue;
      const holder = layout.folders.find((folder) => folder.sessionIds.includes(session.id));
      const counted = holder ? plain(holder.id) : null;
      if (counted === null) continue;
      const when = Date.parse(session.lastActivityAt ?? session.createdAt);
      const entry = tally.get(counted) ?? { count: 0, latest: Number.NEGATIVE_INFINITY };
      tally.set(counted, { count: entry.count + 1, latest: Math.max(entry.latest, Number.isFinite(when) ? when : Number.NEGATIVE_INFINITY) });
    }
    let best: { id: string; count: number; latest: number } | null = null;
    for (const [id, entry] of tally) if (!best || entry.count > best.count || (entry.count === best.count && entry.latest > best.latest)) best = { id, ...entry };
    if (best) return roomy(layout, best.id);
  }
  if (input.lastChoice !== undefined && input.lastChoice !== null && byId.has(input.lastChoice)) return roomy(layout, input.lastChoice);
  return null;
}

/** `id`, or the nearest folder above it that can hold one more level ({@link planSidebarFolderProblem}); `null` = the root. */
function roomy(layout: SidebarLayout, id: string): string | null {
  let at: string | null = id;
  for (let guard = 0; at !== null && planSidebarFolderProblem(layout, at) !== null && guard <= layout.folders.length; guard += 1) {
    at = layout.folders.find((folder) => folder.id === at)?.parentId ?? null;
  }
  return at;
}
