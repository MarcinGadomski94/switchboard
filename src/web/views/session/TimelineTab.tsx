import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session, SessionEvent } from '../../../core/api.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent, useHubStatus } from '../../api/useHub.ts';
import { useThrottled } from '../../api/useThrottled.ts';
import { rootPath } from './right-panel.ts';
import { terminalTail } from './terminal-tail.ts';
import {
  LOG_HEADING,
  PAUSE_LABEL,
  PLAY_LABEL,
  PLAY_MAX,
  PLAY_TICK_MS,
  playStep,
  timelineModel,
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

/**
 * The session's events: `GET /api/sessions/{id}/events` plus every `/hub` `event`
 * for the session (new events and updates, e.g. a tool call's result), fetched
 * again when the hub stream reopens after a drop.
 */
function useSessionEvents(sessionId: string, onUnknownAgent: (agentId: string) => void): SessionEvent[] {
  const fetched = useApi(() => api.sessionEvents(sessionId), [sessionId]);
  const [pushed, setPushed] = useState<ReadonlyMap<number, SessionEvent>>(() => new Map());
  useEffect(() => setPushed(new Map()), [sessionId]);

  useHubEvent('event', (payload) => {
    if (payload.sessionId !== sessionId) return;
    setPushed((prev) => new Map(prev).set(payload.event.id, payload.event));
    if (payload.event.agentId !== null) onUnknownAgent(payload.event.agentId);
  });

  const hub = useHubStatus();
  const wasOpen = useRef(false);
  const reload = fetched.reload;
  useEffect(() => {
    if (hub === 'open' && wasOpen.current === false) {
      if (fetched.data !== null) reload();
      wasOpen.current = true;
    } else if (hub !== 'open') {
      wasOpen.current = false;
    }
    // Only the hub status decides; `fetched.data` is read, not watched.
  }, [hub, reload]);

  return useMemo(() => {
    const byId = new Map<number, SessionEvent>();
    for (const event of fetched.data ?? []) byId.set(event.id, event);
    // Hub copies arrive in order, so the newest one of an event wins.
    for (const [id, event] of pushed) byId.set(id, event);
    return [...byId.values()];
  }, [fetched.data, pushed]);
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
  const [pushedSession, setPushedSession] = useState<Session | null>(null);
  useEffect(() => setPushedSession(null), [sessionId]);
  useHubEvent('sessionUpdated', (session) => {
    if (session.id === sessionId) setPushedSession(session);
  });
  const session: Session | null = pushedSession ?? detail.data;
  const agents = session?.agents ?? [];

  // A subagent appears without a sessionUpdated (its status is not a session status change): refetch.
  const reloadDetail = detail.reload;
  const refetchAgents = useThrottled(() => {
    setPushedSession(null);
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
  const events = useSessionEvents(sessionId, onUnknownAgent);

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
  const model = useMemo(() => timelineModel({ events, agents, status, now, play, root }), [events, agents, status, now, play, root]);
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
