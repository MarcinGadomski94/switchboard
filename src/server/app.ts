import { forgetGraduatedSwitches } from './settings/graduated.ts';
import { AccountService } from './accounts/service.ts';
import { SharedAccounts } from './accounts/shared.ts';
import { AutoSwitcher } from './accounts/auto-switch.ts';
import { AccountNeedsYou } from './accounts/needs-you.ts';
import { AccountChoice } from './accounts/choice.ts';
import { registerAccountChoiceSource } from './sessions/wire.ts';
import { SignInManager } from './accounts/signin.ts';
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
import { LoopService } from './loops/owned.ts';
import { NO_ATTACHMENTS } from './attachments/service.ts';
import { registerPeerForwarding } from './api/machines.ts';
import { AttachmentService } from './attachments/service.ts';
import { ArtifactService } from './artifacts/service.ts';
import { PeerService } from './peers/service.ts';
import { HookService } from './hooks/service.ts';
import { TakeoverRunner } from './takeover/runner.ts';
import { TakeoverService } from './takeover/service.ts';
import { McpService } from './mcp/service.ts';
import { agentTokenFor, agentTokenMatches } from './todos/agent-token.ts';
import { agentMcpLaunch, withClaudeConfigFile } from './todos/agent-mcp.ts';
import { HELPER_NODE_ARGS, helperScript } from './mcp/helper-bundle.ts';
import { registerAgentToolRoutes } from './todos/agent-tools.ts';
import { TodoService } from './todos/service.ts';
import { TodoReminder } from './todos/reminder.ts';
import { checkpointsEnabled, todoEnrichEnabled, todoReminderEnabled } from './settings/settings.ts';
import { CheckpointService } from './checkpoints/service.ts';
import { TodoEnricher } from './todos/enricher.ts';
import { FreshPlaces } from './sessions/fresh-place.ts';
import { RunPlaces } from './sessions/run-place.ts';
import { HOOK_TOKEN_FILE, loadOrCreateToken } from './token.ts';
import path from 'node:path';
import type { Providers } from './providers.ts';
import { type ApiContext, registerApiRoutes } from './routes.ts';
import { CleanupService } from './cleanup/service.ts';
import { ArchiveService } from './sessions/archive.ts';
import { TurnWaitingInbox } from './inbox/turn-waiting.ts';
// Team (D100) hook (docs/team-removal.md).
import { installTeam } from './team/install.ts';
import { withTeamAccessServers } from './team/hooks.ts';
import { SearchBackfill } from './search/backfill.ts';
import { SearchService } from './search/service.ts';
import { InsightsBackfill } from './insights/backfill.ts';
import { InsightsService } from './insights/service.ts';
import { UsageTurnsBackfill } from './insights/turns-backfill.ts';
import { UsageService } from './insights/usage.ts';
import { TutorialService, tutorialAutoOpen } from './tutorial/service.ts';
import { DraftService } from './drafts/service.ts';
import { appVersion } from './updates/wire.ts';
import { Scheduler, scheduleRunnerFor } from './schedules/scheduler.ts';
import { registerSecurity } from './security.ts';
import { claudeAgentsLister } from './supervisor/recovery.ts';
import { SetupService } from './setup/service.ts';
import { type ControlRequestHandler, SessionSupervisor } from './supervisor/supervisor.ts';
import type { UsageMeter } from './usage/meter.ts';
import { registerWeb } from './web.ts';
import { DeviceService } from './devices/service.ts';
import { WorktreeAdoption } from './worktrees/adopt.ts';
import { WorktreeManager } from './worktrees/manager.ts';
// Plans (D99) hook (docs/plans-removal.md).
import { installPlans, planServiceOf } from './plans/install.ts';
import type { PlanService } from './plans/service.ts';
// Project memory (D107) hook (docs/memory-removal.md).
import { installMemory } from './memory/install.ts';
import { CiGh } from './ci/gh.ts';
import { PrWatcher, ciPollMs } from './ci/watcher.ts';
import { ProcessService } from './processes/service.ts';
import { processSessions, withTrackedProcesses } from './processes/wire.ts';
import { platformScanner } from './processes/scan.ts';

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
  /** D68: the sessions' todo lists (default: one over the store and the bus, started when the app is ready, closed with it). */
  readonly todos?: TodoService;
  /**
   * D68: give every session the app's supervisor starts the built-in `switchboard`
   * MCP server (its todo tools). Default `true`; tests of the CLIs' argv turn it off.
   */
  readonly agentTools?: boolean;
  /**
   * D73: paired devices, the device listener and web push (`docs/devices.md`). A
   * caller that passes one owns it (main.ts starts it once the UI port is ours and
   * closes it); without one the app makes its own, which is never started (no
   * device listener, no push: the routes still answer) and closes with the app.
   */
  readonly devices?: DeviceService;
  /**
   * D85: the tutorial's state (`docs/tutorial.md`). Without one the app makes its own
   * over the store (this checkout's version; opens by itself unless demo mode or
   * `SWITCHBOARD_TUTORIAL=off`).
   */
  readonly tutorial?: TutorialService;
  /**
   * D94: the loops Switchboard fires itself (`docs/loops.md`). Without one the app
   * makes its own over the store (the real clock), started when the app is ready and
   * closed with it.
   */
  readonly loops?: LoopService;
  /**
   * D97: the search index's startup backfill (`docs/search.md`). A caller that passes
   * one owns it (starts and stops it); without one the app makes its own, started
   * when the app is ready and stopped with it.
   */
  readonly searchBackfill?: SearchBackfill;
  /** D108: the Insights rollup's startup backfill (`docs/insights.md`); like `searchBackfill`, a caller that passes one starts it. */
  readonly insightsBackfill?: InsightsBackfill;
  /** D134: the Usage breakdown's per-turn backfill (`docs/insights.md` → *Usage breakdown*); a caller that passes one starts it. */
  readonly usageTurnsBackfill?: UsageTurnsBackfill;
  /**
   * Plans (D99) hook: plans and their scheduler (`docs/plans.md`). Without one the app makes its
   * own (git from PATH, the configured gh), started when the app is ready and closed with it.
   */
  readonly plans?: PlanService;
  /**
   * D109 (`docs/ci.md`): the shared PR watcher. A caller that passes one owns it (main.ts starts
   * its timer and closes it); without one the app makes its own, which is never started (the
   * routes, the Inbox items' actions and Plans' reads still work) and closes with the app.
   */
  readonly ci?: PrWatcher;
  /** D97: a paired machine's search may take this long (default `PEER_SEARCH_TIMEOUT_MS`; tests shorten it). */
  readonly peerSearchTimeoutMs?: number;
  /** Fastify logger; off by default (tests). */
  readonly logger?: boolean;
}

