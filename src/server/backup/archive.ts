import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { createGunzip, createGzip } from 'node:zlib';
import { BACKUP_FORMAT, type BackupChecksum, type BackupConversation, type BackupFolder, type BackupPreview } from '../../core/backup.ts';
import { defaultDir } from '../accounts/share.ts';
import { findCodexRollout } from '../cli/handover.ts';
import { JIRA_SECRET_REF } from '../plans/jira/credentials.ts';
import type { SecretRef, SecretStore } from '../team/access/secret-store.ts';
import { type EntrySource, PreviewRead, readContainer, writeContainer } from './container.ts';
import { type BackupHeader, type BackupKey, decryptStage, encryptStage } from './crypto.ts';

/**
 * D168 · making and reading a backup (`docs/backup.md`): what goes into the archive (the four
 * databases as consistent snapshots, the data folder's own files, every agent's CLI conversation
 * kept outside it, the keychain values Switchboard put there), the preview, and the encrypted
 * file. Reading: the preview alone (Inspect), or everything into a staging folder, checked.
 */

/** The databases, by file name, in the data folder. */
export const BACKUP_DATABASES = ['switchboard.db', 'plans.db', 'team.db', 'memory.db'] as const;

/** The data folder's own entries that travel (folders and files); the rest is machine-specific or rebuilt. */
export const BACKUP_DATA_DIRS = ['attachments', 'artifacts', 'chats', 'handovers', 'profiles'] as const;
/** The data folder's own files that travel (the restore keeps the new computer's when it starts as a new computer). */
export const BACKUP_DATA_FILES = ['sb_token', 'hook-token', 'vapid.json'] as const;

/** What a backup is made from. */
export interface BackupSource {
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly version: string;
  readonly platform?: NodeJS.Platform;
  /** The keychain Switchboard writes to (`null`: no secrets travel). */
  readonly secrets: SecretStore | null;
  readonly now?: () => Date;
}

/** What a finished backup reports. */
export interface BackupResult {
  readonly file: string;
  readonly size: number;
  readonly preview: BackupPreview;
  readonly entries: number;
  /** Symbolic links in the data folder, not followed and left out (an account's shared settings: re-linked by Settings → Accounts). */
  readonly skippedLinks: number;
}

function quoteSql(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** A consistent copy of a live database (`VACUUM INTO`: never the raw file next to its WAL). */
export function snapshotDatabase(file: string, into: string): void {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec(`VACUUM INTO ${quoteSql(into)}`);
  } finally {
    db.close();
  }
}

function inside(parent: string, child: string): string | null {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** Every regular file under `dir` (links and special files are counted, never followed). */
async function* walkFiles(dir: string, counts: { links: number }): AsyncGenerator<{ readonly abs: string; readonly size: number }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      counts.links += 1;
      continue;
    }
    if (entry.isDirectory()) {
      yield* walkFiles(abs, counts);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await lstat(abs).catch(() => null);
    if (info?.isFile()) yield { abs, size: info.size };
  }
}

