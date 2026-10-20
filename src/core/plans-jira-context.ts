/**
 * D118 · Plans · Jira: everything in Jira a plan's agents need to fulfil the plan
 * (`docs/plans.md` → *Jira context (D118)*). The shapes and pure rules that turn Jira's REST v3
 * answers (an issue's fields, its comments, its remote links, its sub-tasks) into a
 * {@link JiraIssueContext}, and render it as text with the caps of the run's first message, the
 * asks to the plan's agent and the `plan_jira_context` tool. No I/O here: the Jira lane
 * (`src/server/plans/jira/`) reads Jira when a run starts, when the plan's agent is asked, and
 * when the tool is called (nothing new is stored).
 */
import { adfToText, jiraPreviewItem, type JiraIssueInput } from './plans-jira.ts';
import { PLAN_RUN_MESSAGE_MAX } from './plans.ts';
import type { TodoToolDefinition } from './todos.ts';

// ── caps ──────────────────────────────────────────────────────────────────

/** The longest first message of an item's run (the brief, the Jira context, the merge rule). */
export const JIRA_RUN_MESSAGE_MAX = PLAN_RUN_MESSAGE_MAX;
/** The epic's shortened section in an item's run (acceptance criteria first). */
export const JIRA_RUN_EPIC_MAX = 3_000;
/** The full epic in an ask to the plan's agent (comments trimmed first). */
export const JIRA_ASK_EPIC_MAX = 30_000;
/** The tool's answer (comments trimmed first): large, but bounded. */
export const JIRA_TOOL_MAX = 120_000;
/** A sub-task's description, cut to this in a context. */
export const JIRA_SUBTASK_DESCRIPTION_MAX = 1_000;
/** The most comments read per issue (the newest are kept). */
export const JIRA_COMMENTS_READ_MAX = 500;
/** The most sub-tasks read per issue. */
export const JIRA_SUBTASKS_MAX = 50;

/** The note when a context could not be read at a run's start (the run starts anyway). */
export const JIRA_UNREAD_NOTE = "Jira couldn't be read at start; use plan_jira_context";

// ── shapes ────────────────────────────────────────────────────────────────

/** A comment of an issue (oldest first in {@link JiraIssueContext.comments}). */
export interface JiraContextComment {
  readonly author: string | null;
  /** As Jira gives it (`2026-10-01T10:00:00.000+0000`), `null` = unknown. */
  readonly created: string | null;
  readonly text: string;
}

/** A sub-task of an issue. */
export interface JiraContextSubtask {
  readonly key: string;
  readonly summary: string;
  readonly status: string | null;
  /** `null` = none (or not read). */
  readonly description: string | null;
}

/** A remote link of an issue (Confluence, Figma, any URL): passed on as a URL for the agent's own tools. */
export interface JiraContextRemoteLink {
  readonly title: string;
  readonly url: string;
}

/** A link to an issue outside the epic (any link type), as Jira shows it on the issue. */
export interface JiraContextLink {
  readonly key: string;
  readonly summary: string | null;
  readonly status: string | null;
  /** The link type's phrase from this issue's side ("is blocked by", "relates to", "clones"). */
  readonly phrase: string;
  /** "PROJ-15 is blocked by PROJ-99 Mail service (In Progress)". */
  readonly text: string;
}

/** Everything Jira holds about one issue that an agent needs. */
export interface JiraIssueContext {
  readonly key: string;
  readonly summary: string;
  readonly url: string;
  readonly status: string | null;
  readonly assignee: string | null;
  readonly components: readonly string[];
  readonly description: string | null;
  readonly acceptanceCriteria: string | null;
  readonly subtasks: readonly JiraContextSubtask[];
  /** Oldest first. */
  readonly comments: readonly JiraContextComment[];
  /** How many comments the issue has (more than {@link comments} when Jira had more than were read). */
  readonly commentsTotal: number;
  readonly remoteLinks: readonly JiraContextRemoteLink[];
  /** File names only: attachments are never downloaded. */
  readonly attachments: readonly string[];
  readonly outsideLinks: readonly JiraContextLink[];
}

/** The small counts the import's preview shows per ticket ("3 comments · 2 sub-tasks · 1 link"). */
export interface JiraContextCounts {
  readonly comments: number;
  readonly subtasks: number;
  /** Remote links plus links to issues outside the epic. */
  readonly links: number;
  readonly attachments: number;
}

