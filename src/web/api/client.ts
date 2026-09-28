import type {
  AnswerBatch,
  AttachRequest,
  Artifact,
  FileDiff,
  HistoryItem,
  InboxItem,
  NewSession,
  ResumeCommand,
  Schedule,
  Session,
  SessionDetail,
  SessionEvent,
  Settings,
  SolutionGroup,
  SystemInfo,
  Tool,
  ToolProbe,
  Worktree,
} from '../../core/api.ts';

/**
 * Typed client for the local API (`docs/handoff/contracts/local-api.md`). Every
 * call is same-origin, so the browser sends the HttpOnly `sb_token` cookie
 * (gap #20); nothing here reads or stores the token. One function per contract
 * row; wire types come from `src/core/api.ts`, shared with the server.
 */

/** A non-2xx answer (or a network failure: `status` 0). */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  /** The parsed JSON body, when there is one. */
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.status = status;
    this.body = body;
  }

  /** The route exists but its backlog item has not landed yet (HTTP 501). */
  get notImplemented(): boolean {
    return this.status === 501;
  }

  /** The service could not be reached at all. */
  get unreachable(): boolean {
    return this.status === 0;
  }
}

type Method = 'GET' | 'POST' | 'PUT';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError(0, `${method} ${path}: ${error instanceof Error ? error.message : 'network error'}`);
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) throw new ApiError(response.status, `${method} ${path}: HTTP ${response.status}`, parsed);
  return parsed as T;
}

function query(params: Readonly<Record<string, string | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const enc = encodeURIComponent;

/** The contract's REST calls. */
export const api = {
  listSessions: () => request<Session[]>('GET', '/api/sessions'),
  createSession: (body: NewSession) => request<Session>('POST', '/api/sessions', body),
  getSession: (id: string) => request<SessionDetail>('GET', `/api/sessions/${enc(id)}`),
  sendMessage: (id: string, text: string) => request<null>('POST', `/api/sessions/${enc(id)}/messages`, { text }),
  pauseSession: (id: string) => request<Session>('POST', `/api/sessions/${enc(id)}/pause`),
  resumeSession: (id: string) => request<Session>('POST', `/api/sessions/${enc(id)}/resume`),
  detachSession: (id: string) => request<ResumeCommand>('POST', `/api/sessions/${enc(id)}/detach`),
  /** M4.1: a warning answers 409 `attach-warning` (`AttachWarning` body) until called again with `confirm`. */
  attachSession: (id: string, confirm = false) =>
    request<ResumeCommand>('POST', `/api/sessions/${enc(id)}/attach`, confirm ? ({ confirm: true } satisfies AttachRequest) : undefined),
  sessionEvents: (id: string, since?: string) => request<SessionEvent[]>('GET', `/api/sessions/${enc(id)}/events${query({ since })}`),
  sessionDiff: (id: string, file?: string) => request<FileDiff[]>('GET', `/api/sessions/${enc(id)}/diff${query({ file })}`),

  inbox: () => request<InboxItem[]>('GET', '/api/inbox'),
  answerBatch: (batchId: string, body: AnswerBatch) => request<null>('POST', `/api/questions/batch/${enc(batchId)}/answers`, body),
  inboxAction: (id: string, action: string) => request<null>('POST', `/api/inbox/${enc(id)}/actions/${enc(action)}`),

  solutions: () => request<SolutionGroup[]>('GET', '/api/solutions'),
  isolate: (repo: string, sessionId: string) => request<Worktree>('POST', `/api/solutions/${enc(repo)}/isolate`, { sessionId }),

  schedules: () => request<Schedule[]>('GET', '/api/schedules'),
  createSchedule: (body: unknown) => request<Schedule>('POST', '/api/schedules', body),
  runSchedule: (id: string) => request<Schedule>('POST', `/api/schedules/${enc(id)}/run`),
  pauseSchedule: (id: string) => request<Schedule>('POST', `/api/schedules/${enc(id)}/pause`),
  resumeSchedule: (id: string) => request<Schedule>('POST', `/api/schedules/${enc(id)}/resume`),

  artifacts: (params: { readonly type?: string; readonly q?: string } = {}) => request<Artifact[]>('GET', `/api/artifacts${query(params)}`),
  history: (q?: string) => request<HistoryItem[]>('GET', `/api/history${query({ q })}`),

  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (body: Settings) => request<Settings>('PUT', '/api/settings', body),

  tools: () => request<Tool[]>('GET', '/api/tools'),
  saveTools: (body: readonly Tool[]) => request<Tool[]>('PUT', '/api/tools', body),
  probeTool: (id: string) => request<ToolProbe>('POST', `/api/tools/${enc(id)}/probe`),

  system: () => request<SystemInfo>('GET', '/api/system'),
} as const;

/** The client's type (for test doubles). */
export type Api = typeof api;
