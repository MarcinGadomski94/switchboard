import { useEffect, useRef, useState } from 'react';
import type { Session } from '../../core/api.ts';
import { openTakeover } from './store.ts';
import { TAKE_OVER_LABEL, moveLabel, offersTakeover } from './takeover.ts';
import { usePairedMachines } from './usePairedMachines.ts';
import './takeover.css';

/**
 * D65: the header's take-over action. A peer's session: **Take over to this
 * machine**. A session of this machine: **Move to <machine> ▸** (one reachable
 * machine opens the dialog at once, several open a small menu of them). Hidden for
 * a session that cannot be taken over (closed, already moved, the peer unreachable)
 * and when no machine is paired.
 */
export function TakeoverAction({ session, sessionId }: { readonly session: Session | null; readonly sessionId: string }) {
  const offered = session !== null && offersTakeover(session);
  const peer = session?.machine ?? null;
  const { machines } = usePairedMachines(offered && peer === null);
  const [menu, setMenu] = useState(false);
  const holder = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (event: MouseEvent): void => {
      if (holder.current && !holder.current.contains(event.target as Node)) setMenu(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menu]);
  useEffect(() => setMenu(false), [sessionId]);
  if (!session || !offered) return null;
  const title = session.displayTitle ?? session.title ?? session.name;
  if (peer) {
    return (
      <button
        type="button"
        className="sb-button sb-sv-action"
        data-testid="session-takeover"
        data-direction="take-over"
        onClick={() => openTakeover({ sessionId, targetMachine: null, machineName: peer.name, title })}
      >
        {TAKE_OVER_LABEL}
      </button>
    );
  }
  const online = machines.filter((machine) => machine.state === 'online');
  if (online.length === 0) return null;
  const only = online.length === 1 ? online[0] : undefined;
  return (
    <div className="sb-sv-takeover" ref={holder}>
      <button
        type="button"
        className="sb-button sb-sv-action"
        data-testid="session-takeover"
        data-direction="move"
        aria-haspopup={only ? undefined : 'menu'}
        aria-expanded={only ? undefined : menu}
        onClick={() => {
          if (only) openTakeover({ sessionId, targetMachine: only.id, machineName: only.name, title });
          else setMenu((open) => !open);
        }}
      >
        {moveLabel(only ? only.name : 'another machine')}
      </button>
      {menu ? (
        <div className="sb-sv-takeover-menu" role="menu" data-testid="session-takeover-menu">
          {online.map((machine) => (
            <button
              key={machine.id}
              type="button"
              role="menuitem"
              data-testid={`session-takeover-to-${machine.id}`}
              onClick={() => {
                setMenu(false);
                openTakeover({ sessionId, targetMachine: machine.id, machineName: machine.name, title });
              }}
            >
              {moveLabel(machine.name)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
