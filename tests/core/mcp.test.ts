import { describe, expect, it } from 'vitest';
import {
  MASK,
  buildDefinition,
  commandText,
  definitionOf,
  describeConfig,
  maskArgs,
  maskUrl,
  McpKeepError,
  parseGetOutput,
  parseListOutput,
  parseServerInput,
  parseStatusResponse,
  scrubSecrets,
  secretValues,
  statusFromText,
} from '../../src/core/mcp.ts';

/**
 * D61: the pure MCP rules: masking, reading the CLI's `mcp get` / `mcp list` text
 * (fixtures derived from CLI 2.1.285's code: `✓ Connected`, `! Needs
 * authentication`, …), the `mcp_status` rows, validation and the add-json
 * definition with kept secrets.
 */

/** `claude mcp get` output as CLI 2.1.285 builds it (mcpGetHandler). */
const GET_HTTP = [
  'docs:',
  '  Scope: Local config (private to you in this project)',
  '  Status: ✗ Failed to connect',
  '  Issue: HTTP 500 from https://mcp.example.com/mcp',
  '  Type: http',
  '  URL: https://mcp.example.com/mcp',
  '  Headers:',
  '    Authorization: Bearer hdrSECRET',
  '',
  'To remove this server, run: claude mcp remove "docs" -s local',
].join('\n');

/** `claude mcp list` output (mcpListHandler: the health line, then `name: target - status[ — issue]`). */
const LIST = [
  'Checking MCP server health…',
  '',
  'acme: npx acme-mcp --token x - ✓ Connected',
  'docs: https://mcp.example.com/mcp (HTTP) - ! Needs authentication',
  'files: node server.js - ✗ Failed to connect — spawn node ENOENT',
  'shared: node s.js - ⏸ Pending approval (run `claude` to approve)',
  'old: node o.js - ⊘ Disabled for this project (re-enable via /mcp)',
  'plugin:acme:search: https://mcp.example.com/p (HTTP) - ! Connected · tools fetch failed — timeout',
  'unset: https://x.example.com (SSE) - - Not configured',
].join('\n');

describe('masking (D61)', () => {
  it('masks URL credentials and secret-looking query values', () => {
    expect(maskUrl('https://user:pa55word@mcp.example.com/mcp?access_token=abc&region=eu')).toBe(`https://user:${MASK}@mcp.example.com/mcp?access_token=${MASK}&region=eu`);
    expect(maskUrl('https://mcp.example.com/mcp?key=abc&api_key=def')).toBe(`https://mcp.example.com/mcp?key=${MASK}&api_key=${MASK}`);
    expect(maskUrl('https://mcp.example.com/mcp')).toBe('https://mcp.example.com/mcp');
  });

  it('masks secret flags, NAME=value pairs, bearer values and URLs in args', () => {
    expect(maskArgs(['server', '--token', 'abc', '--api-key=def', 'API_KEY=ghi', 'Bearer xyz', 'https://x.example.com/?token=t', '--port', '80'])).toEqual([
      'server',
      '--token',
      MASK,
      `--api-key=${MASK}`,
      `API_KEY=${MASK}`,
      `Bearer ${MASK}`,
      `https://x.example.com/?token=${MASK}`,
      '--port',
      '80',
    ]);
  });

  it('describes a config without values; collects the secrets; scrubs them from text', () => {
    const config = { type: 'http', url: 'https://mcp.example.com/?token=urlSECRET', headers: { Authorization: 'Bearer hdrSECRET' } };
    expect(describeConfig(config)).toEqual({ transport: 'http', command: null, args: [], url: `https://mcp.example.com/?token=${MASK}`, envNames: [], headerNames: ['Authorization'], canAuthenticate: true });
    expect(secretValues(config).sort()).toEqual(['Bearer hdrSECRET', 'urlSECRET']);
    expect(scrubSecrets('failed: Bearer hdrSECRET at urlSECRET', secretValues(config))).toBe(`failed: ${MASK} at ${MASK}`);
    expect(scrubSecrets('Authorization: Bearer unknownVALUE', [])).toBe(`Authorization: Bearer ${MASK}`);
  });

  it('writes a command as typed, secrets masked', () => {
    expect(commandText(['mcp', 'add-json', 'x', '{"env":{"K":"s3cret"}}', '--scope', 'user'], ['s3cret'])).toBe(`claude mcp add-json x '{"env":{"K":"${MASK}"}}' --scope user`);
  });
});

