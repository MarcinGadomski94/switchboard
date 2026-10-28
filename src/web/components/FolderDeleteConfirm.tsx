import { type KeyboardEvent, useState } from 'react';
import { createPortal } from 'react-dom';
import { CLOSE_CANCEL } from '../../core/session-close.ts';
import { type FolderArchiveListed, folderArchiveConfirm } from '../../core/sidebar-folder-archive.ts';
import './close-session.css';

/** Props of {@link FolderDeleteConfirm}. */
export interface FolderDeleteConfirmProps {
  readonly name: string;
  /** The sessions in the folder and its subfolders (at least one; an empty folder keeps the simple confirm). */
  readonly sessions: readonly FolderArchiveListed[];
  /** What happens to them when the box is unticked ("the sessions move to the top level"). */
  readonly moveNote: string;
  readonly onConfirm: (archive: boolean) => void;
  readonly onCancel: () => void;
}

/**
 * D141 · classic: deleting a sidebar folder that holds sessions (`docs/sidebar.md` →
 * *Delete a folder and archive its agents (D141)*). The D33 confirmation's look
 * (overlay, pill buttons); **Also archive the sessions in it** is ticked by default;
 * unticked, the delete is D54 / D58's (the sessions move out). Esc or a click on the
 * overlay cancels; Cancel has the focus.
 */
export function FolderDeleteConfirm({ name, sessions, moveNote, onConfirm, onCancel }: FolderDeleteConfirmProps) {
  const [archive, setArchive] = useState(true);
  const words = folderArchiveConfirm(name, sessions, archive, 'classic');
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
    }
  };
  return createPortal(
    <div className="sb-close-overlay" data-testid="folder-delete-overlay" onClick={onCancel} onKeyDown={onKeyDown}>
      <div className="sb-close-dialog" role="alertdialog" aria-modal="true" aria-labelledby="sb-folder-delete-text" data-testid="folder-delete-confirm" onClick={(event) => event.stopPropagation()}>
        <div className="sb-close-text" id="sb-folder-delete-text" data-testid="folder-delete-title">
          {words.title}
        </div>
        <label className="sb-folder-archive-check">
          <input type="checkbox" checked={archive} onChange={(event) => setArchive(event.target.checked)} data-testid="folder-delete-archive" />
          {words.checkbox}
        </label>
        {archive ? (
          <>
            {words.working ? (
              <div className="sb-folder-archive-working" data-testid="folder-delete-working">
                {words.working}
              </div>
            ) : null}
            <ul className="sb-folder-archive-names" data-testid="folder-delete-names">
              {words.names.map((sessionName, i) => (
                <li key={`${i}:${sessionName}`}>{sessionName}</li>
              ))}
              {words.more ? <li>{words.more}</li> : null}
            </ul>
          </>
        ) : (
          <div className="sb-folder-archive-note" data-testid="folder-delete-note">
            {moveNote}
          </div>
        )}
        <div className="sb-close-actions">
          <button type="button" className="sb-button sb-close-primary" data-testid="folder-delete-go" onClick={() => onConfirm(archive)}>
            Delete folder
          </button>
          <button type="button" className="sb-button sb-close-outlined" data-testid="folder-delete-cancel" autoFocus onClick={onCancel}>
            {CLOSE_CANCEL}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
