import type http from 'node:http';
import { type StubServer, startStubServer } from './stub-http.ts';

/**
 * D99-Jira tests: a fake Jira Cloud (REST API v3) on a loopback test port. Never the real Jira
 * (AGENTS.md): every test of the Jira lane points its credentials here. It holds issues (an
 * epic and its children with "blocks" links), a workflow's transitions and comments, checks
 * basic auth, records every request and can be told to fail.
 */

/** One issue of the fake. */
export interface FakeIssue {
  key: string;
  summary: string;
  /** An ADF document or `null`. */
  description: unknown;
  status: string;
  parent: string | null;
  components?: string[];
  assignee?: string | null;
  estimateSeconds?: number | null;
  /** Fields by id (e.g. `customfield_10050` = acceptance criteria). */
  custom?: Record<string, unknown>;
  /** "this blocks <key>" (Jira's UI on this issue): each <key> waits on this one. */
  blocks?: string[];
  /** Transition ids this issue cannot take (a missing transition). */
  without?: string[];
  /** REST v3 comments: an ADF body; D118: the author's display name and the creation date (Jira's `created`). */
  comments: Array<{ id: string; body: unknown; author?: string; created?: string }>;
  /** D118: a sub-task (its `parent` is a ticket): listed in the parent's `fields.subtasks`. */
  subtask?: boolean;
  /** D118: remote links (`GET …/remotelink`). */
  remoteLinks?: Array<{ title: string; url: string }>;
  /** D118: attachment file names (`fields.attachment`). */
  attachments?: string[];
  /** D118: links of other types, as Jira's UI on this issue says "this <type's outward phrase> <to>" (e.g. Relates: "relates to", Cloners: "clones"). */
  links?: Array<{ type: keyof typeof FAKE_LINK_TYPES; to: string }>;
}

/** D118: the link types the fake knows (Jira's real names and phrases). */
export const FAKE_LINK_TYPES = {
  Blocks: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  Relates: { name: 'Relates', inward: 'relates to', outward: 'relates to' },
  Cloners: { name: 'Cloners', inward: 'is cloned by', outward: 'clones' },
} as const;

/** A recorded request. */
export interface FakeJiraRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

/** The fake's workflow: transition id → name and target status. */
export const FAKE_TRANSITIONS: ReadonlyArray<{ id: string; name: string; to: string }> = [
  { id: '11', name: 'To Do', to: 'To Do' },
  { id: '21', name: 'Start progress', to: 'In Progress' },
  { id: '31', name: 'In Review', to: 'In Review' },
  { id: '41', name: 'Done', to: 'Done' },
];

const CATEGORY: Record<string, string> = { 'To Do': 'new', 'In Progress': 'indeterminate', 'In Review': 'indeterminate', Done: 'done', Blocked: 'indeterminate' };

/** The fake Jira. */
export interface FakeJira {
  readonly url: string;
  readonly email: string;
  readonly token: string;
  readonly issues: Map<string, FakeIssue>;
  readonly requests: FakeJiraRequest[];
  /** The next `count` requests whose `METHOD path` matches answer `status` (`commit`: a comment POST is stored / a transition POST is made first, then fails: a lost answer). */
  failNext(match: RegExp, status: number, options?: { count?: number; commit?: boolean }): void;
  /** Requests whose `METHOD path` matches. */
  calls(match: RegExp): FakeJiraRequest[];
  close(): Promise<void>;
}

/** A one-paragraph ADF document. */
export function adf(text: string): unknown {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

/** An ADF document with a paragraph, then an "Acceptance criteria" heading and a bullet list. */
export function adfWithAcceptance(text: string, criteria: string[]): unknown {
  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
      { type: 'bulletList', content: criteria.map((line) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: line }] }] })) },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Notes' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Ask Acme design.' }] },
    ],
  };
}

