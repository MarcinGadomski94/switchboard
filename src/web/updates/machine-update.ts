import type { Machine } from '../../core/peers.ts';
import { type MachineUpdate, type UpdateStatus, phaseText, updateRunning } from '../../core/updates.ts';

/**
 * D140 "Update Switchboard remotely" (`docs/updates.md` → *Remote updates*): what
 * a paired computer's row / card shows about its updates, from its
 * `Machine.update` (the compact state it streams), and what the phone's own
 * Settings → Updates shows instead of **Update** where this computer cannot
 * restart itself. Pure and DOM-free (unit-tested in `tests/web/remote-update.test.ts`);
 * the words of v2 are in `v2/glossary.ts` (`COMPUTER_UPDATE_WORDS`).
 */

/** Where a paired computer's update stands. */
export type MachineUpdateStage =
  /** It reports no update state (a Switchboard before D140, or its updater is off). */
  | 'unknown'
  /** An update made it restart and it is not back yet. */
  | 'restarting'
  /** An update runs there (downloading → verifying → unpacking → installing → switching). */
  | 'running'
  /** The last update there failed. */
  | 'failed'
  /** A newer release, and it can update itself. */
  | 'available'
  /** A newer release, but it cannot update itself from here (git checkout, by-hand restart). */
  | 'blocked'
  /** A check runs there. */
  | 'checking'
  /** Its last check failed. */
  | 'check-failed'
  /** It runs the newest release. */
  | 'up-to-date';

/** The view of a paired computer's updates. */
export interface MachineUpdateView {
  readonly stage: MachineUpdateStage;
  /** The version it runs (`null`: not reported). */
  readonly current: string | null;
  /** The newer release (`available` / `blocked` / `running`), else `null`. */
  readonly latest: string | null;
  /** **Update** is offered (online, a newer release, it restarts itself, nothing running). */
  readonly canUpdate: boolean;
  /** **Check for updates** is offered (online, nothing running). */
  readonly canCheck: boolean;
  /** `blocked`: why ("Can't update itself here: … restart it by hand."). */
  readonly blocked: string | null;
  /** `running` / `failed` / `check-failed`: the line of the step or the error. */
  readonly detail: string | null;
  /** Agents with a live process there (the confirm says how many resume after the restart). */
  readonly liveSessions: number;
  /** The last update asked for from a phone or another computer ended on the version it runs now: who asked. */
  readonly updatedBy: string | null;
}

const NONE: MachineUpdateView = { stage: 'unknown', current: null, latest: null, canUpdate: false, canCheck: false, blocked: null, detail: null, liveSessions: 0, updatedBy: null };

/** D140: the view of `machine`'s updates. */
export function machineUpdateView(machine: Pick<Machine, 'state' | 'update'>): MachineUpdateView {
  const update: MachineUpdate | undefined = machine.update;
  if (!update) return NONE;
  const online = machine.state === 'online';
  const progress = { ...update.progress, dir: null };
  const running = updateRunning(progress);
  const latest = update.latest?.version ?? null;
  const updatedBy = update.lastRemote && update.lastRemote.outcome === 'updated' && update.lastRemote.version === update.current ? update.lastRemote.by.name : null;
  const base = { current: update.current, liveSessions: update.liveSessions, updatedBy };
  if (update.progress.phase === 'restarting' && !online) return { ...NONE, ...base, stage: 'restarting', latest: update.progress.version };
  if (running) return { ...NONE, ...base, stage: 'running', latest: update.progress.version, detail: phaseText(progress) };
  const canCheck = online && !update.checking;
  const failed = update.progress.phase === 'failed' ? phaseText(progress) : null;
  if (update.available && latest) {
    if (!update.remote.allowed) return { ...NONE, ...base, stage: 'blocked', latest, canCheck, blocked: update.remote.message };
    const canUpdate = online && !update.checking;
    return { ...NONE, ...base, stage: failed ? 'failed' : 'available', latest, canCheck, canUpdate, detail: failed };
  }
  if (update.checking) return { ...NONE, ...base, stage: 'checking', latest };
  if (update.lastCheck && !update.lastCheck.ok) return { ...NONE, ...base, stage: 'check-failed', canCheck, detail: update.lastCheck.error };
  return { ...NONE, ...base, stage: 'up-to-date', latest, canCheck };
}

/**
 * D140: on a paired phone, the reason this computer cannot update itself from
 * there (its Settings → Updates shows it instead of **Update**); `null` when it
 * can, or on this computer's own UI.
 */
export function remoteBlockOf(status: UpdateStatus | null, onDevice: boolean): string | null {
  if (!onDevice || !status || !status.remote || status.remote.allowed) return null;
  return status.available ? status.remote.message : null;
}

/** D140: the refusal's text of a failed check / install (`{ message }` of the answer), else `fallback`. */
export function refusalMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string') return (body as { message: string }).message;
  return fallback;
}
