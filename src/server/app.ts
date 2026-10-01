import { CliRegistry } from './cli/registry.ts';
import { CliStatusService, envCommandFlags } from './cli/status.ts';
import { cliAdapters, cliModelListers } from './cli/adapters.ts';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.ts';
import type { Store } from './db/store.ts';
import { FolderService } from './folders/service.ts';
import { HubBus } from './hub/bus.ts';
import { type HubTimingOptions, SseHub } from './hub/hub.ts';
import { forwardServiceEvents } from './hub/wire.ts';
import { QuestionPipeline, type QuestionSessions } from './inbox/pipeline.ts';
import { SystemItemService } from './inbox/system-items.ts';
import { LoopTracker } from './loops/tracker.ts';
import { registerPeerForwarding } from './api/machines.ts';
import { AttachmentService } from './attachments/service.ts';
import { PeerService } from './peers/service.ts';
import { HookService } from './hooks/service.ts';
import { McpService } from './mcp/service.ts';
import { HOOK_TOKEN_FILE, loadOrCreateToken } from './token.ts';
import path from 'node:path';
import type { Providers } from './providers.ts';
import { registerApiRoutes } from './routes.ts';
import { Scheduler, scheduleRunnerFor } from './schedules/scheduler.ts';
import { registerSecurity } from './security.ts';
import { claudeAgentsLister } from './supervisor/recovery.ts';
import { SetupService } from './setup/service.ts';
import { type ControlRequestHandler, SessionSupervisor } from './supervisor/supervisor.ts';
import type { UsageMeter } from './usage/meter.ts';
import { registerWeb } from './web.ts';
import { WorktreeAdoption } from './worktrees/adopt.ts';
import { WorktreeManager } from './worktrees/manager.ts';

/** Options for {@link buildApp}. */
export interface AppOptions {
  readonly config: ServerConfig;
  /** The per-install token (token.ts). */
  readonly token: string;
  /** The opened database (db/store.ts); the caller owns it and closes it after the app. */
  readonly store: Store;
  /** Absolute path of the built UI, normally `<repo>/dist/web`. */
  readonly webRoot: string;
  /** Computed data sources (providers.ts); none by default. */
  readonly providers?: Providers;
  /**
   * The claude process supervisor (M2.1). The caller owns one it passes in (and
   * shuts it down before closing the store); without one the app makes its own from
   * `config` and shuts it down when it closes.
   */
  readonly supervisor?: SessionSupervisor;
  /**
   * The worktree manager (M2.2). Without one the app makes its own from `config`
   * (git from PATH, `SWITCHBOARD_GH_BIN`) around the supervisor; it does not poll.
   */
  readonly worktrees?: WorktreeManager;
  /**
   * The `/hub` event bus (M2.3). The caller passes one when services it creates
   * publish to it; without one the app makes its own. Either way the app forwards
   * the supervisor's and the worktree manager's notifications to it.
   */
  readonly bus?: HubBus;
  /**
   * The question pipeline (M3.1). A caller that passes its own supervisor passes the
   * pipeline that supervisor was built with (`createSessionServices`); without one
   * the app makes its own, which answers stored batches and items through the
   * supervisor but only hears about new requests when it is the supervisor's handler.
   */
  readonly questions?: QuestionPipeline;
  /**
   * System Inbox items (M3.3). A caller that passes one owns it (main.ts starts its
   * sync and closes it); without one the app makes its own around the worktree
   * manager and the bus (no background sync) and closes it with the app.
   */
  readonly systemItems?: SystemItemService;
  /**
   * The saved folders (D14, docs/folders.md). main.ts passes the one it opened;
   * without one the app opens its own over the store.
   */
  readonly folders?: FolderService;
  /**
   * First-run setup (M5.3, docs/setup.md). Without one the app makes its own over
   * the store and the folders.
   */
  readonly setup?: SetupService;
  /**
   * The scheduler (M7.1, docs/schedules.md). A caller that passes one owns it
   * (main.ts starts its timer, plugs it into its system items and closes it);
   * without one the app makes its own (no timer: Run now / Pause / Resume / Save
   * only) and closes it with the app.
   */
  readonly scheduler?: Scheduler;
  /** `/hub` timings (keepalive, `system` interval); tests shorten them (docs/hub.md). */
  readonly hub?: HubTimingOptions;
  /**
   * The Max usage meter (M9.2, docs/usage.md). The caller owns it (main.ts starts
   * and stops it); the app tells it how many `/hub` clients are connected, since it
   * reads usage only while someone sees the meter.
   */
  readonly usage?: UsageMeter;
  /**
   * Paired machines and the peer listener (D48, `docs/peers.md`). A caller that
   * passes one owns it (main.ts starts it once the UI port is ours and closes it);
   * without one the app makes its own, which is never started (no listener, no
   * connections: the routes still answer) and closes with the app.
   */
  readonly peers?: PeerService;
  /**
   * Hooked terminal sessions (D48 P4). A caller that passes one owns it (main.ts
   * starts its polls and closes it) and passes its `hookToken`; without one the app
   * makes its own (no polls) with the hook token of `config.dataDir`.
   */
  readonly hooks?: HookService;
  /** D48 P4: the hook token `/hook/*` takes (with {@link hooks}). */
  readonly hookToken?: string;
  /** D57: chat attachments (default: one over `config.dataDir` and `store`). */
  readonly attachments?: AttachmentService;
  /** D61: the MCP servers page's service (default: one over `config`'s CLI command and `process.env`, closed with the app). */
  readonly mcp?: McpService;
  /** D62: the CLIs' status (default: one over the supervisor's registry). */
  readonly clis?: CliStatusService;
  /** Fastify logger; off by default (tests). */
  readonly logger?: boolean;
}

