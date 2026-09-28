import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Question, Session, SessionEvent } from '../../src/core/api.ts';
import { QR_BORDER, qrPath } from '../../src/web/components/qr.ts';
import { answeredOnText, batchWaiting, chatItems, stepLabel, stepMark } from '../../src/web/views/session/chat.ts';
import { REMOTE_LABEL, REMOTE_LINK_LABEL, REMOTE_NOTE, remoteToggle } from '../../src/web/views/session/session-header.ts';
import { eventLines } from '../../src/web/views/session/terminal-tail.ts';

/**
 * D24 in the UI (pure parts; the real path is tests/e2e/remote-control.spec.ts):
 * the header toggle's state and tooltip reason, the QR code, the popover's markup,
 * a batch answered on claude.ai in the chat, the `remote` step lines.
 */

const URL = 'https://claude.ai/code/session_FAKE01';

/** A component, imported at run time (the server tsconfig has no JSX; Vitest transforms it). */
async function component(file: string, name: string): Promise<(props: object) => unknown> {
  const module = (await import(/* @vite-ignore */ file)) as Record<string, (props: object) => unknown>;
  return module[name] as (props: object) => unknown;
}

type ToggleInput = Pick<Session, 'remote' | 'live' | 'attached'>;
const live = (remote: ToggleInput['remote'], extra: Partial<ToggleInput> = {}): ToggleInput => ({ remote, live: true, attached: true, ...extra });

describe('the Remote toggle (D24)', () => {
  it('no toggle without Remote state (the demo sessions: remote null / absent)', () => {
    expect(remoteToggle(live(null))).toBeNull();
    expect(remoteToggle({ live: true, attached: true })).toBeNull();
  });

  it('off by default and clickable while the process is live and Remote Control is available', () => {
    expect(remoteToggle(live({ available: true, enabled: false, url: null }))).toEqual({
      on: false,
      disabled: false,
      reason: null,
      title: 'Reachable from phone: turn Remote Control on (claude.ai and the Claude app)',
      url: null,
    });
    // An old link from an earlier bridge is not offered while Remote is off.
    expect(remoteToggle(live({ available: true, enabled: false, url: URL }))?.url).toBeNull();
  });

  it('on: the link, the tooltip says what a click does', () => {
    expect(remoteToggle(live({ available: true, enabled: true, url: URL }))).toEqual({ on: true, disabled: false, reason: null, title: 'Turn Remote Control off', url: URL });
  });

  it('disabled with the reason as its tooltip: no live process (off / on while paused), not available, detached', () => {
    expect(remoteToggle(live({ available: false, enabled: false, url: null }, { live: false }))).toMatchObject({
      disabled: true,
      reason: 'Remote needs a running claude process: resume the session first.',
    });
    const paused = remoteToggle(live({ available: false, enabled: true, url: URL }, { live: false }));
    expect(paused).toMatchObject({ on: true, disabled: true, url: URL, reason: 'Remote is on and reconnects when the session resumes: it needs a running claude process.' });
    expect(paused?.title).toBe(paused?.reason);
    expect(remoteToggle(live({ available: false, enabled: false, url: null }))).toMatchObject({
      disabled: true,
      reason: "Remote Control is not available here: claude's initialize did not report remote_control_available (it needs a claude.ai subscription login).",
    });
    expect(remoteToggle(live({ available: false, enabled: false, url: null }, { live: false, attached: false }))).toMatchObject({
      disabled: true,
      reason: 'The session continues in a terminal: attach it here first.',
    });
  });

  it('copy', () => {
    expect([REMOTE_LABEL, REMOTE_LINK_LABEL, REMOTE_NOTE]).toEqual(['Remote', 'Link & QR', "While Remote is on, the transcript is stored on Anthropic's servers."]);
  });
});

