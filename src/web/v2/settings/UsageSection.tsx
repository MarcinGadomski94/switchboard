import { type DragEvent, useEffect, useMemo, useState } from 'react';
import type { AccountProfile } from '../../../core/accounts.ts';
import type { AccountsOverview } from '../../../core/api.ts';
import { CLI_LABELS, CLI_PROVIDERS, type CliProviderId } from '../../../core/cli-providers.ts';
import { ApiError, accountsApi, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { droppedOrder, movedOrder } from '../../views/settings/accounts.ts';
import { warnAtOptions } from '../../views/settings/model.ts';
import { SignInPanel } from '../../views/settings/AccountsSection.tsx';
import { Button, Card, Dialog, EmptyState, Icon, IconButton, Segmented, Skeleton, StatusBadge, Switch, useToast } from '../components/index.ts';
import { ACCOUNT_CHOICE_WORDS, SETTINGS_WORDS as W } from '../glossary.ts';
import { accountChoiceRows } from '../../api/account-choice.ts';
import { AccountChoiceRows, useChooseAccount } from '../shared/AccountChoice.tsx';
import { V2Link } from '../nav.tsx';
import { agentName } from '../shared/agent-line.ts';
import { saveWarnAt, useWarnAt } from '../shared/warn-at.ts';
import { ClassicFrame } from './ClassicFrame.tsx';
import { accountCard, inUseIds, switchAtChoices, switchAtOf, switchAtPatch } from './settings-model.ts';

function errorText(caught: unknown): string {
  if (caught instanceof ApiError && typeof caught.body === 'object' && caught.body !== null) {
    const body = caught.body as { errors?: Array<{ message?: string }>; message?: string };
    const message = body.errors?.[0]?.message ?? body.message;
    if (message) return message;
  }
  return caught instanceof Error ? caught.message : String(caught);
}

/** A usage bar (`.meter`): used %, the tone from how full it is. */
function Meter({ used, label }: { readonly used: number | null; readonly label: string }) {
  const tone = used === null ? 'grey' : used >= 98 ? 'red' : used >= 85 ? 'amber' : 'blue';
  return (
    <div className="v2-meter" data-tone={tone} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used ?? 0}>
      <b style={{ width: `${used ?? 0}%` }} />
    </div>
  );
}

/**
 * Fix after 2.0 · "Warn at" (`usage.warnAtPct`, the same setting and choices as
 * classic's Settings › Notifications & usage, `warnAtOptions`): when a Max usage
 * warning fires (`docs/v2.md` → *Usage warnings*) and where the status pill turns amber.
 */
function WarnAtCard() {
  const warnAt = useWarnAt();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const save = (pct: number): void => {
    setBusy(true);
    saveWarnAt(pct).then(
      (saved) => toast({ text: W.warnSaved(saved) }),
      (caught: unknown) => toast({ text: errorText(caught) || W.saveError, tone: 'error' }),
    ).finally(() => setBusy(false));
  };
  return (
    <Card pad className="v2-set-card" data-testid="v2-usage-warnings">
      <div className="v2-set-card-h">
        <h3 className="v2-grow">{W.warnTitle}</h3>
      </div>
      <p className="v2-muted v2-set-p">{W.warnSub}</p>
      <label className="v2-set-label">
        {W.warnAt}
        <select className="v2-field" data-testid="v2-usage-warn-at" value={warnAt} disabled={busy} onChange={(event) => save(Number(event.target.value))}>
          {warnAtOptions(warnAt).map((pct) => (
            <option key={pct} value={pct}>{`${pct}%`}</option>
          ))}
        </select>
      </label>
    </Card>
  );
}

/**
 * D131 · lane R · Settings › Usage & accounts (the prototype's `#set-usage` and
 * `renderAcctRules`): a card per account (what is left of its 5-hour window and
 * week, paid extra usage), the switching rules (order by drag or arrows, Sign in /
 * out, "switch at 98%", when all are out, switch back), pinned accounts, and a
 * link to Insights. Everything is D63's accounts API (`docs/accounts.md`).
 */
