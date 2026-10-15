import { useEffect, useState } from 'react';
import { type MemorySessionCount, memoryCountText, memoryCountTooltip } from '../../core/memory.ts';
import { onHubEvent } from '../api/useHub.ts';
import { memoryApi } from './api.ts';
import { useRouter } from '../router.tsx';
import { type NavBadge, badgeCount } from '../shell/nav-grid.ts';
import { NavCell } from '../shell/NavCell.tsx';
import { proposalCount, useMemory } from './store.ts';
import './memory.css';

/**
 * D107 · the entry points to Project memory outside its page, rendered only while it is on
 * (nothing at all while off): the nav grid's **Memory** cell (D101; its amber badge counts the
 * proposals waiting for review) and the session panel's "Memory: N entries" line.
 */

/** The cell's badge: proposals to review (amber, they wait for you). */
export function memoryBadge(proposals: number): NavBadge | null {
  return proposals > 0 ? { text: badgeCount(proposals), kind: 'need', title: `${proposals} ${proposals === 1 ? 'proposal' : 'proposals'} to review` } : null;
}

/** The nav grid's Memory cell (only while Project memory is on). */
export function MemoryNavItem() {
  const { on, scopes } = useMemory();
  const { route } = useRouter();
  if (!on) return null;
  return (
    <NavCell
      to={{ view: 'memory' }}
      label="Memory"
      icon="memory"
      badge={memoryBadge(proposalCount(scopes))}
      active={route.view === 'memory'}
      testId="nav-memory"
      tour="memory"
      badgeTestId="nav-memory-count"
    />
  );
}

/**
 * The session panel's line: "Memory: 3 entries" (what this session receives: the entries in its
 * block, its member's, its repositories' and its folder's; D107 follow-up 2026-10-15) with the
 * breakdown per scope in the tooltip, and "· 1 to review", linking to the Memory page at the
 * session's folder. This machine's sessions only (a paired machine's memory is on that machine).
 */
export function SessionMemoryLine({ sessionId, folderPath, remote }: { readonly sessionId: string; readonly folderPath: string | null | undefined; readonly remote: boolean }) {
  const { on } = useMemory();
  const { navigate } = useRouter();
  const [count, setCount] = useState<MemorySessionCount | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => onHubEvent('memoryChanged', () => setTick((n) => n + 1)), []);
  useEffect(() => {
    if (!on || remote || !folderPath) return;
    let cancelled = false;
    memoryApi(null)
      .sessionCount(sessionId)
      .then(
        (answer) => {
          if (!cancelled) setCount(answer);
        },
        () => {
          if (!cancelled) setCount(null);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [on, remote, folderPath, sessionId, tick]);
  if (!on || remote || !folderPath) return null;
  const href = `/memory?scope=${encodeURIComponent(count?.folder ?? folderPath)}`;
  const proposed = count?.proposed ?? 0;
  return (
    <div className="sb-mem-line" data-testid="session-memory" data-tour="session-memory">
      <a
        href={href}
        className="sb-mem-line__link"
        data-testid="session-memory-link"
        title={count ? memoryCountTooltip(count) : undefined}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          navigate(href);
        }}
      >
        {memoryCountText(count?.count ?? 0)}
      </a>
      {proposed > 0 ? (
        <span className="sb-mem-line__pending" data-testid="session-memory-pending">
          · {proposed} to review
        </span>
      ) : null}
    </div>
  );
}
