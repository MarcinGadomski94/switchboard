import { type AccountActionHit, type LimitStrictness, type ProfileNeedsYou, accountFixCommand, accountNeedsYouTitle, accountStoppedLabel, parseAccountAction, sessionProfileId } from '../../core/accounts.ts';
import { CLI_LABELS } from '../../core/cli-providers.ts';
import type { SessionEvent } from '../../core/api.ts';
import type { Store } from '../db/store.ts';
import type { SystemItemService } from '../inbox/system-items.ts';
import type { SessionSupervisor } from '../supervisor/supervisor.ts';
import type { AccountService } from './service.ts';

/** Options of {@link AccountNeedsYou}. */
export interface AccountNeedsYouOptions {
  readonly store: Store;
  readonly supervisor: Pick<SessionSupervisor, 'on' | 'recordServiceEvent' | 'restartStopped' | 'isLive'>;
  readonly accounts: Pick<AccountService, 'block' | 'unblock' | 'blockOf' | 'blocks'>;
  readonly systemItems?: Pick<SystemItemService, 'accountNeedsYouNotice' | 'closeAccountNeedsYouNotices'>;
  /** Called after a profile was blocked or cleared (Plans looks again: its held steps may start). */
  readonly changed?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly log?: (line: string) => void;
}

const watchers = new WeakMap<Store, AccountNeedsYou>();

/** D139: the {@link AccountNeedsYou} the app made over `store` (Plans' environment and tests reach it). */
export function accountNeedsYouOf(store: Store): AccountNeedsYou | undefined {
  return watchers.get(store);
}

/** What a failed session event says, when it is a failure: a process exit's stderr (D7's `failed`), or a failed turn's result text. */
function failureText(event: SessionEvent): string | null {
  const payload = event.payload as { type?: string; action?: string; stderr?: string; message?: string; isError?: boolean; text?: string | null; errors?: string[] } | null;
  if (!payload) return null;
  if (payload.type === 'lifecycle' && payload.action === 'failed') return [payload.stderr, payload.message].filter((part): part is string => typeof part === 'string' && part !== '').join('\n');
  if (payload.type === 'result' && payload.isError === true) return [payload.text, ...(payload.errors ?? [])].filter((part): part is string => typeof part === 'string' && part !== '').join('\n');
  return null;
}

/** A turn that ended well (a result that is not an error): the account works. */
function succeeded(event: SessionEvent): boolean {
  const payload = event.payload as { type?: string; isError?: boolean } | null;
  return payload?.type === 'result' && payload.isError !== true;
}

/**
 * D139 (`docs/accounts.md` → *The account needs you*): watches the sessions' failures for a CLI
 * that refuses to run until the developer acts for the account (Claude Code's "[ACTION REQUIRED]
 * … review the updated terms", a login that no longer works: `parseAccountAction`). Then the
 * profile is **blocked** (the setting `accounts.blocked`, so it survives a restart), the session's
 * chat gets the divider "Stopped: the account Work needs you — …" with the command, and one Inbox
 * item per block says so with **Retry stopped agents**. The block clears by itself when a turn of
 * a session on that profile ends well, or with {@link retry} (the developer did it).
 */
