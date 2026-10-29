import { useCallback, useEffect, useRef, useState } from 'react';
import type { TeamAccessEntryView, TeamAccessView } from '../../../core/team-access.ts';
import { onHubEvent } from '../../api/useHub.ts';
import { AccessApiError, accessApi } from '../../team/access/api.ts';
import { Button, Chip, EmptyState, Field, Icon, Skeleton, useToast } from '../components/index.ts';
import { CREW_WORDS } from '../glossary.ts';
import { timeAgo } from '../shared/time.ts';

/**
 * D131 · lane P · a teammate's **Access** tab (D100-T2): every access its agent asked for, with
 * the exact service, host and scope, its status on each computer, and **Add key**: the values of
 * exactly the declared fields, sent once to the Switchboard of the computer the teammate runs on
 * (D146: over the paired connection when that is another computer), which keeps them in its OS
 * keychain (`POST /api/team/access/{id}/setup`); never shown again. Test connection and Revoke
 * run there too; "Set up here too" keeps a copy in this computer's keychain. A phone reads it only ("Set this up on a computer"). Opened from Needs you's Add key
 * by `/crews/<crew>?member=<id>&tab=access&access=<id>` (that access's form opens).
 */
export function AccessPanel({ memberId, focusAccess = null, onChanged }: { readonly memberId: string; /** The access whose form opens (Needs you's Add key); else the first one waiting. */ readonly focusAccess?: string | null; readonly onChanged?: () => void }) {
  const [view, setView] = useState<TeamAccessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // The form opens by itself once per member / asked access, never again on a reload: a reload racing a
  // save (the hub's teamChanged) would otherwise open the just-saved form again, as if Save did nothing.
  const opened = useRef<string | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await accessApi.view(memberId);
      setView(next);
      setError(null);
      const key = `${memberId}|${focusAccess ?? ''}`;
      if (opened.current !== key) {
        opened.current = key;
        const asked = focusAccess ? next.entries.find((entry) => entry.id === focusAccess && entry.canSetUp) : undefined;
        setOpen(asked?.id ?? next.entries.find((entry) => entry.canSetUp && (entry.status === 'requested' || entry.status === 'needs-setup'))?.id ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [memberId, focusAccess]);
  useEffect(() => {
    void load();
    return onHubEvent('teamChanged', () => void load());
  }, [load]);
  if (error) {
    return (
      <p className="v2-field-error" role="alert">
        {error}
      </p>
    );
  }
  if (!view) return <Skeleton lines={3} />;
  if (view.entries.length === 0) {
    return <EmptyState icon="shield" tone="grey" title="No access asked for" text="When its agent needs a key or a connection to fetch data, the request shows here and in Needs you." testId="v2-access-empty" />;
  }
  return (
    <div className="v2-c-access" data-testid="v2-access-tab">
      {view.device ? (
        <p className="v2-c-note">
          <Icon name="phone" size="s" />
          Set this up on a computer: keys never go through a phone.
        </p>
      ) : null}
      {!view.member.local ? (
        // D146: setup, test and revoke go to the computer the teammate runs on.
        <p className="v2-c-note" data-testid="v2-access-target">
          <Icon name="desktop" size="s" />
          For {view.member.name} on {view.member.machineName}: keys you save here are sent once to {view.member.machineName} and kept in its keychain, not on {view.self.name}.
        </p>
      ) : null}
      {view.member.local && !view.keychain.available ? (
        <p className="v2-c-note">
          <Icon name="alert" size="s" />
          {view.keychain.name} can’t be used here{view.keychain.problem ? `: ${view.keychain.problem}` : ''}.
        </p>
      ) : null}
      {view.entries.map((entry) => (
        <AccessEntry key={entry.id} entry={entry} device={view.device} keychain={view.keychain.available} local={view.member.local} self={view.self.name} open={open === entry.id} onToggle={() => setOpen((current) => (current === entry.id ? null : entry.id))} onChanged={() => void load().then(() => onChanged?.())} />
      ))}
    </div>
  );
}

function statusTone(entry: TeamAccessEntryView): 'green' | 'amber' | 'grey' | 'red' {
  if (entry.status === 'ready') return 'green';
  if (entry.status === 'requested' || entry.status === 'needs-setup') return 'amber';
  if (entry.status === 'denied' || entry.status === 'revoked' || entry.status === 'expired') return 'red';
  return 'grey';
}

function AccessEntry({ entry, device, keychain, local, self, open, onToggle, onChanged }: { readonly entry: TeamAccessEntryView; readonly device: boolean; readonly keychain: boolean; /** The teammate runs on this computer. */ readonly local: boolean; /** This computer's name. */ readonly self: string; readonly open: boolean; readonly onToggle: () => void; readonly onChanged: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // D146: "Set up here too" (this computer's keychain) instead of the teammate's computer (the default).
  const [here, setHere] = useState(false);
  const toast = useToast();
  const machine = entry.member.machineName;
  const onMember = entry.setUpOn.includes(entry.member.machineId);
  const label = local ? (entry.here ? 'Replace' : entry.setUpOn.length > 0 ? 'Set up here too' : CREW_WORDS.addKey) : onMember ? 'Replace' : CREW_WORDS.addKey;
  const save = async (): Promise<void> => {
    setBusy(true);
    setErrors({});
    try {
      await accessApi.setUp(entry.id, { values, ...(here && !local ? { here: true } : {}) });
      setValues({});
      toast({ text: here && !local ? `${entry.service} set up on ${self} too.` : `${entry.service} set up on ${local ? 'this computer' : machine}. Its agent gets it from its next start.` });
      setHere(false);
      onToggle();
      onChanged();
    } catch (e) {
      if (e instanceof AccessApiError && e.errors.length > 0) setErrors(Object.fromEntries(e.errors.map((field) => [field.field.replace(/^values\./, ''), field.message])));
      else toast({ text: e instanceof Error ? e.message : String(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="v2-card v2-c-access-entry" data-testid="v2-access-entry" data-access-id={entry.id} data-status={entry.status} aria-label={entry.service}>
      <div className="v2-row v2-c-wrap">
        <Icon name={entry.kind === 'mcp' ? 'plug' : 'shield'} size="s" />
        <b className="v2-grow">{entry.service}</b>
        <Chip tone={statusTone(entry)} size="s">
          {entry.statusText}
        </Chip>
      </div>
      <p className="v2-muted v2-c-small">
        <span className="v2-mono">{entry.host}</span> · {entry.scope}
        {entry.lastUsedAt ? ` · used ${timeAgo(entry.lastUsedAt)}` : ''}
      </p>
      <p className="v2-c-why">{entry.why}</p>
      {entry.warning ? (
        <p className="v2-c-warn">
          <Icon name="alert" size="s" />
          {entry.warning}
        </p>
      ) : null}
      <p className="v2-muted v2-c-small">Gives: {entry.delivers}</p>
      <div className="v2-row v2-c-wrap">
        {entry.canSetUp && !device ? (
          <Button
            size="sm"
            variant={entry.status === 'ready' ? 'default' : 'primary'}
            icon="plus"
            disabled={local && !keychain}
            onClick={() => {
              if (open && !here) onToggle();
              else {
                setHere(false);
                if (!open) onToggle();
              }
            }}
            aria-expanded={open && !here}
            data-testid="v2-access-add"
          >
            {label}
          </Button>
        ) : null}
        {entry.canSetUp && !device && !local && onMember && !entry.here ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={!keychain}
            onClick={() => {
              if (open && here) onToggle();
              else {
                setHere(true);
                if (!open) onToggle();
              }
            }}
            aria-expanded={open && here}
            data-testid="v2-access-add-here"
          >
            Set up here too
          </Button>
        ) : null}
        {(onMember || entry.here) && !device && entry.status !== 'revoked' ? (
          <Button
            size="sm"
            data-testid="v2-access-test"
            onClick={async () => {
              try {
                const result = await accessApi.test(entry.id, !onMember);
                toast({ text: result.detail || (result.ok ? 'Connected' : 'Test failed'), tone: result.ok ? 'ok' : 'error' });
              } catch (e) {
                toast({ text: e instanceof Error ? e.message : String(e), tone: 'error' });
              }
            }}
          >
            Test connection
          </Button>
        ) : null}
        {entry.setUpOn.length > 0 && !device && entry.status !== 'revoked' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                await accessApi.revoke(entry.id);
                toast({ text: `${entry.service} revoked everywhere.` });
                onChanged();
              } catch (e) {
                toast({ text: e instanceof Error ? e.message : String(e), tone: 'error' });
              }
            }}
          >
            Revoke
          </Button>
        ) : null}
      </div>
      {open && entry.canSetUp && !device ? (
        <form
          className="v2-c-access-form"
          data-testid="v2-access-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="v2-muted v2-c-small" data-testid="v2-access-form-where">
            {here || local ? 'Stored in this computer’s keychain' : `Sent once to ${machine} and stored in its keychain`}, given only to this teammate’s agent, never shown again.
          </p>
          {entry.fields.map((field) => (
            <Field
              key={field.name}
              label={`${field.label} (${field.name})`}
              type={field.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              value={values[field.name] ?? ''}
              hint={field.help || undefined}
              error={errors[field.name] ?? null}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setValues((current) => ({ ...current, [field.name]: value }));
              }}
              data-testid="v2-access-field"
              data-field={field.name}
            />
          ))}
          <div className="v2-row">
            <span className="v2-grow" />
            <Button onClick={onToggle}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy || entry.fields.some((field) => (values[field.name] ?? '').trim() === '')} data-testid="v2-access-save">
              Save key
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
