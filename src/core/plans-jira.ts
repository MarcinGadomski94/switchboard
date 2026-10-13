/**
 * D99 · Plans · Jira (`docs/plans.md` → *Jira import and status sync*; contract → *Plans ·
 * Jira (D99)* in `docs/handoff/contracts/local-api.md`): the shapes and the pure rules of the
 * Jira import (an epic's child issues → plan items, their "blocks" links → dependencies) and
 * of the optional status sync. No I/O here: the server's `src/server/plans/jira/` reads Jira.
 */
import { findCycle, type PlanEdge } from './plans.ts';
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
}

/** The default transition names. Done is never set: the team's own process moves a ticket to Done. */
export const DEFAULT_JIRA_TRANSITIONS: JiraTransitionNames = { inProgress: 'In Progress', inReview: 'In Review' };

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
  readonly epic: { readonly key: string; readonly summary: string; readonly url: string };
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
   * Whether "Propose missing order" is offered: always `false` in this build. Switchboard has no
   * sanctioned one-shot agent run (`.loop/questions.md` → *D99-Jira*).
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
  readonly kind: 'import' | 'refresh' | 'transition' | 'comment' | 'soft-failure' | 'error' | 'settings';
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

/** The "blocks" links of an issue, as "`to` waits on `from`" pairs (both directions read). */
export function blocksLinks(issue: JiraIssueInput): Array<{ readonly from: string; readonly to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  const links = Array.isArray(issue.fields['issuelinks']) ? (issue.fields['issuelinks'] as unknown[]) : [];
  for (const raw of links) {
    const link = record(raw);
    if (!link || !isBlocksLink(link['type'])) continue;
    const outward = nameOf(link['outwardIssue'], 'key');
    const inward = nameOf(link['inwardIssue'], 'key');
    // "issue blocks outward": the outward issue waits on this one.
    if (outward) out.push({ from: issue.key, to: outward.toUpperCase() });
    // "inward blocks issue": this one waits on the inward issue.
    if (inward) out.push({ from: inward.toUpperCase(), to: issue.key });
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

/** Cuts `text` to `max` characters, ending with "…" when it was longer. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The todo an item becomes: title "KEY Summary"; description = the ticket's description, then
 * its acceptance criteria, then a line with the ticket's link, components and assignee (cut to
 * the todo's limit, the acceptance criteria kept first when something must go).
 */
export function jiraItemTodo(item: JiraPreviewItem): { readonly title: string; readonly description: string } {
  const title = cut(`${item.key} ${item.summary}`, TODO_TITLE_MAX);
  const facts = [`Jira: ${item.url}`, item.components.length > 0 ? `components ${item.components.join(', ')}` : null, item.assignee ? `assignee ${item.assignee}` : null].filter(Boolean).join(' · ');
  const acceptance = item.acceptanceCriteria ? `Acceptance criteria:\n${item.acceptanceCriteria}` : '';
  const fixed = [acceptance, facts].filter((part) => part !== '').join('\n\n');
  const room = TODO_DESCRIPTION_MAX - fixed.length - 2;
  const body = item.description && room > 40 ? cut(item.description, room) : '';
  return { title, description: cut([body, fixed].filter((part) => part !== '').join('\n\n'), TODO_DESCRIPTION_MAX) };
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
  const working = ['running', 'question', 'review'].includes(input.itemState);
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
