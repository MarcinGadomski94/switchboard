import { AGENTS_WORDS } from '../glossary.ts';
import { Placeholder } from '../shared/Placeholder.tsx';

export { NotesPage } from './notes/NotesPage.tsx';
export { RoutinesPage } from './routines/RoutinesPage.tsx';
export { TasksPage } from './tasks/TasksPage.tsx';

/**
 * D131 · Agents (`/agents`, `?show=closed` = closed agents), lane A: List / Chats /
 * Board, the folder tree (⌘\ via `useShortcut('folder-tree', …)`), drafts, closed.
 */
export function AgentsPage({ showClosed = false }: { readonly showClosed?: boolean }) {
  return <Placeholder area={showClosed ? 'agents-closed' : 'agents'} title={showClosed ? 'Closed agents' : AGENTS_WORDS.title} sub={AGENTS_WORDS.sub} lane="A" />;
}