describe('reading the CLI (D61)', () => {
  it('reads `mcp get`: status and issue only', () => {
    expect(parseGetOutput(GET_HTTP)).toEqual({ status: 'failed', error: 'HTTP 500 from https://mcp.example.com/mcp' });
    expect(parseGetOutput('x:\n  Status: ✓ Connected\n')).toEqual({ status: 'connected', error: null });
    expect(parseGetOutput('No MCP server found')).toBeNull();
  });

  it('reads what CLI 2.1.285 printed in a real run on macOS (✔ / ✘ marks; paths shortened)', () => {
    const failed = [
      'b1:',
      '  Scope: Local config (private to you in this project)',
      '  Status: ✘ Failed to connect',
      "  Issue: ENOENT: ENOENT: no such file or directory, posix_spawn '/nonexistent/probe-bin'",
      '  Type: stdio',
      '  Command: /nonexistent/probe-bin',
      '  Args: ',
      '',
      'To remove this server, run: claude mcp remove b1 -s local',
      '',
    ].join('\n');
    expect(parseGetOutput(failed)).toEqual({ status: 'failed', error: "ENOENT: ENOENT: no such file or directory, posix_spawn '/nonexistent/probe-bin'" });
    const connected = 'e1:\n  Scope: Local config (private to you in this project)\n  Status: ✔ Connected\n  Type: stdio\n  Command: /bin/node\n  Args: /x/echo.mjs\n  Environment:\n    TOKEN=value\n';
    expect(parseGetOutput(connected)).toEqual({ status: 'connected', error: null });
    expect(parseGetOutput('e1:\n  Status: ⊘ Disabled for this project (re-enable via /mcp)\n')).toEqual({ status: 'disabled', error: null });
    expect(parseGetOutput('p1:\n  Scope: Project config (shared via .mcp.json)\n  Status: ⏸ Pending approval (run `claude` to approve)\n')).toEqual({ status: 'pending-approval', error: null });
    const list = [
      'Checking MCP server health…',
      '',
      'u1: /bin/node /x/echo.mjs - ✔ Connected',
      'p1: /bin/node /x/echo.mjs - ⏸ Pending approval (run `claude` to approve)',
      "b1: /nonexistent/probe-bin  - ✘ Failed to connect — ENOENT: ENOENT: no such file or directory, posix_spawn '/nonexistent/probe-bin'",
      '',
    ].join('\n');
    expect(parseListOutput(list)).toEqual([
      { name: 'u1', status: 'connected', error: null },
      { name: 'p1', status: 'pending-approval', error: null },
      { name: 'b1', status: 'failed', error: "ENOENT: ENOENT: no such file or directory, posix_spawn '/nonexistent/probe-bin'" },
    ]);
  });

  it('maps every status text the CLI prints', () => {
    expect(statusFromText('! Needs authentication').status).toBe('needs-auth');
    expect(statusFromText('⏸ Pending approval (run `claude` to approve)').status).toBe('pending-approval');
    expect(statusFromText('✗ Rejected (see disabledMcpjsonServers in settings)').status).toBe('rejected');
    expect(statusFromText('⊘ Disabled for this project (re-enable via /mcp)').status).toBe('disabled');
    expect(statusFromText('✗ Connection error')).toEqual({ status: 'failed', error: 'Connection error' });
    expect(statusFromText('- Not configured')).toEqual({ status: 'failed', error: 'Not configured' });
  });

  it('reads `mcp list` rows (names with colons, issues after —)', () => {
    expect(parseListOutput(LIST)).toEqual([
      { name: 'acme', status: 'connected', error: null },
      { name: 'docs', status: 'needs-auth', error: null },
      { name: 'files', status: 'failed', error: 'spawn node ENOENT' },
      { name: 'shared', status: 'pending-approval', error: null },
      { name: 'old', status: 'disabled', error: null },
      { name: 'plugin:acme:search', status: 'failed', error: 'timeout' },
      { name: 'unset', status: 'failed', error: 'Not configured' },
    ]);
  });

  it('reads `mcp_status` rows: tools counted, APPROVAL_REQUIRED, unknown statuses failed', () => {
    const rows = parseStatusResponse({
      mcpServers: [
        { name: 'a', status: 'connected', scope: 'user', source: 'user', tools: [{ name: 't1' }, { name: 't2' }], config: { command: 'x' } },
        { name: 'b', status: 'failed', error_code: 'APPROVAL_REQUIRED', scope: 'project' },
        { name: 'c', status: 'failed', error: 'boom' },
        { name: 'd', status: 'weird' },
        { status: 'connected' },
      ],
    });
    expect(rows.map((r) => [r.name, r.status, r.error, r.tools])).toEqual([
      ['a', 'connected', null, 2],
      ['b', 'pending-approval', null, null],
      ['c', 'failed', 'boom', null],
      ['d', 'failed', 'Failed to connect', null],
    ]);
    expect(parseStatusResponse(null)).toEqual([]);
  });
});

