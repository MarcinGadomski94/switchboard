import type { CliProviderId } from '../../core/cli-providers.ts';
import type { TakeoverPreview, TakeoverRun } from '../../core/takeover.ts';
import type { AccountProfile, AccountSettings } from '../../core/accounts.ts';
import type {
  AccountsOverview,
  NewProfileInput,
  CliMcpServerInput,
  CliMcpView,
  CliInfo,
  CliOverview,
  ProviderSwitchResult,
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
  FullEventAnswer,
  NewTodoInput,
  SessionTodoList,
  TodoGroup,
  TodoOrderInput,
  TodoFieldsInput,
  TodoPatchInput,
} from '../../core/api.ts';
import type { LoginServiceRequest, LoginServiceStatus } from '../../core/login-service.ts';
import type { UpdateStatus, UpdateVersionInput } from '../../core/updates.ts';
import type { McpActionResult, McpAuthState, McpServerDefinition, McpServerInput, McpView } from '../../core/mcp.ts';
import type { Device, DeviceAccessInput, DeviceAccessState, DevicePairingCode, DevicePushInput, DeviceSelfView, DevicesView } from '../../core/devices.ts';
import type { AddMachineInput, Machine, MachinesView, PairingCode, PeerListenerInput, PeerListenerState, ReconnectResult } from '../../core/peers.ts';

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

/**
 * D73: `true` when the page runs on the devices' origin (a paired phone or tablet,
 * through `tailscale serve`), not on this machine's own UI, which is always
 * `http://127.0.0.1:<port>` (a `localhost` page load is redirected there).
 */
export function onDeviceOrigin(): boolean {
  const where = pageLocation();
  return where !== null && where.hostname !== '127.0.0.1';
}

