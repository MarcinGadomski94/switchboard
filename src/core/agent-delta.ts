import type { Agent, AgentsDelta, Session, UnchangedSessionField } from './api.ts';

/**
 * D95 follow-up (`docs/performance.md` → *Agent deltas*): a `sessionUpdated` carries
 * every agent of the session (hundreds of subagents in a long one), and one goes out
 * for every status or context change while a turn runs. A stream that asks for
 * deltas (`/hub?delta=1`, `/peer/v1/events?delta=1`) gets the whole list
 * the first time it hears of a session, and afterwards only the agents added or
 * changed (a finished agent once more, with its final state), the ids that went,
 * and the order when it changed. One encoder per stream (the server side), one
 * decoder per stream (the reading side): a new stream starts over with whole lists,
 * so a reconnect resynchronizes by itself.
 *
 * Second follow-up (D95-q3): the heavy fields in {@link DELTA_FIELDS} (`loops`, `model`)
 * are left out of an update when they equal what the stream last sent for the
 * session, and named in `Session.unchanged`; the decoder puts the previous value back.
 */

/** The query a stream asks for deltas with (`?delta=1`). */
export const AGENT_DELTA_QUERY = 'delta';
export const AGENT_DELTA_VALUE = '1';

/** `true` when a stream's query asks for deltas. */
export function wantsDeltas(query: { readonly delta?: unknown } | undefined): boolean {
  return query?.delta === AGENT_DELTA_VALUE;
}

/** D95-q3: the session fields a delta stream sends only when they changed. */
export const DELTA_FIELDS: readonly UnchangedSessionField[] = ['loops', 'model'];

/** The {@link DELTA_FIELDS} of a session as JSON (`undefined` = absent), once per published session object. */
const fieldStrings = new WeakMap<Session, ReadonlyMap<UnchangedSessionField, string | undefined>>();

function fieldsOf(session: Session): ReadonlyMap<UnchangedSessionField, string | undefined> {
  let map = fieldStrings.get(session);
  if (!map) {
    map = new Map(DELTA_FIELDS.map((field) => [field, session[field] === undefined ? undefined : JSON.stringify(session[field])]));
    fieldStrings.set(session, map);
  }
  return map;
}

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
  readonly #sent = new Map<
    string,
    { readonly order: readonly string[]; readonly agents: ReadonlyMap<string, string>; readonly fields: ReadonlyMap<UnchangedSessionField, string | undefined> }
  >();

  /**
   * The session as this stream sends it: whole the first time (and after {@link forget}),
   * else with only the changed agents and without the {@link DELTA_FIELDS} that did not change.
   */
  encode(session: Session): Session {
    const current = agentStrings(session);
    const fields = fieldsOf(session);
    const order = session.agents.map((agent) => agent.id);
    const previous = this.#sent.get(session.id);
    this.#sent.set(session.id, { order, agents: current, fields });
    if (!previous) {
      if (session.agentsDelta === undefined && session.unchanged === undefined) return session;
      const { agentsDelta: _delta, unchanged: _unchanged, ...whole } = session;
      return whole;
    }
    const changed: Agent[] = session.agents.filter((agent) => previous.agents.get(agent.id) !== current.get(agent.id));
    const removed = previous.order.filter((id) => !current.has(id));
    const delta: AgentsDelta = sameOrder(previous.order, order) ? { removed } : { removed, order };
    const out: Record<string, unknown> = { ...session, agents: changed, agentsDelta: delta };
    delete out['unchanged'];
    const unchanged: UnchangedSessionField[] = [];
    for (const field of DELTA_FIELDS) {
      const value = fields.get(field);
      if (value !== undefined && value === previous.fields.get(field)) {
        delete out[field];
        unchanged.push(field);
      }
    }
    if (unchanged.length > 0) out['unchanged'] = unchanged;
    return out as unknown as Session;
  }

  /** The stream will get the session's whole list next time (e.g. it left). */
  forget(sessionId: string): void {
    this.#sent.delete(sessionId);
  }
}

/** One stream's reading side: keeps each session's whole agent list and expands deltas into it. */
export class AgentDeltaDecoder {
  readonly #agents = new Map<string, readonly Agent[]>();
  /** D95-q3: each session's last {@link DELTA_FIELDS} values. */
  readonly #fields = new Map<string, Partial<Record<UnchangedSessionField, unknown>>>();

  /** Puts back the fields an update named unchanged; remembers the ones it carries. */
  #fill(session: Session): Session {
    const { unchanged, ...rest } = session;
    const known = this.#fields.get(session.id) ?? {};
    const out: Record<string, unknown> = rest;
    if (Array.isArray(unchanged)) {
      for (const field of unchanged as readonly unknown[]) {
        const name = DELTA_FIELDS.find((candidate) => candidate === field);
        if (name !== undefined && out[name] === undefined && name in known) out[name] = known[name];
      }
    }
    const next: Partial<Record<UnchangedSessionField, unknown>> = {};
    for (const field of DELTA_FIELDS) if (out[field] !== undefined) next[field] = out[field];
    this.#fields.set(session.id, next);
    return out as unknown as Session;
  }

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
      return this.#fill(session);
    }
    const delta = session.agentsDelta;
    const { agentsDelta: _delta, ...rest } = this.#fill(session);
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
    this.#fields.clear();
  }
}
