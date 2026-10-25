import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Artifact, ArtifactDetail, DiffScope, SessionEvent } from '../../../core/api.ts';
import { parseCsv } from '../../../core/artifacts.ts';
import { api, artifactRawUrl } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { ChatMarkdown } from '../../views/session/ChatMarkdown.tsx';
import { renderedMarkdown, viewerModes, type ViewerMode } from '../../views/session/artifacts.ts';
import { deltaText, diffModel, fileKey, scopeOptions, shownScope } from '../../views/session/diff.ts';
import { useDiffScope } from '../../views/session/useDiffScope.ts';
import { useSessionRefresh } from '../../views/session/useSessionRefresh.ts';
import { hasSubagentChat } from '../../views/session/chat.ts';
import { PLAY_MAX, TIMELINE_EVENTS_PAGE, formatClock, timelineModel } from '../../views/session/timeline.ts';
import { rootPath } from '../../views/session/right-panel.ts';
import { Card, Drawer, EmptyState, Icon, Segmented, Skeleton, StatusBadge } from '../components/index.ts';
import { AGENT_WORDS, sessionStatusToV2 } from '../glossary.ts';
import { V2Link, useV2Router } from '../nav.tsx';
import { resultMeta } from './chat-model.ts';
import type { AgentData } from './useAgent.ts';

/** The v2 names of the classic diff views (D90). */
const SCOPE_WORDS: Readonly<Record<DiffScope, string>> = { head: AGENT_WORDS.sinceSavePoint, branch: AGENT_WORDS.wholeCopy, repo: AGENT_WORDS.allUnsaved };
const SCOPE_NOTES: Readonly<Record<DiffScope, string>> = {
  head: 'What changed since the last save point (commit).',
  branch: 'Everything on the separate copy, compared with where it started. Nothing reaches your main code until you Combine.',
  repo: 'Every unsaved change in the code project, other agents’ and people’s too.',
};

/**
 * D131 · lane S · the Changes tab (the classic Diff tab's data, D90): Since last save
 * point / Whole separate copy / All unsaved, the files with their +/−, and the
 * picked file's diff.
 */
