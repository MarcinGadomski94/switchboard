import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { McpEditableScope, McpRawConfig } from '../../core/mcp.ts';

/**
 * D61: reads (never writes) the files Claude Code keeps its MCP servers in, for
 * one folder (`docs/mcp.md` → *Where servers come from*; CLI 2.1.285, read in its
 * code):
 *
 * - **user** and **local**: the global config file, `$CLAUDE_CONFIG_DIR/.claude.json`
 *   (or `~/.claude.json`; `<config dir>/.config.json` wins when it exists): its
 *   top-level `mcpServers` (user) and `projects[<folder>].mcpServers` (local).
 *   `projects[<folder>].disabledMcpServers` lists the servers turned off for the
 *   folder (what `mcp_toggle` writes).
 * - **project**: `<folder>/.mcp.json` → `mcpServers`. Whether a project server is
 *   approved: `enableAllProjectMcpServers` / `enabledMcpjsonServers` /
 *   `disabledMcpjsonServers` in the user settings (`<config dir>/settings.json`), the
 *   folder's `.claude/settings.json` and `.claude/settings.local.json`, and the
 *   folder's entry in the global file.
 *
 * Every change goes through the CLI (`claude mcp add-json / remove`, `mcp_toggle`);
 * this module only reads.
 */

/** One server found in a config file. */
export interface ConfiguredServer {
  readonly name: string;
  readonly scope: McpEditableScope;
  readonly config: McpRawConfig;
  /** Turned off for this folder (`disabledMcpServers`). */
  readonly disabled: boolean;
  /** A project server's approval state; `null` for user / local. */
  readonly approval: 'approved' | 'pending' | 'rejected' | null;
}

/** Where the files are for an environment (`HOME`, `CLAUDE_CONFIG_DIR`). */
export interface ClaudeConfigPaths {
  /** `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  readonly configDir: string;
  /** The global config file candidates, first existing wins. */
  readonly globalFiles: readonly string[];
  readonly userSettings: string;
}

/** The config paths for `env` (the environment the CLI is spawned with). */
export function claudeConfigPaths(env: NodeJS.ProcessEnv): ClaudeConfigPaths {
  const home = env['HOME']?.trim() || env['USERPROFILE']?.trim() || os.homedir();
  const override = env['CLAUDE_CONFIG_DIR']?.trim();
  const configDir = override ? path.resolve(override) : path.join(home, '.claude');
  return {
    configDir,
    globalFiles: [path.join(configDir, '.config.json'), path.join(override ? configDir : home, '.claude.json')],
    userSettings: path.join(configDir, 'settings.json'),
  };
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function servers(value: unknown): Array<[string, McpRawConfig]> {
  return Object.entries(record(value)).filter((entry): entry is [string, McpRawConfig] => !!entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1]));
}

/** The global config file in use (the first candidate that exists), `null` when none. */
export async function globalConfigFile(paths: ClaudeConfigPaths): Promise<string | null> {
  for (const file of paths.globalFiles) if (await exists(file)) return file;
  return null;
}

/**
 * The folder's entry in the global file's `projects`: keyed by the folder's path
 * (the CLI's project key; both the path as saved and its realpath are tried).
 */
function projectEntry(global: Record<string, unknown> | null, keys: readonly string[]): Record<string, unknown> {
  const projects = record(global?.['projects']);
  for (const key of keys) {
    const entry = projects[key];
    if (entry && typeof entry === 'object') return record(entry);
  }
  return {};
}

/**
 * The user, project and local servers Claude Code would load in `folder`
 * (`root` = its realpath, `folderPath` = as saved), with their disabled and
 * approval states. Unreadable or malformed files count as empty.
 */
export async function readConfiguredServers(env: NodeJS.ProcessEnv, root: string, folderPath: string = root): Promise<ConfiguredServer[]> {
  const paths = claudeConfigPaths(env);
  const globalFile = await globalConfigFile(paths);
  const global = globalFile ? await readJson(globalFile) : null;
  const keys = [...new Set([root, folderPath, root.replace(/\\/g, '/'), folderPath.replace(/\\/g, '/')])];
  const project = projectEntry(global, keys);
  const disabled = new Set(names(project['disabledMcpServers']));

  const settingsFiles = [paths.userSettings, path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')];
  const settings = [project, ...(await Promise.all(settingsFiles.map(readJson))).map((s) => s ?? {})];
  const enableAll = settings.some((s) => s['enableAllProjectMcpServers'] === true);
  const enabled = new Set(settings.flatMap((s) => names(s['enabledMcpjsonServers'])));
  const rejected = new Set(settings.flatMap((s) => names(s['disabledMcpjsonServers'])));

  const out: ConfiguredServer[] = [];
  for (const [name, config] of servers(project['mcpServers'])) out.push({ name, scope: 'local', config, disabled: disabled.has(name), approval: null });
  const mcpJson = await readJson(path.join(root, '.mcp.json'));
  for (const [name, config] of servers(mcpJson?.['mcpServers'])) {
    const approval = rejected.has(name) ? 'rejected' : enableAll || enabled.has(name) ? 'approved' : 'pending';
    out.push({ name, scope: 'project', config, disabled: disabled.has(name), approval });
  }
  for (const [name, config] of servers(global?.['mcpServers'])) out.push({ name, scope: 'user', config, disabled: disabled.has(name), approval: null });
  return out;
}

/** One stored definition (`name` in `scope`), `null` when it is not there. */
export async function readServerConfig(env: NodeJS.ProcessEnv, root: string, folderPath: string, name: string, scope: McpEditableScope): Promise<McpRawConfig | null> {
  const found = (await readConfiguredServers(env, root, folderPath)).find((s) => s.name === name && s.scope === scope);
  return found?.config ?? null;
}
