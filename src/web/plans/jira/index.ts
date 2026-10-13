/**
 * D99 · Plans · Jira: the UI the Plans page mounts (`docs/plans.md` → *Jira import and status
 * sync*, contract → *Plans · Jira (D99)*):
 *
 * - {@link ImportJiraDialog} `{ sourceSessionId, repos?, initialEpic?, onImported(plan), onClose() }`:
 *   the **Import from Jira…** dialog (preview, then Create plan → a draft; `onImported` gets the
 *   new `Plan`, a paired machine's plan already namespaced). Render it while open; it is its own overlay.
 * - {@link PlanJiraPanel} `{ planId }`: a plan's Jira section (sync setting, Refresh now, drift and
 *   soft-failure notes per ticket, the Jira activity). Renders nothing for a plan not from Jira.
 * - {@link JiraCredentialsForm} `{ onChanged? }`: Settings → Integrations → Jira (this computer only;
 *   renders nothing while Plans is off).
 * - {@link jiraApi}: the calls, if the page needs them directly.
 *
 * A stand-alone mount for development and the Playwright spec is
 * `/plans-jira-dev.html?session=<sessionId>` (`src/web/plans-jira-dev.html`).
 */
export { ImportJiraDialog, type ImportJiraDialogProps } from './ImportJiraDialog.tsx';
export { PlanJiraPanel, type PlanJiraPanelProps } from './PlanJiraPanel.tsx';
export { JiraCredentialsForm, type JiraCredentialsFormProps } from './JiraCredentialsForm.tsx';
export { JiraApiError, type JiraImportBody, jiraApi } from './api.ts';
