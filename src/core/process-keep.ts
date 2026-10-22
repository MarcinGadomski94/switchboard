/**
 * D127 · the `process_keep` tool of the built-in `switchboard` MCP server (`docs/mcp.md`,
 * `docs/processes.md`): the agent keeps a process the developer needs running (never stopped
 * automatically), or hands it back. Its definition lives here, apart from `processes.ts`, so the
 * helper (`src/hook/sb-mcp.ts`) loads nothing else; the helper registers it and calls
 * `POST /agent/v1/processes/keep`.
 */
import type { SessionProcess } from './api.ts';
import type { TodoToolDefinition } from './todos.ts';

/** The longest `process_keep` reason. */
export const PROCESS_KEEP_REASON_MAX = 200;

/** The tool's name. */
export const PROCESS_KEEP_TOOL_NAME = 'process_keep';

/** `process_keep`: the agent marks a process it leaves for the developer (or hands it back to the automatic stop). */
export const PROCESS_KEEP_TOOL: TodoToolDefinition = {
  name: PROCESS_KEEP_TOOL_NAME,
  description:
    "Mark a process this session started (a dev server, a watcher) to keep running, or hand it back. Switchboard stops what a session leaves running (build servers, test hosts, dev servers) when the session is closed or has been idle for a while, to free the machine's memory; a kept process is never stopped automatically. Keep a server ONLY when the developer needs it running after your turn (say so in your reply, with its address); otherwise let Switchboard stop it. Give pid, or match (part of its command line, e.g. \"vite\" or \"dotnet run\"); keep false hands it back to the automatic stop. Only this session's own processes can be marked.",
  inputSchema: {
    type: 'object',
    properties: {
      pid: { type: 'integer', minimum: 1, maximum: 4_294_967_295, description: "The process id (as ps / Task Manager shows it). Give pid or match." },
      match: { type: 'string', description: 'Part of the command line (case-insensitive), e.g. "vite" or "dotnet watch": every process of this session that matches. Give pid or match.' },
      keep: { type: 'boolean', description: 'true = keep it running (never stopped automatically); false = Switchboard may stop it again when the session is idle or closed.' },
      reason: { type: 'string', maxLength: PROCESS_KEEP_REASON_MAX, description: `Optional, one line (at most ${PROCESS_KEEP_REASON_MAX} characters): why the developer needs it, e.g. "dev server for the review at http://localhost:5173".` },
    },
    required: ['keep'],
    additionalProperties: false,
  },
  annotations: { title: 'Keep a process running', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/** The tool's answer: what is kept now. */
export function processKeepAnswer(changed: readonly Pick<SessionProcess, 'pid' | 'name' | 'keep'>[], keep: boolean): string {
  const list = changed.map((process) => `${process.name} (pid ${process.pid})`).join(', ');
  return keep
    ? `Kept running: ${list}. Switchboard will not stop ${changed.length === 1 ? 'it' : 'them'} automatically; tell the developer it is running.`
    : `Handed back: ${list}. Switchboard stops ${changed.length === 1 ? 'it' : 'them'} when the session is idle or closed.`;
}