/**
 * Builds the Fastify app without listening: the security guard first, then the
 * API routes, then the UI. Tests drive it with `inject()`; main.ts listens
 * through `listenLoopback`.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: false });
  // D48 P4: the hook script presents this token to `/hook/*` (a file only the user can read).
  const hookToken = options.hookToken ?? (await loadOrCreateToken(options.config.dataDir, HOOK_TOKEN_FILE));
  registerSecurity(app, { port: options.config.port, token: options.token, hookToken });
  const bus = options.bus ?? new HubBus();
  let supervisor = options.supervisor;
  let questions = options.questions;
  if (!supervisor) {
    const own = createSessionServices(options.config, options.store, bus);
    app.addHook('onClose', async () => {
      await own.supervisor.shutdown();
    });
    supervisor = own.supervisor;
    questions = own.questions;
  }
  questions ??= new QuestionPipeline({ store: options.store, bus }).bind(supervisor);
  const worktrees = options.worktrees ?? createWorktreeManager(options.config, options.store, supervisor);
  let systemItems = options.systemItems;
  if (!systemItems) {
    const own = new SystemItemService({ store: options.store, bus, worktrees, sessions: supervisor });
    app.addHook('onClose', async () => {
      await own.close();
    });
    systemItems = own;
  }
  const providers = options.providers ?? {};
  const hub = new SseHub({ bus, ...(providers.system ? { system: providers.system } : {}), ...options.hub });
  options.usage?.watchViewers(() => hub.clientCount);
  const stopForwarding = forwardServiceEvents(bus, { supervisor, worktrees });
  // Loop cards (M7.2, D9): the `loops` rows follow the sessions' events. Stopped before
  // anything closes, so no refresh runs against a closed store; the sweep at start
  // re-derives the loops whose process the last stop ended.
  const loops = new LoopTracker({ store: options.store, events: supervisor, bus });
  const sweeping = loops.sweep().catch((error: unknown) => console.error('switchboard loops:', error));
  app.addHook('preClose', async () => {
    await sweeping;
    await loops.close();
  });
  // D38: worktrees a session's agent creates itself (`git worktree add`, or found at a turn's end) become the session's.
  const adoption = new WorktreeAdoption({ store: options.store, sessions: supervisor, worktrees });
  app.addHook('preClose', async () => {
    await adoption.close();
  });
  // Open streams would keep the server from closing: end them before it stops listening.
  app.addHook('preClose', async () => {
    hub.close();
  });
  app.addHook('onClose', async () => {
    stopForwarding();
  });
  // D14: no workspace root; every session, scan and schedule names its folder through this service.
  const folders = options.folders ?? (await FolderService.open({ store: options.store }));
  const setup = options.setup ?? new SetupService({ store: options.store, folders });
  const config = options.config;
  // D62: Settings → CLIs, the New-session forms' CLI row, the sidebar's switcher.
  const clis = options.clis ?? createCliStatus(config, options.store, supervisor.cliRegistry);
  let scheduler = options.scheduler;
  if (!scheduler) {
    const own = new Scheduler({ store: options.store, sessions: { store: options.store, providers, supervisor, worktrees, folders, clis }, updates: supervisor, bus, systemItems });
    app.addHook('onClose', async () => {
      await own.close();
    });
    // "Retry run" of the system items the app made itself (a caller's service gets its runner from the caller).
    if (!options.systemItems) systemItems.useScheduleRunner(scheduleRunnerFor(own));
    scheduler = own;
  }
  let peers = options.peers;
  if (!peers) {
    const own = new PeerService({ config, store: options.store, bus, token: options.token });
    app.addHook('onClose', async () => {
      await own.close();
    });
    peers = own;
  }
  peers.useApp(app);
  let hooks = options.hooks;
  if (!hooks) {
    const own = new HookService({ config, store: options.store, bus, questions, hookTokenFile: path.join(config.dataDir, HOOK_TOKEN_FILE) });
    app.addHook('onClose', async () => {
      await own.close();
    });
    hooks = own;
  }
  // D48 P4: answers and messages of a hooked session go through its hooks; everything else through the supervisor.
  questions.bind(sessionsWithHooks(supervisor, hooks));
  // D52: a hooked terminal session's loops are derived from its imported events, like a supervised session's.
  loops.listen(hooks);
  loops.useEventsOf((sessionId) => hooks.loopEvents(sessionId));
  // D48: a request that names a peer's id goes to that peer (before any route handler reads the local store).
  registerPeerForwarding(app, peers);
  // D57: attachments live in the data folder (`<dataDir>/attachments/<session>/`).
  const attachments = options.attachments ?? new AttachmentService({ dataDir: config.dataDir, store: options.store });
  // D61: its helper processes end with the app (a sign-in in progress is cancelled).
  let mcp = options.mcp;
  if (!mcp) {
    const own = new McpService({ claudeCommand: config.claudeCommand, extraArgs: config.claudeExtraArgs });
    app.addHook('onClose', async () => {
      await own.close();
    });
    mcp = own;
  }
  await registerApiRoutes(app, { config, store: options.store, providers, supervisor, worktrees, bus, hub, questions, systemItems, setup, folders, scheduler, peers, hooks, attachments, mcp, clis });
  await registerWeb(app, { webRoot: options.webRoot, token: options.token });
  return app;
}

/**
 * D62: the CLIs sessions run on: their commands (environment, Settings → CLIs
 * overrides in `store`) and adapters (`docs/providers.md`).
 */
