import { useV2Router } from '../nav.tsx';
import { Placeholder } from '../shared/Placeholder.tsx';

/** D131 · Search (`/search?q=`), lane R: everything on every computer, to the exact message (⌘⇧F opens it). */
export function SearchPage() {
  const { search } = useV2Router();
  const q = new URLSearchParams(search).get('q') ?? '';
  return <Placeholder area="search" title="Search" sub={q ? `Results for “${q}”` : 'Every message, result, task and closed agent, on every computer.'} lane="R" />;
}
