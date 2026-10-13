# Plans (D99)

<!-- The core lane's sections (the graph, the scheduler, merge modes, storage, the seam) go above this one. -->

## Jira import and status sync

A plan can be made from a Jira epic: its child issues become the items, their "blocks / is blocked by" links the dependencies. Optionally, Switchboard keeps the tickets in step with the plan. Code: `src/server/plans/jira/` (client, credentials, store, service, routes, `install.ts`), `src/core/plans-jira.ts` (shapes and pure rules), `src/web/plans/jira/` (the dialog, a plan's Jira section, the credentials form). Contract → *Plans · Jira (D99)*. Like the rest of Plans it is experimental: every route answers 404 `plans-off` and nothing reads or writes Jira while Plans is off.

### Import

1. **Import from Jira…** (the Plans page mounts `ImportJiraDialog`): paste an epic key (`PROJ-10`) or its link (`…/browse/PROJ-10`, `…?selectedIssue=PROJ-10`).
2. **Preview** reads, and creates nothing:
   - the epic (`GET /rest/api/3/issue/{key}`) and its children (`GET /rest/api/3/search/jql`, `parent = PROJ-10`, at most 100; more are reported as cut);
   - per child: summary, description, acceptance criteria, components, status, assignee, original estimate. Acceptance criteria come from a custom field named "Acceptance criteria" (found through `GET /rest/api/3/field`, any case) or else from a description section with that heading (an ADF heading, or a line "Acceptance criteria:"; the section runs to the next heading of the same or a higher level);
   - **dependencies**: every `Blocks` link between two children ("PROJ-12 waits on PROJ-11"); both sides of a link are read and deduplicated; other link types are ignored;
   - **outside links**: a `Blocks` link to an issue outside the epic is a note ("PROJ-15 waits on PROJ-99 (outside the epic)"), never a dependency;
   - **cycles**: links are taken in ticket order (by the waiting issue, then the one it waits on); a link that would close a cycle is left out and named with the cycle ("PROJ-14 waits on PROJ-13 was left out: PROJ-13 → PROJ-14 → PROJ-13 would be a cycle"). The plan core refuses cycles, so nothing cyclic is ever sent to it;
   - items without any dependency inside the epic are flagged ("no links").
3. **Create plan** reads the epic again (the server never trusts a preview the page held) and calls the core's seam `PlanService.createFromExternal` with:
   - one item per child: `ref` and `key` = the issue key, title "KEY Summary", the todo's description = the ticket's description, then "Acceptance criteria:" with them, then a line with the ticket's link, components and assignee (cut to the todo's 4,000 characters, the acceptance criteria kept first), the estimate in minutes, **no solutions** (the components are shown as a hint; the developer picks the solutions on the plan);
   - the preview's dependencies;
   - `external: { system: 'jira', key: <epic> }`;
   - the title, target branch, base branch and repos from the dialog (title and target pre-filled: "PROJ-10 Acme checkout", `feature/PROJ-10-acme-checkout`).

   The plan is a **draft**; its merge mode is chosen at Start (the core requires it). A failure of the core (no target branch, a forbidden branch, too many items) creates nothing.

**Propose missing order** is not built: Switchboard has no sanctioned one-shot agent run (the usage poller and the MCP helper run the CLI without a model call; todo enrichment asks an existing session). `JiraPreview.proposeAvailable` is `false`; `.loop/questions.md` → *D99-Jira*.

### Status sync

A per-plan setting, chosen in the dialog (default **off**) and changeable on the plan (`PlanJiraPanel`, `PUT /api/plans/{id}/jira`):

- **off**: nothing is read or written after the import.
- **read-only**: the tickets are read again (title, status, description, with the import's fields) on **Refresh now** and every 30 minutes while the plan runs. A still-pending item's todo takes the new title and description (an item that started keeps its brief). Each item shows a **drift note** when Jira says Done and the item is not done, still says To Do (category `new`) while the item's run works, or its status changed since the import.
- **write**: read-only, plus, as the plan's items move (followed through `planChanged`, while the plan runs, is paused or just finished):
  - the item's run starts → the **In Progress** transition;
  - its pull request opens → the **In Review** transition and a comment "Pull request opened: <url>";
  - it waits on a developer question → a comment (one per question episode: it is in `question` again after it left);
  - it is merged into the target → a comment "Merged into <target>." **Never Done**: the team's own process moves the ticket there. An item the developer marks done gets no comment.

  The transition names are per plan (defaults "In Progress", "In Review") and resolved through the issue's available transitions (`GET …/transitions`) by the transition's name or its target status' name, case-insensitive. An issue already in that status is left alone. **A missing transition is a soft failure**: noted on the item (`syncNote`) and in the activity, never retried, never blocking.

**Idempotent writes.** Each write is one event per item (`start:<run>`, `pr-transition:<url>`, `pr-comment:<url>`, `question:<n>`, `merged`) recorded in `plan_jira_writes`: done or soft once, never again. A comment ends with a marker `[switchboard:<plan>:<item>:<event>]`; before posting, the issue's comments are read and a comment with that marker counts as posted (a retry after a lost answer adds no second one). A failed write (network, 5xx, 401) stays pending and is retried at the next `planChanged` or refresh, at most 5 times; a deleted issue is given up at once. Every write, soft failure, give-up, refresh and settings change is a line of the plan's **Jira activity** (`GET /api/plans/{id}/jira`, newest 200).

### Credentials

Jira Cloud REST API v3 with basic auth (the account's email and an API token): from **Settings → Integrations → Jira** (`JiraCredentialsForm`, stored as one value in the OS keychain through the Team access lane's `SecretStore`, item "Switchboard Jira" / "default"), else from the environment `ATL_BASE_URL`, `ATL_USER`, `ATL_TOKEN`. Settings win when both are set. Requests go only to that base URL (`https://`, or `http://` on loopback for the tests' fake); redirects are refused. See `docs/security.md` → *Jira credentials (D99)*.

### Storage

Plans' `plans.db` (its own connection, opened on first use while Plans is on and closed when it is seen off), tables created when missing (`CREATE TABLE IF NOT EXISTS`, outside the core's migration list): `plan_jira` (epic, base URL, sync, transition names, last refresh), `plan_jira_items` (issue key, status at import and as last read, drift, last soft failure, question episodes), `plan_jira_writes`, `plan_jira_activity`. No secret. A deleted plan's rows go with its `planChanged` (`state: null`).

### Machines and devices

Import and sync run on the machine that owns the plan (the source session's machine): a remote session or plan id is forwarded by the peers' proxy and answered there with that machine's credentials. The token never travels: the credential routes are refused to peers and phones. Phones may preview, import and change a plan's sync (D73 ruling 2026-10-13); the credential settings are this computer's only.

### Tests

`tests/server/plans/jira.test.ts` (the fake Jira `tests/helpers/fake-jira.ts`: an epic with five children, blocks links with a cycle and a link outside the epic, a workflow without "In Review" for one issue, comments, injected failures), `tests/core/plans-jira.test.ts` (rules, route classification), `tests/e2e/plans-jira.spec.ts` (the dialog's dev mount against the fake Jira, desktop and 360 px). Tests never call the real Jira and never read the developer's `ATL_*` (test servers drop them; in-process tests read no environment).