export class AccountNeedsYou {
  readonly #o: AccountNeedsYouOptions;
  #off: (() => void) | null = null;
  readonly #pending = new Set<Promise<unknown>>();
  /** Per profile, one change at a time (a burst of failures blocks once). */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: AccountNeedsYouOptions) {
    this.#o = options;
    watchers.set(options.store, this);
  }

  #error(error: unknown): void {
    (this.#o.onError ?? ((e) => console.error('switchboard accounts:', e)))(error);
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Starts listening to the supervisor's events. */
  start(): void {
    if (this.#off) return;
    this.#off = this.#o.supervisor.on('event', ({ sessionId, event }) => {
      const failed = failureText(event);
      const work = failed !== null ? this.onFailure(sessionId, failed) : succeeded(event) ? this.onSuccess(sessionId) : null;
      if (!work) return;
      const run = work.catch((error: unknown) => this.#error(error));
      this.#pending.add(run);
      void run.finally(() => this.#pending.delete(run));
    });
  }

  /** Stops listening and waits for the work in progress. */
  async stop(): Promise<void> {
    this.#off?.();
    this.#off = null;
    await Promise.allSettled([...this.#pending]);
    if (watchers.get(this.#o.store) === this) watchers.delete(this.#o.store);
  }

  /** A session failed with `text`: when its CLI says the account needs the developer, its profile is blocked. Answers the hit. */
  async onFailure(sessionId: string, text: string): Promise<AccountActionHit | null> {
    const session = await this.#o.store.sessions.get(sessionId);
    if (!session || session.hooked) return null;
    const hit = parseAccountAction(text, session.provider as LimitStrictness);
    if (!hit) return null;
    const profileId = sessionProfileId(session);
    const profile = await this.#o.store.profiles.get(profileId);
    const name = profile?.name ?? 'Default';
    const dir = profile?.dir ?? null;
    const command = accountFixCommand(session.provider, hit.kind, dir);
    const { block, fresh } = await this.#serial(() => this.#o.accounts.block(profileId, { kind: hit.kind, text: hit.text, command, sessionId }));
    this.#o.log?.(`switchboard accounts: ${profileId} needs the developer (${hit.kind}); session ${sessionId} stopped`);
    await this.#o.supervisor.recordServiceEvent(sessionId, 'text', accountStoppedLabel(name, session.provider, hit.kind), {
      type: 'lifecycle',
      action: 'account-needs-you',
      message: hit.text,
      fromProfile: name,
      ...(command !== null ? { command } : {}),
    });
    const label = CLI_LABELS[session.provider];
    const detail = [
      hit.text,
      command !== null ? `Run this in a terminal, do what it asks, then choose Retry stopped agents:` : `Open ${label} with this account, do what it asks, then choose Retry stopped agents.`,
    ].join('\n\n');
    await this.#o.systemItems?.accountNeedsYouNotice({
      profileId,
      sessionId,
      title: accountNeedsYouTitle(name, session.provider, label, hit.kind),
      detail,
      command,
      dedupe: `account-needs-you:${profileId}:${block.since}`,
    });
    if (fresh) this.#o.changed?.();
    return hit;
  }

  /** A turn of a session ended well: its profile no longer waits for the developer. */
  async onSuccess(sessionId: string): Promise<void> {
    const session = await this.#o.store.sessions.get(sessionId);
    if (!session || session.hooked) return;
    const profileId = sessionProfileId(session);
    if ((await this.#o.accounts.blockOf(profileId)) === null) return;
    const cleared = await this.#serial(() => this.#o.accounts.unblock(profileId));
    if (cleared === null) return;
    this.#o.log?.(`switchboard accounts: ${profileId} works again (a turn of ${sessionId} ended well)`);
    await this.#o.systemItems?.closeAccountNeedsYouNotices(profileId, 'resolved');
    this.#o.changed?.();
  }

  /**
   * **Retry stopped agents** (the developer did what the CLI asked): the profile no longer
   * waits, and each session it stopped that is still stopped (failed, not live, not closed)
   * starts again, the same session (`SessionSupervisor.restartStopped`). A session that fails
   * the same way blocks the profile again (a new Inbox item). Answers the sessions started again.
   */
  async retry(profileId: string): Promise<string[]> {
    const block: ProfileNeedsYou | null = await this.#serial(() => this.#o.accounts.unblock(profileId));
    await this.#o.systemItems?.closeAccountNeedsYouNotices(profileId, 'retry-stopped');
    this.#o.changed?.();
    const started: string[] = [];
    for (const sessionId of block?.sessionIds ?? []) {
      const session = await this.#o.store.sessions.get(sessionId);
      if (!session || session.closedAt !== null || session.status !== 'fail' || this.#o.supervisor.isLive(sessionId)) continue;
      try {
        await this.#o.supervisor.restartStopped(sessionId);
        started.push(sessionId);
      } catch (error) {
        this.#error(error);
      }
    }
    return started;
  }
}