/** The epic of the tests: PROJ-10 with five children (PROJ-11…15). */
export function acmeEpic(): FakeIssue[] {
  return [
    { key: 'PROJ-10', summary: 'Acme checkout', description: adf('The Acme checkout epic.'), status: 'In Progress', parent: null, comments: [] },
    { key: 'PROJ-11', summary: 'Cart API', description: adf('Expose the cart.'), status: 'To Do', parent: 'PROJ-10', components: ['acme-api'], assignee: 'Ada Acme', estimateSeconds: 3600, custom: { customfield_10050: adf('Cart answers 200 with items.') }, blocks: ['PROJ-12'], comments: [] },
    { key: 'PROJ-12', summary: 'Cart page', description: adfWithAcceptance('Show the cart.', ['Lists the items', 'Shows the total']), status: 'To Do', parent: 'PROJ-10', components: ['acme-front'], blocks: ['PROJ-13'], without: ['31'], comments: [] },
    // A cycle: PROJ-13 blocks PROJ-14 and PROJ-14 blocks PROJ-13.
    { key: 'PROJ-13', summary: 'Payment form', description: null, status: 'To Do', parent: 'PROJ-10', blocks: ['PROJ-14'], comments: [] },
    { key: 'PROJ-14', summary: 'Payment provider', description: null, status: 'To Do', parent: 'PROJ-10', blocks: ['PROJ-13'], comments: [] },
    // Blocked by an issue outside the epic.
    { key: 'PROJ-15', summary: 'Receipt email', description: adf('Send a receipt.'), status: 'To Do', parent: 'PROJ-10', comments: [] },
    { key: 'PROJ-99', summary: 'Mail service', description: null, status: 'In Progress', parent: 'PROJ-90', blocks: ['PROJ-15'], comments: [] },
  ];
}

/** A linked issue as real Jira embeds it in `issuelinks`: key plus summary, status and type. */
/**
 * D118: {@link acmeEpic} with what the agents get besides the text: the epic's description with
 * acceptance criteria, a comment and a Confluence link; PROJ-12's comments (two people), two
 * sub-tasks, a Figma and a Confluence link, attachments and a "clones" link to an issue outside
 * the epic; PROJ-15 "is blocked by" PROJ-99 (outside) as before.
 */
export function acmeEpicWithContext(): FakeIssue[] {
  const issues = acmeEpic();
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  const epic = byKey.get('PROJ-10') as FakeIssue;
  epic.description = adfWithAcceptance('The Acme checkout epic: carts, payments and receipts.', ['A customer can pay for the cart', 'A receipt is emailed']);
  epic.comments = [{ id: '1', body: adf('Scope agreed with Acme product.'), author: 'Grace Acme', created: '2026-09-20T08:00:00.000+0000' }];
  epic.remoteLinks = [{ title: 'Acme checkout spec', url: 'https://acme.atlassian.net/wiki/spaces/ACME/pages/100/Checkout' }];
  const cart = byKey.get('PROJ-12') as FakeIssue;
  cart.comments = [
    { id: '2', body: adf('Use the new price formatter.'), author: 'Ada Acme', created: '2026-10-01T10:00:00.000+0000' },
    { id: '3', body: adf('Design updated: empty state added.'), author: 'Grace Acme', created: '2026-10-02T11:30:00.000+0000' },
  ];
  cart.remoteLinks = [
    { title: 'Cart page (Figma)', url: 'https://www.figma.com/design/AcmeFile/Cart?node-id=1-2' },
    { title: 'Cart rules', url: 'https://acme.atlassian.net/wiki/spaces/ACME/pages/101/Cart' },
  ];
  cart.attachments = ['cart-mockup.png', 'totals.pdf'];
  cart.links = [{ type: 'Cloners', to: 'PROJ-98' }];
  issues.push(
    { key: 'PROJ-21', summary: 'Cart empty state', description: adf('Show "Your cart is empty".'), status: 'To Do', parent: 'PROJ-12', subtask: true, comments: [] },
    { key: 'PROJ-22', summary: 'Cart totals row', description: null, status: 'Done', parent: 'PROJ-12', subtask: true, comments: [] },
    { key: 'PROJ-98', summary: 'Old cart page', description: null, status: 'Done', parent: 'PROJ-90', comments: [] },
  );
  return issues;
}

function linked(key: string, all: Map<string, FakeIssue>): Record<string, unknown> {
  const other = all.get(key);
  if (!other) return { id: key, key };
  return { id: other.key, key: other.key, fields: { summary: other.summary, status: { name: other.status, statusCategory: { key: CATEGORY[other.status] ?? 'indeterminate' } }, issuetype: { name: other.subtask ? 'Sub-task' : 'Story' } } };
}

/** A comment as REST v3 answers it. */
function commentJson(comment: FakeIssue['comments'][number]): Record<string, unknown> {
  const created = comment.created ?? '2026-10-01T09:00:00.000+0000';
  return { id: comment.id, author: { accountId: `acc-${comment.author ?? 'switchboard'}`, displayName: comment.author ?? 'Switchboard Bot' }, body: comment.body, created, updated: created };
}

