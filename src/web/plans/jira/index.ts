/**
 * D99 · Plans · Jira: the UI the Plans page mounts (`docs/plans.md` → *Jira import and status
 * sync*, contract → *Plans · Jira (D99)*):
 *
 * - {@link ImportJiraDialog} `{ sourceSessionId?, repos?, initialEpic?, onImported(plan), onClose(), onUseSession? }`:
 *   the **Import from Jira…** dialog (preview, then Create plan → a draft; `onImported` gets the
 *   new `Plan`, a paired machine's plan already namespaced). Render it while open; it is its own overlay.
 *   D112: without `sourceSessionId` it asks **Where it runs** and a new session in that folder owns the plan.
 * - {@link PlanJiraPanel} `{ planId }`: a plan's Jira section (sync setting, Refresh now, drift and
 *   soft-failure notes per ticket, the Jira activity). Renders nothing for a plan not from Jira.
 * - {@link JiraCredentialsForm} `{ onChanged? }`: Settings → Integrations → Jira (this computer only;
 *   renders nothing while Plans is off).
 * - {@link PlanEdgeProposals} `{ planId }`: the dependencies the plan's source session proposed
 *   (`plan_propose_dependencies`), "PROJ-12 should wait on PROJ-11 — <reason>" with ✓ / ✕ and
 *   Accept all; renders nothing without a pending one. **Propose order** on a draft plan is
 *   `jiraApi.askForOrder(planId)` (the session is asked; its proposals arrive later).
 * - {@link jiraApi}: the calls, if the page needs them directly.
 *
 * A stand-alone mount for development and the Playwright spec is
 * `/plans-jira-dev.html?session=<sessionId>` (`src/web/plans-jira-dev.html`).
 */
export { ImportJiraDialog, type ImportJiraDialogProps } from './ImportJiraDialog.tsx';
export { PlanJiraPanel, type PlanJiraPanelProps } from './PlanJiraPanel.tsx';
export { JiraCredentialsForm, type JiraCredentialsFormProps } from './JiraCredentialsForm.tsx';
export { PlanEdgeProposals, type PlanEdgeProposalsProps } from './PlanEdgeProposals.tsx';
export { JiraApiError, type JiraFolderImportBody, type JiraImportBody, jiraApi } from './api.ts';
