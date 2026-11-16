import { useState } from 'react';
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
 * switch to it, delete it (its open agents are archived; Default stays).
 */
export function ProfilesSection() {
  const { view, reload } = useUserProfiles();
  const { ask, dialog } = useSwitchProfile();
  const [adding, setAdding] = useState(false);
  return (
    <section className="v2-set-section" data-testid="v2-settings-profiles-section">
      <p className="v2-muted">{W.sectionIntro}</p>
      <p className="v2-muted v2-profile-note">{W.notSecurity}</p>
      <Card>
        <ul className="v2-profile-list" data-testid="v2-profile-list">
          {(view?.profiles ?? []).map((profile) => (
            <ProfileRow key={profile.id} profile={profile} active={profile.id === view?.activeId} onSwitch={() => ask(profile)} onChanged={reload} />
          ))}
        </ul>
      </Card>
      <Button icon="plus" onClick={() => setAdding(true)} data-testid="v2-profile-add">
        {W.add}
      </Button>
      {adding ? <AddProfileDialog onClose={() => setAdding(false)} onAdded={reload} /> : null}
      {dialog}
    </section>
  );
}

function errorText(error: unknown): string {
  const body = error instanceof ApiError ? (error.body as { message?: unknown } | null) : null;
  return typeof body?.message === 'string' && body.message ? body.message : W.failed;
}

function colorOptions() {
  return USER_PROFILE_COLORS.map((color) => ({ value: color, label: color[0]!.toUpperCase() + color.slice(1) }));
}

function ProfileRow({ profile, active, onSwitch, onChanged }: { readonly profile: UserProfile; readonly active: boolean; readonly onSwitch: () => void; readonly onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <li className="v2-profile-row" data-testid="v2-profile-row" data-profile={profile.id} data-active={active ? 'true' : undefined}>
      <ProfileDot color={profile.color} />
      <span className="v2-grow">
        <b>{profile.name}</b>
        {active ? <span className="v2-chip-mini">{W.active}</span> : null}
        {profile.hasPassword ? <span className="v2-chip-mini">{W.locked}</span> : null}
      </span>
      {!active ? (
        <Button size="sm" onClick={onSwitch} data-testid="v2-profile-switch">
          {W.switchAction}
        </Button>
      ) : null}
      <Button size="sm" onClick={() => setEditing(true)} data-testid="v2-profile-edit">
        {W.rename}
      </Button>
      {!profile.isDefault ? (
        <Button size="sm" variant="danger" onClick={() => setDeleting(true)} data-testid="v2-profile-delete">
          {W.delete}
        </Button>
      ) : null}
      {editing ? <EditProfileDialog profile={profile} active={active} onClose={() => setEditing(false)} onChanged={onChanged} /> : null}
      {deleting ? <DeleteProfileDialog profile={profile} onClose={() => setDeleting(false)} onChanged={onChanged} /> : null}
    </li>
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
