import {
  ISSUE_IMPORT_MAX,
  type ImportableIssue,
  type IssueImportPreview,
  type IssueImportQuery,
  type IssueImportSources,
  issueTodo,
  jiraImportJql,
  parseIssueQuery,
} from '../../core/ci.ts';
import type { SessionTodoList } from '../../core/api.ts';
import type { CiGhPort } from '../ci/gh.ts';
import type { Store } from '../db/store.ts';
import type { TodoService } from './service.ts';

/** One issue a Jira source answered (plain text body, the issue's browse link). */
export interface JiraImportIssue {
  readonly key: string;
  readonly title: string;
  readonly url: string | null;
  readonly body: string | null;
}

/**
 * D109: where Jira issues come from for the import: Plans' Jira lane registers its client and
 * credentials here (`src/server/plans/jira/install.ts`), so the todo import reuses the one
 * Jira connection (Settings → Experimental → Plans → Jira connection, else `ATL_*`) and never
 * reads a credential itself. Without a registration Jira is not available.
 */
export interface JiraIssueSource {
  /** Whether a Jira connection exists; `problem` says what is missing. */
  status(): Promise<{ readonly available: boolean; readonly problem: string | null }>;
  /** Issues matching `jql`, at most `max`. Throws an `Error` whose message is safe to show (never a credential). */
  search(jql: string, max: number): Promise<{ readonly issues: readonly JiraImportIssue[]; readonly truncated: boolean }>;
}

const jiraSources = new WeakMap<object, JiraIssueSource>();

/** Registers the Jira issue source for `store`; answers the unregister function. */
export function registerJiraIssueSource(store: object, source: JiraIssueSource): () => void {
  jiraSources.set(store, source);
  return () => {
    if (jiraSources.get(store) === source) jiraSources.delete(store);
  };
}

