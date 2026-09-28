/**
 * How a supervised `claude` process is started (`docs/handoff/ARCHITECTURE.md` →
 * *Claude Code integration* → *Process and flags*; `docs/spike-m0.md`).
 */

/**
 * The permission mode passed on every spawn (D6): `auto`, the mode the developer uses
 * interactively. It engages headless on models that support it (probe 2026-09-28,
 * `docs/spike-m0.md` → *D6 follow-up*); on other models the CLI silently reports
 * `default`, and the recorder switches the session to {@link FALLBACK_PERMISSION_MODE}.
 */
export const DEFAULT_PERMISSION_MODE = 'auto';

/** D6 fallback when `auto` is not available for the session's model (M0.1/M0.2: Haiku). */
export const FALLBACK_PERMISSION_MODE = 'acceptEdits';

/** How the process picks up its conversation. */
export type ClaudeStart =
  /** A new session: `--session-id <uuid>` (the uuid becomes the claudeSessionId). */
  | { readonly kind: 'new'; readonly claudeSessionId: string }
  /** Resume, attach, restart: `--resume <claudeSessionId>`; the id never changes. */
  | { readonly kind: 'resume'; readonly claudeSessionId: string }
  /**
   * D25: a local copy of a remote session, `--teleport <session_X>`, **without**
   * `--session-id` (the CLI picks the local copy's id; Switchboard learns it from
   * `system/init`, `docs/supervisor.md` → *Teleport*). Only the first spawn: every
   * later one resumes the local id.
   */
  | { readonly kind: 'teleport'; readonly remoteSession: string };

/** Input of {@link buildClaudeArgs}. */
export interface ClaudeArgsInput {
  readonly start: ClaudeStart;
  /** `--name` (the CLI's display name, the transcript title): the session's title, else its name (D22). */
  readonly name: string;
  readonly permissionMode: string;
  /** Dev-only flags appended at the end (`SWITCHBOARD_CLAUDE_EXTRA_ARGS`, the D13 real-CLI smoke). */
  readonly extraArgs?: readonly string[];
}

/** The flag pair that says which conversation the process runs (see {@link ClaudeStart}). */
function startArgs(start: ClaudeStart): [string, string] {
  switch (start.kind) {
    case 'new':
      return ['--session-id', start.claudeSessionId];
    case 'resume':
      return ['--resume', start.claudeSessionId];
    case 'teleport':
      return ['--teleport', start.remoteSession];
  }
}

/**
 * The baseline argv (without the CLI command itself): stream-json in and out,
 * `--permission-prompt-tool stdio` (questions and permission requests over stdin,
 * M0.2), the permission mode (not inherited on `--resume`, M0.4), the session id
 * (D25: or `--teleport <session_X>` for a local copy of a remote session),
 * `--name`, `--forward-subagent-text`, `--replay-user-messages`. No prompt argument:
 * every message, the first one included, goes through stdin. No `--settings`: no
 * hooks are needed (D6 allows a Switchboard-owned file if that changes).
 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-prompt-tool',
    'stdio',
    '--permission-mode',
    input.permissionMode,
    ...startArgs(input.start),
    '--name',
    input.name,
    '--forward-subagent-text',
    '--replay-user-messages',
    ...(input.extraArgs ?? []),
  ];
}

/** Variables that tie a child to a parent Claude Code session (M0.1): never passed on. */
export function isScrubbedEnvKey(key: string): boolean {
  return key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT' || key.startsWith('CLAUDE_CODE_');
}

/**
 * The child's environment: `base` without `CLAUDECODE`, `CLAUDE_CODE_*`,
 * `CLAUDE_PID` and `CLAUDE_EFFORT`. `CLAUDE_CONFIG_DIR` is kept (it moves the
 * transcripts, M0.3).
 */
export function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !isScrubbedEnvKey(key)) env[key] = value;
  }
  return env;
}

/** The terminal handoff command shown after Detach (prototype copy, M0.4). */
export function resumeCommand(claudeSessionId: string): string {
  return `claude --resume ${claudeSessionId}`;
}
