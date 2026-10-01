import path from 'node:path';
import { type LimitStrictness, type SwitchDecision, type SwitchTrigger, decideAccountSwitch, parseLimitError, sessionProfileId } from '../../core/accounts.ts';
import { CLI_LABELS } from '../../core/cli-providers.ts';
import type { SessionEvent } from '../../core/api.ts';
import type { CliStatusService } from '../cli/status.ts';
import type { Store } from '../db/store.ts';
import type { SystemItemService } from '../inbox/system-items.ts';
import type { SessionSupervisor } from '../supervisor/supervisor.ts';
import type { AccountService } from './service.ts';

/** Options of {@link AutoSwitcher}. */
export interface AutoSwitcherOptions {
  readonly store: Store;
  readonly supervisor: SessionSupervisor;
  readonly accounts: AccountService;
  /** Where exports of a switch go (`<dataDir>/handovers`). */
  readonly dataDir: string;
  /** Inbox items for "every account is spent" and a failed switch. */
  readonly systemItems?: Pick<SystemItemService, 'accountNotice'>;
  /** CLIs' status (a "switch to another CLI" rule checks the target can be chosen). */
  readonly clis?: Pick<CliStatusService, 'refusal'>;
  readonly now?: () => number;
  /** Gap between the periodic threshold / reset checks (default 30 s). */
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
  readonly log?: (line: string) => void;
}

/** The text of a failed turn's result event (its text, errors and label). */
function resultText(event: SessionEvent): string | null {
  const payload = event.payload as { type?: string; isError?: boolean; text?: string | null; errors?: string[] } | null;
  if (!payload || payload.type !== 'result' || payload.isError !== true) return null;
  return [payload.text, ...(payload.errors ?? []), event.label].filter((part): part is string => typeof part === 'string' && part !== '').join(' · ');
}

/**
 * D63 (`docs/accounts.md` → *Rules*): switches sessions to another account of their
 * CLI when a usage limit is hit. Two triggers feed the pure decision
 * (`core/accounts.ts` → `decideAccountSwitch`): the CLI's own **limit error** (a
 * failed turn's result, read as it arrives), and a periodic check of the **thresholds**
 * and of **resets** ("switch back to the first account"). Every switch goes through
 * `SessionSupervisor.switchAccount` (a divider in the chat); a failed one, and
 * "every account is spent", raise an Inbox item. No loops: a profile known to be
 * spent is never a target until its reset, and the periodic switches keep a cooldown.
 */
export class AutoSwitcher {
  readonly #o: AutoSwitcherOptions;
  readonly #busy = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #off: (() => void) | null = null;
  #ticking: Promise<void> | null = null;
  readonly #pending = new Set<Promise<unknown>>();

