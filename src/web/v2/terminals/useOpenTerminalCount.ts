import { useEffect, useState } from 'react';
import { machineApi } from '../../api/client.ts';

/** How often the rail re-reads this computer's open terminals (no hub event carries them). */
export const OPEN_TERMINALS_POLL_MS = 15_000;

/**
 * 2.5.2 (D170 follow-up, `docs/terminals.md` → *Getting back to a terminal*): the number of
 * terminals open on this computer, for the rail's Terminals badge. Paired computers' terminals are
 * not counted here (the Terminals page lists them); `key` re-reads at once (the route, so leaving
 * or closing a terminal shows at once). `0` while unknown or when the read fails.
 */
export function useOpenTerminalCount(key: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      machineApi(null)
        .terminals()
        .then(
          (view) => {
            if (live) setCount(view.terminals.length);
          },
          () => {
            if (live) setCount(0);
          },
        );
    };
    read();
    const timer = setInterval(read, OPEN_TERMINALS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [key]);
  return count;
}
