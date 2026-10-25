import { useEffect, useMemo, useState } from 'react';
import type { ArtifactDetail, ArtifactListItem } from '../../../core/api.ts';
import { ARTIFACT_CSV_ROWS_MAX, artifactSizeLabel, parseCsv } from '../../../core/artifacts.ts';
import { ApiError, api, artifactRawUrl } from '../../api/client.ts';
import { useCoarsePointer, useLayout } from '../../shell/useLayout.ts';
import { ChatMarkdown } from '../../views/session/ChatMarkdown.tsx';
import { renderedMarkdown } from '../../views/session/artifacts.ts';
import { actionErrorText } from '../../views/session/session-header.ts';
import { Button, Chip, ComputerTag, Drawer, Icon, IconButton, Skeleton, useToast } from '../components/index.ts';
import { RESULTS_WORDS as W, computerStateToV2 } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { comparePair, hasSource } from './results-model.ts';
import './results.css';

function errorText(caught: unknown): string {
  return caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null);
}

/** One version's detail (`null` while it loads), refetched when the result gets a new version. */
function useVersion(item: ArtifactListItem, n: number | null): { readonly detail: ArtifactDetail | null; readonly error: string | null } {
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionId = item.sessionId;
  useEffect(() => {
    if (!sessionId || n === null) return undefined;
    let cancelled = false;
    api.artifact(sessionId, item.id, n).then(
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
  }, [sessionId, item.id, n, item.updatedAt]);
  return { detail: detail && detail.version.n === n && detail.id === item.id ? detail : null, error };
}

/**
 * D131 · lane R · the result drawer (the prototype's `#drawer` and `drawerExtra`):
 * the preview by kind (PDF in the browser's own viewer through the raw route,
 * Mermaid and web pages in the sandboxed frame classic uses, CSV as a table,
 * Markdown and code rendered, images and SVG as images of the served file), the
 * versions with Compare side by side, Source / Rendered, Copy, Download, Full
 * screen, Open agent and Delete. On a phone it fills the screen.
 *
 * Lane X: the agent view's Results tab and its chat attachments open this drawer
 * too. `onDelete` is optional (no Delete button without it) and `openAgent={false}`
 * hides Open agent (the agent's own page shows it already).
 */
export function ResultDrawer({
  item,
  onClose,
  onDelete,
  openAgent = true,
}: {
  readonly item: ArtifactListItem | null;
  readonly onClose: () => void;
  readonly onDelete?: (item: ArtifactListItem) => void;
  /** Show **Open agent** (default); the agent view passes `false`. */
  readonly openAgent?: boolean;
}) {
  const phone = useLayout() === 'phone';
  const [full, setFull] = useState(false);
  return (
    <Drawer
      open={item !== null}
      onClose={onClose}
      full={phone || full}
      testId="v2-result-drawer"
      title={
        item ? (
          <div className="v2-res-dr-title">
            <b data-testid="v2-result-title">{item.title}</b>
            <div className="v2-muted v2-res-dr-sub" data-testid="v2-result-sub">
              {W.kinds[item.kind]}
              {item.language ? ` · ${item.language}` : ''} · {item.sessionId ? W.from(item.sessionTitle ?? item.sessionName ?? '') : W.agentGone}
              {item.machine ? (
                <>
                  {' '}
                  <ComputerTag name={item.machine.name} state={computerStateToV2(item.machine.state)} short />
                </>
              ) : null}
            </div>
          </div>
        ) : (
          ''
        )
      }
      actions={
        item ? (
          <>
            {phone ? null : (
              <IconButton
                icon="external"
                label={full ? W.exitFullScreen : W.fullScreen}
                aria-pressed={full}
                data-testid="v2-result-full"
                onClick={() => setFull((on) => !on)}
              />
            )}
            {onDelete ? <IconButton icon="trash" label={W.delete} data-testid="v2-result-delete" className="v2-res-danger" onClick={() => onDelete(item)} /> : null}
          </>
        ) : null
      }
    >
      {item ? <ResultView key={`${item.machine?.id ?? ''}/${item.id}`} item={item} onFull={setFull} openAgent={openAgent} /> : null}
    </Drawer>
  );
}

/** The body: toolbar (versions, Compare, Source, Copy, Download, Open agent) and the preview. */
function ResultView({ item, onFull, openAgent }: { readonly item: ArtifactListItem; readonly onFull: (on: boolean) => void; readonly openAgent: boolean }) {
  const toast = useToast();
  const { navigate } = useV2Router();
  // `null` = follow the newest version.
  const [picked, setPicked] = useState<number | null>(null);
  const n = Math.min(picked ?? item.versions, item.versions);
  const [source, setSource] = useState(false);
  const [comparing, setComparing] = useState(false);
  const text = hasSource(item.kind);
  const needsText = text && item.sessionId !== null;
  const shown = useVersion(item, needsText ? n : null);
  const pair = comparePair(n, item.versions);
  const left = useVersion(item, comparing && needsText && pair ? pair[0] : null);
  const right = useVersion(item, comparing && needsText && pair ? pair[1] : null);

  if (!item.sessionId) {
    return (
      <p className="v2-muted" data-testid="v2-result-no-preview">
        {W.noPreview}
      </p>
    );
  }
  const sessionId = item.sessionId;
  const content = shown.detail?.version.content ?? null;
  const version = shown.detail?.versionList.find((entry) => entry.n === n) ?? null;

  const copy = (): void => {
    if (content === null) return;
    void navigator.clipboard?.writeText(content).then(
      () => toast({ text: W.copied(item.title) }),
      () => undefined,
    );
  };
  const compare = (): void => {
    if (!pair) {
      toast({ text: W.compareOne });
      return;
    }
    const next = !comparing;
    setComparing(next);
    if (next) {
      setSource(false);
      onFull(true);
    }
  };

  return (
    <div className="v2-res-view" data-testid="v2-result-view" data-kind={item.kind} data-version={n} data-mode={comparing ? 'compare' : source ? 'source' : 'rendered'}>
      <div className="v2-res-toolbar" role="toolbar" aria-label={W.preview}>
        <div className="v2-res-vlist" role="group" aria-label={W.versions}>
          {Array.from({ length: item.versions }, (_, index) => index + 1).map((number) => (
            <button
              key={number}
              type="button"
              className="v2-res-fchip"
              data-size="s"
              data-testid="v2-result-version"
              aria-pressed={number === n}
              onClick={() => setPicked(number === item.versions ? null : number)}
            >
              {W.version(number)}
            </button>
          ))}
        </div>
        <span className="v2-grow" />
        <Button size="sm" icon="eye" aria-pressed={comparing} data-testid="v2-result-compare" onClick={compare}>
          {W.compare}
        </Button>
        {text ? (
          <Button size="sm" icon={source ? 'image' : 'cmd'} data-testid="v2-result-source" disabled={comparing} onClick={() => setSource((on) => !on)}>
            {source ? W.rendered : W.source}
          </Button>
        ) : null}
        {text ? (
          <Button size="sm" icon="copy" data-testid="v2-result-copy" disabled={content === null} onClick={copy}>
            {W.copy}
          </Button>
        ) : null}
        <a className="v2-btn" data-size="sm" data-testid="v2-result-download" href={artifactRawUrl(sessionId, item.id, n, true)} download>
          <Icon name="download" size="s" />
          {W.download}
        </a>
        {openAgent ? (
          <Button size="sm" icon="agents" data-testid="v2-result-open-agent" onClick={() => navigate({ area: 'agent', id: sessionId, tab: 'chat' })}>
            {W.openAgent}
          </Button>
        ) : null}
      </div>
      {version ? (
        <div className="v2-muted v2-res-meta" data-testid="v2-result-meta">
          {W.version(version.n)} · {artifactSizeLabel(version.size)} · {version.createdBy === 'agent' ? W.savedByAgent : W.savedByYou}
        </div>
      ) : null}
      {shown.error ? (
        <div className="v2-res-error" role="alert" data-testid="v2-result-error">
          {shown.error}
        </div>
      ) : null}
      {comparing && pair ? (
        <div className="v2-res-cmp" data-testid="v2-result-cmp">
          {([pair[0], pair[1]] as const).map((number, index) => {
            const side = index === 0 ? left : right;
            return (
              <div key={number} className="v2-res-cmp-side" data-testid="v2-result-cmp-side" data-version={number}>
                <div className="v2-muted v2-res-cmp-h">
                  {W.version(number)}
                  {index === 1 ? (
                    <>
                      {' '}
                      <Chip tone="green" size="s">
                        {W.newer}
                      </Chip>
                    </>
                  ) : null}
                </div>
                <Preview item={item} sessionId={sessionId} n={number} content={side.detail?.version.content ?? null} loading={needsText && side.detail === null} />
              </div>
            );
          })}
        </div>
      ) : source && content !== null ? (
        <pre className="v2-res-source" data-testid="v2-result-source-text">
          {content}
        </pre>
      ) : (
        <Preview item={item} sessionId={sessionId} n={n} content={content} loading={needsText && shown.detail === null} />
      )}
    </div>
  );
}

/** One version as it is meant to be seen. */
function Preview({ item, sessionId, n, content, loading }: { readonly item: ArtifactListItem; readonly sessionId: string; readonly n: number; readonly content: string | null; readonly loading: boolean }) {
  const src = artifactRawUrl(sessionId, item.id, n);
  if (item.kind === 'image' || item.kind === 'svg') return <img className="v2-res-image" data-testid="v2-result-image" src={src} alt={item.title} />;
  if (item.kind === 'pdf') return <PdfPreview src={src} title={item.title} />;
  if (item.kind === 'html') {
    // D89: scripts run in an opaque origin: no cookie, no storage, no API, no navigation of the app.
    return <iframe className="v2-res-frame" data-testid="v2-result-frame" sandbox="allow-scripts" src={src} title={item.title} referrerPolicy="no-referrer" />;
  }
  if (item.kind === 'mermaid') {
    // D89 ruling: Mermaid draws in the raw route's sandboxed `?render` page, never in the app.
    return <iframe className="v2-res-frame" data-testid="v2-result-mermaid" sandbox="allow-scripts" src={`${src}?render`} title={item.title} referrerPolicy="no-referrer" />;
  }
  if (loading || content === null) return <Skeleton lines={6} height={12} style={{ width: '100%' }} />;
  if (item.kind === 'csv') return <CsvPreview text={content} />;
  const markdown = renderedMarkdown(item.kind, item.language, content);
  return (
    <div className="v2-res-doc" data-testid="v2-result-doc">
      <ChatMarkdown text={markdown ?? content} testId="v2-result-markdown" />
    </div>
  );
}

/** D126: the browser's own PDF viewer (an `<object>` of the raw route); on a phone or touch screen an Open PDF card. */
function PdfPreview({ src, title }: { readonly src: string; readonly title: string }) {
  const phone = useLayout() === 'phone';
  const touch = useCoarsePointer();
  const card = (
    <div className="v2-res-pdf-card" data-testid="v2-result-pdf-card">
      <div className="v2-res-pdf-icon" aria-hidden="true">
        PDF
      </div>
      <b>{title}</b>
      <a className="v2-btn" data-variant="primary" href={src} target="_blank" rel="noopener noreferrer">
        {W.openPdf}
      </a>
    </div>
  );
  if (phone || touch) return card;
  return (
    <object className="v2-res-frame v2-res-pdf" data-testid="v2-result-pdf" data={src} type="application/pdf" aria-label={title}>
      {card}
    </object>
  );
}

/** A CSV as a table (the first row is the header), capped like classic. */
function CsvPreview({ text }: { readonly text: string }) {
  const table = useMemo(() => parseCsv(text), [text]);
  const [head, ...rows] = table.rows;
  return (
    <div className="v2-res-csv">
      {table.total > table.rows.length ? <div className="v2-muted">{W.csvCap(ARTIFACT_CSV_ROWS_MAX, table.total)}</div> : null}
      <table data-testid="v2-result-table">
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
