import path from 'node:path';
import {
  type AccountChoiceSource,
  type AccountPreference,
  CONTINUE_AFTER_CHOICE,
  type MoveCandidate,
  type MoveSelection,
  choiceMoveReason,
  moveConfirmText,
  resolveAccountPreference,
  selectSessionsToMove,
  sessionProfileId,
} from '../../core/accounts.ts';
import type { AccountChoicePreview, AccountChoiceResult, SessionAccountChoice } from '../../core/api.ts';
import { CLI_LABELS, type CliProviderId } from '../../core/cli-providers.ts';
import type { PlanAccounts } from '../../core/plans.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import type { HubBus } from '../hub/bus.ts';
import type { SystemItemService } from '../inbox/system-items.ts';
import type { SessionSupervisor } from '../supervisor/supervisor.ts';
import { AccountError, type AccountService } from './service.ts';

/**
 * D138 · Plans (D99) hook (`docs/plans-removal.md`): which Project a session
 * belongs to, and a Project's sessions. Absent (Plans removed, plans.db not open): no Project has an account.
 */
export interface ProjectAccountsLookup {
  /** The active Project (plan) of a session (its own session or a step's run session), `null` = none. */
  ofSession(sessionId: string): Promise<{ readonly planId: string; readonly title: string; readonly accounts: PlanAccounts } | null>;
  /** A Project's accounts and sessions, `null` = no such plan. */
  sessionsOf(planId: string): Promise<{ readonly title: string; readonly accounts: PlanAccounts; readonly sessionIds: readonly string[] } | null>;
}

const choices = new WeakMap<Store, AccountChoice>();

/** D138: the {@link AccountChoice} the app made over `store` (tests wire a given Plans service's environment to it). */
export function accountChoiceOf(store: Store): AccountChoice | undefined {
  return choices.get(store);
}

/** Options of {@link AccountChoice}. */
export interface AccountChoiceOptions {
  readonly store: Store;
  readonly supervisor: SessionSupervisor;
  readonly accounts: AccountService;
  /** Where exports of a switch go (`<dataDir>/handovers`). */
  readonly dataDir: string;
  /** `accountChoiceChanged` goes out on it. */
  readonly bus?: HubBus;
  /** A move that fails raises the "Could not switch the account of …" Inbox item. */
  readonly systemItems?: Pick<SystemItemService, 'accountNotice'>;
  readonly onError?: (error: unknown) => void;
  readonly log?: (line: string) => void;
}

/**
 * D138 (`docs/accounts.md` → *Choosing the account*): the account the developer chose, overall
 * (per CLI, the `accounts.settings` setting's `choice`) and per Project (plans.db `accounts`).
 *
 * - **Precedence** ({@link preference}, the pure `resolveAccountPreference`): a session's own pin >
 *   its Project's account > the overall choice > the automatic rules.
 * - **Moving now**: choosing account B moves the live sessions (idle and running) to it through
 *   `SessionSupervisor.switchAccount` (the same conversation; a running turn is interrupted and
 *   continued), except pinned sessions and, for the overall choice, sessions whose Project has its
 *   own account. {@link preview} gives the confirm's counts first. Moves run one after another in
 *   the background; each session's `sessionUpdated` shows its new account.
 * - Per computer: profile ids are this machine's and the choice is this machine's setting, so a
 *   paired computer's sessions are never moved by it (D98 shares names, order and usage only).
 */
export class AccountChoice {
  readonly #o: AccountChoiceOptions;
  #projects: ProjectAccountsLookup | null = null;
  #moving: Promise<void> = Promise.resolve();

  constructor(options: AccountChoiceOptions) {
    this.#o = options;
    choices.set(options.store, this);
  }

  /** The Plans hook (installed by `installPlans`; `null` takes it away). */
  useProjects(lookup: ProjectAccountsLookup | null): void {
    this.#projects = lookup;
  }

  #error(error: unknown): void {
    (this.#o.onError ?? ((e) => console.error('switchboard accounts:', e)))(error);
  }

