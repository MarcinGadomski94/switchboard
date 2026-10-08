import { open } from 'node:fs/promises';
import path from 'node:path';
import {
  currentStandingInstruction,
  EDITABLE_SETTINGS,
  type EditableSettings,
  type KnownSettings,
  effectiveStandingInstruction,
  SETTING_DEFAULTS,
  STANDING_INSTRUCTION_MAX,
  type SettingKey,
  WARN_AT_PCT_MAX,
  WARN_AT_PCT_MIN,
  isEditableSetting,
  isNewSessionMode,
} from '../../core/settings.ts';
import type { ServerConfig } from '../config.ts';
import type { FolderRecord } from '../db/repos/folders.ts';
import type { SettingRepository } from '../db/repos/settings.ts';
import type { FieldError } from '../sessions/validate.ts';
import { DEFAULT_PR_POLL_MS } from '../worktrees/manager.ts';

/** The router file at the workspace root (ARCHITECTURE → Workspace rules). */
export const ROUTER_FILE = 'AGENTS.md';

/** How much of the router file is read to find its title. */
const ROUTER_HEAD_BYTES = 16 * 1024;

/** Every known key with the read-only ones, for {@link validateSettingsPatch} messages. */
const READ_ONLY_KEYS: readonly SettingKey[] = [
  'service.startAtLogin',
  'service.address',
  'workspace.root',
  'workspace.router',
  'github.prPollMinutes',
];

/** Result of {@link validateSettingsPatch}. */
export type SettingsValidation =
  | { readonly ok: true; readonly value: Partial<EditableSettings> }
  | { readonly ok: false; readonly errors: FieldError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a `PUT /api/settings` body: an object with any subset of the editable
 * keys (`EDITABLE_SETTINGS`). `sessions.worktrees` / `sessions.ultracode` / D75 `sessions.todoReminder` and
 * D41's `ui.sidebarHidden` / `ui.rightPanelHidden` are booleans,
 * `usage.warnAtPct` a whole number 1–100, D64's `agents.standingInstruction` text (at most 4,000 characters) and its `.enabled` a boolean, D56's `newSession.mode` `simple` or `full`. A read-only or unknown key,
 * or a value of the wrong type, fails the whole body (nothing is stored).
 */
export function validateSettingsPatch(body: unknown): SettingsValidation {
  if (!isRecord(body)) return { ok: false, errors: [{ field: '', message: 'the body must be an object of settings' }] };
  const errors: FieldError[] = [];
  const value: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!isEditableSetting(key)) {
      const readOnly = (READ_ONLY_KEYS as readonly string[]).includes(key);
      errors.push({ field: key, message: readOnly ? `${key} is read-only` : `unknown setting ${key}` });
      continue;
    }
    if (key === 'usage.warnAtPct') {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < WARN_AT_PCT_MIN || raw > WARN_AT_PCT_MAX) {
        errors.push({ field: key, message: `${key} must be a whole number ${WARN_AT_PCT_MIN}–${WARN_AT_PCT_MAX}` });
        continue;
      }
    } else if (key === 'newSession.mode') {
      // D56: the New-session dialog's last used mode.
      if (!isNewSessionMode(raw)) {
        errors.push({ field: key, message: `${key} must be "simple" or "full"` });
        continue;
      }
    } else if (key === 'agents.standingInstruction') {
      // D64: free text, empty allowed (nothing is passed), bounded.
      if (typeof raw !== 'string' || raw.length > STANDING_INSTRUCTION_MAX) {
        errors.push({ field: key, message: `${key} must be text of at most ${STANDING_INSTRUCTION_MAX} characters` });
        continue;
      }
    } else if (typeof raw !== 'boolean') {
      errors.push({ field: key, message: `${key} must be true or false` });
      continue;
    }
    value[key] = raw;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as Partial<EditableSettings> };
}

/**
 * The title of the router file `<root>/AGENTS.md`: its first `# ` heading, or
 * `AGENTS.md` when the first 16 KiB have none; `null` when there is no workspace
 * root or no such file. Reads asynchronously and never writes.
 */
export async function routerTitle(workspaceRoot: string | null): Promise<string | null> {
  if (!workspaceRoot) return null;
  let handle;
  try {
    handle = await open(path.join(workspaceRoot, ROUTER_FILE), 'r');
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(ROUTER_HEAD_BYTES, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8').replace(/^﻿/, '');
    for (const line of head.split(/\r?\n/)) {
      const match = /^#\s+(.+?)\s*#*\s*$/.exec(line);
      if (match?.[1]) return match[1];
    }
    return ROUTER_FILE;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Every known setting (`GET /api/settings`): the stored editable values (their
 * default until set), the stored `service.startAtLogin` (`false` until M9.1 sets
 * it), and what the service reports about itself from its configuration, the
 * default folder (D14: `workspace.root` / `workspace.router`; `null` without
 * one, the router `null` for a repo folder) and the worktree manager's PR poll
 * interval.
 */
export async function readSettings(
  repo: SettingRepository,
  config: Pick<ServerConfig, 'host' | 'port'>,
  defaultFolder: Pick<FolderRecord, 'path' | 'kind'> | null,
): Promise<KnownSettings> {
  const stored = await repo.getAll();
  const editable = Object.fromEntries(
    EDITABLE_SETTINGS.map((key) => {
      const value = stored[key];
      const fallback = SETTING_DEFAULTS[key];
      // D56: the mode is one of two words; anything else stored reads as the default.
      if (key === 'newSession.mode') return [key, isNewSessionMode(value) ? value : fallback];
      // D68: an earlier default text reads as the current default (it gains the todo sentence).
      if (key === 'agents.standingInstruction') return [key, typeof value === 'string' ? currentStandingInstruction(value) : fallback];
      return [key, typeof value === typeof fallback ? value : fallback];
    }),
  ) as unknown as EditableSettings;
  const startAtLogin = stored['service.startAtLogin'];
  return {
    ...editable,
    'service.startAtLogin': typeof startAtLogin === 'boolean' ? startAtLogin : false,
    'service.address': `${config.host}:${config.port}`,
    'workspace.root': defaultFolder?.path ?? null,
    'workspace.router': defaultFolder?.kind === 'workspace' ? await routerTitle(defaultFolder.path) : null,
    'github.prPollMinutes': DEFAULT_PR_POLL_MS / 60_000,
  };
}

/**
 * D64: the standing instruction to give a session's agent right now (read at every
 * spawn, so a change applies to sessions started or resumed afterwards): the stored
 * text when enabled and not empty, else `null`.
 */
export async function standingInstructionFor(repo: SettingRepository): Promise<string | null> {
  const stored = await repo.getAll();
  const text = stored['agents.standingInstruction'];
  const enabled = stored['agents.standingInstruction.enabled'];
  return effectiveStandingInstruction({
    'agents.standingInstruction': typeof text === 'string' ? currentStandingInstruction(text) : SETTING_DEFAULTS['agents.standingInstruction'],
    'agents.standingInstruction.enabled': typeof enabled === 'boolean' ? enabled : SETTING_DEFAULTS['agents.standingInstruction.enabled'],
  });
}

/** D75: whether the agent gets one reminder to finish a started todo (Settings → Sessions; default on). */
export async function todoReminderEnabled(repo: SettingRepository): Promise<boolean> {
  const stored = (await repo.getAll())['sessions.todoReminder'];
  return typeof stored === 'boolean' ? stored : SETTING_DEFAULTS['sessions.todoReminder'];
}
