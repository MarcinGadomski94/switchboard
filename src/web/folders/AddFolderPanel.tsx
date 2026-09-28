import { type KeyboardEvent, useState } from 'react';
import type { Folder } from '../../core/api.ts';
import { folderNamePlaceholder } from './folders.ts';
import { FolderBrowserList } from './FolderTag.tsx';
import { useFolderPicker } from './useFolders.ts';
import './folders.css';

/**
 * The add-a-folder panel (D14): Settings → Folders → Add… and the New-session
 * form's Browse…. It is the setup wizard's folder picker (M5.3): a path field
 * checked live with its check line, the Browse… listing (open from the start,
 * beginning at the default folder, else the home folder), and **Add**, which
 * posts `POST /api/folders`. D18: an optional **Name** field under the path
 * (the folder's custom name; its placeholder is the folder's own name once a path
 * is chosen), sent as `label`. A refused folder or name stays in the panel with
 * `Not added: <reason>` and nothing is saved; an added one (or one saved already)
 * goes to `onAdded`. `testId` prefixes the test ids (`<prefix>-input`, `-name`,
 * `-add`, `-line`, `-error`, and the listing's).
 */
export function AddFolderPanel({ testId, onAdded, onCancel }: { readonly testId: string; readonly onAdded: (folder: Folder) => void; readonly onCancel: () => void }) {
  const picker = useFolderPicker({ browseOnStart: true });
  const [name, setName] = useState('');
  const add = async (): Promise<void> => {
    const folder = await picker.add(name);
    if (folder) onAdded(folder);
  };
  const addOnEnter = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void add();
    }
  };
  return (
    <div className="sb-fp-panel" data-testid={`${testId}-panel`}>
      <div className="sb-fp-row">
        <input
          className="sb-fp-field"
          data-testid={`${testId}-input`}
          value={picker.input}
          spellCheck={false}
          placeholder="A workspace (router AGENTS.md) or a git repository"
          aria-label="Folder to add"
          onChange={(event) => picker.setInput(event.target.value)}
          onKeyDown={addOnEnter}
        />
        <button type="button" className="sb-button sb-fp-add" data-testid={`${testId}-add`} disabled={picker.adding || picker.input.trim() === ''} onClick={() => void add()}>
          Add
        </button>
        <button type="button" className="sb-button sb-fp-cancel" data-testid={`${testId}-cancel`} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <label className="sb-fp-row sb-fp-name-row">
        <span className="sb-fp-name-label">Name</span>
        <input
          className="sb-fp-field sb-fp-name"
          data-testid={`${testId}-name`}
          value={name}
          spellCheck={false}
          placeholder={folderNamePlaceholder(picker.input, picker.check)}
          aria-label="Name (optional)"
          onChange={(event) => {
            setName(event.target.value);
            picker.setError(null);
          }}
          onKeyDown={addOnEnter}
        />
      </label>
      {picker.line ? (
        <div className="sb-fp-line" data-testid={`${testId}-line`} data-ok={String(picker.line.ok)}>
          {picker.line.text}
        </div>
      ) : null}
      {picker.error ? (
        <div className="sb-fp-error" role="alert" data-testid={`${testId}-error`}>
          {`Not added: ${picker.error}`}
        </div>
      ) : null}
      {picker.listing ? (
        <div className="sb-fp-browser-wrap">
          <FolderBrowserList listing={picker.listing} onOpen={picker.openFolder} testId={testId} />
        </div>
      ) : null}
    </div>
  );
}
