import { AgentPage } from '../agent/index.tsx';
import { AgentsPage, NotesPage, RoutinesPage, TasksPage } from '../agents/index.tsx';
import { CrewPage, CrewsPage } from '../crews/index.tsx';
import { HomePage } from '../home/index.tsx';
import { InsightsPage } from '../insights/index.tsx';
import { NeedsYouPage } from '../needs-you/index.tsx';
import { ProjectGraphPage, ProjectPage, ProjectsPage } from '../projects/index.tsx';
import { ResultsPage } from '../results/index.tsx';
import type { V2Route } from '../routes.ts';
import { SearchPage } from '../search/index.tsx';
import { SettingsPage, SharePage, ToolPage } from '../settings/index.tsx';
import { MorePage } from './MorePage.tsx';
import type { StatusPill } from './status-model.ts';
import type { RailCounts } from './useShellData.ts';

/**
 * D131 · the page for a v2 route. Each area's page comes from its folder's
 * `index.tsx` (the lanes own them); this file and the shell are lane F's, so the
 * lanes never edit the router.
 */
export function Outlet({ route, search, pill, counts }: { readonly route: V2Route; readonly search: string; readonly pill: StatusPill; readonly counts: RailCounts }) {
  switch (route.area) {
    case 'home':
      return <HomePage />;
    case 'needs-you':
      return <NeedsYouPage />;
    case 'agents':
      return <AgentsPage showClosed={new URLSearchParams(search).get('show') === 'closed'} />;
    case 'agent':
      return <AgentPage key={route.id} route={route} />;
    case 'projects':
      return <ProjectsPage />;
    case 'project':
      return <ProjectPage key={route.id} id={route.id} />;
    case 'project-graph':
      return <ProjectGraphPage key={route.id} id={route.id} />;
    case 'crews':
      return <CrewsPage />;
    case 'crew':
      return <CrewPage key={route.id} id={route.id} />;
    case 'results':
      return <ResultsPage />;
    case 'search':
      return <SearchPage />;
    case 'insights':
      return <InsightsPage />;
    case 'settings':
      return <SettingsPage section={route.section} sub={route.sub} />;
    case 'notes':
      return <NotesPage />;
    case 'routines':
      return <RoutinesPage />;
    case 'tasks':
      return <TasksPage />;
    case 'tool':
      return <ToolPage key={route.id} id={route.id} />;
    case 'share':
      return <SharePage />;
    case 'more':
      return <MorePage pill={pill} counts={counts} />;
  }
}