export function createCliRegistry(config: ServerConfig, store: Store): CliRegistry {
  return new CliRegistry({
    commands: { claude: config.claudeCommand, codex: config.codexCommand, opencode: config.opencodeCommand },
    settings: store.settings,
    adapters: cliAdapters(),
  });
}

/** D62: Settings → CLIs' checks over the supervisor's registry. */
export function createCliStatus(config: ServerConfig, store: Store, registry: CliRegistry): CliStatusService {
  return new CliStatusService({
    registry,
    settings: store.settings,
    cwd: config.dataDir,
    envCommands: envCommandFlags({ claude: config.claudeCommand, codex: config.codexCommand, opencode: config.opencodeCommand }),
    listModels: cliModelListers(),
  });
}

/** A supervisor for the configured CLI command and extra args (D14: each session brings its own folder). */
export function createSupervisor(config: ServerConfig, store: Store, controlHandler?: ControlRequestHandler): SessionSupervisor {
  return new SessionSupervisor({
    store,
    providers: createCliRegistry(config, store),
    claudeCommand: config.claudeCommand,
    claudeExtraArgs: config.claudeExtraArgs,
    // M4.1: the "Attach here" warning asks `claude agents --json` (in the session's cwd) whether a terminal holds the session.
    listLive: claudeAgentsLister({ claudeCommand: config.claudeCommand }),
    ...(controlHandler ? { controlHandler } : {}),
    // D57: an imported terminal prompt's images are stored as the session's attachments.
    attachments: new AttachmentService({ dataDir: config.dataDir, store }),
  });
}

/**
 * The supervisor and the question pipeline joined (M3.1): the pipeline is the
 * supervisor's control-request handler and answers through it; its `/hub` events
 * go to `bus`.
 */
export function createSessionServices(config: ServerConfig, store: Store, bus: HubBus): { supervisor: SessionSupervisor; questions: QuestionPipeline } {
  const questions = new QuestionPipeline({ store, bus });
  const supervisor = createSupervisor(config, store, questions);
  questions.bind(supervisor);
  return { supervisor, questions };
}

/** A worktree manager for the configured gh command, isolating through `supervisor` (D14: solutions resolve in each session's folder). */
export function createWorktreeManager(config: ServerConfig, store: Store, supervisor: SessionSupervisor): WorktreeManager {
  return new WorktreeManager({
    store,
    ghCommand: config.ghCommand,
    sessions: supervisor,
  });
}

/**
 * D48 P4: what the question pipeline answers through: a hooked terminal session's
 * requests and stale answers go to its hooks (`HookService`), every other
 * session's to the supervisor.
 */
export function sessionsWithHooks(supervisor: SessionSupervisor, hooks: HookService): QuestionSessions {
  return {
    respond: async (sessionId, requestId, decision) =>
      (await hooks.isHooked(sessionId)) ? hooks.respond(sessionId, requestId, decision) : supervisor.respond(sessionId, requestId, decision),
    sendToLive: async (sessionId, text, origin) => ((await hooks.isHooked(sessionId)) ? hooks.sendToLive(sessionId, text) : supervisor.sendToLive(sessionId, text, origin)),
    activity: (sessionId) => supervisor.activity(sessionId),
  };
}