/** The page's location (`null` outside a browser: tests of this module run in Node). */
function pageLocation(): { readonly hostname: string; replace(url: string): void } | null {
  return (globalThis as { location?: { readonly hostname: string; replace(url: string): void } }).location ?? null;
}

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
  // D73: a paired device whose credential was revoked (or expired) goes back to the pairing page.
  if (response.status === 401 && onDeviceOrigin()) pageLocation()?.replace('/pair');
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
  /** D68, additive: the session's todo list (`docs/todos.md`); every write answers the whole list. A peer's session id is forwarded. */
  sessionTodos: (id: string) => request<SessionTodoList>('GET', `/api/sessions/${enc(id)}/todos`),
  // D69: title, description, plan; `text` (= title) too, so a paired machine still on 1.7.0 adds the item (without the notes).
  addTodo: (id: string, fields: TodoFieldsInput) =>
    request<SessionTodoList>('POST', `/api/sessions/${enc(id)}/todos`, {
      title: fields.title,
      text: fields.title,
      description: fields.description,
      plan: fields.plan,
      // D70: an older peer ignores them (its item is medium, not estimated).
      priority: fields.priority,
      estimateMinutes: fields.estimateMinutes,
    } satisfies NewTodoInput),
  updateTodo: (id: string, todoId: string, patch: TodoPatchInput) =>
    request<SessionTodoList>('PUT', `/api/sessions/${enc(id)}/todos/${enc(todoId)}`, patch.title === undefined ? patch : { ...patch, text: patch.title }),
  deleteTodo: (id: string, todoId: string) => request<SessionTodoList>('DELETE', `/api/sessions/${enc(id)}/todos/${enc(todoId)}`),
  clearDoneTodos: (id: string) => request<SessionTodoList>('POST', `/api/sessions/${enc(id)}/todos/clear-done`),
  reorderTodos: (id: string, ids: readonly string[]) => request<SessionTodoList>('PUT', `/api/sessions/${enc(id)}/todos/order`, { ids } satisfies TodoOrderInput),
  /** D68: every open session's items, grouped (this machine's, then the paired machines' as last known). */
  todos: () => request<TodoGroup[]>('GET', '/api/todos'),
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
  /** D72: Continue in Switchboard of a hooked terminal session; 409 `terminal-running` until called with the stop confirmed. */
  continueHookedSession: (id: string, confirmStopTerminal = false) =>
    request<Session>('POST', `/api/sessions/${enc(id)}/continue-in-switchboard`, confirmStopTerminal ? { confirmStopTerminal: true } : {}),
  /** D72: Resend of a message marked not sent (its terminal ended before taking it up). */
  resendMessage: (id: string, eventId: number) => request<void>('POST', `/api/sessions/${enc(id)}/events/${eventId}/resend`, {}),
  resumeSession: (id: string) => request<Session>('POST', `/api/sessions/${enc(id)}/resume`),
  detachSession: (id: string) => request<ResumeCommand>('POST', `/api/sessions/${enc(id)}/detach`),
  /** M4.1: a warning answers 409 `attach-warning` (`AttachWarning` body) until called again with `confirm`. */
  attachSession: (id: string, confirm = false) =>
    request<ResumeCommand>('POST', `/api/sessions/${enc(id)}/attach`, confirm ? ({ confirm: true } satisfies AttachRequest) : undefined),
  sessionEvents: (id: string, since?: string) => request<SessionEvent[]>('GET', `/api/sessions/${enc(id)}/events${query({ since })}`),
  /** Fix · long messages: a cut event's whole text from the session's CLI transcript (message text is written back). */
  fullEvent: (id: string, eventId: number) => request<FullEventAnswer>('GET', `/api/sessions/${enc(id)}/events/${eventId}/full`),
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
  /** D62 P7: `cli` adds the Codex / OpenCode terminal conversations. */
  history: (q?: string, cli = false) => request<HistoryItem[]>('GET', `/api/history${query({ q, cli: cli ? '1' : undefined })}`),
  /** D16, additive: a terminal conversation continues in Switchboard as the same conversation (201 Session; 409 `ContinueRefusal`s, docs/derivations.md → History). */
  continueConversation: (claudeSessionId: string, body: ContinueConversation = {}) => {
    // D62 P7: a Codex / OpenCode row's id is `<cli>:<its own id>` and moves through its own route.
    const cli = /^(codex|opencode):(.+)$/.exec(claudeSessionId);
    return cli
      ? request<Session>('POST', `/api/history/cli/${enc(cli[1] as string)}/${enc(cli[2] as string)}/continue`, body)
      : request<Session>('POST', `/api/history/${enc(claudeSessionId)}/continue`, body);
  },

  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (body: Settings) => request<Settings>('PUT', '/api/settings', body),
  /** D42, additive: the latest reported model list and the last model choice (the New-session form's Model row). D62: of a CLI. */
  models: (provider?: CliProviderId) => request<ModelSettings>('GET', `/api/models${query({ provider })}`),
  /** D62, additive: the CLIs (Settings → CLIs, the forms' CLI row, the sidebar's switcher); `refresh` checks them again. */
  clis: (refresh = false) => request<CliOverview>('GET', `/api/clis${refresh ? '?refresh=1' : ''}`),
  /** D62: the CLI new sessions start on (422 for one that cannot be chosen). */
  setDefaultCli: (provider: CliProviderId) => request<CliOverview>('PUT', '/api/clis/default', { provider }),
  /** D62: a Codex / OpenCode command override (`null` = the environment's). */
  setCliCommand: (provider: CliProviderId, command: readonly string[] | null) => request<CliInfo>('PUT', `/api/clis/${enc(provider)}/command`, { command }),
  /** D62: checks a CLI again (version, sign-in, models). */
  checkCli: (provider: CliProviderId) => request<CliInfo>('POST', `/api/clis/${enc(provider)}/check`),
  /** D62 P5: switches a session to another CLI with a handover (202 once it started; progress on `sessionUpdated`). */
  switchProvider: (id: string, provider: CliProviderId) => request<ProviderSwitchResult>('POST', `/api/sessions/${enc(id)}/provider`, { provider }),

  /** D63 P5: moves a session to another account profile of its CLI (answers when the switch is over). */
  switchAccount: (id: string, profileId: string) => request<Session>('POST', `/api/sessions/${enc(id)}/account`, { profileId }),
  /** D63: pins a session to its account (automatic switching leaves it) or unpins it. */
  pinProfile: (id: string, pinned: boolean) => request<Session>('PUT', `/api/sessions/${enc(id)}/profile-pin`, { pinned }),

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
   * 201 added / 200 already saved; 422 `{ error: "invalid", message, check }` for anything but an existing folder (D59: a plain folder is saved too).
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
  /** D65: what a take-over would do (both machines' view), before anything changes. */
  takeoverPreview: (body: { readonly sessionId: string; readonly targetMachine: string | null; readonly clonePaths?: Readonly<Record<string, string>> }) =>
    request<TakeoverPreview>('POST', '/api/takeover/preview', body),
  /** D65: starts the take-over (202; poll {@link takeoverRun}). */
  takeoverStart: (body: { readonly sessionId: string; readonly targetMachine: string | null; readonly clonePaths?: Readonly<Record<string, string>>; readonly confirmStopTerminal?: boolean }) =>
    request<TakeoverRun>('POST', '/api/takeover', body),
  takeoverRun: (id: string) => request<TakeoverRun>('GET', `/api/takeover/runs/${enc(id)}`),
  /** D65: the one-click delete of a temporary branch left on a remote; `machineId` = the machine that pushed it (`null` = this one). */
  takeoverDeleteLeftover: (machineId: string | null, leftoverId: string) =>
    request<{ readonly deleted: boolean }>('POST', machineId ? `/api/machines/${enc(machineId)}/api/takeover/leftovers/${enc(leftoverId)}/delete` : `/api/takeover/leftovers/${enc(leftoverId)}/delete`),
  renameSelf: (name: string) => request<{ id: string; name: string }>('PUT', '/api/machines/self', { name }),
  setListener: (body: PeerListenerInput) => request<PeerListenerState>('PUT', '/api/machines/listener', body),
  /** "Allow a new peer": a one-time code for the other machine. */
  pairingCode: () => request<PairingCode>('POST', '/api/machines/pairing-code'),
  /** "Add machine": 201; 409 `pairing-refused` (wrong / expired / used code), 502 `peer-unreachable`, 422 `invalid`. */
  addMachine: (body: AddMachineInput) => request<Machine>('POST', '/api/machines', body),
  renameMachine: (id: string, name: string) => request<Machine>('PUT', `/api/machines/${enc(id)}`, { name }),
  removeMachine: (id: string) => request<null>('DELETE', `/api/machines/${enc(id)}`),
  /** D71: the sidebar layout shared with machine `id`, on / off (turning it on merges both layouts). */
  setMachineSidebarSync: (id: string, enabled: boolean) => request<Machine>('PUT', `/api/machines/${enc(id)}/sidebar-sync`, { enabled }),
  /** Fix · peer reconnects: Reconnect now (cuts the wait, tries at once; answers when the attempt is over). */
  reconnectMachine: (id: string) => request<ReconnectResult>('POST', `/api/machines/${enc(id)}/reconnect`),

  // D73, additive (docs/devices.md): Settings → Devices (this machine's UI only) and the device's own settings.
  devices: () => request<DevicesView>('GET', '/api/devices'),
  setDeviceAccess: (body: DeviceAccessInput) => request<DeviceAccessState>('PUT', '/api/devices/access', body),
  /** "Pair a device": a one-time code and the URL its QR code carries; 409 `access-off`. */
  devicePairingCode: () => request<DevicePairingCode>('POST', '/api/devices/pairing'),
  cancelDevicePairing: () => request<null>('DELETE', '/api/devices/pairing'),
  renameDevice: (id: string, name: string) => request<Device>('PUT', `/api/devices/${enc(id)}`, { name }),
  /** Revoke: the device loses access at once. */
  revokeDevice: (id: string) => request<null>('DELETE', `/api/devices/${enc(id)}`),
  /** Who is asking: the paired device (or `null` on this machine), the VAPID key, the push toggles. */
  deviceSelf: () => request<DeviceSelfView>('GET', '/api/device'),
  renameThisDevice: (name: string) => request<Device>('PUT', '/api/device', { name }),
  saveDevicePush: (body: DevicePushInput) => request<DeviceSelfView>('PUT', '/api/device/push', body),
  deleteDevicePush: () => request<DeviceSelfView>('DELETE', '/api/device/push'),
  testDevicePush: () => request<{ readonly ok: boolean; readonly error?: string }>('POST', '/api/device/push/test'),
} as const;

