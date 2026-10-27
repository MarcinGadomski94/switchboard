import { useCallback, useState } from 'react';
import type { PlanItem } from '../../../core/plans.ts';
import { EmptyState, Icon, Skeleton } from '../components/index.ts';
import { GRAPH_WORDS } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { EditStepDialog, SendBackDialog, StepDetailSheet } from './dialogs.tsx';
import { GraphView } from './GraphView.tsx';
import { useProject } from './useProject.ts';
import { useStepActions } from './useStepActions.ts';
import './projects.css';

/**
 * Fixes after 2.0 → *The Project graph in full screen*: `/projects/:id/graph`, a project's graph
 * alone, filling the window (a second monitor, a shared link). The shell shows nothing else on this
 * address (`../shell/Shell.tsx`). Live like the project page (`useProject`); a step's click, ⋯ and
 * details work as there (Send back, Edit, the step's details); the project's own menu and Jira
 * dialogs stay on the project page (← in the top bar).
 */
export function ProjectGraphPage({ id }: { readonly id: string }) {
  const data = useProject(id);
  if (data.gone) {
    return (
      <div className="v2-page" data-testid="v2-page-project-graph" data-area="project-graph">
        <V2Link to="/projects" className="v2-p-back">
          <Icon name="back" size="s" />
          Projects
        </V2Link>
        <EmptyState icon="projects" tone="grey" title="This project is gone" text="It was deleted, or it belongs to a computer that no longer lists it." testId="v2-project-gone" />
      </div>
    );
  }
  if (!data.plan) {
    return (
      <div className="v2-page" data-testid="v2-page-project-graph" data-area="project-graph" aria-busy="true">
        <Skeleton width="40%" height={30} style={{ margin: '14px 0 22px' }} />
        <Skeleton lines={4} height={18} />
        {data.error ? (
          <p className="v2-field-error" role="alert">
            {data.error}
          </p>
        ) : null}
      </div>
    );
  }
  return <GraphPageBody plan={data.plan} put={data.put} todos={data.todos} />;
}

type StepOverlay = { readonly kind: 'sendback'; readonly item: PlanItem } | { readonly kind: 'edit'; readonly item: PlanItem } | { readonly kind: 'details'; readonly itemId: string };

function GraphPageBody({ plan, put, todos }: { readonly plan: NonNullable<ReturnType<typeof useProject>['plan']>; readonly put: ReturnType<typeof useProject>['put']; readonly todos: ReturnType<typeof useProject>['todos'] }) {
  const [overlay, setOverlay] = useState<StepOverlay | null>(null);
  const close = useCallback(() => setOverlay(null), []);
  const actions = useStepActions(plan, put, (item) => setOverlay({ kind: 'edit', item }));
  const detailsItem = overlay?.kind === 'details' ? plan.items.find((item) => item.id === overlay.itemId) : undefined;
  return (
    <div className="v2-p-graph-page" data-testid="v2-page-project-graph" data-area="project-graph" aria-label={GRAPH_WORDS.graphOf(plan.title)}>
      <GraphView page plan={plan} actions={actions} onDetails={(item) => setOverlay({ kind: 'details', itemId: item.id })} onSendBack={(item) => setOverlay({ kind: 'sendback', item })} />
      {overlay?.kind === 'sendback' ? <SendBackDialog item={overlay.item} onClose={close} onSend={(comment) => actions.sendBack(overlay.item, comment)} /> : null}
      {overlay?.kind === 'edit' ? <EditStepDialog item={overlay.item} onClose={close} onSave={(title, estimate) => actions.edit(overlay.item, title, estimate)} /> : null}
      {detailsItem ? (
        <StepDetailSheet
          plan={plan}
          item={detailsItem}
          todo={todos.get(detailsItem.todoId) ?? null}
          onClose={close}
          onOpenAgent={() => {
            close();
            actions.openAgent(detailsItem);
          }}
          onAction={(action) => {
            close();
            void actions.run(detailsItem, action);
          }}
        />
      ) : null}
    </div>
  );
}
