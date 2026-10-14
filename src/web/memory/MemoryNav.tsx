import { memoryCountText } from '../../core/memory.ts';
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
 * The session panel's line: "Memory: 3 entries" (the approved entries of the session's folder,
 * the ones its agent gets) and "· 1 to review", linking to the Memory page at that folder. This
 * machine's sessions only (a paired machine's memory is on that machine).
 */
export function SessionMemoryLine({ folderPath, remote }: { readonly folderPath: string | null | undefined; readonly remote: boolean }) {
  const { on, scopes } = useMemory();
  const { navigate } = useRouter();
  if (!on || remote || !folderPath) return null;
  const href = `/memory?scope=${encodeURIComponent(folderPath)}`;
  const scope = scopes.find((candidate) => candidate.scope === folderPath);
  const approved = scope?.approved ?? 0;
  const proposed = scope?.proposed ?? 0;
  return (
    <div className="sb-mem-line" data-testid="session-memory" data-tour="session-memory">
      <a
        href={href}
        className="sb-mem-line__link"
        data-testid="session-memory-link"
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          navigate(href);
        }}
      >
        {memoryCountText(approved)}
      </a>
      {proposed > 0 ? (
        <span className="sb-mem-line__pending" data-testid="session-memory-pending">
          · {proposed} to review
        </span>
      ) : null}
    </div>
  );
}