export function UsageSection() {
  const client = useMemo(() => accountsApi(null), []);
  const toast = useToast();
  const [overview, setOverview] = useState<AccountsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<AccountProfile | null>(null);
  const load = (refresh = false): void => {
    client.overview(refresh).then(
      (value) => {
        setOverview(value);
        setError(null);
      },
      (caught: unknown) => setError(errorText(caught)),
    );
  };
  useEffect(() => load(false), []);
  // The readings move with every usage event (the status pill's `system` event).
  useHubEvent('system', () => load(false));
  // D138: the overall choice changed (here, in the pill, on another tab).
  useHubEvent('accountChoiceChanged', () => load(false));
  const chooser = useChooseAccount(() => load(false));
  const now = Date.now();
  const saveRules = (patch: Record<string, unknown>): void => {
    setError(null);
    client.saveSettings(patch).then(
      (settings) => setOverview((current) => (current ? { ...current, settings } : current)),
      (caught: unknown) => setError(errorText(caught)),
    );
  };
  const reorder = (cli: CliProviderId, order: string[], moved: AccountProfile): void => {
    client.order(cli, order).then(
      (next) => {
        setOverview(next);
        toast({ text: `${accountCard(moved, false).title} is now number ${order.indexOf(moved.id) + 1}.` });
      },
      (caught: unknown) => setError(errorText(caught)),
    );
  };
  const signOut = (profile: AccountProfile): void => {
    client.signOut(profile.id).then(
      (answer) => {
        toast({ text: answer.message || `${accountCard(profile, false).title} signed out.`, tone: answer.ok ? 'ok' : 'error' });
        load(false);
      },
      (caught: unknown) => toast({ text: errorText(caught), tone: 'error' }),
    );
  };

  if (!overview) {
    return (
      <div className="v2-set-stack" data-testid="v2-set-usage-loading">
        {error ? (
          <EmptyState icon="alert" tone="grey" title={W.loadError} text={error} />
        ) : (
          <>
            <Card pad>
              <Skeleton width="40%" height={14} />
              <Skeleton lines={2} style={{ marginTop: 12 }} />
            </Card>
            <Card pad>
              <Skeleton width="30%" height={14} />
              <Skeleton lines={3} style={{ marginTop: 12 }} />
            </Card>
          </>
        )}
      </div>
    );
  }

  const profiles = [...overview.profiles].sort((a, b) => a.position - b.position);
  const using = inUseIds(profiles, now);
  const settings = overview.settings;
  const switchAt = switchAtOf(settings);
  return (
    <div className="v2-set-stack" data-testid="v2-set-usage">
      {error ? (
        <div className="v2-set-error" role="alert" data-testid="v2-set-error">
          {error}
        </div>
      ) : null}
      {profiles.length === 0 ? <EmptyState icon="wallet" tone="grey" title={W.noAccounts} /> : null}
      {profiles.map((profile) => {
        const card = accountCard(profile, using.has(profile.id), now);
        return (
          <Card pad key={profile.id} className="v2-set-card" data-testid="v2-account-card" data-profile-id={profile.id}>
            <div className="v2-set-card-h">
              <h3 className="v2-grow">{card.title}</h3>
              <StatusBadge status={card.status} label={card.statusLabel} />
            </div>
            {card.who ? <div className="v2-muted v2-set-small">{card.who}</div> : null}
            {card.outUntil && !card.credits?.onCredits ? <p className="v2-muted v2-set-p">{`${W.outOfUsage} until ${card.outUntil}. Agents on it move to the next account with usage left.`}</p> : null}
            {card.credits?.onCredits ? <p className="v2-muted v2-set-p">Normal usage is used up. Agents on this account use paid extra usage until it resets.</p> : null}
            <div className="v2-set-bars">
              {card.windows.map((window) => (
                <div className="v2-set-bar" key={window.label} data-testid="v2-account-window">
                  <span className="v2-set-bar-l">{window.label}</span>
                  <Meter used={window.used} label={`${card.title}: ${window.label} used`} />
                  <span className="v2-set-bar-t">{window.text}</span>
                </div>
              ))}
            </div>
            {card.credits ? (
              <div className="v2-set-credits" data-testid="v2-account-credits">
                <Icon name="wallet" size="s" />
                <span>
                  <b>{W.paidExtra}</b> · {card.credits.text}
                </span>
              </div>
            ) : null}
          </Card>
        );
      })}

      {accountChoiceRows(overview, now).length > 0 ? (
        <Card pad className="v2-set-card" data-testid="v2-account-choice-card">
          <div className="v2-set-card-h">
            <h3 className="v2-grow">{ACCOUNT_CHOICE_WORDS.title}</h3>
          </div>
          <p className="v2-muted v2-set-p">{ACCOUNT_CHOICE_WORDS.sub}</p>
          <AccountChoiceRows rows={accountChoiceRows(overview, now)} disabled={chooser.busy} testId="v2-set-account-choice" onChoose={(row, profileId) => void chooser.choose(row.cli, profileId)} />
        </Card>
      ) : null}
      {chooser.dialog}

      <Card pad className="v2-set-card" data-testid="v2-account-rules">
        <div className="v2-set-card-h">
          <h3 className="v2-grow">{W.switchingTitle}</h3>
          <Switch checked={settings.enabled} label={W.switchingOn} testId="v2-accounts-enabled" onChange={(on) => saveRules({ enabled: on })} />
        </div>
        <p className="v2-muted v2-set-p">{W.switchingSub}</p>
        {CLI_PROVIDERS.map((cli) => {
          const mine = profiles.filter((p) => p.cli === cli);
          if (mine.length === 0) return null;
          return <OrderList key={cli} cli={cli} profiles={mine} onReorder={reorder} onSignIn={setSigningIn} onSignOut={signOut} />;
        })}
        <div className="v2-set-grid2">
          <label className="v2-set-label" data-row="accounts-switch-at">
            {W.switchAt}
            <select className="v2-field" data-testid="v2-accounts-switch-at" value={switchAt} onChange={(event) => saveRules(switchAtPatch(Number(event.target.value)))}>
              {switchAtChoices(switchAt).map((pct) => (
                <option key={pct} value={pct}>
                  {pct >= 100 ? W.switchAtLimit : `${pct}%`}
                </option>
              ))}
            </select>
          </label>
          <div data-row="accounts-all-out">
            <span className="v2-set-label">{W.whenAllOut}</span>
            <Segmented
              label={W.whenAllOut}
              testId="v2-accounts-all-out"
              value={settings.outOfAllowance}
              onChange={(value) => saveRules({ outOfAllowance: value })}
              options={[
                { value: 'use-credits', label: W.usePaidExtra },
                { value: 'pause', label: W.pauseNewWork },
              ]}
            />
          </div>
        </div>
        <div className="v2-set-row" data-row="accounts-switch-back">
          <span className="v2-grow">{W.switchBack}</span>
          <Switch checked={settings.afterReset === 'back-to-first'} label={W.switchBack} testId="v2-accounts-switch-back" onChange={(on) => saveRules({ afterReset: on ? 'back-to-first' : 'stay' })} />
        </div>
        <PinnedAccounts profiles={profiles} />
        <p className="v2-muted v2-set-small">
          More options (adding accounts, per-engine switching, other computers’ accounts):{' '}
          <V2Link to="/settings/advanced/accounts" data-testid="v2-accounts-more">
            Advanced › Accounts
          </V2Link>
        </p>
      </Card>

      <WarnAtCard />

      <InsightsCard />

      <Dialog open={signingIn !== null} onClose={() => setSigningIn(null)} title={signingIn ? `${W.signIn}: ${accountCard(signingIn, false).title}` : W.signIn} icon="wallet" testId="v2-signin-dialog" width={620}>
        {signingIn ? (
          <ClassicFrame>
            <SignInPanel
              profile={signingIn}
              client={client}
              onFinished={() => {
                toast({ text: `${accountCard(signingIn, false).title} signed in.` });
                setSigningIn(null);
                load(false);
              }}
              onClose={() => setSigningIn(null)}
            />
          </ClassicFrame>
        ) : null}
      </Dialog>
    </div>
  );
}

