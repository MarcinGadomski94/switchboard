import type { KnownSettings } from '../../../core/settings.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { scanRows } from './model.ts';
import { Action, Row, SectionTitle } from './rows.tsx';

/** The workspace root row's description: `<root> · <router title>`. */
function rootText(settings: KnownSettings): string {
  const root = settings['workspace.root'];
  if (!root) return 'not configured';
  return `${root} · ${settings['workspace.router'] ?? 'no AGENTS.md'}`;
}

/**
 * Workspace & solutions (M8.2): the workspace root with the router file's title
 * and Rescan, then the scan table (folder, count, examples, rule) from
 * `GET /api/solutions` (the M6.1 scanner reads the router's folder rules on every
 * request, so Rescan just asks again).
 */
export function WorkspaceSection({ settings }: { readonly settings: KnownSettings }) {
  const solutions = useApi(api.solutions);
  const rows = solutions.data ? scanRows(solutions.data, settings['workspace.root']) : [];
  const errorCode = (solutions.error?.body as { error?: unknown } | null | undefined)?.error;
  let note: string | null = null;
  if (solutions.data && rows.length === 0) note = 'No solutions found.';
  else if (!solutions.data && solutions.error) {
    note = errorCode === 'no-folder' ? 'No folder is saved yet.' : 'The scan could not be loaded.';
  }
  return (
    <>
      <SectionTitle>Workspace &amp; solutions</SectionTitle>
      <Row id="workspace-root" label="Workspace root" mono description={rootText(settings)}>
        <Action testId="settings-rescan" onClick={solutions.reload}>
          Rescan
        </Action>
      </Row>
      {rows.length > 0 ? (
        <div className="sb-set-scan" data-testid="settings-scan">
          {rows.map((row) => (
            <div key={row.folder} className="sb-set-scan-row" data-folder={row.folder}>
              <span className="sb-set-scan-folder">{row.folder}</span>
              <span className="sb-set-scan-count">{row.count}</span>
              <span className="sb-set-scan-examples" title={row.examples}>
                {row.examples}
              </span>
              <span className="sb-set-scan-rule" data-rule={row.rule}>
                {row.ruleLabel}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {note ? (
        <div className="sb-set-note" data-testid="settings-note">
          {note}
        </div>
      ) : null}
    </>
  );
}
