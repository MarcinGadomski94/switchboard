import type { Folder } from '../../core/api.ts';
import { MASK, type McpEditableScope, type McpServerDefinition, type McpServerInput, type McpServerView, type McpStatus, type McpTransport, parseServerInput, type McpFieldError } from '../../core/mcp.ts';
import type { Machine } from '../../core/peers.ts';

/**
 * D61: the MCP servers page's pure parts (`McpView.tsx`): status labels, the scope
 * groups, the folder selector's options (this machine's folders, then a paired
 * machine's), and the Add / Edit form's state ↔ `McpServerInput` with the
 * "unchanged" secret placeholders (`docs/mcp.md` → *Secrets*).
 */

/** How a status reads and its dot's kind (`mcp.css`). */
export function statusLabel(status: McpStatus): { readonly text: string; readonly kind: 'ok' | 'warn' | 'fail' | 'off' | 'none' } {
  switch (status) {
    case 'connected':
      return { text: 'connected', kind: 'ok' };
    case 'failed':
      return { text: 'failed', kind: 'fail' };
    case 'needs-auth':
      return { text: 'needs authentication', kind: 'warn' };
    case 'pending':
      return { text: 'still connecting', kind: 'warn' };
    case 'pending-approval':
      return { text: 'pending approval', kind: 'warn' };
    case 'rejected':
      return { text: 'rejected', kind: 'off' };
    case 'disabled':
      return { text: 'disabled', kind: 'off' };
    default:
      return { text: 'not checked', kind: 'none' };
  }
}

/** The scope groups' titles and notes, in page order. */
export const SCOPE_TITLES: Readonly<Record<string, { readonly title: string; readonly note: string }>> = {
  local: { title: 'Local', note: 'private to you in this folder (~/.claude.json)' },
  project: { title: 'Project', note: 'shared: .mcp.json in the folder (may be committed)' },
  user: { title: 'User', note: 'all your folders (~/.claude.json)' },
  plugin: { title: 'Plugins', note: 'from installed plugins (read-only)' },
  claudeai: { title: 'claude.ai connectors', note: 'managed on claude.ai (read-only)' },
};

/** A scope's group title and note (unknown scopes read as their name, read-only). */
export function scopeTitle(scope: string): { readonly title: string; readonly note: string } {
  return SCOPE_TITLES[scope] ?? { title: scope, note: 'read-only' };
}

/** The servers grouped by scope, in the order the service sent them. */
export function groupByScope(servers: readonly McpServerView[]): Array<{ readonly scope: string; readonly servers: McpServerView[] }> {
  const groups: Array<{ scope: string; servers: McpServerView[] }> = [];
  for (const server of servers) {
    const last = groups[groups.length - 1];
    if (last && last.scope === server.scope) last.servers.push(server);
    else groups.push({ scope: server.scope, servers: [server] });
  }
  return groups;
}

/** What a row shows as its target: `command args…` or the (masked) URL. */
export function targetText(server: Pick<McpServerView, 'command' | 'args' | 'url'>): string {
  if (server.url) return server.url;
  return [server.command ?? '', ...server.args].join(' ').trim();
}

/** One entry of the folder selector: `value` = `<machine or "">|<folder id>`. */
export interface FolderChoice {
  readonly value: string;
  readonly machine: string | null;
  readonly folderId: string;
  readonly label: string;
  readonly path: string;
}

/** The selector's value for a folder. */
export function choiceValue(machine: string | null, folderId: string): string {
  return `${machine ?? ''}|${folderId}`;
}

/** Reads a selector value back. */
export function parseChoice(value: string): { readonly machine: string | null; readonly folderId: string } {
  const bar = value.indexOf('|');
  const machine = bar > 0 ? value.slice(0, bar) : null;
  return { machine, folderId: value.slice(bar + 1) };
}

/**
 * The selector's options: this machine's folders (the default one first, as
 * `GET /api/folders` sends them), then each online paired machine's, labelled
 * `<machine> · <folder>`.
 */
export function folderChoices(local: readonly Folder[], peers: ReadonlyArray<{ readonly machine: Pick<Machine, 'id' | 'name'>; readonly folders: readonly Folder[] }> = []): FolderChoice[] {
  const ordered = [...local.filter((f) => f.isDefault), ...local.filter((f) => !f.isDefault)];
  const out: FolderChoice[] = ordered.map((f) => ({ value: choiceValue(null, f.id), machine: null, folderId: f.id, label: f.displayName, path: f.path }));
  for (const { machine, folders } of peers) {
    for (const f of folders) out.push({ value: choiceValue(machine.id, f.id), machine: machine.id, folderId: f.id, label: `${machine.name} · ${f.displayName}`, path: f.path });
  }
  return out;
}

// ---------------------------------------------------------------- the form

/** An env / header row on the form: `keep` = the stored value stays (shown as the placeholder). */
export interface SecretRow {
  readonly name: string;
  readonly value: string;
  readonly keep: boolean;
}

/** The Add / Edit form's state. */
export interface McpFormState {
  readonly name: string;
  readonly scope: McpEditableScope;
  readonly transport: McpTransport;
  readonly command: string;
  /** One argument per line. */
  readonly args: string;
  readonly url: string;
  readonly env: readonly SecretRow[];
  readonly headers: readonly SecretRow[];
}

/** An empty Add form (local scope, stdio: the CLI's defaults). */
export function emptyForm(): McpFormState {
  return { name: '', scope: 'local', transport: 'stdio', command: '', args: '', url: '', env: [], headers: [] };
}

/** The Edit form for a definition: secrets as kept placeholders. */
export function formFromDefinition(definition: McpServerDefinition): McpFormState {
  return {
    name: definition.name,
    scope: definition.scope,
    transport: definition.transport,
    command: definition.command ?? '',
    args: definition.args.join('\n'),
    url: definition.url ?? '',
    env: definition.env.map((e) => ({ name: e.name, value: '', keep: e.set })),
    headers: definition.headers.map((h) => ({ name: h.name, value: '', keep: h.set })),
  };
}

/** The placeholder a kept secret shows. */
export const KEPT_PLACEHOLDER = `${MASK} unchanged`;

/** The form as the API's `McpServerInput` (kept rows as `keep: true`, blank rows left out). */
export function formToInput(form: McpFormState): McpServerInput {
  const rows = (list: readonly SecretRow[]) =>
    list.filter((r) => r.name.trim() !== '').map((r) => (r.keep && r.value === '' ? { name: r.name.trim(), keep: true } : { name: r.name.trim(), value: r.value }));
  const base = { name: form.name.trim(), scope: form.scope, transport: form.transport };
  if (form.transport === 'stdio') {
    const env = rows(form.env);
    return { ...base, command: form.command.trim(), args: form.args.split('\n').map((a) => a.trim()).filter((a) => a !== ''), ...(env.length > 0 ? { env } : {}) };
  }
  const headers = rows(form.headers);
  return { ...base, url: form.url.trim(), ...(headers.length > 0 ? { headers } : {}) };
}

/** The form's field errors, by the CLI's rules (the same checks the service runs). */
export function formErrors(form: McpFormState): readonly McpFieldError[] {
  const parsed = parseServerInput(formToInput(form));
  return parsed.ok ? [] : parsed.errors;
}

/** The API's error body as one line (the CLI's words for `cli-failed`). */
export function errorMessage(body: unknown, fallback: string): string {
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message !== '' ? message : fallback;
}
