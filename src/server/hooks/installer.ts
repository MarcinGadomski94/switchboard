import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type HookCommand, switchboardHooksState, withSwitchboardHooks, withoutSwitchboardHooks } from '../../core/hooks.ts';

/**
 * D48 P4 (`docs/peers.md` → *Installing the hooks*): Switchboard's hook entries in
 * the user's Claude settings (`<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`),
 * written only by the explicit Install hooks / Remove hooks action. Before any
 * change the file is copied to `settings.json.switchboard-backup-<timestamp>`;
 * only Switchboard's own entries are added or removed (`src/core/hooks.ts`), the
 * rest of the file keeps its content and order; the new file replaces the old one
 * atomically (write + rename), keeping its mode. A file that is not a JSON object
 * is never changed.
 */

/** The settings file of a config dir. */
export function settingsFile(configDir: string): string {
  return path.join(configDir, 'settings.json');
}

/** What the settings file holds now. */
export interface HookSettingsRead {
  readonly path: string;
  /** The parsed object; `{}` when the file does not exist; `null` when it is unreadable. */
  readonly settings: Record<string, unknown> | null;
  readonly exists: boolean;
  /** Why it could not be used (`null` when it could). */
  readonly error: string | null;
}

/** Reads the settings file (never throws for a missing or broken file). */
export async function readHookSettings(configDir: string): Promise<HookSettingsRead> {
  const file = settingsFile(configDir);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: file, settings: {}, exists: false, error: null };
    return { path: file, settings: null, exists: true, error: `could not read ${file}: ${(error as Error).message}` };
  }
  if (text.trim() === '') return { path: file, settings: {}, exists: true, error: null };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return { path: file, settings: parsed as Record<string, unknown>, exists: true, error: null };
  } catch {
    // Not JSON.
  }
  return { path: file, settings: null, exists: true, error: `${file} is not a JSON object: Switchboard leaves it unchanged` };
}

/** Where Switchboard's entries stand in the settings file. */
export async function hooksState(configDir: string, command: HookCommand): Promise<{ readonly state: 'installed' | 'outdated' | 'none' | 'unreadable'; readonly path: string; readonly error: string | null }> {
  const read = await readHookSettings(configDir);
  if (!read.settings) return { state: 'unreadable', path: read.path, error: read.error };
  return { state: switchboardHooksState(read.settings, command), path: read.path, error: null };
}

/** Why an install or a removal was refused. */
export class HookInstallError extends Error {
  override name = 'HookInstallError';
}

function stamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function backup(file: string, now: Date): Promise<string> {
  let target = `${file}.switchboard-backup-${stamp(now)}`;
  for (let n = 2; ; n++) {
    try {
      await stat(target);
      target = `${file}.switchboard-backup-${stamp(now)}-${n}`;
    } catch {
      break;
    }
  }
  await copyFile(file, target);
  return target;
}

async function write(file: string, settings: Record<string, unknown>): Promise<void> {
  let mode = 0o600;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch {
    // A new file: private to the user.
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.switchboard-tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode });
  await rename(temp, file);
}

/** What an install or a removal did. */
export interface HookChange {
  readonly path: string;
  /** The backup made before the change; `null` when the file did not exist or nothing changed. */
  readonly backup: string | null;
  readonly changed: boolean;
}

/** Install hooks: backup, then exactly Switchboard's current entries (idempotent: nothing is written when they are already there). */
export async function installHooks(configDir: string, command: HookCommand, now: Date = new Date()): Promise<HookChange> {
  const read = await readHookSettings(configDir);
  if (!read.settings) throw new HookInstallError(read.error ?? 'the settings file cannot be read');
  if (switchboardHooksState(read.settings, command) === 'installed') return { path: read.path, backup: null, changed: false };
  const saved = read.exists ? await backup(read.path, now) : null;
  await write(read.path, withSwitchboardHooks(read.settings, command));
  return { path: read.path, backup: saved, changed: true };
}

/** Remove hooks: backup, then the file without Switchboard's entries (nothing else is restored or removed). */
export async function removeHooks(configDir: string, now: Date = new Date()): Promise<HookChange> {
  const read = await readHookSettings(configDir);
  if (!read.settings) throw new HookInstallError(read.error ?? 'the settings file cannot be read');
  const without = withoutSwitchboardHooks(read.settings);
  if (without.removed === 0) return { path: read.path, backup: null, changed: false };
  const saved = await backup(read.path, now);
  await write(read.path, without.settings);
  return { path: read.path, backup: saved, changed: true };
}
