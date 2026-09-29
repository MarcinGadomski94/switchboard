import { describe, expect, it } from 'vitest';
import type { InboxItem, Session, SessionDetail } from '../../src/core/api.ts';
import { mapPeerAnswer, peerAnswerKind, peerHubEvent, peerInboxItem, peerSession, peerSessionDetail } from '../../src/core/peer-wire.ts';
import {
  cleanMachineName,
  isMachineId,
  isTailscaleIPv4,
  machineIdFrom,
  normalizePairingCode,
  pairingCodeFrom,
  parsePeerAddress,
  parseRemoteId,
  remoteId,
} from '../../src/core/peers.ts';

const MACHINE = { id: 'abcdefghijkl', name: 'pc-office', state: 'online' as const };

describe('D48 remote ids', () => {
  it('round-trips and never takes a local UUID for a remote id', () => {
    const id = remoteId('abcdefghijkl', '0b7c3e0a-1111-4222-8333-944455556666');
    expect(id).toBe('r~abcdefghijkl~0b7c3e0a-1111-4222-8333-944455556666');
    expect(parseRemoteId(id)).toEqual({ machineId: 'abcdefghijkl', id: '0b7c3e0a-1111-4222-8333-944455556666' });
    expect(parseRemoteId('0b7c3e0a-1111-4222-8333-944455556666')).toBeNull();
    expect(parseRemoteId('r~BAD~x')).toBeNull();
    expect(parseRemoteId('r~abcdefghijkl~')).toBeNull();
    expect(parseRemoteId(42)).toBeNull();
  });

  it('machine ids are 12 characters of a-z2-7', () => {
    const id = machineIdFrom(new Uint8Array(16).fill(255));
    expect(isMachineId(id)).toBe(true);
    expect(isMachineId('ABCDEFGHIJKL')).toBe(false);
    expect(isMachineId('abc')).toBe(false);
  });
});

