import type {
  AnswerBatch,
  AttachRequest,
  Artifact,
  ArtifactListItem,
  CodebaseMemoryStatus,
  FileDiff,
  Folder,
  FolderCheck,
  FolderListing,
  HistoryItem,
  InboxItem,
  NewRepoSession,
  NewSession,
  ResumeCommand,
  Schedule,
  Session,
  SessionDetail,
  SessionEvent,
  SetupState,
  Settings,
  SolutionGroup,
  SystemInfo,
  Tool,
  ToolProbe,
  Worktree,
} from '../../core/api.ts';
import type { LoginServiceRequest, LoginServiceStatus } from '../../core/login-service.ts';

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

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

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
  /** D14: `folder` picks the saved folder (the default when omitted); a repo folder takes a `NewRepoSession`. */
  createSession: (body: NewSession | NewRepoSession) => request<Session>('POST', '/api/sessions', body),
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

  /** D14: one folder's solutions (`folder` = a saved folder's id or a session's folder path; the default folder when omitted). */
  solutions: (folder?: string) => request<SolutionGroup[]>('GET', `/api/solutions${query({ folder })}`),
  isolate: (repo: string, sessionId: string) => request<Worktree>('POST', `/api/solutions/${enc(repo)}/isolate`, { sessionId }),

  schedules: () => request<Schedule[]>('GET', '/api/schedules'),
  createSchedule: (body: unknown) => request<Schedule>('POST', '/api/schedules', body),
  runSchedule: (id: string) => request<Schedule>('POST', `/api/schedules/${enc(id)}/run`),
  pauseSchedule: (id: string) => request<Schedule>('POST', `/api/schedules/${enc(id)}/pause`),
  resumeSchedule: (id: string) => request<Schedule>('POST', `/api/schedules/${enc(id)}/resume`),

  artifacts: (params: { readonly type?: string; readonly q?: string } = {}) => request<ArtifactListItem[]>('GET', `/api/artifacts${query(params)}`),
  history: (q?: string) => request<HistoryItem[]>('GET', `/api/history${query({ q })}`),

  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (body: Settings) => request<Settings>('PUT', '/api/settings', body),

  tools: () => request<Tool[]>('GET', '/api/tools'),
  saveTools: (body: readonly Tool[]) => request<Tool[]>('PUT', '/api/tools', body),
  probeTool: (id: string) => request<ToolProbe>('POST', `/api/tools/${enc(id)}/probe`),
  /** Additive (M8.1, docs/tools.md): the Codebase Memory strip and its "Reindex n now" (gap #4). */
  codebaseMemory: (folder?: string) => request<CodebaseMemoryStatus>('GET', `/api/codebase-memory${query({ folder })}`),
  reindexCodebaseMemory: (folder?: string) => request<Session>('POST', `/api/codebase-memory/reindex${query({ folder })}`),

  system: () => request<SystemInfo>('GET', '/api/system'),

  /** "Start at login" (M9.1, additive to the contract, `docs/service.md`). */
  loginService: () => request<LoginServiceStatus>('GET', '/api/service'),
  setStartAtLogin: (startAtLogin: boolean) => request<LoginServiceStatus>('PUT', '/api/service', { startAtLogin } satisfies LoginServiceRequest),
  /** M5.3: `?fresh=1` checks the CLI and gh again (the setup wizard's first step). */
  systemFresh: () => request<SystemInfo>('GET', '/api/system?fresh=1'),

  // M5.3, additive to the contract: the first-run setup wizard (docs/setup.md).
  setup: () => request<SetupState>('GET', '/api/setup'),
  /** Browse…: one folder's subfolders (`GET /api/setup/folders`). */
  folders: (path?: string) => request<FolderListing>('GET', `/api/setup/folders${query({ path })}`),
  completeSetup: () => request<SetupState>('POST', '/api/setup/complete'),

  // D14, additive to the contract: the saved folders (docs/folders.md).
  savedFolders: () => request<Folder[]>('GET', '/api/folders'),
  /** The check line of a typed path; nothing is saved. */
  checkFolder: (path: string) => request<FolderCheck>('GET', `/api/folders/check${query({ path })}`),
  /** 201 added / 200 already saved; 422 `{ error: "invalid", message, check }` for anything but a workspace or a git repo. */
  addFolder: (path: string) => request<Folder>('POST', '/api/folders', { path }),
  /** The list left; 409 `folder-in-use` (`FolderInUse`) while schedules start their runs there. */
  removeFolder: (id: string) => request<Folder[]>('DELETE', `/api/folders/${enc(id)}`),
  setDefaultFolder: (id: string) => request<Folder[]>('PUT', `/api/folders/${enc(id)}/default`),
} as const;

/** The client's type (for test doubles). */
export type Api = typeof api;
