import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { RepoContext } from './context.ts';
import { DB_FILE, openDatabase } from './database.ts';
import { type Migration, type MigrationResult, loadMigrations, migrate } from './migrate.ts';
import { AgentRepository } from './repos/agents.ts';
import { ArtifactRepository } from './repos/artifacts.ts';
import { EventRepository } from './repos/events.ts';
import { FolderRepository } from './repos/folders.ts';
import { HistoryCacheRepository } from './repos/history-cache.ts';
import { LoopRepository } from './repos/loops.ts';
import { MachineRepository } from './repos/machines.ts';
import { PeerSnapshotRepository } from './repos/peer-snapshots.ts';
import { PendingMessageRepository } from './repos/pending-messages.ts';
import { PermissionRepository } from './repos/permissions.ts';
import { QuestionRepository } from './repos/questions.ts';
import { ScheduleRepository } from './repos/schedules.ts';
import { SessionRepository } from './repos/sessions.ts';
import { SettingRepository } from './repos/settings.ts';
import { SystemItemRepository } from './repos/system-items.ts';
import { ToolRepository } from './repos/tools.ts';
import { UsageRepository } from './repos/usage.ts';
import { WorktreeRepository } from './repos/worktrees.ts';

/**
 * The service's storage: one SQLite database (node:sqlite) with a repository per
 * entity. Repository methods return Promises so callers stay async end to end; each
 * call runs to completion without yielding, so it is atomic on its own.
 */
export interface Store {
  /** The database file (`:memory:` for a throwaway store). */
  readonly file: string;
  /** Result of the migrations run at open. */
  readonly migrations: MigrationResult;
  readonly sessions: SessionRepository;
  readonly agents: AgentRepository;
  readonly events: EventRepository;
  readonly questions: QuestionRepository;
  readonly permissions: PermissionRepository;
  readonly systemItems: SystemItemRepository;
  readonly worktrees: WorktreeRepository;
  readonly artifacts: ArtifactRepository;
  readonly schedules: ScheduleRepository;
  readonly loops: LoopRepository;
  readonly tools: ToolRepository;
  readonly settings: SettingRepository;
  readonly usage: UsageRepository;
  readonly historyCache: HistoryCacheRepository;
  readonly pendingMessages: PendingMessageRepository;
  /** Saved folders (D14, `docs/folders.md`). */
  readonly folders: FolderRepository;
  /** Paired Switchboard machines (D48, `docs/peers.md`). */
  readonly machines: MachineRepository;
  /** The paired machines' last known sessions (D48 ruling D48-cache-persist). */
  readonly peerSnapshots: PeerSnapshotRepository;
  /** The raw connection, for repositories added later and for tests. */
  readonly db: DatabaseSync;
  /** Closes the database; idempotent. */
  close(): Promise<void>;
}

/** Options for {@link openStore}. */
export interface OpenStoreOptions {
  /** Clock for stored timestamps (tests pass a fake one). */
  readonly now?: () => Date;
  /** Migrations to apply; default: the shipped `migrations/*.sql`. */
  readonly migrations?: readonly Migration[];
}

/** `<dataDir>/switchboard.db`. */
export function storeFile(dataDir: string): string {
  return path.join(dataDir, DB_FILE);
}

/**
 * Opens (creating when needed) the database at `file`, applies pending migrations
 * and returns the repositories. Throws `MigrationError` when the database cannot be
 * brought to this build's schema; the connection is closed in that case.
 */
export async function openStore(file: string, options: OpenStoreOptions = {}): Promise<Store> {
  const clock = options.now ?? (() => new Date());
  const migrations = options.migrations ?? (await loadMigrations());
  const db = await openDatabase(file);
  let result: MigrationResult;
  try {
    result = migrate(db, migrations, clock);
  } catch (error) {
    db.close();
    throw error;
  }
  const ctx: RepoContext = { db, now: () => clock().toISOString() };
  let closed = false;
  return {
    file,
    migrations: result,
    sessions: new SessionRepository(ctx),
    agents: new AgentRepository(ctx),
    events: new EventRepository(ctx),
    questions: new QuestionRepository(ctx),
    permissions: new PermissionRepository(ctx),
    systemItems: new SystemItemRepository(ctx),
    worktrees: new WorktreeRepository(ctx),
    artifacts: new ArtifactRepository(ctx),
    schedules: new ScheduleRepository(ctx),
    loops: new LoopRepository(ctx),
    tools: new ToolRepository(ctx),
    settings: new SettingRepository(ctx),
    usage: new UsageRepository(ctx),
    historyCache: new HistoryCacheRepository(ctx),
    pendingMessages: new PendingMessageRepository(ctx),
    folders: new FolderRepository(ctx),
    machines: new MachineRepository(ctx),
    peerSnapshots: new PeerSnapshotRepository(ctx),
    db,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
