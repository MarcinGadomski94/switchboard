import type {
  Attachment,
  AttachmentUpload,
  InterruptResult,
  StopBackgroundRequest,
  StopBackgroundResult,
  BranchingPreflight,
  BranchingPreflightRequest,
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
  HooksStatus,
  InboxItem,
  IsolateRequest,
  RepoBranches,
  ModelSettings,
  NewRepoSession,
  NewSimpleSession,
  NewSession,
  ResumeCommand,
  Schedule,
  TerminalLoop,
  Session,
  SessionTitleInput,
  SessionCloseInput,
  SessionDetail,
  SessionModelInput,
  SessionRemoteInput,
  SessionEvent,
  SetupState,
  Settings,
  SidebarFolderPatch,
  SidebarLayout,
  SidebarPlaceInput,
  SolutionGroup,
  SystemInfo,
  TeleportSession,
  TerminalSession,
  Tool,
  ToolProbe,
  Worktree,
  WorkflowAgentChat,
} from '../../core/api.ts';
import type { LoginServiceRequest, LoginServiceStatus } from '../../core/login-service.ts';
import type { UpdateStatus, UpdateVersionInput } from '../../core/updates.ts';
import type { AddMachineInput, Machine, MachinesView, PairingCode, PeerListenerInput, PeerListenerState } from '../../core/peers.ts';

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
  /** D14: `folder` picks the saved folder (the default when omitted); a repo folder takes a `NewRepoSession`; D56: the simple form a `NewSimpleSession`. */
  createSession: (body: NewSession | NewRepoSession | NewSimpleSession) => request<Session>('POST', '/api/sessions', body),
  /** D25, additive: continue a remote session locally (201 Session; 422 / 409, or 502 `teleport-failed` / 504 `teleport-timeout` with the CLI's text). */
  teleportSession: (body: TeleportSession) => request<Session>('POST', '/api/sessions/teleport', body),
  /** D40, additive: the New-session form's branching preflight (each repo fetched, then read; nothing created). */
  branchingPreflight: (body: BranchingPreflightRequest) => request<BranchingPreflight>('POST', '/api/branching/preflight', body),
  getSession: (id: string) => request<SessionDetail>('GET', `/api/sessions/${enc(id)}`),
  /** D57: `attachments` = ids uploaded to this session (`uploadAttachment`); with some, `text` may be empty. */
  sendMessage: (id: string, text: string, attachments: readonly string[] = []) =>
    request<null>('POST', `/api/sessions/${enc(id)}/messages`, attachments.length > 0 ? { text, attachments } : { text }),
  /** D57: one file (base64) for this session's next message → 201 Attachment; 413 over 20 MiB. */
  uploadAttachment: (id: string, body: AttachmentUpload) => request<Attachment>('POST', `/api/sessions/${enc(id)}/attachments`, body),
  /** D22, additive: rename (`null` or an empty title clears it; 422 on field `title` beyond 80 characters). */
  renameSession: (id: string, title: string | null) => request<Session>('PUT', `/api/sessions/${enc(id)}/title`, { title } satisfies SessionTitleInput),
  /** D24: Remote Control on / off for the session's live process. */
  setRemote: (id: string, enabled: boolean) => request<Session>('PUT', `/api/sessions/${enc(id)}/remote`, { enabled } satisfies SessionRemoteInput),
  /** D31: the session's model and / or effort (a field left out keeps its value; `null` = the CLI's default). */
  setModel: (id: string, input: SessionModelInput) => request<Session>('PUT', `/api/sessions/${enc(id)}/model`, input),
  pauseSession: (id: string) => request<Session>('POST', `/api/sessions/${enc(id)}/pause`),
  /** D50: Stop the current turn (the process stays alive); the reply carries the messages taken back for the composer. */
  interruptSession: (id: string) => request<InterruptResult>('POST', `/api/sessions/${enc(id)}/interrupt`),
  /** D50 ruling: stop the session's background tasks (`stop_task` each); `taskIds` absent = every stoppable one. */
  stopBackground: (id: string, body: StopBackgroundRequest = {}) => request<StopBackgroundResult>('POST', `/api/sessions/${enc(id)}/background/stop`, body),
  /** D33: close; `confirm` is needed for a live, running or waiting session (409 `close-needs-confirm` otherwise). */
  closeSession: (id: string, confirm = false) =>
    request<Session>('POST', `/api/sessions/${enc(id)}/close`, confirm ? ({ confirm: true } satisfies SessionCloseInput) : undefined),
  /** D54, additive: the sidebar's pins and folders (this machine's; `docs/sidebar.md`). Every write answers the new layout. */
  sidebarLayout: () => request<SidebarLayout>('GET', '/api/sidebar'),
  /** D54: a new folder, at the end of the folders (201); D58: `parentId` = at the end of that folder's subfolders. */
  createSidebarFolder: (name: string, parentId: string | null = null) => request<SidebarLayout>('POST', '/api/sidebar/folders', parentId === null ? { name } : { name, parentId }),
  /** D54: rename and / or collapse / expand a folder. */
  updateSidebarFolder: (id: string, patch: SidebarFolderPatch) => request<SidebarLayout>('PUT', `/api/sidebar/folders/${enc(id)}`, patch),
  /** D54: a folder's final position among the folders of its level; D58: `parentId` moves it into that folder (`null` = the top level). */
  moveSidebarFolder: (id: string, index: number, parentId?: string | null) =>
    request<SidebarLayout>('PUT', `/api/sidebar/folders/${enc(id)}/position`, parentId === undefined ? { index } : { index, parentId }),
  /** D54: delete a folder (its sessions become loose; D58: in a subfolder they go to its parent, and its subfolders move up a level). */
  deleteSidebarFolder: (id: string) => request<SidebarLayout>('DELETE', `/api/sidebar/folders/${enc(id)}`),
  /** D54: pin, unpin, put into / take out of a folder, or re-order a session. */
  placeSidebarSession: (input: SidebarPlaceInput) => request<SidebarLayout>('POST', '/api/sidebar/place', input),
  /** D55, additive: the updater (`docs/updates.md`); 501 when it is off (the demo, `SWITCHBOARD_UPDATES=off`). */
  updates: () => request<UpdateStatus>('GET', '/api/updates'),
  /** D55: check GitHub releases now. */
  checkUpdates: () => request<UpdateStatus>('POST', '/api/updates/check'),
  /** D55: start the update to `version` (202; the progress comes as `updateChanged`). */
  installUpdate: (version: string) => request<UpdateStatus>('POST', '/api/updates/install', { version } satisfies UpdateVersionInput),
  /** D55: hide the banner of `version`. */
  dismissUpdate: (version: string) => request<UpdateStatus>('POST', '/api/updates/dismiss', { version } satisfies UpdateVersionInput),
  /** D33: reopen a closed session (no process starts). */
  reopenSession: (id: string) => request<Session>('POST', `/api/sessions/${enc(id)}/reopen`),
  resumeSession: (id: string) => request<Session>('POST', `/api/sessions/${enc(id)}/resume`),
  detachSession: (id: string) => request<ResumeCommand>('POST', `/api/sessions/${enc(id)}/detach`),
  /** M4.1: a warning answers 409 `attach-warning` (`AttachWarning` body) until called again with `confirm`. */
  attachSession: (id: string, confirm = false) =>
    request<ResumeCommand>('POST', `/api/sessions/${enc(id)}/attach`, confirm ? ({ confirm: true } satisfies AttachRequest) : undefined),
  sessionEvents: (id: string, since?: string) => request<SessionEvent[]>('GET', `/api/sessions/${enc(id)}/events${query({ since })}`),
  /** D51: a Workflow agent's conversation (from its transcript). */
  workflowAgentChat: (id: string, agentId: string) => request<WorkflowAgentChat>('GET', `/api/sessions/${enc(id)}/workflow-agents/${enc(agentId)}/chat`),
  sessionDiff: (id: string, file?: string) => request<FileDiff[]>('GET', `/api/sessions/${enc(id)}/diff${query({ file })}`),

  inbox: () => request<InboxItem[]>('GET', '/api/inbox'),
  answerBatch: (batchId: string, body: AnswerBatch) => request<null>('POST', `/api/questions/batch/${enc(batchId)}/answers`, body),
  /** D48 P4: a hooked session's Deny takes `{ message }`. */
  inboxAction: (id: string, action: string, body?: { readonly message: string }) => request<null>('POST', `/api/inbox/${enc(id)}/actions/${enc(action)}`, body),

  /** D14: one folder's solutions (`folder` = a saved folder's id or a session's folder path; the default folder when omitted). */
  solutions: (folder?: string) => request<SolutionGroup[]>('GET', `/api/solutions${query({ folder })}`),
  /** "Move … to worktree" (gap #2); D32: `{ sessionId, branch }` names a new branch after the ticket; D60: `{ sessionId, existingBranch }` uses an existing one. */
  isolate: (repo: string, body: IsolateRequest) => request<Worktree>('POST', `/api/solutions/${enc(repo)}/isolate`, body),
  /** D60: the repo's local and remote branches for the "Existing branch" picker; `fetch` runs `git fetch --all --prune` first. */
  repoBranches: (repo: string, sessionId: string, fetch: boolean) =>
    request<RepoBranches>('GET', `/api/solutions/${enc(repo)}/branches${query({ session: sessionId, fetch: fetch ? '1' : undefined })}`),

  schedules: () => request<Schedule[]>('GET', '/api/schedules'),
  createSchedule: (body: unknown) => request<Schedule>('POST', '/api/schedules', body),
  runSchedule: (id: string) => request<Schedule>('POST', `/api/schedules/${enc(id)}/run`),
  pauseSchedule: (id: string) => request<Schedule>('POST', `/api/schedules/${enc(id)}/pause`),
  resumeSchedule: (id: string) => request<Schedule>('POST', `/api/schedules/${enc(id)}/resume`),
  /** D52: 204; 409 `running` while a run is in progress; a peer's schedule (remote id) is deleted there. */
  deleteSchedule: (id: string) => request<void>('DELETE', `/api/schedules/${enc(id)}`),
  /** D52: the loops of terminal sessions Switchboard does not follow, this machine's and the paired machines' (last known). */
  terminalLoops: () => request<TerminalLoop[]>('GET', '/api/terminal-loops'),

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

  // D48, additive (docs/peers.md): Settings → Machines.
  machines: () => request<MachinesView>('GET', '/api/machines'),
  renameSelf: (name: string) => request<{ id: string; name: string }>('PUT', '/api/machines/self', { name }),
  setListener: (body: PeerListenerInput) => request<PeerListenerState>('PUT', '/api/machines/listener', body),
  /** "Allow a new peer": a one-time code for the other machine. */
  pairingCode: () => request<PairingCode>('POST', '/api/machines/pairing-code'),
  /** "Add machine": 201; 409 `pairing-refused` (wrong / expired / used code), 502 `peer-unreachable`, 422 `invalid`. */
  addMachine: (body: AddMachineInput) => request<Machine>('POST', '/api/machines', body),
  renameMachine: (id: string, name: string) => request<Machine>('PUT', `/api/machines/${enc(id)}`, { name }),
  removeMachine: (id: string) => request<null>('DELETE', `/api/machines/${enc(id)}`),
} as const;

