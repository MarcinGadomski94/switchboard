import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Artifact, ArtifactDetail } from '../../../core/api.ts';
import { ARTIFACT_CSV_ROWS_MAX, artifactSizeLabel, lineDiff, parseCsv } from '../../../core/artifacts.ts';
import { ApiError, api, artifactRawUrl } from '../../api/client.ts';
import { formatAge } from '../../shell/format.ts';
import { ChatMarkdown } from './ChatMarkdown.tsx';
import { KIND_LABELS, type ViewerMode, authorLabel, renderedMarkdown, viewerModes } from './artifacts.ts';
import { actionErrorText } from './session-header.ts';
import '../../components/close-session.css';

/** Props of {@link ArtifactViewer}. */
export interface ArtifactViewerProps {
  readonly sessionId: string;
  /** The artifact as the list has it (its `versions` grows when the agent saves again). */
  readonly artifact: Artifact;
  /** D48: why the session's machine cannot be reached (Delete is off), else `null`. */
  readonly blocked: string | null;
  /** On a phone: back to the list. */
  readonly onBack?: () => void;
  readonly onDeleted: () => void;
}

function errorText(caught: unknown): string {
  return caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null);
}

/**
 * D89 · one saved artifact (`docs/artifacts.md` → *Viewer*): its title, kind, who
 * saved it and when; the version picker (the newest followed live until another
 * is picked); Rendered / Source / Compare; Copy, Download, Full screen, Delete
 * (with a confirmation). Rendered: Markdown with the chat's renderer, code and
 * Mermaid drawn in a sandboxed frame (D89 ruling), HTML in a
 * sandboxed frame (`allow-scripts`, never `allow-same-origin`; the served page
 * carries its own sandbox CSP), SVG and images as `<img>` of the served file
 * (never inline in the page), CSV as a table (the first rows).
 */
