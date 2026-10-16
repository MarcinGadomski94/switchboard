import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AGENT_SESSION_HEADER } from '../../core/todos.ts';

/**
 * 2026-10-16 (`docs/mcp.md` → *Tools that appear without a restart*): what each session's
 * `switchboard` MCP helper (`src/hook/sb-mcp.ts`) has actually **listed to its CLI**, and the
 * wake-up channel that makes it look again.
 *
 * The feature tools (Team, Project memory, Plans) depend on state that changes while a
 * process runs: a session is adopted into Team, a switch is turned on, a start-up probe
 * timed out. The helper therefore re-probes (on a wake-up or every
 * {@link TOOLS_WATCH_MS}), adds or removes those tools and sends MCP
 * `notifications/tools/list_changed`; every `tools/list` answer it writes to the CLI is
 * reported here (`POST /agent/v1/tools`). A tool counts as available to a session only once
 * its CLI has **listed** it: a CLI that ignores `list_changed` never re-lists, so its report
 * keeps lacking the tool and Switchboard falls back to one restart before an ask that
 * needs it ({@link SessionSupervisor.sendNeedingTool}).
 *
 * In memory only: a report belongs to one process (it is dropped when that process ends) and
 * a Switchboard restart restarts every process anyway.
 */

/** How long `GET /agent/v1/tools/watch` holds a request before it answers "nothing new" (the helper then re-probes anyway: the periodic check). */
export const TOOLS_WATCH_MS = 25_000;

interface Waiter {
  readonly sessionId: string;
  readonly done: () => void;
}

/** What one session's helper last listed to its CLI. */
export interface ListedTools {
  readonly tools: ReadonlySet<string>;
  /** When it was reported (epoch ms). */
  readonly at: number;
}

/** The per-session reports and wake-ups (one per Switchboard; owned by the supervisor). */
export class AgentToolsRegistry {
  readonly #listed = new Map<string, ListedTools>();
  #generation = 0;
  #everyone = 0;
  readonly #nudged = new Map<string, number>();
  readonly #watchers = new Set<Waiter>();
  readonly #reportWaiters = new Set<Waiter>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** `POST /agent/v1/tools`: the helper of `sessionId` listed `tools` to its CLI. */
  report(sessionId: string, tools: readonly string[]): void {
    this.#listed.set(sessionId, { tools: new Set(tools), at: this.#now() });
    for (const waiter of [...this.#reportWaiters]) if (waiter.sessionId === sessionId) waiter.done();
  }

  /** What the session's CLI was last given; `null` when its helper has not reported (no process, an older helper, a CLI without one). */
  listed(sessionId: string): ListedTools | null {
    return this.#listed.get(sessionId) ?? null;
  }

  /** The process of `sessionId` ended: its report goes with it. */
  forget(sessionId: string): void {
    this.#listed.delete(sessionId);
  }

  /** The generation a waiting helper of `sessionId` compares with (the newest wake-up meant for it). */
  #relevant(sessionId: string): number {
    return Math.max(this.#everyone, this.#nudged.get(sessionId) ?? 0);
  }

  /** Wakes the helper of `sessionId` (or every helper, without one): it re-probes now instead of at its next periodic check. */
  nudge(sessionId?: string): void {
    this.#generation += 1;
    if (sessionId === undefined) this.#everyone = this.#generation;
    else this.#nudged.set(sessionId, this.#generation);
    for (const waiter of [...this.#watchers]) if (sessionId === undefined || waiter.sessionId === sessionId) waiter.done();
  }

  /**
   * `GET /agent/v1/tools/watch?since=N`: resolves with the current generation once a wake-up
   * newer than `since` is meant for `sessionId`, or after `timeoutMs` (`nudged: false`).
   */
  watch(sessionId: string, since: number, timeoutMs = TOOLS_WATCH_MS): Promise<{ readonly generation: number; readonly nudged: boolean }> {
    if (this.#relevant(sessionId) > since) return Promise.resolve({ generation: this.#generation, nudged: true });
    return new Promise((resolve) => {
      const waiter: Waiter = {
        sessionId,
        done: () => {
          clearTimeout(timer);
          this.#watchers.delete(waiter);
          resolve({ generation: this.#generation, nudged: this.#relevant(sessionId) > since });
        },
      };
      const timer = setTimeout(waiter.done, timeoutMs);
      timer.unref?.();
      this.#watchers.add(waiter);
    });
  }

  /** Resolves `true` once the session's helper reports `tool` as listed, `false` after `timeoutMs`. */
  waitForTool(sessionId: string, tool: string, timeoutMs: number): Promise<boolean> {
    if (this.#listed.get(sessionId)?.tools.has(tool)) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        sessionId,
        done: () => {
          if (!this.#listed.get(sessionId)?.tools.has(tool)) return;
          finish(true);
        },
      };
      const finish = (value: boolean) => {
        clearTimeout(timer);
        this.#reportWaiters.delete(waiter);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.#reportWaiters.add(waiter);
    });
  }

  /** Answers every held watch (the service is closing). */
  close(): void {
    for (const waiter of [...this.#watchers]) waiter.done();
  }
}

function agentSession(request: FastifyRequest): string {
  const value = request.headers[AGENT_SESSION_HEADER];
  return typeof value === 'string' ? value : '';
}

/**
 * The helper's routes (agent token only, `security.ts`):
 * - `POST /agent/v1/tools` `{ tools: string[] }` → 204: the tools the helper's last `tools/list` answer gave its CLI;
 * - `GET /agent/v1/tools/watch?since=N` → `{ generation, nudged }`: held up to {@link TOOLS_WATCH_MS} until Switchboard wants it to re-probe.
 */
export async function registerAgentToolRoutes(app: FastifyInstance, registry: AgentToolsRegistry, watchMs = TOOLS_WATCH_MS): Promise<void> {
  app.post('/agent/v1/tools', async (request, reply) => {
    const body = request.body !== null && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    const tools = body['tools'];
    if (!Array.isArray(tools) || tools.some((name) => typeof name !== 'string') || tools.length > 500) {
      return reply.code(422).send({ error: 'invalid', message: 'tools must be a list of tool names' });
    }
    registry.report(agentSession(request), tools as string[]);
    return reply.code(204).send();
  });
  app.get<{ Querystring: { since?: string } }>('/agent/v1/tools/watch', async (request) => {
    const since = Number(request.query.since ?? 0);
    return registry.watch(agentSession(request), Number.isFinite(since) ? since : 0, watchMs);
  });
  app.addHook('preClose', async () => {
    registry.close();
  });
}