// ── parsing ───────────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The fields an issue's context reads (with the import's, plus the acceptance criteria field when Jira has one). */
export const JIRA_CONTEXT_FIELDS = ['summary', 'description', 'status', 'assignee', 'components', 'issuelinks', 'timeoriginalestimate', 'issuetype', 'subtasks', 'attachment', 'comment'] as const;

/** A comment of Jira's REST v3 (`fields.comment.comments[]` or `GET …/comment`): author, date, ADF body. */
export function parseJiraComment(raw: unknown): JiraContextComment | null {
  const entry = record(raw);
  if (!entry) return null;
  const text = adfToText(entry['body']);
  if (text === null) return null;
  return { author: str(record(entry['author'])?.['displayName']), created: str(entry['created']), text };
}

/** Switchboard's own sync comments end with `[switchboard:<plan>:<item>:<event>]` (`jiraCommentMarker`): noise for the agents, left out of every context and count. */
const OWN_MARKER = /\[switchboard:[^\]:\s]+:[^\]:\s]+:[^\]]+\]\s*$/;

/** Whether a comment's text is one of Switchboard's own sync comments. */
export function isSwitchboardComment(text: string): boolean {
  return OWN_MARKER.test(text);
}

/** A remote link of `GET /rest/api/3/issue/{key}/remotelink` (`{ object: { url, title } }`), `null` without a URL. */
export function parseJiraRemoteLink(raw: unknown): JiraContextRemoteLink | null {
  const object = record(record(raw)?.['object']);
  const url = str(object?.['url']);
  if (!url) return null;
  return { title: str(object?.['title']) ?? url, url };
}

/**
 * The links of an issue to issues not in `exclude` (the epic and its children), of any type, with
 * the phrase Jira shows **on this issue** (D117's rule, generalised): a link entry carries the
 * other issue under the side that issue is on, and this issue reads the opposite side's phrase.
 * So on issue I, `{ outwardIssue: O }` reads "I <type.inward> O" (Blocks: "I is blocked by O") and
 * `{ inwardIssue: N }` reads "I <type.outward> N" (Blocks: "I blocks N"). Real Jira gives the other
 * issue's `fields.summary` and `fields.status` in the entry.
 */
