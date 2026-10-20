import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_TOOLS } from '../../../src/core/artifacts.ts';
import { MEMORY_TOOLS } from '../../../src/core/memory.ts';
import { LOOP_TOOLS } from '../../../src/core/owned-loops.ts';
import { PLAN_TOOLS } from '../../../src/core/plans.ts';
import { PLAN_PROPOSE_TOOL } from '../../../src/core/plans-jira.ts';
import { TEAM_TOOLS } from '../../../src/core/team-tools.ts';
import { TODO_TOOLS } from '../../../src/core/todos.ts';
import { FEATURE_TOOL_SETS, FeatureTools } from '../../../src/hook/sb-feature-tools.ts';
import { type AgentApi, type ApiAnswer, createTodoServer } from '../../../src/hook/sb-mcp.ts';

/**
 * 2026-10-19 oracle (`docs/mcp.md` → *Tool annotations*): every tool the `switchboard` MCP
 * helper can expose (the always-on todo / artifact / loop tools, plus every feature set on:
 * a team member's session with Plans and Project memory on) declares a title and all four
 * MCP behaviour hints as explicit booleans, as `tools/list` hands them to a CLI. Directories
 * (OpenAI's among them) reject a tool with a hint missing or not a boolean.
 */

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

/** The expected hints, tool → [readOnly, destructive, idempotent, openWorld] (docs/mcp.md's table). */
const EXPECTED: Record<string, readonly [boolean, boolean, boolean, boolean]> = {
  todo_list: [true, false, true, false],
  todo_get: [true, false, true, false],
  todo_add: [false, false, false, false],
  todo_update: [false, true, true, false],
  todo_start: [false, false, true, false],
  todo_done: [false, false, true, false],
  todo_remove: [false, true, true, false],
  artifact_save: [false, false, false, false],
  artifact_list: [true, false, true, false],
  artifact_get: [true, false, true, false],
  loop_create: [false, false, false, false],
  loop_list: [true, false, true, false],
  loop_update: [false, true, true, false],
  loop_pause: [false, false, true, false],
  loop_resume: [false, false, true, false],
  loop_cancel: [false, true, true, false],
  team_handoff: [false, false, false, false],
  team_members: [true, false, true, false],
  team_report: [false, false, false, false],
  team_propose_charter: [false, false, true, false],
  request_access: [false, false, true, false],
  plan_create: [false, false, false, false],
  plan_add_item: [false, false, false, false],
  plan_add_dependency: [false, false, true, false],
  plan_status: [true, false, true, false],
  plan_start: [false, false, true, true],
  plan_set_solutions: [false, true, true, false],
  plan_propose_dependencies: [false, false, true, false],
  memory_propose: [false, false, true, false],
  memory_list: [true, false, true, false],
};

/** `tools/list` of the helper with every feature set on (every probe answers 200), over the in-memory transport. */
async function listEveryTool(): Promise<Array<{ name: string; title?: string; annotations?: Record<string, unknown> }>> {
  const api: AgentApi = async (): Promise<ApiAnswer> => ({ status: 200, body: {} });
  const server = createTodoServer(api);
  const features = new FeatureTools(server, api);
  await features.refresh();
  expect(features.active()).toEqual(FEATURE_TOOL_SETS.map((set) => set.name));
  const [client, inner] = InMemoryTransport.createLinkedPair();
  await server.connect(inner);
  const answered = new Promise<Record<string, unknown>>((resolve) => {
    client.onmessage = (message: JSONRPCMessage) => resolve(message as Record<string, unknown>);
  });
  await client.start();
  await client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' } as JSONRPCMessage);
  const tools = ((await answered)['result'] as { tools: Array<{ name: string; title?: string; annotations?: Record<string, unknown> }> }).tools;
  await server.close();
  return tools;
}

describe('tool annotations', () => {
  it('every tool the helper can register (all features on, a member session) has a title and all four hints as booleans', async () => {
    const tools = await listEveryTool();
    const names = tools.map((tool) => tool.name);
    // Every feature tool is in the list (a set that registers a new tool shows up here too).
    for (const set of FEATURE_TOOL_SETS) for (const name of set.tools) expect(names).toContain(name);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      for (const hint of HINTS) expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe('boolean');
      expect(typeof tool.annotations?.['title'], `${tool.name}.title`).toBe('string');
      expect(String(tool.annotations?.['title']), `${tool.name}.title`).not.toBe('');
      expect(tool.title, `${tool.name} title`).toBe(tool.annotations?.['title']);
      // A read-only tool is never destructive.
      if (tool.annotations?.['readOnlyHint'] === true) expect(tool.annotations['destructiveHint'], tool.name).toBe(false);
    }
  });

  it('the hints match the handlers (docs/mcp.md → Tool annotations); a new tool needs a row here', async () => {
    const tools = await listEveryTool();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const tool of tools) {
      const actual = HINTS.map((hint) => tool.annotations?.[hint]);
      expect(actual, tool.name).toEqual([...EXPECTED[tool.name]!]);
    }
  });

  it('the hints written out where each tool is registered match its definition in src/core', async () => {
    const defined = new Map<string, Record<string, unknown>>([
      ...[...TODO_TOOLS, ...ARTIFACT_TOOLS, ...LOOP_TOOLS, ...PLAN_TOOLS, PLAN_PROPOSE_TOOL, ...MEMORY_TOOLS].map((tool) => [tool.name, { ...tool.annotations }] as const),
      ...TEAM_TOOLS.map((tool) => [tool.name, { title: tool.title, ...tool.annotations }] as const),
    ]);
    for (const tool of await listEveryTool()) {
      if (tool.name === 'request_access') continue; // Defined where it is registered (src/core/team-access-tools.ts).
      expect(tool.annotations, tool.name).toEqual(defined.get(tool.name));
    }
  });
});
