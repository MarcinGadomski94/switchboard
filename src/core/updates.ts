/**
 * D55 "Updates from GitHub releases" (`docs/updates.md`): the wire types of
 * `GET /api/updates` and the `updateChanged` hub event, and the pure copy the UI
 * shows (banner, dialog, Settings → Updates). Additive to the contract.
 */

/** How this Switchboard was installed: a git checkout (notify only) or an unpacked release tarball (full update). */
export type InstallKind = 'git' | 'release';

/** How an update would restart this process: through the login service it runs under, or by hand. */
export type RestartMode = 'service' | 'manual';

/** Where an update stands. `idle` = none running; `restart-manually` / `failed` stay until the next attempt. */
export type UpdatePhase = 'idle' | 'downloading' | 'verifying' | 'extracting' | 'installing' | 'switching' | 'restarting' | 'restart-manually' | 'failed';

/** The newest release found (drafts and pre-releases are never offered). */
export interface ReleaseInfo {
  /** `1.1.0` (from the tag). */
  readonly version: string;
  /** `v1.1.0`. */
  readonly tag: string;
  /** The release title (`Switchboard 1.1.0`), else the tag. */
  readonly name: string;
  /** The release notes, Markdown (may be empty). */
  readonly notes: string;
  readonly publishedAt: string | null;
  /** The release page on GitHub. */
  readonly url: string | null;
}

/** The last check for a new release. */
export interface UpdateCheck {
  readonly at: string;
  readonly ok: boolean;
  /** How GitHub was reached: the public REST API, or `gh` after the API refused (private repo, rate limit). */
  readonly via: 'api' | 'gh' | null;
  /** Why it failed (`ok` false): "Can't reach releases: …". */
  readonly error: string | null;
}

/** The update in progress, or the last one's outcome. */
export interface UpdateProgress {
  readonly phase: UpdatePhase;
  /** The version being installed. */
  readonly version: string | null;
  /** One line for the UI ("Installing dependencies (npm ci --omit=dev)…"). */
  readonly message: string;
  /** `failed`: why. */
  readonly error: string | null;
  /** `restart-manually`: where the new version was installed. */
  readonly dir: string | null;
  readonly at: string | null;
}

/** Additive (D55): `GET /api/updates`, also the payload of the `updateChanged` hub event. */
export interface UpdateStatus {
  /** This process's version (`package.json`). */
  readonly current: string;
  readonly install: { readonly kind: InstallKind; readonly dir: string };
  /** How an update restarts: `service` when this process runs as the login service, else `manual`. */
  readonly restart: RestartMode;
  /** The GitHub repository releases come from (`owner/name`). */
  readonly repo: string;
  /** A check is running. */
  readonly checking: boolean;
  readonly lastCheck: UpdateCheck | null;
  /** The newest release found by the last successful check. */
  readonly latest: ReleaseInfo | null;
  /** `latest` is newer than `current`. */
  readonly available: boolean;
  /** The version whose banner the developer dismissed (it shows again for a newer one). */
  readonly dismissed: string | null;
  readonly progress: UpdateProgress;
  /** The install kept for a manual rollback (`docs/updates.md` → *Rollback*). */
  readonly previous: { readonly version: string; readonly dir: string } | null;
  /** Sessions with a live process now: resumed after the restart (restart recovery). */
  readonly liveSessions: number;
  /**
   * Additive (D140, `docs/updates.md` → *Remote updates*): whether a paired phone
   * or another computer may update this Switchboard (a release install running as
   * its login service), else why not. Absent from services before D140.
   */
  readonly remote?: RemoteUpdateAbility;
  /** Additive (D140): the last update a phone or another computer asked for here, `null` before the first. */
  readonly lastRemote?: RemoteUpdateRecord | null;
}

/** D140: who asked for an update: this computer's own UI, a paired phone (device) or a paired computer (peer). */
export type UpdateTrigger =
  | { readonly kind: 'local' }
  | { readonly kind: 'device'; readonly id: string; readonly name: string }
  | { readonly kind: 'peer'; readonly id: string; readonly name: string };

