import { describe, expect, it } from 'vitest';
import { REMOTE_CONTROL_BADGE, buildHistoryRows } from '../../src/core/history.ts';
import { ANSWERED_ON_CLAUDE_AI, parseRemoteControlReply, remoteControlAvailable } from '../../src/core/remote-control.ts';
import { initializeLine, remoteControlLine } from '../../src/core/stdin.ts';
import { TRANSCRIPT_FACTS_VERSION, parseTranscript } from '../../src/core/transcript.ts';

/**
 * D24 (docs/remote-control.md): the stdin lines Switchboard writes, the replies it
 * reads (shapes from docs/spike-remote.md → R.6, code-read and never run, so read
 * defensively), and History's "Remote Control" badge from a `bridge-session` line.
 */

const OK_REPLY = {
  session_url: 'https://claude.ai/code/session_01AbC',
  connect_url: 'https://claude.ai/code?environment=env_1',
  environment_id: 'env_1',
  bridge_epoch: 3,
  bridge_session_id: 'cse_01AbC',
};

describe('stdin lines (D24)', () => {
  it('initialize: the spike probe shape, hooks null', () => {
    expect(initializeLine('sb-init-1')).toEqual({ type: 'control_request', request_id: 'sb-init-1', request: { subtype: 'initialize', hooks: null } });
  });

  it('remote_control on: name, keep_session_on_exit and (when given) reattach_session_id in the SDK field names', () => {
    expect(remoteControlLine('r1', { enabled: true, name: 'JIRA Ticket handling', keepSessionOnExit: true })).toEqual({
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'remote_control', enabled: true, name: 'JIRA Ticket handling', keep_session_on_exit: true },
    });
    expect(remoteControlLine('r2', { enabled: true, name: 'x', reattachSessionId: 'cse_01AbC', keepSessionOnExit: true }).request).toEqual({
      subtype: 'remote_control',
      enabled: true,
      name: 'x',
      reattach_session_id: 'cse_01AbC',
      keep_session_on_exit: true,
    });
    // One JSON line exactly as the spike's R.6 example orders it.
    expect(JSON.stringify(remoteControlLine('rc1', { enabled: true, name: '<title>', keepSessionOnExit: true }))).toBe(
      '{"type":"control_request","request_id":"rc1","request":{"subtype":"remote_control","enabled":true,"name":"<title>","keep_session_on_exit":true}}',
    );
  });

  it('remote_control off: only enabled false (the on-only fields are never sent)', () => {
    expect(remoteControlLine('r3', { enabled: false, name: 'ignored', reattachSessionId: 'cse_x', keepSessionOnExit: true }).request).toEqual({
      subtype: 'remote_control',
      enabled: false,
    });
  });
});

describe('initialize reply: remote_control_available (D24)', () => {
  it('true only when the CLI says exactly true', () => {
    expect(remoteControlAvailable({ remote_control_available: true, remote_control_auto_enable: false })).toBe(true);
    expect(remoteControlAvailable({ remote_control_available: false })).toBe(false);
    expect(remoteControlAvailable({ remote_control_available: 'true' })).toBe(false);
    expect(remoteControlAvailable({})).toBe(false);
    expect(remoteControlAvailable(null)).toBe(false);
    expect(remoteControlAvailable([true])).toBe(false);
  });
});

