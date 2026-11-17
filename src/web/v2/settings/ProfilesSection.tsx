import { useState } from 'react';
import type { MachinesView } from '../../../core/peers.ts';
import { USER_PROFILE_COLORS, type UserProfile } from '../../../core/user-profiles.ts';
import { ApiError, api, machineApi } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { Button, Card, Dialog, Field, Select, useToast } from '../components/index.ts';
import { PROFILE_WORDS as W } from '../glossary.ts';
import { ProfileDot, useSwitchProfile, useUserProfiles } from '../profiles/Profiles.tsx';

/**
 * D165 · Settings → Profiles (`docs/profiles.md`): every profile (any number) with its colour,
 * whether it has a password and whether this browser works in it; add one; per profile rename,
 * colour, set / change / remove its password, its default account per CLI on this computer,
 * switch to it, delete it (its open agents are archived; Default stays). D173: its Admin chip and the
 * computers it may use; an admin (or the first admin, the bootstrap) changes them with *Computers…*.
 */
export function ProfilesSection() {
  const { view, reload } = useUserProfiles();
  const machines = useApi(api.machines);
  const actor = view?.profiles.find((profile) => profile.id === view.activeId) ?? null;
  const anyAdmin = (view?.profiles ?? []).some((profile) => profile.admin === true);
  const { ask, dialog } = useSwitchProfile();
  const [adding, setAdding] = useState(false);
  return (
    <section className="v2-set-section" data-testid="v2-settings-profiles-section">
      <p className="v2-muted">{W.sectionIntro}</p>
      <p className="v2-muted v2-profile-note">{W.notSecurity}</p>
      <Card>
        <ul className="v2-profile-list" data-testid="v2-profile-list">
          {(view?.profiles ?? []).map((profile) => (
            <ProfileRow key={profile.id} profile={profile} all={view?.profiles ?? []} active={profile.id === view?.activeId} actor={actor} anyAdmin={anyAdmin} machines={machines.data} onSwitch={() => ask(profile)} onChanged={reload} />
          ))}
        </ul>
      </Card>
      <Button icon="plus" onClick={() => setAdding(true)} data-testid="v2-profile-add">
        {W.add}
      </Button>
      {view?.startId !== undefined ? <StartProfileSelect profiles={view.profiles} startId={view.startId} onChanged={reload} /> : null}
      {adding ? <AddProfileDialog onClose={() => setAdding(false)} onAdded={reload} /> : null}
      {dialog}
    </section>
  );
}

/**
 * 2026-11-16 · *Open in*: the profile a browser opens in before it chose one (with a password, the
 * browser asks once; afterwards it stays signed in to its profile across restarts).
 */
