import { describe, expect, it } from 'vitest';
import { reconnectText, signInNoticeRows } from '../../src/web/v2/agent/mcp-sign-in-model.ts';

/** D163: the agent view's sign-in notices (`McpSignInNotice`). */
describe('v2 · MCP sign-in notices', () => {
  const needs = [
    { name: 'claude.ai Gmail', claudeAi: true },
    { name: 'docs', claudeAi: false },
  ];

  it('one row per server the running CLI needs, minus the dismissed; none for a closed agent; a paired computer\'s says where', () => {
    expect(signInNoticeRows({ mcpSignIn: needs, machine: null, closedAt: null }).map((row) => [row.name, row.claudeAi, row.elsewhere, row.text])).toEqual([
      ['claude.ai Gmail', true, null, 'claude.ai Gmail needs you to sign in again on claude.ai'],
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
