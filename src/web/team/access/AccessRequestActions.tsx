import { useState } from 'react';
import type { TeamNeedsYouItem } from '../../../core/team.ts';
import { onDeviceOrigin } from '../../api/client.ts';
import { accessApi } from './api.ts';
import './access.css';

/**
 * D100-T2 · the body and actions of an **access** Needs-you card (`item.kind ===
 * 'access'`), for T3's Needs-you list: the exact service and host (always shown),
 * the scope, what it gives, why, the catalog-host warning, and **Set up…** (opens
 * the member's Access tab at this access: `onSetUp`), **Deny** and **Not now**.
 * Nothing is approved without the developer typing the values in the Access tab.
 * On a paired phone, Set up… is replaced by "Set this up on a computer".
 */
export interface AccessRequestActionsProps {
  /** A `GET /api/team/needs-you` item with `kind: 'access'` (its `access` and `request`). */
  readonly item: TeamNeedsYouItem;
  /** "Set up…": open the member's Access tab with this access's form (`AccessTab`'s `focusAccessId`). */
  readonly onSetUp: (memberId: string, accessId: string) => void;
  /** After Deny / Not now. */
  readonly onDecided?: () => void;
}

/** The card's access part. */
export function AccessRequestActions({ item, onSetUp, onDecided }: AccessRequestActionsProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const access = item.access;
  const request = item.request;
  if (!access || !request) return null;
  const device = onDeviceOrigin();
  const decide = async (decision: 'decline' | 'dismiss'): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await accessApi.decide(request.id, decision);
      onDecided?.();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sb-access-request" data-testid={`access-request-${access.id}`}>
      <div className="sb-access-facts">
        <span className="sb-access-service">{access.service}</span>
        <span>
          Host <code data-testid="access-request-host">{access.host}</code>
        </span>
        <span>{access.kind === 'mcp' ? 'MCP server' : `API key (${access.fields.map((f) => f.name).join(', ')})`}</span>
        <span>Scope: {access.scope}</span>
      </div>
      {access.warning ? (
        <div className="sb-access-warning" data-testid="access-request-warning">
          {access.warning}
        </div>
      ) : null}
      <div className="sb-access-why">Why: {access.why}</div>
      {problem ? <div className="sb-access-error">{problem}</div> : null}
      <div className="sb-access-actions">
        {device ? (
          <span className="sb-access-device" data-testid="access-request-device">
            Set this up on a computer.
          </span>
        ) : (
          <button type="button" className="sb-button sb-access-primary" data-testid="access-request-setup" disabled={busy} onClick={() => onSetUp(item.memberId, access.id)}>
            Set up…
          </button>
        )}
        <button type="button" className="sb-button sb-access-danger" data-testid="access-request-deny" disabled={busy} onClick={() => void decide('decline')}>
          Deny
        </button>
        <button type="button" className="sb-button sb-access-secondary" data-testid="access-request-later" disabled={busy} onClick={() => void decide('dismiss')}>
          Not now
        </button>
      </div>
    </div>
  );
}