/** Why an import call was refused (`status` → HTTP). */
export class TodoImportError extends Error {
  override name = 'TodoImportError';
  readonly status: number;
  readonly code: string;
  readonly field: string | null;
  constructor(status: number, code: string, message: string, field: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** Options of {@link TodoImportService}. */
export interface TodoImportServiceOptions {
  readonly store: Store;
  readonly todos: TodoService;
  readonly gh: CiGhPort;
  /** Where `gh issue list` runs (any folder: `--repo` names the repository). */
  readonly cwd: string;
  /** The folders of the session's repositories (its worktrees, its solutions in place), to offer their `owner/repo`. */
  readonly sessionDirs: (sessionId: string) => Promise<readonly string[]>;
}

/**
 * D109 · Import issues as todos (`docs/todos.md` → *Import issues (D109)*): a preview of a
 * GitHub repository's open issues (`gh issue list`, label / assigned to me) or of Jira issues
 * (JQL or a project key), then the ticked ones become todo items of the session: the title,
 * the body (cut) and a link back. Each imported issue is recorded per session
 * (`todo_imports`), so importing again skips it (also after its todo was removed).
 */
export class TodoImportService {
  readonly #store: Store;
  readonly #todos: TodoService;
  readonly #gh: CiGhPort;
  readonly #cwd: string;
  readonly #sessionDirs: (sessionId: string) => Promise<readonly string[]>;

  constructor(options: TodoImportServiceOptions) {
    this.#store = options.store;
    this.#todos = options.todos;
    this.#gh = options.gh;
    this.#cwd = options.cwd;
    this.#sessionDirs = options.sessionDirs;
  }

  async #session(sessionId: string): Promise<void> {
    if (!(await this.#store.sessions.get(sessionId))) throw new TodoImportError(404, 'not-found', `no session ${sessionId}`);
  }

  /** `GET …/todos/import/sources`: the session's `owner/repo`s and whether Jira is connected. */
  async sources(sessionId: string): Promise<IssueImportSources> {
    await this.#session(sessionId);
    const repos = new Set<string>();
    for (const dir of await this.#sessionDirs(sessionId)) {
      const name = await this.#gh.repoName(dir);
      if (name) repos.add(name);
    }
    const jira = jiraSources.get(this.#store);
    const jiraStatus = jira ? await jira.status().catch(() => ({ available: false, problem: 'the Jira connection could not be read' })) : { available: false, problem: 'Jira import needs Plans: it reuses the Jira connection of Settings → Experimental → Plans' };
    return {
      github: { available: true, repos: [...repos].sort(), problem: null },
      jira: { available: jiraStatus.available, problem: jiraStatus.problem },
    };
  }

  /** `POST …/todos/import/preview`: the matching issues, already imported ones marked. */
  async preview(sessionId: string, body: unknown): Promise<IssueImportPreview> {
    await this.#session(sessionId);
    const query = this.#query(body);
    const { issues, truncated } = await this.#fetch(query);
    const known = await this.#store.todoImports.keys(sessionId, query.source);
    return { issues: issues.map((issue) => ({ ...issue, imported: known.has(issue.key) })), truncated };
  }

  /**
   * `POST …/todos/import` `{ query, keys }`: reads the issues again and adds the ticked ones that
   * are not imported yet, in the preview's order; answers the session's list.
   */
  async import(sessionId: string, body: unknown): Promise<SessionTodoList> {
    await this.#session(sessionId);
    const input = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const query = this.#query(input['query']);
    const keys = Array.isArray(input['keys']) ? input['keys'].filter((key): key is string => typeof key === 'string' && key.length <= 200) : null;
    if (keys === null || keys.length === 0) throw new TodoImportError(422, 'invalid', 'tick at least one issue to import', 'keys');
    if (keys.length > ISSUE_IMPORT_MAX) throw new TodoImportError(422, 'invalid', `import at most ${ISSUE_IMPORT_MAX} issues at once`, 'keys');
    const wanted = new Set(keys);
    const { issues } = await this.#fetch(query);
    for (const issue of issues) {
      if (!wanted.has(issue.key)) continue;
      // Claimed first, so two imports at once never add the same issue twice.
      if (!(await this.#store.todoImports.record({ sessionId, source: query.source, externalKey: issue.key, url: issue.url, todoId: null }))) continue;
      const fields = issueTodo(issue, query.source);
      try {
        const { todo } = await this.#todos.add(sessionId, { title: fields.title, description: fields.description, plan: `No plan: imported from ${query.source === 'github' ? 'GitHub' : 'Jira'} (${issue.key})` }, 'developer');
        await this.#store.todoImports.setTodo(sessionId, query.source, issue.key, todo.id);
      } catch (error) {
        await this.#store.todoImports.forget(sessionId, query.source, issue.key);
        throw error;
      }
    }
    return this.#todos.list(sessionId);
  }

  #query(body: unknown): IssueImportQuery {
    const parsed = parseIssueQuery(body);
    if (!parsed.ok) throw new TodoImportError(422, 'invalid', parsed.message, parsed.field);
    return parsed.value;
  }

  async #fetch(query: IssueImportQuery): Promise<{ readonly issues: Array<Omit<ImportableIssue, 'imported'>>; readonly truncated: boolean }> {
    if (query.source === 'github') {
      const answer = await this.#gh.listIssues(this.#cwd, { repo: query.repo, label: query.label, mine: query.mine });
      if (!answer.ok) throw new TodoImportError(502, 'source-failed', answer.message);
      return {
        issues: answer.issues.slice(0, ISSUE_IMPORT_MAX).map((issue) => ({ key: `${query.repo}#${issue.number}`, title: issue.title, url: issue.url, body: issue.body, labels: issue.labels })),
        truncated: answer.issues.length > ISSUE_IMPORT_MAX,
      };
    }
    const jira = jiraSources.get(this.#store);
    if (!jira) throw new TodoImportError(409, 'jira-unavailable', 'Jira import reuses the Jira connection of Settings → Experimental → Plans: switch Plans on and connect Jira there (or set ATL_BASE_URL, ATL_USER and ATL_TOKEN)');
    const status = await jira.status();
    if (!status.available) throw new TodoImportError(409, 'jira-unavailable', status.problem ?? 'Jira is not connected');
    let found;
    try {
      found = await jira.search(jiraImportJql(query), ISSUE_IMPORT_MAX);
    } catch (error) {
      throw new TodoImportError(502, 'source-failed', error instanceof Error ? error.message : 'Jira could not be read');
    }
    return { issues: found.issues.map((issue) => ({ key: issue.key, title: issue.title, url: issue.url, body: issue.body, labels: [] })), truncated: found.truncated };
  }
}
