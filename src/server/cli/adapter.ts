import type { CliProviderId } from '../../core/cli-providers.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { ClaudeStart } from '../supervisor/argv.ts';
import type { AgentProcess } from './agent-process.ts';

/**
 * D62: what the supervisor asks of a provider when it starts a process for a
 * session (`docs/providers.md` → *Design*). Built by `SessionSupervisor.#spawn`
 * from the stored session; each adapter takes what its CLI needs.
 */
export interface SpawnRequest {
  /** The session as stored right before the spawn (title / name, model, effort, cwd). */
  readonly session: SessionRecord;
  /** Claude Code: `--session-id` / `--resume` / `--teleport` (D25). Other providers ignore it. */
  readonly claudeStart: ClaudeStart;
  /**
   * Codex / OpenCode: the provider's own conversation id to reopen (a Codex
   * thread id, an OpenCode session id); `null` = start a new one.
   */
  readonly nativeId: string | null;
  /** D6: the permission mode of this spawn (Claude's `--permission-mode`; the bridges map it to their own policy). */
  readonly permissionMode: string;
  /** The process's working folder (D14: the session's stored cwd). */
  readonly cwd: string;
  /** The child's environment (already scrubbed). */
  readonly env: NodeJS.ProcessEnv;
  /** The argv prefix of the CLI (env / settings, `docs/configuration.md`). */
  readonly command: readonly string[];
  /** Dev-only flags appended to the CLI's argv (`SWITCHBOARD_CLAUDE_EXTRA_ARGS`; Claude only). */
  readonly extraArgs: readonly string[];
  /** Every stream-json stdout line, in order. */
  readonly onLine: (line: string) => void;
  /** A bridge learned (or created) the provider's own conversation id: stored so later spawns reopen it. */
  readonly onNativeId?: (nativeId: string) => void;
  /** D57: where a message's attachments live (the bridges hand image paths to their CLI). */
  readonly attachmentPath?: (attachmentId: string) => string | null;
}

/** One CLI behind the {@link AgentProcess} seam. */
export interface CliAdapter {
  readonly id: CliProviderId;
  /** Starts the session's process. Throws only for a programming error; a CLI that cannot start ends with a `spawnError`. */
  spawn(request: SpawnRequest): AgentProcess;
}
