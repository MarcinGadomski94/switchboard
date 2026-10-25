// Plans (D99) hook: the Jira lane's connection (docs/plans-removal.md).
import { JiraCredentialsForm } from '../../plans/jira/JiraCredentialsForm.tsx';
import { SectionTitle } from './rows.tsx';

/**
 * Settings → **Jira** (D132): the Jira connection Plans' Jira import and the todo import's Jira
 * source use (`docs/plans.md`). Until 2.0 it sat in Settings → Experimental under the Plans
 * switch; Team, Plans and Project memory graduated (always on), so the Experimental section went
 * and the connection got its own section.
 */
export function JiraSection() {
  return (
    <>
      <SectionTitle>Jira</SectionTitle>
      <div className="sb-jira-settings" data-testid="settings-jira">
        <JiraCredentialsForm />
      </div>
    </>
  );
}
