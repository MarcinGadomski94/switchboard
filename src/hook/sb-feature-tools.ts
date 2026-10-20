/**
 * 2026-10-16 (`docs/mcp.md` → *Tools that appear without a restart*): the feature tools of the
 * built-in `switchboard` MCP server (`sb-mcp.ts`), kept in step with Switchboard while the
 * process runs.
 *
 * Team (D100), Plans (D99) and Project memory (D107) each register their tools only while their
 * probe route answers 200 for this session (`GET /agent/v1/team`, `/agent/v1/plans`,
 * `/agent/v1/memory`). Until now the helper asked once, at start, so a session adopted into
 * Team, a switch turned on later, or a probe that timed out left the process without the tools
 * until it restarted. {@link FeatureTools} asks again whenever Switchboard wakes it
 * (`GET /agent/v1/tools/watch`, held until a wake-up or for about 25 s: the periodic check) and
 * adds or removes the tools; the SDK's `McpServer` sends `notifications/tools/list_changed` on
 * each change, and a CLI that honours it lists the tools again.
 *
 * {@link ListedToolsTransport} reports every `tools/list` answer the CLI got
 * (`POST /agent/v1/tools`), so Switchboard knows what the CLI really has (a CLI that ignores
 * `list_changed` keeps its old list, and Switchboard restarts it once before an ask that needs a
 * missing tool). It also answers a call to a feature tool that is off with a clear tool error
 * (why, and what to do) instead of the SDK's bare "Tool … not found".
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
// Project memory (D107) hook: the `memory` set (docs/memory-removal.md).
import { MEMORY_TOOLS } from '../core/memory.ts';
// Plans (D99) hook: the `plans` set (docs/plans-removal.md).
import { PLAN_TOOLS } from '../core/plans.ts';
import { PLAN_PROPOSE_TOOL } from '../core/plans-jira.ts';
import { PLAN_JIRA_CONTEXT_TOOL } from '../core/plans-jira-context.ts';
// Team (D100) hook: the `team` set (docs/team-removal.md).
import { registerAccessTool } from '../core/team-access-tools.ts';
import { TEAM_TOOLS, registerTeamTools } from '../core/team-tools.ts';
import { registerMemoryTools } from './sb-memory-tools.ts';
import type { AgentApi } from './sb-mcp.ts';
import { registerPlanTools } from './sb-plan-tools.ts';

/** One feature's tools: the route that says whether this session gets them, and how they are registered. */
export interface FeatureToolSet {
  readonly name: 'team' | 'plans' | 'memory';
  /** Shown in the "not available" answer. */
  readonly label: string;
  /** `GET` this; 200 = the session gets the tools. */
  readonly probe: string;
  /** Every tool name the set registers (a call to one while the set is off is answered with the reason). */
  readonly tools: readonly string[];
  /** Why the tools are missing when the probe gave no message of its own. */
  readonly offReason: string;
  register(server: McpServer, api: AgentApi): void;
}

/** The feature tool sets, in the order the helper probes them. */
export const FEATURE_TOOL_SETS: readonly FeatureToolSet[] = [
  {
    name: 'team',
    label: 'Team',
    probe: '/agent/v1/team',
    tools: [...TEAM_TOOLS.map((tool) => tool.name), 'request_access'],
    offReason: 'this session is not a team member, or Team is off',
    register: (server, api) => {
      registerTeamTools(server, api);
      // D100-T2: request_access, likewise only in a member's session.
      registerAccessTool(server, api);
    },
  },
  { name: 'plans', label: 'Plans', probe: '/agent/v1/plans', tools: [...PLAN_TOOLS.map((tool) => tool.name), PLAN_PROPOSE_TOOL.name, PLAN_JIRA_CONTEXT_TOOL.name], offReason: 'Plans is off', register: registerPlanTools },
  { name: 'memory', label: 'Project memory', probe: '/agent/v1/memory', tools: MEMORY_TOOLS.map((tool) => tool.name), offReason: 'Project memory is off, or this session has no project folder', register: registerMemoryTools },
];

