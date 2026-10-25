import { TASKS_WORDS } from '../../glossary.ts';
import { Placeholder } from '../../shared/Placeholder.tsx';

/** D131 · Tasks (`/tasks`), lane A. */
export function TasksPage() {
  return <Placeholder area="tasks" title={TASKS_WORDS.title} sub={TASKS_WORDS.sub} lane="A" />;
}
