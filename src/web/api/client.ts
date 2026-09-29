import type {
  AnswerBatch,
  AttachRequest,
  Artifact,
  ArtifactListItem,
  CodebaseMemoryStatus,
  ContinueConversation,
  FileDiff,
  Folder,
  FolderCheck,
  FolderListing,
  FrameHelperInfo,
  HistoryItem,
  InboxItem,
  IsolateRequest,
  ModelSettings,
  NewRepoSession,
  NewSession,
  ResumeCommand,
  Schedule,
  Session,
  SessionTitleInput,
  SessionCloseInput,
  SessionDetail,
  SessionModelInput,
  SessionRemoteInput,
  SessionEvent,
  SetupState,
  Settings,
  SolutionGroup,
  SystemInfo,
  TeleportSession,
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
  /** D33: open sessions only (the sidebar, the palette); `{ closed: 'include' }` lists closed ones too. */
  listSessions: (options: { readonly closed?: 'include' } = {}) => request<Session[]>('GET', `/api/sessions${query({ closed: options.closed })}`),
  /** D14: `folder` picks the saved folder (the default when omitted); a repo folder takes a `NewRepoSession`. */
  createSession: (body: NewSession | NewRepoSession) => request<Session>('POST', '/api/sessions', body),
  /** D25, additive: continue a remote session locally (201 Session; 422 / 409, or 502 `teleport-failed` / 504 `teleport-timeout` with the CLI's text). */
  teleportSession: (body: TeleportSession) => request<Session>('POST', '/api/sessions/teleport', body),
  getSession: (id: string) => request<SessionDetail>('GET', `/api/sessions/${enc(id)}`),
  sendMessage: (id: string, text: string) => request<null>('POST', `/api/sessions/${enc(id)}/messages`, { text }),
  /** D22, additive: rename (`null` or an empty title clears it; 422 on field `title` beyond 80 characters). */
  renameSession: (id: string, title: string | null) => request<Session>('PUT', `/api/sessions/${enc(id)}/title`, { title } satisfies SessionTitleInput),
  /** D24: Remote Control on / off for the session's live process. */
  setRemote: (id: string, enabled: boolean) => request<Session>('PUT', `/api/sessions/${enc(id)}/remote`, { enabled } satisfies SessionRemoteInput),
  /** D31: the session's model and / or effort (a field left out keeps its value; `null` = the CLI's default). */
  setModel: (id: string, input: SessionModelInput) => request<Session>('PUT', `/api/sessions/${enc(id)}/model`, input),
  pauseSession: (id: string) => request<Session>('POST', `/api/sessions/${enc(id)}/pause`),
  /** D33: close; `confirm` is needed for a live, running or waiting session (409 `close-needs-confirm` otherwise). */
  closeSession: (id: string, confirm = false) =>
    request<Session>('POST', `/api/sessions/${enc(id)}/close`, confirm ? ({ confirm: true } satisfies SessionCloseInput) : undefined),
  /** D33: reopen a closed session (no process starts). */
  reopenSession: (id: string) => request<Session>('POST', `/api/sessions/${enc(id)}/reopen`),
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
  /** "Move … to worktree" (gap #2); D32: `branch` names the new worktree's branch after the ticket (required). */
  isolate: (repo: string, sessionId: string, branch: string) =>
    request<Worktree>('POST', `/api/solutions/${enc(repo)}/isolate`, { sessionId, branch } satisfies IsolateRequest),

  schedules: () => request<Schedule[]>('GET', '/api/schedules'),
  createSchedule: (body: unknown) => request<Schedule>('POST', '/api/schedules', body),
  runSchedule: (id: string) => request<Schedule>('POST', `/api/schedules/${enc(id)}/run`),
  pauseSchedule: (id: string) => request<Schedule>('POST', `/api/schedules/${enc(id)}/pause`),
  resumeSchedule: (id: string) => request<Schedule>('POST', `/api/schedules/${enc(id)}/resume`),

  artifacts: (params: { readonly type?: string; readonly q?: string } = {}) => request<ArtifactListItem[]>('GET', `/api/artifacts${query(params)}`),
  history: (q?: string) => request<HistoryItem[]>('GET', `/api/history${query({ q })}`),
  /** D16, additive: a terminal conversation continues in Switchboard as the same conversation (201 Session; 409 `ContinueRefusal`s, docs/derivations.md → History). */
  continueConversation: (claudeSessionId: string, body: ContinueConversation = {}) =>
    request<Session>('POST', `/api/history/${enc(claudeSessionId)}/continue`, body),

  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (body: Settings) => request<Settings>('PUT', '/api/settings', body),
  /** D42, additive: the latest reported model list and the last model choice (the New-session form's Model row). */
  models: () => request<ModelSettings>('GET', '/api/models'),

  tools: () => request<Tool[]>('GET', '/api/tools'),
  saveTools: (body: readonly Tool[]) => request<Tool[]>('PUT', '/api/tools', body),
  probeTool: (id: string) => request<ToolProbe>('POST', `/api/tools/${enc(id)}/probe`),
  /** Additive (M8.1, docs/tools.md): the Codebase Memory strip and its "Reindex n now" (gap #4). */
  codebaseMemory: (folder?: string) => request<CodebaseMemoryStatus>('GET', `/api/codebase-memory${query({ folder })}`),
  reindexCodebaseMemory: (folder?: string) => request<Session>('POST', `/api/codebase-memory/reindex${query({ folder })}`),
  // D35, additive (docs/frame-helper.md → Guided setup): the frame-helper setup; the two POSTs answer 204, or 502 `open-failed` with the opener's error.
  frameHelper: () => request<FrameHelperInfo>('GET', '/api/frame-helper'),
  /** Opens the OS file manager on `tools/frame-helper`. */
  revealFrameHelper: () => request<null>('POST', '/api/frame-helper/reveal'),
  /** Opens `chrome://extensions` in Chrome (a page cannot open `chrome://` URLs itself). */
  openChromeExtensions: () => request<null>('POST', '/api/frame-helper/open-extensions'),

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
  /**
   * 201 added / 200 already saved; 422 `{ error: "invalid", message, check }` for anything but a workspace or a git repo.
   * D18: `label` is the optional custom name (sent only when not empty); 409 `label-taken`, 422 `invalid-label`.
   */
  addFolder: (path: string, label?: string) => request<Folder>('POST', '/api/folders', label ? { path, label } : { path }),
  /** D18: Rename (`null` or empty = the folder's own name again); the whole list; 404, 409 `label-taken`, 422 `invalid-label`. */
  renameFolder: (id: string, label: string | null) => request<Folder[]>('PUT', `/api/folders/${enc(id)}/label`, { label }),
  /** The list left; 409 `folder-in-use` (`FolderInUse`) while schedules start their runs there. */
  removeFolder: (id: string) => request<Folder[]>('DELETE', `/api/folders/${enc(id)}`),
  setDefaultFolder: (id: string) => request<Folder[]>('PUT', `/api/folders/${enc(id)}/default`),
} as const;

/** The client's type (for test doubles). */
export type Api = typeof api;
