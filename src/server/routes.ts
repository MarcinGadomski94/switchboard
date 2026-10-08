import type { CliStatusService } from './cli/status.ts';
import { registerCliRoutes } from './api/clis.ts';
import { registerAccountRoutes } from './api/accounts.ts';
import type { AccountService } from './accounts/service.ts';
import type { SignInManager } from './accounts/signin.ts';
import type { FastifyInstance } from 'fastify';
import { registerArtifactRoutes } from './api/artifacts.ts';
import { registerAttachmentRoutes } from './api/attachments.ts';
import type { AttachmentService } from './attachments/service.ts';
import { registerBranchingRoutes } from './api/branching.ts';
import { registerFolderRoutes } from './api/folders.ts';
import { registerFrameHelperRoutes } from './api/frame-helper.ts';
import { registerHistoryRoutes } from './api/history.ts';
import { registerHubRoutes } from './api/hub.ts';
import { registerHookRoutes } from './api/hooks.ts';
import { registerInboxRoutes } from './api/inbox.ts';
import { registerMachineRoutes } from './api/machines.ts';
import { registerMcpRoutes } from './api/mcp.ts';
import { registerScheduleRoutes } from './api/schedules.ts';
import { registerServiceRoutes } from './api/service.ts';
import { registerSessionRoutes } from './api/sessions.ts';
import { registerSettingsRoutes } from './api/settings.ts';
import { registerSetupRoutes } from './api/setup.ts';
import { registerSidebarRoutes } from './api/sidebar.ts';
import { registerSolutionRoutes } from './api/solutions.ts';
import { registerSystemRoutes } from './api/system.ts';
import { registerTakeoverRoutes } from './api/takeover.ts';
import { registerToolRoutes } from './api/tools.ts';
import { registerUpdateRoutes } from './api/updates.ts';
import type { ServerConfig } from './config.ts';
import type { Store } from './db/store.ts';
import type { FolderService } from './folders/service.ts';
import type { HubBus } from './hub/bus.ts';
import type { SseHub } from './hub/hub.ts';
import type { QuestionPipeline } from './inbox/pipeline.ts';
import type { SystemItemService } from './inbox/system-items.ts';
import type { HookService } from './hooks/service.ts';
import type { McpService } from './mcp/service.ts';
import type { PeerService } from './peers/service.ts';
import type { Providers } from './providers.ts';
import type { Scheduler } from './schedules/scheduler.ts';
import type { SetupService } from './setup/service.ts';
import type { SessionSupervisor } from './supervisor/supervisor.ts';
import type { TakeoverRunner } from './takeover/runner.ts';
import type { TakeoverService } from './takeover/service.ts';
import type { WorktreeManager } from './worktrees/manager.ts';
import type { TodoService } from './todos/service.ts';
import { registerTodoRoutes } from './api/todos.ts';
import { registerDeviceRoutes } from './api/devices.ts';
import type { DeviceService } from './devices/service.ts';
import type { ReviewService } from './reviews/service.ts';
import { registerReviewRoutes } from './api/reviews.ts';