export function jiraOutsideLinks(issue: JiraIssueInput, exclude: ReadonlySet<string>): JiraContextLink[] {
  const out: JiraContextLink[] = [];
  const seen = new Set<string>();
  for (const raw of list(issue.fields['issuelinks'])) {
    const link = record(raw);
    if (!link) continue;
    const type = record(link['type']);
    const outward = record(link['outwardIssue']);
    const inward = record(link['inwardIssue']);
    const other = outward ?? inward;
    const key = str(other?.['key'])?.toUpperCase();
    if (!other || !key || key === issue.key || exclude.has(key)) continue;
    // outwardIssue → this issue is on the inward side: the type's inward phrase (D117).
    const phrase = (outward ? str(type?.['inward']) : str(type?.['outward'])) ?? str(type?.['name'])?.toLowerCase() ?? 'is linked to';
    const fields = record(other['fields']);
    const summary = str(fields?.['summary']);
    const status = str(record(fields?.['status'])?.['name']);
    const id = `${phrase}|${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key, summary, status, phrase, text: `${issue.key} ${phrase} ${key}${summary ? ` ${summary}` : ''}${status ? ` (${status})` : ''}` });
  }
  return out;
}

/** Input of {@link buildJiraIssueContext}: Jira's answers for one issue. */
export interface JiraIssueContextInput {
  readonly issue: JiraIssueInput;
  readonly baseUrl: string;
  readonly acceptanceField: string | null;
  /** `GET …/comment` (oldest first); omitted = `fields.comment.comments`. */
  readonly comments?: readonly unknown[];
  /** How many comments Jira has (omitted = `fields.comment.total`, else the comments' count). */
  readonly commentsTotal?: number;
  /** `GET …/remotelink`; omitted = none read. */
  readonly remoteLinks?: readonly unknown[];
  /** The sub-tasks with their descriptions (a search `parent = KEY`); omitted = `fields.subtasks` (no descriptions). */
  readonly subtasks?: readonly JiraIssueInput[];
  /** Keys that are not "outside": the epic and its children. */
  readonly exclude: ReadonlySet<string>;
}

/** One issue's {@link JiraIssueContext} from Jira's answers. */
export function buildJiraIssueContext(input: JiraIssueContextInput): JiraIssueContext {
  const { issue } = input;
  const base = jiraPreviewItem(issue, input.baseUrl, input.acceptanceField, false);
  const embedded = record(issue.fields['comment']);
  const rawComments = input.comments ?? list(embedded?.['comments']);
  const parsed = rawComments.map(parseJiraComment).filter((entry): entry is JiraContextComment => entry !== null);
  // Switchboard's own sync comments are left out (and not counted).
  const comments = parsed.filter((entry) => !isSwitchboardComment(entry.text));
  const own = parsed.length - comments.length;
  const total = (input.commentsTotal ?? (typeof embedded?.['total'] === 'number' ? embedded['total'] : parsed.length)) - own;
  const subtasks: JiraContextSubtask[] = input.subtasks
    ? input.subtasks.map((sub) => ({ key: sub.key, summary: str(sub.fields['summary']) ?? sub.key, status: str(record(sub.fields['status'])?.['name']), description: adfToText(sub.fields['description']) }))
    : list(issue.fields['subtasks'])
        .map(record)
        .filter((sub): sub is Record<string, unknown> => sub !== null && typeof sub['key'] === 'string')
        .map((sub) => {
          const fields = record(sub['fields']);
          return { key: sub['key'] as string, summary: str(fields?.['summary']) ?? (sub['key'] as string), status: str(record(fields?.['status'])?.['name']), description: null };
        });
  return {
    key: issue.key,
    summary: base.summary,
    url: base.url,
    status: base.status,
    assignee: base.assignee,
    components: base.components,
    description: base.description,
    acceptanceCriteria: base.acceptanceCriteria,
    subtasks,
    comments,
    commentsTotal: Math.max(total, comments.length),
    remoteLinks: (input.remoteLinks ?? []).map(parseJiraRemoteLink).filter((entry): entry is JiraContextRemoteLink => entry !== null),
    attachments: list(issue.fields['attachment'])
      .map((entry) => str(record(entry)?.['filename']))
      .filter((name): name is string => name !== null),
    outsideLinks: jiraOutsideLinks(issue, input.exclude),
  };
}

/**
 * The preview's counts of an issue from its search answer alone (`fields.comment.total`,
 * `fields.subtasks`, `fields.attachment`, the outside links) plus its remote links when read.
 */
export function jiraContextCounts(issue: JiraIssueInput, exclude: ReadonlySet<string>, remoteLinks: number): JiraContextCounts {
  const comment = record(issue.fields['comment']);
  return {
    comments: (() => {
      const parsed = list(comment?.['comments']).map(parseJiraComment);
      const own = parsed.filter((entry) => entry !== null && isSwitchboardComment(entry.text)).length;
      return Math.max(0, (typeof comment?.['total'] === 'number' ? comment['total'] : parsed.length) - own);
    })(),
    subtasks: list(issue.fields['subtasks']).length,
    links: remoteLinks + jiraOutsideLinks(issue, exclude).length,
    attachments: list(issue.fields['attachment']).length,
  };
}

/** "3 comments · 2 sub-tasks · 1 link" (nothing to show = ""). */
export function jiraCountsText(counts: JiraContextCounts): string {
  const part = (n: number, one: string, many: string) => (n > 0 ? `${n} ${n === 1 ? one : many}` : null);
  return [part(counts.comments, 'comment', 'comments'), part(counts.subtasks, 'sub-task', 'sub-tasks'), part(counts.links, 'link', 'links'), part(counts.attachments, 'attachment', 'attachments')].filter(Boolean).join(' · ');
}

// ── rendering ─────────────────────────────────────────────────────────────

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function day(created: string | null): string {
  return created ? created.slice(0, 10) : 'unknown date';
}

function commentLine(comment: JiraContextComment): string {
  return `- ${comment.author ?? 'Someone'}, ${day(comment.created)}:\n${comment.text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')}`;
}

/** The comments that fit `budget` characters, the newest kept; oldest first, with a note when some were left out. */
export function renderJiraComments(context: JiraIssueContext, budget: number, toolNote: boolean): { readonly text: string; readonly dropped: number } {
  const all = context.comments;
  const unread = Math.max(0, context.commentsTotal - all.length);
  if (all.length === 0 && unread === 0) return { text: '', dropped: 0 };
  const kept: string[] = [];
  let used = 0;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const line = commentLine(all[index] as JiraContextComment);
    if (used + line.length + 1 > budget - 200) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  const dropped = all.length - kept.length + unread;
  const head = `Comments (${context.commentsTotal}, oldest first${dropped > 0 ? `; the ${dropped} oldest left out to keep this short${toolNote ? ', plan_jira_context has them all' : ''}` : ''}):`;
  if (kept.length === 0) return { text: dropped > 0 ? head : '', dropped };
  return { text: `${head}\n${kept.join('\n')}`, dropped };
}

/** The sections of an issue's context except its comments (acceptance criteria first). */
function issueSections(context: JiraIssueContext): string[] {
  const facts = [context.status ? `status ${context.status}` : null, context.assignee ? `assignee ${context.assignee}` : null, context.components.length > 0 ? `components ${context.components.join(', ')}` : null].filter(Boolean).join(' · ');
  const sections = [`${context.url}${facts ? `\n${facts}` : ''}`];
  if (context.acceptanceCriteria) sections.push(`Acceptance criteria:\n${context.acceptanceCriteria}`);
  if (context.description) sections.push(`Description:\n${context.description}`);
  if (context.subtasks.length > 0) {
    sections.push(
      `Sub-tasks:\n${context.subtasks
        .map((sub) => `- ${sub.key} ${sub.summary}${sub.status ? ` (${sub.status})` : ''}${sub.description ? `\n${cut(sub.description, JIRA_SUBTASK_DESCRIPTION_MAX)
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')}` : ''}`)
        .join('\n')}`,
    );
  }
  if (context.outsideLinks.length > 0) sections.push(`Linked tickets outside the epic:\n${context.outsideLinks.map((link) => `- ${link.text}`).join('\n')}`);
  if (context.remoteLinks.length > 0) sections.push(`Links (Confluence, Figma and other pages: open them with your own tools):\n${context.remoteLinks.map((link) => `- ${link.title}: ${link.url}`).join('\n')}`);
  if (context.attachments.length > 0) sections.push(`Attachments (names only, not downloaded): ${context.attachments.join(', ')}`);
  return sections;
}

/**
 * One issue's full context as text: a heading, the facts, acceptance criteria, description,
 * sub-tasks, outside links, remote links, attachment names, then the comments (oldest first).
 * Over `max` characters the oldest comments go first, then the rest is cut (said so).
 */
export function renderJiraIssueContext(context: JiraIssueContext, options: { readonly heading: string; readonly max: number; readonly toolNote?: boolean }): { readonly text: string; readonly trimmed: readonly string[] } {
  const toolNote = options.toolNote !== false;
  const body = [`${options.heading}`, ...issueSections(context)].join('\n\n');
  const trimmed: string[] = [];
  const comments = renderJiraComments(context, Math.max(0, options.max - body.length - 2), toolNote);
  if (comments.dropped > 0) trimmed.push(`${comments.dropped} older comment(s) of ${context.key}`);
  let text = comments.text ? `${body}\n\n${comments.text}` : body;
  if (text.length > options.max) {
    trimmed.push(`the rest of ${context.key}`);
    text = `${cut(text, options.max - 80)}\n[cut to keep this short${toolNote ? '; plan_jira_context has it all' : ''}]`;
  }
  return { text, trimmed };
}

/** The epic's shortened section of an item's run: acceptance criteria first, then the description, links and the newest comments, within `max`. */
export function renderJiraEpicShort(epic: JiraIssueContext, max: number = JIRA_RUN_EPIC_MAX): string {
  const heading = `Epic context: ${epic.key} ${epic.summary} (shortened; the full text is available via plan_jira_context)`;
  const parts = [heading, epic.url];
  if (epic.acceptanceCriteria) parts.push(`Acceptance criteria:\n${epic.acceptanceCriteria}`);
  if (epic.description) parts.push(`Description:\n${epic.description}`);
  if (epic.remoteLinks.length > 0) parts.push(`Links:\n${epic.remoteLinks.map((link) => `- ${link.title}: ${link.url}`).join('\n')}`);
  const text = parts.join('\n\n');
  if (text.length <= max) {
    const comments = renderJiraComments(epic, max - text.length - 2, true);
    return comments.text ? `${text}\n\n${comments.text}` : text;
  }
  return cut(text, max);
}

/** Input of {@link renderRunJiraContext}. */
export interface RunJiraContextInput {
  /** The item's ticket (`null` = it could not be read). */
  readonly item: JiraIssueContext | null;
  /** The epic (`null` = it could not be read). */
  readonly epic: JiraIssueContext | null;
  /** The characters the block may take in the first message. */
  readonly budget: number;
  /** When it was read (ISO). */
  readonly readAt: string;
}

/**
 * D118 · the "Jira context" block of an item's run's first message (after the item's brief, before
 * the merge rule): the ticket in full, then the epic shortened (≤ {@link JIRA_RUN_EPIC_MAX}).
 * Over `budget`: the ticket's comments are trimmed first (the newest kept), then the epic (cut,
 * then left out), then the ticket's text is cut; the block says what was trimmed and that
 * `plan_jira_context` has it all.
 */
export function renderRunJiraContext(input: RunJiraContextInput): string {
  const head = `Jira context (read from Jira when this run started, ${input.readAt.slice(0, 16).replace('T', ' ')} UTC):`;
  const trimmedNote = (what: readonly string[]) => (what.length > 0 ? `\n\nTrimmed to keep this message short: ${what.join('; ')}. Call plan_jira_context for everything.` : '');
  const room = Math.max(1_000, input.budget - head.length - 400);
  let epic = input.epic ? renderJiraEpicShort(input.epic) : '';
  const trimmed: string[] = [];
  const itemFixed = input.item ? [`Ticket ${input.item.key} ${input.item.summary}`, ...issueSections(input.item)].join('\n\n') : '';
  // 1. Comments get what the ticket's text and the epic leave.
  let itemText = itemFixed;
  if (input.item) {
    const comments = renderJiraComments(input.item, Math.max(0, room - itemFixed.length - epic.length - 4), true);
    if (comments.dropped > 0) trimmed.push(`${comments.dropped} older comment(s) of ${input.item.key}`);
    if (comments.text) itemText = `${itemFixed}\n\n${comments.text}`;
  }
  // 2. Then the epic: cut, then left out.
  if (itemText.length + epic.length + 4 > room && epic !== '') {
    const left = room - itemText.length - 4;
    if (left >= 600) {
      epic = renderJiraEpicShort(input.epic as JiraIssueContext, left);
      trimmed.push(`the epic's section`);
    } else {
      epic = '';
      trimmed.push(`the epic's section (left out)`);
    }
  }
  // 3. Then the ticket's own text.
  if (itemText.length + epic.length + 4 > room) {
    itemText = cut(itemText, Math.max(200, room - epic.length - 4));
    trimmed.push(`the rest of ${input.item?.key ?? 'the ticket'}`);
  }
  const notes: string[] = [];
  if (!input.item) notes.push(`The ticket could not be read from Jira now; use plan_jira_context.`);
  if (!input.epic) notes.push(`The epic could not be read from Jira now; use plan_jira_context.`);
  return [head, itemText, epic, ...notes].filter((part) => part !== '').join('\n\n') + trimmedNote(trimmed);
}

// ── the tool ──────────────────────────────────────────────────────────────

/** The parts `plan_jira_context` answers. */
export const JIRA_CONTEXT_PARTS = ['item', 'epic', 'both'] as const;

/** D118 · the read-only plan tool (registered with the other plan tools, only while Plans is on). */
export const PLAN_JIRA_CONTEXT_TOOL: TodoToolDefinition = {
  name: 'plan_jira_context',
  description:
    "Read the full, current Jira context of a plan imported from a Jira epic, straight from Jira: the item's ticket (description, acceptance criteria, sub-tasks, all comments, remote links such as Confluence and Figma pages, attachment names, linked tickets outside the epic) and/or the epic (the same). Read-only. In an item's run session it defaults to that item's ticket and the epic; the plan's own session gives plan_id and item (a key such as PROJ-12, or an item id), or only plan_id for the epic. Links are URLs: open them with your own tools. Attachments are names only.",
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: "The plan id (in brackets in plan_status). Leave it out in an item's run session: its own plan." },
      item: { type: 'string', description: "The item's Jira key (PROJ-12) or item id. Leave it out in an item's run session (its own item); in the plan's session leave it out for the epic only." },
      part: { type: 'string', enum: [...JIRA_CONTEXT_PARTS], description: 'item, epic or both (default: both when there is an item, else epic).' },
    },
    additionalProperties: false,
  },
  annotations: { title: 'Read plan Jira context', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};
