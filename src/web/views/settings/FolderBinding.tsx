import { useEffect, useState } from 'react';
import type { Folder, FolderBindPreview } from '../../../core/api.ts';
import type { UserProfile } from '../../../core/user-profiles.ts';
import { ApiError, api } from '../../api/client.ts';
import { announceFoldersChanged } from '../../folders/useFolders.ts';

/** A refused bind as a sentence: the server's message, else a short fallback. */
function refusalText(error: unknown): string {
  const body = error instanceof ApiError ? (error.body as { message?: unknown } | null) : null;
  return typeof body?.message === 'string' && body.message ? body.message : 'It didn’t work. Try again.';
}

/**
 * D169 · a saved folder's binding to a profile (`docs/profiles.md` → *A folder bound to a profile*),
 * inline in its Settings row (both themes): pick the profile (its password when it has one), see
 * which agents and schedules of other profiles move to it, then **Bind**; or, for a bound folder,
 * **Unbind** (the owner's password when it has one). The other profiles stop seeing the folder.
 */
export function FolderBinding({ folder, profiles, onDone }: { readonly folder: Folder; readonly profiles: readonly UserProfile[]; readonly onDone: () => void }) {
  const owner = folder.userProfileId ? (profiles.find((profile) => profile.id === folder.userProfileId) ?? null) : null;
  const [to, setTo] = useState<string>(folder.userProfileId ?? profiles[0]?.id ?? '');
  const [password, setPassword] = useState('');
  const [preview, setPreview] = useState<FolderBindPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = profiles.find((profile) => profile.id === to) ?? null;
  useEffect(() => {
    if (!to || to === folder.userProfileId) {
      setPreview(null);
      return;
    }
    let live = true;
    api.folderBindPreview(folder.id, to).then(
      (answer) => live && setPreview(answer),
      () => live && setPreview(null),
    );
    return () => {
      live = false;
    };
  }, [folder.id, folder.userProfileId, to]);
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      announceFoldersChanged();
      onDone();
    } catch (caught) {
      setError(refusalText(caught));
      setBusy(false);
    }
  };
  const moving = preview ? preview.agents.length : 0;
  const needsPassword = owner ? owner.hasPassword : (target?.hasPassword ?? false);
  return (
    <div className="sb-set-folder-bind" data-testid="settings-folder-bind" data-folder-id={folder.id}>
      {owner ? (
        <div className="sb-set-row-desc" data-testid="settings-folder-bind-owner">
          Bound to <b>{owner.name}</b>: the other profiles don’t see this folder. Unbind to share it with every profile again.
        </div>
      ) : (
        <>
          <label className="sb-set-row-desc">
            Bind to{' '}
            <select data-testid="settings-folder-bind-profile" value={to} disabled={busy} onChange={(event) => setTo(event.target.value)}>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <div className="sb-set-row-desc" data-testid="settings-folder-bind-preview">
            {preview === null
              ? 'Only this profile will see this folder and start agents in it.'
              : moving === 0 && preview.schedules.length === 0
                ? 'No agent of another profile works here. Only this profile will see this folder.'
                : `These ${moving} agent${moving === 1 ? '' : 's'}${preview.schedules.length > 0 ? ` and ${preview.schedules.length} schedule${preview.schedules.length === 1 ? '' : 's'}` : ''} move to ${target?.name ?? 'it'}: ${[...preview.agents.map((agent) => agent.title), ...preview.schedules.map((schedule) => schedule.name)].join(', ')}.`}
          </div>
        </>
      )}
      {needsPassword ? (
        <input
          type="password"
          className="sb-set-folder-rename"
          data-testid="settings-folder-bind-password"
          autoComplete="current-password"
          placeholder={`Password of ${owner?.name ?? target?.name ?? 'the profile'}`}
          aria-label={`Password of ${owner?.name ?? target?.name ?? 'the profile'}`}
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      ) : null}
      <div className="sb-set-folder-actions">
        {owner ? (
          <button type="button" className="sb-set-action" data-testid="settings-folder-unbind-go" disabled={busy || (needsPassword && password === '')} onClick={() => void run(() => api.bindFolder(folder.id, null, password || undefined))}>
            Unbind
          </button>
        ) : (
          <button type="button" className="sb-set-action" data-testid="settings-folder-bind-go" disabled={busy || !to || (needsPassword && password === '')} onClick={() => void run(() => api.bindFolder(folder.id, to, password || undefined))}>
            Bind
          </button>
        )}
        <button type="button" className="sb-set-action" data-testid="settings-folder-bind-cancel" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
      {error ? (
        <div className="sb-set-folder-rename-error" role="alert" data-testid="settings-folder-bind-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}