/**
 * D48: a route on machine `machine` (`null` = this machine): the path as it is, or
 * through that machine's peer API (`/api/machines/{id}/api/…`); answers come back
 * namespaced (remote ids, `docs/peers.md` → *Proxy*).
 */
export function onMachine(machine: string | null, path: string): string {
  return machine ? `/api/machines/${enc(machine)}${path}` : path;
}

/** D63 (`docs/accounts.md`): Settings → Accounts' calls on a machine (`null` = this one; a paired machine's go through its peer API). */
export function accountsApi(machine: string | null) {
  const at = (path: string): string => onMachine(machine, path);
  return {
    overview: (refresh = false) => request<AccountsOverview>('GET', at(`/api/accounts${refresh ? '?refresh=1' : ''}`)),
    saveSettings: (body: Partial<AccountSettings> | Record<string, unknown>) => request<AccountSettings>('PUT', at('/api/accounts/settings'), body),
    createProfile: (body: NewProfileInput) => request<AccountProfile>('POST', at('/api/accounts/profiles'), body),
    updateProfile: (id: string, body: { name?: string; enabled?: boolean; shareSettings?: boolean }) => request<AccountProfile>('PUT', at(`/api/accounts/profiles/${enc(id)}`), body),
    deleteProfile: (id: string, removeFiles = false) => request<null>('DELETE', at(`/api/accounts/profiles/${enc(id)}${removeFiles ? '?removeFiles=1' : ''}`)),
    order: (cli: CliProviderId, order: readonly string[]) => request<AccountsOverview>('PUT', at('/api/accounts/order'), { cli, order }),
    check: (id: string) => request<AccountProfile>('POST', at(`/api/accounts/profiles/${enc(id)}/check`)),
    syncSettings: (id: string) => request<{ shared: string[]; mcp: string }>('POST', at(`/api/accounts/profiles/${enc(id)}/sync-settings`)),
    signIn: (id: string, body: { email?: string; deviceCode?: boolean; provider?: string; apiKey?: string } = {}) => request<AccountSignIn>('POST', at(`/api/accounts/profiles/${enc(id)}/signin`), body),
    signInState: (id: string) => request<AccountSignIn>('GET', at(`/api/accounts/signin/${enc(id)}`)),
    pasteBack: (id: string, value: string) => request<AccountSignIn>('POST', at(`/api/accounts/signin/${enc(id)}/paste`), { value }),
    cancelSignIn: (id: string) => request<AccountSignIn>('DELETE', at(`/api/accounts/signin/${enc(id)}`)),
    signOut: (id: string) => request<{ ok: boolean; message: string; profile?: AccountProfile }>('POST', at(`/api/accounts/profiles/${enc(id)}/signout`)),
  };
}

