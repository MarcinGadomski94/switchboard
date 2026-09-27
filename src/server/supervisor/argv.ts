/**
 * How a supervised `claude` process is started (`docs/handoff/ARCHITECTURE.md` →
 * *Claude Code integration* → *Process and flags*; `docs/spike-m0.md`).
 */

/** The permission mode passed on every spawn (D6 fallback: `auto` is unproven headless, M0.1/M0.2). */
export const DEFAULT_PERMISSION_MODE = 'acceptEdits';

/** How the process picks up its conversation. */
export type ClaudeStart =
  /** A new session: `--session-id <uuid>` (the uuid becomes the claudeSessionId). */
  | { readonly kind: 'new'; readonly claudeSessionId: string }
  /** Resume, attach, restart: `--resume <claudeSessionId>`; the id never changes. */
  | { readonly kind: 'resume'; readonly claudeSessionId: string };

/** Input of {@link buildClaudeArgs}. */
export interface ClaudeArgsInput {
  readonly start: ClaudeStart;
  /** The Switchboard session name (`--name`: the transcript title). */
  readonly name: string;
  readonly permissionMode: string;
  /** Dev-only flags appended at the end (`SWITCHBOARD_CLAUDE_EXTRA_ARGS`, the D13 real-CLI smoke). */
  readonly extraArgs?: readonly string[];
}

/**
 * The baseline argv (without the CLI command itself): stream-json in and out,
 * `--permission-prompt-tool stdio` (questions and permission requests over stdin,
 * M0.2), the permission mode (not inherited on `--resume`, M0.4), the session id,
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
    input.start.kind === 'new' ? '--session-id' : '--resume',
    input.start.claudeSessionId,
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
