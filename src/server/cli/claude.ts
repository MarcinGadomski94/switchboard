import { buildClaudeArgs } from '../supervisor/argv.ts';
import { claudeMcpArgs } from '../todos/agent-mcp.ts';
import { ClaudeProcess } from '../supervisor/process.ts';
import type { CliAdapter, SpawnRequest } from './adapter.ts';
import type { AgentProcess } from './agent-process.ts';

/**
 * D62: Claude Code behind the provider seam, exactly as before D62
 * (`docs/supervisor.md` → *Spawning*): the baseline argv from `buildClaudeArgs`
 * and one `claude` child speaking stream-json itself. Nothing is translated.
 */
export const claudeAdapter: CliAdapter = {
  id: 'claude',
  spawn(request: SpawnRequest): AgentProcess {
    const { session } = request;
    // D22: the CLI's display name is the session's title (as it is now: a rename applies from the next spawn), else its name.
    // D31: the stored model and effort (neither is inherited on `--resume`); `null` = the CLI's default, no flag.
    const args = buildClaudeArgs({
      start: request.claudeStart,
      name: session.title ?? session.name,
      permissionMode: request.permissionMode,
      model: session.model,
      effort: session.effort,
      standingInstruction: request.standingInstruction,
      // D68: the session's todo tools (`--mcp-config`, merged with the developer's own servers).
      ...(request.agentMcp ? { mcpArgs: claudeMcpArgs(request.agentMcp) } : {}),
      extraArgs: request.extraArgs,
    });
    return new ClaudeProcess({ command: request.command, args, cwd: request.cwd, env: request.env, onLine: request.onLine });
  },
};