describe('D48 pairing codes', () => {
  it('shows 8 characters as XXXX-XXXX and reads typed codes leniently', () => {
    const code = pairingCodeFrom(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(normalizePairingCode(code.toLowerCase().replace('-', ' '))).toBe(code);
    expect(normalizePairingCode('oooo-llll')).toBe('0000-1111');
    expect(normalizePairingCode('1234-567')).toBeNull();
    expect(normalizePairingCode('UUUU-UUUU')).toBeNull();
    expect(normalizePairingCode(null)).toBeNull();
  });
});

describe('D48 addresses', () => {
  it('accepts only Tailscale IPv4 (100.64.0.0/10) as a peer bind address', () => {
    expect(isTailscaleIPv4('100.64.0.1')).toBe(true);
    expect(isTailscaleIPv4('100.127.255.254')).toBe(true);
    expect(isTailscaleIPv4('100.128.0.1')).toBe(false);
    expect(isTailscaleIPv4('100.63.255.255')).toBe(false);
    expect(isTailscaleIPv4('127.0.0.1')).toBe(false);
    expect(isTailscaleIPv4('0.0.0.0')).toBe(false);
    expect(isTailscaleIPv4('192.168.1.10')).toBe(false);
  });

  it('parses typed peer addresses (IPv4 literal, optional port, default 13002)', () => {
    expect(parsePeerAddress('100.101.102.103')).toEqual({ host: '100.101.102.103', port: 13002 });
    expect(parsePeerAddress(' 100.101.102.103:4000 ')).toEqual({ host: '100.101.102.103', port: 4000 });
    expect(parsePeerAddress('pc.tailnet.ts.net')).toBeNull();
    expect(parsePeerAddress('100.101.102.103:0')).toBeNull();
    expect(parsePeerAddress('300.1.1.1')).toBeNull();
    expect(parsePeerAddress('[fd7a::1]:13002')).toBeNull();
  });

  it('cleans machine names', () => {
    expect(cleanMachineName('  pc\u0007-office ')).toBe('pc-office');
    expect(cleanMachineName('x'.repeat(60))).toHaveLength(40);
    expect(cleanMachineName('   ')).toBeNull();
  });
});

function session(id: string): Session {
  return {
    id,
    name: 'n',
    claudeSessionId: 'c',
    status: 'idle',
    workType: null,
    mode: null,
    phase: null,
    coordination: null,
    qaStack: null,
    ultracode: false,
    worktrees: false,
    solutions: [],
    attached: true,
    createdAt: '2026-09-29T10:00:00.000Z',
    lastActivityAt: null,
    agents: [],
    openQuestionCount: 0,
    cwd: null,
    folder: null,
    folderPath: null,
    folderKind: null,
    origin: 'switchboard',
    live: false,
    activity: null,
    resumeCommand: '',
    chips: [],
    loops: [{ id: 'loop1', sessionId: id } as never],
    machine: null,
  };
}

describe('D48 peer wire mapping', () => {
  it('namespaces a session and tags its machine', () => {
    const mapped = peerSession(MACHINE, session('s1'));
    expect(mapped.id).toBe('r~abcdefghijkl~s1');
    expect(mapped.loops[0]?.sessionId).toBe('r~abcdefghijkl~s1');
    expect(mapped.machine).toEqual(MACHINE);
  });

  it('namespaces a detail: events (and an AskUserQuestion requestId), questions and artifacts; question ids stay', () => {
    const detail = {
      ...session('s1'),
      task: 't',
      events: [{ id: 1, sessionId: 's1', agentId: null, ts: 't', endTs: null, kind: 'ask', label: 'q', payload: { type: 'tool', requestId: 'b1' } }],
      files: [],
      artifacts: [{ id: 'a1', type: 'DOC', name: 'x', solution: null, branch: null, sessionId: 's1', meta: null, createdAt: 't' }],
      questions: [{ id: 'q1', batchId: 'b1', sessionId: 's1' }],
      reportedTable: null,
    } as unknown as SessionDetail;
    const mapped = peerSessionDetail(MACHINE, detail);
    expect(mapped.id).toBe('r~abcdefghijkl~s1');
    expect(mapped.events[0]?.sessionId).toBe('r~abcdefghijkl~s1');
    expect((mapped.events[0]?.payload as { requestId: string }).requestId).toBe('r~abcdefghijkl~b1');
    expect(mapped.questions[0]).toMatchObject({ id: 'q1', batchId: 'r~abcdefghijkl~b1', sessionId: 'r~abcdefghijkl~s1' });
    expect(mapped.artifacts[0]?.sessionId).toBe('r~abcdefghijkl~s1');
  });

  it('namespaces an Inbox item (its id, session and questions) and keeps its actions', () => {
    const item = { id: 'b1', kind: 'questions', sessionId: 's1', questions: [{ id: 'q1', batchId: 'b1', sessionId: 's1' }], actions: [{ id: 'allow-once', label: 'Allow once' }] } as unknown as InboxItem;
    const mapped = peerInboxItem(MACHINE, item);
    expect(mapped).toMatchObject({ id: 'r~abcdefghijkl~b1', sessionId: 'r~abcdefghijkl~s1', machine: MACHINE, actions: [{ id: 'allow-once', label: 'Allow once' }] });
    expect(mapped.questions?.[0]?.batchId).toBe('r~abcdefghijkl~b1');
    expect(peerInboxItem(MACHINE, { ...item, sessionId: null }).sessionId).toBeNull();
  });

  it('maps hub events; schedule, worktree and system events are not forwarded', () => {
    expect(peerHubEvent(MACHINE, 'activity', { sessionId: 's1', activity: null })).toEqual({ sessionId: 'r~abcdefghijkl~s1', activity: null });
    expect(peerHubEvent(MACHINE, 'questionBatch', { sessionId: 's1', batchId: 'b1', questions: [] })).toEqual({ sessionId: 'r~abcdefghijkl~s1', batchId: 'r~abcdefghijkl~b1', questions: [] });
    expect(peerHubEvent(MACHINE, 'scheduleRun', { scheduleId: 'x', result: 'ok' } as never)).toBeNull();
    expect(peerHubEvent(MACHINE, 'system', {} as never)).toBeNull();
    expect(peerHubEvent(MACHINE, 'worktreeRemovable', {} as never)).toBeNull();
  });

  it('picks the mapping of a forwarded answer by its path', () => {
    expect(peerAnswerKind('GET', '/api/sessions')).toBe('sessions');
    expect(peerAnswerKind('POST', '/api/sessions')).toBe('session');
    expect(peerAnswerKind('GET', '/api/sessions/s1')).toBe('detail');
    expect(peerAnswerKind('GET', '/api/sessions/s1/events?since=x')).toBe('events');
    expect(peerAnswerKind('POST', '/api/sessions/s1/pause')).toBe('session');
    expect(peerAnswerKind('PUT', '/api/sessions/s1/model')).toBe('session');
    expect(peerAnswerKind('GET', '/api/sessions/s1/diff')).toBe('none');
    // D51: a workflow agent's chat: its events are namespaced.
    expect(peerAnswerKind('GET', '/api/sessions/s1/workflow-agents/wf_a.a1/chat')).toBe('workflow-chat');
    expect(mapPeerAnswer({ id: 'm1', name: 'A', state: 'online' }, 'workflow-chat', { events: [{ id: 1, sessionId: 's1', agentId: 'wf_a.a1', ts: 't', endTs: null, kind: 'text', label: 'x', payload: null }], result: null, version: 3 })).toEqual({
      events: [{ id: 1, sessionId: 'r~m1~s1', agentId: 'wf_a.a1', ts: 't', endTs: null, kind: 'text', label: 'x', payload: null }],
      result: null,
      version: 3,
    });
    expect(peerAnswerKind('GET', '/api/inbox')).toBe('inbox');
    expect(peerAnswerKind('POST', '/api/terminal-sessions/abc/hook')).toBe('session');
    expect(peerAnswerKind('GET', '/api/folders')).toBe('none');
    expect(mapPeerAnswer(MACHINE, 'sessions', [session('s1')])).toEqual([peerSession(MACHINE, session('s1'))]);
    expect(mapPeerAnswer(MACHINE, 'session', { error: 'x' })).toEqual({ error: 'x' });
  });
});