/** D48 (P3): the New-session form's calls on the chosen machine (`null` = this one). */
export function machineApi(machine: string | null) {
  return {
    savedFolders: () => request<Folder[]>('GET', onMachine(machine, '/api/folders')),
    models: (provider?: CliProviderId) => request<ModelSettings>('GET', onMachine(machine, `/api/models${query({ provider })}`)),
    /** D63: that machine's account profiles (the forms' Account row). */
    accounts: () => request<AccountsOverview>('GET', onMachine(machine, '/api/accounts')),
    /** D62: that machine's CLIs (the forms' CLI row for a start there). */
    clis: () => request<CliOverview>('GET', onMachine(machine, '/api/clis')),
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

/**
 * D61: the MCP servers page's calls for one folder (`folder` = a saved folder's id)
 * on machine `machine` (`null` = this one; a paired machine's go through its peer
 * API, `docs/mcp.md` → *Peers*).
 */
export function mcpApi(machine: string | null, folder: string | undefined) {
  const at = (path: string, extra: Readonly<Record<string, string | undefined>> = {}): string => onMachine(machine, `${path}${query({ folder, ...extra })}`);
  return {
    view: () => request<McpView>('GET', at('/api/mcp')),
    check: (name?: string) => request<McpActionResult>('POST', at('/api/mcp/check'), name ? { name } : {}),
    definition: (name: string, scope: string) => request<McpServerDefinition>('GET', at(`/api/mcp/servers/${enc(name)}`, { scope })),
    add: (input: McpServerInput) => request<McpActionResult>('POST', at('/api/mcp/servers'), input),
    edit: (name: string, scope: string, input: McpServerInput) => request<McpActionResult>('PUT', at(`/api/mcp/servers/${enc(name)}`, { scope }), input),
    remove: (name: string, scope: string) => request<McpActionResult>('DELETE', at(`/api/mcp/servers/${enc(name)}`, { scope })),
    reconnect: (name: string) => request<McpActionResult>('POST', at(`/api/mcp/servers/${enc(name)}/reconnect`)),
    toggle: (name: string, enabled: boolean) => request<McpActionResult>('POST', at(`/api/mcp/servers/${enc(name)}/toggle`), { enabled }),
    startAuth: (name: string, reset: boolean) => request<McpAuthState>('POST', at(`/api/mcp/servers/${enc(name)}/auth`), { reset }),
    authState: (id: string) => request<McpAuthState>('GET', onMachine(machine, `/api/mcp/auth/${enc(id)}`)),
    submitCallback: (id: string, callbackUrl: string) => request<McpAuthState>('POST', onMachine(machine, `/api/mcp/auth/${enc(id)}/callback`), { callbackUrl }),
    cancelAuth: (id: string) => request<McpAuthState>('DELETE', onMachine(machine, `/api/mcp/auth/${enc(id)}`)),
    // D62 P7: Codex CLI's / OpenCode's servers through their own CLIs.
    cliView: (provider: CliProviderId) => request<CliMcpView>('GET', at(`/api/mcp/cli/${enc(provider)}`)),
    cliAdd: (provider: CliProviderId, input: CliMcpServerInput) => request<CliMcpView>('POST', at(`/api/mcp/cli/${enc(provider)}/servers`), input),
    cliRemove: (provider: CliProviderId, name: string) => request<CliMcpView>('DELETE', at(`/api/mcp/cli/${enc(provider)}/servers/${enc(name)}`)),
  };
}

/** D63: one sign-in as the server answers it (`src/server/accounts/signin.ts`). */
export interface AccountSignIn {
  readonly id: string;
  readonly profileId: string;
  readonly cli: CliProviderId;
  readonly state: 'starting' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'timeout';
  readonly url: string | null;
  readonly code: string | null;
  readonly instructions: string | null;
  readonly error: string | null;
  readonly command: string;
  readonly canPasteBack: boolean;
  readonly startedAt: string;
  readonly expiresAt: string;
}
