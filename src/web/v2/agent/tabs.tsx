import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, ArtifactListItem, DiffScope, SessionEvent } from '../../../core/api.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { deleteErrorText } from '../../views/session/ArtifactDelete.tsx';
import { deltaText, diffModel, fileKey, scopeOptions, shownScope } from '../../views/session/diff.ts';
import { useDiffScope } from '../../views/session/useDiffScope.ts';
import { useSessionRefresh } from '../../views/session/useSessionRefresh.ts';
import { hasSubagentChat } from '../../views/session/chat.ts';
import { PLAY_MAX, PLAY_TICK_MS, TIMELINE_EVENTS_PAGE, formatClock, playStep, timelineModel } from '../../views/session/timeline.ts';
import { rootPath } from '../../views/session/right-panel.ts';
import { Button, Card, Chip, EmptyState, Icon, IconButton, Segmented, Skeleton, StatusBadge, TOAST_MS, useToast } from '../components/index.ts';
import { AGENT_WORDS, RESULTS_WORDS, sessionStatusToV2 } from '../glossary.ts';
import { V2Link, useV2Router } from '../nav.tsx';
import { ResultDrawer } from '../results/ResultDrawer.tsx';
import { resultMeta } from './chat-model.ts';
import { openResult, resultItemOf, shownResults } from './results-bits.ts';
import { LOG_LOOKS, SCRUB_STEP, blockOf, nextMoment, playOf, previousMoment } from './timeline-model.ts';
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

/**
 * D89 · this agent's results (artifacts), newest first; a click opens lane R's
 * result drawer (versions, Compare, Source / Rendered, Copy, Download, Full
 * screen), the same drawer as the Results page. Delete hides the result at once
 * and deletes it when the toast's Undo window ends (D111, as the Results page).
 */
