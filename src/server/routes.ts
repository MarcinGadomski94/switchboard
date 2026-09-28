import type { FastifyInstance } from 'fastify';
import { registerArtifactRoutes } from './api/artifacts.ts';
import { registerHistoryRoutes } from './api/history.ts';
import { registerHubRoutes } from './api/hub.ts';
import { registerInboxRoutes } from './api/inbox.ts';
import { registerScheduleRoutes } from './api/schedules.ts';
import { registerSessionRoutes } from './api/sessions.ts';
import { registerSettingsRoutes } from './api/settings.ts';
import { registerSetupRoutes } from './api/setup.ts';
import { registerSolutionRoutes } from './api/solutions.ts';
import { registerSystemRoutes } from './api/system.ts';
import { registerToolRoutes } from './api/tools.ts';
import type { ServerConfig } from './config.ts';
import type { Store } from './db/store.ts';
import type { HubBus } from './hub/bus.ts';
import type { SseHub } from './hub/hub.ts';
import type { QuestionPipeline } from './inbox/pipeline.ts';
import type { SystemItemService } from './inbox/system-items.ts';
import type { Providers } from './providers.ts';
import type { SetupService } from './setup/service.ts';
import type { SessionSupervisor } from './supervisor/supervisor.ts';
import type { WorktreeManager } from './worktrees/manager.ts';

/** What API route modules receive when they register. Later items add their services here. */
export interface ApiContext {
  readonly config: ServerConfig;
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
  /** First-run setup: wizard state, the workspace root chosen there (M5.3, docs/setup.md). */
  readonly setup: SetupService;
}

/**
 * Registry of the REST routes (`/api/*`, contracts/local-api.md) and the `/hub`
 * SSE endpoint. Each API area registers from its own module in `api/` with one
 * line here (`docs/lanes.md` has the ownership map). Every contract route exists
 * from M1.4 on and answers 501 until its item implements it. The security guard
 * (security.ts) already covers every route registered here: none of them may be
 * marked `config.public`.
 */
export async function registerApiRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  await registerSessionRoutes(app, context);
  await registerInboxRoutes(app, context);
  await registerSolutionRoutes(app, context);
  await registerScheduleRoutes(app, context);
  await registerArtifactRoutes(app, context);
  await registerHistoryRoutes(app, context);
  await registerSettingsRoutes(app, context);
  await registerToolRoutes(app, context);
  await registerSystemRoutes(app, context);
  await registerSetupRoutes(app, context);
  await registerHubRoutes(app, context);
}