function StartProfileSelect({ profiles, startId, onChanged }: { readonly profiles: readonly UserProfile[]; readonly startId: string; readonly onChanged: () => void }) {
  const toast = useToast();
  return (
    <Select
      label={W.openIn}
      hint={W.openInHint}
      value={startId}
      options={profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
      onChange={(event) => {
        const id = event.currentTarget.value;
        api.setStartUserProfile(id).then(
          () => {
            onChanged();
            toast({ text: W.openInSaved(profiles.find((profile) => profile.id === id)?.name ?? '') });
          },
          (caught: unknown) => toast({ text: errorText(caught), tone: 'error' }),
        );
      }}
      data-testid="v2-profile-open-in"
      data-tour="v2-profile-open-in"
    />
  );
}

function errorText(error: unknown): string {
  const body = error instanceof ApiError ? (error.body as { message?: unknown } | null) : null;
  return typeof body?.message === 'string' && body.message ? body.message : W.failed;
}

function colorOptions() {
  return USER_PROFILE_COLORS.map((color) => ({ value: color, label: color[0]!.toUpperCase() + color.slice(1) }));
}

/** D173: the computers' names for an access list (`null`: every computer); an unknown id shows as itself. */
function computerNames(computers: readonly string[] | null | undefined, machines: MachinesView | null): readonly string[] | null {
  if (computers === null || computers === undefined) return null;
  return computers.map((id) => (id === machines?.self.id ? `${machines.self.name} (${W.thisComputer})` : (machines?.machines.find((machine) => machine.id === id)?.name ?? id)));
}

interface RowProps {
  readonly profile: UserProfile;
  readonly all: readonly UserProfile[];
  readonly active: boolean;
  /** D173: this browser's profile (`null`: none chosen). */
  readonly actor: UserProfile | null;
  readonly anyAdmin: boolean;
  readonly machines: MachinesView | null;
  readonly onSwitch: () => void;
  readonly onChanged: () => void;
}

function ProfileRow({ profile, all, active, actor, anyAdmin, machines, onSwitch, onChanged }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [access, setAccess] = useState(false);
  const others = all.filter((other) => other.id !== profile.id);
  // D173: an admin manages every profile; while there is no admin, a profile with a password may make itself the first.
  const bootstrap = !anyAdmin && active && profile.hasPassword;
  const manages = actor?.admin === true || bootstrap;
  return (
    <li className="v2-profile-row" data-testid="v2-profile-row" data-profile={profile.id} data-active={active ? 'true' : undefined}>
      <ProfileDot color={profile.color} />
      <span className="v2-grow">
        <b>{profile.name}</b>
        {active ? <span className="v2-chip-mini">{W.active}</span> : null}
        {profile.hasPassword ? <span className="v2-chip-mini">{W.locked}</span> : null}
        {profile.admin ? (
          <span className="v2-chip-mini" data-testid="v2-profile-admin-chip">
            {W.admin}
          </span>
        ) : null}
        {profile.allowedHere === false ? <span className="v2-chip-mini">{W.notHere}</span> : null}
        {profile.computers !== undefined ? (
          <span className="v2-muted v2-profile-computers" data-testid="v2-profile-computers" data-tour="v2-profile-access">
            {' '}
            · {W.computersSummary(computerNames(profile.computers, machines))}
          </span>
        ) : null}
      </span>
      {manages ? (
        <Button size="sm" onClick={() => setAccess(true)} data-testid="v2-profile-access">
          {W.access}
        </Button>
      ) : null}
      {!active && profile.allowedHere !== false ? (
        <Button size="sm" onClick={onSwitch} data-testid="v2-profile-switch">
          {W.switchAction}
        </Button>
      ) : null}
      <Button size="sm" onClick={() => setEditing(true)} data-testid="v2-profile-edit">
        {W.rename}
      </Button>
      {others.length > 0 ? (
        <Button size="sm" onClick={() => setMerging(true)} data-testid="v2-profile-merge" data-tour="v2-profile-merge">
          {W.merge}
        </Button>
      ) : null}
      {!profile.isDefault && !profile.computerDefault ? (
        <Button size="sm" variant="danger" onClick={() => setDeleting(true)} data-testid="v2-profile-delete">
          {W.delete}
        </Button>
      ) : null}
      {merging ? <MergeProfileDialog profile={profile} others={others} onClose={() => setMerging(false)} onChanged={onChanged} /> : null}
      {editing ? <EditProfileDialog profile={profile} active={active} onClose={() => setEditing(false)} onChanged={onChanged} /> : null}
      {deleting ? <DeleteProfileDialog profile={profile} onClose={() => setDeleting(false)} onChanged={onChanged} /> : null}
      {access && actor ? <AccessDialog profile={profile} actor={actor} bootstrap={bootstrap && actor.admin !== true} machines={machines} onClose={() => setAccess(false)} onChanged={onChanged} /> : null}
    </li>
  );
}

/**
 * D173 · *Computers…*: whether the profile is an admin and which computers it may use (all, or a
 * checklist of this computer and the paired ones). The admin's (this browser's profile's) password
 * confirms. The bootstrap (no admin yet): only *Admin*, for this browser's own profile.
 */
function AccessDialog({ profile, actor, bootstrap, machines, onClose, onChanged }: { readonly profile: UserProfile; readonly actor: UserProfile; readonly bootstrap: boolean; readonly machines: MachinesView | null; readonly onClose: () => void; readonly onChanged: () => void }) {
  const toast = useToast();
  const [admin, setAdmin] = useState(profile.admin === true || bootstrap);
  const [all, setAll] = useState(profile.computers === null || profile.computers === undefined);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(profile.computers ?? []));
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const choices = machines ? [{ id: machines.self.id, name: `${machines.self.name} (${W.thisComputer})` }, ...machines.machines.map((machine) => ({ id: machine.id, name: machine.name }))] : [];
  const sameAccess = all ? profile.computers === null || profile.computers === undefined : profile.computers !== null && profile.computers !== undefined && profile.computers.length === picked.size && profile.computers.every((id) => picked.has(id));
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (admin !== (profile.admin === true)) await api.setUserProfileAdmin(profile.id, admin, password);
      if (!bootstrap && !sameAccess) await api.setUserProfileAccess(profile.id, all ? 'all' : [...picked], password);
      toast({ text: W.accessSaved(profile.name) });
      onChanged();
      onClose();
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={W.accessTitle(profile.name)}
      icon="agents"
      testId="v2-profile-access-dialog"
      footer={
        <>
          <Button onClick={onClose}>{W.cancel}</Button>
          <Button variant="primary" disabled={busy || password === ''} onClick={() => void save()} data-testid="v2-profile-access-go">
            {W.save}
          </Button>
        </>
      }
    >
      <p>{bootstrap ? W.bootstrapText : W.accessText}</p>
      <label className="v2-check">
        <input type="checkbox" checked={admin} onChange={(event) => setAdmin(event.currentTarget.checked)} data-testid="v2-profile-admin" /> {W.makeAdmin}
      </label>
      {!bootstrap ? (
        <fieldset className="v2-profile-computers-choice" data-testid="v2-profile-computers-choice">
          <legend>{W.computers}</legend>
          <label className="v2-check">
            <input type="radio" name="v2-profile-computers" checked={all} onChange={() => setAll(true)} data-testid="v2-profile-computers-all" /> {W.allComputers}
          </label>
          <label className="v2-check">
            <input type="radio" name="v2-profile-computers" checked={!all} onChange={() => setAll(false)} data-testid="v2-profile-computers-some" /> {W.onlyThese}
          </label>
          {!all
            ? choices.map((choice) => (
                <label key={choice.id} className="v2-check v2-profile-computer" data-machine={choice.id}>
                  <input
                    type="checkbox"
                    checked={picked.has(choice.id)}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setPicked((now) => {
                        const next = new Set(now);
                        if (on) next.add(choice.id);
                        else next.delete(choice.id);
                        return next;
                      });
                    }}
                  />{' '}
                  {choice.name}
                </label>
              ))
            : null}
        </fieldset>
      ) : null}
      <Field label={W.adminPassword(actor.name)} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} data-testid="v2-profile-admin-password" />
      {error ? (
        <p className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

function AddProfileDialog({ onClose, onAdded }: { readonly onClose: () => void; readonly onAdded: () => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>('green');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async (): Promise<void> => {
    try {
      await api.createUserProfile({ name: name.trim(), color, ...(password ? { password } : {}) });
      onAdded();
      onClose();
    } catch (caught) {
      setError(errorText(caught));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={W.add}
      icon="agents"
      testId="v2-profile-add-dialog"
      footer={
        <>
          <Button onClick={onClose}>{W.cancel}</Button>
          <Button variant="primary" disabled={name.trim() === ''} onClick={() => void add()} data-testid="v2-profile-add-go">
            {W.add}
          </Button>
        </>
      }
    >
      <Field label={W.name} value={name} maxLength={40} autoFocus onChange={(event) => setName(event.currentTarget.value)} data-testid="v2-profile-name" />
      <Select label={W.color} value={color} options={colorOptions()} onChange={(event) => setColor(event.currentTarget.value)} data-testid="v2-profile-color" />
      <Field label={W.newPassword} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} data-testid="v2-profile-new-password" />
      {error ? (
        <p className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

function EditProfileDialog({ profile, active, onClose, onChanged }: { readonly profile: UserProfile; readonly active: boolean; readonly onClose: () => void; readonly onChanged: () => void }) {
  const toast = useToast();
  const accounts = useApi(machineApi(null).accounts);
  const [name, setName] = useState(profile.name);
  const [color, setColor] = useState<string>(profile.color);
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [removePassword, setRemovePassword] = useState(false);
  const [defaults, setDefaults] = useState<Record<string, string | null>>({ ...profile.defaultAccounts });
  const [error, setError] = useState<string | null>(null);
  const clis = [...new Set(((accounts.data as { profiles?: ReadonlyArray<{ cli: string }> } | null)?.profiles ?? []).map((account) => account.cli))];
  const accountsOf = (cli: string) => ((accounts.data as { profiles?: ReadonlyArray<{ id: string; cli: string; name: string; enabled?: boolean }> } | null)?.profiles ?? []).filter((account) => account.cli === cli && account.enabled !== false);
  const save = async (): Promise<void> => {
    try {
      const needCurrent = profile.hasPassword && (!active || password !== '' || removePassword);
      await api.updateUserProfile(profile.id, {
        ...(name.trim() !== profile.name ? { name: name.trim() } : {}),
        ...(color !== profile.color ? { color } : {}),
        ...(password ? { password } : removePassword ? { password: null } : {}),
        ...(needCurrent ? { currentPassword: current } : {}),
        defaultAccounts: defaults,
      });
      onChanged();
      toast({ text: `${name.trim()} saved.` });
      onClose();
    } catch (caught) {
      setError(errorText(caught));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={profile.name}
      icon="agents"
      testId="v2-profile-edit-dialog"
      footer={
        <>
          <Button onClick={onClose}>{W.cancel}</Button>
          <Button variant="primary" disabled={name.trim() === ''} onClick={() => void save()} data-testid="v2-profile-save">
            {W.save}
          </Button>
        </>
      }
    >
      <Field label={W.name} value={name} maxLength={40} onChange={(event) => setName(event.currentTarget.value)} data-testid="v2-profile-edit-name" />
      <Select label={W.color} value={color} options={colorOptions()} onChange={(event) => setColor(event.currentTarget.value)} />
      <Field label={profile.hasPassword ? W.changePassword : W.setPassword} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} data-testid="v2-profile-edit-password" />
      {profile.hasPassword ? (
        <>
          <label className="v2-check">
            <input type="checkbox" checked={removePassword} onChange={(event) => setRemovePassword(event.currentTarget.checked)} /> {W.removePassword}
          </label>
          <Field label={W.currentPassword} type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.currentTarget.value)} data-testid="v2-profile-current-password" />
        </>
      ) : null}
      {clis.map((cli) => (
        <Select
          key={cli}
          label={W.defaultAccount(cli)}
          hint={W.defaultAccountHint}
          value={defaults[cli] ?? ''}
          options={[{ value: '', label: W.automatic }, ...accountsOf(cli).map((account) => ({ value: account.id, label: account.name }))]}
          onChange={(event) => setDefaults((now) => ({ ...now, [cli]: event.currentTarget.value === '' ? null : event.currentTarget.value }))}
        />
      ))}
      {error ? (
        <p className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/**
 * D172 · Merge… : `profile` and another one become one profile on every computer, on purpose. Both
 * passwords (where set); the developer picks whose name, colour and password the merged one keeps.
 */
function MergeProfileDialog({ profile, others, onClose, onChanged }: { readonly profile: UserProfile; readonly others: readonly UserProfile[]; readonly onClose: () => void; readonly onChanged: () => void }) {
  const toast = useToast();
  const [otherId, setOtherId] = useState(others[0]?.id ?? '');
  const other = others.find((candidate) => candidate.id === otherId) ?? null;
  const [passwordA, setPasswordA] = useState('');
  const [passwordB, setPasswordB] = useState('');
  const [keep, setKeep] = useState<{ name: 'a' | 'b'; color: 'a' | 'b'; password: 'a' | 'b' }>({ name: 'a', color: 'a', password: 'a' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pickOptions = (label: (p: UserProfile) => string) => (other ? [{ value: 'a', label: label(profile) }, { value: 'b', label: label(other) }] : []);
  const merge = async (): Promise<void> => {
    if (!other) return;
    setBusy(true);
    setError(null);
    try {
      const { survivor } = await api.mergeUserProfiles({ a: profile.id, b: other.id, ...(passwordA ? { passwordA } : {}), ...(passwordB ? { passwordB } : {}), keep });
      toast({ text: W.merged(survivor.name) });
      onChanged();
      onClose();
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };
  const missing = (profile.hasPassword && !passwordA) || (other?.hasPassword === true && !passwordB);
  return (
    <Dialog
      open
      onClose={onClose}
      title={W.mergeTitle(profile.name)}
      icon="agents"
      testId="v2-profile-merge-dialog"
      footer={
        <>
          <Button onClick={onClose}>{W.cancel}</Button>
          <Button variant="primary" disabled={busy || !other || missing} onClick={() => void merge()} data-testid="v2-profile-merge-go">
            {W.mergeGo}
          </Button>
        </>
      }
    >
      <p>{W.mergeText}</p>
      <Select label={W.mergeWith} value={otherId} options={others.map((candidate) => ({ value: candidate.id, label: candidate.name }))} onChange={(event) => setOtherId(event.currentTarget.value)} data-testid="v2-profile-merge-other" />
      {profile.hasPassword ? <Field label={W.passwordOf(profile.name)} type="password" value={passwordA} onChange={(event) => setPasswordA(event.currentTarget.value)} data-testid="v2-profile-merge-password-a" /> : null}
      {other?.hasPassword ? <Field label={W.passwordOf(other.name)} type="password" value={passwordB} onChange={(event) => setPasswordB(event.currentTarget.value)} data-testid="v2-profile-merge-password-b" /> : null}
      <Select label={W.mergeKeepName} value={keep.name} options={pickOptions((p) => p.name)} onChange={(event) => setKeep((now) => ({ ...now, name: event.currentTarget.value as 'a' | 'b' }))} data-testid="v2-profile-merge-name" />
      <Select label={W.mergeKeepColor} value={keep.color} options={pickOptions((p) => `${p.name} (${p.color})`)} onChange={(event) => setKeep((now) => ({ ...now, color: event.currentTarget.value as 'a' | 'b' }))} />
      <Select label={W.mergeKeepPassword} value={keep.password} options={pickOptions((p) => (p.hasPassword ? p.name : `${p.name} ${W.noPassword}`))} onChange={(event) => setKeep((now) => ({ ...now, password: event.currentTarget.value as 'a' | 'b' }))} />
      {error ? (
        <p className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

function DeleteProfileDialog({ profile, onClose, onChanged }: { readonly profile: UserProfile; readonly onClose: () => void; readonly onChanged: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      const { archived } = await api.deleteUserProfile(profile.id, password || undefined);
      toast({ text: W.deleted(profile.name, archived) });
      onChanged();
      onClose();
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={W.deleteTitle(profile.name)}
      icon="trash"
      testId="v2-profile-delete-dialog"
      footer={
        <>
          <Button onClick={onClose}>{W.cancel}</Button>
          <Button variant="danger" disabled={busy || (profile.hasPassword && !password)} onClick={() => void remove()} data-testid="v2-profile-delete-go">
            {W.delete.replace('…', '')}
          </Button>
        </>
      }
    >
      <p>{W.deleteText}</p>
      {profile.hasPassword ? <Field label={W.passwordOf(profile.name)} type="password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} /> : null}
      {error ? (
        <p className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
