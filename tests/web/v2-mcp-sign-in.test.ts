import { describe, expect, it } from 'vitest';
import { signInNoticeText } from '../../src/core/mcp-sign-in.ts';
import { reconnectText, signInNoticeRows } from '../../src/web/v2/agent/mcp-sign-in-model.ts';
import { connectorRows } from '../../src/web/v2/settings/connectors-model.ts';

/** D163: the agent view's sign-in notices (`McpSignInNotice`). */
describe('v2 · MCP sign-in notices', () => {
  const needs = [
    { name: 'claude.ai Gmail', claudeAi: true },
    { name: 'docs', claudeAi: false },
  ];

  it('one row per server the running CLI needs, minus the dismissed; none for a closed agent; a paired computer\'s says where', () => {
    expect(signInNoticeRows({ mcpSignIn: needs, machine: null, closedAt: null }).map((row) => [row.name, row.claudeAi, row.elsewhere, row.text])).toEqual([
      ['claude.ai Gmail', true, null, signInNoticeText({ name: 'claude.ai Gmail', claudeAi: true })],
      ['docs', false, null, 'docs needs you to sign in again'],
    ]);
    expect(signInNoticeRows({ mcpSignIn: needs, machine: null, closedAt: null }, new Set(['docs'])).map((row) => row.name)).toEqual(['claude.ai Gmail']);
    expect(signInNoticeRows({ mcpSignIn: needs, machine: null, closedAt: '2026-11-11T10:00:00.000Z' })).toEqual([]);
    expect(signInNoticeRows({ machine: null, closedAt: null })).toEqual([]);
    expect(signInNoticeRows(null)).toEqual([]);
    expect(signInNoticeRows({ mcpSignIn: needs, machine: { id: 'm', name: 'mac-laptop', state: 'online' }, closedAt: null })[0]?.elsewhere).toBe('mac-laptop');
  });

  it('says how the reconnect went', () => {
    expect(reconnectText('docs', 1, 0)).toBe('Signed in. The agent reconnected docs.');
    expect(reconnectText('docs', 2, 1)).toBe('Signed in. 2 reconnected docs; 1 could not be told (restart it).');
    expect(reconnectText('docs', 0, 1)).toBe('Signed in, but the agent could not reconnect docs: restart it, or use /mcp in its terminal.');
  });
});

/** D183: Settings › Advanced › Connections' claude.ai connectors card. */
describe('v2 · claude.ai connectors and muted sign-ins (Settings)', () => {
  it('lists every connector seen with its status and whether Switchboard asks; other muted servers below; nothing before it loads', () => {
    expect(connectorRows(null)).toEqual({ connectors: [], otherMuted: [] });
    const rows = connectorRows({
      muted: ['claude.ai Google Drive', 'docs'],
      connectors: [
        { name: 'claude.ai Notion', status: 'connected', at: 't' },
        { name: 'claude.ai Google Drive', status: 'needs-auth', at: 't' },
        { name: 'claude.ai Slack', status: 'failed', at: 't' },
      ],
    });
    expect(rows.connectors.map((row) => [row.name, row.status, row.statusText, row.ask])).toEqual([
      ['claude.ai Google Drive', 'needs-auth', 'needs a sign-in', false],
      ['claude.ai Notion', 'connected', 'connected', true],
      ['claude.ai Slack', 'other', 'failed', true],
    ]);
    expect(rows.otherMuted).toEqual(['docs']);
  });
});