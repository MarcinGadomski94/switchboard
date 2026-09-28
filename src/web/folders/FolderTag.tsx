import type { FolderListing } from '../../core/api.ts';
import './folders.css';

/**
 * The small mono tag of a row that belongs to a folder other than the default one
 * (D14: the sidebar's session rows, the Inbox meta, History, Artifacts,
 * Schedules). `name` comes from `folderTag()`; nothing renders for `null`, so the
 * default folder's rows look exactly as before.
 */
export function FolderTag({ name, title }: { readonly name: string | null; readonly title?: string | null }) {
  if (!name) return null;
  return (
    <span className="sb-folder-tag" data-testid="folder-tag" title={title ?? undefined}>
      {name}
    </span>
  );
}

/**
 * The Browse… listing (M5.3's folder picker, shared since D14): the folder shown,
 * `../` (when there is a parent) and one button per subfolder. A click calls
 * `onOpen` with the folder to move into. `testId` prefixes the test ids
 * (`<prefix>-browser`, `-browser-path`, `-folder-up`, `-folder`).
 */
export function FolderBrowserList({ listing, onOpen, testId }: { readonly listing: FolderListing; readonly onOpen: (path: string) => void; readonly testId: string }) {
  return (
    <div className="sb-fp-browser" data-testid={`${testId}-browser`}>
      <div className="sb-fp-browser-path" data-testid={`${testId}-browser-path`}>
        {listing.path}
      </div>
      {listing.parent !== null ? (
        <button type="button" className="sb-button sb-fp-folder" data-testid={`${testId}-folder-up`} onClick={() => onOpen(listing.parent ?? listing.path)}>
          ../
        </button>
      ) : null}
      {listing.folders.map((folder) => (
        <button key={folder.path} type="button" className="sb-button sb-fp-folder" data-testid={`${testId}-folder`} onClick={() => onOpen(folder.path)}>
          {`${folder.name}/`}
        </button>
      ))}
    </div>
  );
}
