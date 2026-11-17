import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type BackupPreview, type PathMap, type RestoreReport, mapPath, mapStoredText, restoreRefusal } from '../../core/backup.ts';
import { slugForCwd } from '../../core/transcript.ts';
import { defaultDir } from '../accounts/share.ts';
import { newMachineId } from '../peers/tokens.ts';
import type { SecretStore } from '../team/access/secret-store.ts';
import { BACKUP_DATABASES, BACKUP_DATA_DIRS, BACKUP_DATA_FILES, extractBackup } from './archive.ts';
import type { BackupHeader } from './crypto.ts';

/**
 * D168 · restoring a backup into a fresh install (`docs/backup.md` → *Restoring*):
 * 1. **stage**: the whole file is decrypted into a folder next to the data folder and every
 *    checksum checked (a wrong passphrase or a damaged file: nothing is written anywhere else);
 * 2. **prepare**: the old computer's paths are mapped onto this one's (the data folder, the CLI
 *    folders, and the developer's folder mappings) in the staged databases; each agent's CLI
 *    conversation is put where this computer's CLI looks for it (`projects/<new cwd's slug>`);
 *    "start as a new computer" gives this install a new identity and leaves pairings and phones out;
 * 3. **apply** (Switchboard stopped): the data folder's entries are swapped for the staged ones in
 *    one go: the ones here move aside to `.pre-restore-<time>` first and come back if anything
 *    fails. Then the conversations outside the data folder and the keychain values are written,
 *    and the report is kept in `restore-report.json`.
 */

/** The folder a prepared restore waits in (applied at the next start: `applyPendingRestore`). */
export const RESTORE_PENDING_DIR = 'restore-pending';
/** The report of the last restore (read by Settings → Backup after the restart). */
export const RESTORE_REPORT_FILE = 'restore-report.json';

/** The new computer's side of a restore. */
export interface RestoreTarget {
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly version: string;
  readonly platform?: NodeJS.Platform;
  readonly secrets: SecretStore | null;
}

/** The developer's choices. */
export interface RestoreChoices {
  /** Folder mappings (old path → path on this computer). */
  readonly maps: readonly PathMap[];
  /** `keep`: take over the old computer's identity (pairings and phones keep working: only when the old one is retired); `new`: start as a new computer (re-pair). */
  readonly identity: 'keep' | 'new';
  /** Restore over an install that already has agents (its data is kept aside). */
  readonly replace: boolean;
  /** Restore even though some saved folders do not exist here (they stay saved as missing). */
  readonly allowMissing: boolean;
}

