import { describe, expect, it } from 'vitest';
import type { Session, SessionEvent } from '../../src/core/api.ts';
import { chatItems } from '../../src/web/views/session/chat.ts';
import { offersSwitcher, sessionProvider, switchConfirmText, switchProgressText } from '../../src/web/views/session/provider-switch.ts';

function event(id: number, kind: SessionEvent['kind'], label: string, payload: unknown): SessionEvent {
  return { id, sessionId: 's', agentId: null, ts: `2026-10-01T00:00:0${id}.000Z`, endTs: null, kind, label, payload };
}

describe('D62 P5 · the header switcher and the chat divider (web)', () => {
  it('a switch is a divider between the CLIs\' messages; a failed one is not', () => {
    const items = chatItems(
      [
        event(1, 'text', 'hello', { type: 'user', text: 'hello', origin: 'user', delivered: true }),
        event(2, 'text', 'Switched from Claude Code to Codex CLI · handover by Claude Code (outgoing agent)', { type: 'lifecycle', action: 'switched', from: 'claude', to: 'codex', handoverBy: 'outgoing' }),
        event(3, 'error', 'Could not switch to OpenCode: boom', { type: 'lifecycle', action: 'switched', from: 'codex', to: 'opencode' }),
        event(4, 'text', 'Paused', { type: 'lifecycle', action: 'paused' }),
      ],
      [],
      null,
    );
    expect(items.map((item) => item.kind)).toEqual(['user', 'divider']);
    expect(items[1]).toMatchObject({ kind: 'divider', text: 'Switched from Claude Code to Codex CLI · handover by Claude Code (outgoing agent)', from: 'claude', to: 'codex' });
  });

  it('texts: the confirmation and the progress of each step', () => {
    expect(switchConfirmText('claude', 'codex')).toBe(
      "Switch this session from Claude Code to Codex CLI? Claude Code writes a handover first (if it can't, Codex CLI reads the chat history itself); then Codex CLI continues here, in the same folder.",
    );
    const base = { id: 'x', from: 'claude' as const, to: 'opencode' as const, handoverBy: null };
    expect(switchProgressText({ ...base, step: 'handover' })).toBe('Switching to OpenCode… asking Claude Code for a handover');
    expect(switchProgressText({ ...base, step: 'export' })).toBe('Switching to OpenCode… exporting the chat for OpenCode');
    expect(switchProgressText({ ...base, step: 'stopping' })).toBe('Switching to OpenCode… stopping Claude Code');
    expect(switchProgressText({ ...base, step: 'starting' })).toBe('Switching to OpenCode… starting OpenCode');
  });

  it('the switcher shows for sessions Switchboard runs (not hooked, not the demo\'s, not closed or detached); an older payload is Claude Code', () => {
    const session = { hooked: false, model: { current: null, effort: null, available: null }, closedAt: null, attached: true } as unknown as Session;
    expect(offersSwitcher(session)).toBe(true);
    expect(offersSwitcher({ ...session, hooked: true })).toBe(false);
    expect(offersSwitcher({ ...session, model: null })).toBe(false);
    expect(offersSwitcher({ ...session, closedAt: 'x' })).toBe(false);
    expect(offersSwitcher({ ...session, attached: false })).toBe(false);
    expect(sessionProvider({})).toBe('claude');
    expect(sessionProvider({ provider: 'codex' })).toBe('codex');
  });
});

describe('D62 P7 · marked and added parts (web)', () => {
  it('Remote Control is disabled with the reason on another CLI\'s session', async () => {
    const { remoteToggle } = await import('../../src/web/views/session/session-header.ts');
    const toggle = remoteToggle({ remote: { enabled: false, available: false, url: null } as never, live: true, attached: true, provider: 'codex' });
    expect(toggle).toMatchObject({ disabled: true, reason: 'Not available in Codex CLI: Remote Control (claude.ai on the phone) is a Claude Code feature.' });
  });

  it('D66: the footer grid adds a Codex line from its windows (5h and week bars; a window the CLI did not size only in the tooltip)', async () => {
    const { usageGridLines } = await import('../../src/web/shell/format.ts');
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    const lines = usageGridLines(
      {
        cliUsage: [
          { provider: 'codex', label: 'Codex 5h', pct: 12, resetsAt: '2026-10-01T14:00:00.000Z', key: 'session' },
          { provider: 'codex', label: 'Codex limit', pct: 5, resetsAt: null, key: 'model' },
        ],
      } as never,
      now,
    );
    expect(lines.map((line) => [line.label, line.session.text, line.week.text])).toEqual([
      ['Claude', '—', '—'],
      ['Codex', '12%', '—'],
    ]);
    expect(lines[1]?.title).toContain('5h: 12% · resets in 2h00');
    expect(lines[1]?.title).toContain('Codex limit: 5% · reset unknown');
  });
});
