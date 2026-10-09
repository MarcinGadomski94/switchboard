import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '../../core/api.ts';
import { ApiError, api, machineApi } from '../api/client.ts';
import { MachineTag } from '../components/MachineTag.tsx';
import { useApi } from '../api/useApi.ts';
import { useHubEvent, useHubStatus } from '../api/useHub.ts';
import { useMachineStateChange } from '../api/useMachines.ts';
import { useRouter } from '../router.tsx';
import { CELL_COLOR, TERMINAL_LOOP_NOTE, type LoopCardModel, loopCards } from './loops.ts';
import './loops.css';
import { OwnedLoopCard } from './OwnedLoops.tsx';
import { CLI_MANAGED_NOTE, ownedLoopCards } from './owned-loops.ts';

/** Relative facts ("in 6 days", "15:00") are re-rendered this often. */
const CLOCK_MS = 30_000;
/** D52: the terminal sessions' loops (no events: read from transcripts) are read again this often. */
const TERMINAL_LOOPS_MS = 15_000;

/**
 * Loop cards of the Schedules & loops view (M7.2, D9; SPEC → Schedules & loops):
 * one card per loop observed in a session, two per row, with the session's status
 * dot, the loop's label, the iteration strip, three facts, the note and "Open
 * session". Data: `GET /api/sessions` (`Session.loops`), kept live with the
 * `sessionUpdated` hub event and fetched again when the hub stream reopens. D52:
 * plus `GET /api/terminal-loops` (terminal sessions not followed here, read from
 * their transcripts; polled), whose cards offer "Hook into…"; a paired machine's
 * loops carry its tag.
 */
export function LoopCards() {
  const { navigate } = useRouter();
  const fetched = useApi(api.listSessions);
  // D52: loops of terminal sessions Switchboard does not follow (this machine's and the paired machines'); none on a failed read.
  const terminal = useApi(api.terminalLoops);
  const [hooking, setHooking] = useState<string | null>(null);
  const [hookError, setHookError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<readonly Session[] | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (fetched.data) setSessions(fetched.data);
  }, [fetched.data]);

  // Fix · peer reconnects: a paired machine's state changed: its terminal loops' blocks follow at once.
  useMachineStateChange(terminal.reload);
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
  const reloadTerminal = terminal.reload;
  useEffect(() => {
    const timer = setInterval(() => reloadTerminal(), TERMINAL_LOOPS_MS);
    return () => clearInterval(timer);
  }, [reloadTerminal]);

  const cards = useMemo(() => (sessions ? loopCards(sessions, now, terminal.data ?? []) : []), [sessions, now, terminal.data]);
  // D94: the loops Switchboard runs itself come first, as first-class cards with actions.
  const owned = useMemo(() => (sessions ? ownedLoopCards(sessions, now) : []), [sessions, now]);
  const open = useCallback((sessionId: string) => navigate({ view: 'session', id: sessionId, tab: 'chat' }), [navigate]);
  // D52 / D48 P4: "Hook into…" a terminal session's loop: the machine follows it; its view opens.
  const hook = async (card: LoopCardModel): Promise<void> => {
    if (!card.terminalId) return;
    setHooking(card.id);
    setHookError(null);
    try {
      const session = await machineApi(card.machine?.id ?? null).hookTerminal(card.terminalId);
      navigate({ view: 'session', id: session.id, tab: 'chat' });
    } catch (caught) {
      const error = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
      const message = (error.body as { message?: unknown } | null)?.message;
      setHookError(`Not hooked: ${typeof message === 'string' && message !== '' ? message : error.unreachable ? 'Switchboard is not reachable.' : `HTTP ${error.status}`}`);
      reloadTerminal();
    } finally {
      setHooking(null);
    }
  };
  const state = sessions === null ? (fetched.error ? 'error' : 'loading') : 'ready';

  return (
    <div className="sb-loops" data-testid="loop-cards" data-tour="loop-cards" data-state={state} data-count={cards.length} data-owned-count={owned.length}>
      {state === 'ready' && cards.length === 0 && owned.length === 0 ? (
        <div className="sb-loops__empty" data-testid="loop-cards-empty">
          No loops yet. Create one with + New loop (or a session's ⋯ → New loop…); agents create them with the switchboard loop_create tool. A card also appears when a session's CLI runs /loop, ScheduleWakeup, CronCreate or Workflow.
        </div>
      ) : null}
      {owned.map((card) => (
        <OwnedLoopCard key={card.id} card={card} />
      ))}
      {cards.map((card) => (
        <div
          key={card.id}
          className="sb-loop"
          style={{ borderColor: card.border }}
          data-testid="loop-card"
          data-loop-id={card.id}
          data-session-id={card.sessionId}
          data-status={card.status}
          data-machine={card.machine?.id}
          data-terminal={card.terminalId ? 'true' : undefined}
        >
          <div className="sb-loop__head">
            <span className="sb-loop__dot" style={{ background: card.dot }} data-testid="loop-dot" />
            <span className="sb-loop__name" data-testid="loop-name">
              {card.sessionName}
            </span>
            {/* D52: a paired machine's loop names its machine. */}
            <MachineTag machine={card.machine} testId="loop-machine" />
            <span className="sb-loop__kind" data-testid="loop-kind">
              {card.kind}
            </span>
            {card.terminalId ? (
              <button
                type="button"
                className="sb-button sb-loop__open"
                data-testid="loop-hook"
                title={card.blocked ?? 'Follow this terminal session in Switchboard (D48 hooks) and open it'}
                disabled={card.blocked !== null || hooking === card.id}
                onClick={() => void hook(card)}
              >
                Hook into…
              </button>
            ) : (
              <button type="button" className="sb-button sb-loop__open" data-testid="loop-open" onClick={() => open(card.sessionId)}>
                Open session
              </button>
            )}
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
          {/* D94: Switchboard only observes these: the CLI runs them (a corner tag, out of the card's flow). */}
          <span className="sb-loop__managed" data-testid="loop-managed">
            {CLI_MANAGED_NOTE}
          </span>
          {card.terminalId ? (
            <div className="sb-loop__note" data-testid="loop-why">
              {card.blocked ?? TERMINAL_LOOP_NOTE}
            </div>
          ) : null}
        </div>
      ))}
      {hookError ? (
        <div className="sb-loops__empty" data-testid="loop-hook-error" role="alert">
          {hookError}
        </div>
      ) : null}
    </div>
  );
}
