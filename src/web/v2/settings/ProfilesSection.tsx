import { useEffect, useState } from 'react';
import { type GitHubBindingView, noreplyEmail } from '../../../core/github-binding.ts';
import { type OrphanProfile, USER_PROFILE_COLORS, type UserProfile } from '../../../core/user-profiles.ts';
import { ApiError, api, machineApi } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { Button, Card, Dialog, Field, Select, useToast } from '../components/index.ts';
import { PROFILE_WORDS as W } from '../glossary.ts';
import { ProfileDot, useSwitchProfile, useUserProfiles } from '../profiles/Profiles.tsx';
import { type KnownComputer, accessChanged, accessRows, accessSummary, knownComputers } from './access-model.ts';

/**
 * D165 · Settings → Profiles (`docs/profiles.md`): every profile (any number) with its colour,
 * whether it has a password and whether this browser works in it; add one; per profile rename,
 * colour, set / change / remove its password, its default account per CLI on this computer,
 * switch to it, delete it (its open agents are archived; Default stays). D173: its Admin chip and the
 * computers it may use; an admin (or the first admin, the bootstrap) changes them with *Computers…*.
 * D176: the checklist also lists the computers known only through a paired one; a computer it never
 * listed stays allowed.
 */
export function ProfilesSection() {
  const { view, reload } = useUserProfiles();
  const machines = useApi(api.machines);
  const actor = view?.profiles.find((profile) => profile.id === view.activeId) ?? null;
  const anyAdmin = (view?.profiles ?? []).some((profile) => profile.admin === true);
  const known = knownComputers(machines.data, view?.otherComputers);
  const { ask, dialog } = useSwitchProfile();
  const [adding, setAdding] = useState(false);
  return (
    <section className="v2-set-section" data-testid="v2-settings-profiles-section">
      <p className="v2-muted">{W.sectionIntro}</p>
      <p className="v2-muted v2-profile-note">{W.notSecurity}</p>
      <Card>
        <ul className="v2-profile-list" data-testid="v2-profile-list">
          {(view?.profiles ?? []).map((profile) => (
            <ProfileRow key={profile.id} profile={profile} all={view?.profiles ?? []} active={profile.id === view?.activeId} actor={actor} anyAdmin={anyAdmin} known={known} onSwitch={() => ask(profile)} onChanged={reload} />
          ))}
        </ul>
      </Card>
      <Button icon="plus" onClick={() => setAdding(true)} data-testid="v2-profile-add">
        {W.add}
      </Button>
      {view?.startId !== undefined ? <StartProfileSelect profiles={view.profiles} startId={view.startId} onChanged={reload} /> : null}
      {view?.orphans && view.orphans.length > 0 ? <OrphanProfiles orphans={view.orphans} profiles={view.profiles} onChanged={reload} /> : null}
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

/**
 * D179 follow-up (2026-11-23): agents left on a removed profile that has no live successor (no merge,
 * no single live profile of the same name): they stay where they are until moved here, never to
 * Default by themselves.
 */
function OrphanProfiles({ orphans, profiles, onChanged }: { readonly orphans: readonly OrphanProfile[]; readonly profiles: readonly UserProfile[]; readonly onChanged: () => void }) {
  return (
    <Card pad data-testid="v2-profile-orphans">
      <h3>{W.orphansTitle}</h3>
      <p className="v2-muted">{W.orphansSub}</p>
      {orphans.map((orphan) => (
        <OrphanRow key={orphan.id} orphan={orphan} profiles={profiles} onChanged={onChanged} />
      ))}
    </Card>
  );
}

function OrphanRow({ orphan, profiles, onChanged }: { readonly orphan: OrphanProfile; readonly profiles: readonly UserProfile[]; readonly onChanged: () => void }) {
  const toast = useToast();
  const [to, setTo] = useState(profiles[0]?.id ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const target = profiles.find((profile) => profile.id === to) ?? null;
  const move = (): void => {
    if (!target) return;
    setBusy(true);
    api.moveOrphanProfile(orphan.id, target.id, password || undefined).then(
      (answer) => {
        toast({ text: W.orphanMoved(answer.moved, target.name) });
        onChanged();
      },
      (caught: unknown) => {
        setBusy(false);
        toast({ text: errorText(caught), tone: 'error' });
      },
    );
  };
  return (
    <div className="v2-set-row" data-testid="v2-profile-orphan" data-profile-id={orphan.id}>
      <span className="v2-grow">
        <b>{orphan.name}</b> <span className="v2-muted">· {W.orphanCount(orphan.sessions)}</span>
      </span>
      <Select label={W.orphanMoveTo} value={to} options={profiles.map((profile) => ({ value: profile.id, label: profile.name }))} onChange={(event) => setTo(event.currentTarget.value)} data-testid="v2-profile-orphan-to" />
      {target?.hasPassword ? <Field label={W.orphanPassword(target.name)} type="password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} data-testid="v2-profile-orphan-password" /> : null}
      <Button variant="primary" disabled={busy || !target} onClick={move} data-testid="v2-profile-orphan-move">
        {W.orphanMove}
      </Button>
    </div>
  );
}

function errorText(error: unknown): string {
  const body = error instanceof ApiError ? (error.body as { message?: unknown } | null) : null;
  return typeof body?.message === 'string' && body.message ? body.message : W.failed;
}

function colorOptions() {
  return USER_PROFILE_COLORS.map((color) => ({ value: color, label: color[0]!.toUpperCase() + color.slice(1) }));
}

/** D173 / D176: the row's summary of the computers a profile may use. */
function computersText(profile: UserProfile, known: readonly KnownComputer[]): string {
  const summary = accessSummary(profile, known, W.thisComputer);
  return summary.kind === 'all' ? W.allComputers : summary.kind === 'not-on' ? W.notOnSummary(summary.names) : W.computersSummary(summary.names);
}

interface RowProps {
  readonly profile: UserProfile;
  readonly all: readonly UserProfile[];
  readonly active: boolean;
  /** D173: this browser's profile (`null`: none chosen). */
  readonly actor: UserProfile | null;
  readonly anyAdmin: boolean;
  /** D173 / D176: this computer, the paired ones and the ones known through them. */
  readonly known: readonly KnownComputer[];
  readonly onSwitch: () => void;
  readonly onChanged: () => void;
}

function ProfileRow({ profile, all, active, actor, anyAdmin, known, onSwitch, onChanged }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [access, setAccess] = useState(false);
  const [github, setGitHub] = useState(false);
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
        {profile.github ? (
          <span className="v2-chip-mini" data-testid="v2-profile-github-chip">
            {W.githubChip(profile.github.login)}
          </span>
        ) : null}
        {profile.computers !== undefined ? (
          <span className="v2-muted v2-profile-computers" data-testid="v2-profile-computers" data-tour="v2-profile-access">
            {' '}
            · {computersText(profile, known)}
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
      <Button size="sm" onClick={() => setGitHub(true)} data-testid="v2-profile-github" data-tour="v2-profile-github">
        {profile.github ? W.github : W.githubConnect}
      </Button>
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
      {github ? <GitHubDialog profile={profile} active={active} onClose={() => setGitHub(false)} onChanged={onChanged} /> : null}
      {deleting ? <DeleteProfileDialog profile={profile} onClose={() => setDeleting(false)} onChanged={onChanged} /> : null}
      {access && actor ? <AccessDialog profile={profile} actor={actor} bootstrap={bootstrap && actor.admin !== true} known={known} onClose={() => setAccess(false)} onChanged={onChanged} /> : null}
    </li>
  );
}

/**
 * D173 · *Computers…*: whether the profile is an admin and which computers it may use (all, or a
 * checklist of this computer and the paired ones). The admin's (this browser's profile's) password
 * confirms. The bootstrap (no admin yet): only *Admin*, for this browser's own profile. D176: the
 * checklist lists the computers known only through a paired one too ("through …"); one the list was
 * never decided for shows "not decided yet: allowed" (ticked) until saved; one not listed at all stays allowed.
 */
function AccessDialog({ profile, actor, bootstrap, known, onClose, onChanged }: { readonly profile: UserProfile; readonly actor: UserProfile; readonly bootstrap: boolean; readonly known: readonly KnownComputer[]; readonly onClose: () => void; readonly onChanged: () => void }) {
  const toast = useToast();
  const rows = accessRows(profile, known);
  const [admin, setAdmin] = useState(profile.admin === true || bootstrap);
  const [all, setAll] = useState(profile.computers === null || profile.computers === undefined);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(rows.filter((row) => row.checked && profile.computers !== null && profile.computers !== undefined).map((row) => row.id)));
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** D176: rows ticked or unticked in this dialog (an undecided one stops saying so). */
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const sameAccess = !accessChanged(profile, rows, all, picked);
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (admin !== (profile.admin === true)) await api.setUserProfileAdmin(profile.id, admin, password);
      if (!bootstrap && !sameAccess) await api.setUserProfileAccess(profile.id, all ? 'all' : [...picked], password, rows.map((row) => row.id));
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
          {!all ? (
            <p className="v2-muted" data-testid="v2-profile-computers-note">
              {W.onlyTheseNote}
            </p>
          ) : null}
          {!all
            ? rows.map((choice) => (
                <label key={choice.id} className="v2-check v2-profile-computer" data-machine={choice.id} data-through={choice.through ?? undefined} data-undecided={choice.undecided && !touched.has(choice.id) ? 'true' : undefined}>
                  <input
                    type="checkbox"
                    checked={picked.has(choice.id)}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setTouched((now) => new Set(now).add(choice.id));
                      setPicked((now) => {
                        const next = new Set(now);
                        if (on) next.add(choice.id);
                        else next.delete(choice.id);
                        return next;
                      });
                    }}
                  />{' '}
                  {choice.self ? `${choice.name} (${W.thisComputer})` : choice.name}
                  {choice.through ? <span className="v2-muted"> · {W.through(choice.through)}</span> : null}
                  {choice.undecided && !touched.has(choice.id) ? <span className="v2-muted"> · {W.undecided}</span> : null}
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

/**
 * D190 · *Connect GitHub* / *GitHub…*: the profile's GitHub account. Connect runs gh's device-code
 * sign-in on this computer (the code and GitHub's page shown here, Cancel, a timeout); connected, it
 * shows the account and the commit author, the commit email, and Disconnect (signs out everywhere).
 * Another profile with a password needs that password.
 */
function GitHubDialog({ profile, active, onClose, onChanged }: { readonly profile: UserProfile; readonly active: boolean; readonly onClose: () => void; readonly onChanged: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: loaded, reload } = useApi(() => api.profileGitHub(profile.id), [profile.id]);
  const [view, setView] = useState<GitHubBindingView | null>(null);
  const current = view ?? loaded;
  const needPassword = profile.hasPassword && !active;
  const pw = needPassword ? password : undefined;
  const pending = current?.login?.state === 'starting' || current?.login?.state === 'waiting';

  // While gh waits for the developer, follow it once a second; tell how it ended.
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => {
      api.profileGitHub(profile.id).then(
        (next) => {
          setView(next);
          const state = next.login?.state;
          if (state === 'done' && next.identity) {
            toast({ text: W.githubDone(next.identity.login) });
            onChanged();
          } else if (state === 'failed') setError(W.githubFailed(next.login?.error ?? ''));
          else if (state === 'cancelled') setError(W.githubCancelled);
        },
        () => undefined,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [pending, profile.id, toast, onChanged]);

  const act = async (run: () => Promise<GitHubBindingView>, after?: (next: GitHubBindingView) => void): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await run();
      setView(next);
      after?.(next);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };
  const identity = current?.identity ?? null;
  const emailValue = email ?? identity?.email ?? '';
  const emailOrNull = emailValue.trim() === '' ? null : emailValue.trim();
  const code = current?.login?.code ?? null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={W.githubTitle(profile.name)}
      testId="v2-profile-github-dialog"
      footer={
        <>
          {pending ? (
            <Button disabled={busy} onClick={() => void act(() => api.cancelProfileGitHub(profile.id, pw))} data-testid="v2-profile-github-cancel">
              {W.cancel}
            </Button>
          ) : (
            <Button onClick={onClose}>{W.cancel}</Button>
          )}
          {identity && !pending ? (
            <Button
              variant="danger"
              disabled={busy || (needPassword && !password)}
              onClick={() =>
                void act(
                  () => api.disconnectProfileGitHub(profile.id, pw),
                  () => {
                    toast({ text: W.githubDisconnected(profile.name) });
                    onChanged();
                    reload();
                  },
                )
              }
              data-testid="v2-profile-github-disconnect"
            >
              {W.githubDisconnect}
            </Button>
          ) : null}
          {!pending ? (
            <Button
              variant="primary"
              disabled={busy || (needPassword && !password)}
              onClick={() => void act(() => api.connectProfileGitHub(profile.id, { ...(pw ? { password: pw } : {}), ...(emailOrNull ? { email: emailOrNull } : {}) }))}
              data-testid="v2-profile-github-start"
            >
              {identity ? W.githubConnect : W.githubStart}
            </Button>
          ) : null}
        </>
      }
    >
      <p>{W.githubIntro}</p>
      {identity ? (
        <div data-testid="v2-profile-github-connected">
          <p>
            <b>{W.githubConnected(identity.login)}</b>
            {current?.author ? <span className="v2-muted"> · {W.githubAuthor(current.author.name, current.author.email)}</span> : null}
          </p>
          {current && !current.signedInHere ? <p className="v2-muted">{W.githubNotHere}</p> : null}
          {current?.unsynced && current.unsynced.length > 0 ? (
            <p className="v2-muted" data-testid="v2-profile-github-older">
              {W.githubOlder(current.unsynced)}
            </p>
          ) : null}
        </div>
      ) : null}
      {pending ? (
        <div data-testid="v2-profile-github-code">
          {code ? (
            <>
              <p>{W.githubCode}</p>
              <p>
                <code data-testid="v2-profile-github-code-value">{code}</code>{' '}
                <Button size="sm" onClick={() => void navigator.clipboard?.writeText(code).catch(() => undefined)}>
                  {W.githubCopy}
                </Button>{' '}
                {current?.login?.url ? (
                  <a href={current.login.url} target="_blank" rel="noreferrer noopener" data-testid="v2-profile-github-link">
                    {W.githubOpen}
                  </a>
                ) : null}
              </p>
              <p className="v2-muted">{W.githubWaiting}</p>
            </>
          ) : (
            <p className="v2-muted">{W.githubStarting}</p>
          )}
        </div>
      ) : (
        <>
          <Field label={W.githubEmail} type="email" value={emailValue} onChange={(event) => setEmail(event.currentTarget.value)} data-testid="v2-profile-github-email" />
          <p className="v2-muted">{identity ? W.githubEmailHint(noreplyEmail(identity)) : W.githubEmailHintNew}</p>
          {identity && emailValue !== (identity.email ?? '') ? (
            <Button size="sm" disabled={busy || (needPassword && !password)} onClick={() => void act(() => api.setProfileGitHubEmail(profile.id, emailOrNull, pw), () => onChanged())} data-testid="v2-profile-github-save-email">
              {W.githubSaveEmail}
            </Button>
          ) : null}
          {needPassword ? <Field label={W.passwordOf(profile.name)} type="password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} data-testid="v2-profile-github-password" /> : null}
          <p className="v2-muted">{W.githubShared}</p>
          {identity ? <p className="v2-muted">{W.githubDisconnectNote}</p> : null}
        </>
      )}
      {error ? (
        <p className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