describe('the QR code (D24, uqr)', () => {
  it('encodes the link with a 4-module quiet zone; the three finder patterns sit in the corners', () => {
    const qr = qrPath(URL);
    expect(qr.size).toBe(qr.modules.length);
    // Version n is 17 + 4n modules, plus the quiet zone on both sides.
    expect((qr.size - 2 * QR_BORDER - 17) % 4).toBe(0);
    const dark = (x: number, y: number): boolean => qr.modules[y]?.[x] === true;
    const inner = qr.size - 2 * QR_BORDER;
    for (const [ox, oy] of [
      [QR_BORDER, QR_BORDER],
      [QR_BORDER + inner - 7, QR_BORDER],
      [QR_BORDER, QR_BORDER + inner - 7],
    ] as const) {
      for (let i = 0; i < 7; i++) {
        expect(dark(ox + i, oy)).toBe(true);
        expect(dark(ox + i, oy + 6)).toBe(true);
        expect(dark(ox, oy + i)).toBe(true);
        expect(dark(ox + 6, oy + i)).toBe(true);
      }
      expect(dark(ox + 1, oy + 1)).toBe(false);
      expect(dark(ox + 3, oy + 3)).toBe(true);
    }
    // The quiet zone is light.
    expect(qr.modules[0]?.every((module) => !module)).toBe(true);
    expect(qr.modules.every((row) => row.slice(0, QR_BORDER).every((module) => !module))).toBe(true);
    // One path; every dark module is drawn exactly once (runs per row).
    const drawn = [...qr.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)].reduce((sum, match) => sum + Number(match[3]), 0);
    expect(drawn).toBe(qr.modules.flat().filter(Boolean).length);
    expect(qrPath(URL)).toEqual(qr);
    expect(qrPath(`${URL}2`).path).not.toBe(qr.path);
  });

  it('renders as SVG with React elements (the light primary token behind the dark modules)', async () => {
    const QrCode = await component('../../src/web/components/QrCode.tsx', 'QrCode');
    const html = renderToStaticMarkup(createElement(QrCode as never, { text: URL, label: 'QR code of the claude.ai link' }));
    const qr = qrPath(URL);
    expect(html).toContain(`viewBox="0 0 ${qr.size} ${qr.size}"`);
    expect(html).toContain('width="168" height="168"');
    expect(html).toContain('fill="var(--primary-bg)"');
    expect(html).toContain(`d="${qr.path}" fill="var(--primary-fg)"`);
    expect(html).toContain('role="img" aria-label="QR code of the claude.ai link"');
    expect(html).toContain(`data-text="${URL}"`);
  });
});

describe('the Remote popover and the phone glyph (D24)', () => {
  it('the link opens in a new tab with rel noopener noreferrer; Open, Copy link, the QR and the note', async () => {
    const RemotePopover = await component('../../src/web/views/session/RemotePopover.tsx', 'RemotePopover');
    const html = renderToStaticMarkup(createElement(RemotePopover as never, { url: URL, onClose: () => undefined }));
    expect(html).toContain(`<a class="sb-sv-remote-pop-url" data-testid="remote-link" href="${URL}" target="_blank" rel="noopener noreferrer">${URL}</a>`);
    expect(html).toContain(`data-testid="remote-open" href="${URL}" target="_blank" rel="noopener noreferrer">Open</a>`);
    expect(html).toContain('data-testid="remote-copy">Copy link</button>');
    expect(html).toContain('data-testid="remote-qr"');
    expect(html).toContain(`<div class="sb-sv-remote-pop-note" data-testid="remote-note">While Remote is on, the transcript is stored on Anthropic&#x27;s servers.</div>`);
    expect(html).toContain('role="dialog" aria-label="Remote Control"');
  });

  it('the glyph is decorative unless titled', async () => {
    const PhoneGlyph = await component('../../src/web/components/PhoneGlyph.tsx', 'PhoneGlyph');
    expect(renderToStaticMarkup(createElement(PhoneGlyph as never, {}))).toContain('aria-hidden="true"');
    const titled = renderToStaticMarkup(createElement(PhoneGlyph as never, { title: 'Remote Control on' }));
    expect(titled).toContain('role="img" aria-label="Remote Control on"');
    expect(titled).toContain('<title>Remote Control on</title>');
  });
});

let clock = 0;
function event(id: number, payload: unknown, extra: Partial<SessionEvent> = {}): SessionEvent {
  clock += 1;
  return { id, sessionId: 's', agentId: 'main', ts: `2026-09-28T10:00:${String(clock).padStart(2, '0')}.000Z`, endTs: null, kind: 'text', label: '', payload, ...extra };
}