export function ResultsTab({ data, resultId, onOpen }: { readonly data: AgentData; readonly resultId: string | null; readonly onOpen?: (id: string | null) => void }) {
  const { navigate } = useV2Router();
  const toast = useToast();
  const session = data.session;
  const results = session?.artifacts ?? null;
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef(new Map<string, number>());
  const open = useCallback(
    (id: string | null): void => {
      if (onOpen) onOpen(id);
      else navigate(id ? `/agents/${encodeURIComponent(data.sessionId)}/results/${encodeURIComponent(id)}` : `/agents/${encodeURIComponent(data.sessionId)}/results`, id ? undefined : { replace: true });
    },
    [onOpen, navigate, data.sessionId],
  );
  const sessionId = data.sessionId;
  const reload = data.reload;
  const send = useCallback(
    (id: string): void => {
      const timer = timers.current.get(id);
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timers.current.delete(id);
      api.deleteArtifact(sessionId, id).then(
        () => reload(),
        (caught: unknown) => {
          toast({ text: deleteErrorText(caught), tone: 'error' });
          setPending((current) => new Set([...current].filter((key) => key !== id)));
          reload();
        },
      );
    },
    [sessionId, reload, toast],
  );
  // Leaving the agent sends the deletes still in their Undo window at once.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const id of [...map.keys()]) sendRef.current(id);
    };
  }, []);
  const remove = (item: ArtifactListItem): void => {
    open(null);
    setPending((current) => new Set([...current, item.id]));
    timers.current.set(
      item.id,
      window.setTimeout(() => send(item.id), TOAST_MS),
    );
    toast({
      text: RESULTS_WORDS.deleted(1),
      undo: () => {
        const timer = timers.current.get(item.id);
        if (timer !== undefined) window.clearTimeout(timer);
        timers.current.delete(item.id);
        setPending((current) => new Set([...current].filter((key) => key !== item.id)));
      },
    });
  };
  const opened = openResult(results, resultId);
  const goneShown = useRef<string | null>(null);
  useEffect(() => {
    // A link to a result this agent does not have (deleted, or a typo): say so and drop it.
    if (opened !== null || resultId === null || pending.has(resultId) || goneShown.current === resultId) return;
    goneShown.current = resultId;
    toast({ text: RESULTS_WORDS.notFound, tone: 'error' });
    open(null);
  }, [opened, resultId, pending, toast, open]);
  if (results === null || !session) return <Skeleton lines={3} height={60} />;
  const shown = shownResults(results, pending);
  const item = opened && !pending.has(opened.id) ? resultItemOf(opened, session, data.sessionId) : null;
  return (
    <div className="v2-ag-tab" data-testid="v2-agent-results">
      {shown.length === 0 ? (
        <EmptyState icon="results" tone="grey" title={AGENT_WORDS.noResults} text={AGENT_WORDS.noResultsText} />
      ) : (
        <div className="v2-ag-rgrid">
          {shown.map((artifact) => (
            <Card key={artifact.id} interactive className="v2-ag-rcard" data-testid="v2-agent-result-card" data-result-id={artifact.id} onClick={() => open(artifact.id)}>
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
      <ResultDrawer item={item} onClose={() => open(null)} openAgent={false} {...(data.blocked === null ? { onDelete: remove } : {})} />
    </div>
  );
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

/** `true` while the developer asked for reduced motion (Play then steps from event to event instead of animating). */
function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const on = (): void => setReduced(list.matches);
    list.addEventListener('change', on);
    return () => list.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * The Timeline tab: one lane per helper (the classic timeline model, D95 window),
 * the newest page of events. Lane X: the playback scrubber (Play / Pause, drag or
 * arrow keys to a moment, ⇧← / ⇧→ to the previous / next event; the lanes dim
 * what happens after the playhead) and the event log up to that moment (a row
 * moves the playhead there and marks its block). With reduced motion Play steps
 * to the next event instead of animating.
 */
export function TimelineTab({ data }: { readonly data: AgentData }) {
  const events = useTimelineEvents(data.sessionId);
  const [now, setNow] = useState(() => Date.now());
  const [play, setPlay] = useState(PLAY_MAX);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const reduced = useReducedMotion();
  const playRef = useRef(play);
  playRef.current = play;
  const live = data.session?.status === 'run' || data.session?.status === 'need';
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  useEffect(() => {
    setPlay(PLAY_MAX);
    setPlaying(false);
    setSelected(null);
  }, [data.sessionId]);
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => {
      const step = playStep(playRef.current);
      playRef.current = step.play;
      setPlay(step.play);
      if (!step.playing) setPlaying(false);
    }, PLAY_TICK_MS);
    return () => clearInterval(timer);
  }, [playing]);
  const session = data.session;
  const model = useMemo(
    () => (events && session ? timelineModel({ events, agents: session.agents.filter((a) => a.kind !== 'workflow'), status: session.status, now, play, root: rootPath(session) }) : null),
    [events, session, now, play],
  );
  if (!model) return <Skeleton lines={4} height={20} />;
  if (model.empty) return <EmptyState icon="clock" tone="grey" title={AGENT_WORDS.noTimeline} />;
  const lanes = model.lanes;
  const seek = (value: number): void => {
    setPlaying(false);
    setPlay(Math.min(PLAY_MAX, Math.max(0, value)));
  };
  const togglePlay = (): void => {
    if (reduced) {
      // No animation: one step to the next event (from the start again once at the end).
      seek(play >= PLAY_MAX ? 0 : nextMoment(lanes, play));
      return;
    }
    if (playing) {
      setPlaying(false);
      return;
    }
    if (play >= PLAY_MAX) {
      playRef.current = 0;
      setPlay(0);
    }
    setPlaying(true);
  };
  const pick = (id: number): void => {
    const block = blockOf(lanes, id);
    setSelected(id);
    if (block) seek(playOf(block.left));
  };
  return (
    <div className="v2-ag-tab v2-ag-tl" data-testid="v2-agent-timeline" data-play={play} data-playing={playing ? 'true' : 'false'}>
      <p className="v2-muted v2-ag-small" style={{ marginTop: 0 }}>
        {AGENT_WORDS.timelineNote} {model.range}
      </p>
      <div className="v2-ag-lanes">
        {lanes.map((lane) => (
          <div className="v2-ag-lane-row" key={lane.id ?? 'main'} data-testid="v2-agent-lane">
            <span className="v2-ag-lane-name" title={lane.sub}>
              {lane.name}
            </span>
            <div className="v2-ag-lane">
              {lane.blocks.map((block) => (
                <i
                  key={block.id}
                  title={`${block.label} · ${formatClock(block.start)}`}
                  style={{ left: `${block.left}%`, width: `${Math.max(block.width, 0.6)}%`, background: LANE_COLORS[block.kind] ?? 'var(--v2-grey)' }}
                  data-open={block.open ? 'true' : undefined}
                  data-dim={block.dim ? 'true' : undefined}
                  data-selected={block.id === selected ? 'true' : undefined}
                  data-testid="v2-agent-timeline-block"
                  data-event-id={block.id}
                >
                  {block.label}
                </i>
              ))}
              <span className="v2-ag-playhead" aria-hidden="true" style={{ left: `${model.head}%` }} data-testid="v2-agent-playhead" />
            </div>
          </div>
        ))}
      </div>
      <div className="v2-row v2-ag-ticks v2-muted v2-ag-small">
        {model.ticks.map((tick, index) => (
          <span key={index}>{tick}</span>
        ))}
      </div>
      <div className="v2-ag-tl-controls" role="group" aria-label={AGENT_WORDS.playback}>
        <div className="v2-row v2-ag-tl-buttons">
          <IconButton icon="back" label={AGENT_WORDS.previousEvent} data-testid="v2-agent-timeline-prev" onClick={() => seek(previousMoment(lanes, play))} />
          <Button size="sm" variant="primary" icon={playing ? 'pause' : 'play'} data-testid="v2-agent-timeline-play" aria-pressed={playing} title={reduced ? AGENT_WORDS.playReducedHint : undefined} onClick={togglePlay}>
            {playing ? AGENT_WORDS.pausePlayback : reduced ? AGENT_WORDS.nextEvent : AGENT_WORDS.play}
          </Button>
          <IconButton icon="chev" label={AGENT_WORDS.nextEvent} data-testid="v2-agent-timeline-next" onClick={() => seek(nextMoment(lanes, play))} />
          <span className="v2-ag-tl-now" data-testid="v2-agent-timeline-now">
            {model.now}
          </span>
          <span className="v2-grow" />
          <Button size="sm" variant="ghost" icon="clock" data-testid="v2-agent-timeline-live" disabled={play >= PLAY_MAX} onClick={() => seek(PLAY_MAX)}>
            {AGENT_WORDS.toNow}
          </Button>
        </div>
        <input
          type="range"
          className="v2-ag-scrubber"
          data-testid="v2-agent-timeline-scrubber"
          aria-label={AGENT_WORDS.timelinePosition}
          aria-valuetext={model.now}
          aria-keyshortcuts="Shift+ArrowLeft Shift+ArrowRight"
          min={0}
          max={PLAY_MAX}
          step={SCRUB_STEP}
          value={play}
          onChange={(event) => seek(Number(event.target.value))}
          onKeyDown={(event) => {
            if (!event.shiftKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
            event.preventDefault();
            seek(event.key === 'ArrowLeft' ? previousMoment(lanes, play) : nextMoment(lanes, play));
          }}
        />
      </div>
      <section className="v2-ag-tl-log" aria-label={AGENT_WORDS.eventLog} data-testid="v2-agent-timeline-log">
        <h3 className="v2-ag-tl-log-h">{AGENT_WORDS.eventsUpTo(model.now)}</h3>
        {model.log.length === 0 ? (
          <p className="v2-muted v2-ag-small">{AGENT_WORDS.noEventsYet}</p>
        ) : (
          <ol>
            {model.log.map((entry) => {
              const look = LOG_LOOKS[entry.kind];
              // The log's own clock has no seconds; the playhead's does, so the rows say the second too.
              const start = blockOf(lanes, entry.id)?.start ?? null;
              return (
                <li key={entry.id}>
                  <button type="button" className="v2-ag-tl-row" aria-pressed={entry.id === selected} data-testid="v2-agent-timeline-entry" data-event-id={entry.id} data-kind={entry.kind} onClick={() => pick(entry.id)}>
                    <span className="v2-ag-tl-time v2-mono">{start === null ? entry.time : formatClock(start, true)}</span>
                    <Chip tone={look.tone} icon={look.icon} size="s">
                      {look.word}
                    </Chip>
                    <span className="v2-ag-tl-what">
                      <b>{entry.who}</b> · {entry.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>
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

