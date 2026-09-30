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
}

/** `POST /api/updates/install` and `POST /api/updates/dismiss` body. */
export interface UpdateVersionInput {
  readonly version: string;
}

/** Refusal codes of the updates routes (409 unless noted). */
export type UpdateErrorCode = 'busy' | 'git-checkout' | 'no-update' | 'stale-version' | 'checking' | 'invalid';

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
