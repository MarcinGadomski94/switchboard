import { useState } from 'react';
import type { Folder, SolutionGroup } from '../../../core/api.ts';
import { ApiError, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { AddFolderPanel } from '../../folders/AddFolderPanel.tsx';
import { FOLDER_KIND_LABEL, defaultFolder, folderById, folderCheckLine, folderRefusal } from '../../folders/folders.ts';
import { announceFoldersChanged, useSavedFolders } from '../../folders/useFolders.ts';
import { scanRows } from './model.ts';
import { Action, Row, SectionTitle } from './rows.tsx';

/** A refused folder call as a sentence: `Not removed: <the server's reason>`. */
function refusal(verb: string, error: unknown): string {
  const reason = error instanceof ApiError ? folderRefusal(error.status, error.body) : String(error);
  return `${verb}: ${reason}`;
}

function FolderRow({
  folder,
  selected,
  busy,
  onSelect,
  onDefault,
  onRemove,
}: {
  readonly folder: Folder;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly onSelect: () => void;
  readonly onDefault: () => void;
  readonly onRemove: () => void;
}) {
  const line = folderCheckLine(folder.check);
  return (
    <div
      className="sb-set-row sb-set-folder"
      data-row="folder"
      data-testid="settings-folder"
      data-folder-id={folder.id}
      data-kind={folder.kind}
      data-default={folder.isDefault ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
    >
      <div
        className="sb-set-row-text sb-set-folder-text"
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        title="Show its solutions below"
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect();
          }
        }}
      >
        <div className="sb-set-row-label sb-set-folder-label">
          <span className="sb-set-folder-name" data-testid="settings-folder-name">
            {folder.name}
          </span>
          <span className="sb-set-folder-kind" data-testid="settings-folder-kind">
            {FOLDER_KIND_LABEL[folder.kind]}
          </span>
          {folder.isDefault ? (
            <span className="sb-set-folder-default" data-testid="settings-folder-default">
              default
            </span>
          ) : null}
        </div>
        <div className="sb-set-row-desc" data-mono="" data-testid="settings-folder-path">
          {folder.path}
        </div>
        {line ? (
          <div className="sb-set-folder-check" data-testid="settings-folder-check" data-ok={String(line.ok)}>
            {line.text}
          </div>
        ) : null}
      </div>
      <div className="sb-set-folder-actions">
        {folder.isDefault ? null : (
          <button type="button" className="sb-set-action" data-testid="settings-folder-make-default" disabled={busy} onClick={onDefault}>
            Make default
          </button>
        )}
        <button type="button" className="sb-set-action" data-testid="settings-folder-remove" disabled={busy} onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

/**
 * Folders (D14; the M8.2 "Workspace & solutions" section): the saved folders, each
 * with its kind, path and live check line (`✓ AGENTS.md (Workspace Router) · 38
 * solutions`, `✓ git repo · single solution`, or what is wrong), the **default**
 * marker and **Make default**, **Remove** (refused while a schedule starts its
 * runs there), and **Add…** (the setup wizard's folder picker: `POST
 * /api/folders`; a refused folder is not added). Below, the scan table of the
 * default folder, or of the folder clicked in the list, with Rescan (M8.2: the
 * scanner reads the router's rules on every request).
 */
export function WorkspaceSection() {
  const folders = useSavedFolders();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = folders.data ?? [];
  const shown = folderById(list, selectedId) ?? defaultFolder(list);

  const change = async (verb: string, call: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await call();
      announceFoldersChanged();
    } catch (caught) {
      setError(refusal(verb, caught));
      folders.reload();
    } finally {
      setBusy(false);
    }
  };

  const remove = (folder: Folder): void => {
    if (!window.confirm(`Remove ${folder.path} from Switchboard? Only the entry is removed: the folder and its sessions stay.`)) return;
    if (selectedId === folder.id) setSelectedId(null);
    void change('Not removed', () => api.removeFolder(folder.id));
  };

  return (
    <>
      <SectionTitle withLede>Folders</SectionTitle>
      <div className="sb-set-lede">Workspaces (a folder with your router AGENTS.md) and git repositories that sessions start in. The default is used when nothing names a folder.</div>
      <div className="sb-set-folders" data-testid="settings-folders">
        {list.map((folder) => (
          <FolderRow
            key={folder.id}
            folder={folder}
            selected={shown?.id === folder.id}
            busy={busy}
            onSelect={() => setSelectedId(folder.id)}
            onDefault={() => void change('Not changed', () => api.setDefaultFolder(folder.id))}
            onRemove={() => remove(folder)}
          />
        ))}
        {folders.data && list.length === 0 ? (
          <div className="sb-set-note" data-testid="settings-folders-empty">
            No folder is saved yet. Add a workspace or a git repository.
          </div>
        ) : null}
        {!folders.data && folders.error ? (
          <div className="sb-set-note sb-set-error" data-testid="settings-folders-empty">
            The folders could not be loaded.
          </div>
        ) : null}
      </div>
      {error ? (
        <div className="sb-set-note sb-set-error" role="alert" data-testid="settings-folders-error">
          {error}
        </div>
      ) : null}
      {adding ? (
        <div className="sb-set-folder-add">
          <AddFolderPanel
            testId="settings-folder-add"
            onAdded={(folder) => {
              setAdding(false);
              setSelectedId(folder.id);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : (
        <div className="sb-set-actions">
          <button type="button" className="sb-set-button" data-testid="settings-folder-add" onClick={() => setAdding(true)}>
            Add…
          </button>
        </div>
      )}
      {shown ? <FolderScan key={shown.id} folder={shown} /> : null}
    </>
  );
}

/** The scan table of one saved folder (`GET /api/solutions?folder=`), with Rescan. */
function FolderScan({ folder }: { readonly folder: Folder }) {
  const solutions = useApi((): Promise<SolutionGroup[]> => api.solutions(folder.id), [folder.id]);
  const rows = solutions.data ? scanRows(solutions.data, [folder.canonicalPath, folder.path]) : [];
  const errorCode = (solutions.error?.body as { error?: unknown } | null | undefined)?.error;
  let note: string | null = null;
  if (solutions.data && rows.length === 0) note = 'No solutions found.';
  else if (!solutions.data && solutions.error) note = errorCode === 'folder-missing' ? 'The folder is not there any more.' : 'The scan could not be loaded.';
  return (
    <div className="sb-set-folder-scan" data-testid="settings-folder-scan" data-folder-id={folder.id}>
      <Row id="workspace-root" label={`Solutions in ${folder.name}`} mono description={folder.path}>
        <Action testId="settings-rescan" onClick={solutions.reload}>
          Rescan
        </Action>
      </Row>
      {rows.length > 0 ? (
        <div className="sb-set-scan" data-testid="settings-scan">
          {rows.map((row) => (
            <div key={row.folder} className="sb-set-scan-row" data-folder={row.folder}>
              <span className="sb-set-scan-folder">{row.folder}</span>
              <span className="sb-set-scan-count">{row.count}</span>
              <span className="sb-set-scan-examples" title={row.examples}>
                {row.examples}
              </span>
              <span className="sb-set-scan-rule" data-rule={row.rule}>
                {row.ruleLabel}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {note ? (
        <div className="sb-set-note" data-testid="settings-note">
          {note}
        </div>
      ) : null}
    </div>
  );
}
