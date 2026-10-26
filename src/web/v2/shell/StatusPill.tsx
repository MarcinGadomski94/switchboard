import { useState } from 'react';
import { api } from '../../api/client.ts';
import { rememberMachine } from '../../api/useMachines.ts';
import { Button, Chip, Icon, Popover } from '../components/index.ts';
import { useV2Router } from '../nav.tsx';
import { type Tone, USAGE_WORDS } from '../glossary.ts';
import { pillUsageHref } from '../insights/usage-model.ts';
import type { StatusPill as Pill, PillComputer } from './status-model.ts';

function Meter({ label, pct, tone }: { readonly label: string; readonly pct: number | null; readonly tone: Tone }) {
  return (
    <div className="v2-bar2">
      <span className="v2-bar2-l">{label}</span>
      <span className="v2-meter" data-tone={tone} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <b style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
      </span>
      <span>{pct === null ? '—' : `${Math.round(pct)}%`}</span>
    </div>
  );
}

function ComputerRow({ row }: { readonly row: PillComputer }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="v2-prow" data-state={row.state} data-testid="v2-pill-computer">
      <Icon name={row.state === 'offline' ? 'offline' : row.state === 'reconnecting' ? 'refresh' : row.self ? 'laptop' : 'desktop'} />
      <div className="v2-grow">
        <b>{row.name}</b>
        {row.self ? <span className="v2-muted"> · this one</span> : null}
        <div className="v2-muted" style={{ fontSize: 12.5 }}>
          {row.detail}
        </div>
      </div>
      {row.power ? (
        <span className="v2-row" style={{ fontSize: 13, gap: 4 }}>
          <Icon name={row.powerKind === 'plug' ? 'bolt' : 'battery'} size="s" />
          {row.power}
        </span>
      ) : null}
      {!row.self && row.state !== 'online' && row.id ? (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api
              .reconnectMachine(row.id as string)
              .then((result) => rememberMachine(result.machine))
              .catch(() => undefined)
              .finally(() => setBusy(false));
          }}
        >
          Reconnect now
        </Button>
      ) : null}
    </div>
  );
}

/**
 * D131 · the status pill (the prototype's `.pill` + `.pop`): the active account's
 * usage, this computer's power and the computers online / offline / reconnecting;
 * a click opens the details (every account, paid extra usage, each computer with
 * its power and background apps).
 */
export function StatusPill({ pill, compact = false }: { readonly pill: Pill; readonly compact?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const { navigate } = useV2Router();
  const go = (path: string): void => {
    setOpen(false);
    navigate(path);
  };
  const usage = pill.usage;
  return (
    <>
      <button ref={setAnchor} type="button" className="v2-pill" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="v2-status-pill" aria-label={`Usage and computers: ${[usage?.label, pill.power?.text, pill.computers.text].filter(Boolean).join(', ')}`}>
        {usage ? (
          <>
            <span className="v2-pill-ic" data-tone={usage.tone}>
              <Icon name={usage.icon} size="s" />
            </span>
            <span data-testid="v2-pill-usage">{usage.label}</span>
            {usage.pct !== null && !compact ? (
              <span className="v2-mini-bar" aria-hidden="true">
                <i style={{ width: `${Math.min(100, usage.pct)}%` }} />
              </span>
            ) : null}
          </>
        ) : (
          <span>Usage —</span>
        )}
        {pill.power && !compact ? (
          <>
            <span className="v2-sep" aria-hidden="true" />
            <Icon name={pill.power.kind === 'plug' ? 'bolt' : 'battery'} size="s" />
            <span data-testid="v2-pill-power">{pill.power.text}</span>
          </>
        ) : null}
        {!compact ? (
          <>
            <span className="v2-sep" aria-hidden="true" />
            <span className="v2-row" style={{ gap: 6 }} data-tone={pill.computers.tone} data-testid="v2-pill-computers">
              <Icon name={pill.computers.icon} size="s" />
              {pill.computers.text}
            </span>
          </>
        ) : null}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label="Usage and computers" testId="v2-status-pop">
        <h4>Usage</h4>
        {pill.accounts.length === 0 ? <p className="v2-muted">No usage reading yet.</p> : null}
        {pill.accounts.map((account) => (
          <div key={account.key} className="v2-acct" data-testid="v2-pill-account">
            <div className="v2-row">
              <b>{account.name}</b>
              {account.badge ? (
                <Chip tone={account.badge.tone} icon={account.badge.icon} size="s" className="v2-acct-badge">
                  {account.badge.text}
                </Chip>
              ) : null}
            </div>
            {account.note ? <div className="v2-bar2">{account.note}</div> : null}
            {!account.note || account.badge?.text === 'Paid extra' ? (
              <>
                <Meter label="5 hours" pct={account.session} tone={account.sessionTone} />
                <Meter label="Week" pct={account.week} tone={account.weekTone} />
              </>
            ) : null}
            {/* D134: where this account's current 5-hour window went (Insights → Usage, filtered to it). */}
            <button type="button" className="v2-acct-usage" onClick={() => go(pillUsageHref(account.key))} data-testid="v2-pill-see-usage">
              {USAGE_WORDS.seeWhat} →
            </button>
          </div>
        ))}
        <p className="v2-muted" style={{ fontSize: 13, margin: '6px 0 14px' }}>
          Switches accounts automatically at the limit.
          {pill.backgroundApps ? ` ${pill.backgroundApps}.` : ''}
        </p>
        <h4>Computers</h4>
        {pill.computerRows.map((row) => (
          <ComputerRow key={row.id ?? 'self'} row={row} />
        ))}
        <div className="v2-row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <Button size="sm" onClick={() => go('/settings/usage')}>
            Usage settings
          </Button>
          <Button size="sm" onClick={() => go('/settings/computers')}>
            Computers
          </Button>
          <Button size="sm" variant="ghost" icon="insights" onClick={() => go('/insights')}>
            Insights
          </Button>
        </div>
      </Popover>
    </>
  );
}
