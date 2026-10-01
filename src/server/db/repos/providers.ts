import { randomUUID } from 'node:crypto';
import { type CliProviderId, type HandoverSource, readCliProvider } from '../../../core/cli-providers.ts';
import type { RepoContext } from '../context.ts';

/** D62 (0023): one CLI's own conversation id for a session. */
export interface SessionProviderRecord {
  readonly sessionId: string;
  readonly provider: CliProviderId;
  readonly nativeId: string;
  readonly firstUsedAt: string;
  readonly lastUsedAt: string;
}

/** D62 (0023): one mid-session switch. */
export interface ProviderSwitchRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly from: CliProviderId;
  readonly to: CliProviderId;
  /** Who wrote the handover; `null` while that is not decided yet. */
  readonly handoverBy: HandoverSource | null;
  readonly status: 'running' | 'done' | 'failed';
  readonly error: string | null;
  readonly exportPath: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** Fields of {@link ProviderRepository.updateSwitch}. */
export interface ProviderSwitchPatch {
  readonly handoverBy?: HandoverSource | null;
  readonly status?: 'running' | 'done' | 'failed';
  readonly error?: string | null;
  readonly exportPath?: string | null;
  readonly finishedAt?: string | null;
}

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nativeRow(row: Row): SessionProviderRecord {
  return {
    sessionId: String(row['session_id']),
    provider: readCliProvider(row['provider']),
    nativeId: String(row['native_id']),
    firstUsedAt: String(row['first_used_at']),
    lastUsedAt: String(row['last_used_at']),
  };
}

function switchRow(row: Row): ProviderSwitchRecord {
  const by = text(row['handover_by']);
  const status = text(row['status']);
  return {
    id: String(row['id']),
    sessionId: String(row['session_id']),
    from: readCliProvider(row['from_provider']),
    to: readCliProvider(row['to_provider']),
    handoverBy: by === 'outgoing' || by === 'history' ? by : null,
    status: status === 'done' || status === 'failed' ? status : 'running',
    error: text(row['error']),
    exportPath: text(row['export_path']),
    createdAt: String(row['created_at']),
    finishedAt: text(row['finished_at']),
  };
}

/**
 * D62: each CLI's own conversation id per session (`session_providers`) and the
 * mid-session switches (`provider_switches`), `docs/providers.md`.
 */
export class ProviderRepository {
  readonly #ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
  }

  /** `provider`'s own id for the session, `null` when that CLI never ran it. */
  async nativeId(sessionId: string, provider: CliProviderId): Promise<string | null> {
    const row = this.#ctx.db.prepare('SELECT native_id FROM session_providers WHERE session_id = ? AND provider = ?').get(sessionId, provider);
    return row ? text(row['native_id']) : null;
  }

  /** Every CLI that ran the session, oldest first. */
  async listNative(sessionId: string): Promise<SessionProviderRecord[]> {
    return this.#ctx.db
      .prepare('SELECT * FROM session_providers WHERE session_id = ? ORDER BY first_used_at, provider')
      .all(sessionId)
      .map((row) => nativeRow(row as Row));
  }

  /** Stores (or moves the last use of) `provider`'s id for the session. */
  async rememberNative(sessionId: string, provider: CliProviderId, nativeId: string): Promise<void> {
    const ts = this.#ctx.now();
    this.#ctx.db
      .prepare(
        `INSERT INTO session_providers (session_id, provider, native_id, first_used_at, last_used_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_id, provider) DO UPDATE SET native_id = excluded.native_id, last_used_at = excluded.last_used_at`,
      )
      .run(sessionId, provider, nativeId, ts, ts);
  }

  /** The session whose `provider` conversation is `nativeId`, `null` when none (History: already in Switchboard). */
  async sessionByNative(provider: CliProviderId, nativeId: string): Promise<string | null> {
    const row = this.#ctx.db.prepare('SELECT session_id FROM session_providers WHERE provider = ? AND native_id = ?').get(provider, nativeId);
    return row ? text(row['session_id']) : null;
  }

  /** Starts a switch record (`running`). */
  async createSwitch(sessionId: string, from: CliProviderId, to: CliProviderId): Promise<ProviderSwitchRecord> {
    const id = randomUUID();
    const ts = this.#ctx.now();
    this.#ctx.db
      .prepare('INSERT INTO provider_switches (id, session_id, from_provider, to_provider, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, from, to, 'running', ts);
    return (await this.getSwitch(id)) as ProviderSwitchRecord;
  }

  async getSwitch(id: string): Promise<ProviderSwitchRecord | null> {
    const row = this.#ctx.db.prepare('SELECT * FROM provider_switches WHERE id = ?').get(id);
    return row ? switchRow(row as Row) : null;
  }

  /** Updates a switch record; `null` when there is none. */
  async updateSwitch(id: string, patch: ProviderSwitchPatch): Promise<ProviderSwitchRecord | null> {
    const sets: string[] = [];
    const values: Array<string | null> = [];
    const put = (column: string, value: string | null | undefined): void => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      values.push(value);
    };
    put('handover_by', patch.handoverBy);
    put('status', patch.status);
    put('error', patch.error);
    put('export_path', patch.exportPath);
    put('finished_at', patch.finishedAt);
    if (sets.length > 0) this.#ctx.db.prepare(`UPDATE provider_switches SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.getSwitch(id);
  }

  /** The session's switches, oldest first. */
  async listSwitches(sessionId: string): Promise<ProviderSwitchRecord[]> {
    return this.#ctx.db
      .prepare('SELECT * FROM provider_switches WHERE session_id = ? ORDER BY created_at, id')
      .all(sessionId)
      .map((row) => switchRow(row as Row));
  }

  /** Switches still `running` (a restart cut them short). */
  async runningSwitches(): Promise<ProviderSwitchRecord[]> {
    return this.#ctx.db
      .prepare("SELECT * FROM provider_switches WHERE status = 'running' ORDER BY created_at, id")
      .all()
      .map((row) => switchRow(row as Row));
  }
}
