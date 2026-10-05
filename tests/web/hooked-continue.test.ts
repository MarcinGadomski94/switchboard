import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../src/core/api.ts';
import { CONTINUED_DIVIDER } from '../../src/core/hooked-continue.ts';
import { continueRefusal, continueTitle } from '../../src/web/hooked-continue/continue.ts';
import { chatItems } from '../../src/web/views/session/chat.ts';

/** D72 (web): how the dialog reads a refusal, its title, and the chat's divider. */

describe('D72: the dialog', () => {
  it('409 terminal-running asks for the confirmation; anything else is the reason', () => {
    expect(continueRefusal(409, { error: 'terminal-running', message: 'x', pid: 4242 })).toEqual({ kind: 'confirm', pid: 4242 });
    expect(continueRefusal(409, { error: 'terminal-unknown', message: 'Not continued: unknown.' })).toEqual({ kind: 'error', text: 'Not continued: unknown.' });
    expect(continueRefusal(502, { error: 'stop-failed', message: 'Not continued: still running.' })).toEqual({ kind: 'error', text: 'Not continued: still running.' });
    expect(continueRefusal(0, null)).toEqual({ kind: 'error', text: 'Switchboard is not reachable.' });
  });

  it('names the machine of a peer\'s session', () => {
    expect(continueTitle(null)).toBe('Continue in Switchboard');
    expect(continueTitle('office-pc')).toBe('Continue in Switchboard (on office-pc)');
  });
});

describe('D72: the chat\'s divider', () => {
  it('"Continued in Switchboard (was a terminal session)" between the terminal\'s turns and the new ones; withdrawn bubbles are not shown', () => {
    const event = (id: number, label: string, payload: unknown): SessionEvent => ({ id, sessionId: 's', agentId: null, ts: `2026-10-05T00:00:0${id}.000Z`, endTs: null, kind: 'text', label, payload });
    const items = chatItems(
      [
        event(1, 'hi', { type: 'user', text: 'hi', origin: 'terminal', delivered: true }),
        event(2, 'later', { type: 'user', text: 'later', origin: 'user', delivered: false, withdrawn: true }),
        event(3, CONTINUED_DIVIDER, { type: 'lifecycle', action: 'continued', pid: 7 }),
        event(4, 'later', { type: 'user', text: 'later', origin: 'user', delivered: true }),
      ],
      [],
      null,
    );
    expect(items.map((item) => item.kind)).toEqual(['user', 'divider', 'user']);
    expect(items[1]).toMatchObject({ text: CONTINUED_DIVIDER, from: null, to: null });
  });
});

describe('D72: a message its terminal never took up', () => {
  it('its bubble stays, marked not sent (the Resend note); one that was resent is gone', () => {
    const event = (id: number, payload: unknown): SessionEvent => ({ id, sessionId: 's', agentId: null, ts: `2026-10-05T00:00:0${id}.000Z`, endTs: null, kind: 'text', label: 'x', payload });
    const items = chatItems(
      [
        event(1, { type: 'user', text: 'handed', origin: 'user', delivered: false, notSent: true }),
        event(2, { type: 'user', text: 'resent', origin: 'user', delivered: false, withdrawn: true }),
        event(3, { type: 'user', text: 'plain', origin: 'user', delivered: true }),
      ],
      [],
      null,
    );
    expect(items.map((item) => (item.kind === 'user' ? [item.text, item.notSent ?? false] : item.kind))).toEqual([
      ['handed', true],
      ['plain', false],
    ]);
  });
});
