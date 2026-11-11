import { describe, expect, it } from 'vitest';
import { isClaudeAiConnector, parseInitMcpServers, sameNeeds, signInItemDetail, signInNeeds, signInNoticeText } from '../../src/core/mcp-sign-in.ts';
import { parseStreamLine } from '../../src/core/stream-json.ts';
import { McpSignInNeeds } from '../../src/server/mcp/sign-in-needs.ts';
import { type McpSignInItems, McpSignInService } from '../../src/server/mcp/sign-in.ts';

/**
 * D163 (`docs/mcp.md` → *Sign-in where it happens*): the init's `mcp_servers` (as recorded
 * from the CLI), what a session needs, the registry, and the Needs-you item's episodes.
 */

// From a recorded CLI init (tools/fake-claude/fixtures): a claude.ai connector that needs a sign-in.
const RECORDED = [
  { name: 'codebase-memory-mcp', status: 'connected', source: 'project' },
  { name: 'claude.ai Google Drive', status: 'needs-auth', source: 'claudeai' },
  { name: 'figma-local', status: 'failed', source: 'project' },
];

describe('the init\'s MCP servers', () => {
  it('reads mcp_servers, skips malformed rows, and the stream parser lifts them on init', () => {
    expect(parseInitMcpServers([...RECORDED, { name: '' }, 'x', { status: 'needs-auth' }])).toEqual(RECORDED);
    expect(parseInitMcpServers(undefined)).toEqual([]);
    const init = parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', mcp_servers: RECORDED, tools: [] }));
    expect(init.kind === 'init' ? init.mcpServers : null).toEqual(RECORDED);
  });

  it('needs only needs-auth servers, once each, by name; a claude.ai connector by its source or name', () => {
    expect(signInNeeds([...RECORDED, { name: 'docs', status: 'needs-auth', source: 'user' }, { name: 'docs', status: 'needs-auth', source: 'local' }])).toEqual([
      { name: 'claude.ai Google Drive', claudeAi: true },
      { name: 'docs', claudeAi: false },
    ]);
    expect(isClaudeAiConnector({ name: 'claude.ai Gmail', source: null })).toBe(true);
    expect(isClaudeAiConnector({ name: 'docs', source: 'user' })).toBe(false);
    expect(sameNeeds([{ name: 'a', claudeAi: false }], [{ name: 'a', claudeAi: false }])).toBe(true);
    expect(sameNeeds([{ name: 'a', claudeAi: false }], [])).toBe(false);
    expect(signInNoticeText({ name: 'docs', claudeAi: false })).toBe('docs needs you to sign in again');
    expect(signInNoticeText({ name: 'claude.ai Gmail', claudeAi: true })).toBe('claude.ai Gmail needs you to sign in again on claude.ai');
    expect(signInItemDetail('docs', ['Fix login', 'Docs'], false)).toContain('2 agents (“Fix login”, “Docs”) can’t use docs');
  });

  it('the registry: replaced per turn, resolved after a reconnect, dropped with the process; listeners hear changes only', () => {
    const needs = new McpSignInNeeds();
    let changes = 0;
    needs.onChange(() => (changes += 1));
    expect(needs.report('a', RECORDED)).toBe(true);
    expect(needs.report('a', RECORDED)).toBe(false);
    expect(needs.report('b', [{ name: 'claude.ai Google Drive', status: 'needs-auth', source: 'claudeai' }])).toBe(true);
    expect(needs.sessionsNeeding('claude.ai Google Drive')).toEqual(['a', 'b']);
    expect([...needs.byServer().entries()]).toEqual([['claude.ai Google Drive', { claudeAi: true, sessionIds: ['a', 'b'] }]]);
    expect(needs.resolve('a', 'claude.ai Google Drive')).toBe(true);
    expect(needs.of('a')).toEqual([]);
    expect(needs.forget('b')).toBe(true);
    expect(needs.forget('b')).toBe(false);
    expect(changes).toBe(4);
  });
});

/** A fake of the system items' D163 methods: an item per dedupe, raised once (open or closed). */
function fakeItems() {
  const items = new Map<string, { server: string; open: boolean; detail: string; outcome: string | null }>();
  const api: McpSignInItems = {
    async mcpSignInNotice(input) {
      const known = items.get(input.dedupe);
      if (known) {
        if (known.open) known.detail = input.detail;
        return null;
      }
      items.set(input.dedupe, { server: input.server, open: true, detail: input.detail, outcome: null });
      return {};
    },
    async closeMcpSignInNotices(server, outcome, keep = new Set()) {
      let closed = 0;
      for (const [dedupe, item] of items) {
        if (!item.open || keep.has(dedupe) || (server !== null && item.server !== server)) continue;
        item.open = false;
        item.outcome = outcome;
        closed += 1;
      }
      return closed;
    },
  };
  return { api, items };
}

