import { useEffect, useRef } from 'react';

/**
 * "The tool list changed" inside this page (M8.2): Settings → Embedded tools
 * saves through `PUT /api/tools` and announces it, so the sidebar's TOOLS rows
 * (their own `GET /api/tools`) reload. `/hub` has no tools event (contract), and
 * other tabs pick the change up on their next load.
 */
const EVENT = 'switchboard:tools-changed';

/** Tells the page's listeners that the tool list changed. */
export function announceToolsChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

/** Calls `handler` whenever {@link announceToolsChanged} runs. */
export function useToolsChanged(handler: () => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (): void => ref.current();
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
}
