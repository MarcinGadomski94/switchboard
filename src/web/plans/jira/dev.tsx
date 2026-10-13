import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Plan } from '../../../core/plans.ts';
import '../../fonts.ts';
import '../../styles/tokens.css';
import '../../styles/global.css';
import { ImportJiraDialog } from './ImportJiraDialog.tsx';
import { PlanJiraPanel } from './PlanJiraPanel.tsx';

/**
 * D99-Jira · a stand-alone mount of the import dialog (development and
 * `tests/e2e/plans-jira.spec.ts`): `/plans-jira-dev.html?session=<sessionId>` shows an
 * "Import from Jira…" button; after an import, the new plan's id and its Jira section. Not
 * linked from the app (the Plans page mounts the dialog).
 */
function DevMount({ sessionId }: { readonly sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  return (
    <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, color: 'var(--text)' }}>
      <button type="button" className="sb-jira-btn" data-testid="dev-open-import" onClick={() => setOpen(true)}>
        Import from Jira…
      </button>
      {plan ? (
        <div data-testid="dev-imported" data-plan-id={plan.id}>
          Created {plan.title} ({plan.state}, {plan.items.length} items)
        </div>
      ) : null}
      {plan ? <PlanJiraPanel planId={plan.id} /> : null}
      {open ? (
        <ImportJiraDialog
          sourceSessionId={sessionId}
          onClose={() => setOpen(false)}
          onImported={(created) => {
            setPlan(created);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

const container = document.getElementById('root');
const sessionId = new URLSearchParams(location.search).get('session') ?? '';
if (container) {
  createRoot(container).render(<StrictMode>{sessionId ? <DevMount sessionId={sessionId} /> : <p>Add ?session=&lt;sessionId&gt; to the URL.</p>}</StrictMode>);
}
