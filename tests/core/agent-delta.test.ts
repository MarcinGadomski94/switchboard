import { describe, expect, it } from 'vitest';
import { AgentDeltaDecoder, AgentDeltaEncoder } from '../../src/core/agent-delta.ts';
import type { Agent, Session } from '../../src/core/api.ts';

/** D95 follow-up (`docs/performance.md` → *Agent deltas*): a stream's encoder and decoder round-trip every update. */

function agent(id: string, status: Agent['status'] = 'run'): Agent {
  return { id, kind: id === 'main' ? 'main' : 'subagent', name: id, description: null, solutionPath: null, branch: null, status, statusText: null, toolUseId: null, workflow: null };
}

function session(agents: Agent[], id = 's1', status: Session['status'] = 'run'): Session {
  return { id, name: id, status, agents } as unknown as Session;
}

describe('D95 · agent deltas', () => {
  it('whole the first time, then only what changed; the decoder gives back the whole list each time', () => {
    const encoder = new AgentDeltaEncoder();
    const decoder = new AgentDeltaDecoder();
    const updates = [
      session([agent('main'), agent('a'), agent('b')]),
      session([agent('main', 'done'), agent('a'), agent('b')], 's1', 'done'),
      session([agent('main', 'done'), agent('a'), agent('b')], 's1', 'done'),
      // A new subagent between others (a workflow's agents come after the stored ones).
      session([agent('main'), agent('a'), agent('c'), agent('b', 'done')]),
      // One gone.
      session([agent('main'), agent('c'), agent('b', 'done')]),
    ];
    const sent = updates.map((update) => encoder.encode(update));
    expect(sent[0]).toBe(updates[0]);
    expect(sent[1]?.agents.map((a) => a.id)).toEqual(['main']);
    expect(sent[1]?.agentsDelta).toEqual({ removed: [] });
    expect(sent[2]?.agents).toEqual([]);
    expect(sent[3]?.agents.map((a) => a.id)).toEqual(['main', 'c', 'b']);
    expect(sent[3]?.agentsDelta).toEqual({ removed: [], order: ['main', 'a', 'c', 'b'] });
    expect(sent[4]?.agentsDelta).toEqual({ removed: ['a'], order: ['main', 'c', 'b'] });
    for (const [index, message] of sent.entries()) {
      const decoded = decoder.decode(JSON.parse(JSON.stringify(message)) as Session);
      expect(decoded).toEqual(updates[index]);
      expect(decoded.agentsDelta).toBeUndefined();
    }
  });

  it('sessions are separate; a new stream (reset, a new encoder) starts with whole lists', () => {
    const encoder = new AgentDeltaEncoder();
    encoder.encode(session([agent('main')], 's1'));
    expect(encoder.encode(session([agent('x')], 's2')).agentsDelta).toBeUndefined();
    expect(encoder.encode(session([agent('main')], 's1')).agentsDelta).toEqual({ removed: [] });
    expect(new AgentDeltaEncoder().encode(session([agent('main')], 's1')).agentsDelta).toBeUndefined();
    const decoder = new AgentDeltaDecoder();
    decoder.decode(session([agent('main'), agent('a')]));
    decoder.reset();
    // A delta without a whole list before it keeps what it carries.
    expect(decoder.decode({ ...session([agent('a', 'done')]), agentsDelta: { removed: [] } }).agents.map((a) => a.id)).toEqual(['a']);
  });

  it('a 430-agent session: an update where one agent changed is a small fraction of the whole', () => {
    const many = [agent('main'), ...Array.from({ length: 429 }, (_, i) => agent(`sub-${i}`, 'done'))];
    const encoder = new AgentDeltaEncoder();
    const whole = JSON.stringify(encoder.encode(session(many)));
    const next = JSON.stringify(encoder.encode(session([agent('main', 'done'), ...many.slice(1)])));
    expect(next.length).toBeLessThan(whole.length / 50);
  });
});
