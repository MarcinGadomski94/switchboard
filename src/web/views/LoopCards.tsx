import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '../../core/api.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent, useHubStatus } from '../api/useHub.ts';
import { useRouter } from '../router.tsx';
import { CELL_COLOR, loopCards } from './loops.ts';
import './loops.css';

/** Relative facts ("in 6 days", "15:00") are re-rendered this often. */
const CLOCK_MS = 30_000;

/**
 * Loop cards of the Schedules & loops view (M7.2, D9; SPEC → Schedules & loops):
 * one card per loop observed in a session, two per row, with the session's status
 * dot, the loop's label, the iteration strip, three facts, the note and "Open
 * session". Data: `GET /api/sessions` (`Session.loops`), kept live with the
 * `sessionUpdated` hub event and fetched again when the hub stream reopens.
 */
export function LoopCards() {
  const { navigate } = useRouter();
  const fetched = useApi(api.listSessions);
  const [sessions, setSessions] = useState<readonly Session[] | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (fetched.data) setSessions(fetched.data);
  }, [fetched.data]);

  useHubEvent('sessionUpdated', (session) => {
    setSessions((current) => {
      if (current === null) return current;
      const at = current.findIndex((s) => s.id === session.id);
      if (at < 0) return [...current, session];
      const next = [...current];
      next[at] = session;
      return next;
    });
  });

  const hub = useHubStatus();
  const wasOpen = useRef<boolean | null>(null);
  const reload = fetched.reload;
  useEffect(() => {
    if (hub === 'open') {
      if (wasOpen.current === false) reload();
      wasOpen.current = true;
    } else if (wasOpen.current === true) {
      wasOpen.current = false;
    }
  }, [hub, reload]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const cards = useMemo(() => (sessions ? loopCards(sessions, now) : []), [sessions, now]);
  const open = useCallback((sessionId: string) => navigate({ view: 'session', id: sessionId, tab: 'chat' }), [navigate]);
  const state = sessions === null ? (fetched.error ? 'error' : 'loading') : 'ready';

  return (
    <div className="sb-loops" data-testid="loop-cards" data-state={state} data-count={cards.length}>
      {state === 'ready' && cards.length === 0 ? (
        <div className="sb-loops__empty" data-testid="loop-cards-empty">
          No loops yet. A card appears when a session runs /loop, ScheduleWakeup, CronCreate or Workflow.
        </div>
      ) : null}
      {cards.map((card) => (
        <div
          key={card.id}
          className="sb-loop"
          style={{ borderColor: card.border }}
          data-testid="loop-card"
          data-loop-id={card.id}
          data-session-id={card.sessionId}
          data-status={card.status}
        >
          <div className="sb-loop__head">
            <span className="sb-loop__dot" style={{ background: card.dot }} data-testid="loop-dot" />
            <span className="sb-loop__name" data-testid="loop-name">
              {card.sessionName}
            </span>
            <span className="sb-loop__kind" data-testid="loop-kind">
              {card.kind}
            </span>
            <button type="button" className="sb-button sb-loop__open" data-testid="loop-open" onClick={() => open(card.sessionId)}>
              Open session
            </button>
          </div>
          {card.cells.length > 0 ? (
            <div className="sb-loop__strip" data-testid="loop-strip">
              {card.cells.map((cell, i) => (
                <span key={i} className="sb-loop__cell" data-result={cell} style={{ background: CELL_COLOR[cell] }} />
              ))}
            </div>
          ) : null}
          <div className="sb-loop__facts">
            {card.facts.map((fact) => (
              <div key={fact.k} className="sb-loop__fact" data-testid="loop-fact">
                <span className="sb-loop__fact-k">{fact.k}</span>
                <span className="sb-loop__fact-v">{fact.v}</span>
              </div>
            ))}
          </div>
          {card.note ? (
            <div className="sb-loop__note" data-testid="loop-note">
              {card.note}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