/** Finds a Claude Code transcript `<sid>.jsonl` under `<configDir>/projects/*\/`. */
async function findClaudeTranscript(configDirs: readonly string[], claudeSessionId: string): Promise<string | null> {
  for (const dir of configDirs) {
    const projects = path.join(dir, 'projects');
    let slugs;
    try {
      slugs = await readdir(projects, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const file = path.join(projects, slug.name, `${claudeSessionId}.jsonl`);
      if (await exists(file)) return file;
    }
  }
  return null;
}

interface SnapshotFacts {
  readonly folders: BackupFolder[];
  readonly sessions: Array<{ id: string; provider: string; profileId: string | null; cwd: string | null; claudeSessionId: string; transcriptPath: string | null; closed: boolean }>;
  readonly profiles: Array<{ id: string; cli: string; dir: string | null }>;
  readonly natives: Map<string, string>;
  readonly self: { id: string | null; name: string | null };
  readonly artifacts: number;
  readonly attachments: number;
}

function readMain(file: string): SnapshotFacts {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = <T>(sql: string): T[] => db.prepare(sql).all() as unknown as T[];
    const has = (table: string): boolean => (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as unknown) !== undefined;
    const folders = has('folders') ? rows<{ id: string; path: string; kind: string; label: string | null }>('SELECT id, path, kind, label FROM folders ORDER BY path') : [];
    const sessions = rows<{ id: string; provider: string | null; profile_id: string | null; cwd: string | null; claude_session_id: string; transcript_path: string | null; closed_at: string | null }>(
      'SELECT id, provider, profile_id, cwd, claude_session_id, transcript_path, closed_at FROM sessions',
    ).map((row) => ({ id: row.id, provider: row.provider ?? 'claude', profileId: row.profile_id, cwd: row.cwd, claudeSessionId: row.claude_session_id, transcriptPath: row.transcript_path, closed: row.closed_at !== null }));
    const profiles = has('cli_profiles') ? rows<{ id: string; cli: string; dir: string | null }>('SELECT id, cli, dir FROM cli_profiles') : [];
    const natives = new Map<string, string>();
    if (has('session_providers')) for (const row of rows<{ session_id: string; native_id: string | null }>("SELECT session_id, native_id FROM session_providers WHERE provider = 'codex'")) if (row.native_id) natives.set(row.session_id, row.native_id);
    let self: { id: string | null; name: string | null } = { id: null, name: null };
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'peers.self'").get() as { value?: string } | undefined;
    if (stored?.value) {
      try {
        const parsed = JSON.parse(stored.value) as { id?: unknown; name?: unknown };
        self = { id: typeof parsed.id === 'string' ? parsed.id : null, name: typeof parsed.name === 'string' ? parsed.name : null };
      } catch {
        // unreadable: no identity known
      }
    }
    const count = (table: string): number => (has(table) ? Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n) : 0);
    return { folders, sessions, profiles, natives, self, artifacts: count('artifacts'), attachments: count('attachments') };
  } finally {
    db.close();
  }
}

function countRows(file: string, table: string, where = ''): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
    return has ? Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n) : 0;
  } finally {
    db.close();
  }
}

/** The keychain references Switchboard wrote: Jira's, and every Team access field's (`team.db`). */
function secretRefs(teamDb: string | null): SecretRef[] {
  const refs: SecretRef[] = [JIRA_SECRET_REF];
  if (!teamDb) return refs;
  const db = new DatabaseSync(teamDb, { readOnly: true });
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'access'").get() !== undefined;
    if (!has) return refs;
    for (const row of db.prepare('SELECT data FROM access WHERE deleted = 0').all() as Array<{ data: string }>) {
      try {
        const data = JSON.parse(row.data) as { secretRefs?: Array<{ service?: unknown; account?: unknown }> };
        for (const ref of data.secretRefs ?? []) if (typeof ref.service === 'string' && typeof ref.account === 'string') refs.push({ service: ref.service, account: ref.account });
      } catch {
        // an unreadable record carries no reference
      }
    }
  } finally {
    db.close();
  }
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.service}\u0000${ref.account}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Makes a backup of `source` into `out` (written next to it first, renamed when complete), encrypted
 * with `key`. The databases are snapshotted first (`VACUUM INTO`), so a running Switchboard can be
 * backed up. Returns what went in.
 */