function issueJson(issue: FakeIssue, all: Map<string, FakeIssue>, fields: string[] | null): Record<string, unknown> {
  const links: unknown[] = [];
  // Real Jira's shape (D117): an entry carries the OTHER issue, under the opposite side's verb.
  // "X blocks Y" is `inwardIssue: Y` on X and `outwardIssue: X` on Y.
  for (const target of issue.blocks ?? []) links.push({ id: `${issue.key}>${target}`, type: FAKE_LINK_TYPES.Blocks, inwardIssue: linked(target, all) });
  for (const other of all.values()) if ((other.blocks ?? []).includes(issue.key)) links.push({ id: `${other.key}>${issue.key}`, type: FAKE_LINK_TYPES.Blocks, outwardIssue: linked(other.key, all) });
  // D118: other types the same way: "X clones Y" is `inwardIssue: Y` on X and `outwardIssue: X` on Y.
  for (const link of issue.links ?? []) links.push({ id: `${issue.key}~${link.type}~${link.to}`, type: FAKE_LINK_TYPES[link.type], inwardIssue: linked(link.to, all) });
  for (const other of all.values()) for (const link of other.links ?? []) if (link.to === issue.key) links.push({ id: `${other.key}~${link.type}~${issue.key}`, type: FAKE_LINK_TYPES[link.type], outwardIssue: linked(other.key, all) });
  // A link of another type, never a dependency.
  links.push({ id: `${issue.key}~rel`, type: FAKE_LINK_TYPES.Relates, outwardIssue: linked('PROJ-10', all) });
  const every: Record<string, unknown> = {
    summary: issue.summary,
    description: issue.description,
    status: { name: issue.status, statusCategory: { key: CATEGORY[issue.status] ?? 'indeterminate' } },
    assignee: issue.assignee ? { displayName: issue.assignee } : null,
    components: (issue.components ?? []).map((name) => ({ name })),
    issuelinks: links,
    timeoriginalestimate: issue.estimateSeconds ?? null,
    issuetype: { name: issue.parent === null ? 'Epic' : issue.subtask ? 'Sub-task' : 'Story' },
    parent: issue.parent ? { key: issue.parent } : undefined,
    // D118: REST v3's sub-tasks (no description: real Jira gives key, summary, status and type only).
    subtasks: [...all.values()].filter((other) => other.subtask === true && other.parent === issue.key).map((other) => ({ id: other.key, key: other.key, fields: { summary: other.summary, status: { name: other.status }, issuetype: { name: 'Sub-task' } } })),
    attachment: (issue.attachments ?? []).map((filename, index) => ({ id: `${issue.key}-a${index}`, filename, size: 1024, mimeType: 'application/octet-stream', created: '2026-10-01T09:00:00.000+0000' })),
    comment: { comments: issue.comments.map(commentJson), maxResults: issue.comments.length, total: issue.comments.length, startAt: 0 },
    ...(issue.custom ?? {}),
  };
  const picked = fields === null ? every : Object.fromEntries(fields.filter((name) => name in every).map((name) => [name, every[name]]));
  return { id: issue.key, key: issue.key, fields: picked };
}

