# Schedules (M7.1)

Scheduled Claude Code runs: a schedule is a session template (the New-session form's values, D8) plus a cron expression. When the cron fires, on **Run now** and on the Inbox's **Retry run** (M3.3), Switchboard starts a session from the template exactly as "Start session" would. There are **no default schedules** (gap #6): the table starts empty; the prototype's four schedules exist only in the demo seed.

Code:
| Part | File |
|---|---|
| Cron parsing, next runs, readable preview | `src/core/cron.ts` |
| Run session names | `src/core/schedules.ts` |
| The scheduler (timer, runs, results) | `src/server/schedules/scheduler.ts` |
| `ScheduleInput` validation | `src/server/schedules/validate.ts` |
| Wire shape | `src/server/schedules/wire.ts` |
| Routes | `src/server/api/schedules.ts` |
| The start flow shared with `POST /api/sessions` | `src/server/sessions/start.ts` |
| Table (header, rows, buttons) | `src/web/views/ScheduleTable.tsx`, `schedule-table.ts`, `schedule-table.css`, mounted by `SchedulesView.tsx` |
| Section 7 · Schedule of the New-session modal | `src/web/modals/ScheduleSection.tsx`, `schedule-form.ts` (+ `NewSessionModal.tsx`, `ModalHost.tsx`, `new-session.css`) |

## Cron
Five fields, `minute hour day-of-month month day-of-week`, in the **machine's local time**: `*`, numbers, `a-b`, `/step` (on `*`, a range or a start: `5/15` = 5-59/15), comma lists, month names `jan`–`dec`, weekday names `sun`–`sat` (0 and 7 are Sunday), case-insensitive, and the macros `@hourly`, `@daily` / `@midnight`, `@weekly`, `@monthly`, `@yearly` / `@annually`. Day of month and day of week follow the Vixie rule: when both are restricted (neither starts with `*`), either one matching is enough; otherwise both must match. The stored expression is the parser's normal form (lower case, single spaces, macros expanded). An expression that never fires (`0 0 30 2 *`) is refused by the form (no next run within 8 years).

**Readable preview** (`cronLabel`, prototype copy for the prototype's four): `02:00 daily`, `every 4h`, `08:30 weekdays`, `Mon 07:00`; also `every minute`, `every 15 min`, `hourly`, `hourly at :20`, `every 6h at :15`, `09:00, 17:00 daily`, `10:00 weekends`, `Mon, Wed, Fri 07:00`, `06:00 on the 1st monthly`. Any other shape (a restricted month, ranges of hours, both day fields) shows **the expression itself**, so the preview never claims something the expression does not do.

DST: a local time the switch skips is not run that day; a repeated hour runs once.

## When a schedule fires
- One timer for all schedules, set to the earliest next firing and never longer than 60 s (the clock may jump, e.g. after sleep). Each schedule remembers the time from which its next firing is looked for ("armed from"): the service start, a save, a resume, and each firing.
- **No catch-up after downtime.** When the service starts, every schedule looks from that moment on: firings missed while it was down are not run.
- **A late timer never bursts.** If several firings came due at once (the machine slept), the schedule fires once.
- **Paused** schedules do not fire; Run now still works. Resume looks from the moment of the resume.
- **Overlap.** While a run of the schedule is in progress (its session is `run` or `need`, or its start has not finished), a cron firing is recorded as a `skipped` run with the summary `the previous run was still in progress`, and Run now / Retry run is refused (409 `running`; the Inbox shows `Not sent: a run of this schedule is still in progress`).
- The timer runs only in normal mode (`main.ts` starts it once the port is bound); demo mode and apps built by tests without `start()` never fire on their own.

## A run
1. A `schedule_runs` row: `result: running`, `triggeredBy: cron | manual`, `ts` = now. `scheduleRun {scheduleId, result: "running"}` goes to `/hub`.
2. The session: the stored template (D14: in the schedule's folder, `schedules.folder_id`, which is also `template.folder`; a schedule saved before any folder existed runs in the default folder of the moment) with `name` = **`<schedule>-<MMDD>-<HHMM>`** (local time of the firing; `-2`, `-3`, … when that name is taken; the schedule part cut so the whole stays within 64 characters) and `title` = the schedule's name (D22: the UI shows the run's session under its schedule's name; `--name` passes it), started through `startNewSession` (`src/server/sessions/start.ts`), the same flow as `POST /api/sessions`: validation (read-only solutions refused through the workspace scan), a worktree per solution when the template says so (`../<repo>-wt-<run session name>`, branch `session/<run session name>`, gap #1; D32 leaves scheduled runs out of ticket branches: the template carries no `branch`, `startNewSession(…, { worktreeBranch: 'session' })`), the M5.2 first message (the task + the confirmed answers block), the supervisor start. The session is linked to the schedule (`sessions.schedule_id`) and the run to the session before the process spawns.
3. The run's result follows the session's status (`sessionUpdated` from the supervisor):

| Session status | Run result |
|---|---|
| `run` | `running` |
| `need` | `need` (the run waits for the developer; the schedule counts as in progress) |
| `done` | `ok` (final) |
| `fail` | `fail` (final) |
| `idle`, `paused` | unchanged |

   A final result sets `finishedAt`. Every change goes out as `scheduleRun {scheduleId, result}`.
4. **Summary** (the short copy the table shows after its prefix): `need` → the first open question of the session verbatim (else `Permission · <tool>` for an open permission request); `ok` → the label of the session's last turn result (the first line of its final text; none when empty); `fail` → the label of that result when it failed, else of the newest error event (e.g. the lifecycle `claude failed`). Nothing else is invented.
5. A session that could not start (422 validation, a worktree refusal, a supervisor refusal) makes the run `fail` at once with the summary `Not started: <the messages>`, and no session.
6. A `fail` result calls the M3.3 hook `systemItems.scheduleRunFinished(runId)`: the **"Scheduled run failed"** Inbox item (title = the summary, the green streak, "Open fix session" / "Retry run" / "Dismiss"; `docs/system-items.md`).

The run's session is left as it is when the run ends, like a session started from the modal (visible in the sidebar and History; the developer pauses or continues it).

**Restart.** When the scheduler first starts (main.ts, once the port is bound, so a second instance that cannot bind never touches the first one's runs) it looks at the runs without a final result: a `running` run without a session (its start was cut short) becomes `fail` (`Not started: Switchboard stopped while the run was starting`); a run with a session follows it again (restart recovery, M2.4, resumes `run` / `need` sessions). A `need` run without a session (the demo's) is left alone.

## API (contract rows; `Schedule` fields in `src/core/api.ts`)
| Route | Body | Answer |
|---|---|---|
| `GET /api/schedules` | — | `Schedule[]` in creation order: `id, name, description, cron, paused, template, runs` (the newest 14, oldest first, each `{ts, result, summary, finishedAt, sessionId, triggeredBy}`), `nextRunAt` (`null` while paused), `running` (additive: a run is in progress), `folder` (additive, D14: the saved folder its runs start in) |
| `POST /api/schedules` | `ScheduleInput` `{ id?, cron, template: NewSession }` | `201 Schedule` (new) · `200 Schedule` (with `id` = Edit: cron and template replaced) · `422 {error:"invalid", errors:[{field, message}]}` · `404` unknown `id` |
| `POST /api/schedules/{id}/run` | — | `200 Schedule` with the new run last (`running`, or `fail` when its session could not start) · `409 {error:"running"}` · `404` |
| `POST /api/schedules/{id}/pause` · `/resume` | — | `200 Schedule` · `404` |

Validation of `ScheduleInput` ("Save schedule"): a valid cron expression (`field: cron`); the template is a valid `NewSession` by the contract's rules (field names prefixed `template.`: kebab-case name, solutions never read-only (D38: the list may be empty in a workspace folder: each run's agent then determines them, and with Worktrees on it creates its worktrees on the run's `session/{run name}` branch, which Switchboard adopts, `docs/worktrees.md` → *Adopted worktrees (D38)*), `qa` for QA); **a non-empty task**, because it is the prompt every run starts with (`template.task`); the name unique **among schedules** (`template.name`; runs get their own names, so a session with the same name does not matter). D14: `template.folder` names the folder the runs start in (a saved folder's id; the default folder when omitted; an unknown id or no saved folder is `template.folder` in `errors`); the template is validated for that folder (a repo folder: only its own solution, the router fields stored `null`), and the stored template always carries the folder's id. A saved folder cannot be removed while a schedule starts its runs there (409 `folder-in-use`, `docs/folders.md`); "Open fix session" of a failed run pre-fills the schedule's folder. The schedule's `name` is `template.name`, its `description` the first non-empty line of the task (at most 160 characters). There is no delete route (not in the contract).

`scheduleRun` on `/hub` (contract payload `{ scheduleId, result }`): when a run starts (`running`), when it is skipped, and whenever its result changes.

## The table (SPEC → Schedules & loops; prototype `SCH` / `scheds`)
Header: "Schedules & loops", the mono sub, "+ New scheduled run" (dashed). Rows `10px 220px 150px 1fr 150px 180px`, the prototype's inline styles:
- **Dot:** idle while paused; else the newest run that was not skipped (ok → done, fail, need, running → run); idle without runs.
- **Name + description**; the whole cell is a button that opens **Edit** (title "Edit schedule").
- **Schedule:** the readable preview (the expression as a tooltip).
- **Last 14 runs:** 14 bars of 14px, oldest first, missing runs as empty bars at the start; ok green, fail red, need amber, running blue, skipped and empty `#26272c` (the prototype's letters g / r / a / b / n). Under it the last result: `OK · <summary>` (`OK`), `Failed <age> ago · <summary>` (`Failed just now`; the age from `finishedAt`, as the sidebar ages), `Asked: <summary>` (`Waiting for you`), `Running now…`, `Skipped · <summary>`, `No runs yet`.
- **Next:** `paused`; `in 1h 12m` / `in 23h 22m` / `in 2h` / `in 30m` within a day (minutes rounded up); `tomorrow 08:30`; `Fri 07:00` within a week; else `29 Oct 07:00`; `—` when it never fires again.
- **Run now / Pause:** `Running` (not clickable) while a run is in progress; Pause ↔ Resume. A refusal shows one line under the table: `Not done: <message>`.
- Empty table: `No scheduled runs yet. “+ New scheduled run” saves a session template with a cron schedule.`
- The table reloads on `/hub` `scheduleRun`, on `sessionUpdated` (at most once a second, for `running`), after the New-session modal closes, and redraws the relative times every 30 s.

The sidebar's "Schedules & loops" badge (`<n> failed`) counts schedules whose last run failed (M1.4, fed by the same route).

## New scheduled run (D8)
"+ New scheduled run" opens the New-session modal (`useModals().open('new-session', { schedule: {} })`) titled **New scheduled run**; a row's name opens it titled **Edit scheduled run** (`{ prefill: <the template>, schedule: { id, cron } }`), prefilled from the stored template and cron. The dialog carries `data-schedule` = `new` or the schedule's id.
- Sections 1–6 as for a session, then **7 · Schedule**: the cron field (220px, mono, placeholder `0 2 * * *`, empty at first), its readable preview next to it (or why the expression is invalid, amber; a hint while empty), and `Next runs` with the next 3 run times (`Tue 29 Sep · 02:00`, local time).
- The summary adds `schedule  <preview>` after `ultracode`, shows the worktree folders the **first run** gets (`../<repo>-wt-<name>-<MMDD>-<HHMM>`), and the schedule's warnings: `⚠ a schedule with this name exists`, `⚠ add the task: it is the prompt of every run`, `⚠ enter a valid cron expression`.
- **Save schedule** replaces "Start session": disabled (45%) until "Start session" would be enabled (solutions, a free name — among schedules, the QA sources) and there is a task and a valid cron. It posts `ScheduleInput` (`template` = exactly the body "Start session" would post, `id` for Edit) and closes the modal; a refusal stays as one line `Not saved: …`.
- D14: the form's **Folder** row applies here too: the template carries the folder's id (a repo folder's template is a `NewRepoSession`, and its sections are 1 · Task definition, 2 · Solution in scope, 3 · Schedule), Edit reopens the form with the template's folder, and a schedule whose runs start in a folder other than the default one carries that folder's tag after its name in the table (`docs/folders.md` → *UI*).

## Tests
- `tests/core/cron.test.ts`: parsing (lists, ranges, steps, names, 7 = Sunday, macros, every refusal), next runs in local time (the Vixie day rule, leap day, never), the readable previews (the prototype's four and the other shapes, the expression otherwise), run session names.
- `tests/server/schedules/scheduler.test.ts` (**oracle: unit with a fake clock**, `tests/helpers/clock.ts`, on the real path: real store, supervisor with fake-claude, question pipeline, worktree manager on temp git repos, system items): Save validation and Edit; one timer, capped at 60 s, the firing at the minute starts `<schedule>-<MMDD>-<HHMM>` with the M5.2 first message and follows it to `ok` with `scheduleRun` events; once a day; a clock jump fires once; a restart does not catch up; Pause / Run now while paused / Resume; a run in progress → `skipped` and Run now refused (Retry run → `busy`); `need` with the question verbatim; a crash → `fail` + the "Scheduled run failed" item + Retry run; a template that cannot start; a worktree per run; restart reconciliation; D14: the template's folder (a repo folder's run in the repo, an unknown folder refused, a used folder not removable).
- `tests/server/api/schedules.test.ts`: the routes (201 / 200 / 422 / 404 / 409), `scheduleRun` on the bus, Retry run through `POST /api/inbox/{id}/actions/retry-run`.
- `tests/web/schedule-table.test.ts`: the row model (strip, dot, last line, next line, buttons) and the Schedule section (preview, Save rules, summary lines, body, refusal text).
- `tests/e2e/schedules.spec.ts` (**oracle: E2E**, real path, no demo): New scheduled run → section 7 → Save → the row; Run now → a real session → `OK · OK`; Pause / Resume; Edit prefilled; server refusals; a failing run live (dot, strip, `1 failed` badge, the Inbox item); the real timer firing a `* * * * *` schedule.
- `tests/e2e/visual/schedules.spec.ts`: the visual oracle for the header and table (`docs/visual/schedules.md`).
- D14: `tests/e2e/folders.spec.ts` → a schedule saved for another folder (the stored folder, the row's tag, Edit reopening with it).
- `tests/e2e/inbox-system.spec.ts` (M3.3) now retries a run through the scheduler instead of expecting the 501.