describe('the form (D61)', () => {
  it('validates like the CLI', () => {
    const bad = parseServerInput({ name: 'a b', scope: 'global', transport: 'tcp' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.field)).toEqual(['name', 'scope', 'transport']);
    expect(parseServerInput({ name: '-x', scope: 'user', transport: 'stdio', command: 'c' }).ok).toBe(false);
    const noUrl = parseServerInput({ name: 'x', scope: 'user', transport: 'http', url: 'ftp://x' });
    expect(noUrl.ok ? [] : noUrl.errors.map((e) => e.message)).toEqual(['A http server needs a http or https URL.']);
    const ws = parseServerInput({ name: 'x', scope: 'user', transport: 'ws', url: 'wss://x.example.com' });
    expect(ws.ok).toBe(true);
    const env = parseServerInput({ name: 'x', scope: 'local', transport: 'stdio', command: 'c', env: [{ name: '1BAD', value: 'v' }, { name: 'OK', value: 'a\nb' }] });
    expect(env.ok ? [] : env.errors.map((e) => e.field)).toEqual(['env.0', 'env.1']);
    const header = parseServerInput({ name: 'x', scope: 'local', transport: 'sse', url: 'https://x.example.com', headers: [{ name: 'X Bad', value: 'v' }] });
    expect(header.ok ? [] : header.errors.map((e) => e.field)).toEqual(['headers.0']);
    expect(parseServerInput({ name: 'ok_1-2', scope: 'project', transport: 'stdio', command: 'npx', args: ['a', ''] })).toEqual({
      ok: true,
      input: { name: 'ok_1-2', scope: 'project', transport: 'stdio', command: 'npx', args: ['a'] },
    });
  });

  it('builds the add-json definition; an edit keeps masked args, the masked URL and kept env / headers, and the extra keys', () => {
    expect(buildDefinition({ name: 'x', scope: 'user', transport: 'stdio', command: 'npx', args: ['a'], env: [{ name: 'K', value: 'v' }] }, null)).toEqual({ type: 'stdio', command: 'npx', args: ['a'], env: { K: 'v' } });
    const original = { type: 'stdio', command: 'npx', args: ['srv', '--token', 'T0KEN'], env: { K: 'SECRETV' }, timeout: 5000 };
    expect(buildDefinition({ name: 'x', scope: 'user', transport: 'stdio', command: 'npx', args: ['srv', '--token', MASK, '-v'], env: [{ name: 'K', keep: true }] }, original)).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['srv', '--token', 'T0KEN', '-v'],
      env: { K: 'SECRETV' },
      timeout: 5000,
    });
    const http = { type: 'http', url: 'https://x.example.com/?token=UT', headers: { Authorization: 'Bearer H' }, oauth: { clientId: 'c' } };
    expect(buildDefinition({ name: 'x', scope: 'user', transport: 'http', url: `https://x.example.com/?token=${MASK}`, headers: [{ name: 'Authorization', keep: true }] }, http)).toEqual(http);
    expect(() => buildDefinition({ name: 'x', scope: 'user', transport: 'stdio', command: 'c', env: [{ name: 'NEW', keep: true }] }, original)).toThrow(McpKeepError);
    expect(() => buildDefinition({ name: 'x', scope: 'user', transport: 'http', url: `https://other.example.com/?token=${MASK}` }, http)).toThrow(McpKeepError);
  });

  it('starts the Edit form without secret values', () => {
    expect(definitionOf('x', 'local', { type: 'sse', url: 'https://x.example.com/?key=K', headers: { 'X-Api-Key': 'V', Empty: '' } })).toEqual({
      name: 'x',
      scope: 'local',
      transport: 'sse',
      command: null,
      args: [],
      url: `https://x.example.com/?key=${MASK}`,
      env: [],
      headers: [
        { name: 'X-Api-Key', set: true },
        { name: 'Empty', set: false },
      ],
    });
  });
});