function service(options: { readonly reconnectOk?: boolean } = {}) {
  const needs = new McpSignInNeeds();
  const { api, items } = fakeItems();
  const listeners: Array<(name: string) => void> = [];
  const reconnects: string[] = [];
  const announced: string[] = [];
  let clock = 1_000;
  const sessions = new Map([
    ['a', { id: 'a', name: 'a', title: 'Fix login', cwd: '/work', root: '/work', folderId: null }],
    ['b', { id: 'b', name: 'b', title: null, cwd: null, root: null, folderId: null }],
  ]);
  const signIn = new McpSignInService({
    store: { sessions: { get: async (id: string) => sessions.get(id) ?? null } } as never,
    needs,
    mcp: {
      startAuth: async (folder, name) => ({ id: `auth-${name}`, server: name, state: 'waiting', authUrl: `http://127.0.0.1/authorize?${folder.root}`, callbackExpected: true, error: null, instructions: null }),
      onSignedIn: (listener) => {
        listeners.push(listener as (name: string) => void);
        return () => undefined;
      },
    },
    reconnect: async (sessionId, name) => {
      reconnects.push(`${sessionId}:${name}`);
      return options.reconnectOk ?? true;
    },
    announce: async (sessionId) => void announced.push(sessionId),
    items: api,
    now: () => clock++,
  });
  signIn.start();
  return { needs, items, signIn, listeners, reconnects, announced };
}

describe('the Needs-you item and the sign-in (McpSignInService)', () => {
  it('one item per server and episode, up to date as agents join; a dismissed one is not raised again in the episode; a new episode raises a new one', async () => {
    const s = service();
    s.needs.report('a', [{ name: 'docs', status: 'needs-auth', source: 'user' }]);
    await s.signIn.idle();
    expect([...s.items.values()]).toMatchObject([{ server: 'docs', open: true }]);
    s.needs.report('b', [{ name: 'docs', status: 'needs-auth', source: 'user' }]);
    await s.signIn.idle();
    expect(s.items.size).toBe(1);
    expect([...s.items.values()][0]?.detail).toContain('2 agents');
    // Dismissed (closed by the developer): the same episode never raises it again.
    for (const item of s.items.values()) item.open = false;
    s.needs.report('a', [{ name: 'docs', status: 'needs-auth', source: 'user' }, { name: 'x', status: 'connected', source: 'user' }]);
    await s.signIn.idle();
    expect([...s.items.values()].filter((item) => item.open)).toEqual([]);
    // Nobody needs it any more: the episode ends; when it comes back, a new item.
    s.needs.forget('a');
    s.needs.forget('b');
    await s.signIn.idle();
    s.needs.report('a', [{ name: 'docs', status: 'needs-auth', source: 'user' }]);
    await s.signIn.idle();
    expect([...s.items.values()].filter((item) => item.open)).toHaveLength(1);
    expect(s.items.size).toBe(2);
  });

  it('closes the item (resolved) when no agent needs the server; Sign in runs in the agent\'s folder; refusals', async () => {
    const s = service();
    s.needs.report('a', [{ name: 'docs', status: 'needs-auth', source: 'user' }, { name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai' }]);
    s.needs.report('b', [{ name: 'docs', status: 'needs-auth', source: 'user' }]);
    await s.signIn.idle();
    expect(await s.signIn.signIn('a', 'docs')).toMatchObject({ state: 'waiting', authUrl: 'http://127.0.0.1/authorize?/work' });
    await expect(s.signIn.signIn('a', 'claude.ai Gmail')).rejects.toMatchObject({ code: 'claude-ai', status: 409 });
    await expect(s.signIn.signIn('a', 'nope')).rejects.toMatchObject({ code: 'not-needed', status: 404 });
    await expect(s.signIn.signIn('b', 'docs')).rejects.toMatchObject({ code: 'no-folder', status: 409 });
    await expect(s.signIn.signIn('zzz', 'docs')).rejects.toMatchObject({ code: 'not-found' });
    // A finished sign-in (from anywhere) reconnects every agent that needs it; their items close.
    s.listeners[0]?.('docs');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await s.signIn.idle();
    expect(s.reconnects.sort()).toEqual(['a:docs', 'b:docs']);
    expect(s.announced.sort()).toEqual(['a', 'b']);
    expect(s.needs.sessionsNeeding('docs')).toEqual([]);
    const docs = [...s.items.values()].find((item) => item.server === 'docs');
    expect(docs).toMatchObject({ open: false, outcome: 'resolved' });
    expect([...s.items.values()].find((item) => item.server === 'claude.ai Gmail')?.open).toBe(true);
  });

  it('a CLI that cannot reconnect keeps the need (and the item); the result says which failed', async () => {
    const s = service({ reconnectOk: false });
    s.needs.report('a', [{ name: 'docs', status: 'needs-auth', source: 'user' }]);
    await s.signIn.idle();
    expect(await s.signIn.reconnect('docs')).toEqual({ server: 'docs', reconnected: [], failed: ['a'] });
    expect(s.needs.sessionsNeeding('docs')).toEqual(['a']);
  });
});
