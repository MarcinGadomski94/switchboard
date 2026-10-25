import { Placeholder } from '../shared/Placeholder.tsx';

/** D131 · Projects (`/projects`), lane P: every project, its progress and what waits. */
export function ProjectsPage() {
  return <Placeholder area="projects" title="Projects" sub="Multi-step work that runs as a plan: progress, blockers and what is ready for your approval." lane="P" />;
}

/** D131 · one project (`/projects/:id`), lane P: Steps / Board / Graph / Timeline. */
export function ProjectPage({ id }: { readonly id: string }) {
  return <Placeholder area="project" title="Project" sub={`Project ${id}`} lane="P" />;
}