/** D140: a remote trigger (a phone or another computer). */
export type RemoteUpdateTrigger = Exclude<UpdateTrigger, { readonly kind: 'local' }>;

/** D140: why a phone or another computer cannot update this Switchboard. */
export type RemoteUpdateBlock = 'git-checkout' | 'manual-restart';

/** D140: whether a phone or another computer may update this Switchboard. */
export interface RemoteUpdateAbility {
  readonly allowed: boolean;
  /** `allowed` false: why. */
  readonly reason: RemoteUpdateBlock | null;
  /** `allowed` false: the line the UI shows instead of the Update button. */
  readonly message: string | null;
}

/** D140: the last update asked for from a phone or another computer (kept in `updates.state`). */
export interface RemoteUpdateRecord {
  readonly version: string;
  /** The version that ran when it was asked for. */
  readonly from: string;
  readonly by: { readonly kind: 'device' | 'peer'; readonly id: string; readonly name: string };
  readonly at: string;
  /** `started` until it ends: `updated` once that version started here, `failed` when it did not get there. */
  readonly outcome: 'started' | 'updated' | 'failed';
  /** `failed`: why. */
  readonly error: string | null;
}

/**
 * Additive (D140): the compact update state a computer tells its paired
 * computers (`/hub` `machineUpdate` on the peer stream; kept as
 * `Machine.update`). No folders, no release notes.
 */
export interface MachineUpdate {
  /** The version it runs. */
  readonly current: string;
  readonly kind: InstallKind;
  readonly restart: RestartMode;
  readonly remote: RemoteUpdateAbility;
  readonly checking: boolean;
  /** The newest release it knows (no notes). */
  readonly latest: { readonly version: string; readonly tag: string; readonly url: string | null } | null;
  readonly available: boolean;
  readonly lastCheck: UpdateCheck | null;
  /** Its update's progress, without the folder. */
  readonly progress: Omit<UpdateProgress, 'dir'>;
  /** Agents with a live process there (resumed after the restart). */
  readonly liveSessions: number;
  readonly lastRemote: RemoteUpdateRecord | null;
}

/** `POST /api/updates/install` and `POST /api/updates/dismiss` body. */
export interface UpdateVersionInput {
  readonly version: string;
}

/** Refusal codes of the updates routes (409 unless noted). */
export type UpdateErrorCode = 'busy' | 'git-checkout' | 'no-update' | 'stale-version' | 'checking' | 'invalid' | 'manual-restart' | 'rate-limited';

/** D140: a phone or another computer may start at most one update here per this period. */
export const REMOTE_INSTALL_INTERVAL_MS = 10 * 60_000;

/** D140: whether a phone or another computer may update an install of `kind` that restarts by `restart`. */
export function remoteUpdateAbility(kind: InstallKind, restart: RestartMode): RemoteUpdateAbility {
  if (kind === 'git') return { allowed: false, reason: 'git-checkout', message: remoteBlockText('git-checkout') };
  if (restart !== 'service') return { allowed: false, reason: 'manual-restart', message: remoteBlockText('manual-restart') };
  return { allowed: true, reason: null, message: null };
}

/** D140: the refusal of a remote update (the 409's message and the UI's line). */
export function remoteBlockText(reason: RemoteUpdateBlock): string {
  return reason === 'git-checkout'
    ? "Can't update itself here: it runs from a git checkout. Update it with git and restart it by hand."
    : "Can't update itself here: it doesn't run as its login service (Start at login). Update it there and restart it by hand.";
}

/** D140: the compact state a computer tells its paired computers. */
export function machineUpdateOf(status: UpdateStatus): MachineUpdate {
  const { dir: _dir, ...progress } = status.progress;
  return {
    current: status.current,
    kind: status.install.kind,
    restart: status.restart,
    remote: status.remote ?? remoteUpdateAbility(status.install.kind, status.restart),
    checking: status.checking,
    latest: status.latest ? { version: status.latest.version, tag: status.latest.tag, url: status.latest.url } : null,
    available: status.available,
    lastCheck: status.lastCheck,
    progress,
    liveSessions: status.liveSessions,
    lastRemote: status.lastRemote ?? null,
  };
}

