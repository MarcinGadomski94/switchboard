/**
 * D168 · backup and restore (`docs/backup.md`): the pure rules. The archive's format
 * version and manifest, which Switchboard may restore which backup, the entry names an
 * archive may hold, and how a path of the old computer is mapped onto the new one.
 * No files, no crypto here: `src/server/backup/` does those.
 */

/** The archive format this build writes and reads. */
export const BACKUP_FORMAT = 1;

/** The file name extension of a backup. */
export const BACKUP_EXTENSION = '.sbbackup';

/** Automatic backups: how many are kept by default (ASSUMED D168: the developer may change it). */
export const BACKUP_KEEP_DEFAULT = 7;

/** Automatic backups: how often (a day). */
export const BACKUP_INTERVAL_MS = 24 * 3600_000;

/** Settings key: the automatic backups' switch, folder and count (`docs/backup.md`). */
export const BACKUP_AUTO_SETTING = 'backup.auto';

/** Settings key: the last backup's outcome (manual or automatic). */
export const BACKUP_STATE_SETTING = 'backup.state';

/** The automatic backups' settings. */
export interface BackupAutoSettings {
  readonly enabled: boolean;
  /** The folder the automatic backups go to (absolute), `null` = the default (`<home>/SwitchboardBackups`). */
  readonly folder: string | null;
  readonly keep: number;
}

/** The automatic backups' settings as stored (defensive). */
export function readBackupAuto(value: unknown): BackupAutoSettings {
  const input = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const keep = typeof input['keep'] === 'number' && Number.isInteger(input['keep']) && input['keep'] >= 1 && input['keep'] <= 100 ? input['keep'] : BACKUP_KEEP_DEFAULT;
  return { enabled: input['enabled'] === true, folder: typeof input['folder'] === 'string' && input['folder'].trim() !== '' ? input['folder'] : null, keep };
}

/** One saved folder of the old computer, as the restore lists it for mapping. */
export interface BackupFolder {
  readonly id: string;
  readonly path: string;
  readonly kind: string;
  readonly label: string | null;
}

/** Where an agent's CLI conversation is in the archive, and how the restore places it. */
export interface BackupConversation {
  readonly sessionId: string;
  readonly provider: 'claude' | 'codex';
  /** The account profile (D63) the session runs on; `null` = the CLI's Default. */
  readonly profileId: string | null;
  /** The session's working folder on the old computer (its cwd: the transcript's project slug). */
  readonly cwd: string | null;
  readonly claudeSessionId: string;
  /**
   * `archive`: copied into the archive under `cli/<provider>/<sessionId>/` (the CLI's Default
   * folder, outside the data folder); `profile`: already inside `data/profiles/…` (an account's
   * own folder), at {@link relative} (from the data folder, `/`-separated).
   */
  readonly location: 'archive' | 'profile';
  /** `profile`: the transcript's path from the data folder (`profiles/claude/<id>/projects/<slug>/<sid>.jsonl`); `archive` (Codex): its path under `sessions/`. */
  readonly relative: string | null;
}

/** The archive's first entry: what the restore shows before anything is written (no hashes: those are at the end). */
export interface BackupPreview {
  readonly format: number;
  readonly switchboardVersion: string;
  readonly createdAt: string;
  /** The old computer's OS (`win32`, `darwin`, `linux`) and its name (D48's), for the restore's words. */
  readonly platform: NodeJS.Platform;
  readonly machineName: string | null;
  readonly machineId: string | null;
  readonly home: string;
  readonly dataDir: string;
  /** The old computer's CLI Default folders (`~/.claude`, `~/.codex`): mapped onto this one's. */
  readonly cliDirs: { readonly claude: string | null; readonly codex: string | null };
  readonly folders: readonly BackupFolder[];
  readonly conversations: readonly BackupConversation[];
  readonly counts: { readonly agents: number; readonly openAgents: number; readonly folders: number; readonly projects: number; readonly crews: number; readonly artifacts: number; readonly attachments: number; readonly secrets: number };
}