  #log(line: string): void {
    (this.#o.log ?? ((text: string) => console.info(`switchboard accounts: ${text}`)))(line);
  }

  async #usable(cli: CliProviderId, id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    const record = await this.#o.store.profiles.get(id);
    return record && record.cli === cli && record.enabled ? id : null;
  }

  async #projectOf(sessionId: string): Promise<{ readonly planId: string; readonly title: string; readonly accounts: PlanAccounts } | null> {
    return (await this.#projects?.ofSession(sessionId).catch(() => null)) ?? null;
  }

  /**
   * The session's preferred account and where it comes from (pin > Project > overall >
   * automatic), with its Project when the account is the Project's.
   */
  async preference(session: Pick<SessionRecord, 'id' | 'provider' | 'profileId' | 'profilePinned'>): Promise<AccountPreference & { readonly project?: { readonly id: string; readonly title: string } }> {
    const cli = session.provider;
    const project = session.profilePinned ? null : await this.#projectOf(session.id);
    const projectId = await this.#usable(cli, project?.accounts[cli]);
    const overall = await this.#o.accounts.overallChoice(cli);
    const resolved = resolveAccountPreference({ pinned: session.profilePinned, currentId: sessionProfileId(session), project: projectId, overall });
    return resolved.source === 'project' && project ? { ...resolved, project: { id: project.planId, title: project.title } } : resolved;
  }

  /** `Session.accountChoice` (the agent header's "Account: B (from project)"). */
  async sessionInfo(record: SessionRecord): Promise<SessionAccountChoice> {
    const pref = await this.preference(record);
    return { source: pref.source, ...(pref.profileId !== null ? { profileId: pref.profileId } : {}), ...(pref.project ? { project: pref.project } : {}) };
  }

  async #candidates(cli: CliProviderId, only: ReadonlySet<string> | null): Promise<MoveCandidate[]> {
    const out: MoveCandidate[] = [];
    for (const live of this.#o.supervisor.liveSessions()) {
      if (live.provider !== cli || (only !== null && !only.has(live.id))) continue;
      const session = await this.#o.store.sessions.get(live.id);
      if (!session || session.closedAt !== null || session.hooked || !session.attached || this.#o.supervisor.accountSwitching(live.id)) continue;
      const project = only === null && !session.profilePinned ? await this.#projectOf(session.id) : null;
      out.push({ id: session.id, cli, profileId: sessionProfileId(session), pinned: session.profilePinned, projectAccount: await this.#usable(cli, project?.accounts[cli]), running: !live.idle });
    }
    return out;
  }

  async #selection(cli: CliProviderId, toId: string | null, planId: string | null): Promise<MoveSelection> {
    if (planId === null) return selectSessionsToMove(await this.#candidates(cli, null), cli, toId, 'overall');
    const project = await this.#projects?.sessionsOf(planId);
    if (!project) throw new AccountError(404, 'not-found', `no project ${planId}`);
    return selectSessionsToMove(await this.#candidates(cli, new Set(project.sessionIds)), cli, toId, 'project');
  }

  /**
   * The confirm's counts (`POST /api/accounts/choice/preview`): choosing `profileId` (`null` =
   * Automatic) overall, or for Project `planId` (then Automatic means the overall choice).
   */
  async preview(input: { readonly cli: CliProviderId; readonly profileId: string | null; readonly planId?: string | null }): Promise<AccountChoicePreview> {
    const planId = input.planId ?? null;
    const chosen = input.profileId === null ? null : await this.#checked(input.cli, input.profileId);
    // A Project back on Automatic goes to the overall choice (if any).
    const target = chosen ?? (planId !== null ? await this.#o.accounts.overallChoice(input.cli) : null);
    const selection = await this.#selection(input.cli, target, planId);
    const name = target === null ? null : ((await this.#o.store.profiles.get(target))?.name ?? target);
    return {
      cli: input.cli,
      profileId: target,
      profileName: name,
      move: selection.move.length,
      running: selection.running,
      skipped: selection.skipped,
      sessionIds: selection.move,
      confirm: name === null ? null : moveConfirmText(selection, name),
    };
  }

  async #checked(cli: CliProviderId, id: string): Promise<string> {
    const record = await this.#o.store.profiles.get(id);
    if (!record || record.cli !== cli) throw new AccountError(422, 'invalid', `no ${CLI_LABELS[cli]} account ${id}`, 'profileId');
    if (!record.enabled) throw new AccountError(422, 'invalid', `the account ${record.name} is disabled`, 'profileId');
    return id;
  }

  /**
   * `PUT /api/accounts/choice`: the overall choice of `cli` (`null` = Automatic). New sessions
   * start on it from now on; the live sessions it applies to move to it now (in the background,
   * one after another; `move: false` only saves the choice).
   */
  async setOverall(cli: CliProviderId, profileId: string | null, options: { readonly move?: boolean } = {}): Promise<AccountChoiceResult> {
    const id = profileId === null ? null : await this.#checked(cli, profileId);
    const settings = await this.#o.accounts.setSettings({ choice: { [cli]: id } });
    const selection = options.move === false || id === null ? { move: [], running: 0 } : await this.#selection(cli, id, null);
    this.#publish({ cli, profileId: id, planId: null, moving: selection.move.length });
    if (id !== null && selection.move.length > 0) this.#start(selection.move, id, 'overall');
    return { settings, moving: selection.move.length, running: selection.running };
  }

  /**
   * A Project's accounts changed (`PlanEnvironment.accountsChanged`): its live sessions move to its
   * account for their CLI (Automatic: the overall choice, when there is one), pinned ones excepted.
   */
  async applyProject(planId: string): Promise<number> {
    const project = await this.#projects?.sessionsOf(planId);
    if (!project) return 0;
    let moving = 0;
    for (const cli of ['claude', 'codex', 'opencode'] as const) {
      const target = (await this.#usable(cli, project.accounts[cli])) ?? (await this.#o.accounts.overallChoice(cli));
      if (target === null) continue;
      const selection = await this.#selection(cli, target, planId);
      if (selection.move.length === 0) continue;
      moving += selection.move.length;
      this.#start(selection.move, target, 'project');
    }
    this.#publish({ cli: null, profileId: null, planId, moving });
    return moving;
  }

  /** Waits for the moves started so far (tests; the routes answer before they finish). */
  settled(): Promise<void> {
    return this.#moving;
  }

  #publish(payload: { readonly cli: CliProviderId | null; readonly profileId: string | null; readonly planId: string | null; readonly moving: number }): void {
    this.#o.bus?.publish('accountChoiceChanged', payload);
  }

  #start(sessionIds: readonly string[], toId: string, source: 'overall' | 'project'): void {
    this.#moving = this.#moving.then(() => this.#move(sessionIds, toId, source)).catch((error: unknown) => this.#error(error));
  }

  async #move(sessionIds: readonly string[], toId: string, source: 'overall' | 'project'): Promise<void> {
    const { store, supervisor } = this.#o;
    for (const id of sessionIds) {
      // Checked again: it may have been pinned, closed, moved or paused since the choice.
      const session = await store.sessions.get(id);
      if (!session || session.closedAt !== null || session.profilePinned || sessionProfileId(session) === toId || !supervisor.isLive(id) || supervisor.accountSwitching(id)) continue;
      try {
        await supervisor.switchAccount(id, toId, { reason: choiceMoveReason(source), handoverDir: path.join(this.#o.dataDir, 'handovers'), continueMessage: CONTINUE_AFTER_CHOICE });
        this.#log(`${id} switched account (${choiceMoveReason(source)})`);
      } catch (error) {
        this.#error(error);
        const name = session.title ?? session.name;
        await this.#o.systemItems
          ?.accountNotice({ kind: 'account-switch-failed', sessionId: id, title: `Could not switch the account of ${name}`, detail: `${error instanceof Error ? error.message : String(error)} (${choiceMoveReason(source)}).`, dedupe: `account-switch-failed:${id}:choice:${toId}` })
          .catch((e: unknown) => this.#error(e));
      }
    }
  }
}

export type { AccountChoiceSource };
