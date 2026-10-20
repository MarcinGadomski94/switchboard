import { useEffect, useMemo, useState } from 'react';
import type { Folder, ModelSettings } from '../../../core/api.ts';
import { DEFAULT_MODEL_CHOICE, type ModelChoice } from '../../../core/model-choice.ts';
import type { CliProviderId } from '../../../core/cli-providers.ts';
import { machineTagSuffix } from '../../../core/peers.ts';
import { type ApiError, api, machineApi } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { AccountPicker } from '../../components/AccountPicker.tsx';
import { CliPicker } from '../../components/CliPicker.tsx';
import { effectiveCli } from '../../components/cli.ts';
import { AddFolderPanel } from '../../folders/AddFolderPanel.tsx';
import { defaultFolder, folderById, folderCheckLine } from '../../folders/folders.ts';
import { useSavedFolders } from '../../folders/useFolders.ts';
import { NO_MODEL_SETTINGS, folderChoices, formModel, formModelOptions, formModelPicker, pickFormEffort, pickFormModel, resolveFormFolder } from '../../modals/new-session.ts';
import { ModelChoicePicker } from '../../views/session/ModelPicker.tsx';
import { defaultPlanSidebarFolder, planSidebarFolderProblem } from '../../../core/plans-jira.ts';
import { folderDepth } from '../../../core/sidebar-layout.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { useSidebarLayout } from '../../shell/SidebarSessions.tsx';
import { type JiraImportPlace, sidebarChoiceKey } from './place.ts';

/** What the section resolved: the folder as saved on that machine, the CLI and the model choice the session starts with. */
export interface ResolvedPlace {
  readonly folder: Folder | null;
  readonly provider: CliProviderId;
  readonly model: ModelChoice | null;
  /** `true` once that machine's folders are known (or could not be read). */
  readonly ready: boolean;
}

/**
 * D112 · **Where it runs** in the Import from Jira dialog: the machine (with a paired machine),
 * the folder (that machine's saved folders, Browse… on this one), the CLI and account, the model
 * and effort. The same data and pickers as the New-session form (D14 / D48 / D62 / D63 / D42:
 * `folderChoices`, `folderCheckLine`, `AddFolderPanel`, `CliPicker`, `AccountPicker`,
 * `ModelChoicePicker`). The session the import starts runs there.
 */
