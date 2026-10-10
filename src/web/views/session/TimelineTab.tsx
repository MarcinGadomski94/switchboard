import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session, SessionEvent } from '../../../core/api.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent, useHubStatus } from '../../api/useHub.ts';
import { useThrottled } from '../../api/useThrottled.ts';
import { rootPath } from './right-panel.ts';
import { type EventWindow, inWindow, pageCursor, withOlderPage } from './session-loading.ts';
import { terminalTail } from './terminal-tail.ts';
import {
  LOG_HEADING,
  PAUSE_LABEL,
  PLAY_LABEL,
  PLAY_MAX,
  PLAY_TICK_MS,
  EMPTY_SESSION_SOURCE,
  SHOW_EARLIER_LABEL,
  TIMELINE_EVENTS_PAGE,
  TIMELINE_TURNS,
  type SessionSource,
  playStep,
  sessionFetched,
  sessionPushed,
  sessionRefetching,
  shownSession,
  timelineModel,
  timelineWindow,
  windowAgents,
} from './timeline.ts';
import './timeline.css';

/**
 * A block is never narrower than its padding + border (6 + 6 + 1 + 1 px, box-sizing
 * border-box), so a point event (a result, a denial) near the axis end is kept inside the lane.
 */
const BLOCK_MIN_PX = 14;