const PHASES: ReadonlySet<string> = new Set<UpdatePhase>(['idle', 'downloading', 'verifying', 'extracting', 'installing', 'switching', 'restarting', 'restart-manually', 'failed']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** D140: a paired computer's `machineUpdate` payload checked field by field; `null` when it is not one. */
export function readMachineUpdate(value: unknown): MachineUpdate | null {
  if (!isObject(value)) return null;
  const { current, kind, restart, remote, progress, latest, lastCheck, lastRemote } = value;
  if (typeof current !== 'string' || (kind !== 'git' && kind !== 'release') || (restart !== 'service' && restart !== 'manual')) return null;
  if (!isObject(progress) || typeof progress['phase'] !== 'string' || !PHASES.has(progress['phase'])) return null;
  const reason: RemoteUpdateBlock | null = isObject(remote) && (remote['reason'] === 'git-checkout' || remote['reason'] === 'manual-restart') ? remote['reason'] : null;
  const ability: RemoteUpdateAbility = isObject(remote) && typeof remote['allowed'] === 'boolean'
    ? { allowed: remote['allowed'], reason, message: stringOrNull(remote['message']) }
    : remoteUpdateAbility(kind, restart);
  const release = isObject(latest) && typeof latest['version'] === 'string' && typeof latest['tag'] === 'string' ? { version: latest['version'], tag: latest['tag'], url: stringOrNull(latest['url']) } : null;
  const via: UpdateCheck['via'] = isObject(lastCheck) && (lastCheck['via'] === 'api' || lastCheck['via'] === 'gh') ? lastCheck['via'] : null;
  const check: UpdateCheck | null = isObject(lastCheck) && typeof lastCheck['at'] === 'string' && typeof lastCheck['ok'] === 'boolean'
    ? { at: lastCheck['at'], ok: lastCheck['ok'], via, error: stringOrNull(lastCheck['error']) }
    : null;
  let record: RemoteUpdateRecord | null = null;
  if (isObject(lastRemote) && isObject(lastRemote['by']) && typeof lastRemote['version'] === 'string' && typeof lastRemote['at'] === 'string') {
    const by = lastRemote['by'];
    const outcome = lastRemote['outcome'];
    if ((by['kind'] === 'device' || by['kind'] === 'peer') && typeof by['name'] === 'string' && (outcome === 'started' || outcome === 'updated' || outcome === 'failed')) {
      record = { version: lastRemote['version'], from: typeof lastRemote['from'] === 'string' ? lastRemote['from'] : '', by: { kind: by['kind'], id: typeof by['id'] === 'string' ? by['id'] : '', name: by['name'] }, at: lastRemote['at'], outcome, error: stringOrNull(lastRemote['error']) };
    }
  }
  return {
    current,
    kind,
    restart,
    remote: ability,
    checking: value['checking'] === true,
    latest: release,
    available: value['available'] === true,
    lastCheck: check,
    progress: {
      phase: progress['phase'] as UpdatePhase,
      version: stringOrNull(progress['version']),
      message: typeof progress['message'] === 'string' ? progress['message'] : '',
      error: stringOrNull(progress['error']),
      at: stringOrNull(progress['at']),
    },
    liveSessions: typeof value['liveSessions'] === 'number' && Number.isFinite(value['liveSessions']) ? Math.max(0, Math.floor(value['liveSessions'])) : 0,
    lastRemote: record,
  };
}

/** D140: "from your phone (Pixel 9)" / "from Marcins-Mac" (the Inbox item and the update log). */
export function triggerText(by: { readonly kind: 'device' | 'peer' | 'local'; readonly name?: string }): string {
  if (by.kind === 'local') return 'from this computer';
  return by.kind === 'device' ? `from your phone (${by.name ?? 'a phone'})` : `from ${by.name ?? 'another computer'}`;
}

/** D140: the remote confirm's question: "Update Marcins-PC to 2.4.3?". */
export function remoteConfirmTitle(machine: string, version: string): string {
  return `Update ${machine} to ${version}?`;
}

/** D140: the remote confirm's text. */
export function remoteConfirmText(): string {
  return 'It restarts Switchboard there; running agents resume after the restart.';
}

/** D140: how many agents run there ("2 agents are running there." / none: ''). */
export function remoteAgentsText(count: number): string {
  if (count <= 0) return 'No agents are running there.';
  return count === 1 ? '1 agent is running there.' : `${count} agents are running there.`;
}

/** An update that is running (not idle and not finished). */
export function updateRunning(progress: UpdateProgress): boolean {
  return progress.phase !== 'idle' && progress.phase !== 'failed' && progress.phase !== 'restart-manually';
}

/** The banner's line: "Switchboard 1.1.0 is available". */
export function availableText(version: string): string {
  return `Switchboard ${version} is available`;
}

/** What the banner shows, or `null` for none (no update, dismissed, nothing running). */
export function bannerState(status: UpdateStatus | null): 'available' | 'progress' | null {
  if (!status) return null;
  if (updateRunning(status.progress) || status.progress.phase === 'failed' || status.progress.phase === 'restart-manually') return 'progress';
  if (status.available && status.latest && status.dismissed !== status.latest.version) return 'available';
  return null;
}

/** The line of each phase (the banner and the dialog). */
export function phaseText(progress: UpdateProgress): string {
  const v = progress.version ?? '';
  switch (progress.phase) {
    case 'idle':
      return '';
    case 'downloading':
      return `Downloading Switchboard ${v}…`;
    case 'verifying':
      return 'Checking the SHA-256 checksum…';
    case 'extracting':
      return 'Unpacking…';
    case 'installing':
      return 'Installing dependencies (npm ci --omit=dev)…';
    case 'switching':
      return `Switching to ${v}…`;
    case 'restarting':
      return `Restarting into ${v}… Sessions resume after the restart.`;
    case 'restart-manually':
      return `Switchboard ${v} is installed. Restart Switchboard to use it.`;
    case 'failed':
      return `Update failed: ${progress.error ?? 'unknown error'}`;
  }
}

/** The confirm dialog's sentence about live sessions (none for 0). */
export function sessionsNote(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 session will be resumed after the restart.' : `${count} sessions will be resumed after the restart.`;
}

/** The confirm dialog's text for an update to `version`. */
export function confirmText(version: string, restart: RestartMode): string {
  const steps = `Switchboard downloads ${version}, checks its SHA-256 checksum, installs its dependencies and switches to it; this install stays for a rollback.`;
  return restart === 'service'
    ? `${steps} Then it restarts through its login service.`
    : `${steps} Switchboard is not running as the login service here, so you restart it yourself afterwards.`;
}

/** The commands a git checkout updates with (D55: git checkouts are only notified). */
export function gitUpdateCommands(tag: string): string[] {
  return [`git fetch --tags origin`, `git merge --ff-only ${tag}    # or: git pull --ff-only`, 'npm ci', 'npm run build', '# then restart Switchboard'];
}

/** How to start an installed version by hand: `cd "<dir>" && npm start`. */
export function manualStartCommand(dir: string): string {
  return `cd "${dir}" && npm start`;
}

/** Settings → Updates "Install" value: `release install` / `git checkout`. */
export function installKindLabel(kind: InstallKind): string {
  return kind === 'git' ? 'git checkout' : 'release install';
}

/** Settings → Updates "Last check" value (`at` already formatted by the caller). */
export function lastCheckText(check: UpdateCheck | null, at: string): string {
  if (!check) return 'not checked yet';
  if (!check.ok) return `${at} · failed`;
  return `${at} · ${check.via === 'gh' ? 'through gh' : 'GitHub API'}`;
}