/** Why a restore was refused or failed. */
export class RestoreError extends Error {
  readonly code: 'newer-backup' | 'not-fresh' | 'missing-folders' | 'invalid' | 'failed';
  readonly detail: unknown;
  constructor(code: RestoreError['code'], message: string, detail: unknown = null) {
    super(message);
    this.name = 'RestoreError';
    this.code = code;
    this.detail = detail;
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** The automatic mappings: the data folder and the CLIs' Default folders. */
export function automaticMaps(preview: BackupPreview, target: RestoreTarget): PathMap[] {
  const maps: PathMap[] = [{ from: preview.dataDir, to: path.resolve(target.dataDir) }];
  const claude = defaultDir('claude', target.env, target.home);
  const codex = defaultDir('codex', target.env, target.home);
  if (preview.cliDirs.claude && claude) maps.push({ from: preview.cliDirs.claude, to: claude });
  if (preview.cliDirs.codex && codex) maps.push({ from: preview.cliDirs.codex, to: codex });
  return maps;
}

/** The saved folders that do not exist on this computer after the mappings (the restore asks for them). */
export async function missingFolders(preview: BackupPreview, maps: readonly PathMap[]): Promise<Array<{ readonly from: string; readonly to: string }>> {
  const out: Array<{ from: string; to: string }> = [];
  for (const folder of preview.folders) {
    const to = mapPath(folder.path, maps) ?? folder.path;
    if (!(await exists(to))) out.push({ from: folder.path, to });
  }
  return out;
}

/** How many agents this install has (a fresh install has none). */
export function agentsHere(dataDir: string): number {
  const file = path.join(dataDir, 'switchboard.db');
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return Number((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n);
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/** Columns that hold one path. */
const PATH_COLUMNS = new Set(['cwd', 'root', 'path', 'canonical_path', 'repo_path', 'dir', 'progress_path', 'export_path', 'folder', 'scope', 'scope_key']);
/** Columns that hold JSON (or a plain string) that may contain paths. */
const JSON_COLUMNS = new Set(['extra_dirs', 'template', 'data', 'repos', 'solutions', 'entry', 'value', 'look_at', 'answers', 'context']);
/** Tables whose rows are rebuilt (caches, a peer's last known lists) or are the agents' own words (never rewritten). */
const SKIP_TABLES = new Set(['events', 'history_cache', 'peer_snapshots', 'search_items', 'search_state', 'schema_migrations']);

/** Maps every path column and JSON document of a staged database; answers how many values changed. */
export function rewriteDatabase(file: string, maps: readonly PathMap[], replaceExact: ReadonlyMap<string, string> = new Map()): number {
  const db = new DatabaseSync(file);
  let changed = 0;
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_fts%'").all() as Array<{ name: string }>).map((row) => row.name);
    db.exec('BEGIN');
    for (const table of tables) {
      if (SKIP_TABLES.has(table)) continue;
      const columns = (db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string; type: string }>).filter((column) => /TEXT/i.test(column.type) || column.type === '');
      for (const column of columns) {
        const pathLike = PATH_COLUMNS.has(column.name);
        const jsonLike = JSON_COLUMNS.has(column.name);
        const machine = replaceExact.size > 0 && (column.name === 'machine_id' || jsonLike);
        if (!pathLike && !jsonLike && !machine) continue;
        let rows: Array<{ rid: number; v: string }>;
        try {
          rows = db.prepare(`SELECT rowid AS rid, ${JSON.stringify(column.name)} AS v FROM ${JSON.stringify(table)} WHERE ${JSON.stringify(column.name)} IS NOT NULL`).all() as Array<{ rid: number; v: string }>;
        } catch {
          continue;
        }
        const update = db.prepare(`UPDATE ${JSON.stringify(table)} SET ${JSON.stringify(column.name)} = ? WHERE rowid = ?`);
        for (const row of rows) {
          if (typeof row.v !== 'string') continue;
          let next: string | null = pathLike || jsonLike ? mapStoredText(row.v, maps) : null;
          const base = next ?? row.v;
          if (replaceExact.size > 0) {
            let swapped = base;
            for (const [from, to] of replaceExact) if (swapped.includes(from)) swapped = swapped.split(from).join(to);
            if (swapped !== base) next = swapped;
          }
          if (next !== null && next !== row.v) {
            update.run(next, row.rid);
            changed += 1;
          }
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // no transaction left
    }
    throw error;
  } finally {
    db.close();
  }
  return changed;
}

/** One conversation file to copy after the swap (into a CLI folder outside the data folder). */
interface Placement {
  readonly from: string;
  readonly to: string;
}

/** What `prepare` decided (stored next to the staged files; `apply` reads it). */
export interface RestorePlan {
  readonly preview: BackupPreview;
  readonly choices: RestoreChoices;
  readonly maps: readonly PathMap[];
  readonly placements: readonly Placement[];
  readonly conversations: number;
  readonly conversationsMissing: number;
  readonly missingFolders: readonly string[];
  readonly remapped: number;
  readonly newMachineId: string | null;
}

function slugOf(relative: string): { readonly before: string; readonly slugIndex: number } | null {
  const parts = relative.split('/');
  const at = parts.indexOf('projects');
  return at >= 0 && at + 1 < parts.length ? { before: parts.slice(0, at + 1).join('/'), slugIndex: at + 1 } : null;
}

/**
 * Stages and prepares a restore of `file` into `staging` (a new folder on the data folder's drive).
 * Throws {@link RestoreError} for a refusal (a newer backup, agents here without `replace`, missing
 * folders without `allowMissing`) and the crypto / container errors for a wrong passphrase or a
 * damaged file; in every case nothing outside `staging` was touched.
 */
export async function prepareRestore(file: string, keyOf: (header: BackupHeader) => Promise<Buffer>, target: RestoreTarget, choices: RestoreChoices, staging: string): Promise<RestorePlan> {
  if (!choices.replace && agentsHere(target.dataDir) > 0) throw new RestoreError('not-fresh', 'this Switchboard already has agents: restore replaces everything here (its data is kept aside first); confirm to go on');
  await rm(staging, { recursive: true, force: true });
  const { preview } = await extractBackup(file, keyOf, staging);
  const refusal = restoreRefusal(preview, target.version);
  if (refusal) throw new RestoreError('newer-backup', refusal);
  const maps = [...choices.maps, ...automaticMaps(preview, target)];
  const missing = await missingFolders(preview, maps);
  if (missing.length > 0 && !choices.allowMissing) throw new RestoreError('missing-folders', `${missing.length} saved folder${missing.length === 1 ? ' does' : 's do'} not exist here: map ${missing.length === 1 ? 'it' : 'them'} to a folder on this computer`, missing);
  // The conversations: where each goes on this computer.
  const placements: Placement[] = [];
  const transcriptPath = new Map<string, string | null>();
  let missingConversations = 0;
  const claudeDefault = defaultDir('claude', target.env, target.home);
  const codexDefault = defaultDir('codex', target.env, target.home);
  const profileDirs = readProfileDirs(path.join(staging, 'db', 'switchboard.db'));
  for (const conversation of preview.conversations) {
    const cwd = conversation.cwd ? (mapPath(conversation.cwd, maps) ?? conversation.cwd) : null;
    if (conversation.provider === 'claude') {
      if (conversation.location === 'profile' && conversation.relative) {
        const slot = slugOf(conversation.relative);
        const stagedFile = path.join(staging, 'data', ...conversation.relative.split('/'));
        if (!slot || !(await exists(stagedFile))) {
          missingConversations += 1;
          continue;
        }
        let relative = conversation.relative;
        if (cwd) {
          const parts = conversation.relative.split('/');
          const newSlug = slugForCwd(cwd);
          if (parts[slot.slugIndex] !== newSlug) {
            parts[slot.slugIndex] = newSlug;
            relative = parts.join('/');
            const to = path.join(staging, 'data', ...relative.split('/'));
            await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
            await rename(stagedFile, to);
            const sub = path.join(path.dirname(stagedFile), conversation.claudeSessionId);
            if (await exists(sub)) await rename(sub, path.join(path.dirname(to), conversation.claudeSessionId));
          }
        }
        transcriptPath.set(conversation.sessionId, path.join(path.resolve(target.dataDir), ...relative.split('/')));
        continue;
      }
      // Copied from the old computer's Default folder: into this computer's (the account's when it has its own).
      const base = path.join(staging, 'cli', 'claude', conversation.sessionId);
      const main = path.join(base, `${conversation.claudeSessionId}.jsonl`);
      const account = conversation.profileId ? profileDirs.get(conversation.profileId) : undefined;
      const configDir = account && account.cli === 'claude' && account.dir ? (mapPath(account.dir, maps) ?? account.dir) : claudeDefault;
      if (!cwd || !configDir || !(await exists(main))) {
        missingConversations += 1;
        continue;
      }
      const project = path.join(configDir, 'projects', slugForCwd(cwd));
      for (const fileIn of await listFiles(base)) {
        const rel = path.relative(base, fileIn);
        placements.push({ from: fileIn, to: path.join(project, rel) });
      }
      transcriptPath.set(conversation.sessionId, path.join(project, `${conversation.claudeSessionId}.jsonl`));
    } else if (conversation.provider === 'codex' && conversation.location === 'archive' && conversation.relative) {
      const from = path.join(staging, 'cli', 'codex', conversation.sessionId, ...conversation.relative.split('/'));
      const account = conversation.profileId ? profileDirs.get(conversation.profileId) : undefined;
      const home = account && account.cli === 'codex' && account.dir ? (mapPath(account.dir, maps) ?? account.dir) : codexDefault;
      if (!home || !(await exists(from))) {
        missingConversations += 1;
        continue;
      }
      placements.push({ from, to: path.join(home, 'sessions', ...conversation.relative.split('/')) });
    }
  }
  // The databases: the paths, the identity, the caches.
  const self = preview.machineId;
  const newId = choices.identity === 'new' ? newMachineId() : null;
  const replaceExact = new Map<string, string>(newId && self ? [[self, newId]] : []);
  let remapped = 0;
  for (const name of BACKUP_DATABASES) {
    const db = path.join(staging, 'db', name);
    if (!(await exists(db))) continue;
    remapped += rewriteDatabase(db, maps, replaceExact);
  }
  const mainDb = path.join(staging, 'db', 'switchboard.db');
  if (await exists(mainDb)) finishMainDatabase(mainDb, transcriptPath, newId);
  const plan: RestorePlan = {
    preview,
    choices,
    maps,
    placements,
    conversations: preview.conversations.length - missingConversations,
    conversationsMissing: missingConversations,
    missingFolders: missing.map((entry) => entry.from),
    remapped,
    newMachineId: newId,
  };
  await writeFile(path.join(staging, 'plan.json'), JSON.stringify(plan), { mode: 0o600 });
  return plan;
}

function readProfileDirs(file: string): Map<string, { readonly cli: string; readonly dir: string | null }> {
  const out = new Map<string, { cli: string; dir: string | null }>();
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const row of db.prepare('SELECT id, cli, dir FROM cli_profiles').all() as Array<{ id: string; cli: string; dir: string | null }>) out.set(row.id, { cli: row.cli, dir: row.dir });
    } finally {
      db.close();
    }
  } catch {
    // no accounts table
  }
  return out;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  await walk(dir);
  return out;
}

/** The main database's last touches: transcripts' new paths, caches out, the automatic backups off, a new identity. */
function finishMainDatabase(file: string, transcripts: ReadonlyMap<string, string | null>, newId: string | null): void {
  const db = new DatabaseSync(file);
  try {
    db.exec('BEGIN');
    const set = db.prepare('UPDATE sessions SET transcript_path = ? WHERE id = ?');
    db.exec('UPDATE sessions SET transcript_path = NULL');
    for (const [id, to] of transcripts) set.run(to, id);
    for (const table of ['history_cache', 'peer_snapshots']) {
      try {
        db.exec(`DELETE FROM ${table}`);
      } catch {
        // an older database without it
      }
    }
    // The automatic backups' key is this computer's keychain's: they are off until a passphrase is set here.
    const auto = db.prepare("SELECT value FROM settings WHERE key = 'backup.auto'").get() as { value?: string } | undefined;
    if (auto?.value) {
      try {
        const parsed = JSON.parse(auto.value) as Record<string, unknown>;
        db.prepare("UPDATE settings SET value = ? WHERE key = 'backup.auto'").run(JSON.stringify({ ...parsed, enabled: false }));
      } catch {
        db.exec("DELETE FROM settings WHERE key = 'backup.auto'");
      }
    }
    db.exec("DELETE FROM settings WHERE key = 'backup.state'");
    if (newId) {
      // A new computer: its own identity (named at the first start), no pairings, no phones.
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('peers.self', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(JSON.stringify({ id: newId }), new Date().toISOString());
      for (const table of ['machines', 'device_push_subscriptions', 'device_pairing_codes', 'devices']) {
        try {
          db.exec(`DELETE FROM ${table}`);
        } catch {
          // an older database without it
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // nothing open
    }
    throw error;
  } finally {
    db.close();
  }
}

/** The data folder's entry names a restore replaces (the databases with their WAL files, the folders, and with `keep` the tokens). */
function replacedNames(identity: 'keep' | 'new'): string[] {
  const dbs = BACKUP_DATABASES.flatMap((name) => [name, `${name}-wal`, `${name}-shm`]);
  return [...dbs, ...BACKUP_DATA_DIRS, ...(identity === 'keep' ? BACKUP_DATA_FILES : [])];
}

function stamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

/**
 * Applies a prepared restore (Switchboard must not be running on `target.dataDir`): swaps the data
 * folder's entries for the staged ones (the ones here move to `.pre-restore-<time>`, and back on a
 * failure), then copies the conversations outside the data folder and writes the keychain values.
 * Writes and returns the report; removes the staging folder.
 */
export async function applyRestore(staging: string, target: RestoreTarget, now: Date = new Date()): Promise<RestoreReport> {
  const plan = JSON.parse(await readFile(path.join(staging, 'plan.json'), 'utf8')) as RestorePlan;
  const dataDir = path.resolve(target.dataDir);
  const aside = path.join(dataDir, `.pre-restore-${stamp(now)}`);
  await mkdir(aside, { recursive: true, mode: 0o700 });
  const moved: string[] = [];
  const placed: string[] = [];
  const staged = (name: string): string => (BACKUP_DATABASES.includes(name as (typeof BACKUP_DATABASES)[number]) ? path.join(staging, 'db', name) : path.join(staging, 'data', name));
  try {
    for (const name of replacedNames(plan.choices.identity)) {
      const here = path.join(dataDir, name);
      if (!(await exists(here))) continue;
      await rename(here, path.join(aside, name));
      moved.push(name);
    }
    for (const name of replacedNames(plan.choices.identity)) {
      const from = staged(name);
      if (!(await exists(from))) continue;
      await rename(from, path.join(dataDir, name));
      placed.push(name);
    }
  } catch (error) {
    // Put back what was here.
    for (const name of placed) await rm(path.join(dataDir, name), { recursive: true, force: true }).catch(() => undefined);
    for (const name of moved) await rename(path.join(aside, name), path.join(dataDir, name)).catch(() => undefined);
    await rm(aside, { recursive: true, force: true }).catch(() => undefined);
    throw new RestoreError('failed', `the restore could not swap the data in (${error instanceof Error ? error.message : String(error)}); the data here is as it was`);
  }
  // The conversations kept outside the data folder (the CLIs' Default folders).
  let placementFailures = 0;
  for (const placement of plan.placements) {
    try {
      await mkdir(path.dirname(placement.to), { recursive: true, mode: 0o700 });
      await copyFile(placement.from, placement.to);
    } catch {
      placementFailures += 1;
    }
  }
  // The keychain values.
  let secrets = 0;
  let secretsFailed = 0;
  const secretsFile = path.join(staging, 'secrets.json');
  if (await exists(secretsFile)) {
    const values = JSON.parse(await readFile(secretsFile, 'utf8')) as Array<{ service: string; account: string; value: string }>;
    for (const entry of values) {
      try {
        if (!target.secrets) throw new Error('no keychain');
        await target.secrets.set({ service: entry.service, account: entry.account }, entry.value);
        secrets += 1;
      } catch {
        secretsFailed += 1;
      }
    }
    await rm(secretsFile, { force: true });
  }
  const todo: string[] = [];
  todo.push('Sign in to each CLI on this computer (Settings → CLIs and Accounts): their own logins are this computer\'s.');
  if (plan.choices.identity === 'new') todo.push('Pair your other computers and phones again (Settings → Computers, Devices): this computer started as a new one.');
  if (plan.missingFolders.length > 0) todo.push(`Fix the saved folders that do not exist here (${plan.missingFolders.length}): Settings → Folders.`);
  if (secretsFailed > 0) todo.push(`${secretsFailed} keychain value${secretsFailed === 1 ? '' : 's'} could not be written: set up those crew accesses / the Jira token again.`);
  if (placementFailures > 0) todo.push(`${placementFailures} conversation file${placementFailures === 1 ? '' : 's'} could not be written into the CLI folders.`);
  const report: RestoreReport = {
    at: now.toISOString(),
    ok: true,
    error: null,
    fromVersion: plan.preview.switchboardVersion,
    fromMachine: plan.preview.machineName,
    agents: plan.preview.counts.agents,
    folders: plan.preview.counts.folders,
    remapped: plan.remapped,
    missingFolders: plan.missingFolders,
    conversations: plan.conversations - placementFailures,
    conversationsMissing: plan.conversationsMissing + placementFailures,
    secrets,
    secretsFailed,
    identity: plan.choices.identity,
    previousData: moved.length > 0 ? aside : null,
    todo,
  };
  if (moved.length === 0) await rm(aside, { recursive: true, force: true }).catch(() => undefined);
  await writeFile(path.join(dataDir, RESTORE_REPORT_FILE), JSON.stringify(report, null, 2), { mode: 0o600 });
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  return report;
}

/**
 * At start, before anything opens the data folder (`main.ts`): applies a restore Settings prepared
 * (`<dataDir>/restore-pending/` with its `plan.json`). A failure leaves the data as it was and
 * writes the failed report; the start goes on either way. `null` when nothing was pending.
 */
export async function applyPendingRestore(target: RestoreTarget): Promise<RestoreReport | null> {
  const staging = path.join(target.dataDir, RESTORE_PENDING_DIR);
  if (!(await exists(path.join(staging, 'plan.json')))) {
    if (await exists(staging)) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
  try {
    return await applyRestore(staging, target);
  } catch (error) {
    const plan = JSON.parse(await readFile(path.join(staging, 'plan.json'), 'utf8').catch(() => '{}')) as Partial<RestorePlan>;
    const report: RestoreReport = {
      at: new Date().toISOString(),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      fromVersion: plan.preview?.switchboardVersion ?? '',
      fromMachine: plan.preview?.machineName ?? null,
      agents: 0,
      folders: 0,
      remapped: 0,
      missingFolders: [],
      conversations: 0,
      conversationsMissing: 0,
      secrets: 0,
      secretsFailed: 0,
      identity: plan.choices?.identity ?? 'new',
      previousData: null,
      todo: [],
    };
    await writeFile(path.join(target.dataDir, RESTORE_REPORT_FILE), JSON.stringify(report, null, 2), { mode: 0o600 }).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    return report;
  }
}

/** The last restore's report, `null` when there was none. */
export async function readRestoreReport(dataDir: string): Promise<RestoreReport | null> {
  try {
    return JSON.parse(await readFile(path.join(dataDir, RESTORE_REPORT_FILE), 'utf8')) as RestoreReport;
  } catch {
    return null;
  }
}
