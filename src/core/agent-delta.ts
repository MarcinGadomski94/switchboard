import type { Agent, AgentsDelta, Session } from './api.ts';

/**
 * D95 follow-up (`docs/performance.md` → *Agent deltas*): a `sessionUpdated` carries
 * every agent of the session (hundreds of subagents in a long one), and one goes out
 * for every status or context change while a turn runs. A stream that asks for
 * deltas (`/hub?agents=delta`, `/peer/v1/events?agents=delta`) gets the whole list
 * the first time it hears of a session, and afterwards only the agents added or
 * changed (a finished agent once more, with its final state), the ids that went,
 * and the order when it changed. One encoder per stream (the server side), one
 * decoder per stream (the reading side): a new stream starts over with whole lists,
 * so a reconnect resynchronizes by itself.
 */

/** The query a stream asks for deltas with (`?agents=delta`). */
export const AGENT_DELTA_QUERY = 'agents';
export const AGENT_DELTA_VALUE = 'delta';

/** Each agent of a session as JSON, computed once per published session object (every stream shares it). */
const serialized = new WeakMap<Session, ReadonlyMap<string, string>>();

function agentStrings(session: Session): ReadonlyMap<string, string> {
  let map = serialized.get(session);
  if (!map) {
    map = new Map(session.agents.map((agent) => [agent.id, JSON.stringify(agent)]));
    serialized.set(session, map);
  }
  return map;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** One stream's sending side: remembers what it sent per session. */
export class AgentDeltaEncoder {
  readonly #sent = new Map<string, { readonly order: readonly string[]; readonly agents: ReadonlyMap<string, string> }>();

  /** The session as this stream sends it: whole the first time (and after {@link forget}), else with only the changed agents. */
  encode(session: Session): Session {
    const current = agentStrings(session);
    const order = session.agents.map((agent) => agent.id);
    const previous = this.#sent.get(session.id);
    this.#sent.set(session.id, { order, agents: current });
    if (!previous) {
      if (session.agentsDelta === undefined) return session;
      const { agentsDelta: _ignored, ...whole } = session;
      return whole;
    }
    const changed: Agent[] = session.agents.filter((agent) => previous.agents.get(agent.id) !== current.get(agent.id));
    const removed = previous.order.filter((id) => !current.has(id));
    const delta: AgentsDelta = sameOrder(previous.order, order) ? { removed } : { removed, order };
    return { ...session, agents: changed, agentsDelta: delta };
  }

  /** The stream will get the session's whole list next time (e.g. it left). */
  forget(sessionId: string): void {
    this.#sent.delete(sessionId);
  }
}

/** One stream's reading side: keeps each session's whole agent list and expands deltas into it. */
export class AgentDeltaDecoder {
  readonly #agents = new Map<string, readonly Agent[]>();

  /**
   * The session with its whole agent list. A delta for a session this stream never
   * had a whole list of (cannot happen with an encoder per stream) keeps the agents
   * it carries.
   */
  decode(session: Session): Session {
    // Not a session with an agent list (a malformed frame): passed on untouched.
    if (!Array.isArray(session.agents)) return session;
    if (session.agentsDelta === undefined || session.agentsDelta === null || typeof session.agentsDelta !== 'object') {
      this.#agents.set(session.id, session.agents);
      return session;
    }
    const { agentsDelta: delta, ...rest } = session;
    const known = this.#agents.get(session.id) ?? [];
    const byId = new Map(known.map((agent) => [agent.id, agent]));
    for (const id of Array.isArray(delta.removed) ? delta.removed : []) byId.delete(id);
    for (const agent of session.agents) byId.set(agent.id, agent);
    let agents: Agent[];
    if (Array.isArray(delta.order)) agents = delta.order.map((id) => byId.get(id)).filter((agent): agent is Agent => agent !== undefined);
    else {
      // Same ids in the same order: each place takes its new copy.
      agents = known.filter((agent) => byId.has(agent.id)).map((agent) => byId.get(agent.id) as Agent);
      const placed = new Set(agents.map((agent) => agent.id));
      for (const agent of session.agents) if (!placed.has(agent.id)) agents.push(agent);
    }
    this.#agents.set(session.id, agents);
    return { ...rest, agents };
  }

  /** Forgets every list (a new stream starts with whole lists again). */
  reset(): void {
    this.#agents.clear();
  }
}