export function ChangesTab({ sessionId }: { readonly sessionId: string }) {
  const [remembered, pick] = useDiffScope(sessionId);
  const targets = useApi(() => api.sessionDiffTargets(sessionId), [sessionId]);
  const known = targets.data ?? (targets.error ? { worktrees: [], inPlace: [] } : null);
  const scope = shownScope(remembered, known);
  const diff = useApi(async () => ({ scope, files: await api.sessionDiff(sessionId, undefined, scope) }), [sessionId, scope]);
  const reloadDiff = diff.reload;
  const reloadTargets = targets.reload;
  const reload = useCallback(() => {
    reloadDiff();
    reloadTargets();
  }, [reloadDiff, reloadTargets]);
  useSessionRefresh(sessionId, reload);
  const [selected, setSelected] = useState<string | null>(null);
  const files = diff.data !== null && diff.data.scope === scope ? diff.data.files : null;
  const model = useMemo(() => diffModel(files ?? [], selected), [files, selected]);
  const options = scopeOptions(known);
  const list = files ?? [];
  return (
    <div className="v2-ag-tab" data-testid="v2-agent-changes" data-scope={scope}>
      <div className="v2-row v2-ag-tab-head">
        <Segmented<DiffScope>
          label={AGENT_WORDS.changesWhich}
          value={scope}
          size="s"
          testId="v2-agent-changes-scope"
          options={(['head', 'branch', 'repo'] as const).filter((value) => options.includes(value)).map((value) => ({ value, label: SCOPE_WORDS[value] }))}
          onChange={(value) => {
            if (options.includes(value)) pick(value);
          }}
        />
        <span className="v2-muted v2-ag-small">{SCOPE_NOTES[scope]}</span>
      </div>
      {files === null ? (
        diff.error ? (
          <EmptyState icon="alert" tone="grey" title="Could not read the changes" text={diff.error.message} />
        ) : (
          <Skeleton lines={4} height={14} />
        )
      ) : model.empty ? (
        <EmptyState icon="copy" tone="grey" title={AGENT_WORDS.noChanges} text={AGENT_WORDS.noChangesText} testId="v2-agent-changes-empty" />
      ) : (
        <>
          <p className="v2-muted v2-ag-small" style={{ marginTop: 0 }}>
            {list.length} file{list.length === 1 ? '' : 's'} changed · {deltaText(list.reduce((s, f) => s + f.added, 0), list.reduce((s, f) => s + f.removed, 0))}
          </p>
          <Card className="v2-ag-files">
            {list.map((file) => {
              const key = fileKey(file);
              const on = model.pane.key === key;
              return (
                <button key={key} type="button" className="v2-ag-file" aria-pressed={on} data-testid="v2-agent-change-file" onClick={() => setSelected(key)}>
                  <Icon name="results" size="s" />
                  <span className="v2-grow v2-mono">{file.solution === 'root' ? file.path : `${file.solution}/${file.path}`}</span>
                  <span className="v2-ag-add">+{file.added}</span>
                  <span className="v2-ag-del">−{file.removed}</span>
                </button>
              );
            })}
          </Card>
          {model.pane.key !== null ? (
            <div className="v2-ag-diff" data-testid="v2-agent-diff">
              <div className="v2-ag-diff-h">{model.pane.name}</div>
              {model.pane.lines.map((line, index) => (
                <div key={index} data-tone={line.tone}>
                  {line.text}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** D89 · this agent's results (artifacts), newest first; a click opens the drawer. */
export function ResultsTab({ data, resultId, onOpen }: { readonly data: AgentData; readonly resultId: string | null; readonly onOpen?: (id: string | null) => void }) {
  const { navigate } = useV2Router();
  const results = data.session?.artifacts ?? null;
  const open = (id: string | null): void => {
    if (onOpen) onOpen(id);
    else navigate(id ? `/agents/${encodeURIComponent(data.sessionId)}/results/${encodeURIComponent(id)}` : `/agents/${encodeURIComponent(data.sessionId)}/results`);
  };
  if (results === null) return <Skeleton lines={3} height={60} />;
  return (
    <div className="v2-ag-tab" data-testid="v2-agent-results">
      {results.length === 0 ? (
        <EmptyState icon="results" tone="grey" title={AGENT_WORDS.noResults} text={AGENT_WORDS.noResultsText} />
      ) : (
        <div className="v2-ag-rgrid">
          {results.map((artifact) => (
            <Card key={artifact.id} interactive className="v2-ag-rcard" data-testid="v2-agent-result-card" onClick={() => open(artifact.id)}>
              <span className="v2-ag-fi" data-kind={artifact.kind}>
                {artifact.kind === 'markdown' ? 'MD' : artifact.kind.slice(0, 3).toUpperCase()}
              </span>
              <span className="v2-ag-att-t">
                <b>{artifact.title}</b>
                <small>{resultMeta(artifact.kind, artifact.versions)}</small>
              </span>
            </Card>
          ))}
        </div>
      )}
      {resultId ? <ResultDrawer sessionId={data.sessionId} artifactId={resultId} onClose={() => open(null)} /> : null}
    </div>
  );
}

/** One result in a drawer: its versions, rendered or as source (the classic viewer's rules, D89 / D126). */
export function ResultDrawer({ sessionId, artifactId, onClose }: { readonly sessionId: string; readonly artifactId: string; readonly onClose: () => void }) {
  const [version, setVersion] = useState<number | null>(null);
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewerMode>('rendered');
  useEffect(() => {
    let live = true;
    setError(null);
    api.artifact(sessionId, artifactId, version ?? undefined).then(
      (answer) => live && setDetail(answer),
      () => live && setError('This result could not be read.'),
    );
    return () => {
      live = false;
    };
  }, [sessionId, artifactId, version]);
  const modes = detail ? viewerModes(detail.kind, 1) : ['rendered' as const];
  return (
    <Drawer
      open
      onClose={onClose}
      testId="v2-agent-result-drawer"
      title={
        <div>
          <b>{detail?.title ?? 'Result'}</b>
          {detail ? <div className="v2-muted v2-ag-small">{resultMeta(detail.kind, detail.versions)}</div> : null}
        </div>
      }
      actions={
        detail && detail.versionList.length > 1 ? (
          <select className="v2-field" aria-label="Version" value={detail.version.n} onChange={(event) => setVersion(Number(event.target.value))}>
            {detail.versionList.map((v) => (
              <option key={v.n} value={v.n}>
                v{v.n} · {new Date(v.createdAt).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}
              </option>
            ))}
          </select>
        ) : null
      }
    >
      {modes.length > 1 ? (
        <Segmented<ViewerMode> label="Show" size="s" value={mode} onChange={setMode} options={modes.filter((m) => m !== 'diff').map((m) => ({ value: m, label: m === 'rendered' ? 'Rendered' : 'Source' }))} />
      ) : null}
      {error ? <p className="v2-ag-dock-error">{error}</p> : detail ? <ResultBody sessionId={sessionId} detail={detail} mode={mode} /> : <Skeleton lines={6} height={12} />}
    </Drawer>
  );
}

function ResultBody({ sessionId, detail, mode }: { readonly sessionId: string; readonly detail: ArtifactDetail; readonly mode: ViewerMode }) {
  const src = artifactRawUrl(sessionId, detail.id, detail.version.n);
  const content = detail.version.content;
  if (detail.kind === 'image' || (detail.kind === 'svg' && mode === 'rendered')) return <img className="v2-ag-result-img" src={src} alt={detail.title} />;
  if (detail.kind === 'pdf') {
    return (
      <a className="v2-btn" href={src} target="_blank" rel="noopener noreferrer">
        Open the PDF
      </a>
    );
  }
  if (detail.kind === 'html' && mode === 'rendered') return <iframe className="v2-ag-result-frame" sandbox="allow-scripts" src={src} title={detail.title} referrerPolicy="no-referrer" />;
  if (detail.kind === 'mermaid' && mode === 'rendered') return <iframe className="v2-ag-result-frame" sandbox="allow-scripts" src={`${src}?render`} title={detail.title} referrerPolicy="no-referrer" />;
  if (content === null) return <Skeleton lines={4} height={12} />;
  if (mode === 'source') return <pre className="v2-ag-code">{content}</pre>;
  if (detail.kind === 'csv') {
    const table = parseCsv(content);
    return (
      <div className="v2-ag-csv">
        <table>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (i === 0 ? <th key={j}>{cell}</th> : <td key={j}>{cell}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return <ChatMarkdown text={renderedMarkdown(detail.kind, detail.language, content) ?? content} testId="v2-agent-result-markdown" />;
}

/** The newest events of the agent for its timeline (the classic tab's first page, kept live). */
function useTimelineEvents(sessionId: string): readonly SessionEvent[] | null {
  const [events, setEvents] = useState<readonly SessionEvent[] | null>(null);
  useEffect(() => {
    let live = true;
    setEvents(null);
    api.sessionEventsPage(sessionId, { limit: TIMELINE_EVENTS_PAGE }).then(
      (page) => live && setEvents(page),
      () => live && setEvents([]),
    );
    return () => {
      live = false;
    };
  }, [sessionId]);
  useHubEvent('event', (payload) => {
    if (payload.sessionId !== sessionId) return;
    setEvents((current) => {
      if (!current) return current;
      const at = current.findIndex((e) => e.id === payload.event.id);
      if (at < 0) return [...current, payload.event];
      const next = [...current];
      next[at] = payload.event;
      return next;
    });
  });
  return events;
}

const LANE_COLORS: Readonly<Record<string, string>> = { plan: 'var(--v2-violet)', impl: 'var(--v2-blue)', loop: 'var(--v2-accent)', ask: 'var(--v2-amber-dot)', ok: 'var(--v2-green)', error: 'var(--v2-red)' };

/** The Timeline tab: one lane per helper (the classic timeline model, D95 window), the newest page of events. */
export function TimelineTab({ data }: { readonly data: AgentData }) {
  const events = useTimelineEvents(data.sessionId);
  const [now, setNow] = useState(() => Date.now());
  const live = data.session?.status === 'run' || data.session?.status === 'need';
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const session = data.session;
  const model = useMemo(
    () => (events && session ? timelineModel({ events, agents: session.agents.filter((a) => a.kind !== 'workflow'), status: session.status, now, play: PLAY_MAX, root: rootPath(session) }) : null),
    [events, session, now],
  );
  if (!model) return <Skeleton lines={4} height={20} />;
  if (model.empty) return <EmptyState icon="clock" tone="grey" title={AGENT_WORDS.noTimeline} />;
  return (
    <div className="v2-ag-tab" data-testid="v2-agent-timeline">
      <p className="v2-muted v2-ag-small" style={{ marginTop: 0 }}>
        {AGENT_WORDS.timelineNote} {model.range}
      </p>
      <div className="v2-ag-lanes">
        {model.lanes.map((lane) => (
          <div className="v2-ag-lane-row" key={lane.id ?? 'main'} data-testid="v2-agent-lane">
            <span className="v2-ag-lane-name" title={lane.sub}>
              {lane.name}
            </span>
            <div className="v2-ag-lane">
              {lane.blocks.map((block) => (
                <i key={block.id} title={`${block.label} · ${formatClock(block.start)}`} style={{ left: `${block.left}%`, width: `${Math.max(block.width, 0.6)}%`, background: LANE_COLORS[block.kind] ?? 'var(--v2-grey)' }} data-open={block.open ? 'true' : undefined}>
                  {block.label}
                </i>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="v2-row v2-ag-ticks v2-muted v2-ag-small">
        {model.ticks.map((tick, index) => (
          <span key={index}>{tick}</span>
        ))}
      </div>
    </div>
  );
}

/** The Helpers tab: each helper with its status, what it was asked, and its own chat. */
export function HelpersTab({ data, helperHref }: { readonly data: AgentData; readonly helperHref: (agentId: string) => string }) {
  const helpers = (data.session?.agents ?? []).filter((agent) => agent.kind !== 'main');
  if (!data.session) return <Skeleton lines={3} height={40} />;
  if (helpers.length === 0) return <EmptyState icon="crew" tone="grey" title={AGENT_WORDS.noHelpersTitle} text={AGENT_WORDS.noHelpersText} />;
  return (
    <div className="v2-ag-tab v2-ag-helpers" data-testid="v2-agent-helpers-tab">
      {helpers.map((agent) => (
        <Card key={agent.id} pad className="v2-ag-helper-card" data-testid="v2-agent-helper-card">
          <div className="v2-row">
            <span className="v2-ag-tav" aria-hidden="true">
              {(agent.description || agent.name).charAt(0).toUpperCase()}
            </span>
            <b className="v2-grow">{agent.description || agent.name}</b>
            <StatusBadge status={sessionStatusToV2(agent.status)} size="s" />
          </div>
          {agent.statusText ? <p className="v2-muted v2-ag-small">{agent.statusText}</p> : null}
          {hasSubagentChat(agent) ? (
            <V2Link to={helperHref(agent.id)} className="v2-btn" data-size="sm" data-testid="v2-agent-helper-card-open">
              {AGENT_WORDS.openHelperChat}
              <Icon name="chev" size="s" />
            </V2Link>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

/** Results for the chat's attachments (`placeResults`). */
export function resultRefs(artifacts: readonly Artifact[] | undefined): Array<{ id: string; title: string; kind: string; meta: string; createdAt: string }> {
  return (artifacts ?? []).map((a) => ({ id: a.id, title: a.title, kind: a.kind, meta: resultMeta(a.kind, a.versions), createdAt: a.createdAt }));
}

