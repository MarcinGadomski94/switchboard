import { type ReactElement, useMemo, useState } from 'react';
import type { UserProfile, UserProfilesView } from '../../../core/user-profiles.ts';
import { ApiError, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { Button, Dialog, Field, Icon, Menu, type MenuItem, Select, useToast } from '../components/index.ts';
import { PROFILE_WORDS as W } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';

/**
 * D165 · Profiles in v2 (`docs/profiles.md`): many profiles on one Switchboard. The rail's
 * switcher (a menu of every profile, the active one marked, each with its colour dot; a password
 * prompt for a locked one; the page reloads in the new profile), the password prompt itself, and
 * the agent's "Move to profile…" dialog. Settings → Profiles is `settings/ProfilesSection.tsx`.
 */

/** The profiles and this browser's active one, live (`userProfilesChanged`). */
export function useUserProfiles(): { readonly view: UserProfilesView | null; readonly reload: () => void } {
  const answer = useApi(api.userProfiles);
  useHubEvent('userProfilesChanged', () => answer.reload());
  return { view: (answer.data as UserProfilesView | null) ?? null, reload: answer.reload };
}

/** The colour dot of a profile (its colour as a CSS custom property `--v2-profile-<colour>`). */
export function ProfileDot({ color }: { readonly color: string }) {
  return <span className="v2-profile-dot" data-color={color} aria-hidden="true" />;
}

function errorText(error: unknown): string {
  const body = error instanceof ApiError ? (error.body as { message?: unknown } | null) : null;
  return typeof body?.message === 'string' && body.message ? body.message : error instanceof Error ? error.message : W.failed;
}

/** Switches this browser to `profile` (asking its password when it has one) and reloads the page in it. */
export function useSwitchProfile(): { readonly ask: (profile: UserProfile) => void; readonly dialog: ReactElement | null } {
  const [locked, setLocked] = useState<UserProfile | null>(null);
  const go = async (profile: UserProfile, password?: string): Promise<void> => {
    await api.switchUserProfile(profile.id, password);
    // A new profile: every list, the hub and the caches start again in it.
    window.location.reload();
  };
  const ask = (profile: UserProfile): void => {
    if (profile.hasPassword) setLocked(profile);
    else void go(profile).catch(() => setLocked(profile));
  };
  const dialog = locked ? <PasswordDialog title={W.switchTitle(locked.name)} action={W.switchAction} onClose={() => setLocked(null)} onSubmit={(password) => go(locked, password)} /> : null;
  return { ask, dialog };
}

/** A password prompt: `onSubmit` throws a refusal, shown under the field. */
export function PasswordDialog({ title, action, onClose, onSubmit }: { readonly title: string; readonly action: string; readonly onClose: () => void; readonly onSubmit: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password);
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      icon="shield"
      testId="v2-profile-password"
      footer={
        <>
          <Button onClick={onClose}>{W.cancel}</Button>
          <Button variant="primary" disabled={!password || busy} onClick={() => void submit()} data-testid="v2-profile-password-go">
            {action}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={W.password} type="password" autoFocus autoComplete="current-password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} error={error} data-testid="v2-profile-password-input" />
      </form>
    </Dialog>
  );
}

/**
 * The rail's switcher: the active profile (its dot and name; "Choose a profile" when none is
 * chosen yet, a locked Default), and a menu of every profile (it scrolls past a screenful, the
 * keyboard moves through it, the active one is checked), then Manage profiles…. D173: only the
 * profiles allowed on this computer.
 */
export function ProfileSwitcher() {
  const { view } = useUserProfiles();
  const { navigate } = useV2Router();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const { ask, dialog } = useSwitchProfile();
  const active = view?.profiles.find((profile) => profile.id === view.activeId) ?? null;
  const items: MenuItem[] = useMemo(
    () => [
      // D173: a profile an admin did not allow on this computer can't be switched to here.
      ...(view?.profiles ?? []).filter((profile) => profile.allowedHere !== false).map(
        (profile): MenuItem => ({
          id: `profile-${profile.id}`,
          label: `${profile.name}${profile.hasPassword ? ' 🔒' : ''}`,
          icon: profile.id === view?.activeId ? 'check' : 'dot',
          onSelect: () => {
            if (profile.id !== view?.activeId) ask(profile);
          },
        }),
      ),
      { separator: true, id: 'sep-manage' },
      { id: 'manage', label: W.manage, icon: 'settings', onSelect: () => navigate('/settings/profiles') },
    ],
    [view, ask, navigate],
  );
  if (!view) return null;
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className="v2-profile-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={active ? W.switcherLabel(active.name) : W.choose}
        onClick={() => setOpen((value) => !value)}
        data-testid="v2-profile-switcher"
        data-tour="v2-profile-switcher"
        data-active={active?.id ?? ''}
      >
        {active ? <ProfileDot color={active.color} /> : <Icon name="agents" size="s" />}
        <span className="v2-profile-name">{active ? active.name : W.choose}</span>
        <Icon name="chev-down" size="s" />
      </button>
      <Menu items={items} anchor={anchor} open={open} onClose={() => setOpen(false)} label={W.menuLabel} align="start" testId="v2-profile-menu" />
      {dialog}
    </>
  );
}

/** The agent's ⋯ → Move to profile…: pick a profile (its password when it has one). */
export function MoveToProfileDialog({ sessionId, title, currentId, onClose }: { readonly sessionId: string; readonly title: string; readonly currentId: string | null; readonly onClose: () => void }) {
  const { view } = useUserProfiles();
  const toast = useToast();
  const others = (view?.profiles ?? []).filter((profile) => profile.id !== currentId);
  const [target, setTarget] = useState<string>('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = others.find((profile) => profile.id === (target || others[0]?.id)) ?? null;
  const move = async (): Promise<void> => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await api.moveToUserProfile(sessionId, chosen.id, chosen.hasPassword ? password : undefined);
      toast({ text: W.moved(title, chosen.name) });
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
      title={W.moveTitle(title)}
      icon="agents"
      testId="v2-move-profile"
      footer={
        <>
          <Button onClick={onClose}>{W.cancel}</Button>
          <Button variant="primary" disabled={!chosen || busy || (chosen.hasPassword && !password)} onClick={() => void move()} data-testid="v2-move-profile-go">
            {W.moveAction}
          </Button>
        </>
      }
    >
      {others.length === 0 ? (
        <p className="v2-muted">{W.noOther}</p>
      ) : (
        <>
          <p className="v2-muted">{W.moveHint}</p>
          <Select label={W.profile} value={chosen?.id ?? ''} options={others.map((profile) => ({ value: profile.id, label: profile.name }))} onChange={(event) => setTarget(event.currentTarget.value)} data-testid="v2-move-profile-select" />
          {chosen?.hasPassword ? <Field label={W.passwordOf(chosen.name)} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} data-testid="v2-move-profile-password" /> : null}
          {error ? (
            <p className="v2-field-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </Dialog>
  );
}
