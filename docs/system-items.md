# System Inbox items (M3.3)

The Inbox items the service raises itself, next to the question batches and permission requests of M3.1 (`docs/questions.md`, `docs/inbox.md`). Prototype: array `SYS` and the `ib.actions[].pick` handler. Code: `src/server/inbox/system-items.ts` (`SystemItemService` + the pure item builders), the actions branch of `src/server/api/inbox.ts`, `SystemItemRepository.createOnce` / `failedRunsWithoutItem` / `removableWorktreesWithoutItem` (`src/server/db/repos/system-items.ts`), and on the web `newSessionAfter` (`src/web/views/inbox.ts`) + the `prefill` of `useModals().open('new-session', { prefill })`.

## Where items come from
Every item is built from stored state only (D13); nothing from the prototype's mock data. One item per failed run and one per worktree, open or closed: `createOnce` checks `(kind, schedule_run_id)` / `(kind, worktree_id)` and inserts in one transaction, so a dismissed item never comes back.

| Kind (`system_items.kind`) | Raised by | When |
|---|---|---|
| `schedule-run-failed` | `scheduleRunFinished(runId)` (the scheduler's hook: M7.1 calls it when a run fails, `docs/schedules.md`) and `sync()` | a `schedule_runs` row with `result = 'fail'` |
| `worktree-removable` | the M2.2 manager's `worktreeRemovable` event (subscribed in the constructor) and `sync()` | a live worktree flagged `removable` (PR `MERGED` and removal allowed, `docs/worktrees.md`) |

`sync()` raises the items of every failed run and removable worktree that has none yet (runs first, then worktrees, oldest first). `main.ts` runs it once the port is bound and then every 30 s (`startWatching()`, `DEFAULT_SYNC_MS`), so a failed run recorded in the schedule tables by anything, or while the service was down, still produces its item. Demo mode does not watch (the demo seeds its own two items). `inboxChanged { count }` is published whenever an item is raised (once per sync) or closed.

## Item shapes
The Inbox shows them through `systemItem()` (`src/server/inbox/wire.ts`): kind label from `SYSTEM_ITEM_LABELS`, status dot from the stored status, no "Open session →" (prototype: session items only).

**Scheduled run failed** (`failedRunItem`):
- source = the schedule's name; status `fail`; dated when the run ended (`finishedAt`, else `ts`), so the age matches the run.
- title = the run's `summary`, else `<schedule> failed`.
- detail = the green streak right before the run, counted over the schedule's newest 200 runs: `The previous 13 runs were green.` / `The previous run was green.`; empty when the run before it did not succeed or the run is older than that window. The prototype's other sentences (the error text, "Likely related to …") have no stored source and are not invented.
- branch chips = those of the session the run started (`sessionBranches`, `docs/inbox.md`), none without one; `sessionId` = that session.
- actions: `open-fix-session` Open fix session · `retry-run` Retry run · `dismiss` Dismiss.
- `payload.prefill` → `InboxItem.prefill` (`NewSessionPrefill`, additive in `src/core/api.ts`), the New-session values of "Open fix session" (`fixSessionPrefill`):

| Field | Value |
|---|---|
| `name` | `fix-<schedule name as kebab-case>`, cut to 64 characters (the modal still checks it is unique) |
| `task` | `<schedule>: <title>.` + ` Fix on <branch>.` when the run's session has a branch chip (prototype: `nightly-build-verify: … Fix on feature/free-talk-360.`) |
| `workType` | `feature` (a fix is feature work) |
| `solutions` | the schedule template's `solutions` (strings only), else `[]` |
| `mode`, `phase` | the template's when valid, else `single` / `ui-first` (the router's recommended answers, which the prototype's prefill uses) |
| `coordination`, `worktrees`, `ultracode` | the template's, only when valid |

**PR merged** (`removableWorktreeItem`, prototype copy):
- source `worktrees`; status `done`; dated when gh was checked (`prCheckedAt`).
- title `PR #<n> merged, so the worktree can be removed` (`The PR was merged, so the worktree can be removed` without a number).
- detail `<worktree path relative to its repo> · branch <branch> was merged on GitHub (checked through gh). No uncommitted changes.` (OS separators, gap #17; the manager only flags a worktree removable when it holds no uncommitted or unpushed work).
- chip `<repo> ⎇ <branch>`; `sessionId` = the worktree's session.
- actions: `remove-worktree` Remove worktree · `keep` Keep.

## Actions (`POST /api/inbox/{id}/actions/{action}` → 204)
The route asks the question pipeline first (permission items), then this service. An action runs, then the item closes with `closed_action` = the action and `inboxChanged` goes out; a refused action leaves it open.

| Action | Server | UI |
|---|---|---|
| `open-fix-session` | closes the item | then opens the New-session modal with the item's `prefill` (prototype): since M5.1 the form starts from it (`docs/new-session.md`); the dialog still carries it as `data-prefill` (JSON); "+ New session" opens it without one. |
| `retry-run` | `ScheduleRunner.runNow(scheduleId)`, then closes (a new failure raises a new item) | — |
| `remove-worktree` | `WorktreeManager.remove(worktreeId)` (gap #3: refused with uncommitted or unpushed work, never `--force`, the branch is kept); a folder already removed counts as done | — |
| `dismiss`, `keep` | close the item | — |

Refusals: unknown id `404`; an action the item does not list `400 {error:"unknown-action"}`; already closed or a second click while one runs `409 {error:"not-open"|"busy"}`; the schedule or worktree it points at is gone `409 {error:"gone"}`; a worktree refusal as the other worktree routes (`409 {error:"uncommitted"|"unpushed"|"git-failed", message}`); Retry run while a run of the schedule is still in progress `409 {error:"busy", message:"a run of this schedule is still in progress"}`; Retry run on a service with no scheduler plugged in `501 {error:"not-implemented", item:"M7.1", message:"the scheduler is not available yet"}` (only services built without one, e.g. in tests; main.ts and buildApp plug it in). The Inbox shows the message on its refusal line (`Not sent: …`).

## The scheduler (M7.1)
- A run that fails calls `systemItems.scheduleRunFinished(run.id)`, so the item appears at once (the 30 s sync still covers anything else).
- "Retry run" = `scheduleRunnerFor(scheduler).runNow(scheduleId)` (`src/server/schedules/scheduler.ts`): a manual run now; a run in progress → `busy` (409), a deleted schedule → `gone`. main.ts plugs it into its service; buildApp plugs its own scheduler into the service it makes itself (a service passed in keeps its runner, so `tests/server/inbox/system-items.test.ts` still covers the 501 path with a stub runner). Details: `docs/schedules.md`.

## Tests
- `tests/server/inbox/system-items.test.ts`: failed runs inserted into the schedule tables → items via `sync()`, the hook and `startWatching` (shapes, green streak, branches, prefill, idempotence, `inboxChanged`); every action and refusal through the route; "PR merged" from the real manager (temp git repo, fake gh) through `worktreeRemovable`, Remove refused while uncommitted then removed with the branch kept, Keep, sync of a removable worktree without an item, an already removed folder; the pure builders.
- `tests/e2e/inbox-system.spec.ts` (oracle, real server, no demo): failed runs inserted before start → the items in the Inbox; Retry run refused (501 line); Dismiss; Open fix session → the modal with the prefill; a session started with a worktree whose PR the fake gh reports merged → the item arrives live after the first PR check; Remove worktree refused while a file is uncommitted, then the folder is removed and the branch kept.
- Visual: the system item detail is part of the M3.2 visual gate (`tests/e2e/visual/inbox.spec.ts`, the demo's `nightly-build-verify` item against the prototype); M3.3 adds no new markup.
