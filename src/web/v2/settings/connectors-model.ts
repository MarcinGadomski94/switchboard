import type { ClaudeAiConnectorSeen, McpSignInSettings } from '../../../core/mcp-sign-in.ts';

/** D184: one computer's last status of a connector. */
export interface ConnectorReport {
  /** The computer's name (`null` when the server did not say: a computer before D184 shows its own only). */
  readonly computer: string | null;
  readonly status: 'needs-auth' | 'connected' | 'other';
  readonly statusText: string;
}

/** D183: one row of Settings' "claude.ai connectors" card. */
export interface ConnectorRow {
  readonly name: string;
  /** The worst status on any computer (`needs-auth` first), for the row's mark. */
  readonly status: 'needs-auth' | 'connected' | 'other';
  /** D184: "needs a sign-in on PC · connected on MacBook" (one computer: just its status). */
  readonly statusText: string;
  /** D184: each computer that reported it, this one first. */
  readonly reports: readonly ConnectorReport[];
  /** "Ask me to sign in" is on (the server is not muted; D184: on every computer that syncs). */
  readonly ask: boolean;
}

function statusOf(raw: string): ConnectorReport['status'] {
  return raw === 'needs-auth' ? 'needs-auth' : raw === 'connected' ? 'connected' : 'other';
}

function statusWords(status: ConnectorReport['status'], raw: string): string {
  return status === 'needs-auth' ? 'needs a sign-in' : status === 'connected' ? 'connected' : raw;
}

/**
 * D183: the card's rows: every claude.ai connector reported (by name), then the other muted
 * servers, each with whether Switchboard asks for its sign-in. D184: the connectors of this
 * computer and of every paired computer, each once, with where it was reported and how; and the
 * paired computers that do not sync the mutes (older than 2.5.8).
 */
export function connectorRows(view: McpSignInSettings | null): { readonly connectors: ConnectorRow[]; readonly otherMuted: string[]; readonly unsynced: string[] } {
  if (!view) return { connectors: [], otherMuted: [], unsynced: [] };
  const muted = new Set(view.muted);
  const sources: Array<{ readonly computer: string | null; readonly connectors: readonly ClaudeAiConnectorSeen[] }> = [
    { computer: view.computers && view.computers.length > 0 ? (view.self ?? null) : null, connectors: view.connectors },
    ...(view.computers ?? []).filter((computer) => computer.synced).map((computer) => ({ computer: computer.name, connectors: computer.connectors })),
  ];
  const byName = new Map<string, ConnectorReport[]>();
  for (const source of sources) {
    for (const connector of source.connectors) {
      const status = statusOf(connector.status);
      const reports = byName.get(connector.name) ?? [];
      reports.push({ computer: source.computer, status, statusText: statusWords(status, connector.status) });
      byName.set(connector.name, reports);
    }
  }
  const connectors = [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, reports]): ConnectorRow => {
      const status = reports.some((report) => report.status === 'needs-auth') ? 'needs-auth' : reports.every((report) => report.status === 'connected') ? 'connected' : 'other';
      const statusText = reports.map((report) => (report.computer ? `${report.statusText} on ${report.computer}` : report.statusText)).join(' · ');
      return { name, status, statusText, reports, ask: !muted.has(name) };
    });
  const known = new Set(connectors.map((row) => row.name));
  return {
    connectors,
    otherMuted: [...muted].filter((name) => !known.has(name)).sort((a, b) => a.localeCompare(b)),
    unsynced: (view.computers ?? []).filter((computer) => !computer.synced).map((computer) => computer.name).sort((a, b) => a.localeCompare(b)),
  };
}