/** Starts the fake on a free test port with `issues` (default {@link acmeEpic}). */
export async function startFakeJira(issues: FakeIssue[] = acmeEpic()): Promise<FakeJira> {
  const email = 'dev@acme.example';
  const token = 'acme-jira-token-5c1d9f7a3b';
  const expected = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const map = new Map(issues.map((issue) => [issue.key, issue]));
  const requests: FakeJiraRequest[] = [];
  const failures: Array<{ match: RegExp; status: number; count: number; commit: boolean }> = [];
  let commentSeq = 100;

  const handle = (req: http.IncomingMessage, res: http.ServerResponse, raw: string): void => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const method = req.method ?? 'GET';
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    requests.push({ method, path: `${url.pathname}${url.search}`, authorization: req.headers.authorization ?? null, body });
    const reply = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload === undefined ? '' : JSON.stringify(payload));
    };
    if (req.headers.authorization !== expected) return reply(401, { errorMessages: ['Client must be authenticated to access this resource.'] });
    const line = `${method} ${url.pathname}`;
    const failure = failures.find((entry) => entry.count > 0 && entry.match.test(line));
    if (failure) {
      failure.count -= 1;
      if (!failure.commit) return reply(failure.status, { errorMessages: ['Fake Jira failure.'] });
    }
    const fields = url.searchParams.get('fields')?.split(',').filter(Boolean) ?? null;
    let match: RegExpExecArray | null;
    if (method === 'GET' && url.pathname === '/rest/api/3/field') {
      return reply(200, [
        { id: 'summary', name: 'Summary', custom: false },
        { id: 'customfield_10050', name: 'Acceptance Criteria', custom: true },
      ]);
    }
    if (method === 'GET' && url.pathname === '/rest/api/3/search/jql') {
      const jql = url.searchParams.get('jql') ?? '';
      const parent = /parent\s*=\s*([A-Z]+-\d+)/.exec(jql)?.[1] ?? '';
      const found = [...map.values()].filter((issue) => issue.parent === parent).map((issue) => issueJson(issue, map, fields));
      return reply(200, { issues: found, isLast: true });
    }
    if ((match = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(url.pathname)) && method === 'GET') {
      const issue = map.get(match[1] as string);
      return issue ? reply(200, issueJson(issue, map, fields)) : reply(404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] });
    }
    if ((match = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/transitions$/.exec(url.pathname))) {
      const issue = map.get(match[1] as string);
      if (!issue) return reply(404, { errorMessages: ['Issue does not exist.'] });
      const available = FAKE_TRANSITIONS.filter((entry) => !(issue.without ?? []).includes(entry.id) && entry.to !== issue.status);
      if (method === 'GET') return reply(200, { transitions: available.map((entry) => ({ id: entry.id, name: entry.name, to: { name: entry.to } })) });
      const id = (body as { transition?: { id?: string } } | null)?.transition?.id;
      const chosen = available.find((entry) => entry.id === id);
      if (!chosen) return reply(400, { errorMessages: ['Transition is not valid.'] });
      issue.status = chosen.to;
      if (failure?.commit) return reply(failure.status, { errorMessages: ['Fake Jira failure after moving.'] });
      return reply(204, undefined);
    }
    if ((match = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/remotelink$/.exec(url.pathname)) && method === 'GET') {
      const issue = map.get(match[1] as string);
      if (!issue) return reply(404, { errorMessages: ['Issue does not exist.'] });
      // REST v3's remote links: `{ id, self, object: { url, title, icon } }`.
      return reply(200, (issue.remoteLinks ?? []).map((link, index) => ({ id: 10_000 + index, self: `${url.origin}/rest/api/3/issue/${issue.key}/remotelink/${10_000 + index}`, object: { url: link.url, title: link.title, icon: {} } })));
    }
    if ((match = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/.exec(url.pathname))) {
      const issue = map.get(match[1] as string);
      if (!issue) return reply(404, { errorMessages: ['Issue does not exist.'] });
      if (method === 'GET') {
        const startAt = Number(url.searchParams.get('startAt') ?? '0');
        const max = Number(url.searchParams.get('maxResults') ?? '50');
        return reply(200, { startAt, maxResults: max, total: issue.comments.length, comments: issue.comments.slice(startAt, startAt + max).map(commentJson) });
      }
      const comment = { id: String(++commentSeq), body: (body as { body?: unknown } | null)?.body ?? null };
      issue.comments.push(comment);
      if (failure?.commit) return reply(failure.status, { errorMessages: ['Fake Jira failure after storing.'] });
      return reply(201, comment);
    }
    return reply(404, { errorMessages: [`No fake route for ${line}`] });
  };

  const server: StubServer = await startStubServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    email,
    token,
    issues: map,
    requests,
    failNext(match, status, options = {}) {
      failures.push({ match, status, count: options.count ?? 1, commit: options.commit === true });
    },
    calls(match) {
      return requests.filter((request) => match.test(`${request.method} ${request.path}`));
    },
    close: () => server.close(),
  };
}

/** The plain text of a fake comment's ADF body. */
export function commentText(comment: { body: unknown }): string {
  const walk = (node: unknown): string => {
    if (typeof node !== 'object' || node === null) return '';
    const record = node as Record<string, unknown>;
    return `${typeof record['text'] === 'string' ? record['text'] : ''}${Array.isArray(record['content']) ? record['content'].map(walk).join('') : ''}`;
  };
  return walk(comment.body);
}