/**
 * D48: a route on machine `machine` (`null` = this machine): the path as it is, or
 * through that machine's peer API (`/api/machines/{id}/api/…`); answers come back
 * namespaced (remote ids, `docs/peers.md` → *Proxy*).
 */
export function onMachine(machine: string | null, path: string): string {
  return machine ? `/api/machines/${enc(machine)}${path}` : path;
}

/** D48 (P3): the New-session form's calls on the chosen machine (`null` = this one). */
export function machineApi(machine: string | null) {
  return {
    savedFolders: () => request<Folder[]>('GET', onMachine(machine, '/api/folders')),
    models: () => request<ModelSettings>('GET', onMachine(machine, '/api/models')),
    solutions: (folder?: string) => request<SolutionGroup[]>('GET', onMachine(machine, `/api/solutions${query({ folder })}`)),
    branchingPreflight: (body: BranchingPreflightRequest) => request<BranchingPreflight>('POST', onMachine(machine, '/api/branching/preflight'), body),
    createSession: (body: NewSession | NewRepoSession | NewSimpleSession) => request<Session>('POST', onMachine(machine, '/api/sessions'), body),
    /** D57: a staged upload for the start's first message (its id goes in `attachments`), on that machine. */
    uploadAttachment: (body: AttachmentUpload) => request<Attachment>('POST', onMachine(machine, '/api/attachments'), body),
    // D48 P4: the machine's terminal sessions and its hooks.
    terminalSessions: () => request<TerminalSession[]>('GET', onMachine(machine, '/api/terminal-sessions')),
    /** 201 a new hooked session (200 one that existed); 404, 409 `already-in-switchboard`. */
    hookTerminal: (id: string) => request<Session>('POST', onMachine(machine, `/api/terminal-sessions/${enc(id)}/hook`)),
    hooks: () => request<HooksStatus>('GET', onMachine(machine, '/api/hooks')),
    installHooks: () => request<HooksStatus>('POST', onMachine(machine, '/api/hooks/install')),
    removeHooks: () => request<HooksStatus>('POST', onMachine(machine, '/api/hooks/remove')),
  } as const;
}

/** The client's type (for test doubles). */
export type Api = typeof api;