/** D73: a route as registered (method, URL pattern with `:params` / `*`). */
export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
}

const REGISTERED_ROUTES = new WeakMap<FastifyInstance, RegisteredRoute[]>();

const APP_PROCESSES = new WeakMap<FastifyInstance, ProcessService>();

/**
 * D127: the app's process tracker. Not started by {@link buildApp} (tests list on demand only);
 * main.ts starts it once the port is ours, as it does the scheduler: a second instance that
 * cannot bind never stops anything.
 */
export function appProcesses(app: FastifyInstance): ProcessService | undefined {
  return APP_PROCESSES.get(app);
}

/** D73: the routes {@link buildApp} registered on `app` (tests: every `/api` route must be classified for devices). */
export function registeredRoutes(app: FastifyInstance): readonly RegisteredRoute[] {
  return REGISTERED_ROUTES.get(app) ?? [];
}

/**
 * Builds the Fastify app without listening: the security guard first, then the
 * API routes, then the UI. Tests drive it with `inject()`; main.ts listens
 * through `listenLoopback`.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: false });
  // D73: every route is recorded, so tests can check each `/api` route is classified for devices.
  const routes: RegisteredRoute[] = [];
  REGISTERED_ROUTES.set(app, routes);
  app.addHook('onRoute', (route) => {
    for (const method of ([] as string[]).concat(route.method)) routes.push({ method: method.toUpperCase(), url: route.url });
  });
  // D48 P4: the hook script presents this token to `/hook/*` (a file only the user can read).
  const hookToken = options.hookToken ?? (await loadOrCreateToken(options.config.dataDir, HOOK_TOKEN_FILE));
  const bus = options.bus ?? new HubBus();
  // D73: the device listener's requests go through this service's guard; it hands them to this app.
  let peersRef: PeerService | null = null;
  let devices = options.devices;
  if (!devices) {
    const own = new DeviceService({ config: options.config, store: options.store, bus, machineName: async () => (peersRef ? (await peersRef.self()).name : 'this computer'), remoteInbox: () => peersRef?.remoteInbox() ?? [] });
    app.addHook('onClose', async () => {
      await own.close();
    });
    devices = own;
  }
  devices.useApp(app);
  const deviceService = devices;
  // D68: `/agent/*` takes a session's agent token (derived from the install token, `todos/agent-token.ts`).
  registerSecurity(app, {
    port: options.config.port,
    token: options.token,
    hookToken,
    agentTokenValid: (sessionId, candidate) => agentTokenMatches(options.token, sessionId, candidate),
    deviceGuard: (request, reply) => deviceService.guard(request, reply),
  });
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
  // D127: the processes sessions leave running (the hooked sessions' roots once the hooks exist, below).
  let hooksForProcesses: HookService | null = null;
  const processes = new ProcessService({ store: options.store, scanner: platformScanner(), sessions: processSessions(supervisor, () => hooksForProcesses) });
  APP_PROCESSES.set(app, processes);
  app.addHook('preClose', async () => {
    await processes.close();
  });
  // D127: the system reads (`GET /api/system`, the hub's `system` ticks) carry the footer's tracked-process totals.
  const providers = withTrackedProcesses(options.providers ?? {}, processes);
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
  // D63: the account profiles (the supervisor's own, so a switch and the pages see the same ones), signing in and out, the automatic switches.
  const accounts = supervisor.accounts ?? new AccountService({ store: options.store, dataDir: config.dataDir, registry: supervisor.cliRegistry });
  const signIn = new SignInManager({ accounts, registry: supervisor.cliRegistry, dataDir: config.dataDir });
  app.addHook('preClose', async () => {
    await signIn.close();
  });
  // D138: the account chosen overall and per Project (precedence, moving the sessions now).
  const accountChoice = new AccountChoice({ store: options.store, supervisor, accounts, dataDir: config.dataDir, bus, systemItems });
  const offAccountChoice = registerAccountChoiceSource(options.store, accountChoice);
  app.addHook('preClose', async () => {
    await accountChoice.settled();
  });
  app.addHook('onClose', async () => {
    offAccountChoice();
  });
  const autoSwitcher = new AutoSwitcher({ store: options.store, supervisor, accounts, dataDir: config.dataDir, systemItems, clis, preference: (session) => accountChoice.preference(session) });
  autoSwitcher.start();
  app.addHook('preClose', async () => {
    await autoSwitcher.stop();
  });
  // D139: an account the CLI refuses to run until the developer acts (new terms, signed out): blocked, an Inbox item, Retry.
  const accountNeedsYou = new AccountNeedsYou({ store: options.store, supervisor, accounts, systemItems, changed: () => planServiceOf(app)?.kick() });
  accountNeedsYou.start();
  systemItems.useAccountRetry((profileId) => accountNeedsYou.retry(profileId));
  app.addHook('preClose', async () => {
    systemItems?.useAccountRetry(null);
    await accountNeedsYou.stop();
  });
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
  peersRef = peers;
  // D98 (docs/accounts.md → Shared across paired machines): the paired machines' accounts, merged by identity with these.
  const sharedAccounts = config.demo ? null : new SharedAccounts({ accounts, store: options.store, peers, bus });
  if (sharedAccounts) {
    accounts.useShared(sharedAccounts);
    sharedAccounts.start();
    app.addHook('preClose', async () => {
      await sharedAccounts.stop();
      accounts.useShared(null);
    });
  }
  let hooks = options.hooks;
  if (!hooks) {
    // D124: a hooked session's prompts and Stops decide its turn wait too.
    const own = new HookService({ config, store: options.store, bus, questions, hookTokenFile: path.join(config.dataDir, HOOK_TOKEN_FILE), turnStatus: supervisor.turnStatus });
    app.addHook('onClose', async () => {
      await own.close();
    });
    hooks = own;
  }
  hooksForProcesses = hooks;
  // D48 P4: answers and messages of a hooked session go through its hooks; everything else through the supervisor.
  questions.bind(sessionsWithHooks(supervisor, hooks));
  // D52: a hooked terminal session's loops are derived from its imported events, like a supervised session's.
  loops.listen(hooks);
  loops.useEventsOf((sessionId) => hooks.loopEvents(sessionId));
  // Unlisted schedules: a supervised Claude Code session's CLI-written prompts come from its transcript.
  loops.useTranscripts((session) => (session.hooked ? Promise.resolve(null) : supervisor.findTranscript(session.claudeSessionId)));
  // D48: a request that names a peer's id goes to that peer (before any route handler reads the local store).
  registerPeerForwarding(app, peers);
  // D57: attachments live in the data folder (`<dataDir>/attachments/<session>/`).
  const attachments = options.attachments ?? new AttachmentService({ dataDir: config.dataDir, store: options.store });
  // D89: artifacts saved on purpose (texts in the database, images in `<dataDir>/artifacts/<id>/`).
  const artifacts = new ArtifactService({ store: options.store, bus, dataDir: config.dataDir, webRoot: options.webRoot, announce: (sessionId) => supervisor.announce(sessionId) });
  // D61: its helper processes end with the app (a sign-in in progress is cancelled).
  let mcp = options.mcp;
  if (!mcp) {
    const own = new McpService({ claudeCommand: config.claudeCommand, extraArgs: config.claudeExtraArgs });
    app.addHook('onClose', async () => {
      await own.close();
    });
    mcp = own;
  }
  // D68: the sessions' todo lists: the sweep of done items starts with the app; the supervisor's spawns get the agent's tools.
  let todos = options.todos;
  if (!todos) {
    const own = new TodoService({ store: options.store, bus, announce: (sessionId) => supervisor.announce(sessionId) });
    app.addHook('onReady', async () => {
      await own.start();
    });
    app.addHook('onClose', async () => {
      own.close();
    });
    todos = own;
  }
  // D124: one "Waiting for you" Inbox item per needs-you episode of a session (its turn_status or the text check); its Dismiss clears the wait.
  const turnWaiting = new TurnWaitingInbox({ bus, systemItems });
  systemItems.useNotWaiting((sessionId, at) => supervisor.turnStatus.notWaiting(sessionId, at));
  app.addHook('onReady', async () => {
    await turnWaiting.start();
  });
  app.addHook('preClose', async () => {
    await turnWaiting.stop();
  });
  // D75: one reminder to the agent to finish a started todo when a turn ends with it still in progress (Settings → Sessions).
  const reminder = new TodoReminder({
    bus,
    todos,
    enabled: () => todoReminderEnabled(options.store.settings),
    deliver: async (sessionId, text) => {
      if (await hooks.isHooked(sessionId)) {
        // A hooked terminal session only while its waiter is held (else the agent would not see it until much later).
        if (!(await hooks.hasWaiter(sessionId))) return false;
        await hooks.sendMessage(sessionId, text);
        return true;
      }
      await supervisor.sendMessage(sessionId, text, 'service');
      return true;
    },
  });
  app.addHook('onReady', async () => {
    reminder.start();
  });
  app.addHook('onClose', async () => {
    await reminder.stop();
  });
  // D80: a checkpoint of the session's working trees before each turn (Settings → Sessions), the revert and Redo, the retention.
  const checkpoints = new CheckpointService({
    store: options.store,
    sessions: supervisor,
    env: supervisor.environment,
    enabled: () => checkpointsEnabled(options.store.settings),
    // The repositories the session works in, as the Diff reads them (one shared answer):
    // its worktrees, its solutions in place (linked worktrees too), the repos it edited, else its cwd's.
    includeCwd: false,
    foldersOf: async (session) => {
      const { worktrees: own, inPlace } = await worktrees.repos.of(session);
      return [...own.map((worktree) => worktree.path), ...inPlace.map((repo) => repo.top)];
    },
  });
  supervisor.useCheckpoints(checkpoints);
  // D90: the end of each turn, snapshotted for the Diff's "files this session touched" (in-place solutions).
  app.addHook('onReady', async () => {
    worktrees.touched.listen(bus);
  });
  app.addHook('onClose', async () => {
    await worktrees.touched.stop();
  });
  app.addHook('onReady', async () => {
    checkpoints.start();
  });
  app.addHook('onClose', async () => {
    supervisor.useCheckpoints(null);
    await checkpoints.stop();
  });
  // D81: a captured todo's agent is asked once, when it is next idle, to fill the item in (Settings → Sessions).
  const enricher = new TodoEnricher({
    bus,
    store: options.store,
    todos,
    enabled: () => todoEnrichEnabled(options.store.settings),
    deliver: async (sessionId, text) => {
      if (await hooks.isHooked(sessionId)) {
        // A hooked terminal session only while its waiter is held (else it waits for a later check).
        if (!(await hooks.hasWaiter(sessionId))) return false;
        await hooks.sendMessage(sessionId, text);
        return true;
      }
      await supervisor.sendMessage(sessionId, text, 'service');
      return true;
    },
  });
  app.addHook('onReady', async () => {
    enricher.start();
  });
  app.addHook('onClose', async () => {
    await enricher.stop();
  });
  if (options.agentTools !== false) {
    // 2026-10-16: the helpers' tool reports and wake-ups (docs/mcp.md → Tools that appear without a restart).
    await registerAgentToolRoutes(app, supervisor.agentTools);
    supervisor.useAgentMcp(async (session) => {
      // 1.24 perf: the prebuilt helpers when fresh (docs/performance.md → The MCP helper's footprint).
      const [script, accessScript] = await Promise.all([helperScript('sb-mcp'), helperScript('sb-access-mcp')]);
      return withClaudeConfigFile(
        config.dataDir,
        session.id,
        // Team (D100) hook (D100-T2): a member's access MCP servers join its launch (docs/team-removal.md).
        withTeamAccessServers(
          options.store,
          agentMcpLaunch({ nodePath: process.execPath, scriptPath: script, nodeArgs: HELPER_NODE_ARGS, port: config.port, sessionId: session.id, token: agentTokenFor(options.token, session.id) }),
          session.id,
          { script: accessScript, nodeArgs: HELPER_NODE_ARGS },
        ),
      );
    });
  }
  // D83: a fresh session takes the sidebar place of the session it continues (this machine's and a paired machine's).
  const freshPlaces = new FreshPlaces({ bus, sidebar: options.store.sidebar, synced: (changes) => peers.sidebarChanged(changes) });
  app.addHook('onReady', async () => {
    freshPlaces.start();
  });
  app.addHook('onClose', async () => {
    await freshPlaces.stop();
  });
  // D99 / D76 follow-up 2026-10-19: a todo's or a plan item's run goes to its source's sidebar folder, after the source (this machine's and a paired machine's).
  const runPlaces = new RunPlaces({
    bus,
    store: options.store,
    listed: async () => [
      ...(await options.store.sessions.list({ closed: false })).filter((record) => !supervisor.isStarting(record.id)).map((record) => record.id),
      ...peers.remoteSessions().map((session) => session.id),
    ],
    remoteSessions: () => peers.remoteSessions(),
    synced: (changes) => peers.sidebarChanged(changes),
  });
  app.addHook('onReady', async () => {
    runPlaces.start();
  });
  app.addHook('onClose', async () => {
    await runPlaces.stop();
  });
  // D94: the loops Switchboard fires itself: a firing is a message through the usual path (a hooked session's mailbox, else the supervisor).
  let ownedLoops = options.loops;
  if (!ownedLoops) {
    const own = new LoopService({
      store: options.store,
      announce: (sessionId) => supervisor.announce(sessionId),
      deliver: async (session, text, mark) => {
        if (session.hooked) await hooks.sendMessage(session.id, text, NO_ATTACHMENTS, { origin: 'service', loop: mark });
        else await supervisor.sendMessage(session.id, text, 'service', NO_ATTACHMENTS, { loop: mark });
      },
    });
    app.addHook('onReady', async () => {
      if (!config.demo) own.start();
    });
    app.addHook('preClose', async () => {
      await own.close();
    });
    ownedLoops = own;
  }
  const loopService = ownedLoops;
  // D65: taking a session over to / from a paired machine (this machine's end, and the runner the UI drives).
  const takeover = new TakeoverService({ store: options.store, config, supervisor, hooks, worktrees, folders, accounts, clis, questions, todos, loops: loopService, self: () => peers.self() });
  loopService.useTakeover((sessionId) => takeover.isTakingOver(sessionId));
  const takeoverRunner = new TakeoverRunner({ service: takeover, peers });
  // D85: the tutorial's state on this machine (the main tour once, What's-new mini-tours after updates).
  const tutorial = options.tutorial ?? new TutorialService({ store: options.store, appVersion: await appVersion(), autoOpen: !config.demo && tutorialAutoOpen() });
  // D88: the sessions' drafts (kept on this machine; a paired machine's session's on that machine).
  // Ruling 2026-10-09: it also cleans up drafts whose batch / todo is gone (listening to the bus).
  const drafts = new DraftService({ store: options.store, bus });
  app.addHook('onClose', async () => {
    drafts.dispose();
    await drafts.idle();
  });
  // D97: search across everything: the index fills in the background, its queries fan out to the paired machines.
  let searchBackfill = options.searchBackfill;
  if (!searchBackfill) {
    const own = new SearchBackfill(options.store);
    app.addHook('onReady', async () => {
      own.start();
    });
    app.addHook('onClose', async () => {
      own.stop();
    });
    searchBackfill = own;
  }
  const search = new SearchService({ store: options.store, backfill: searchBackfill, peers, ...(options.peerSearchTimeoutMs ? { peerTimeoutMs: options.peerSearchTimeoutMs } : {}) });
  // D108: Insights: the rollup's backfill runs in the background like search's.
  let insightsBackfill = options.insightsBackfill;
  if (!insightsBackfill) {
    const own = new InsightsBackfill(options.store);
    app.addHook('onReady', async () => {
      own.start();
    });
    app.addHook('onClose', async () => {
      own.stop();
    });
    insightsBackfill = own;
  }
  const insights = new InsightsService({ store: options.store, backfill: insightsBackfill, accounts, peers });
  // D134: the Usage breakdown's per-turn rows: the last 8 days before 0050 are added in the background.
  let turnsBackfill = options.usageTurnsBackfill;
  if (!turnsBackfill) {
    const own = new UsageTurnsBackfill(options.store);
    app.addHook('onReady', async () => {
      own.start();
    });
    app.addHook('onClose', async () => {
      own.stop();
    });
    turnsBackfill = own;
  }
  const usage = new UsageService({ store: options.store, backfill: turnsBackfill, accounts, peers });
  // D109: the shared PR watcher (CI failures back to the session, Merge PR, the header chip; Plans reads its PRs through it).
  let ci = options.ci;
  if (!ci) {
    const own = createPrWatcher(config, options.store, bus, systemItems, supervisor, hooks, worktrees);
    app.addHook('preClose', async () => {
      await own.close();
    });
    ci = own;
  }
  systemItems.useCi(ci);
  // D84 Clean-up and D137 the archive (archived sessions deleted after their period, with their safe worktrees).
  const cleanup = new CleanupService({ store: options.store, dataDir: config.dataDir, isLive: (sessionId) => supervisor.isLive(sessionId), takeover });
  const archive = new ArchiveService({ store: options.store, cleanup, isLive: (sessionId) => supervisor.isLive(sessionId) });
  const apiContext: ApiContext = { ci, config, store: options.store, providers, supervisor, worktrees, bus, hub, questions, systemItems, setup, folders, scheduler, peers, hooks, attachments, artifacts, mcp, clis, accounts, accountChoice, signIn, ...(sharedAccounts ? { sharedAccounts } : {}), takeover, takeoverRunner, todos, devices: deviceService, checkpoints, tutorial, drafts, loops: loopService, search, insights, usage, processes, cleanup, archive };
  await registerApiRoutes(app, apiContext);
  // D132: Team, Plans and Project memory graduated (always on); their stored 1.x switches go.
  await forgetGraduatedSwitches(options.store.settings);
  // ── Team (D100) hook: the Team service and its routes (docs/team-removal.md). ──
  await installTeam(app, apiContext);
  // ── Plans (D99) hook: the Plans service and its routes (docs/plans-removal.md). ──
  await installPlans(app, apiContext, options.plans);
  // ── Project memory (D107) hook: the Project memory service and its routes (docs/memory-removal.md). ──
  await installMemory(app, apiContext);
  // D137: the archive sweeps after Plans and Team started (registered last, so its onReady runs after theirs); never in demo mode.
  app.addHook('onReady', async () => {
    if (!config.demo) void archive.start().catch((error: unknown) => console.error(error));
  });
  app.addHook('preClose', async () => {
    await archive.stop();
  });
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
  const providers = createCliRegistry(config, store);
  return new SessionSupervisor({
    store,
    providers,
    // D63: the account profiles (docs/accounts.md): each process gets its profile's folder variable.
    accounts: new AccountService({ store, dataDir: config.dataDir, registry: providers }),
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
 * D109: a PR watcher for the configured gh: its messages go the normal way (a hooked session's
 * mailbox, else the supervisor: queued while the agent works, held while new turns pause for
 * credits), its items to the Inbox, and a merged PR's clean-up through the worktree manager.
 */
export function createPrWatcher(config: ServerConfig, store: Store, bus: HubBus, systemItems: SystemItemService, supervisor: SessionSupervisor, hooks: HookService, worktrees: WorktreeManager): PrWatcher {
  return new PrWatcher({
    store,
    bus,
    gh: new CiGh({ gh: config.ghCommand }),
    send: async (sessionId, text) => {
      if (await hooks.isHooked(sessionId)) await hooks.sendMessage(sessionId, text);
      else await supervisor.sendMessage(sessionId, text, 'service');
    },
    notices: systemItems,
    cleanup: async (worktreeId) => {
      await worktrees.checkPullRequest(worktreeId);
    },
    // Test servers shorten the reads (`SWITCHBOARD_CI_POLL_MS`, docs/configuration.md).
    ...(ciPollMs() !== null ? { pollMs: ciPollMs() as number } : {}),
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