/** One entry's checksum (the archive's last entry lists them all). */
export interface BackupChecksum {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/** `[major, minor, patch]` of `x.y.z`, `null` for anything else. */
export function semver(text: string): readonly [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** -1 / 0 / 1 as `a` is older / the same / newer than `b` (unreadable versions compare equal). */
export function compareVersions(a: string, b: string): number {
  const x = semver(a);
  const y = semver(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if ((x[i] as number) !== (y[i] as number)) return (x[i] as number) < (y[i] as number) ? -1 : 1;
  return 0;
}

/**
 * Whether this Switchboard (`running`) may restore a backup: the same format, and a backup from
 * this version or an older one (its databases are then migrated at the next start). A backup
 * from a newer Switchboard is refused: its databases may hold migrations this one does not know.
 */
export function restoreRefusal(preview: Pick<BackupPreview, 'format' | 'switchboardVersion'>, running: string): string | null {
  if (preview.format !== BACKUP_FORMAT) return `this backup has format ${preview.format}; this Switchboard reads format ${BACKUP_FORMAT}`;
  if (compareVersions(preview.switchboardVersion, running) > 0) return `this backup was made by Switchboard ${preview.switchboardVersion}, newer than this one (${running}): update Switchboard here first`;
  return null;
}

/**
 * An archive entry's name, checked: relative, `/`-separated, no `.` / `..` / empty segment, no
 * drive or backslash, under one of the known roots. `null` when it is not one (the restore stops:
 * a name like that never comes from a backup Switchboard wrote).
 */
export function safeEntryName(name: unknown): string | null {
  if (typeof name !== 'string' || name === '' || name.length > 4096) return null;
  if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  const root = parts[0];
  if (root !== 'data' && root !== 'db' && root !== 'cli' && root !== 'secrets.json') return null;
  if (root === 'secrets.json' && parts.length !== 1) return null;
  if (root !== 'secrets.json' && parts.length < 2) return null;
  return name;
}

/** One mapping of an old path (a folder, the data folder, a CLI folder) onto this computer's. */
export interface PathMap {
  readonly from: string;
  readonly to: string;
}

/** Whether a path is a Windows path (`C:\…`, `\\server\…`). */
export function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function trimEnd(value: string): string {
  let out = value;
  while (out.length > 1 && (out.endsWith('/') || out.endsWith('\\')) && !/^[A-Za-z]:[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/**
 * `value` mapped by the first map (the longest `from` first) it equals or lies under, else
 * `null`. Windows paths compare without regard to case and separator; the rest of the path
 * after the matched prefix takes the separator of `to` (a `D:\code\app` mapped `D:\code` →
 * `/Users/me/code` gives `/Users/me/code/app`).
 */
export function mapPath(value: string, maps: readonly PathMap[]): string | null {
  if (value === '') return null;
  const sorted = [...maps].filter((map) => map.from !== '' && map.to !== '').sort((a, b) => b.from.length - a.from.length);
  for (const map of sorted) {
    const from = trimEnd(map.from);
    const windows = isWindowsPath(from);
    const norm = (text: string): string => (windows ? text.replace(/\//g, '\\').toLowerCase() : text);
    const head = norm(value.slice(0, from.length));
    if (head !== norm(from)) continue;
    const rest = value.slice(from.length);
    if (rest !== '' && rest[0] !== '/' && rest[0] !== '\\') continue;
    const to = trimEnd(map.to);
    const sep = isWindowsPath(to) ? '\\' : '/';
    const tail = rest.replace(/[\\/]+/g, sep);
    return `${to}${tail}`;
  }
  return null;
}

/** Every string inside a JSON value mapped by {@link mapPath} (others unchanged); `changed` says whether any was. */
export function mapJsonPaths(value: unknown, maps: readonly PathMap[]): { readonly value: unknown; readonly changed: boolean } {
  let changed = false;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const mapped = mapPath(node, maps);
      if (mapped !== null && mapped !== node) {
        changed = true;
        return mapped;
      }
      return node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, inner]) => [key, walk(inner)]));
    return node;
  };
  const out = walk(value);
  return { value: out, changed };
}

/**
 * A stored text that may be a path or a JSON document, mapped: JSON is walked, a plain string
 * mapped as a path; `null` when nothing changed.
 */
export function mapStoredText(text: string, maps: readonly PathMap[]): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const mapped = mapJsonPaths(parsed, maps);
      return mapped.changed ? JSON.stringify(mapped.value) : null;
    } catch {
      // not JSON: a plain string below
    }
  }
  const mapped = mapPath(text, maps);
  return mapped !== null && mapped !== text ? mapped : null;
}

/** `--map old=new` (the CLI) read; the first `=` that is not part of a Windows drive splits. */
export function parseMapArgument(text: string): PathMap | null {
  // A Windows `from` has `C:` (no `=` there); split at the first `=`.
  const at = text.indexOf('=');
  if (at <= 0 || at === text.length - 1) return null;
  return { from: text.slice(0, at).trim(), to: text.slice(at + 1).trim() };
}

/** The file name of a backup made at `at` (`switchboard-backup-2026-11-17-0930.sbbackup`). */
export function backupFileName(at: Date, tag = ''): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `switchboard-backup-${stamp}${tag ? `-${tag}` : ''}${BACKUP_EXTENSION}`;
}

/** Whether a file name is one of the automatic backups this folder keeps a count of. */
export function isBackupFileName(name: string): boolean {
  return /^switchboard-backup-\d{4}-\d{2}-\d{2}-\d{6}(?:-[a-z]+)?\.sbbackup$/.test(name);
}

/** The automatic backups to remove: all but the newest `keep` (names sort by time). */
export function backupsToPrune(names: readonly string[], keep: number): string[] {
  const own = names.filter((name) => name.includes('-auto') && isBackupFileName(name)).sort();
  return own.slice(0, Math.max(0, own.length - keep));
}

/** The restore's report (shown after the restart and printed by the CLI). */
export interface RestoreReport {
  readonly at: string;
  readonly ok: boolean;
  readonly error: string | null;
  readonly fromVersion: string;
  readonly fromMachine: string | null;
  readonly agents: number;
  readonly folders: number;
  readonly remapped: number;
  readonly missingFolders: readonly string[];
  readonly conversations: number;
  readonly conversationsMissing: number;
  readonly secrets: number;
  readonly secretsFailed: number;
  readonly identity: 'keep' | 'new';
  /** Where the data that was here before is kept (the safety copy). */
  readonly previousData: string | null;
  /** What needs the developer: sign in to the CLIs, re-pair, … */
  readonly todo: readonly string[];
}