/** `server` as the register functions see it, with each `registerTool` handle collected into `handles`. */
function collecting(server: McpServer, handles: RegisteredTool[]): McpServer {
  return new Proxy(server, {
    get(target, key) {
      if (key === 'registerTool') {
        return (...args: unknown[]) => {
          const handle = (target.registerTool as (...a: unknown[]) => RegisteredTool).apply(target, args);
          handles.push(handle);
          return handle;
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function messageOf(body: unknown): string | null {
  const message = body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['message'] : undefined;
  return typeof message === 'string' && message.trim() !== '' ? message : null;
}

/** The helper's feature tools: probed, added and removed while the MCP connection lives. */
export class FeatureTools {
  readonly #server: McpServer;
  readonly #api: AgentApi;
  readonly #probe: AgentApi;
  readonly #sets: readonly FeatureToolSet[];
  readonly #on = new Map<FeatureToolSet['name'], RegisteredTool[]>();
  /** Why each set that is off is off (the probe's message), for the "not available" answer. */
  readonly #why = new Map<FeatureToolSet['name'], string>();
  #running: Promise<boolean> = Promise.resolve(false);

  /** `api` serves the tools' calls; `probe` (a short timeout) asks the probe routes. */
  constructor(server: McpServer, api: AgentApi, probe: AgentApi = api, sets: readonly FeatureToolSet[] = FEATURE_TOOL_SETS) {
    this.#server = server;
    this.#api = api;
    this.#probe = probe;
    this.#sets = sets;
  }

  /** The sets whose tools are registered now. */
  active(): FeatureToolSet['name'][] {
    return this.#sets.filter((set) => this.#on.has(set.name)).map((set) => set.name);
  }

  /**
   * Probes every set again and adds the tools of those that answer 200, removes those of the
   * ones that answer anything else (each change sends `list_changed` once connected). A probe
   * that fails (no answer in time, Switchboard not reachable) leaves its set as it was: the next
   * check tries again. Answers whether anything changed. One refresh at a time.
   */
  refresh(): Promise<boolean> {
    const next = this.#running.catch(() => false).then(() => this.#refreshNow());
    this.#running = next;
    return next;
  }

  async #refreshNow(): Promise<boolean> {
    let changed = false;
    for (const set of this.#sets) {
      let wanted: boolean;
      try {
        const answer = await this.#probe('GET', set.probe);
        wanted = answer.status === 200;
        if (wanted) this.#why.delete(set.name);
        else this.#why.set(set.name, messageOf(answer.body) ?? set.offReason);
      } catch {
        continue;
      }
      const handles = this.#on.get(set.name);
      if (wanted && !handles) {
        const registered: RegisteredTool[] = [];
        set.register(collecting(this.#server, registered), this.#api);
        this.#on.set(set.name, registered);
        changed = true;
      } else if (!wanted && handles) {
        for (const handle of handles) handle.remove();
        this.#on.delete(set.name);
        changed = true;
      }
    }
    return changed;
  }

  /** The tool error for a call to `name` while its set is off; `null` for any other tool (the server answers it). */
  unavailable(name: string): string | null {
    const set = this.#sets.find((candidate) => candidate.tools.includes(name));
    if (!set || this.#on.has(set.name)) return null;
    const why = this.#why.get(set.name) ?? set.offReason;
    return `${name} is not available in this session: ${why}. The ${set.label} tools appear here by themselves once this session gets them (no restart needed); do not retry until then.`;
  }

  /**
   * Waits for Switchboard's wake-ups (`watch`: `GET /agent/v1/tools/watch?since=N`, held by the
   * server; an older Switchboard or none answering: a plain wait of `fallbackMs`) and refreshes
   * after each, until `stop` is aborted.
   */
  async watch(watch: AgentApi, stop: AbortSignal, fallbackMs = 30_000): Promise<void> {
    let since = 0;
    while (!stop.aborted) {
      try {
        const answer = await watch('GET', `/agent/v1/tools/watch?since=${since}`);
        const generation = answer.body !== null && typeof answer.body === 'object' ? Number((answer.body as Record<string, unknown>)['generation']) : Number.NaN;
        if (answer.status === 200 && Number.isFinite(generation)) since = generation;
        else await delay(fallbackMs, undefined, { signal: stop, ref: false });
      } catch {
        if (stop.aborted) return;
        await delay(fallbackMs, undefined, { signal: stop, ref: false }).catch(() => undefined);
      }
      if (stop.aborted) return;
      await this.refresh().catch(() => false);
      // Never a tight loop, whatever the server answers.
      await delay(100, undefined, { signal: stop, ref: false }).catch(() => undefined);
    }
  }
}

/**
 * A transport around the helper's own (stdio; in-memory in tests) that sees the CLI's
 * `tools/list` requests and reports each answer's tool names (`onListed`), and answers a
 * `tools/call` of a feature tool that is off with `unavailable`'s text as a tool error.
 */
export class ListedToolsTransport implements Transport {
  readonly #inner: Transport;
  readonly #onListed: (tools: string[]) => void;
  readonly #unavailable: (name: string) => string | null;
  readonly #listing = new Set<string | number>();
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(inner: Transport, onListed: (tools: string[]) => void, unavailable: (name: string) => string | null = () => null) {
    this.#inner = inner;
    this.#onListed = onListed;
    this.#unavailable = unavailable;
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => this.onerror?.(error);
    inner.onmessage = (message, extra) => {
      const request = message as { method?: unknown; id?: unknown; params?: { name?: unknown } };
      const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
      if (request.method === 'tools/list' && id !== null) this.#listing.add(id);
      if (request.method === 'tools/call' && id !== null && typeof request.params?.name === 'string') {
        const why = this.#unavailable(request.params.name);
        if (why !== null) {
          void this.#inner.send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: why }], isError: true } } as JSONRPCMessage).catch((error: unknown) => this.onerror?.(error instanceof Error ? error : new Error(String(error))));
          return;
        }
      }
      this.onmessage?.(message, extra);
    };
  }

  get sessionId(): string | undefined {
    return this.#inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.#inner.setProtocolVersion?.(version);
  }

  start(): Promise<void> {
    return this.#inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const answer = message as { id?: unknown; result?: { tools?: unknown } };
    const id = typeof answer.id === 'string' || typeof answer.id === 'number' ? answer.id : null;
    const listed = id !== null && this.#listing.delete(id) && Array.isArray(answer.result?.tools) ? (answer.result.tools as { name?: unknown }[]).map((tool) => tool.name).filter((name): name is string => typeof name === 'string') : null;
    await this.#inner.send(message, options);
    if (listed !== null) this.#onListed(listed);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}
