import { Placeholder } from '../shared/Placeholder.tsx';

/** D131 · Crews (`/crews`), lane P: every crew, in order. */
export function CrewsPage() {
  return <Placeholder area="crews" title="Crews" sub="Long-lived teammates with job descriptions, rhythms, budgets and hand-offs." lane="P" />;
}

/** D131 · one crew (`/crews/:id`, `?member=&tab=` opens a teammate's tab), lane P. */
export function CrewPage({ id }: { readonly id: string }) {
  return <Placeholder area="crew" title="Crew" sub={`Crew ${id}`} lane="P" />;
}