  constructor(options: AutoSwitcherOptions) {
    this.#o = options;
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  #error(error: unknown): void {
    (this.#o.onError ?? ((e) => console.error('switchboard accounts:', e)))(error);
  }

  /** Starts listening to the supervisor's events and the periodic checks. */
  start(): void {
    if (this.#off) return;
    this.#off = this.#o.supervisor.on('event', ({ sessionId, event }) => {
      const text = resultText(event);
      if (text === null) return;
      const run = this.onFailedTurn(sessionId, text).catch((error: unknown) => this.#error(error));
      this.#pending.add(run);
      void run.finally(() => this.#pending.delete(run));
    });
    this.#timer = setInterval(() => void this.tick().catch((error: unknown) => this.#error(error)), this.#o.intervalMs ?? 30_000);
    this.#timer.unref();
  }

  /** Stops listening and waits for a switch in progress. */
  async stop(): Promise<void> {
    this.#off?.();
    this.#off = null;
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#ticking?.catch(() => undefined);
    await Promise.allSettled([...this.#pending]);
  }

  /** A turn of the session failed with `text`: a usage limit of its account switches it. */
  async onFailedTurn(sessionId: string, text: string): Promise<void> {
    const session = await this.#o.store.sessions.get(sessionId);
    if (!session || session.hooked || session.closedAt !== null) return;
    const hit = parseLimitError(text, session.provider as LimitStrictness, new Date(this.#now()));
    if (!hit) return;
    await this.#decide(sessionId, { kind: 'limit', hit });
  }

  /** One periodic check of every live session: thresholds, then resets. Overlapping calls share the run. */
  tick(): Promise<void> {
    this.#ticking ??= this.#tick().finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  async #tick(): Promise<void> {
    const settings = await this.#o.accounts.settings();
    if (!settings.enabled) return;
    for (const live of this.#o.supervisor.liveSessions()) {
      if (!settings.perCli[live.provider]) continue;
      await this.#decide(live.id, { kind: 'threshold' }, live.idle);
      if (settings.afterReset === 'back-to-first') await this.#decide(live.id, { kind: 'reset' }, live.idle);
    }
  }

  /** Decides for one session and carries the decision out (a no-op while one runs for it). */
  async #decide(sessionId: string, trigger: SwitchTrigger, idle = true): Promise<void> {
    if (this.#busy.has(sessionId)) return;
    this.#busy.add(sessionId);
    try {
      const session = await this.#o.store.sessions.get(sessionId);
      if (!session || session.hooked || session.closedAt !== null || !session.attached) return;
      const accounts = this.#o.accounts;
      const now = this.#now();
      const decision = decideAccountSwitch({
        settings: await accounts.settings(),
        cli: session.provider,
        trigger,
        profiles: await accounts.snapshots(session.provider),
        currentId: sessionProfileId(session),
        pinned: session.profilePinned,
        idle,
        lastSwitchAt: this.#o.supervisor.lastAccountSwitch(sessionId),
        now,
      });
      if (decision.mark) await accounts.markExhausted(decision.mark);
      await this.#carryOut(sessionId, session.provider, trigger, decision);
    } finally {
      this.#busy.delete(sessionId);
    }
  }

  async #carryOut(sessionId: string, cli: 'claude' | 'codex' | 'opencode', trigger: SwitchTrigger, decision: SwitchDecision): Promise<void> {
    const handoverDir = path.join(this.#o.dataDir, 'handovers');
    const log = this.#o.log ?? ((line: string) => console.info(`switchboard accounts: ${line}`));
    const notice = async (kind: 'account-exhausted' | 'account-switch-failed', title: string, detail: string): Promise<void> => {
      await this.#o.systemItems?.accountNotice({ kind, sessionId, title, detail, dedupe: `${kind}:${sessionId}:${decision.mark?.until ?? decision.reason}` });
    };
    const name = (await this.#o.store.sessions.get(sessionId))?.title ?? sessionId;
    switch (decision.action) {
      case 'none':
        if (decision.mark && decision.reason.includes('pinned')) {
          log(`${sessionId} hit a usage limit but is pinned to its account`);
          await notice('account-exhausted', `${name} hit its usage limit`, `The session is pinned to its account, so Switchboard did not switch it (${decision.mark.text ?? 'usage limit'}). Switch its account from the session header, or unpin it.`);
        }
        return;
      case 'switch':
        try {
          await this.#o.supervisor.switchAccount(sessionId, decision.to as string, { reason: decision.reason, handoverDir, ...(trigger.kind === 'limit' ? { interrupted: true } : {}) });
          log(`${sessionId} switched account (${decision.reason})`);
        } catch (error) {
          this.#error(error);
          await notice('account-switch-failed', `Could not switch the account of ${name}`, `${error instanceof Error ? error.message : String(error)} (${decision.reason}).`);
        }
        return;
      case 'switch-cli': {
        const to = decision.toCli as 'claude' | 'codex' | 'opencode';
        const refusal = await this.#o.clis?.refusal(to);
        if (refusal) {
          await notice('account-exhausted', `Every ${CLI_LABELS[cli]} account is out of usage`, `${name} could not move to ${CLI_LABELS[to]}: ${refusal}.`);
          return;
        }
        try {
          await this.#o.supervisor.switchProvider(sessionId, to, { capacity: { ok: false, reason: decision.reason }, handoverDir });
          log(`${sessionId} handed over to ${to} (${decision.reason})`);
        } catch (error) {
          this.#error(error);
          await notice('account-switch-failed', `Could not hand ${name} over to ${CLI_LABELS[to]}`, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case 'exhausted':
        log(`${sessionId}: ${decision.reason}`);
        await notice('account-exhausted', `Every ${CLI_LABELS[cli]} account is out of usage`, `${name}: ${decision.reason}. ${decision.mark?.until ? `The first one is usable again at ${decision.mark.until}.` : ''}`.trim());
        return;
    }
  }
}
