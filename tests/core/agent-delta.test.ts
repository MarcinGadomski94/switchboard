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

describe('D95-q3 · loops and model only when they change', () => {
  const loopsA = [{ id: 'l1', iterations: [{ result: 'ok', ts: null, label: 'one' }] }] as unknown as Session['loops'];
  const loopsB = [{ id: 'l1', iterations: [{ result: 'ok', ts: null, label: 'one' }, { result: 'run', ts: null, label: null }] }] as unknown as Session['loops'];
  const model = { current: 'opus', effort: null, available: null } as Session['model'];
  const with_ = (loops: Session['loops'], m: Session['model'] | undefined, status: Session['status'] = 'run'): Session =>
    ({ ...session([agent('main')], 's1', status), loops, ...(m === undefined ? {} : { model: m }) }) as Session;

  it('sent whole first, left out (and named) while equal, sent again when changed; the decoder puts the previous value back', () => {
    const encoder = new AgentDeltaEncoder();
    const decoder = new AgentDeltaDecoder();
    const updates = [with_(loopsA, model), with_(loopsA, model, 'done'), with_(loopsB, model), with_(loopsB, { ...model, current: 'sonnet' } as Session['model']), with_(loopsB, undefined)];
    const sent = updates.map((update) => JSON.parse(JSON.stringify(encoder.encode(update))) as Session);
    expect(sent[0]?.unchanged).toBeUndefined();
    expect(sent[0]?.loops).toEqual(loopsA);
    expect(sent[1]?.unchanged).toEqual(['loops', 'model']);
    expect('loops' in (sent[1] as object) || 'model' in (sent[1] as object)).toBe(false);
    expect(sent[2]?.unchanged).toEqual(['model']);
    expect(sent[2]?.loops).toEqual(loopsB);
    expect(sent[3]?.unchanged).toEqual(['loops']);
    // An absent field is never named (an older shape stays absent).
    expect(sent[4]?.unchanged).toEqual(['loops']);
    expect('model' in (sent[4] as object)).toBe(false);
    for (const [index, message] of sent.entries()) {
      const decoded = decoder.decode(message);
      expect(decoded).toEqual(updates[index]);
      expect(decoded.unchanged).toBeUndefined();
    }
  });

  it('a new stream (a new encoder, a reset decoder) starts whole; a payload already carrying the markers is cleaned first', () => {
    const encoder = new AgentDeltaEncoder();
    encoder.encode(with_(loopsA, model));
    expect(new AgentDeltaEncoder().encode(with_(loopsA, model)).unchanged).toBeUndefined();
    const stray = { ...with_(loopsA, model), unchanged: ['loops'] } as Session;
    expect(new AgentDeltaEncoder().encode(stray).unchanged).toBeUndefined();
    const decoder = new AgentDeltaDecoder();
    decoder.decode(with_(loopsA, model));
    decoder.reset();
    // Nothing remembered: the named field stays absent rather than invented.
    const { loops: _l, ...rest } = with_(loopsA, model);
    const decoded = decoder.decode({ ...rest, agentsDelta: { removed: [] }, unchanged: ['loops'] } as unknown as Session);
    expect(decoded.loops).toBeUndefined();
    expect(decoded.model).toEqual(model);
  });
});
