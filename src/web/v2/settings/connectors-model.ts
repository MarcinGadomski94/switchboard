import type { McpSignInSettings } from '../../../core/mcp-sign-in.ts';

/** D183: one row of Settings' "claude.ai connectors" card. */
export interface ConnectorRow {
  readonly name: string;
  /** The CLI's last status in words (`needs a sign-in`, `connected`, or as reported). */
  readonly status: 'needs-auth' | 'connected' | 'other';
  readonly statusText: string;
  /** "Ask me to sign in" is on (the server is not muted). */
  readonly ask: boolean;
}

/**
 * D183: the card's rows: every claude.ai connector this computer's agents reported (by
 * name), then the other muted servers (local ones muted from an agent's notice), each
 * with whether Switchboard asks for its sign-in.
 */
export function connectorRows(view: McpSignInSettings | null): { readonly connectors: ConnectorRow[]; readonly otherMuted: string[] } {
  if (!view) return { connectors: [], otherMuted: [] };
  const muted = new Set(view.muted);
  const connectors = [...view.connectors]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((connector): ConnectorRow => {
      const status = connector.status === 'needs-auth' ? 'needs-auth' : connector.status === 'connected' ? 'connected' : 'other';
      return { name: connector.name, status, statusText: status === 'needs-auth' ? 'needs a sign-in' : status === 'connected' ? 'connected' : connector.status, ask: !muted.has(connector.name) };
    });
  const known = new Set(connectors.map((row) => row.name));
  return { connectors, otherMuted: [...muted].filter((name) => !known.has(name)).sort((a, b) => a.localeCompare(b)) };
}
