import { NOTES_WORDS } from '../../glossary.ts';
import { Placeholder } from '../../shared/Placeholder.tsx';

/** D131 · Notes (`/notes`), lane A. */
export function NotesPage() {
  return <Placeholder area="notes" title={NOTES_WORDS.title} sub={NOTES_WORDS.sub} lane="A" />;
}