describe('remote_control reply parsing (D24)', () => {
  it('success on: the link and the cse_ id; unknown fields ignored', () => {
    expect(parseRemoteControlReply({ subtype: 'success', response: { ...OK_REPLY, extra: { nested: 1 } }, error: null }, true)).toEqual({
      ok: true,
      bridge: { sessionUrl: 'https://claude.ai/code/session_01AbC', bridgeSessionId: 'cse_01AbC' },
    });
  });

  it('success on without bridge_session_id: kept as null (no reattach later)', () => {
    const { bridge_session_id: _, ...rest } = OK_REPLY;
    expect(parseRemoteControlReply({ subtype: 'success', response: rest, error: null }, true)).toEqual({
      ok: true,
      bridge: { sessionUrl: OK_REPLY.session_url, bridgeSessionId: null },
    });
    expect(parseRemoteControlReply({ subtype: 'success', response: { ...OK_REPLY, bridge_session_id: 42 }, error: null }, true)).toMatchObject({
      ok: true,
      bridge: { bridgeSessionId: null },
    });
  });

  it('a missing, empty or non-string session_url is an error that quotes the reply', () => {
    const { session_url: _, ...rest } = OK_REPLY;
    const missing = parseRemoteControlReply({ subtype: 'success', response: rest, error: null }, true);
    expect(missing).toEqual({ ok: false, error: `claude's remote_control reply has no session_url: ${JSON.stringify(rest)}` });
    expect(parseRemoteControlReply({ subtype: 'success', response: { ...OK_REPLY, session_url: '  ' }, error: null }, true)).toMatchObject({ ok: false });
    expect(parseRemoteControlReply({ subtype: 'success', response: { ...OK_REPLY, session_url: 7 }, error: null }, true)).toMatchObject({ ok: false });
    expect(parseRemoteControlReply({ subtype: 'success', response: null, error: null }, true)).toEqual({
      ok: false,
      error: "claude's remote_control reply has no session_url: {}",
    });
  });

  it('a session_url that is not https is refused (it becomes a link and a QR code)', () => {
    for (const url of ['http://claude.ai/code/session_x', 'javascript:alert(1)', 'claude.ai/code/session_x']) {
      expect(parseRemoteControlReply({ subtype: 'success', response: { ...OK_REPLY, session_url: url }, error: null }, true)).toEqual({
        ok: false,
        error: expect.stringContaining('not an https URL'),
      });
    }
  });

  it('an error reply keeps the CLI text verbatim; one without text says so', () => {
    const text = 'Remote Control cannot be enabled from inside a remote session';
    expect(parseRemoteControlReply({ subtype: 'error', response: null, error: text }, true)).toEqual({ ok: false, error: text });
    expect(parseRemoteControlReply({ subtype: 'error', response: null, error: '  Workspace not trusted.\n' }, true)).toEqual({ ok: false, error: '  Workspace not trusted.\n' });
    expect(parseRemoteControlReply({ subtype: 'error', response: null, error: null }, false)).toEqual({
      ok: false,
      error: 'claude answered the remote_control request with an error and no text',
    });
  });

  it('success off needs no fields; an unknown subtype is an error', () => {
    expect(parseRemoteControlReply({ subtype: 'success', response: {}, error: null }, false)).toEqual({ ok: true, bridge: null });
    expect(parseRemoteControlReply({ subtype: 'success', response: null, error: null }, false)).toEqual({ ok: true, bridge: null });
    expect(parseRemoteControlReply({ subtype: 'pending', response: null, error: null }, true)).toEqual({
      ok: false,
      error: 'claude answered the remote_control request with "pending" (expected success or error)',
    });
  });

  it('answered on claude.ai is the one place a withdrawn request is labelled with', () => {
    expect(ANSWERED_ON_CLAUDE_AI).toBe('claude.ai');
  });
});

describe('History: the Remote Control badge (D24)', () => {
  const ROOT = '/Users/dev/work space';
  const line = (entry: Record<string, unknown>): string => JSON.stringify(entry);
  const prompt = (uuid: string, parent: string | null, text: string): string =>
    line({ type: 'user', uuid, parentUuid: parent, isSidechain: false, entrypoint: 'cli', cwd: ROOT, timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: text } });
  const bridge = line({ type: 'bridge-session', sessionId: 't-1', bridgeSessionId: 'cse_01AbC', lastSequenceNum: 4, ownerAccountUuid: 'x', ownerOrganizationUuid: 'y' });

  it('a bridge-session line marks the facts (version 2) and the terminal row gets remoteControl + a searchable badge', () => {
    expect(TRANSCRIPT_FACTS_VERSION).toBe(2);
    const withBridge = parseTranscript('t-1', [prompt('u1', null, 'Fix the login page'), bridge, bridge].join('\n'));
    const without = parseTranscript('t-2', prompt('u2', null, 'Tidy the README'));
    expect(withBridge.remoteControl).toBe(true);
    expect(without.remoteControl).toBe(false);

    const rows = buildHistoryRows({
      sessions: [],
      transcripts: [
        { facts: withBridge, mtimeMs: Date.parse('2026-09-28T10:00:00.000Z') },
        { facts: without, mtimeMs: Date.parse('2026-09-28T09:00:00.000Z') },
      ],
      roots: [{ path: ROOT, kind: 'workspace', folder: 'f1', folderPath: ROOT, repoName: null }],
      caseInsensitive: false,
      now: Date.parse('2026-09-28T12:00:00.000Z'),
    });
    const byId = new Map(rows.map((row) => [row.item.claudeSessionId, row]));
    expect(byId.get('t-1')?.item).toMatchObject({ terminal: true, remoteControl: true });
    expect(byId.get('t-2')?.item.terminal).toBe(true);
    expect(byId.get('t-2')?.item).not.toHaveProperty('remoteControl');
    expect(byId.get('t-1')?.search).toContain(REMOTE_CONTROL_BADGE.toLowerCase());
    expect(byId.get('t-2')?.search).not.toContain('remote control');
  });

  it('a stored session row carries no badge (D24 badges terminal conversations)', () => {
    const facts = parseTranscript('c-stored', [prompt('u1', null, 'Build it'), bridge].join('\n'));
    const [row] = buildHistoryRows({
      sessions: [
        {
          id: 's1',
          name: 'stored',
          claudeSessionId: 'c-stored',
          status: 'done',
          task: 'Build it',
          workType: null,
          mode: null,
          phase: null,
          solutions: [],
          createdAt: '2026-09-28T10:00:00.000Z',
          worktrees: [],
          folder: null,
          folderPath: ROOT,
        },
      ],
      transcripts: [{ facts, mtimeMs: 0 }],
      roots: [],
      caseInsensitive: false,
      now: 0,
    });
    expect(row?.item).not.toHaveProperty('remoteControl');
  });
});
