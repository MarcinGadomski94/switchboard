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
  /** "this blocks <key>". */
  blocks?: string[];
  /** Transition ids this issue cannot take (a missing transition). */
  without?: string[];
  comments: Array<{ id: string; body: unknown }>;
}

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

function adf(text: string): unknown {
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

function issueJson(issue: FakeIssue, all: Map<string, FakeIssue>, fields: string[] | null): Record<string, unknown> {
  const links: unknown[] = [];
  for (const target of issue.blocks ?? []) links.push({ id: `${issue.key}>${target}`, type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: target } });
  for (const other of all.values()) if ((other.blocks ?? []).includes(issue.key)) links.push({ id: `${other.key}>${issue.key}`, type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: other.key } });
  // A link of another type, never a dependency.
  links.push({ id: `${issue.key}~rel`, type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, outwardIssue: { key: 'PROJ-10' } });
  const every: Record<string, unknown> = {
    summary: issue.summary,
    description: issue.description,
    status: { name: issue.status, statusCategory: { key: CATEGORY[issue.status] ?? 'indeterminate' } },
    assignee: issue.assignee ? { displayName: issue.assignee } : null,
    components: (issue.components ?? []).map((name) => ({ name })),
    issuelinks: links,
    timeoriginalestimate: issue.estimateSeconds ?? null,
    issuetype: { name: issue.parent === null ? 'Epic' : 'Story' },
    parent: issue.parent ? { key: issue.parent } : undefined,
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
    if ((match = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/.exec(url.pathname))) {
      const issue = map.get(match[1] as string);
      if (!issue) return reply(404, { errorMessages: ['Issue does not exist.'] });
      if (method === 'GET') {
        const startAt = Number(url.searchParams.get('startAt') ?? '0');
        const max = Number(url.searchParams.get('maxResults') ?? '50');
        return reply(200, { startAt, maxResults: max, total: issue.comments.length, comments: issue.comments.slice(startAt, startAt + max) });
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
