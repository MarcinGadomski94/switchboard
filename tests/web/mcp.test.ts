import { describe, expect, it } from 'vitest';
import type { Folder } from '../../src/core/api.ts';
import type { McpServerView } from '../../src/core/mcp.ts';
import { emptyForm, folderChoices, formErrors, formFromDefinition, formToInput, groupByScope, parseChoice, scopeTitle, statusLabel, targetText } from '../../src/web/views/mcp.ts';

/** D61: the MCP page's pure parts (the `/mcp` route is covered by tests/e2e/shell.spec.ts): status labels, groups, folder choices and the form ↔ input with kept secrets. */

function folder(id: string, name: string, isDefault = false): Folder {
  return { id, path: `/work/${name}`, canonicalPath: `/work/${name}`, name, label: null, displayName: name, kind: 'repo', isDefault, addedAt: '', lastUsedAt: null } as unknown as Folder;
}

function server(name: string, scope: string, patch: Partial<McpServerView> = {}): McpServerView {
  return { name, scope, editable: true, transport: 'stdio', command: 'npx', args: ['srv'], url: null, envNames: [], headerNames: [], status: 'unchecked', error: null, tools: null, checkedAt: null, canAuthenticate: false, approval: null, ...patch };
}

describe('MCP page (D61)', () => {
  it('labels statuses and scopes; groups rows by scope in order', () => {
    expect(statusLabel('needs-auth')).toEqual({ text: 'needs authentication', kind: 'warn' });
    expect(statusLabel('unchecked').kind).toBe('none');
    expect(scopeTitle('project').title).toBe('Project');
    expect(scopeTitle('managed')).toEqual({ title: 'managed', note: 'read-only' });
    const groups = groupByScope([server('a', 'local'), server('b', 'local'), server('c', 'user'), server('p', 'plugin')]);
    expect(groups.map((g) => [g.scope, g.servers.map((s) => s.name)])).toEqual([
      ['local', ['a', 'b']],
      ['user', ['c']],
      ['plugin', ['p']],
    ]);
    expect(targetText(server('x', 'user', { url: 'https://mcp.example.com', command: null, args: [] }))).toBe('https://mcp.example.com');
    expect(targetText(server('x', 'user'))).toBe('npx srv');
  });

  it('lists the default folder first, then a paired machine’s folders', () => {
    const choices = folderChoices([folder('f1', 'alpha'), folder('f2', 'beta', true)], [{ machine: { id: 'pc', name: 'PC' }, folders: [folder('r1', 'gamma')] }]);
    expect(choices.map((c) => [c.value, c.label])).toEqual([
      ['|f2', 'beta'],
      ['|f1', 'alpha'],
      ['pc|r1', 'PC · gamma'],
    ]);
    expect(parseChoice('pc|r1')).toEqual({ machine: 'pc', folderId: 'r1' });
    expect(parseChoice('|f2')).toEqual({ machine: null, folderId: 'f2' });
  });

  it('turns the form into McpServerInput: kept secrets stay placeholders, typed ones replace them', () => {
    const form = formFromDefinition({ name: 'acme', scope: 'user', transport: 'stdio', command: 'npx', args: ['acme', '--token', '••••'], url: null, env: [{ name: 'API_KEY', set: true }], headers: [] });
    expect(form.args).toBe('acme\n--token\n••••');
    expect(formToInput(form)).toEqual({ name: 'acme', scope: 'user', transport: 'stdio', command: 'npx', args: ['acme', '--token', '••••'], env: [{ name: 'API_KEY', keep: true }] });
    const typed = { ...form, env: [{ name: 'API_KEY', value: 'new', keep: true }, { name: '', value: '', keep: false }] };
    expect(formToInput(typed).env).toEqual([{ name: 'API_KEY', value: 'new' }]);
    const http = { ...emptyForm(), name: 'docs', transport: 'http' as const, url: ' https://mcp.example.com/mcp ', headers: [{ name: 'Authorization', value: 'Bearer x', keep: false }] };
    expect(formToInput(http)).toEqual({ name: 'docs', scope: 'local', transport: 'http', url: 'https://mcp.example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer x' }] });
  });

  it('checks the form with the CLI’s rules before sending it', () => {
    expect(formErrors({ ...emptyForm(), name: 'bad name' }).map((e) => e.field)).toEqual(['name', 'command']);
    expect(formErrors({ ...emptyForm(), name: 'ok', command: 'npx' })).toEqual([]);
  });
});
