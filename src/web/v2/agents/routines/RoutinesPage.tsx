import { ROUTINES_WORDS } from '../../glossary.ts';
import { Placeholder } from '../../shared/Placeholder.tsx';

/** D131 · Routines (`/routines`), lane A. */
export function RoutinesPage() {
  return <Placeholder area="routines" title={ROUTINES_WORDS.title} sub={ROUTINES_WORDS.sub} lane="A" />;
}