export async function createBackup(source: BackupSource, out: string, key: BackupKey): Promise<BackupResult> {
  const tmp = path.join(source.dataDir, `.backup-tmp-${randomBytes(6).toString('hex')}`);
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  const partial = `${out}.partial-${randomBytes(4).toString('hex')}`;
  try {
    const snapshots = new Map<string, string>();
    for (const name of BACKUP_DATABASES) {
      const file = path.join(source.dataDir, name);
      if (!(await exists(file))) continue;
      const into = path.join(tmp, name);
      snapshotDatabase(file, into);
      snapshots.set(name, into);
    }
    const main = snapshots.get('switchboard.db');
    if (!main) throw new Error(`there is no Switchboard database in ${source.dataDir}`);
    const facts = readMain(main);
    // The CLI folders: the Default's (outside the data folder) and each account's (inside it).
    const claudeDefault = defaultDir('claude', source.env, source.home);
    const codexDefault = defaultDir('codex', source.env, source.home);
    const profileDir = new Map(facts.profiles.map((profile) => [profile.id, profile]));
    const claudeDirs = [claudeDefault, ...facts.profiles.filter((profile) => profile.cli === 'claude' && profile.dir).map((profile) => profile.dir as string)].filter((dir): dir is string => dir !== null);
    const conversations: BackupConversation[] = [];
    const extra: EntrySource[] = [];
    for (const session of facts.sessions) {
      if (session.provider === 'claude') {
        const transcript = session.transcriptPath && (await exists(session.transcriptPath)) ? session.transcriptPath : await findClaudeTranscript(claudeDirs, session.claudeSessionId);
        if (!transcript) continue;
        const rel = inside(source.dataDir, transcript);
        if (rel) {
          conversations.push({ sessionId: session.id, provider: 'claude', profileId: session.profileId, cwd: session.cwd, claudeSessionId: session.claudeSessionId, location: 'profile', relative: rel });
          continue;
        }
        const base = `cli/claude/${session.id}`;
        extra.push({ kind: 'file', name: `${base}/${session.claudeSessionId}.jsonl`, path: transcript });
        const counts = { links: 0 };
        const folder = path.join(path.dirname(transcript), session.claudeSessionId);
        for await (const file of walkFiles(folder, counts)) {
          const sub = inside(folder, file.abs);
          if (sub) extra.push({ kind: 'file', name: `${base}/${session.claudeSessionId}/${sub}`, path: file.abs, size: file.size });
        }
        conversations.push({ sessionId: session.id, provider: 'claude', profileId: session.profileId, cwd: session.cwd, claudeSessionId: session.claudeSessionId, location: 'archive', relative: null });
      } else if (session.provider === 'codex') {
        const native = facts.natives.get(session.id);
        if (!native) continue;
        const profile = session.profileId ? profileDir.get(session.profileId) : undefined;
        const home = profile && profile.cli === 'codex' && profile.dir ? profile.dir : codexDefault;
        if (!home) continue;
        const rollout = await findCodexRollout({ CODEX_HOME: home }, native).catch(() => null);
        if (!rollout) continue;
        const rel = inside(source.dataDir, rollout);
        const underSessions = inside(path.join(home, 'sessions'), rollout);
        if (!underSessions) continue;
        if (rel) {
          conversations.push({ sessionId: session.id, provider: 'codex', profileId: session.profileId, cwd: session.cwd, claudeSessionId: session.claudeSessionId, location: 'profile', relative: underSessions });
        } else {
          extra.push({ kind: 'file', name: `cli/codex/${session.id}/${underSessions}`, path: rollout });
          conversations.push({ sessionId: session.id, provider: 'codex', profileId: session.profileId, cwd: session.cwd, claudeSessionId: session.claudeSessionId, location: 'archive', relative: underSessions });
        }
      }
    }
    // The keychain values (only when the keychain answers them).
    const secrets: Array<{ service: string; account: string; value: string }> = [];
    if (source.secrets) {
      for (const ref of secretRefs(snapshots.get('team.db') ?? null)) {
        const value = await source.secrets.get(ref).catch(() => null);
        if (typeof value === 'string' && value !== '') secrets.push({ service: ref.service, account: ref.account, value });
      }
    }
    const plansDb = snapshots.get('plans.db');
    const teamDb = snapshots.get('team.db');
    const preview: BackupPreview = {
      format: BACKUP_FORMAT,
      switchboardVersion: source.version,
      createdAt: (source.now?.() ?? new Date()).toISOString(),
      platform: source.platform ?? process.platform,
      machineName: facts.self.name,
      machineId: facts.self.id,
      home: source.home,
      dataDir: path.resolve(source.dataDir),
      cliDirs: { claude: claudeDefault, codex: codexDefault },
      folders: facts.folders,
      conversations,
      counts: {
        agents: facts.sessions.length,
        openAgents: facts.sessions.filter((session) => !session.closed).length,
        folders: facts.folders.length,
        projects: plansDb ? countRows(plansDb, 'plans') : 0,
        crews: teamDb ? countRows(teamDb, 'teams') : 0,
        artifacts: facts.artifacts,
        attachments: facts.attachments,
        secrets: secrets.length,
      },
    };
    const counts = { links: 0 };
    let entries = 0;
    const dataDir = source.dataDir;
    async function* all(): AsyncGenerator<EntrySource> {
      yield { kind: 'json', role: 'preview', value: preview };
      for (const [name, file] of snapshots) {
        entries += 1;
        yield { kind: 'file', name: `db/${name}`, path: file };
      }
      for (const name of BACKUP_DATA_FILES) {
        const file = path.join(dataDir, name);
        const info = await lstat(file).catch(() => null);
        if (!info?.isFile()) continue;
        entries += 1;
        yield { kind: 'file', name: `data/${name}`, path: file, size: info.size };
      }
      for (const dir of BACKUP_DATA_DIRS) {
        for await (const file of walkFiles(path.join(dataDir, dir), counts)) {
          const rel = inside(dataDir, file.abs);
          if (!rel) continue;
          entries += 1;
          yield { kind: 'file', name: `data/${rel}`, path: file.abs, size: file.size };
        }
      }
      for (const entry of extra) {
        entries += 1;
        yield entry;
      }
      if (secrets.length > 0) {
        entries += 1;
        yield { kind: 'bytes', name: 'secrets.json', bytes: Buffer.from(JSON.stringify(secrets), 'utf8') };
      }
    }
    await mkdir(path.dirname(out), { recursive: true });
    await pipeline(Readable.from(writeContainer(all())), createGzip({ level: 6 }), encryptStage(key), createWriteStream(partial, { mode: 0o600 }));
    await rename(partial, out);
    const size = (await stat(out)).size;
    return { file: out, size, preview, entries, skippedLinks: counts.links };
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Reads only the preview of `file` (the passphrase is checked; nothing is written). */
export async function readBackupPreview(file: string, keyOf: (header: BackupHeader) => Promise<Buffer>): Promise<BackupPreview> {
  try {
    await pipeline(createReadStream(file), decryptStage(keyOf), createGunzip(), async (source: AsyncIterable<Buffer>) => {
      await readContainer(source, { previewOnly: true });
    });
  } catch (error) {
    if (error instanceof PreviewRead) return error.preview as BackupPreview;
    throw error;
  }
  throw new Error('the backup has no preview');
}

/** Reads all of `file` into `into` (a new folder), checking every checksum; nothing else is touched. */
export async function extractBackup(file: string, keyOf: (header: BackupHeader) => Promise<Buffer>, into: string): Promise<{ readonly preview: BackupPreview; readonly checksums: readonly BackupChecksum[] }> {
  await mkdir(into, { recursive: true, mode: 0o700 });
  let read: { preview: unknown; checksums: readonly BackupChecksum[] } | null = null;
  await pipeline(createReadStream(file), decryptStage(keyOf), createGunzip(), async (source: AsyncIterable<Buffer>) => {
    read = await readContainer(source, { into });
  });
  const done = read as { preview: unknown; checksums: readonly BackupChecksum[] } | null;
  if (!done) throw new Error('the backup could not be read');
  return { preview: done.preview as BackupPreview, checksums: done.checksums };
}