export function ArtifactViewer({ sessionId, artifact, blocked, onBack, onDeleted }: ArtifactViewerProps) {
  // `null` = follow the newest version (a new save shows at once).
  const [picked, setPicked] = useState<number | null>(null);
  const n = picked ?? artifact.versions;
  const [mode, setMode] = useState<ViewerMode>('rendered');
  const [compareFrom, setCompareFrom] = useState<number | null>(null);
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [other, setOther] = useState<ArtifactDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.artifact(sessionId, artifact.id, n).then(
      (loaded) => {
        if (!cancelled) {
          setDetail(loaded);
          setError(null);
        }
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
    // `updatedAt` too: a new version of the one on screen (never in practice: versions only grow) and a reload after a reconnect.
  }, [sessionId, artifact.id, n, artifact.updatedAt]);

  const modes = viewerModes(artifact.kind, artifact.versions);
  const shownMode: ViewerMode = modes.includes(mode) ? mode : 'rendered';
  const from = compareFrom !== null && compareFrom !== n ? compareFrom : n > 1 ? n - 1 : 2;

  useEffect(() => {
    if (shownMode !== 'diff') return;
    let cancelled = false;
    api.artifact(sessionId, artifact.id, from).then(
      (loaded) => {
        if (!cancelled) setOther(loaded);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, artifact.id, from, shownMode]);

  const content = detail?.version.n === n ? detail.version.content : null;
  const copy = (): void => {
    if (content === null) return;
    void navigator.clipboard?.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const remove = (): void => {
    setDeleting(true);
    api.deleteArtifact(sessionId, artifact.id).then(
      () => {
        setConfirming(false);
        setDeleting(false);
        onDeleted();
      },
      (caught: unknown) => {
        setDeleting(false);
        setError(errorText(caught));
      },
    );
  };

  const body = (
    <ArtifactBody
      sessionId={sessionId}
      artifact={artifact}
      n={n}
      mode={shownMode}
      content={content}
      older={other?.version.n === from ? other.version.content : null}
      from={from}
      loading={detail === null || detail.version.n !== n}
    />
  );
  const version = detail?.versionList.find((entry) => entry.n === n) ?? null;

  return (
    <section className="sb-artv" data-testid="artifact-viewer" data-artifact-id={artifact.id} data-kind={artifact.kind} data-mode={shownMode} data-version={n} aria-label={artifact.title}>
      <div className="sb-artv-head">
        {onBack ? (
          <button type="button" className="sb-button sb-artv-back" data-testid="artifact-back" onClick={onBack} aria-label="All artifacts">
            ‹
          </button>
        ) : null}
        <div className="sb-artv-titles">
          <div className="sb-artv-title" data-testid="artifact-title">
            {artifact.title}
          </div>
          <div className="sb-artv-sub" data-testid="artifact-sub">
            {KIND_LABELS[artifact.kind]}
            {artifact.language ? ` · ${artifact.language}` : ''}
            {version ? ` · v${version.n} saved by ${authorLabel(version.createdBy)} ${formatAge(version.createdAt) === 'now' ? 'just now' : `${formatAge(version.createdAt)} ago`} · ${artifactSizeLabel(version.size)}` : ''}
          </div>
        </div>
      </div>
      <div className="sb-artv-bar" role="toolbar" aria-label="Artifact actions">
        <label className="sb-artv-version">
          <span className="sb-artv-version-label">Version</span>
          <select
            data-testid="artifact-version"
            value={picked === null ? 'latest' : String(picked)}
            onChange={(event) => setPicked(event.target.value === 'latest' ? null : Number(event.target.value))}
          >
            <option value="latest">Latest (v{artifact.versions})</option>
            {Array.from({ length: artifact.versions }, (_, index) => artifact.versions - index).map((number) => (
              <option key={number} value={String(number)}>
                v{number}
              </option>
            ))}
          </select>
        </label>
        {modes.length > 1 ? (
          <div className="sb-artv-modes" role="group" aria-label="View">
            {modes.map((entry) => (
              <button key={entry} type="button" className="sb-button sb-artv-mode" data-testid={`artifact-mode-${entry}`} aria-pressed={entry === shownMode} onClick={() => setMode(entry)}>
                {entry === 'rendered' ? 'Rendered' : entry === 'source' ? 'Source' : 'Compare'}
              </button>
            ))}
          </div>
        ) : null}
        {shownMode === 'diff' ? (
          <label className="sb-artv-version">
            <span className="sb-artv-version-label">with</span>
            <select data-testid="artifact-compare-from" value={String(from)} onChange={(event) => setCompareFrom(Number(event.target.value))}>
              {Array.from({ length: artifact.versions }, (_, index) => artifact.versions - index)
                .filter((number) => number !== n)
                .map((number) => (
                  <option key={number} value={String(number)}>
                    v{number}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        <div className="sb-artv-actions">
          {artifact.kind !== 'image' ? (
            <button type="button" className="sb-button sb-artv-action" data-testid="artifact-copy" disabled={content === null} onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          ) : null}
          <a className="sb-artv-action" data-testid="artifact-download" href={artifactRawUrl(sessionId, artifact.id, n, true)} download>
            Download
          </a>
          <button type="button" className="sb-button sb-artv-action" data-testid="artifact-fullscreen" onClick={() => setFullScreen(true)}>
            Full screen
          </button>
          <button
            type="button"
            className="sb-button sb-artv-action"
            data-danger="true"
            data-testid="artifact-delete"
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        </div>
      </div>
      {error ? (
        <div className="sb-artv-error" role="alert" data-testid="artifact-error">
          {error}
        </div>
      ) : null}
      <div className="sb-artv-body" data-testid="artifact-body">
        {body}
      </div>
      {fullScreen ? <FullScreen title={artifact.title} onClose={() => setFullScreen(false)}>{body}</FullScreen> : null}
      {confirming ? <DeleteConfirm title={artifact.title} busy={deleting} onConfirm={remove} onCancel={() => setConfirming(false)} /> : null}
    </section>
  );
}

/** Props of {@link ArtifactBody}. */
interface ArtifactBodyProps {
  readonly sessionId: string;
  readonly artifact: Artifact;
  readonly n: number;
  readonly mode: ViewerMode;
  readonly content: string | null;
  readonly older: string | null;
  readonly from: number;
  readonly loading: boolean;
}

/** One version as the mode shows it. */
function ArtifactBody({ sessionId, artifact, n, mode, content, older, from, loading }: ArtifactBodyProps) {
  const src = artifactRawUrl(sessionId, artifact.id, n);
  if (artifact.kind === 'image') return <img className="sb-artv-image" data-testid="artifact-image" src={src} alt={artifact.title} />;
  if (artifact.kind === 'svg' && mode === 'rendered') return <img className="sb-artv-image" data-testid="artifact-svg" src={src} alt={artifact.title} />;
  if (artifact.kind === 'html' && mode === 'rendered') {
    // D89: scripts run, but in an opaque origin: no cookie, no storage, no API, no navigation of the app.
    return <iframe className="sb-artv-frame" data-testid="artifact-frame" sandbox="allow-scripts" src={src} title={artifact.title} referrerPolicy="no-referrer" />;
  }
  if (artifact.kind === 'mermaid' && mode === 'rendered') {
    // D89 ruling: Mermaid draws inside the same kind of sandboxed frame (the raw route's `?render` page), never in the app.
    return <iframe className="sb-artv-frame" data-testid="artifact-mermaid" sandbox="allow-scripts" src={`${src}?render`} title={artifact.title} referrerPolicy="no-referrer" />;
  }
  if (loading || content === null) return <div className="sb-artv-loading" data-testid="artifact-loading" aria-busy="true" />;
  if (mode === 'source') {
    return (
      <pre className="sb-artv-source" data-testid="artifact-source">
        {content}
      </pre>
    );
  }
  if (mode === 'diff') return older === null ? <div className="sb-artv-loading" aria-busy="true" /> : <VersionDiff before={older} after={content} from={from} to={n} />;
  if (artifact.kind === 'csv') return <CsvTable text={content} />;
  const markdown = renderedMarkdown(artifact.kind, artifact.language, content);
  return <ChatMarkdown text={markdown ?? content} testId="artifact-markdown" />;
}

/** D89: a CSV as a table (the first row is the header), at most {@link ARTIFACT_CSV_ROWS_MAX} rows. */
function CsvTable({ text }: { readonly text: string }) {
  const table = useMemo(() => parseCsv(text), [text]);
  const [head, ...rows] = table.rows;
  return (
    <div className="sb-artv-csv">
      {table.total > table.rows.length ? (
        <div className="sb-artv-note" data-testid="artifact-csv-cap">
          Showing the first {ARTIFACT_CSV_ROWS_MAX} of {table.total} rows. Download for all of them.
        </div>
      ) : null}
      <table data-testid="artifact-table">
        {head ? (
          <thead>
            <tr>
              {head.map((cell, index) => (
                <th key={index}>{cell}</th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) => (
                <td key={column}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** D89: the line diff of two versions (`- ` removed, `+ ` added). */
function VersionDiff({ before, after, from, to }: { readonly before: string; readonly after: string; readonly from: number; readonly to: number }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  const added = lines.filter((line) => line.op === 'add').length;
  const removed = lines.filter((line) => line.op === 'del').length;
  return (
    <div className="sb-artv-diff" data-testid="artifact-diff">
      <div className="sb-artv-note" data-testid="artifact-diff-summary">
        v{from} → v{to}: +{added} −{removed}
      </div>
      <pre>
        {lines.map((line, index) => (
          <div key={index} className="sb-artv-diff-line" data-op={line.op}>
            {line.op === 'add' ? '+ ' : line.op === 'del' ? '- ' : '  '}
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

/** Full screen: the same view over the whole window; Esc or ✕ closes. */
function FullScreen({ title, children, onClose }: { readonly title: string; readonly children: ReactNode; readonly onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="sb-artv-full" role="dialog" aria-modal="true" aria-label={title} data-testid="artifact-fullscreen-view">
      <div className="sb-artv-full-head">
        <span className="sb-artv-title">{title}</span>
        <button type="button" className="sb-button sb-artv-action" data-testid="artifact-fullscreen-close" onClick={onClose} autoFocus aria-label="Close full screen">
          ✕
        </button>
      </div>
      <div className="sb-artv-full-body">{children}</div>
    </div>,
    document.body,
  );
}

/** Delete's confirmation (the Close confirmation's look); Cancel has the focus. */
function DeleteConfirm({ title, busy, onConfirm, onCancel }: { readonly title: string; readonly busy: boolean; readonly onConfirm: () => void; readonly onCancel: () => void }) {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
    }
  };
  return createPortal(
    <div className="sb-close-overlay" onClick={busy ? undefined : onCancel} onKeyDown={onKeyDown}>
      <div className="sb-close-dialog" role="alertdialog" aria-modal="true" aria-labelledby="sb-artv-delete-text" data-testid="artifact-delete-confirm" onClick={(event) => event.stopPropagation()}>
        <div className="sb-close-text" id="sb-artv-delete-text">
          Delete “{title}” and all its versions? This cannot be undone.
        </div>
        <div className="sb-close-actions">
          <button type="button" className="sb-button sb-close-primary" data-testid="artifact-delete-yes" disabled={busy} aria-busy={busy || undefined} onClick={onConfirm}>
            Delete
          </button>
          <button type="button" className="sb-button sb-close-outlined" data-testid="artifact-delete-cancel" disabled={busy} autoFocus onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