function question(id: string, extra: Partial<Question> = {}): Question {
  return {
    id,
    batchId: 'b1',
    sessionId: 's',
    source: 'main',
    text: `Question ${id}?`,
    header: null,
    options: [{ label: 'A' }, { label: 'B' }],
    multiSelect: false,
    state: 'open',
    answerIndex: null,
    answeredAt: null,
    ...extra,
  };
}

describe('the chat: answered on claude.ai and the remote step lines (D24)', () => {
  it('a batch the phone answered no longer waits (the answers bubble says where)', () => {
    const open = [question('q1'), question('q2')];
    expect(batchWaiting(open)).toBe(true);
    const phone = open.map((q) => ({ ...q, state: 'answered' as const, answeredOn: 'claude.ai' as const }));
    expect(batchWaiting(phone)).toBe(false);
    expect(answeredOnText('claude.ai')).toBe('Answered on claude.ai');
    const ask = event(1, { type: 'tool', name: 'AskUserQuestion', toolUseId: 't1', input: {}, requestId: 'b1', requestState: 'cancelled', answeredOn: 'claude.ai' });
    const items = chatItems([ask], phone, 'main');
    expect(items).toEqual([{ kind: 'questions', key: 'q:b1', batchId: 'b1', questions: phone, waiting: false }]);
  });

  it('a permission request answered on the phone: ✓ and the label says where; the remote events are step lines', () => {
    const request = event(2, { type: 'request', requestId: 'r1', toolName: 'Bash', toolUseId: null, input: {}, agentId: null, description: null, decisionReason: null, state: 'cancelled', answeredOn: 'claude.ai' }, { kind: 'ask', label: 'Permission · Bash · node -e 1' });
    expect(stepMark(request)).toBe('✓');
    expect(stepLabel(request)).toBe('Permission · Bash · node -e 1 · answered on claude.ai');
    const interrupted = event(3, { type: 'request', requestId: 'r2', toolName: 'Bash', toolUseId: null, input: {}, agentId: null, description: null, decisionReason: null, state: 'cancelled' }, { kind: 'ask', label: 'Permission · Bash · x' });
    expect(stepMark(interrupted)).toBe('✕');
    expect(stepLabel(interrupted)).toBe('Permission · Bash · x');

    const on = event(4, { type: 'remote', action: 'on', reattach: false, url: URL }, { label: `Remote Control on · ${URL}` });
    const failed = event(5, { type: 'remote', action: 'failed', enabled: true, reattach: true, error: 'archived' }, { kind: 'error', label: 'Remote Control could not reconnect: archived' });
    const off = event(6, { type: 'remote', action: 'off' }, { label: 'Remote Control off' });
    expect([on, failed, off].map(stepMark)).toEqual(['✓', '✕', '✓']);
    const items = chatItems([request, on, failed, off], [], 'main');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'agent',
      text: '',
      steps: [
        { id: 2, mark: '✓', label: 'Permission · Bash · node -e 1 · answered on claude.ai' },
        { id: 4, mark: '✓', label: `Remote Control on · ${URL}` },
        { id: 5, mark: '✕', label: 'Remote Control could not reconnect: archived' },
        { id: 6, mark: '✓', label: 'Remote Control off' },
      ],
    });
  });

  it('the terminal tail shows them too', () => {
    const request = event(7, { type: 'request', requestId: 'r1', toolName: 'Bash', toolUseId: null, input: {}, agentId: null, description: null, decisionReason: null, state: 'cancelled', answeredOn: 'claude.ai' }, { kind: 'ask', label: 'Permission · Bash · node -e 1' });
    expect(eventLines(request)).toEqual(['✓ Permission · Bash · node -e 1 · answered on claude.ai']);
    expect(eventLines(event(8, { type: 'remote', action: 'on', url: URL }, { label: `Remote Control on · ${URL}` }))).toEqual([`✓ Remote Control on · ${URL}`]);
    expect(eventLines(event(9, { type: 'remote', action: 'failed', error: 'x' }, { kind: 'error', label: 'Remote Control could not be turned on: x' }))).toEqual(['✕ Remote Control could not be turned on: x']);
  });
});
