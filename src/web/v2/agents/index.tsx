import { Placeholder } from '../shared/Placeholder.tsx';

/**
 * D131 · Agents (`/agents`, `?show=closed` = closed agents), lane A: List / Chats /
 * Board, the folder tree (⌘\ via `useShortcut('folder-tree', …)`), drafts, closed.
 * Placeholder until lane A lands; see `README.md`.
 */
export function AgentsPage({ showClosed = false }: { readonly showClosed?: boolean }) {
  return <Placeholder area={showClosed ? 'agents-closed' : 'agents'} title={showClosed ? 'Closed agents' : 'Agents'} sub="Every agent on every computer: conversations, teammates, routines and project steps too." lane="A" />;
}

/** D131 · Notes (`/notes?scope=`), lane A: what agents know (project memory). */
export function NotesPage() {
  return <Placeholder area="notes" title="Notes" sub="What agents know: facts agents proposed and you approved." lane="A" />;
}

/** D131 · Routines (`/routines`), lane A: scheduled and recurring work. */
export function RoutinesPage() {
  return <Placeholder area="routines" title="Routines" sub="Work that runs on a schedule. Routines skip a run while they wait for you." lane="A" />;
}

/** D131 · Tasks (`/tasks`), lane A: every agent's task list and the board. */
export function TasksPage() {
  return <Placeholder area="tasks" title="Tasks" sub="Every agent’s tasks, with estimate vs actual." lane="A" />;
}
