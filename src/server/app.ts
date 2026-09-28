import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.ts';
import type { Store } from './db/store.ts';
import { FolderService } from './folders/service.ts';
import { HubBus } from './hub/bus.ts';
import { type HubTimingOptions, SseHub } from './hub/hub.ts';
import { forwardServiceEvents } from './hub/wire.ts';
import { QuestionPipeline } from './inbox/pipeline.ts';
import { SystemItemService } from './inbox/system-items.ts';
import { LoopTracker } from './loops/tracker.ts';
import type { Providers } from './providers.ts';
import { registerApiRoutes } from './routes.ts';
import { Scheduler, scheduleRunnerFor } from './schedules/scheduler.ts';
import { registerSecurity } from './security.ts';
import { claudeAgentsLister } from './supervisor/recovery.ts';
import { SetupService } from './setup/service.ts';
import { type ControlRequestHandler, SessionSupervisor } from './supervisor/supervisor.ts';
import type { UsageMeter } from './usage/meter.ts';
import { registerWeb } from './web.ts';
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
  registerSecurity(app, { port: options.config.port, token: options.token });
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
    const own = new SystemItemService({ store: options.store, bus, worktrees });
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
  let scheduler = options.scheduler;
  if (!scheduler) {
    const own = new Scheduler({ store: options.store, sessions: { store: options.store, providers, supervisor, worktrees, folders }, updates: supervisor, bus, systemItems });
    app.addHook('onClose', async () => {
      await own.close();
    });
    // "Retry run" of the system items the app made itself (a caller's service gets its runner from the caller).
    if (!options.systemItems) systemItems.useScheduleRunner(scheduleRunnerFor(own));
    scheduler = own;
  }
  await registerApiRoutes(app, { config, store: options.store, providers, supervisor, worktrees, bus, hub, questions, systemItems, setup, folders, scheduler });
  await registerWeb(app, { webRoot: options.webRoot, token: options.token });
  return app;
}

/** A supervisor for the configured CLI command and extra args (D14: each session brings its own folder). */
export function createSupervisor(config: ServerConfig, store: Store, controlHandler?: ControlRequestHandler): SessionSupervisor {
  return new SessionSupervisor({
    store,
    claudeCommand: config.claudeCommand,
    claudeExtraArgs: config.claudeExtraArgs,
    // M4.1: the "Attach here" warning asks `claude agents --json` (in the session's cwd) whether a terminal holds the session.
    listLive: claudeAgentsLister({ claudeCommand: config.claudeCommand }),
    ...(controlHandler ? { controlHandler } : {}),
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
