/**
 * D124 · the `turn_status` tool of the built-in `switchboard` MCP server (`docs/mcp.md`): the
 * agent says how its turn ends: done, waiting for the developer, or blocked, with a one-line ask.
 * Its definition (name, description, input schema, annotations) lives here; the helper
 * (`src/hook/sb-mcp.ts`) registers it and calls `POST /agent/v1/turn-status`.
 */
import { TURN_ASK_MAX, TURN_STATUSES, type TurnWait } from './derive/turn-status.ts';
import type { TodoToolDefinition } from './todos.ts';

/** The tool's name. */
export const TURN_STATUS_TOOL_NAME = 'turn_status';

/** `turn_status`: the last action of every turn that ends without a question card. */
export const TURN_STATUS_TOOL: TodoToolDefinition = {
  name: TURN_STATUS_TOOL_NAME,
  description:
    "Tell Switchboard how this turn ends. Call it as the LAST action of every turn that ends without a question card (AskUserQuestion): status done when the task is finished; waiting_for_you when you need the developer's answer, decision or action; blocked when you cannot go on (a permission, an external dependency, a failing service). With waiting_for_you or blocked give ask: one line saying what the developer must do or answer. Switchboard shows the session as needing the developer, with the ask, until the next turn starts. Only the main agent calls it, never a subagent.",
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...TURN_STATUSES], description: 'done = the task is finished; waiting_for_you = you need the developer\'s answer, decision or action; blocked = you cannot go on.' },
      ask: { type: 'string', maxLength: TURN_ASK_MAX, description: `Required for waiting_for_you and blocked: what the developer must do or answer, one line (at most ${TURN_ASK_MAX} characters).` },
    },
    required: ['status'],
    additionalProperties: false,
  },
  annotations: { title: 'Say how this turn ends', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/** The tool's answer to the agent. */
export function turnStatusAnswer(wait: Pick<TurnWait, 'status' | 'ask'>): string {
  if (wait.status === 'done') return 'Recorded: done. Switchboard shows this turn as finished.';
  const word = wait.status === 'blocked' ? 'blocked' : 'waiting for the developer';
  return `Recorded: ${word} (${wait.ask ?? ''}). Switchboard shows the developer this ask until the next turn starts.`;
}
