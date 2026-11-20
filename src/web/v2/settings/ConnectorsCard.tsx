import { CLAUDE_AI_CONNECTORS_URL } from '../../../core/mcp-sign-in.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { Button, Card, Switch, useToast } from '../components/index.ts';
import { MCP_SIGN_IN_WORDS as W } from '../glossary.ts';
import { connectorRows } from './connectors-model.ts';

/**
 * D183 (`docs/mcp.md` → *Don't ask again*): Settings › Advanced › Connections' card for the
 * claude.ai connectors (loaded by every agent from the claude.ai account, managed on
 * claude.ai, so not in the MCP list below) and the servers whose sign-in Switchboard does not
 * ask for: each with "Ask me to sign in" (off = muted). D184: the connectors of every paired
 * computer too ("needs a sign-in on PC · connected on MacBook"), and the switch mutes on all of
 * them; a computer older than 2.5.8 is named as not synced.
 */
export function ConnectorsCard() {
  const toast = useToast();
  const view = useApi(() => api.mcpSignInSettings(), []);
  const { connectors, otherMuted, unsynced } = connectorRows(view.data);
  const set = (name: string, ask: boolean): void => {
    api.setMcpSignInMuted(name, !ask).then(
      () => view.reload(),
      (error: unknown) => toast({ text: error instanceof Error ? error.message : 'It could not be changed.', tone: 'error' }),
    );
  };
  return (
    <Card pad className="v2-set-card" data-testid="v2-mcp-connectors" data-tour="v2-mcp-connectors">
      <div className="v2-set-card-h">
        <h3 className="v2-grow">{W.connectorsTitle}</h3>
        <Button size="sm" icon="external" onClick={() => window.open(CLAUDE_AI_CONNECTORS_URL, '_blank', 'noopener')} data-testid="v2-mcp-connectors-open">
          {W.openConnectors}
        </Button>
      </div>
      <p className="v2-muted v2-set-small">{W.connectorsSub}</p>
      {/* D184: a paired computer older than 2.5.8 keeps its own mutes. */}
      {unsynced.length > 0 ? (
        <p className="v2-muted v2-set-small" data-testid="v2-mcp-unsynced">
          {W.notSynced(unsynced)}
        </p>
      ) : null}
      {view.data && connectors.length === 0 ? <p className="v2-muted v2-set-small">{W.noConnectors}</p> : null}
      {connectors.map((row) => (
        <div className="v2-set-row" key={row.name} data-testid="v2-mcp-connector" data-name={row.name} data-status={row.status}>
          <span className="v2-grow">
            <b>{row.name}</b> <span className="v2-muted">· {W.managedOn} · {row.statusText}</span>
          </span>
          <Switch checked={row.ask} label={W.askMe(row.name)} onChange={(next) => set(row.name, next)} testId="v2-mcp-connector-ask" />
        </div>
      ))}
      {otherMuted.length > 0 ? (
        <>
          <p className="v2-muted v2-set-small">{W.mutedOther}</p>
          {otherMuted.map((name) => (
            <div className="v2-set-row" key={name} data-testid="v2-mcp-muted" data-name={name}>
              <span className="v2-grow">
                <b>{name}</b>
              </span>
              <Switch checked={false} label={W.askMe(name)} onChange={(next) => set(name, next)} testId="v2-mcp-muted-ask" />
            </div>
          ))}
        </>
      ) : null}
    </Card>
  );
}