/** One engine's accounts in switching order: drag, ↑ / ↓ and Sign in / out. */
function OrderList({
  cli,
  profiles,
  onReorder,
  onSignIn,
  onSignOut,
}: {
  readonly cli: CliProviderId;
  readonly profiles: readonly AccountProfile[];
  readonly onReorder: (cli: CliProviderId, order: string[], moved: AccountProfile) => void;
  readonly onSignIn: (profile: AccountProfile) => void;
  readonly onSignOut: (profile: AccountProfile) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const ids = profiles.map((p) => p.id);
  const drop = (event: DragEvent<HTMLDivElement>, before: string): void => {
    event.preventDefault();
    const id = dragging ?? event.dataTransfer.getData('text/plain');
    setDragging(null);
    const moved = profiles.find((p) => p.id === id);
    if (!moved || id === before) return;
    onReorder(cli, droppedOrder(ids, id, before), moved);
  };
  return (
    <div className="v2-acct-list" role="list" aria-label={`${CLI_LABELS[cli]} accounts, in switching order`} data-testid="v2-account-order" data-cli={cli}>
      {profiles.length > 1 || CLI_PROVIDERS.length > 1 ? <div className="v2-set-group">{CLI_LABELS[cli]}</div> : null}
      {profiles.map((profile, index) => {
        const card = accountCard(profile, false);
        return (
          <div
            key={profile.id}
            role="listitem"
            className="v2-acct-row"
            draggable={profiles.length > 1}
            data-testid="v2-account-row"
            data-profile-id={profile.id}
            data-dragging={dragging === profile.id ? '' : undefined}
            onDragStart={(event) => {
              setDragging(profile.id);
              event.dataTransfer.setData('text/plain', profile.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(event) => drop(event, profile.id)}
          >
            <span className="v2-acct-grip" aria-hidden="true">
              <Icon name="grip" size="s" />
            </span>
            <b className="v2-acct-pos">{index + 1}</b>
            <div className="v2-grow">
              <div className="v2-acct-name">{card.title}</div>
              <div className="v2-muted v2-set-small">{card.signedIn ? (card.who ?? 'Signed in') : 'Signed out'}</div>
            </div>
            {profiles.length > 1 ? (
              <>
                <IconButton icon="chev-down" className="v2-acct-up" label={`Move ${card.title} up`} disabled={index === 0} onClick={() => onReorder(cli, movedOrder(ids, profile.id, -1), profile)} data-testid="v2-account-up" />
                <IconButton icon="chev-down" label={`Move ${card.title} down`} disabled={index === profiles.length - 1} onClick={() => onReorder(cli, movedOrder(ids, profile.id, 1), profile)} data-testid="v2-account-down" />
              </>
            ) : null}
            {profile.builtin ? (
              <span className="v2-muted v2-set-small" title="Your own login of the engine: sign in or out in its terminal.">
                Your own login
              </span>
            ) : card.signedIn ? (
              <Button size="sm" onClick={() => onSignOut(profile)} data-testid="v2-account-signout">
                {W.signOut}
              </Button>
            ) : (
              <Button size="sm" onClick={() => onSignIn(profile)} data-testid="v2-account-signin">
                {W.signIn}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Pinned accounts: the agents that always use one account (`profilePinned`), Unpin, and pinning another. */
function PinnedAccounts({ profiles }: { readonly profiles: readonly AccountProfile[] }) {
  const sessions = useSessionListOf();
  const toast = useToast();
  const open = (sessions.data ?? []).filter((s) => !s.closedAt && !s.machine);
  const pinned = open.filter((s) => s.profilePinned);
  const [agent, setAgent] = useState('');
  const [account, setAccount] = useState('');
  const chosen = open.find((s) => s.id === agent) ?? null;
  const fitting = profiles.filter((p) => p.enabled && p.cli === (chosen?.provider ?? 'claude'));
  const pin = async (): Promise<void> => {
    if (!chosen) return;
    const target = account || chosen.profileId || fitting[0]?.id;
    try {
      if (target && target !== (chosen.profileId ?? `default-${chosen.provider ?? 'claude'}`)) await api.switchAccount(chosen.id, target);
      await api.pinProfile(chosen.id, true);
      toast({ text: `${agentName(chosen)} always uses this account now.`, undo: () => api.pinProfile(chosen.id, false) });
      sessions.reload();
    } catch (caught) {
      toast({ text: errorText(caught), tone: 'error' });
    }
  };
  return (
    <div className="v2-set-pins" data-testid="v2-account-pins">
      <h4>{W.pinnedTitle}</h4>
      <p className="v2-muted v2-set-small">{W.pinnedSub}</p>
      {pinned.length === 0 ? <p className="v2-muted v2-set-small">{W.pinnedNone}</p> : null}
      {pinned.map((session) => (
        <div className="v2-set-row" key={session.id} data-testid="v2-account-pin">
          <Icon name="pin" size="s" />
          <span className="v2-grow">
            <b>{agentName(session)}</b> always uses {session.profileName ?? 'its account'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void api.pinProfile(session.id, false).then(
                () => sessions.reload(),
                (caught: unknown) => toast({ text: errorText(caught), tone: 'error' }),
              )
            }
          >
            {W.unpin}
          </Button>
        </div>
      ))}
      <div className="v2-set-pin-form">
        <select className="v2-field" aria-label="Agent" value={agent} onChange={(event) => setAgent(event.target.value)} data-testid="v2-pin-agent">
          <option value="">Choose an agent…</option>
          {open
            .filter((s) => !s.profilePinned)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {agentName(s)}
              </option>
            ))}
        </select>
        <select className="v2-field" aria-label="Account" value={account} onChange={(event) => setAccount(event.target.value)} disabled={!chosen} data-testid="v2-pin-account">
          <option value="">{chosen ? 'Its current account' : 'Account'}</option>
          {fitting.map((p) => (
            <option key={p.id} value={p.id}>
              {accountCard(p, false).title}
            </option>
          ))}
        </select>
        <Button icon="pin" disabled={!chosen} title={chosen ? undefined : 'Choose an agent first.'} onClick={() => void pin()} data-testid="v2-pin-button">
          {W.pinButton}
        </Button>
      </div>
    </div>
  );
}

/** The Insights card: today's numbers in brief, and the way to the page. */
function InsightsCard() {
  const insights = useApi(() => api.insights('period=7d').catch(() => null), []);
  const totals = insights.data?.time.totals ?? null;
  return (
    <Card pad className="v2-set-card" data-testid="v2-insights-card">
      <div className="v2-set-card-h">
        <Icon name="insights" size="l" />
        <h3 className="v2-grow">{W.insightsTitle}</h3>
        <V2Link to="/insights" className="v2-btn" data-variant="primary" data-size="sm" data-testid="v2-open-insights">
          {W.openInsights}
          <Icon name="chev" size="s" />
        </V2Link>
      </div>
      <p className="v2-muted v2-set-small">Time, tokens and cost per folder, engine, model, account and computer, and how good the estimates are.</p>
      {/* D134: the Usage breakdown (which agents used each account's windows). */}
      <V2Link to="/insights?view=usage" className="v2-btn" data-variant="ghost" data-size="sm" data-testid="v2-open-usage">
        <Icon name="clock" size="s" />
        {W.seeUsage}
        <Icon name="chev" size="s" />
      </V2Link>
      {totals ? (
        <div className="v2-set-kv" data-testid="v2-insights-kv">
          <span>
            <b>{totals.tokens >= 1_000_000 ? `${(totals.tokens / 1_000_000).toFixed(1)}M` : `${Math.round(totals.tokens / 1000)}k`}</b> tokens in 7 days
          </span>
          <span>
            <b>{totals.sessions}</b> agents
          </span>
          <span>
            <b>{totals.turns}</b> replies
          </span>
        </div>
      ) : null}
    </Card>
  );
}
