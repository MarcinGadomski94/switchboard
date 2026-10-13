# Removing Plans (D99)

Plans is experimental and built to be removed cleanly (`docs/plans.md`, decision D99). Its code lives in its own folders and files; the rest of Switchboard knows it only through the small hooks listed here, each marked in the code with the comment **`Plans (D99) hook`** (`grep -rn "Plans (D99) hook" src` lists them all). `tests/server/plans/removal.test.ts` fails when a file carries the marker and is not listed below, or a listed file no longer carries it.

## 1. Delete Plans' folders and files

- `src/server/plans/` (service and scheduler, `plans.db` and its migrations, repository, routes, git / gh adapter, environment, hooks, `install.ts`)
- `src/core/plans.ts` (shapes, graph rules, texts, the MCP tool definitions)
- `src/core/plans-jira.ts` (the Jira lane's shapes and rules; its server code is `src/server/plans/jira/`, its UI `src/web/plans/jira/`, both inside the folders above)
- `src/web/plans-jira-dev.html` (the Jira import dialog's dev mount)
- `src/hook/sb-plan-tools.ts` (the plan tools of the `switchboard` MCP helper)
- `src/web/plans/` (Settings → Experimental's Plans row, `PlansSwitchRow.tsx`; the Plans page lane adds its page here)
- `tests/server/plans/`, `tests/core/plans.test.ts`, `tests/e2e/plans-switch.spec.ts`, `tests/core/plans-jira.test.ts`, `tests/helpers/fake-jira.ts`, `tests/e2e/plans-jira.spec.ts`
- `docs/plans.md`, this file

## 2. Revert the hooks

| File | Hook | Revert to |
|---|---|---|
| `src/server/app.ts` | imports `installPlans` and the `PlanService` type; `AppOptions.plans`; calls `installPlans(app, apiContext, options.plans)` after `installTeam` | drop the imports, the option and the call |
| `src/core/settings.ts` | `experimental.plans` in `KnownSettings`, `EDITABLE_SETTINGS`, `SETTING_DEFAULTS` and `readKnownSettings` | remove the key in all four places |
| `src/server/api/settings.ts` | imports `plansSwitchChanged`; calls it when `PUT /api/settings` changes `experimental.plans` | drop both |
| `src/hook/sb-mcp.ts` | imports `registerPlanToolsIfOn`; `main` calls it before `connect` | drop the import and the call |
| `src/core/api.ts` | imports `PlanChanged`; re-exports the plan types; `HubEvents.planChanged` and its entry in `HUB_EVENT_NAMES` | remove all four |
| `src/core/peer-wire.ts` | imports `Plan`; `peerPlan`; `planChanged` in `PEER_HUB_EVENTS` and its `peerHubEvent` case; `plan` / `plans` / `plan-item` in `PeerAnswerKind`, `peerAnswerKind` and `mapPeerAnswer`; the Jira lane's two lines in `peerAnswerKind` (the import answers `plan-item`, a plan's Jira state and proposals `none`) | remove them |
| `src/server/peers/service.ts` | imports `peerPlan` and `Plan`; `plans` in `PEER_LISTS`; the Plans entries of `PEER_API_ALLOW` (with the Jira lane's preview, import, plan Jira state, refresh and proposed order); the `planChanged` branch of the peer stream; `remotePlans()`; the plans refresh after a forwarded plan call; in `refreshList`, a 404 of the plans list read as no plans | remove them (`refreshList` back to `answer.body` throughout) |
| `src/server/db/repos/peer-snapshots.ts` | `plans` in `PeerSnapshotKind` | remove it |
| `src/server/devices/local-only.ts` | the Plans entries of `DEVICE_ALLOWED` (with the Jira lane's preview, import, plan Jira state, refresh and proposed order) and of `DEVICE_REFUSED` (`/api/integrations/jira`), and "(D99) plans" in the file comment | remove them |
| `src/server/inbox/system-items.ts` | `planNotice` (the "Plan ready" and second-conflict Inbox items) | remove the method |
| `src/server/todos/run.ts` | `TodoRunOverrides` and the `overrides` parameter of `runTodo` (a plan item's branch, cut, brief and answers) | remove the type and the parameter; the branch, `from`, `task` and `answers` back to D76's (the source session's) |
| `src/web/views/settings/ExperimentalSection.tsx` | the shared Experimental section: imports `PlansSwitchRow` and renders it | drop the import and the element; delete the file when no other experimental feature (Team) is left |
| `src/web/views/SettingsView.tsx` | imports `ExperimentalSection`; its `case 'experimental'` (shared with Team, D100) | keep while Team is there; otherwise remove both |
| `src/web/views/settings/model.ts` | the `experimental` section (shared with Team, D100) | keep while Team is there; otherwise remove the entry |

Outside `src/` (not markers): `vite.config.ts` builds the Jira dialog's dev mount as an entry (`rollupOptions.input.plansJiraDev`: remove it); `tests/helpers/server-process.ts` drops `ATL_*` from test servers' environment (the Jira lane's guard; harmless without Plans, may stay).

Tests that name Plans' additions (revert with the code):

- `tests/server/api/settings.test.ts`: the `'experimental.plans': false` line of the fresh-install answer.
- `tests/core/plans.test.ts` goes with step 1; nothing else names Plans (the Experimental section's Plans row has no screenshot of its own).

Docs: the *Plans (D99)* and *Plans · Jira (D99)* sections of `docs/handoff/contracts/local-api.md`, *Jira credentials (D99)* in `docs/security.md`, the Jira paragraphs of `PRIVACY.md`, the *D99-Jira* section of `.loop/questions.md`, D99 in `docs/decisions.md` (mark it removed rather than deleting the record), the *D99* section of `.loop/questions.md`.

## 3. Delete the data

If Jira was connected in Settings → Integrations → Jira, remove it there first (or delete the keychain item named `Switchboard Jira` by hand: Keychain Access on macOS, Credential Manager on Windows, `secret-tool clear service "Switchboard Jira" account default` on Linux). The Jira lane's tables (`plan_jira*`) are inside `plans.db` and go with it.

`<dataDir>/plans.db` (and `plans.db-wal` / `plans.db-shm` if present). Nothing of Plans' own state is in `switchboard.db`. Three kinds of rows there mention it, all harmless to a build without Plans:

- the `experimental.plans` setting (an unknown settings key is never read): `DELETE FROM settings WHERE key = 'experimental.plans'`;
- the Inbox items it raised ("Plan ready", a second conflict; dismiss-only): `DELETE FROM system_items WHERE source = 'plans'`;
- a paired machine's last known plans: `DELETE FROM peer_snapshots WHERE kind = 'plans'`.

Plan items are ordinary todos and their runs ordinary sessions (D76 todo runs) throughout: the todos, the run sessions, their worktrees, branches, pull requests and review cards are untouched by removal. Sessions that were working on an item keep their branch; nothing merges or starts any more.

## Checked

The procedure was applied once to a throw-away copy (a scratch `git worktree` of the Plans branch): every step above, then `npm run typecheck`; the result is recorded in `.loop/questions.md` → *D99* (`VERIFIED D99-removal`).
