import type { JiraIssueInput, JiraTransition } from '../../../core/plans-jira.ts';
import { normalizeJiraBaseUrl } from '../../../core/plans-jira.ts';

/** Jira credentials (basic auth: the account's email and an API token). The token never leaves this module's requests. */
export interface JiraCredentials {
  readonly baseUrl: string;
  readonly email: string;
  readonly token: string;
}

/** Why a Jira call failed. `message` never carries the token or a header. */
export class JiraError extends Error {
  override name = 'JiraError';
  /** The HTTP status Jira answered, `0` = Jira could not be reached (or answered something that is not JSON). */
  readonly status: number;
  /** `auth` (401 / 403), `not-found` (404), `unreachable`, `failed` (anything else). */
  readonly code: 'auth' | 'not-found' | 'unreachable' | 'failed';
  constructor(status: number, code: JiraError['code'], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  /** A transient failure worth trying again later (network, 429, 5xx). */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** The time one request may take. */
export const JIRA_TIMEOUT_MS = 20_000;

/** A page of `GET /rest/api/3/search/jql`. */
interface SearchPage {
  readonly issues: JiraIssueInput[];
  readonly nextPageToken: string | null;
}

/** A comment's plain text (enough to find a Switchboard marker in it). */
export interface JiraComment {
  readonly id: string;
  readonly text: string;
  /** D118: the comment as Jira answered it (author, created, ADF body), for the plan's Jira context. */
  readonly raw: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Every text node of an ADF document, joined (for markers). */
function adfStrings(value: unknown): string {
  if (typeof value === 'string') return value;
  const node = record(value);
  if (!node) return '';
  const own = typeof node['text'] === 'string' ? node['text'] : '';
  const inner = Array.isArray(node['content']) ? node['content'].map(adfStrings).join(' ') : '';
  return `${own} ${inner}`.trim();
}

/**
 * D99-Jira: a small Jira Cloud REST API v3 client (basic auth: email + API token). Every
 * request goes to the configured base URL only (a path is resolved against it and refused if
 * it would leave it); errors carry the status and Jira's own messages, never the token.
 */
export class JiraClient {
  readonly #base: string;
  readonly #auth: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(credentials: JiraCredentials, options: { readonly fetch?: typeof fetch; readonly timeoutMs?: number } = {}) {
    const base = normalizeJiraBaseUrl(credentials.baseUrl);
    if (base === null) throw new JiraError(0, 'failed', 'the Jira base URL must be https://<your-site>.atlassian.net');
    this.#base = base;
    this.#auth = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`, 'utf8').toString('base64')}`;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? JIRA_TIMEOUT_MS;
  }

  /** The base URL (`https://acme.atlassian.net`). */
  get baseUrl(): string {
    return this.#base;
  }

  async #call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, this.#base);
    if (url.origin !== this.#base) throw new JiraError(0, 'failed', 'refused a request outside the configured Jira site');
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: { authorization: this.#auth, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? `no answer within ${Math.round(this.#timeoutMs / 1000)} s` : 'could not connect';
      throw new JiraError(0, 'unreachable', `Jira (${this.#base}) ${reason}`);
    }
    const text = await response.text().catch(() => '');
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      const messages = record(parsed);
      const detail = [...(Array.isArray(messages?.['errorMessages']) ? (messages['errorMessages'] as unknown[]) : []), ...Object.values(record(messages?.['errors']) ?? {})]
        .filter((entry): entry is string => typeof entry === 'string')
        .join('; ')
        .slice(0, 300);
      const code = response.status === 401 || response.status === 403 ? 'auth' : response.status === 404 ? 'not-found' : 'failed';
      const lead = code === 'auth' ? 'Jira refused the credentials (check the email and the API token)' : `Jira answered ${response.status}`;
      throw new JiraError(response.status, code, detail ? `${lead}: ${detail}` : lead);
    }
    return parsed;
  }

  /** One issue with `fields`. @throws {JiraError} `not-found` */
  async issue(key: string, fields: readonly string[]): Promise<JiraIssueInput> {
    const answer = record(await this.#call('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fields.join(','))}`));
    if (!answer || typeof answer['key'] !== 'string') throw new JiraError(0, 'failed', `Jira answered no issue for ${key}`);
    return { key: answer['key'], fields: record(answer['fields']) ?? {} };
  }

  /** Issues matching `jql` (enhanced search, paged by `nextPageToken`), at most `max`; `truncated` when there were more. */
  async search(jql: string, fields: readonly string[], max: number): Promise<{ readonly issues: JiraIssueInput[]; readonly truncated: boolean }> {
    const issues: JiraIssueInput[] = [];
    let token: string | null = null;
    do {
      const page: SearchPage = await this.#searchPage(jql, fields, Math.min(100, max - issues.length + 1), token);
      issues.push(...page.issues);
      token = page.nextPageToken;
    } while (token !== null && issues.length <= max);
    return { issues: issues.slice(0, max), truncated: issues.length > max || token !== null };
  }

  async #searchPage(jql: string, fields: readonly string[], maxResults: number, token: string | null): Promise<SearchPage> {
    const query = new URLSearchParams({ jql, fields: fields.join(','), maxResults: String(maxResults) });
    if (token !== null) query.set('nextPageToken', token);
    const answer = record(await this.#call('GET', `/rest/api/3/search/jql?${query.toString()}`));
    const issues = (Array.isArray(answer?.['issues']) ? (answer['issues'] as unknown[]) : [])
      .map(record)
      .filter((issue): issue is Record<string, unknown> => issue !== null && typeof issue['key'] === 'string')
      .map((issue) => ({ key: issue['key'] as string, fields: record(issue['fields']) ?? {} }));
    const next = answer?.['nextPageToken'];
    return { issues, nextPageToken: typeof next === 'string' && next !== '' && answer?.['isLast'] !== true ? next : null };
  }

  /** The id of a custom field named "Acceptance criteria" (any case), or `null`. */
  async acceptanceField(): Promise<string | null> {
    const answer = await this.#call('GET', '/rest/api/3/field');
    const fields = Array.isArray(answer) ? answer.map(record) : [];
    const found = fields.find((field) => field !== null && typeof field['name'] === 'string' && /^acceptance\s+criteria$/i.test(field['name'].trim()) && typeof field['id'] === 'string');
    return (found?.['id'] as string | undefined) ?? null;
  }

  /** The transitions available to the issue now. */
  async transitions(key: string): Promise<JiraTransition[]> {
    const answer = record(await this.#call('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`));
    return (Array.isArray(answer?.['transitions']) ? (answer['transitions'] as unknown[]) : [])
      .map(record)
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry['id'] === 'string' && typeof entry['name'] === 'string')
      .map((entry) => ({ id: entry['id'] as string, name: entry['name'] as string, to: typeof record(entry['to'])?.['name'] === 'string' ? (record(entry['to'])?.['name'] as string) : null }));
  }

  /** Moves the issue through transition `id`. */
  async transition(key: string, id: string): Promise<void> {
    await this.#call('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id } });
  }

  /** The issue's comments (plain text, enough to find a marker), oldest first. */
  async comments(key: string): Promise<JiraComment[]> {
    const out: JiraComment[] = [];
    for (let startAt = 0; startAt < 5_000; ) {
      const answer = record(await this.#call('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100`));
      const page = (Array.isArray(answer?.['comments']) ? (answer['comments'] as unknown[]) : []).map(record).filter((entry): entry is Record<string, unknown> => entry !== null);
      for (const entry of page) out.push({ id: String(entry['id'] ?? ''), text: adfStrings(entry['body']), raw: entry });
      const total = typeof answer?.['total'] === 'number' ? answer['total'] : out.length;
      if (page.length === 0 || out.length >= total) break;
      startAt = out.length;
    }
    return out;
  }

  /** D118: the issue's remote links (`GET …/remotelink`: Confluence, Figma, any URL), as Jira answers them. */
  async remoteLinks(key: string): Promise<unknown[]> {
    const answer = await this.#call('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`);
    return Array.isArray(answer) ? answer : [];
  }

  /** Adds a comment (one paragraph of plain text; a URL in it stays a plain link). */
  async addComment(key: string, text: string): Promise<void> {
    await this.#call('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    });
  }
}