/** What API route modules receive when they register. Later items add their services here. */
export interface ApiContext {
  readonly config: ServerConfig;
  /** D63: the account profiles of each CLI and the rules (docs/accounts.md). */
  readonly accounts: AccountService;
  /** D63: signing profiles in and out. */
  readonly signIn: SignInManager;
  /** D62: the CLIs sessions run on: status, default, command overrides (docs/providers.md). */
  readonly clis: CliStatusService;
  /** The database repositories (db/store.ts, docs/database.md). */
  readonly store: Store;
  /** Computed data sources (providers.ts); demo implementations when SWITCHBOARD_DEMO=1. */
  readonly providers: Providers;
  /** The claude process supervisor (M2.1). */
  readonly supervisor: SessionSupervisor;
  /** Git worktrees, their PR state and the session diff (M2.2). */
  readonly worktrees: WorktreeManager;
  /** The in-process event bus: services publish the contract's `/hub` events here (M2.3, docs/hub.md). */
  readonly bus: HubBus;
  /** The `/hub` SSE fan-out over {@link bus} (M2.3). */
  readonly hub: SseHub;
  /** Question batches and permission items: the supervisor's control-request handler (M3.1, docs/questions.md). */
  readonly questions: QuestionPipeline;
  /** System Inbox items: failed scheduled runs, removable worktrees, and their actions (M3.3, docs/system-items.md). */
  readonly systemItems: SystemItemService;
  /** First-run setup: wizard state, Browse…'s folder listing (M5.3, docs/setup.md). */
  readonly setup: SetupService;
  /** Saved folders (D14, docs/folders.md): which folder a session, a scan or a schedule works in. */
  readonly folders: FolderService;
  /** Schedules: cron runs from templates, Run now, Pause/Resume (M7.1, docs/schedules.md). */
  readonly scheduler: Scheduler;
  /** Paired machines, the peer listener and the proxy to peers (D48, docs/peers.md). */
  readonly peers: PeerService;
  /** Hand-started terminal sessions: hooks, the hook endpoints, hooked sessions (D48 P4, docs/peers.md). */
  readonly hooks: HookService;
  /** Chat attachments: uploads, storage, serving, a message's inline blocks and paths (D57, docs/chat.md → Attachments). */
  readonly attachments: AttachmentService;
  /** D61: the MCP servers page: list, check, reconnect, sign in, enable / disable, add / edit / remove (docs/mcp.md). */
  readonly mcp: McpService;
  /** D65: this machine's side of taking a session over to / from a paired machine (docs/peers.md). */
  readonly takeover: TakeoverService;
  /** D65: the initiating machine's runner (preview, start, progress). */
  readonly takeoverRunner: TakeoverRunner;
  /** D68: the sessions' todo lists (the UI's routes and the agent's, docs/todos.md). */
  readonly todos: TodoService;
  /** D73: paired devices, the device listener and web push (docs/devices.md). */
  readonly devices: DeviceService;
  /** D79: the review cards (docs/reviews.md). */
  readonly reviews: ReviewService;
}

/**
 * Registry of the REST routes (`/api/*`, contracts/local-api.md) and the `/hub`
 * SSE endpoint. Each API area registers from its own module in `api/` with one
 * line here (`docs/lanes.md` has the ownership map). Every contract route exists
 * from M1.4 on and answers 501 until its item implements it. The security guard
 * (security.ts) already covers every route registered here: none of them may be
 * marked `config.public`, except D73's device-listener pairing page and exchange
 * (`/pair`, `/device/v1/pair`), which answer 404 anywhere but the device listener.
 */
export async function registerApiRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  await registerSessionRoutes(app, context);
  await registerAttachmentRoutes(app, context);
  await registerInboxRoutes(app, context);
  await registerSolutionRoutes(app, context);
  await registerScheduleRoutes(app, context);
  await registerArtifactRoutes(app, context);
  await registerHistoryRoutes(app, context);
  await registerSettingsRoutes(app, context);
  await registerCliRoutes(app, context);
  await registerAccountRoutes(app, context);
  await registerToolRoutes(app, context);
  await registerFrameHelperRoutes(app, context);
  await registerSystemRoutes(app, context);
  await registerServiceRoutes(app, context);
  await registerSetupRoutes(app, context);
  await registerFolderRoutes(app, context);
  await registerBranchingRoutes(app, context);
  await registerMachineRoutes(app, context);
  await registerTakeoverRoutes(app, context);
  await registerHookRoutes(app, context);
  await registerSidebarRoutes(app, context);
  await registerTodoRoutes(app, context);
  await registerReviewRoutes(app, context);
  await registerUpdateRoutes(app, context);
  await registerMcpRoutes(app, context);
  await registerDeviceRoutes(app, context);
  await registerHubRoutes(app, context);
}
