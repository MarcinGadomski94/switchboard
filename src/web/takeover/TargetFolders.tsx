import { useState } from 'react';
import { ApiError, api } from '../api/client.ts';
import { FolderBrowserList } from '../folders/FolderTag.tsx';
import type { TakeoverPreview, TargetDirListing, TargetPlacement } from '../../core/takeover.ts';
import { type RepoRow, repoRows, withRoot, withoutRoot } from './takeover.ts';

/**
 * D110 (`docs/peers.md` → *Target folders and verification*): the move dialog's
 * target side, shared by the session take-over and the Team member move. The
 * developer picks folders **on the target machine** (its saved folders and home,
 * a typed path, or browsing its folders through the peer API); the target then
 * looks for each of the session's repos under them by remote and the table shows
 * ✓ / ⚠ / ✖ per repo. Nothing here decides: every change re-runs the preview.
 */

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | null;
    if (body && typeof body.message === 'string') return body.message;
    return error.status === 0 ? 'Switchboard could not be reached' : `HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The chosen folders on the target (chips), and **Choose folders…**: the target's
 * saved folders and home, a path field, and a browser of its folders.
 */
export function TargetFolderPicker({
  machine,
  machineName,
  placement,
  remembered,
  onChange,
}: {
  /** The target machine's id; `null` = this machine. */
  readonly machine: string | null;
  readonly machineName: string;
  readonly placement: TargetPlacement | null;
  readonly remembered: boolean;
  readonly onChange: (next: TargetPlacement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<TargetDirListing | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = (path: string | null): void => {
    setError(null);
    api
      .takeoverFolders(machine, path)
      .then((next) => {
        setListing(next);
        if (next.path) setTyped(next.path);
      })
      .catch((caught: unknown) => setError(errorText(caught)));
  };
  const toggle = (): void => {
    if (!open && listing === null) load(null);
    setOpen(!open);
  };
  const use = (path: string): void => {
    if (path.trim() === '') return;
    onChange(withRoot(placement, path));
    setOpen(false);
  };
  const roots = placement?.roots ?? [];
  return (
    <div className="sb-takeover-folders" data-testid="takeover-folders">
      <div className="sb-takeover-folders-head">
        <span className="sb-takeover-folders-label">Folders on {machineName}</span>
        {roots.length === 0 ? (
          <span className="sb-takeover-muted" data-testid="takeover-folders-saved">
            its saved folders
          </span>
        ) : (
          roots.map((root) => (
            <span key={root} className="sb-takeover-root" data-testid="takeover-root" title={root}>
              {root}
              <button type="button" className="sb-takeover-root-remove" data-testid="takeover-root-remove" aria-label={`Remove ${root}`} onClick={() => onChange(withoutRoot(placement, root))}>
                ×
              </button>
            </span>
          ))
        )}
        <button type="button" className="sb-button sb-takeover-outlined sb-takeover-small" data-testid="takeover-folders-toggle" aria-expanded={open} onClick={toggle}>
          {open ? 'Close' : roots.length === 0 ? 'Choose folders…' : 'Add a folder…'}
        </button>
      </div>
      {remembered && roots.length > 0 ? (
        <div className="sb-takeover-muted" data-testid="takeover-remembered">
          The folders of the last move of this folder to {machineName}.
        </div>
      ) : null}
      {open ? (
        <div className="sb-takeover-picker" data-testid="takeover-folder-picker">
          {listing ? (
            <div className="sb-takeover-places">
              {listing.places.map((place) => (
                <button key={place.path} type="button" className="sb-button sb-takeover-place" data-testid="takeover-place" data-kind={place.kind} title={place.path} onClick={() => load(place.path)}>
                  {place.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="sb-takeover-clone">
            <input
              className="sb-takeover-input"
              data-testid="takeover-folder-path"
              placeholder={`A folder on ${machineName}`}
              value={typed}
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') load(typed);
              }}
            />
            <button type="button" className="sb-button sb-takeover-outlined sb-takeover-small" data-testid="takeover-folder-open" onClick={() => load(typed)}>
              Open
            </button>
            <button type="button" className="sb-button sb-takeover-primary sb-takeover-small" data-testid="takeover-folder-use" disabled={typed.trim() === ''} onClick={() => use(typed)}>
              Use this folder
            </button>
          </div>
          {error ? (
            <div className="sb-takeover-error" role="alert" data-testid="takeover-folder-error">
              {error}
            </div>
          ) : null}
          {listing && listing.path ? <FolderBrowserList listing={{ path: listing.path, parent: listing.parent, folders: listing.entries.map((entry) => ({ name: entry.repo ? `${entry.name} (git)` : entry.workspace ? `${entry.name} (workspace)` : entry.name, path: entry.path })) }} onOpen={(path) => load(path)} testId="takeover" /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** One repo row: ✓ / ⚠ / ✖, the source's side (remote, branch, work) and what the target found. */
function RepoRowView({
  row,
  sourceName,
  targetName,
  clonePath,
  onClonePath,
  onCloneDone,
  onPick,
}: {
  readonly row: RepoRow;
  readonly sourceName: string;
  readonly targetName: string;
  readonly clonePath: string | undefined;
  readonly onClonePath: ((key: string, value: string) => void) | null;
  readonly onCloneDone: (() => void) | null;
  readonly onPick: ((key: string, path: string | null) => void) | null;
}) {
  const [override, setOverride] = useState<string | null>(null);
  return (
    <div className="sb-takeover-repo" data-testid="takeover-repo" data-key={row.key} data-action={row.action} data-state={row.state ?? ''} data-mark={row.mark}>
      <div className="sb-takeover-repo-head">
        <span className="sb-takeover-mark-cell" data-testid="takeover-repo-mark" data-mark={row.mark} aria-label={row.mark === '✓' ? 'found' : row.mark === '⚠' ? 'needs attention' : 'blocked'}>
          {row.mark}
        </span>
        <span className="sb-takeover-repo-name">{row.name}</span>
        <span className="sb-takeover-branch" data-testid="takeover-repo-branch">
          {row.branch}
        </span>
        <span className="sb-takeover-action" data-testid="takeover-repo-action">
          {row.action === 'use' ? 'Use here' : row.action === 'clone' ? 'Clone first' : 'Blocked'}
        </span>
      </div>
      <div className="sb-takeover-repo-cols">
        <div className="sb-takeover-repo-col">
          <span className="sb-takeover-col-label">{sourceName}</span>
          {row.remoteUrl ? (
            <span className="sb-takeover-repo-line sb-takeover-muted" data-testid="takeover-repo-remote">
              {row.remoteUrl}
            </span>
          ) : null}
          <span className="sb-takeover-repo-line" data-testid="takeover-repo-work">
            {row.work} · carried through a temporary branch
          </span>
        </div>
        <div className="sb-takeover-repo-col">
          <span className="sb-takeover-col-label">{targetName}</span>
          <span className="sb-takeover-repo-line" data-testid="takeover-repo-summary">
            {row.target}
          </span>
          {row.choices.length > 0 && onPick ? (
            <div className="sb-takeover-choices" role="radiogroup" aria-label={`Which checkout of ${row.name}`}>
              {row.choices.map((choice) => (
                <button key={choice.path} type="button" role="radio" aria-checked={false} className="sb-button sb-takeover-outlined sb-takeover-choice" data-testid="takeover-repo-choice" onClick={() => onPick(row.key, choice.path)}>
                  {choice.path} · {choice.branch ?? 'detached'}
                  {choice.dirty > 0 ? ` · ${choice.dirty} uncommitted` : ''}
                </button>
              ))}
            </div>
          ) : null}
          {onPick ? (
            override === null ? (
              <button type="button" className="sb-takeover-link" data-testid="takeover-repo-other" onClick={() => setOverride(row.path ?? '')}>
                Another checkout…
              </button>
            ) : (
              <label className="sb-takeover-clone">
                Use
                <input
                  className="sb-takeover-input"
                  data-testid="takeover-repo-override"
                  value={override}
                  placeholder={`The checkout of ${row.name} on ${targetName}`}
                  spellCheck={false}
                  onChange={(event) => setOverride(event.target.value)}
                  onBlur={() => onPick(row.key, override.trim() === '' ? null : override)}
                />
              </label>
            )
          ) : null}
          {onClonePath && (row.action === 'clone' || (row.action === 'blocked' && row.cloneTo !== null)) ? (
            <label className="sb-takeover-clone">
              Clone into
              <input
                className="sb-takeover-input"
                data-testid="takeover-clone-path"
                value={clonePath ?? row.cloneTo ?? ''}
                spellCheck={false}
                onChange={(event) => onClonePath(row.key, event.target.value)}
                onBlur={() => onCloneDone?.()}
              />
            </label>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The repo table (D110: ✓ / ⚠ / ✖ per repo); the choices and clone paths call back to re-run the preview. */
export function RepoTable({
  preview,
  sourceName,
  targetName,
  clonePaths,
  onClonePath,
  onCloneDone,
  onPick,
}: {
  readonly preview: TakeoverPreview;
  readonly sourceName: string;
  readonly targetName: string;
  readonly clonePaths: Readonly<Record<string, string>>;
  readonly onClonePath: ((key: string, value: string) => void) | null;
  readonly onCloneDone: (() => void) | null;
  readonly onPick: ((key: string, path: string | null) => void) | null;
}) {
  return (
    <div className="sb-takeover-repos" data-testid="takeover-repos">
      {repoRows(preview).map((row) => (
        <RepoRowView key={row.key} row={row} sourceName={sourceName} targetName={targetName} clonePath={clonePaths[row.key]} onClonePath={onClonePath} onCloneDone={onCloneDone} onPick={onPick} />
      ))}
    </div>
  );
}
