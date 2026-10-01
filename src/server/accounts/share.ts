import { lstat, mkdir, readFile, symlink, copyFile, cp, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CliProviderId } from '../../core/cli-providers.ts';

/**
 * D63 (`docs/accounts.md` → *Sharing the Default's settings*): what a profile
 * borrows from the Default's folder so a switched session behaves the same. Only
 * configuration is ever shared: never credentials (`.credentials.json`,
 * `auth.json`), never conversations (`projects/`, `sessions/`), never the
 * account identity in `.claude.json`.
 */
export const SHARED_ENTRIES: Readonly<Record<CliProviderId, readonly string[]>> = {
  claude: ['settings.json', 'CLAUDE.md', 'agents', 'commands', 'skills', 'keybindings.json'],
  codex: ['config.toml', 'AGENTS.md', 'prompts', 'skills'],
  // OpenCode's config lives in `~/.config/opencode`, outside the data folder a profile overrides: shared already.
  opencode: [],
};

/** The Default's folder of a CLI for an environment (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, else the home default); `null` for OpenCode. */
export function defaultDir(cli: CliProviderId, env: NodeJS.ProcessEnv, home: string = os.homedir()): string | null {
  const set = (name: string): string | null => (env[name] && env[name]!.trim() !== '' ? env[name]! : null);
  if (cli === 'claude') return set('CLAUDE_CONFIG_DIR') ?? path.join(home, '.claude');
  if (cli === 'codex') return set('CODEX_HOME') ?? path.join(home, '.codex');
  return null;
}

/** What {@link shareSettings} did. */
export interface ShareResult {
  /** Entries now shared (linked or copied). */
  readonly shared: readonly string[];
  /** Entries copied because a link was not possible (Windows without the privilege). */
  readonly copied: readonly string[];
  readonly mcp: 'merged' | 'none';
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Links (symlink; a copy where links are refused) the shared entries of the
 * Default's folder into the profile's, leaving anything the profile already has.
 * Claude Code's user-level MCP servers live in `<config dir>/.claude.json` next to
 * the account identity, so that file is never linked: only its `mcpServers` key is
 * merged into the profile's own file (servers the profile already has win).
 * Idempotent; a missing source is skipped.
 */
export async function shareSettings(cli: CliProviderId, fromDir: string | null, profileDir: string, home: string = os.homedir()): Promise<ShareResult> {
  const shared: string[] = [];
  const copied: string[] = [];
  let mcp: ShareResult['mcp'] = 'none';
  if (fromDir === null || path.resolve(fromDir) === path.resolve(profileDir)) return { shared, copied, mcp };
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  for (const entry of SHARED_ENTRIES[cli]) {
    const source = path.join(fromDir, entry);
    const target = path.join(profileDir, entry);
    if (!(await exists(source)) || (await exists(target))) continue;
    try {
      await symlink(source, target);
    } catch {
      const info = await lstat(source);
      if (info.isDirectory()) await cp(source, target, { recursive: true });
      else await copyFile(source, target);
      copied.push(entry);
    }
    shared.push(entry);
  }
  if (cli === 'claude') {
    // The user-level config: `<dir>/.claude.json` when the dir is set, `~/.claude.json` for the home default.
    const fromFile = path.resolve(fromDir) === path.resolve(path.join(home, '.claude')) ? path.join(home, '.claude.json') : path.join(fromDir, '.claude.json');
    mcp = await mergeMcpServers(fromFile, path.join(profileDir, '.claude.json'));
  }
  return { shared, copied, mcp };
}

async function mergeMcpServers(fromFile: string, toFile: string): Promise<'merged' | 'none'> {
  let from: Record<string, unknown>;
  try {
    from = JSON.parse(await readFile(fromFile, 'utf8')) as Record<string, unknown>;
  } catch {
    return 'none';
  }
  const servers = from['mcpServers'];
  if (typeof servers !== 'object' || servers === null || Object.keys(servers).length === 0) return 'none';
  let to: Record<string, unknown> = {};
  try {
    to = JSON.parse(await readFile(toFile, 'utf8')) as Record<string, unknown>;
  } catch {
    // A new file.
  }
  const own = typeof to['mcpServers'] === 'object' && to['mcpServers'] !== null ? (to['mcpServers'] as Record<string, unknown>) : {};
  await writeFile(toFile, `${JSON.stringify({ ...to, mcpServers: { ...(servers as Record<string, unknown>), ...own } }, null, 2)}\n`, { mode: 0o600 });
  await chmod(toFile, 0o600).catch(() => undefined);
  return 'merged';
}