export function WhereItRuns({
  place,
  onChange,
  onResolved,
  onSidebar,
  disabled = false,
}: {
  readonly place: JiraImportPlace;
  readonly onChange: (patch: Partial<JiraImportPlace>) => void;
  readonly onResolved: (resolved: ResolvedPlace) => void;
  /** D119: the sidebar folder picked (or suggested) for the plan's own subfolder. */
  readonly onSidebar: (sidebarFolderId: string | null) => void;
  readonly disabled?: boolean;
}) {
  const machine = place.machine;
  const machines = useApi(() => api.machines().catch(() => null), []);
  const peers = machines.data?.machines ?? [];
  const localFolders = useSavedFolders();
  const peerFolders = useApi(
    (): Promise<{ readonly machine: string; readonly list: Folder[] } | null> => (machine ? machineApi(machine).savedFolders().then((list) => ({ machine, list })) : Promise.resolve(null)),
    [machine],
  );
  const folders: { readonly data: Folder[] | null; readonly error: ApiError | null } = machine
    ? { data: peerFolders.data?.machine === machine ? peerFolders.data.list : null, error: peerFolders.error }
    : localFolders;
  const [adding, setAdding] = useState(false);
  const clis = useApi(() => machineApi(machine).clis().catch(() => null), [machine]);
  const provider = effectiveCli(place.provider, clis.data ?? null);
  const models = useApi(() => machineApi(machine).models(provider).then((settings) => ({ provider, settings })), [machine, provider]);
  const modelSettings: ModelSettings | null = models.data?.provider === provider ? models.data.settings : models.error ? NO_MODEL_SETTINGS : null;
  const form = { model: place.model };
  const choice = formModel(form, modelSettings, provider);

  // The remembered folder while it is still saved there, else that machine's default (as the New-session form does).
  const list = folders.data;
  useEffect(() => {
    if (!list) return;
    const resolved = resolveFormFolder(place.folder, list);
    if (resolved !== place.folder) onChange({ folder: resolved });
  }, [list, place.folder, onChange]);
  const folder = folderById(list, place.folder) ?? (place.folder ? null : defaultFolder(list));
  const ready = list !== null || folders.error !== null;
  const folderId = folder?.id ?? null;
  const modelKey = choice ? `${choice.model ?? ''}|${choice.effort ?? ''}` : '';
  useEffect(() => {
    onResolved({ folder, provider, model: choice, ready });
    // `folder` and `choice` are compared by what they name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, folder?.kind, provider, modelKey, ready, onResolved]);

  // D119: the sidebar folder the plan's own subfolder "Plan · …" goes into. This machine's layout (the one the
  // developer sees; the shared one when D71 sharing is on), also for a plan on a paired machine: its session is
  // placed here by its remote id. The default follows the working folder until the developer picks one by hand.
  const { layout } = useSidebarLayout();
  const listed = useSessionListOf();
  const [pickedSidebar, setPickedSidebar] = useState<{ readonly id: string | null } | null>(null);
  const lastSidebar = folderId ? place.sidebarFolders[sidebarChoiceKey(machine, folderId)] : undefined;
  const suggestedSidebar = useMemo(
    () => defaultPlanSidebarFolder({ layout, sessions: listed.data ?? [], machine, workingFolder: folder ? { id: folder.id, path: folder.canonicalPath } : null, lastChoice: lastSidebar }),
    // `folder` is compared by what it names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, listed.data, machine, folderId, folder?.canonicalPath, lastSidebar],
  );
  const sidebarFolderId = pickedSidebar !== null && (pickedSidebar.id === null || planSidebarFolderProblem(layout, pickedSidebar.id) === null) ? pickedSidebar.id : suggestedSidebar;
  useEffect(() => {
    onSidebar(sidebarFolderId);
  }, [sidebarFolderId, onSidebar]);

  const choices = folderChoices(list ?? []);
  const checkLine = folderCheckLine(folder?.check ?? null);
  return (
    <section className="sb-jira-form sb-jira-where" data-testid="jira-where">
      <h3>Where it runs</h3>
      <p className="sb-jira-muted">A new session starts in this folder and owns the plan: the epic's tickets become its todos, and their runs start next to it.</p>
      {peers.length > 0 ? (
        <label className="sb-jira-field">
          <span>Machine</span>
          <select
            data-testid="jira-where-machine"
            value={machine ?? ''}
            disabled={disabled}
            onChange={(event) => {
              setAdding(false);
              // The folders, CLIs and accounts belong to a machine: nothing carries over.
              onChange({ machine: event.target.value === '' ? null : event.target.value, folder: null, provider: null, model: null, profileId: null, repos: [] });
            }}
          >
            <option value="">{`This machine${machines.data ? ` (${machines.data.self.name})` : ''}`}</option>
            {peers.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={entry.state !== 'online' && entry.state !== 'reconnecting'}>
                {entry.state === 'online' ? entry.name : `${entry.name} (${machineTagSuffix(entry.state) ?? entry.state})`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="sb-jira-field">
        <span>Folder</span>
        <div className="sb-jira-row">
          <select
            data-testid="jira-where-folder"
            aria-label="Folder"
            value={place.folder ?? ''}
            disabled={disabled || choices.length === 0}
            title={folder?.path}
            onChange={(event) => onChange({ folder: event.target.value, repos: [] })}
          >
            {choices.length === 0 ? <option value="">{list ? 'No folder saved yet' : 'Loading folders…'}</option> : null}
            {choices.map((entry) => (
              <option key={entry.id} value={entry.id} title={entry.path}>
                {entry.label}
              </option>
            ))}
          </select>
          {machine ? null : (
            <button type="button" className="sb-jira-btn" data-testid="jira-where-browse" aria-expanded={adding} disabled={disabled} onClick={() => setAdding((open) => !open)}>
              Browse…
            </button>
          )}
          {checkLine ? (
            <span className="sb-jira-muted" data-testid="jira-where-check" data-ok={String(checkLine.ok)}>
              {checkLine.text}
            </span>
          ) : null}
        </div>
        {adding ? (
          <AddFolderPanel
            testId="jira-where-add"
            onAdded={(added) => {
              setAdding(false);
              onChange({ folder: added.id, repos: [] });
            }}
            onCancel={() => setAdding(false)}
          />
        ) : null}
        {folder?.kind === 'plain' ? <em className="sb-jira-error">A plan merges into a target branch: pick a git repository or a workspace.</em> : null}
      </div>
      <label className="sb-jira-field">
        <span>Sidebar folder</span>
        <select
          data-testid="jira-where-sidebar"
          value={sidebarFolderId ?? ''}
          disabled={disabled}
          onChange={(event) => setPickedSidebar({ id: event.target.value === '' ? null : event.target.value })}
        >
          <option value="">Sidebar root</option>
          {layout.folders.map((entry) => {
            const full = planSidebarFolderProblem(layout, entry.id) !== null;
            return (
              <option key={entry.id} value={entry.id} disabled={full} title={full ? 'Too deep for one more folder' : entry.name}>
                {`${'\u00a0\u00a0\u00a0'.repeat(Math.max(0, folderDepth(layout, entry.id) - 1))}${entry.name}`}
              </option>
            );
          })}
        </select>
        <em className="sb-jira-muted">The plan gets its own subfolder here, with the session first; its runs start next to it.</em>
      </label>
      <div className="sb-jira-row">
        <div className="sb-jira-field">
          <span>CLI</span>
          <span className="sb-cli-picker-group">
            <CliPicker testId="jira-where-cli" value={provider} overview={clis.data ?? null} disabled={disabled} onPick={(next) => onChange({ provider: next, model: null, profileId: null })} />
            <AccountPicker machine={machine} provider={provider} value={place.profileId} onPick={(profileId) => onChange({ profileId })} testId="jira-where-account" disabled={disabled} />
          </span>
        </div>
        <div className="sb-jira-field">
          <span>Model</span>
          <ModelChoicePicker
            testId="jira-where-model"
            picker={formModelPicker(form, modelSettings, provider)}
            keepEscape
            onPickModel={(value) => onChange({ model: pickFormModel(choice ?? DEFAULT_MODEL_CHOICE, formModelOptions(modelSettings, provider), value) })}
            onPickEffort={(value) => onChange({ model: pickFormEffort(choice ?? DEFAULT_MODEL_CHOICE, value) })}
          />
        </div>
      </div>
    </section>
  );
}