/** The current time, refreshed every `ms` while `ms` is set. */
function useClock(ms: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ms === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** The loaded events of the session the hook is for (D95 follow-up: its newest pages). */
interface Loaded {
  readonly sessionId: string;
  readonly window: EventWindow;
}

/** What {@link useTimelineEvents} gives the tab. */
interface TimelineEvents {
  /** The loaded events with the `/hub` copies over them; `null` before the first page landed. */
  readonly events: readonly SessionEvent[] | null;
  /** `true` once the loaded events reach the session's first one. */
  readonly complete: boolean;
  /** An older page is being read. */
  readonly loadingOlder: boolean;
  /** The last read of an older page failed (the button retries). */
  readonly failed: boolean;
  /** Reads the page before the loaded events. */
  readonly loadOlder: () => void;
  /** After a failed read: reads it again (the newest page when none landed yet). */
  readonly retry: () => void;
}

/**
 * D95 follow-up (`docs/performance.md` → *Windowed Timeline*): the session's newest
 * events in pages of {@link TIMELINE_EVENTS_PAGE} (`GET /api/sessions/{id}/events?limit=&before=`),
 * older pages on demand, plus every `/hub` `event` for the session that belongs in
 * them (new events and updates, e.g. a tool call's result; `inWindow`). The newest
 * page is read again when the hub stream reopens after a drop (older pages are then
 * read again as the window needs them). A machine without paging answers every
 * event: complete at once.
 */
function useTimelineEvents(sessionId: string, onUnknownAgent: (agentId: string) => void): TimelineEvents {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [pushed, setPushed] = useState<ReadonlyMap<number, SessionEvent>>(() => new Map());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [failed, setFailed] = useState(false);
  /** Bumped by every newest-page read: an older page asked for before it is dropped. */
  const generation = useRef(0);

  const loadNewest = useCallback(() => {
    const gen = ++generation.current;
    setLoadingOlder(false);
    api.sessionEventsPage(sessionId, { limit: TIMELINE_EVENTS_PAGE }).then(
      (page) => {
        if (gen !== generation.current) return;
        setLoaded({ sessionId, window: { list: page, cursor: pageCursor(page, TIMELINE_EVENTS_PAGE) } });
        setFailed(false);
      },
      () => {
        if (gen === generation.current) setFailed(true);
      },
    );
  }, [sessionId]);

  useEffect(() => {
    setLoaded(null);
    setPushed(new Map());
    setFailed(false);
    loadNewest();
    return () => {
      generation.current += 1;
    };
  }, [loadNewest]);

  const current = loaded !== null && loaded.sessionId === sessionId ? loaded : null;
  const cursor = current?.window.cursor ?? null;
  const loadOlder = useCallback(() => {
    if (cursor === null || loadingOlder) return;
    const gen = generation.current;
    setLoadingOlder(true);
    setFailed(false);
    api.sessionEventsPage(sessionId, { limit: TIMELINE_EVENTS_PAGE, before: cursor.id }).then(
      (page) => {
        if (gen !== generation.current) return;
        setLoaded((prev) => (prev !== null && prev.sessionId === sessionId ? { sessionId, window: withOlderPage(prev.window, page, TIMELINE_EVENTS_PAGE) } : prev));
        setLoadingOlder(false);
      },
      () => {
        if (gen !== generation.current) return;
        setLoadingOlder(false);
        setFailed(true);
      },
    );
  }, [sessionId, cursor, loadingOlder]);

  useHubEvent('event', (payload) => {
    if (payload.sessionId !== sessionId) return;
    setPushed((prev) => new Map(prev).set(payload.event.id, payload.event));
    if (payload.event.agentId !== null) onUnknownAgent(payload.event.agentId);
  });

  const hub = useHubStatus();
  const wasOpen = useRef(false);
  useEffect(() => {
    if (hub === 'open' && wasOpen.current === false) {
      // Events missed while the stream was down: the newest page again (the first open needs nothing).
      if (current !== null) loadNewest();
      wasOpen.current = true;
    } else if (hub !== 'open') {
      wasOpen.current = false;
    }
    // Only the hub status decides; `current` is read, not watched.
  }, [hub, loadNewest]);

  const events = useMemo(() => {
    if (current === null) return null;
    const byId = new Map<number, SessionEvent>();
    for (const event of current.window.list) byId.set(event.id, event);
    // Hub copies arrive in order, so the newest one of an event wins; one older than the loaded pages waits for its page.
    for (const [id, event] of pushed) if (inWindow(current.window, event)) byId.set(id, event);
    return [...byId.values()];
  }, [current, pushed]);

  const retry = current === null ? loadNewest : loadOlder;
  return { events, complete: current !== null && cursor === null, loadingOlder, failed, loadOlder, retry };
}

/**
 * Timeline tab (SPEC → Session → Timeline; M4.4): a 150px label column, 34px lanes
 * per agent with blocks colored by kind (plan / impl / loop / ask / ok, plus error),
 * a white playhead, a range scrubber with ▶ / ❚❚, the "Events up to" log and the
 * terminal tail. Real data only: the session's events and agents through the API
 * and `/hub` (`docs/derivations.md` → *Timeline tab*, *Terminal tail*).
 */
export function TimelineTab({ sessionId }: { readonly sessionId: string }) {
  const detail = useApi(() => api.getSession(sessionId), [sessionId]);
  const [source, setSource] = useState<SessionSource>(EMPTY_SESSION_SOURCE);
  useEffect(() => setSource(EMPTY_SESSION_SOURCE), [sessionId]);
  useHubEvent('sessionUpdated', (pushed) => {
    if (pushed.id === sessionId) setSource((prev) => sessionPushed(prev, pushed));
  });
  const fetchedSession = detail.data;
  useEffect(() => setSource(sessionFetched), [fetchedSession]);
  const session: Session | null = shownSession(source, fetchedSession);
  // D51: a Workflow's agents have no events of the session (their chats read their transcripts): no empty lanes.
  const agents = (session?.agents ?? []).filter((agent) => agent.kind !== 'workflow');

  // A subagent appears without a sessionUpdated (its status is not a session status change): refetch.
  // The /hub copy stays until the refetch lands (`SessionSource`), so no lane blinks meanwhile.
  const reloadDetail = detail.reload;
  const refetchAgents = useThrottled(() => {
    setSource(sessionRefetching);
    reloadDetail();
  }, 300);
  const agentIds = useRef<ReadonlySet<string>>(new Set());
  agentIds.current = new Set(agents.map((agent) => agent.id));
  const onUnknownAgent = useCallback(
    (agentId: string) => {
      if (!agentIds.current.has(agentId)) refetchAgents();
    },
    [refetchAgents],
  );
  const loaded = useTimelineEvents(sessionId, onUnknownAgent);

  // D95 follow-up: the last `turns` turns, lanes only for the agents active in them.
  const [turns, setTurns] = useState(TIMELINE_TURNS);
  useEffect(() => setTurns(TIMELINE_TURNS), [sessionId]);
  const range = useMemo(() => timelineWindow(loaded.events ?? [], loaded.complete, turns), [loaded.events, loaded.complete, turns]);
  const events = range.shown;
  const { loadOlder, loadingOlder, failed } = loaded;
  useEffect(() => {
    // Fewer turns loaded than shown: the page before (one at a time; a failed read waits for the button).
    if (range.needMore && !loadingOlder && !failed) loadOlder();
  }, [range.needMore, loadingOlder, failed, loadOlder]);
  const showEarlier = (): void => {
    if (failed) loaded.retry();
    else setTurns((n) => n + TIMELINE_TURNS);
  };
  const laneAgents = useMemo(() => windowAgents(agents, events), [agents, events]);

  const [play, setPlay] = useState(PLAY_MAX);
  const [playing, setPlaying] = useState(false);
  const playRef = useRef(play);
  playRef.current = play;
  useEffect(() => {
    setPlay(PLAY_MAX);
    setPlaying(false);
  }, [sessionId]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const step = playStep(playRef.current);
      playRef.current = step.play;
      setPlay(step.play);
      if (!step.playing) setPlaying(false);
    }, PLAY_TICK_MS);
    return () => clearInterval(timer);
  }, [playing]);
  const togglePlay = (): void => {
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

  const status = session?.status ?? null;
  const [clockMs, setClockMs] = useState<number | null>(null);
  const now = useClock(clockMs);
  const root = session ? rootPath(session) : undefined;
  const model = useMemo(() => timelineModel({ events, agents: laneAgents, status, now, play, root }), [events, laneAgents, status, now, play, root]);
  useEffect(() => setClockMs(model.ticking ? 1_000 : null), [model.ticking]);
  const lines = useMemo(() => terminalTail(events, agents), [events, agents]);

  const head: CSSProperties = { left: `${model.head}%` };
  return (
    <div className="sb-timeline" data-testid="session-timeline" data-session-id={sessionId} data-empty={model.empty ? 'true' : 'false'}>
      <div className="sb-timeline__axis">
        <span data-testid="timeline-range">{model.range}</span>
        <div className="sb-timeline__ticks" data-testid="timeline-ticks">
          {model.ticks.map((tick, index) => (
            <span key={index}>{tick}</span>
          ))}
        </div>
      </div>
      {range.earlier || failed ? (
        <div className="sb-timeline__earlier" data-testid="timeline-earlier" data-state={loadingOlder || range.needMore ? 'loading' : failed ? 'failed' : 'idle'}>
          {loadingOlder || (range.needMore && !failed) ? (
            <span role="status">Loading earlier events…</span>
          ) : (
            <button type="button" className="sb-button sb-timeline__earlier-button" data-testid="timeline-earlier-load" onClick={showEarlier}>
              {failed ? 'Could not load earlier events · Retry' : SHOW_EARLIER_LABEL}
            </button>
          )}
          <span className="sb-timeline__earlier-note" data-testid="timeline-window-note">
            Last {turns} turns
          </span>
        </div>
      ) : null}
      {model.lanes.map((lane) => (
        <div className="sb-timeline__row" key={lane.id ?? 'session'} data-testid="timeline-lane" data-agent-id={lane.id ?? ''} data-agent={lane.name}>
          <div className="sb-timeline__label">
            <span className="sb-timeline__name">{lane.name}</span>
            <span className="sb-timeline__sub">{lane.sub}</span>
          </div>
          <div className="sb-timeline__lane" data-testid="timeline-track">
            {lane.blocks.map((block) => (
              <div
                key={block.id}
                className="sb-timeline__block"
                data-testid="timeline-block"
                data-event-id={block.id}
                data-kind={block.kind}
                data-open={block.open ? 'true' : 'false'}
                data-dim={block.dim ? 'true' : 'false'}
                title={block.label}
                style={{ left: `min(${block.left}%, calc(100% - ${BLOCK_MIN_PX}px))`, width: `${block.width}%`, opacity: block.dim ? 0.35 : 1 }}
              >
                {block.label}
              </div>
            ))}
            <div className="sb-timeline__playhead" data-testid="timeline-playhead" style={head} />
          </div>
        </div>
      ))}
      <div className="sb-timeline__controls">
        <div className="sb-timeline__play-row">
          <button
            type="button"
            className="sb-button sb-timeline__play"
            data-testid="timeline-play"
            aria-label={playing ? 'Pause' : 'Play'}
            onClick={togglePlay}
          >
            {playing ? PAUSE_LABEL : PLAY_LABEL}
          </button>
          <span className="sb-timeline__now" data-testid="timeline-now">
            {model.now}
          </span>
        </div>
        <input
          type="range"
          className="sb-timeline__scrubber"
          data-testid="timeline-scrubber"
          aria-label="Timeline position"
          min={0}
          max={PLAY_MAX}
          value={play}
          onChange={(event) => setPlay(Number(event.target.value))}
        />
      </div>
      <div className="sb-timeline__bottom">
        <div className="sb-timeline__log" data-testid="timeline-log">
          <div className="sb-timeline__log-head" data-testid="timeline-log-head">
            {LOG_HEADING} {model.now}
          </div>
          {model.log.map((entry) => (
            <div className="sb-timeline__log-row" key={entry.id} data-testid="timeline-log-entry" data-kind={entry.kind}>
              <span className="sb-timeline__log-time">{entry.time}</span>
              <span className="sb-timeline__log-dot" data-kind={entry.kind} />
              <span>
                <span className="sb-timeline__log-who">{entry.who} · </span>
                {entry.label}
              </span>
            </div>
          ))}
        </div>
        <div className="sb-timeline__terminal" data-testid="timeline-terminal">
          {lines.map((line) => (
            <div className="sb-timeline__term-line" key={line.key} data-testid="timeline-terminal-line" data-tone={line.tone}>
              {line.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
